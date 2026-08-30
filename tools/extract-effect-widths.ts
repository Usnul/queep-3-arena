/*
 * extract-effect-widths.ts -- how wide Q3's flat effect shaders actually paint.
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
 * Four of Q3's weapon effects are a *quad with a picture on it*: the plasma
 * bolt, the lightning beam, the railgun core and the machinegun tracer. This
 * port draws all four as solid geometry -- an emissive sphere and three tubes --
 * because the renderer has bloom and local lights where Q3 had a painted
 * falloff, and a sphere that lights the corridor it flies down is a better
 * picture than a decal that does not (D-130).
 *
 * **The number the C gives for each of them is the size of the image, not the
 * size of the light**, and that is the whole reason this tool exists. Every one
 * of those four textures is a narrow bright filament or core sitting inside a
 * wide dark margin, and the margin is the shader's own falloff. Transcribing the
 * quad's half-extent onto solid geometry paints the entire falloff at core
 * brightness, which is a plasma bolt the size of a wall brick and a lightning
 * beam you could walk along. See D-156.
 *
 * # What is measured
 *
 * The **equivalent width** of the shader's cross-section: the width of the
 * top-hat carrying the same total light at the same peak brightness.
 *
 *     beam:    W_eq = integral(I dv) / peak(I)
 *     sprite:  R_eq = sqrt( integral(I dA) / (pi * peak(I)) )
 *
 * Threshold-free, which is the point -- "where does the glow end" has no answer
 * and every percentile is a different opinion, while this one is an integral.
 * It is also invariant to how many additive passes a shader stacks: a second
 * copy of the same image scales the integral and the peak together, so
 * `sprites/plasma1` drawing `plasmaa.tga` twice measures the same as once. On
 * these four it lands within 15% of the half-maximum width, which is the sanity
 * check that the profiles have no pathological tail; both are reported.
 *
 * Intensity is luminance, because all four stages are additive (`blendfunc add`
 * or `GL_SRC_ALPHA GL_ONE` over a texture with no alpha channel), so what a
 * texel contributes to the frame is what it is worth here.
 *
 * # What is not measured
 *
 * The quad extents themselves, which stay written down below with their
 * citations. They were never wrong -- `ent.radius = 16` really is Q3's sprite
 * half-extent -- and lifting a renderer literal and two cvar defaults out of C
 * by regex would be a fragile way to restate four numbers that have not moved
 * since 1999.
 *
 * Output: `src/client/effectWidths.generated.json`, committed for the same
 * reasons `balance.generated.json` is -- it derives from GPLv2 content, it is
 * small, and the runtime must not depend on the asset tree being present.
 * `--check` fails if it is stale, and is wired into `npm run check`.
 *
 * Usage:  node tools/extract-effect-widths.ts [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { ShaderIndex } from './pipeline/shader-index.ts';
import { decodeTga } from './pipeline/tga.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const OUT = join(ROOT, 'src', 'client', 'effectWidths.generated.json');

/** Whether the shader paints a beam across a quad or a sprite about a point. */
type Geometry = 'beam' | 'sprite';

interface EffectSpec {
    /** `WP_*`, so the runtime tables can be keyed the way every other one is. */
    readonly weapon: string;
    /** The Q3 shader whose artwork decides the answer. */
    readonly shader: string;
    readonly geometry: Geometry;
    /**
     * The full span of Q3's quad in Q3 units -- a diameter, never a half-extent.
     *
     * Every one of the four C numbers is a half-extent, because both places that
     * build these quads work outwards from a centre line: `RB_AddQuadStamp` puts
     * corners at `origin +/- left +/- up` for a sprite, and `DoRailCore` extrudes
     * `+/-spanWidth` for a beam. So each is doubled here, once, where it can be
     * read against its citation.
     */
    readonly quadQ3: number;
    /** Where that number comes from, for the generated file to carry. */
    readonly quadSource: string;
    /** What the port draws instead, for the record. */
    readonly drawnAs: string;
}

