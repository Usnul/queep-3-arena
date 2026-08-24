/*
 * shader-to-pbr.ts -- map Quake III `.shader` scripts onto meep PBR materials.
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
 * # What is kept and what is thrown away
 *
 * A Q3 shader is a list of blend passes over fixed-function hardware. A PBR
 * material is a description of a surface. These are not the same kind of object,
 * so this is a lossy projection, made once, offline, by hand-written rules.
 *
 * **Kept**, because it carries information about the surface:
 *
 * | Q3                          | PBR                                        |
 * |-----------------------------|--------------------------------------------|
 * | first opaque/filter stage   | `texture_albedo`                            |
 * | `blendfunc add` stage       | `texture_emissive` -- an additive pass over |
 * |                             | a lit surface *is* a glow map               |
 * | `q3map_surfacelight <n>`    | emissive intensity, and a real point light  |
 * | `q3map_lightimage <tex>`    | emissive texture when no additive stage     |
 * | `q3map_sun r g b i deg elev`| a directional light for the map             |
 * | `surfaceparm trans`/`alphaFunc` | transparency mode                       |
 * | `cull none`/`twosided`      | double-sided                                |
 * | `qer_editorimage`           | last-resort albedo when nothing else names one |
 *
 * **Dropped**, because it is a rasteriser trick with no surface meaning:
 * `tcMod` (scroll/scale/rotate/turb/stretch), `deformVertexes`, `rgbGen wave`,
 * `alphaGen`, `animMap`, `tcGen environment`, multi-pass blend equations beyond
 * the albedo/emissive split above, `sort`, `polygonOffset` detail passes,
 * `videomap`, and every `q3map_*` directive that only spoke to the light
 * compiler.
 *
 * Every drop that changes how a surface looks is counted and reported, so the
 * conversion's own lossiness is a number rather than a vibe.
 */

import { directive, directivesAll, type ShaderScriptEntry } from './shader-script.ts';

export type TransparencyMode = 'opaque' | 'mask' | 'blend';

export interface PbrMaterial {
    readonly name: string;
    /** Virtual texture path, without extension; the resolver picks `.jpg`/`.tga`. */
    readonly albedo: string | null;
    readonly emissive: string | null;
    readonly emissiveIntensity: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly transparency: TransparencyMode;
    /** Alpha cutoff for `mask`. */
    readonly alphaCutoff: number;
    readonly doubleSided: boolean;
    /** From `surfaceparm sky` -- rendered as the environment rather than geometry. */
    readonly isSky: boolean;
    /** From `surfaceparm nodraw`/`nodrawnonsolid` etc. -- collision only. */
    readonly isNoDraw: boolean;
    /** `q3map_surfacelight` intensity, 0 when absent. Drives point-light placement. */
    readonly surfaceLight: number;
    /** Directives that were understood but deliberately not represented. */
    readonly dropped: readonly string[];
    readonly source: string;
}

export interface SunLight {
    readonly color: readonly [number, number, number];
    readonly intensity: number;
    /** Compass degrees, Q3 convention. */
    readonly degrees: number;
    /** Elevation above the horizon, degrees. */
    readonly elevation: number;
    readonly shader: string;
}

/**
 * Directives that change a surface's appearance and that this conversion
 * deliberately does not represent. Counted so the report can state how lossy the
 * projection actually is, per shader and in total.
 */
const VISUALLY_LOSSY = new Set([
    'tcmod',
    'deformvertexes',
    'animmap',
    'tcgen',
    'alphagen',
    'videomap',
    'rgbgen', // only counted when it is a wave/entity form -- see below
]);

/** `rgbGen identity`/`identityLighting`/`vertex` are not visually lossy. */
const RGBGEN_BENIGN = new Set(['identity', 'identitylighting', 'vertex', 'exactvertex', 'const']);

const DEFAULT_ROUGHNESS = 0.85;
const DEFAULT_METALLIC = 0.0;

