/*
 * texture-out.ts -- resolve a Q3 virtual texture path and write it next to a bundle.
 *
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Lifted out of `convert-map.ts` when the model converter needed the same
 * behaviour. TGA is decoded and re-encoded because browsers do not read it;
 * JPEG and PNG are copied byte-for-byte where nothing has to change in them,
 * because re-encoding them would only lose quality to no purpose.
 *
 * # An image is written for the blend it was authored for
 *
 * A Q3 image is not a texture on its own -- it is a texture *plus* the blend
 * equation the stage that named it used, and the two are only meaningful
 * together. meep wants straight RGBA with coverage in alpha, and it premultiplies
 * on upload, which makes an alpha channel load-bearing whether or not Q3's blend
 * ever read one. So each reference carries its {@link ImageBlend} and this file
 * holds what each of them costs:
 *
 * | blend           | what it does to the image                                |
 * |-----------------|----------------------------------------------------------|
 * | `opaque`        | alpha forced to 255 -- Q3 ignored it, and a leftover one  |
 * |                 | would shade the surface black wherever it was zero        |
 * | `alpha`         | nothing; the file already says what meep wants            |
 * | `add`           | colour dropped, `luminance` into alpha (D-079's rule)     |
 * | `addAlpha`      | same, scaled by the image's own alpha                     |
 * | `filter`        | colour dropped, `255 - luminance` into alpha -- a multiply |
 * |                 | by a grey image *is* black at that coverage               |
 * | `premultiplied` | colour divided back out of alpha                          |
 *
 * `add` and `addAlpha` discard the colour rather than keeping it, which is where
 * this differs from `convert-fx.ts`'s otherwise identical `add`. A particle
 * sprite *is* its colour; a shader's additive pass is bound as the material's
 * emissive as well, so keeping the colour here would shade it a second time.
 *
 * Two references that restate to the same bytes share one file: the caller keys
 * the bundle by {@link textureKey}, which is a pure function of path and blend,
 * while the file on disk is named for what the restatement actually did. A JPEG
 * has no alpha channel, so `opaque`, `alpha` and `premultiplied` all leave it
 * alone and all three land on the same copy.
 *
 * # A generated map is not a Q3 image and does not restate
 *
 * {@link writeDerivedTexture} carries the normal and ORM maps, and it bypasses
 * the table above entirely. Nothing in it applies: a blend is a statement about
 * how Q3 composited a *colour*, and neither of these is one. Running `opaque`
 * over a normal map would force an alpha the sampler never reads, and running
 * any of the others would destroy all three channels. So the bytes are copied,
 * and the only thing shared with the Q3 path is the memo.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import type { ShaderIndex } from './shader-index.ts';
import type { ImageBlend } from './shader-to-pbr.ts';
import { decodeTga, type DecodedImage } from './tga.ts';

/**
 * Rec. 709 luminance of one 8-bit RGB triple.
 *
 * Shared with `convert-fx.ts` rather than written twice, because the two places
 * that turn a Q3 additive image into coverage have to agree on what "bright"
 * means or the same artwork reads differently depending on which pipeline
 * carried it.
 */
export function luminance8(r: number, g: number, b: number): number {
    return Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
}

/**
 * Memo of what has been resolved and what has been written.
 *
 * `byKey` maps a {@link textureKey} to the filename it ended up in, with an
 * empty string recording "resolved to nothing" so a missing texture is looked up
 * once rather than once per material that references it. `byFile` maps the
 * *effective* blend -- what the restatement actually did to this particular
 * source -- to the same filename, so two references that restate identically are
 * one file on disk.
 */
export interface TextureCache {
    readonly byKey: Map<string, string>;
    readonly byFile: Map<string, string>;
}

export function textureCache(): TextureCache {
    return { byKey: new Map(), byFile: new Map() };
}

/** Files actually written, and references that resolved to nothing. */
export function textureCounts(cache: TextureCache): { written: number; missing: number } {
    let missing = 0;
    for (const v of cache.byKey.values()) if (v === '') missing += 1;
    return { written: cache.byFile.size, missing };
}

/**
 * How a bundle names one texture reference.
 *
 * A path alone is not enough any more: the same image can be referenced by two
 * materials through two different blends and has to be written twice. `opaque`
 * is unsuffixed because it is what the overwhelming majority of references are,
 * and because it keeps the bundles' texture names readable.
 */
export function textureKey(virtualPath: string, blend: ImageBlend): string {
    return blend === 'opaque' ? virtualPath : `${virtualPath}#${blend}`;
}

/** The virtual path a {@link textureKey} was made from. */
export function texturePathOf(key: string): string {
    const hash = key.lastIndexOf('#');
    return hash < 0 ? key : key.slice(0, hash);
}

/**
 * A generated map that is not a Q3 image at all.
 *
 * `normal` is tangent-space; `orm` is G = roughness, B = metalness, R = 1.0.
 * Neither is a Q3 blend product, so neither goes through {@link restate}: a
 * normal map has no alpha semantics to preserve and must not be premultiplied,
 * and forcing an ORM's alpha would say nothing about its three real channels.
 */