const EFFECTS: readonly EffectSpec[] = [
    /*
     `CG_Missile`'s early return for the one projectile Q3 draws without a model:
     `reType = RT_SPRITE; radius = 16; customShader = plasmaBallShader`, and
     `cgs.media.plasmaBallShader` is `sprites/plasma1`. `RB_SurfaceSprite` scales
     the view's right and up axes by `e.radius` and hands them to
     `RB_AddQuadStamp`, which corners at `origin +/- left +/- up` -- so 16 is a
     half-extent and the bolt is 32 units across.
    */
    {
        weapon: 'WP_PLASMAGUN',
        shader: 'sprites/plasma1',
        geometry: 'sprite',
        quadQ3: 32,
        quadSource: "CG_Missile's `ent.radius = 16`, doubled: RB_SurfaceSprite is a half-extent",
        drawnAs: 'emissive sphere with a point light inside it (MissileView.plasmaBall)',
    },

    /*
     `RB_SurfaceLightningBolt` calls `DoRailCore(start, end, right, len, 8)` four
     times, rolling `right` 45 degrees between them, so the bolt is four quads on
     one axis rather than four widths. `cgs.media.lightningShader` is
     `lightningBoltNew` in the OA cgame -- an eight-frame `animmap` over
     `textures/oafx/lbeam[3-8].tga`, twice, at two scroll rates.
    */
    {
        weapon: 'WP_LIGHTNING',
        shader: 'lightningBoltNew',
        geometry: 'beam',
        quadQ3: 16,
        quadSource: "RB_SurfaceLightningBolt's literal spanWidth 8, doubled: DoRailCore extrudes +/-",
        drawnAs: 'Trail3D stroke (Effects.hitscanTrail)',
    },

    /*
     `CG_RailTrail`'s `RT_RAIL_CORE`, drawn by `RB_SurfaceRailCore` as
     `DoRailCore(..., r_railCoreWidth->integer)`; the cvar's default is "6"
     (`tr_init.c`). `cgs.media.railCoreShader` is `railCore`.

     Q3 also draws `RT_RAIL_RINGS` -- the spiral, `r_railWidth` 16 -- and this
     port does not. That is an omission and not a reason to fatten the core:
     a core widened to stand in for a missing spiral is a number that means
     nothing and cannot be checked against anything.
    */
    {
        weapon: 'WP_RAILGUN',
        shader: 'railCore',
        geometry: 'beam',
        quadQ3: 12,
        quadSource: 'r_railCoreWidth default 6, doubled: DoRailCore extrudes +/-',
        drawnAs: 'Trail3D stroke (Effects.hitscanTrail)',
    },

    /*
     `CG_Tracer` builds the quad by hand -- `VectorMA(start, +/-cg_tracerWidth,
     right, ...)` -- and the cvar's default is "1". `cgs.media.tracerShader` is
     `gfx/misc/tracer`. The chaingun shares it; `CG_Bullet` is one function.
    */
    {
        weapon: 'WP_MACHINEGUN',
        shader: 'gfx/misc/tracer',
        geometry: 'beam',
        quadQ3: 2,
        quadSource: 'cg_tracerWidth default 1, doubled: CG_Tracer extrudes +/-',
        drawnAs: 'Trail3D stroke (Effects.hitscanTrail)',
    },
];

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

/** Rec. 709 luminance, which is what an additive texel contributes. */
function luminance(rgba: Uint8Array, i: number): number {
    return 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
}

interface Profile {
    /** Equivalent width, as a fraction of the quad's full span. */
    readonly equivalent: number;
    /** Full width at half maximum, same units. The cross-check. */
    readonly halfMaximum: number;
}

/**
 * A beam's cross-section: mean luminance per row, averaged along the beam.
 *
 * Along the beam is the right axis to average over. `DoRailCore` runs the
 * texture's `u` down the length and its `v` across the width, and both lightning
 * and rail textures are a stroke that *wanders* within the image rather than
 * sitting on the centre line -- so a single column measures where the stroke is
 * at one point and the average measures the band it stays inside, which is the
 * band a player sees.
 */
