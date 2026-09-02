/*
 * extract-explosion-colors.ts -- what colour Q3 paints each weapon's detonation.
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
 * `CG_MissileHitWall` names a different explosion shader for every weapon that
 * detonates, and this port drew one warm particle ramp for all of them: a plasma
 * bolt and a BFG shot threw the same orange fireball a rocket does. That ramp
 * was not wrong so much as unsourced -- it was authored by eye, and it was
 * authored against a rocket.
 *
 * The source exists, in the pk3s, and this is the argument D-156 makes for
 * effect widths: the number is in the artwork rather than in the C. So the hue
 * is measured here and the brightness is not -- those two halves have different
 * owners, see "What is not measured".
 *
 * # What is measured
 *
 * A three-stop chromaticity ramp per weapon, off the shader's own textures.
 *
 * Only the **additive** stages are read. Every one of these shaders stacks
 * `blendfunc add` passes for the glow, and the port's fireball is one additive
 * emitter, so the additive stages are the like-for-like measurement. It is also
 * what keeps the rocket honest: `rocketExplosion` runs an eight-frame `animmap`
 * of `rlboom` under `GL_ONE GL_SRC_ALPHA` whose last three frames are *smoke*,
 * which this port draws as a separate emitter and which would otherwise wash the
 * fireball's measured colour toward white.
 *
 * Every lit texel of those stages is pooled, sorted by luminance and split into
 * three bands -- the brightest 2%, the first third, the last third. That is the
 * picture's own core, body and tail, and the artwork really does carry a ramp:
 * in all five shaders the bright texels sit nearer white and the dim ones are
 * more saturated, which is the shape the port's hand-authored ramp already had.
 * Each band is a luminance-weighted mean normalised to a top channel of 1,
 * because what is measured here is hue and not brightness.
 *
 * # What is not measured
 *
 * How bright the fireball is over its life, and how long it lives. Those stay
 * the port's own, in `Effects.ts`, for GAP-011's reason -- photometric
 * plausibility and reading well are different questions, and a particle ramp
 * tuned against the screen answers the second. The runtime holds the tuned
 * ramp's *luminance* at each stop and takes only the hue from here, which is why
 * the rocket lands within a few hundredths of the ramp authored for it while
 * every other weapon moves to its own picture. See D-166.
 *
 * Output: `src/client/explosionColors.generated.json`, committed for the same
 * reasons `effectWidths.generated.json` is -- it derives from GPLv2 content, it
 * is small, and the runtime must not depend on the asset tree being present.
 * `--check` fails if it is stale, and is wired into `npm run check`.
 *
 * Usage:  node tools/extract-explosion-colors.ts [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { ShaderIndex } from './pipeline/shader-index.ts';
import { decodeTga } from './pipeline/tga.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const OUT = join(ROOT, 'src', 'client', 'explosionColors.generated.json');

interface ExplosionSpec {
    /** A `WP_*`, so the table is keyed the way every other one in the port is. */
    readonly weapon: string;
    /** The shader `CG_MissileHitWall` gives this weapon. */
    readonly shader: string;
    /** The C line it comes from, for the generated file to carry. */
    readonly source: string;
}

/**
 * Every weapon whose detonation reaches `Effects.explosion`, and no others.
 *
 * `CG_MissileHitWall`'s switch is wider than this in both directions.
 *
 * - **The railgun's `railExplosion` is not here.** `stats.hitscan` is true for
 *   it, so a rail shot never becomes a missile and never detonates; measuring it
 *   would put a row in the file that nothing can ever ask for.
 * - **The nailgun has no row because the C gives it no explosion.** Its arm sets
 *   `mark` and `radius` and leaves `mod` at zero, and `CG_MissileHitWall` builds
 *   the fireball only `if (mod)` -- so Q3 draws a nail a hole and nothing else.
 *   This port detonates nails because every missile goes through one path, and
 *   the runtime falls back to its own tuned ramp for it rather than borrowing a
 *   picture painted for another weapon.
 * - **The prox mine shares the grenade's shader**, which is the C's own doing:
 *   both arms assign `cgs.media.grenadeExplosionShader`.
 */