export type DerivedMap = 'normal' | 'orm';

/**
 * Where a de-lit albedo for this image would be, if one has been generated.
 *
 * Not a {@link DerivedMap}: the other two are new slots, and this one *replaces*
 * the colour of an image that still has to go through the Q3 blend it was
 * authored for. See {@link writeTexture}.
 */
export function delitAlbedoPath(mapsRoot: string, virtualPath: string): string {
    return join(mapsRoot, `${virtualPath.replace(/[\/]/g, '_')}.albedo.png`);
}

/**
 * How a bundle names a generated map.
 *
 * The same `#`-suffixed shape as {@link textureKey} and in the same namespace,
 * which is safe because no {@link ImageBlend} is called `normal` or `orm`. It
 * takes a *virtual path* and not a texture key, because a generated map belongs
 * to the artwork rather than to the blend some stage restated it through.
 */
export function derivedTextureKey(virtualPath: string, map: DerivedMap): string {
    return `${virtualPath}#${map}`;
}

/**
 * Copy a generated map next to a bundle, if one has been generated.
 *
 * Returns `null` when the file is not there, which is the ordinary case for
 * every texture the generator has not reached and for every texture whose
 * per-channel verdict was "author by hand". A material with no normal map
 * samples meep's `PIXEL_TEXTURE_NORMAL` -- a flat (0.5, 0.5, 1) -- and one with
 * no ORM samples `PIXEL_TEXTURE_ORM`, a white pixel, which is exactly the
 * behaviour of this pipeline before generated maps existed. So a missing map
 * costs nothing and needs no fallback of its own.
 *
 * The bytes are copied rather than re-encoded. The generator already writes PNG
 * at the size and bit depth the bundle wants, and a normal map is the last thing
 * to put through a lossy round trip.
 */
export function writeDerivedTexture(
    mapsRoot: string,
    virtualPath: string,
    map: DerivedMap,
    outDir: string,
    cache: TextureCache
): string | null {
    const key = derivedTextureKey(virtualPath, map);

    const existing = cache.byKey.get(key);
    if (existing !== undefined) return existing === '' ? null : existing;

    const flat = virtualPath.replace(/[\/]/g, '_');
    const out = `${flat}.${map}.png`;
    const src = join(mapsRoot, out);

    if (!existsSync(src)) {
        cache.byKey.set(key, '');
        return null;
    }

    /*
     One source image is one generated map whatever restates it, so `byFile` is
     keyed the same way `byKey` is here rather than by an effective blend. Two
     materials sharing a texture share the copy.
    */
    const shared = cache.byFile.get(key);
    if (shared !== undefined) {
        cache.byKey.set(key, shared);
        return shared;
    }

    try {
        copyFileSync(src, join(outDir, out));
    } catch (e) {
        console.warn(`  texture ${key}: ${(e as Error).message}`);
        cache.byKey.set(key, '');
        return null;
    }

    cache.byFile.set(key, out);
    cache.byKey.set(key, out);
    return out;
}

/**
 * The blend, reduced to what it actually changes about *this* source.
 *
 * The two that read the *colour* -- `add` and `filter` -- always do something.
 * The rest only touch alpha, so on an image with no alpha channel `alpha` and
 * `premultiplied` are no-ops, `addAlpha` degenerates to `add`, and `opaque` has
 * nothing to force. Folding those together is what lets one file serve several
 * keys.
 */
function effectiveBlend(blend: ImageBlend, hasAlpha: boolean): ImageBlend {
    if (blend === 'add' || blend === 'filter') return blend;
    if (hasAlpha) return blend;
    return blend === 'addAlpha' ? 'add' : 'opaque';
}

/** Apply a restatement in place. See the table at the top of this file. */
function restate(rgba: Uint8Array, blend: ImageBlend): void {
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i]!;
        const g = rgba[i + 1]!;
        const b = rgba[i + 2]!;
        const a = rgba[i + 3]!;

        switch (blend) {
            case 'opaque':
                rgba[i + 3] = 255;
                break;

            case 'add':
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = luminance8(r, g, b);
                break;

            case 'addAlpha':
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = Math.round((luminance8(r, g, b) * a) / 255);
                break;

            case 'filter':
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = 255 - luminance8(r, g, b);
                break;

            case 'premultiplied':
                if (a === 0) {
                    rgba[i] = 0;
                    rgba[i + 1] = 0;
                    rgba[i + 2] = 0;
                } else {
                    rgba[i] = Math.min(255, Math.round((r * 255) / a));
                    rgba[i + 1] = Math.min(255, Math.round((g * 255) / a));
                    rgba[i + 2] = Math.min(255, Math.round((b * 255) / a));
                }
                break;

            case 'alpha':
                break;
        }
    }
}