function beamProfile(image: Image): Profile {
    const { width, height, rgba } = image;
    const row = new Float64Array(height);

    for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let x = 0; x < width; x++) sum += luminance(rgba, (y * width + x) * 4);
        row[y] = sum / width;
    }

    return profileOf(row, height);
}

/**
 * A sprite's cross-section: mean luminance per ring about the centre.
 *
 * Out to the inscribed circle only. A sprite is sampled with `tcMod rotate` in
 * both of `sprites/plasma1`'s stages, so the corners of the image rotate in and
 * out of the quad over time and the disc is the part that is always on it.
 *
 * The returned width is a *diameter*, so that every number this tool emits is
 * one and a caller cannot halve the wrong one: the equivalent radius is
 * `sqrt(E / (pi * peak))` over the disc, doubled.
 */
function spriteProfile(image: Image): Profile {
    const { width, height, rgba } = image;

    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const maxRadius = Math.min(width, height) / 2;

    const bins = 256;
    const sum = new Float64Array(bins);
    const count = new Float64Array(bins);
    let total = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const r = Math.hypot(x - cx, y - cy) / maxRadius;
            if (r > 1) continue;

            const value = luminance(rgba, (y * width + x) * 4);
            const bin = Math.min(bins - 1, Math.floor(r * bins));

            sum[bin]! += value;
            count[bin]! += 1;
            total += value;
        }
    }

    const ring = new Float64Array(bins);
    for (let i = 0; i < bins; i++) ring[i] = count[i]! > 0 ? sum[i]! / count[i]! : 0;

    const peak = Math.max(...ring);

    /*
     `total` is a sum over pixels and `maxRadius` is in pixels, so dividing by
     `maxRadius^2` puts the integral in units of the half-extent squared -- which
     is what makes the result a fraction of the quad rather than a pixel count.
    */
    const equivalentRadius = Math.sqrt(total / (Math.PI * peak) / (maxRadius * maxRadius));

    // The outermost ring still at half the peak, as a fraction of the radius.
    let outer = bins - 1;
    while (outer >= 0 && ring[outer]! < peak / 2) outer -= 1;

    return {
        equivalent: equivalentRadius,
        halfMaximum: (outer + 1) / bins,
    };
}

/** Equivalent width and FWHM of a 1-D profile, as fractions of its full span. */
function profileOf(samples: Float64Array, span: number): Profile {
    const peak = Math.max(...samples);

    let area = 0;
    for (const s of samples) area += s;

    let low = 0;
    while (low < span && samples[low]! < peak / 2) low += 1;

    let high = span - 1;
    while (high >= 0 && samples[high]! < peak / 2) high -= 1;

    return {
        equivalent: area / peak / span,
        halfMaximum: high < low ? 0 : (high - low + 1) / span,
    };
}

/**
 * Every texture a shader's stages name, in the order they are drawn.
 *
 * Repeats are kept rather than deduplicated, because an `animmap` frame listed
 * twice is on screen twice as long and should weigh twice as much in the mean --
 * `lightningBoltNew` lists `lbeam7` four times across its two stages and
 * `lbeam3` twice.
 *
 * `$lightmap` and `$whiteimage` are Q3's built-ins and name no file.
 */
function stageTextures(index: ShaderIndex, shader: string): string[] {
    const entry = index.entry(shader);

    if (entry === null) throw new Error(`no shader script declares "${shader}"`);

    const paths: string[] = [];

    for (const stage of entry.stages) {
        for (const directive of stage.directives) {
            const keyword = directive[0]?.toLowerCase();

            if (keyword === 'map' || keyword === 'clampmap') {
                const path = directive[1];
                if (path !== undefined && !path.startsWith('$')) paths.push(path);
            } else if (keyword === 'animmap') {
                // `animmap <frequency> <frame> <frame> ...`
                for (const path of directive.slice(2)) {
                    if (!path.startsWith('$')) paths.push(path);
                }
            }
        }
    }

    if (paths.length === 0) throw new Error(`"${shader}" names no texture in any stage`);

    return paths;
}

