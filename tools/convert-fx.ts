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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const OUT = join(ROOT, 'assets', 'built', 'fx');

interface FxTexture {
    /** Output name, used by the effects layer. */
    readonly name: string;
    /** Source paths in Q3 load order; the first that exists wins. */
    readonly sources: readonly string[];
    /**
     * Q3 stored several of these as opaque images meant to be drawn additively,
     * where black is transparent. A decal or a normally-blended particle needs a
     * real alpha channel, so luminance is promoted to alpha.
     */
    readonly luminanceToAlpha?: boolean;
}

const TEXTURES: readonly FxTexture[] = [
    // Particles.
    { name: 'smoke', sources: ['gfx/misc/smokepuff3.tga', 'gfx/misc/smokepuff2b.tga'] },
    { name: 'flare', sources: ['gfx/misc/flare.jpg'], luminanceToAlpha: true },
    { name: 'tracer', sources: ['gfx/misc/tracer2.jpg'], luminanceToAlpha: true },

    // Decals. Q3's mark textures are alpha-masked already.
    { name: 'mark_bullet', sources: ['gfx/damage/bullet_mrk.jpg'], luminanceToAlpha: true },
    { name: 'mark_burn', sources: ['gfx/damage/burn_med_mrk.tga'] },
    { name: 'mark_plasma', sources: ['gfx/damage/plasma_mrk.tga'] },
    { name: 'mark_hole', sources: ['gfx/damage/hole_lg_mrk.tga'] },
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

    if (fx.luminanceToAlpha === true) {
        /*
         Q3 drew these additively, so the image is opaque and "transparent" means
         black. Promoting luminance to alpha turns that into something a
         normally-blended particle or a decal can use, and keeping the colour
         means a bright core stays bright.
        */
        for (let i = 0; i < rgba.length; i += 4) {
            const r = rgba[i]!;
            const g = rgba[i + 1]!;
            const b = rgba[i + 2]!;
            rgba[i + 3] = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
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

