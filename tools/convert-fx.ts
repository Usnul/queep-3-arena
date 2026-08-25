/*
 * convert-fx.ts -- extract the textures the effects layer needs.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Q3's effects were drawn by `cg_effects.c` and `cg_localents.c` with
 * hand-written sprite code and multi-pass shaders. Both go in the bin per the
 * brief; what survives is the *artwork*, which is still the right artwork -- a
 * Q3 smoke puff looks like Q3 smoke.
 *
 * So this converts a small, explicit list of sprites and marks into PNG for
 * meep's particle system and GPU decals. Explicit rather than "everything under
 * gfx/", because the list is the record of which effects exist.
 *
 * Output: `assets/built/fx/<name>.png`, shared across maps.
 *
 * Usage:  node tools/convert-fx.ts
 */

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

import { decodeTga } from './pipeline/tga.ts';
import { luminance8 } from './pipeline/texture-out.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const OUT = join(ROOT, 'assets', 'built', 'fx');

/**
 * How Q3 blended this image, which is the whole of what the conversion has to
 * undo.
 *
 * meep's particles and decals both want straight RGBA -- colour, and coverage
 * in the alpha -- so an image Q3 drew through some other blend equation has to
 * be restated in those terms rather than copied across. The name is the Q3
 * blend rather than the operation performed, because the blend is the fact and
 * the operation is the consequence.
 *
 * - `add`: `blendfunc add`. The image is opaque and black means transparent, so
 *   luminance becomes coverage and the colour is kept -- a bright core stays
 *   bright.
 * - `darken`: `blendfunc gl_zero gl_one_minus_src_color`, which every Q3 impact
 *   mark uses. The result is `dst * (1 - src)`, and for the greyscale images
 *   these all are that is *exactly* a black decal with coverage `luminance(src)`
 *   -- `src.rgb * a + dst * (1 - a)` with `src.rgb = 0`, `a = luminance`. So the
 *   colour is discarded rather than kept, which is the difference between a
 *   scorch mark and a white blob.
 * - absent: `blendfunc blend`, or a particle sprite with its own alpha. The
 *   file already says what meep wants.
 */
type FxBlend = 'add' | 'darken';

interface FxTexture {
    /** Output name, used by the effects layer. */
    readonly name: string;
    /** Source paths in Q3 load order; the first that exists wins. */
    readonly sources: readonly string[];
    /** The Q3 blend this image was authored for; see {@link FxBlend}. */
    readonly blend?: FxBlend;
}

/**
 * Q3's crosshairs, `gfx/2d/crosshair[a-j]`.
 *
 * All ten, because `cg_drawCrosshair` is a number from 0 to 9 and picking one
 * of them here would move a player preference into the build. They are 128x128
 * white-on-transparent TGAs with a real alpha channel and cost 2 KB apiece.
 */
const CROSSHAIRS: readonly FxTexture[] = Array.from({ length: 10 }, (_, i) => {
    const letter = String.fromCharCode('a'.charCodeAt(0) + i);
    return { name: `crosshair${letter}`, sources: [`gfx/2d/crosshair${letter}.tga`] };
});

const TEXTURES: readonly FxTexture[] = [
    // Particles.
    { name: 'smoke', sources: ['gfx/misc/smokepuff3.tga', 'gfx/misc/smokepuff2b.tga'] },
    { name: 'flare', sources: ['gfx/misc/flare.jpg'], blend: 'add' },
    { name: 'tracer', sources: ['gfx/misc/tracer2.jpg'], blend: 'add' },

    /*
     Decals. Three of the four are `gl_zero gl_one_minus_src_color` marks and
     convert to black-with-coverage; `plasma_mrk` is the one Q3 drew with a
     plain `blendfunc blend` and is the one whose own RGBA is already right.
     `scripts/decals.shader` is the record of which is which.
    */
    { name: 'mark_bullet', sources: ['gfx/damage/bullet_mrk.jpg'], blend: 'darken' },
    { name: 'mark_burn', sources: ['gfx/damage/burn_med_mrk.tga'], blend: 'darken' },
    { name: 'mark_plasma', sources: ['gfx/damage/plasma_mrk.tga'] },
    { name: 'mark_hole', sources: ['gfx/damage/hole_lg_mrk.tga'], blend: 'darken' },

    ...CROSSHAIRS,
];

async function convertOne(fx: FxTexture): Promise<boolean> {
    const source = fx.sources.find((s) => existsSync(join(EXTRACTED, s)));

    if (source === undefined) {
        console.warn(`  ${fx.name}: none of ${fx.sources.join(', ')} exist`);
        return false;
    }

    const src = join(EXTRACTED, source);
    const dest = join(OUT, `${fx.name}.png`);

    let rgba: Uint8Array;
    let width: number;
    let height: number;

    if (source.endsWith('.tga')) {
        const decoded = decodeTga(readFileSync(src));
        rgba = decoded.rgba;
        width = decoded.width;
        height = decoded.height;
    } else {
        const raw = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        rgba = new Uint8Array(raw.data);
        width = raw.info.width;
        height = raw.info.height;
    }

    if (fx.blend !== undefined) {
        /*
         Both blends read coverage out of the image's own brightness; they differ
         only in whether the colour survives it. See `FxBlend`.
        */
        const keepColour = fx.blend === 'add';

        for (let i = 0; i < rgba.length; i += 4) {
            const r = rgba[i]!;
            const g = rgba[i + 1]!;
            const b = rgba[i + 2]!;

            rgba[i + 3] = luminance8(r, g, b);

            if (!keepColour) {
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
            }
        }
    }

    await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toFile(dest);

    console.log(`  ${fx.name}: ${source} -> ${width}x${height}`);
    return true;
}

async function main(): Promise<void> {
    if (!existsSync(EXTRACTED)) {
        console.error(`missing ${EXTRACTED}\nrun: npm run setup`);
        process.exit(2);
    }

    mkdirSync(OUT, { recursive: true });

    console.log('converting effect textures...');

    let ok = 0;
    for (const fx of TEXTURES) {
        if (await convertOne(fx)) ok += 1;
    }

    console.log(`${ok}/${TEXTURES.length} written to assets/built/fx/`);

    if (ok < TEXTURES.length) {
        process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}