/**
 * Rounded to hundredths of a Q3 unit, which is a thousandth of a player's width.
 *
 * Not decoration: `--check` compares the file byte for byte, and a JPEG decoded
 * by a different libjpeg build can differ in the last bit of a channel. A tenth
 * of a millimetre of beam is not a difference anyone can see and is not one
 * worth failing a build over.
 */
function round(value: number): number {
    return Math.round(value * 100) / 100;
}

async function measure(index: ShaderIndex, spec: EffectSpec) {
    const virtualPaths = stageTextures(index, spec.shader);

    const frames: { texture: string; equivalent: number; halfMaximum: number }[] = [];

    for (const virtualPath of virtualPaths) {
        const resolved = index.resolveTexture(virtualPath);

        if (resolved === null || !existsSync(join(EXTRACTED, resolved))) {
            throw new Error(`${spec.shader}: no file backs "${virtualPath}"`);
        }

        const image = await loadImage(resolved);
        const profile =
            spec.geometry === 'sprite' ? spriteProfile(image) : beamProfile(image);

        frames.push({
            texture: resolved,
            equivalent: profile.equivalent,
            halfMaximum: profile.halfMaximum,
        });
    }

    const mean = (pick: (f: (typeof frames)[number]) => number): number =>
        frames.reduce((a, f) => a + pick(f), 0) / frames.length;

    const equivalent = mean((f) => f.equivalent);
    const halfMaximum = mean((f) => f.halfMaximum);

    return {
        weapon: spec.weapon,
        shader: spec.shader,
        geometry: spec.geometry,
        quadQ3: spec.quadQ3,
        quadSource: spec.quadSource,
        drawnAs: spec.drawnAs,
        /** What the port should draw, in Q3 units. A diameter, both cases. */
        coreQ3: round(equivalent * spec.quadQ3),
        /** The cross-check, same units. Never used by the runtime. */
        halfMaximumQ3: round(halfMaximum * spec.quadQ3),
        /** How much of the quad the artwork actually lights. Thousandths. */
        coreFraction: Math.round(equivalent * 1000) / 1000,
        textures: [...new Set(frames.map((f) => f.texture))].sort(),
    };
}

async function main(): Promise<void> {
    if (!existsSync(EXTRACTED)) {
        console.error(`${EXTRACTED} does not exist; run: npm run setup`);
        process.exit(1);
    }

    const index = new ShaderIndex(EXTRACTED).load();

    const effects: Record<string, unknown> = {};

    for (const spec of EFFECTS) {
        effects[spec.weapon] = await measure(index, spec);
    }

    const json =
        JSON.stringify(
            {
                $generated: 'tools/extract-effect-widths.ts -- do not edit by hand',
                $source: 'OpenArena shader scripts and textures under assets/extracted',
                $method:
                    'equivalent width of the shader cross-section, integral(I)/peak(I), ' +
                    'scaled by the Q3 quad span. Diameters, in Q3 units. See D-156.',
                effects,
            },
            null,
            1
        ) + '\n';

    if (process.argv.includes('--check')) {
        if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) {
            console.error(`${OUT} is stale; run: node tools/extract-effect-widths.ts`);
            process.exit(1);
        }
        console.error(`ok: ${EFFECTS.length} effect widths`);
        return;
    }

    writeFileSync(OUT, json);

    console.log('wrote src/client/effectWidths.generated.json');
    for (const spec of EFFECTS) {
        const e = effects[spec.weapon] as { coreQ3: number; halfMaximumQ3: number };
        console.log(
            `  ${spec.weapon.padEnd(14)} ${spec.shader.padEnd(20)} ` +
            `quad ${String(spec.quadQ3).padStart(2)}u -> core ${e.coreQ3.toFixed(2)}u ` +
            `(FWHM ${e.halfMaximumQ3.toFixed(2)}u)`
        );
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