const EXPLOSIONS: readonly ExplosionSpec[] = [
    {
        weapon: 'WP_ROCKET_LAUNCHER',
        shader: 'rocketExplosion',
        source: 'CG_MissileHitWall: case WP_ROCKET_LAUNCHER, rocketExplosionShader',
    },
    {
        weapon: 'WP_GRENADE_LAUNCHER',
        shader: 'grenadeExplosion',
        source: 'CG_MissileHitWall: case WP_GRENADE_LAUNCHER, grenadeExplosionShader',
    },
    {
        weapon: 'WP_PROX_LAUNCHER',
        shader: 'grenadeExplosion',
        source: 'CG_MissileHitWall: case WP_PROX_LAUNCHER, grenadeExplosionShader',
    },
    {
        weapon: 'WP_PLASMAGUN',
        shader: 'plasmaExplosion',
        source: 'CG_MissileHitWall: case WP_PLASMAGUN, plasmaExplosionShader',
    },
    {
        weapon: 'WP_BFG',
        shader: 'bfgExplosion',
        source: 'CG_MissileHitWall: case WP_BFG, bfgExplosionShader',
    },
];

/**
 * Where each band is cut, as a fraction of the lit texels sorted by luminance.
 *
 * The core is a small fraction because a sprite's hot centre is: these are
 * clamped round images with a bright middle inside a wide dark margin, which is
 * the shape `extract-effect-widths.ts` is built around.
 *
 * **These cuts are a choice and not a canon**, and saying otherwise would be
 * easy and wrong. The brightest 1% and the brightest 5% of a glow really are
 * different colours -- measured across that range the rocket's core moves 0.09
 * in blue and the grenade's 0.16 in green -- and the tail is as sensitive at the
 * other end. Only the body is flat, within 0.05 over any cut from a quarter to
 * a half. Sampling a continuous gradient at three points has no cut that is
 * canonical.
 *
 * What makes these three defensible is not that they are special. It is that
 * they are the same three for every weapon, so the five are comparable; and that
 * with them the *rocket* lands on the ramp this port had already tuned by eye
 * for a rocket -- within 0.05 per channel at the body and the tail, and with
 * both core colours near enough to white that their one real difference, 0.16 of
 * blue, is not a colour anybody can name. That agreement is the calibration:
 * every other weapon is measured the same way and trusted on the strength of it.
 * `explosion.test.ts` asserts it, so a cut moved later has to face it.
 */
const BANDS: readonly (readonly [number, number])[] = [
    [0, 0.02],
    [0.02, 0.35],
    [0.65, 1],
];

/** A texel dimmer than this carries no hue worth averaging; it is the margin. */
const LIT_THRESHOLD = 0.002;

interface Image {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

async function loadImage(relative: string): Promise<Image> {
    const file = join(EXTRACTED, relative);

    if (relative.toLowerCase().endsWith('.tga')) {
        const decoded = decodeTga(readFileSync(file));
        return { width: decoded.width, height: decoded.height, rgba: decoded.rgba };
    }

    const raw = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
        width: raw.info.width,
        height: raw.info.height,
        rgba: new Uint8Array(raw.data),
    };
}

/** Rec. 709, the same weighting every other luminance in this port uses. */
function luminance(r: number, g: number, b: number): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The textures of a shader's additive stages, in the order they are drawn.
 *
 * Repeats are kept for `extract-effect-widths.ts`'s reason: an `animmap` frame
 * listed twice is on screen twice as long and should weigh twice as much.
 *
 * "Additive" is `blendfunc add` or its spelled-out form `GL_ONE GL_ONE`.
 * `GL_SRC_ALPHA GL_ONE` is additive too and is deliberately not counted: it
 * modulates by an alpha channel this reader would then have to honour, and no
 * stage of the five shaders here is written that way.
 */
function additiveStageTextures(index: ShaderIndex, shader: string): string[] {
    const entry = index.entry(shader);

    if (entry === null) throw new Error(`no shader script declares "${shader}"`);

    const paths: string[] = [];

    for (const stage of entry.stages) {
        const blend = stage.directives.find((d) => d[0]?.toLowerCase() === 'blendfunc');
        if (blend === undefined) continue;

        const args = blend.slice(1).map((a) => a.toLowerCase());
        const additive =
            (args.length === 1 && args[0] === 'add') ||
            (args.length === 2 && args[0] === 'gl_one' && args[1] === 'gl_one');

        if (!additive) continue;

        for (const directive of stage.directives) {
            const keyword = directive[0]?.toLowerCase();

            if (keyword === 'map' || keyword === 'clampmap') {
                const path = directive[1];
                if (path !== undefined && !path.startsWith('$')) paths.push(path);
            } else if (keyword === 'animmap') {
                for (const path of directive.slice(2)) {
                    if (!path.startsWith('$')) paths.push(path);
                }
            }
        }
    }

    if (paths.length === 0) throw new Error(`"${shader}" has no additive stage`);

    return paths;
}

