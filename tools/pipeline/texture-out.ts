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
 * # And an env-mapped image is written as one texel
 *
 * The second axis, and it composes with the first rather than replacing it: an
 * image referenced by a shader whose every pass is `tcGen environment` is
 * reduced to its mean colour before the blend above restates it. Q3 sampled such
 * an image at coordinates it generated per frame from the reflected view and
 * never at the model's own, so the model's own are filler -- on the health
 * pickups, literally the same `(0, 1)` on every vertex of five of the nine
 * models. {@link flattenToMean} says what the mean is and why it is taken in
 * linear light; `shader-to-pbr.ts` says why there is nothing better to take.
 *
 * Two references that restate to the same bytes share one file: the caller keys
 * the bundle by {@link textureKey}, which is a pure function of path and blend,
 * while the file on disk is named for what the restatement actually did. A JPEG
 * has no alpha channel, so `opaque`, `alpha` and `premultiplied` all leave it
 * alone and all three land on the same copy.
 *
 * # And a glow map is masked by the test its pass was drawn under
 *
 * The third axis, and it composes with the other two the same way. A Q3 glow
 * pass can carry an `alphaFunc`, and on that pass the test is not a silhouette
 * -- the surface is drawn either way -- it is the mask saying *which texels
 * glow*. `shader-to-pbr.ts` explains why that belongs to the emissive slot; the
 * restatement here is to write the image **black** wherever the test fails,
 * because an emissive is added rather than composited and black adds nothing.
 *
 * It is exact. Every other entry in the table above trades something away --
 * luminance for coverage, a whole image for its mean -- and this one trades
 * nothing, because a per-texel binary test is precisely what a texture can say.
 *
 * The mask is applied before the flatten and before the blend, because both of
 * those overwrite the alpha channel the test has to read.
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
import { alphaTestPasses, type AlphaTest, type ImageBlend } from './shader-to-pbr.ts';
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
    /**
     * The generated maps, memoised separately.
     *
     * They are not in `byKey` because `textureCounts` reads that to say how many
     * references resolved to nothing, and a *Q3* reference that resolves to
     * nothing is a conversion failure worth failing a test over -- the shader
     * named an image and the image is not there. A generated map that has not
     * been produced is not that. Thirty-five normal maps were refused by
     * `build_maps.py` on purpose, and counting them as missing textures broke
     * `presentation.test.ts` on all six maps while nothing was wrong.
     */
    readonly byDerived: Map<string, string>;
}

export function textureCache(): TextureCache {
    return { byKey: new Map(), byFile: new Map(), byDerived: new Map() };
}

/**
 * Files actually written, and Q3 references that resolved to nothing.
 *
 * `missing` counts only the Q3 side. A generated map that has not been produced
 * is absent by design -- 35 normal maps were refused outright by `build_maps.py`
 * -- and reporting those as missing textures says a conversion failed when it
 * did exactly what it was told. `written` counts both, because a file is a file.
 */
export function textureCounts(cache: TextureCache): { written: number; missing: number } {
    let missing = 0;
    for (const v of cache.byKey.values()) if (v === '') missing += 1;

    let derived = 0;
    for (const k of cache.byDerived.keys()) if (k.startsWith('file:')) derived += 1;

    return { written: cache.byFile.size + derived, missing };
}

/**
 * How a bundle names one texture reference.
 *
 * A path alone is not enough any more: the same image can be referenced by two
 * materials through two different blends and has to be written twice. `opaque`
 * is unsuffixed because it is what the overwhelming majority of references are,
 * and because it keeps the bundles' texture names readable.
 *
 * `flat` is the second axis and rides in the same suffix rather than a second
 * one, so a key still splits on its last `#` and {@link texturePathOf} still
 * answers. It is not an {@link ImageBlend} of its own because it is not a Q3
 * blend: the flattening happens to the image *before* the blend restates it,
 * and the two compose -- an additive shell is flattened and then turned into
 * coverage, in that order.
 *
 * `alphaTest` is the third, and it is the one that has to be here or the fix it
 * carries does nothing: a glow pass's `alphaFunc` is baked into the *image*
 * (D-153), and OA's plasma gun names one image for both its albedo and its
 * glow. Without this axis both references key to `models/weapons2/plasma/skin`,
 * the memo hands the second one the first one's file, and the mask either never
 * gets written or gets written over the gun's own skin.
 */
export function textureKey(
    virtualPath: string,
    blend: ImageBlend,
    flat = false,
    alphaTest: AlphaTest | null = null
): string {
    const parts: string[] = [];
    if (blend !== 'opaque') parts.push(blend);
    if (flat) parts.push('flat');
    if (alphaTest !== null) parts.push(alphaTest.toLowerCase());

    return parts.length === 0 ? virtualPath : `${virtualPath}#${parts.join('.')}`;
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
    return join(mapsRoot, `${virtualPath.replace(/[\\/]/g, '_')}.albedo.png`);
}