async function decode(src: string, isTga: boolean): Promise<DecodedImage> {
    if (isTga) return decodeTga(readFileSync(src));

    /*
     `hadAlpha` comes from the metadata rather than from the raw buffer, because
     `ensureAlpha` has already put a fourth channel there by the time the pixels
     come back and every image would claim to have one.
    */
    const image = sharp(src);
    const hadAlpha = (await image.metadata()).hasAlpha === true;
    const raw = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    return {
        width: raw.info.width,
        height: raw.info.height,
        rgba: new Uint8Array(raw.data),
        hadAlpha,
    };
}

/**
 * Swap in the de-lit colour, keeping the original's alpha.
 *
 * The generated albedo is a statement about *colour* and about nothing else, so
 * the alpha channel is untouched: an alpha-tested grate's cutout is the same
 * cutout, and the {@link ImageBlend} restatement that follows still sees the
 * coverage the Q3 stage meant. The two images are the same size by construction
 * -- the generator recovers its output at the source's own resolution -- and a
 * mismatch is treated as a generator fault and skipped rather than resampled,
 * because resampling a normal map's sibling silently is how a set drifts.
 */
async function applyDelit(
    decoded: DecodedImage,
    path: string
): Promise<'applied' | 'absent' | 'mismatched'> {
    if (!existsSync(path)) return 'absent';

    const raw = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (raw.info.width !== decoded.width || raw.info.height !== decoded.height) return 'mismatched';

    const rgb = raw.data;
    for (let i = 0, j = 0; i < decoded.rgba.length; i += 4, j += 3) {
        decoded.rgba[i] = rgb[j]!;
        decoded.rgba[i + 1] = rgb[j + 1]!;
        decoded.rgba[i + 2] = rgb[j + 2]!;
    }

    return 'applied';
}

export async function writeTexture(
    index: ShaderIndex,
    assetRoot: string,
    virtualPath: string,
    outDir: string,
    cache: TextureCache,
    blend: ImageBlend = 'opaque',
    /** When set, a generated de-lit albedo here replaces the image's colour. */
    mapsRoot: string | null = null
): Promise<string | null> {
    const delit = mapsRoot === null ? null : delitAlbedoPath(mapsRoot, virtualPath);
    const hasDelit = delit !== null && existsSync(delit);

    /*
     The *key* is unchanged, because a material names its albedo by path and blend
     and that is still what this is: the same surface, drawn the same way, with
     the painted shading taken out of its colour. What changes is the file the key
     resolves to, and the file is named `.delit` so a bundle says on disk which
     one it holds rather than leaving it to be inferred from a timestamp.
    */
    const key = textureKey(virtualPath, blend);

    const existing = cache.byKey.get(key);
    if (existing !== undefined) return existing === '' ? null : existing;

    const resolved = index.resolveTexture(virtualPath);
    if (resolved === null) {
        cache.byKey.set(key, '');
        return null;
    }

    const src = join(assetRoot, resolved);
    const flat = virtualPath.replace(/[\\/]/g, '_');
    const isTga = resolved.toLowerCase().endsWith('.tga');

    /*
     A JPEG has no alpha channel, so nothing but `add` can change it and the
     common case stays a byte copy. Everything else has to be decoded to know
     whether its alpha is real, which the TGA path was doing anyway.
    */
    const isJpeg = /\.jpe?g$/i.test(resolved);

    try {
        // A byte copy cannot carry a colour that is not in the file.
        if (!hasDelit && isJpeg && (blend === 'opaque' || blend === 'alpha' || blend === 'premultiplied')) {
            // A JPEG has no alpha, so none of these three change a pixel of it.
            const out = `${flat}${resolved.slice(resolved.lastIndexOf('.'))}`;
            const shared = cache.byFile.get(`${virtualPath}#opaque`);
            if (shared === undefined) {
                copyFileSync(src, join(outDir, out));
                cache.byFile.set(`${virtualPath}#opaque`, out);
            }
            cache.byKey.set(key, out);
            return out;
        }

        const decoded = await decode(src, isTga);
        const effective = effectiveBlend(blend, decoded.hadAlpha);

        let suffix = '';
        if (hasDelit) {
            const applied = await applyDelit(decoded, delit!);
            if (applied === 'applied') suffix = '.delit';
            else if (applied === 'mismatched') {
                console.warn(`  texture ${key}: de-lit albedo is a different size, ignored`);
            }
        }

        const fileKey = `${virtualPath}#${effective}${suffix}`;

        const shared = cache.byFile.get(fileKey);
        if (shared !== undefined) {
            cache.byKey.set(key, shared);
            return shared;
        }

        const out = `${flat}${effective === 'opaque' ? '' : `.${effective}`}${suffix}.png`;

        restate(decoded.rgba, effective);

        await sharp(Buffer.from(decoded.rgba), {
            raw: { width: decoded.width, height: decoded.height, channels: 4 },
        })
            .png({ compressionLevel: 9 })
            .toFile(join(outDir, out));

        cache.byFile.set(fileKey, out);
        cache.byKey.set(key, out);
        return out;
    } catch (e) {
        console.warn(`  texture ${key}: ${(e as Error).message}`);
        cache.byKey.set(key, '');
        return null;
    }
}