/**
 * Rounded to hundredths of a channel, for `extract-effect-widths.ts`'s reason:
 * `--check` compares the file byte for byte and a JPEG decoded by a different
 * libjpeg build can differ in the last bit. A hundredth is two and a half steps
 * of an 8-bit channel and is not a colour difference anyone can see.
 */
function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Luminance-weighted mean of one band, normalised to a top channel of 1. */
function bandColor(texels: Float64Array, count: number, from: number, to: number): number[] {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;

    for (let i = Math.round(count * from); i < Math.round(count * to); i += 1) {
        const l = texels[i * 4 + 3]!;
        r += texels[i * 4]! * l;
        g += texels[i * 4 + 1]! * l;
        b += texels[i * 4 + 2]! * l;
        weight += l;
    }

    if (weight === 0) throw new Error('a band with no light in it');

    const top = Math.max(r, g, b);

    return [round(r / top), round(g / top), round(b / top)];
}

async function measure(index: ShaderIndex, spec: ExplosionSpec) {
    const virtualPaths = additiveStageTextures(index, spec.shader);

    const lit: number[] = [];
    const textures: string[] = [];

    for (const virtualPath of virtualPaths) {
        const resolved = index.resolveTexture(virtualPath);

        if (resolved === null || !existsSync(join(EXTRACTED, resolved))) {
            throw new Error(`${spec.shader}: no file backs "${virtualPath}"`);
        }

        textures.push(resolved);

        const image = await loadImage(resolved);

        for (let i = 0; i < image.rgba.length; i += 4) {
            const r = image.rgba[i]! / 255;
            const g = image.rgba[i + 1]! / 255;
            const b = image.rgba[i + 2]! / 255;
            const a = image.rgba[i + 3]! / 255;

            const l = luminance(r, g, b) * a;
            if (l <= LIT_THRESHOLD) continue;

            lit.push(r, g, b, l);
        }
    }

    /*
     Sorted by luminance, brightest first, through an index rather than by
     building an array of arrays: these five shaders pool a few million texels
     and the packed form is the difference between a tool that runs in a second
     and one that spends its time in the garbage collector.
    */
    const count = lit.length / 4;
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) order[i] = i;
    order.sort((x, y) => lit[y * 4 + 3]! - lit[x * 4 + 3]!);

    const sorted = new Float64Array(lit.length);
    for (let i = 0; i < count; i += 1) {
        const s = order[i]! * 4;
        sorted[i * 4] = lit[s]!;
        sorted[i * 4 + 1] = lit[s + 1]!;
        sorted[i * 4 + 2] = lit[s + 2]!;
        sorted[i * 4 + 3] = lit[s + 3]!;
    }

    const [core, body, tail] = BANDS.map(([from, to]) => bandColor(sorted, count, from, to));

    return {
        weapon: spec.weapon,
        shader: spec.shader,
        source: spec.source,
        /** Chromaticities, top channel 1. Brightness is the runtime's. */
        core,
        body,
        tail,
        litTexels: count,
        textures: [...new Set(textures)].sort(),
    };
}

async function main(): Promise<void> {
    if (!existsSync(EXTRACTED)) {
        console.error(`${EXTRACTED} does not exist; run: npm run setup`);
        process.exit(1);
    }

    const index = new ShaderIndex(EXTRACTED).load();

    const explosions: Record<string, unknown> = {};

    for (const spec of EXPLOSIONS) {
        explosions[spec.weapon] = await measure(index, spec);
    }

    const json =
        JSON.stringify(
            {
                $generated: 'tools/extract-explosion-colors.ts -- do not edit by hand',
                $source: 'OpenArena shader scripts and textures under assets/extracted',
                $method:
                    'luminance-weighted mean chromaticity of the additive stages, in three ' +
                    'brightness bands, normalised to a top channel of 1. Hue only: how bright ' +
                    "the fireball is over its life stays the port's. See D-166.",
                explosions,
            },
            null,
            1
        ) + '\n';

    if (process.argv.includes('--check')) {
        if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) {
            console.error(`${OUT} is stale; run: node tools/extract-explosion-colors.ts`);
            process.exit(1);
        }
        console.error(`ok: ${EXPLOSIONS.length} explosion colours`);
        return;
    }

    writeFileSync(OUT, json);

    console.log('wrote src/client/explosionColors.generated.json');
    for (const spec of EXPLOSIONS) {
        const e = explosions[spec.weapon] as { core: number[]; body: number[]; tail: number[] };
        console.log(
            `  ${spec.weapon.padEnd(20)} ${spec.shader.padEnd(17)} ` +
                `core ${e.core.join(', ')}  body ${e.body.join(', ')}  tail ${e.tail.join(', ')}`
        );
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