/**
 * How a bundle names a generated map.
 *
 * The same `#`-suffixed shape as {@link textureKey} and in the same namespace,
 * which is safe because no {@link ImageBlend} is called `normal` or `orm`. It
 * takes a *virtual path* and not a texture key, because a generated map belongs
 * to the artwork rather than to the blend some stage restated it through.
 */
export function derivedTextureKey(virtualPath: string, map: DerivedMap, flat = false): string {
    return flat ? `${virtualPath}#${map}.flat` : `${virtualPath}#${map}`;
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
 *
 * `flatten` is the env-mapped case and it splits the two maps rather than
 * treating them alike, because they are owed different things:
 *
 * - the **ORM** is flattened, to its mean *as stored*. Roughness and metalness
 *   are linear data and not a colour, so there is no transfer function to undo,
 *   and the mean of a generated ORM is by construction the classified level the
 *   variation was scattered around. Without this, a material whose UVs mean
 *   nothing draws a roughness picked at random out of the spread -- `greenchrm`
 *   runs 0.03 to 1.00, a mirror to a matte, over the same small health cross.
 * - the **normal** is refused outright. A relief map derived from a fake
 *   reflection is not relief, and the flat (0.5, 0.5, 1) that averaging one
 *   would approximate is exactly what meep samples when nothing is bound. So
 *   there is nothing to write; the honest answer is no map.
 */
export async function writeDerivedTexture(
    mapsRoot: string,
    virtualPath: string,
    map: DerivedMap,
    outDir: string,
    cache: TextureCache,
    flatten = false
): Promise<string | null> {
    const key = derivedTextureKey(virtualPath, map, flatten);

    const existing = cache.byDerived.get(key);
    if (existing !== undefined) return existing === '' ? null : existing;

    if (flatten && map === 'normal') {
        cache.byDerived.set(key, '');
        return null;
    }

    const flat = virtualPath.replace(/[\\/]/g, '_');
    const src = join(mapsRoot, `${flat}.${map}.png`);
    const out = flatten ? `${flat}.${map}.flat.png` : `${flat}.${map}.png`;

    if (!existsSync(src)) {
        cache.byDerived.set(key, '');
        return null;
    }

    /*
     One source image is one generated map whatever restates it, so `byFile` is
     keyed the same way `byKey` is here rather than by an effective blend. Two
     materials sharing a texture share the copy.
    */
    const shared = cache.byDerived.get(`file:${key}`);
    if (shared !== undefined) {
        cache.byDerived.set(key, shared);
        return shared;
    }

    try {
        if (flatten) {
            const raw = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const mean = flattenToMean(
                {
                    width: raw.info.width,
                    height: raw.info.height,
                    rgba: new Uint8Array(raw.data),
                    hadAlpha: true,
                },
                'stored'
            );

            await sharp(Buffer.from(mean.rgba), { raw: { width: 1, height: 1, channels: 4 } })
                .png({ compressionLevel: 9 })
                .toFile(join(outDir, out));
        } else {
            copyFileSync(src, join(outDir, out));
        }
    } catch (e) {
        console.warn(`  texture ${key}: ${(e as Error).message}`);
        cache.byDerived.set(key, '');
        return null;
    }

    cache.byDerived.set(`file:${key}`, out);
    cache.byDerived.set(key, out);
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

/**
 * The same reduction for the alpha test, and for the same reason.
 *
 * An image with no alpha channel is alpha 255 everywhere, so `GT0` and `GE128`
 * pass on every texel and select nothing -- folding them to `null` lets such a
 * reference share the unmasked file rather than writing a byte-identical copy
 * under a second name.
 *
 * `LT128` is kept, because on such an image it passes *nowhere*: Q3 would draw
 * that glow pass as nothing at all, and a glow Q3 does not draw is not one this
 * port should invent. It does not arise in OA -- every alpha-tested glow stage
 * in the set names a TGA with a real alpha channel -- but "black" is the honest
 * answer if it ever does, and a silently unmasked one would be the bug this
 * whole axis exists to fix.
 */
function effectiveAlphaTest(test: AlphaTest | null, hasAlpha: boolean): AlphaTest | null {
    if (test === null || hasAlpha) return test;
    return test === 'LT128' ? test : null;
}

/**
 * Black out the texels a Q3 alpha test rejected, in place.
 *
 * Runs *before* {@link restate}, which is not incidental: the emissive is
 * written `opaque`, and `opaque` forces alpha to 255 -- so the channel the test
 * reads has to be read while it is still the file's own. Afterwards there is
 * nothing left to test.
 *
 * The colour goes to black rather than the alpha to zero because an emissive is
 * added, not composited: `emissive_factor * texture_emissive` at RGB 0 adds
 * nothing, which is exactly a texel Q3's alpha test discarded. Zeroing alpha
 * instead would say nothing to a slot that never samples it.
 */
function applyAlphaTest(rgba: Uint8Array, test: AlphaTest): void {
    for (let i = 0; i < rgba.length; i += 4) {
        if (alphaTestPasses(test, rgba[i + 3]!)) continue;

        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
    }
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

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const s = i / 255;
    SRGB_TO_LINEAR[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb8(l: number): number {
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, s * 255)));
}

/**
 * Reduce an image to one texel of its mean.
 *
 * For a `tcGen environment` shader, whose images are a fake reflection and never
 * a skin -- see `shader-to-pbr.ts`. The mean is what such an object averages to
 * over a turn, it is the only thing the artwork says that survives losing the
 * lookup, and one texel cannot be sampled wrongly by texture coordinates that
 * mean nothing.
 *
 * `sRGB` averages in *linear light* and re-encodes, because that is the mean of
 * the light the image stands for rather than the mean of its encoding. The two
 * are not close on this artwork: these are dark grounds with bright streaks over
 * them, which is exactly the shape that a mean-of-sRGB under-reads. `greenchrm`
 * comes out `rgb(47, 63, 31)` linear against `rgb(34, 50, 19)` naive, and the
 * naive one is a third of a stop dark for the same reason a photograph averaged
 * in gamma space is.
 *
 * `stored` averages the bytes as they are, and is for a map whose channels are
 * measurements rather than a colour -- an ORM, where undoing a transfer function
 * nobody applied would bias every roughness in the set upward.
 *
 * Alpha is averaged as stored either way. It is a coverage fraction and was
 * never gamma-encoded.
 */
function flattenToMean(image: DecodedImage, encoding: 'sRGB' | 'stored'): DecodedImage {
    const n = image.width * image.height;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    const decode = encoding === 'sRGB' ? (v: number) => SRGB_TO_LINEAR[v]! : (v: number) => v;
    const encode = encoding === 'sRGB' ? linearToSrgb8 : (v: number) => Math.round(v);

    for (let i = 0; i < image.rgba.length; i += 4) {
        r += decode(image.rgba[i]!);
        g += decode(image.rgba[i + 1]!);
        b += decode(image.rgba[i + 2]!);
        a += image.rgba[i + 3]!;
    }

    return {
        width: 1,
        height: 1,
        rgba: new Uint8Array([encode(r / n), encode(g / n), encode(b / n), Math.round(a / n)]),
        hadAlpha: image.hadAlpha,
    };
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
    mapsRoot: string | null = null,
    /** `PbrMaterial.environmentMapped`: reduce the image to its mean colour. */
    flatten = false,
    /**
     * `PbrMaterial.emissiveAlphaTest`: black out the texels Q3's alpha test
     * rejected. Only ever set on an emissive reference -- an albedo's test is a
     * silhouette and becomes `transparency: 'mask'` instead. See D-153.
     */
    alphaTest: AlphaTest | null = null
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
    const key = textureKey(virtualPath, blend, flatten, alphaTest);

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
        // A byte copy cannot carry a colour that is not in the file, nor an
        // image that is not the one on disk, nor a mask over either.
        if (!hasDelit && !flatten && alphaTest === null && isJpeg && (blend === 'opaque' || blend === 'alpha' || blend === 'premultiplied')) {
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

        let decoded = await decode(src, isTga);
        const effective = effectiveBlend(blend, decoded.hadAlpha);
        const test = effectiveAlphaTest(alphaTest, decoded.hadAlpha);

        let suffix = '';
        if (hasDelit) {
            const applied = await applyDelit(decoded, delit!);
            if (applied === 'applied') suffix = '.delit';
            else if (applied === 'mismatched') {
                console.warn(`  texture ${key}: de-lit albedo is a different size, ignored`);
            }
        }

        /*
         Before the restatement, not after. The blends that read the *colour* --
         `add`, `addAlpha`, `filter` -- turn it into a coverage per texel, and a
         mean taken after that is a mean of coverages rather than of the light
         the image stands for. An additive shell wants the brightness of its
         average colour, which is the first of those two and not the second.
        */
        /*
         Before the flatten as well as before the restatement, and for the same
         reason both times: the test reads the file's own alpha, and neither of
         those two leaves it there. A masked env-mapped glow then averages to
         the mean of the part that glows, which is what such a surface averages
         to as it turns -- the same argument the flatten makes for itself.
        */
        if (test !== null) {
            applyAlphaTest(decoded.rgba, test);
            suffix = `.${test.toLowerCase()}${suffix}`;
        }

        if (flatten) {
            decoded = flattenToMean(decoded, 'sRGB');
            suffix = `.flat${suffix}`;
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