/** Strip a texture reference down to a virtual path without extension. */
function texturePath(token: string | undefined): string | null {
    if (token === undefined) return null;

    const t = token.replace(/\\/g, '/').toLowerCase().trim();

    // `$lightmap` and `$whiteimage` are renderer built-ins, not files.
    if (t.startsWith('$')) return null;
    if (t === '' || t === '-') return null;

    return t.replace(/\.(tga|jpg|jpeg|png|pcx)$/i, '');
}

function isAdditive(blend: readonly string[] | null): boolean {
    if (blend === null) return false;

    const a = blend[1]?.toLowerCase() ?? '';
    const b = blend[2]?.toLowerCase() ?? '';

    if (a === 'add' || a === 'gl_one') {
        // `blendFunc add` or `blendFunc GL_ONE GL_ONE`
        return a === 'add' || b === 'gl_one';
    }

    return false;
}

function isFilter(blend: readonly string[] | null): boolean {
    if (blend === null) return false;

    const a = blend[1]?.toLowerCase() ?? '';
    const b = blend[2]?.toLowerCase() ?? '';

    // `blendFunc filter` == GL_DST_COLOR GL_ZERO: this is the diffuse pass being
    // multiplied into the lightmap, i.e. the albedo.
    return a === 'filter' || (a === 'gl_dst_color' && b === 'gl_zero');
}

function isAlphaBlend(blend: readonly string[] | null): boolean {
    if (blend === null) return false;

    const a = blend[1]?.toLowerCase() ?? '';
    const b = blend[2]?.toLowerCase() ?? '';

    return a === 'blend' || (a === 'gl_src_alpha' && b === 'gl_one_minus_src_alpha');
}

/**
 * Project one shader script entry onto a PBR material.
 */
export function shaderToPbr(entry: ShaderScriptEntry): PbrMaterial {
    const dropped: string[] = [];

    const surfaceParms = new Set(
        directivesAll(entry.directives, 'surfaceparm')
            .map((d) => d[1]?.toLowerCase())
            .filter((s): s is string => s !== undefined)
    );

    const isSky = surfaceParms.has('sky');
    const isNoDraw =
        surfaceParms.has('nodraw') ||
        surfaceParms.has('nodrawnonsolid') ||
        surfaceParms.has('trigger') ||
        surfaceParms.has('clusterportal') ||
        surfaceParms.has('donotenter');

    const cull = directive(entry.directives, 'cull');
    const cullMode = cull?.[1]?.toLowerCase() ?? 'front';
    const doubleSided = cullMode === 'none' || cullMode === 'twosided' || cullMode === 'disable';

    const surfaceLightDirective = directive(entry.directives, 'q3map_surfacelight');
    const surfaceLight =
        surfaceLightDirective === null ? 0 : Number.parseFloat(surfaceLightDirective[1] ?? '0') || 0;

    /* ---- pick the albedo and emissive stages ---- */

    let albedo: string | null = null;
    let emissive: string | null = null;
    let transparency: TransparencyMode = 'opaque';
    let alphaCutoff = 0.5;

    for (const stage of entry.stages) {
        const map = directive(stage.directives, 'map') ?? directive(stage.directives, 'clampmap');
        const blend = directive(stage.directives, 'blendfunc');
        const alphaFunc = directive(stage.directives, 'alphafunc');

        // Count the visually-lossy directives in this stage.
        for (const d of stage.directives) {
            const kw = d[0]?.toLowerCase();
            if (kw === undefined) continue;

            if (kw === 'rgbgen') {
                const form = d[1]?.toLowerCase() ?? '';
                if (!RGBGEN_BENIGN.has(form)) dropped.push(`rgbGen ${form}`);
                continue;
            }

            if (VISUALLY_LOSSY.has(kw)) {
                dropped.push(d.join(' '));
            }
        }

        // `animMap` names several textures; take the first so an animated surface
        // is at least the right texture rather than untextured.
        const animMap = directive(stage.directives, 'animmap');
        const path = texturePath(map?.[1]) ?? texturePath(animMap?.[2]);

        if (path === null) continue;

        if (isAdditive(blend)) {
            // An additive pass over a lit surface is a glow map.
            emissive ??= path;
            continue;
        }

        if (alphaFunc !== null) {
            transparency = 'mask';
            const fn = alphaFunc[1]?.toUpperCase() ?? 'GT0';
            // GT0 / GE128 / LT128 -- the only three Q3 supports.
            alphaCutoff = fn === 'GE128' ? 0.5 : fn === 'LT128' ? 0.5 : 0.01;
            albedo ??= path;
            continue;
        }

        if (isAlphaBlend(blend)) {
            if (albedo === null) {
                transparency = 'blend';
                albedo = path;
            }
            continue;
        }

        // Opaque or `filter` (the diffuse-over-lightmap pass): this is the albedo.
        if (isFilter(blend) || blend === null) {
            albedo ??= path;
        }
    }

    // Fall back through the light image and then the editor image. Both are real
    // texture paths and both are better than an untextured surface.
    if (albedo === null) {
        albedo = texturePath(directive(entry.directives, 'q3map_lightimage')?.[1]);
    }
    if (albedo === null) {
        albedo = texturePath(directive(entry.directives, 'qer_editorimage')?.[1]);
    }

    // A surface that emits light but has no additive stage still wants an
    // emissive: `q3map_lightimage` is exactly the texture the light compiler used
    // for the emitted colour.
    if (emissive === null && surfaceLight > 0) {
        emissive =
            texturePath(directive(entry.directives, 'q3map_lightimage')?.[1]) ?? albedo;
    }

    if (surfaceParms.has('trans') && transparency === 'opaque') {
        transparency = 'blend';
    }

    /*
     Q3 had no notion of roughness or metalness, so both are conventions rather
     than data. Uniform dielectric with high roughness is the least-wrong default
     for painted metal, concrete and rock, which is most of the OA texture set. A
     texture-name heuristic would guess wrong often enough to look like a bug.
    */
    const roughness = DEFAULT_ROUGHNESS;
    const metallic = DEFAULT_METALLIC;

    /*
     `q3map_surfacelight` is in the light compiler's own units, where 1000-2000 is
     a normal ceiling light. Dividing by 1000 puts a typical emitter near 1-2,
     which reads correctly against meep's PBR range without a per-shader tuning
     pass.
    */
    const emissiveIntensity = surfaceLight > 0 ? Math.min(surfaceLight / 1000, 8) : 0;

    return {
        name: entry.name,
        albedo,
        emissive,
        emissiveIntensity,
        roughness,
        metallic,
        transparency,
        alphaCutoff,
        doubleSided,
        isSky,
        isNoDraw,
        surfaceLight,
        dropped,
        source: entry.source,
    };
}

/**
 * Extract `q3map_sun` from a shader entry, if present.
 *
 * Syntax: `q3map_sun <red> <green> <blue> <intensity> <degrees> <elevation>`.
 * `q3map_sunExt` adds deviance and sample count, which only affected the light
 * compiler's soft-shadow quality and is ignored.
 */
export function shaderSun(entry: ShaderScriptEntry): SunLight | null {
    const d =
        directive(entry.directives, 'q3map_sun') ?? directive(entry.directives, 'q3map_sunext');

    if (d === null) return null;

    const num = (i: number, fallback: number): number => {
        const v = Number.parseFloat(d[i] ?? '');
        return Number.isFinite(v) ? v : fallback;
    };

    return {
        color: [num(1, 1), num(2, 1), num(3, 1)],
        intensity: num(4, 100),
        degrees: num(5, 0),
        elevation: num(6, 45),
        shader: entry.name,
    };
}
