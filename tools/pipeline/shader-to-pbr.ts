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
 * | best-ranked non-additive stage | `texture_albedo`                         |
 * | `blendfunc add` stage       | `texture_emissive` -- an additive pass over |
 * |                             | a lit surface *is* a glow map               |
 * | `q3map_surfacelight <n>`    | emissive intensity, and a real point light  |
 * | `q3map_lightimage <tex>`    | emissive texture when no additive stage     |
 * | `q3map_sun r g b i deg elev`| a directional light for the map             |
 * | stage 0's `blendFunc`       | transparency mode -- Q3's own sort rule     |
 * | `alphaFunc`                 | `mask`, when stage 0 does not blend         |
 * | each stage's `blendFunc`    | what that image's alpha channel means       |
 * | `cull none`/`twosided`      | double-sided                                |
 * | `qer_editorimage`           | last-resort albedo when nothing else names one |
 * | *every* stage `tcGen environment` | `environmentMapped` -- the images are a |
 * |                             | fake reflection and not a skin, so they are  |
 * |                             | flattened rather than sampled at the model's UVs |
 *
 * **Dropped**, because it is a rasteriser trick with no surface meaning:
 * `tcMod` (scroll/scale/rotate/turb/stretch), `deformVertexes`, `rgbGen wave`,
 * `alphaGen`, `animMap`, `tcGen environment`, multi-pass blend equations beyond
 * the albedo/emissive split above, `sort`, `polygonOffset` detail passes,
 * `videomap`, and every `q3map_*` directive that only spoke to the light
 * compiler.
 *
 * # A `tcGen environment` shader does not name a surface
 *
 * `RB_CalcEnvironmentTexCoords` builds a stage's UVs per vertex per frame, from
 * the reflected view vector, and throws the model's own away. So an MD3 drawn
 * through such a shader carries whatever texture coordinates its author left in
 * it -- and for the four health crosses that is filler, and for the four health
 * shells and `mega_cross.md3` it is literally the same `(0, 1)` on every vertex.
 * Q3 never read them, so nobody ever noticed.
 *
 * Sampling a *spherical environment map* at those coordinates is what a pickup
 * covered in torn black and olive patches is: `envmapligh.jpg` is a chrome
 * reflection, and the port was drawing arbitrary slices of it as if it were
 * paint. The mega health cross came out solid black, that being the colour of
 * `envmapblue2.jpg`'s bottom-left texel, and all four shells came out invisible
 * for the same reason.
 *
 * There is no static restatement of a view-dependent lookup, so the flag says
 * what is true -- these images are not artwork of a surface -- and the writers
 * reduce each of them to its mean colour. That is what an env-mapped object
 * averages to as it spins, it keeps the one thing the artwork is carrying (a
 * health cross is green, yellow, orange or blue by size), and it does not depend
 * on a texture coordinate that means nothing.
 *
 * Every drop that changes how a surface looks is counted and reported, so the
 * conversion's own lossiness is a number rather than a vibe.
 *
 * # Transparency comes from stage 0's blend, and from nothing else
 *
 * `tr_shader.c:FinishShader` decides which pass a shader is drawn in by asking
 * one question: does **stage 0** set blend bits? If it does, the shader sorts
 * into `SS_BLEND0`/`SS_SEE_THROUGH`; if it does not, `shader.sort = SS_OPAQUE`,
 * however many later stages blend. That is the whole rule, and it is reproduced
 * here literally -- including `ParseStage`'s two normalisations: the
 * `add`/`filter`/`blend` shorthands, and *"implicitly assume that a GL_ONE
 * GL_ZERO blend mask disables blending"*.
 *
 * `surfaceparm trans` is **not** consulted, because Q3's renderer does not
 * consult it either. `infoParms` maps it to `CONTENTS_TRANSLUCENT` with surface
 * flags of zero, and the comment beside it says what it is for: *"don't eat
 * contained surfaces"*, a hint to the BSP compiler about vis and light. An
 * earlier version of this file read it as "draw this blended", which made
 * `textures/liquids/lavahell` -- opaque geometry with an additive second pass --
 * see-through, and rescued a handful of genuinely additive shaders by accident.
 * Both were the same mistake.
 *
 * # An additive surface is a transparent emitter, not an opaque one
 *
 * meep has three transparency modes -- opaque, alpha-tested, alpha-blended --
 * and no additive one, so a shader whose *only* drawn passes are additive has to
 * be restated in the terms that exist. It is the same restatement
 * `convert-fx.ts` makes for the additive sprites (D-079): **luminance becomes
 * coverage**, because a `blendfunc add` image is authored over black and its
 * brightness is exactly how much of the destination it replaces.
 *
 * Such a shader becomes an alpha-blended material with
 *
 *   - albedo: the same image restated as *black* with `luminance` in alpha, so
 *     it contributes coverage and no diffuse -- the colour has to be emitted
 *     rather than shaded, or a flame is lit by the room it is lighting;
 *   - emissive: the image itself, at intensity 1 or at `q3map_surfacelight`.
 *
 * which composites to `src * L + dst * (1 - L)` against Q3's `dst + src`. The
 * two agree where the image is black and where it is bright, and the port
 * under-brightens in between rather than over-brightening -- the same trade
 * D-079 already took.
 *
 * # What an image's alpha channel means depends on the blend that read it
 *
 * meep premultiplies on upload and un-premultiplies in the shader, so an alpha
 * channel that reaches it is *load-bearing*: a texel at alpha 0 shades black.
 * Q3 had no such coupling -- a stage with no `blendFunc`, or `filter`, or `add`
 * ignores the image's alpha entirely, and a good many OA textures carry a
 * leftover one. Nineteen of the shipping albedo images do, the red armour and
 * the railgun skin among them.
 *
 * Every texture reference therefore carries the blend it was authored for, and
 * `texture-out.ts` holds the restatements. See {@link ImageBlend}.
 */

import {
    directive,
    directivesAll,
    type ShaderScriptEntry,
    type ShaderStage,
} from './shader-script.ts';
import { LUX_PER_BYTE } from './lightgrid.ts';

export type TransparencyMode = 'opaque' | 'mask' | 'blend';

/**
 * What an image's alpha channel means, named after the Q3 blend that read it.
 *
 * The name is the blend rather than the operation, for the reason `convert-fx.ts`
 * gives: the blend is the fact and the operation is the consequence.
 * `texture-out.ts` holds the consequences.
 *
 * - `opaque` -- the stage ignored the alpha channel: no `blendFunc`, or `GL_ONE
 *   GL_ZERO`, or `filter`, or an additive stage taken as an *emissive*, where
 *   alpha would only dim the glow. Any alpha in the file is a leftover.
 * - `alpha` -- `blendFunc blend`, or an `alphaFunc` test. Alpha is coverage and
 *   the file already says what meep wants.
 * - `add` -- any blend whose destination factor is `GL_ONE` and so cannot occlude
 *   what is behind it, taken as an *albedo*. Coverage is the image's own
 *   luminance; the colour goes to the emissive slot instead.
 * - `addAlpha` -- `GL_SRC_ALPHA GL_ONE`, the same thing scaled by the image's
 *   alpha, which is what OA's flames and most of its sprites use.
 * - `filter` -- `GL_DST_COLOR GL_ZERO`, a multiply. `dst * src` with a greyscale
 *   source is *exactly* black at coverage `1 - luminance`, which is D-079's
 *   identity read the other way round, and is how the fog brushes darken a room
 *   rather than filling it with a grey wall.
 * - `premultiplied` -- `GL_ONE GL_ONE_MINUS_SRC_ALPHA`. Colour is already
 *   multiplied by coverage and has to be divided back out, or meep premultiplies
 *   it a second time.
 */
export type ImageBlend = 'opaque' | 'alpha' | 'add' | 'addAlpha' | 'filter' | 'premultiplied';

export interface PbrMaterial {
    readonly name: string;
    /** Virtual texture path, without extension; the resolver picks `.jpg`/`.tga`. */
    readonly albedo: string | null;
    /** The Q3 blend the albedo image was authored for. See {@link ImageBlend}. */
    readonly albedoBlend: ImageBlend;
    /**
     * Virtual path of the image a tangent-space normal map was derived *from*,
     * or `null` when this surface takes none -- sky, nodraw, unlit, blended, or
     * no albedo at all. Not a {@link textureKey}: a generated map belongs to the
     * artwork, not to the Q3 blend a stage restated it through.
     */
    readonly normal: string | null;
    /**
     * Virtual path of the image an ORM map was derived *from*, or `null`. G is
     * roughness, B is metalness, R stays 1.0 -- meep runs GTAO off the g-buffer
     * shading normal, so a baked occlusion channel would only fight it.
     */
    readonly orm: string | null;
    readonly emissive: string | null;
    readonly emissiveLuminance: number;
    /**
     * Every drawn stage was `tcGen environment`, so no image here is a skin.
     *
     * The shader names textures, but it never asked for them to be sampled at
     * the model's own texture coordinates -- see {@link ImageBlend}'s neighbour
     * problem, one level up. A caller that writes these images has to flatten
     * them; `texture-out.ts` holds the restatement and the argument for it.
     */
    readonly environmentMapped: boolean;
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
    /** Q3 drew this without any baked or dynamic lighting. See {@link UNLIT_LUMINANCE}. */
    readonly unlit: boolean;
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

/**
 * What an *unlit* Q3 surface is worth, in cd/m2.
 *
 * Q3 draws a shader with no `$lightmap` stage at its texture's own brightness,
 * unmodulated by anything in the room -- `identityLighting`, which is 1.0 once
 * the overbright shift is undone. Every flame, beam, waterfall and portal in
 * the game is drawn that way, and in a renderer that shades everything from
 * photometric lights there is exactly one way to say "not shaded": emit it.
 *
 * The number is the port's own ceiling on how brightly anything is lit. A
 * lightgrid byte is `LUX_PER_BYTE` lux (D-078) and a byte holds 255, so 51 lux
 * is the most illumination this calibration admits; a Lambertian surface under
 * it reflects `51 / pi` times its albedo. An unlit surface emits what a fully
 * lit one of the same texture would reflect, which is Q3's own equivalence --
 * an unlit stage and a lightmapped stage at full white draw the same pixel.
 *
 * Against this port's measured 1 to 6 cd/m2 for an ordinary lit wall, that puts
 * a torch flame three to sixteen times brighter than the room it is in, which
 * is what a torch in a Quake III dungeon looks like.
 */
export const UNLIT_LUMINANCE = (LUX_PER_BYTE * 255) / Math.PI;

/** Strip a texture reference down to a virtual path without extension. */
function texturePath(token: string | undefined): string | null {
    if (token === undefined) return null;

    const t = token.replace(/\\/g, '/').toLowerCase().trim();

    // `$lightmap` and `$whiteimage` are renderer built-ins, not files.
    if (t.startsWith('$')) return null;
    if (t === '' || t === '-') return null;

    return t.replace(/\.(tga|jpg|jpeg|png|pcx)$/i, '');
}

/**
 * How one stage combines with the framebuffer.
 *
 * `none` covers both an absent `blendFunc` and `GL_ONE GL_ZERO`, which
 * `ParseStage` collapses to the same thing. `other` is every blend equation this
 * projection has no use for -- `GL_ZERO GL_ONE_MINUS_SRC_COLOR` and the rest.
 * It still counts as *a* blend for the sort test, which is the only thing asked
 * of it there.
 *
 * The additive family is recognised by its **destination** factor rather than by
 * an enumeration of source factors. A stage whose destination factor is `GL_ONE`
 * keeps everything already in the framebuffer, so it cannot occlude anything, so
 * whatever coverage it has must come from its own brightness. That is one
 * statement covering `GL_ONE GL_ONE`, `GL_SRC_ALPHA GL_ONE` and `GL_DST_COLOR
 * GL_ONE` -- OA's flames, its beams and its water, none of which are opaque and
 * all three of which the port used to draw that way.
 */
type StageBlend = 'none' | 'filter' | 'add' | 'addAlpha' | 'alpha' | 'premultiplied' | 'other';

function blendOf(stage: ShaderStage): StageBlend {
    const d = directive(stage.directives, 'blendfunc');
    if (d === null) return 'none';

    let src = (d[1] ?? '').toLowerCase();
    let dst = (d[2] ?? '').toLowerCase();

    // `ParseStage`'s three "simple" blends, expanded exactly as the C expands them.
    if (src === 'add') {
        src = 'gl_one';
        dst = 'gl_one';
    } else if (src === 'filter') {
        src = 'gl_dst_color';
        dst = 'gl_zero';
    } else if (src === 'blend') {
        src = 'gl_src_alpha';
        dst = 'gl_one_minus_src_alpha';
    }

    // "implicitly assume that a GL_ONE GL_ZERO blend mask disables blending"
    if (src === 'gl_one' && dst === 'gl_zero') return 'none';

    // Additive: the destination survives whole, so `GL_ZERO <src>` draws nothing.
    if (dst === 'gl_one' && src !== 'gl_zero') {
        return src === 'gl_src_alpha' ? 'addAlpha' : 'add';
    }

    if (src === 'gl_dst_color' && dst === 'gl_zero') return 'filter';
    if (src === 'gl_src_alpha' && dst === 'gl_one_minus_src_alpha') return 'alpha';
    if (src === 'gl_one' && dst === 'gl_one_minus_src_alpha') return 'premultiplied';

    return 'other';
}

interface StageInfo {
    /** Virtual texture path, or `null` for `$lightmap` and the other built-ins. */
    readonly path: string | null;
    readonly blend: StageBlend;
    /** `GT0`/`GE128`/`LT128`, upper-cased, or `null`. */
    readonly alphaFunc: string | null;
    /** See {@link isShadedPass}. */
    readonly shaded: boolean;
    /** `tcGen environment`: the stage's texture coordinates are not the model's. */
    readonly environment: boolean;
    /** See {@link rankStage}. */
    readonly rank: number;
}

/** `tcGen environment` -- Q3 generating this stage's UVs from the reflected view. */
function isEnvironmentStage(stage: ShaderStage): boolean {
    return (directive(stage.directives, 'tcgen')?.[1]?.toLowerCase() ?? '') === 'environment';
}

/**
 * How good a single stage is as *the* image for the surface.
 *
 * These are `VertexLightingCollapse`'s weights, which is Q3 answering the same
 * question this projection has to answer -- if only one of these passes can be
 * drawn, which one carries the surface? -- on its way down to vertex lighting.
 * Resolving ties in favour of the earlier stage is the C's too, and falls out of
 * comparing with a strict `>`.
 *
 * The lightmap term is absent because a `map $lightmap` stage has no path and so
 * is never a candidate here.
 */
function rankStage(stage: ShaderStage): number {
    let rank = 0;

    const tcGen = directive(stage.directives, 'tcgen')?.[1]?.toLowerCase();
    if (tcGen !== undefined && tcGen !== 'base' && tcGen !== 'texture') rank -= 5;

    if (directivesAll(stage.directives, 'tcmod').length > 0) rank -= 5;

    const rgbGen = directive(stage.directives, 'rgbgen')?.[1]?.toLowerCase();
    if (rgbGen !== undefined && rgbGen !== 'identity' && rgbGen !== 'identitylighting') rank -= 3;

    return rank;
}

/** The image a stage names: `map`, `clampmap`, or an `animMap`'s first frame. */
function stagePath(stage: ShaderStage): string | null {
    const map = directive(stage.directives, 'map') ?? directive(stage.directives, 'clampmap');
    const animMap = directive(stage.directives, 'animmap');
    return texturePath(map?.[1]) ?? texturePath(animMap?.[2]);
}

/** Whether Q3 would have counted the stage as active, i.e. whether it names an image. */
function isActive(stage: ShaderStage): boolean {
    return (
        directive(stage.directives, 'map') !== null ||
        directive(stage.directives, 'clampmap') !== null ||
        directive(stage.directives, 'animmap') !== null
    );
}

/**
 * Whether a stage's brightness is computed from the scene rather than authored.
 *
 * `rgbGen lightingDiffuse` and `alphaGen lightingSpecular` are Q3 shading a pass
 * with the room's lights -- `RB_CalcSpecularAlpha` computes a reflected-view
 * coefficient and puts it in the alpha -- and `tcGen environment` is Q3 sampling
 * the surroundings. All three are how 1999 hardware faked specular and
 * reflection, and a PBR material does both of them natively out of `roughness`,
 * `metallic` and the IBL.
 *
 * This matters because those passes are *additive*, and an additive pass over a
 * lit surface is otherwise exactly the shape of a glow map. Nine of the shipping
 * materials are the weapons and armour, whose second copy of their own skin is a
 * highlight; promoting that to an emissive lights the railgun up like a lamp.
 */
function isShadedPass(stage: ShaderStage): boolean {
    const rgbGen = directive(stage.directives, 'rgbgen')?.[1]?.toLowerCase() ?? '';
    const alphaGen = directive(stage.directives, 'alphagen')?.[1]?.toLowerCase() ?? '';

    return rgbGen.startsWith('lighting') || alphaGen.startsWith('lighting') || isEnvironmentStage(stage);
}

/** What the alpha channel of an image drawn through this blend means. */
function imageBlendOf(blend: StageBlend, alphaFunc: string | null): ImageBlend {
    if (alphaFunc !== null) return 'alpha';

    switch (blend) {
        case 'add':
            return 'add';
        case 'addAlpha':
            return 'addAlpha';
        case 'alpha':
            return 'alpha';
        case 'filter':
            return 'filter';
        case 'premultiplied':
            return 'premultiplied';
        default:
            return 'opaque';
    }
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

    /*
     Q3 lights a surface in one of three ways, and the third is "not at all".
     `FinishShader` tracks `hasLightmapStage` for exactly this reason: a shader
     with one is modulated by the baked light, one that {@link isShadedPass}
     recognises is shaded by the scene, and one with neither is drawn at its own
     brightness whatever the room is doing. Every flame, beam, waterfall, portal
     and fullbright pickup in the game is the third kind.

     `isShadedPass` rather than a lightmap test alone, because a `tcGen
     environment` pass is *also* shaded by the scene -- it samples the
     surroundings. Without that the chrome shells on the health pickups and the
     domination point skins came out as emitters, which is a reflection read as a
     light.

     An implicit texture -- a name with no script at all -- is never unlit: Q3
     builds it a default shader that carries a lightmap stage when the surface
     has a lightmap, and vertex lighting when it does not.
    */
    const unlit =
        entry.stages.length > 0 &&
        !entry.stages.some((s) => {
            const map = directive(s.directives, 'map') ?? directive(s.directives, 'clampmap');
            if ((map?.[1] ?? '').toLowerCase() === '$lightmap') return true;
            return isShadedPass(s);
        });

    const cull = directive(entry.directives, 'cull');
    const cullMode = cull?.[1]?.toLowerCase() ?? 'front';
    const doubleSided = cullMode === 'none' || cullMode === 'twosided' || cullMode === 'disable';

    const surfaceLightDirective = directive(entry.directives, 'q3map_surfacelight');
    const surfaceLight =
        surfaceLightDirective === null ? 0 : Number.parseFloat(surfaceLightDirective[1] ?? '0') || 0;

    /* ---- read the stages ---- */

    const stages: StageInfo[] = entry.stages.filter(isActive).map((stage) => ({
        path: stagePath(stage),
        blend: blendOf(stage),
        alphaFunc: directive(stage.directives, 'alphafunc')?.[1]?.toUpperCase() ?? null,
        shaded: isShadedPass(stage),
        environment: isEnvironmentStage(stage),
        rank: rankStage(stage),
    }));

    /*
     Count the visually-lossy directives over every stage rather than only the
     ones that end up contributing: a dropped `tcMod scroll` on a pass this
     projection never looks at is still a drop.

     The shader's own directives are counted too, and that is not a formality:
     `deformVertexes` is only ever written at that level, so counting stages
     alone reported two of them across the whole OA set -- and those two were an
     artefact of a stage that a mis-read closing brace had failed to end.
    */
    for (const directives of [entry.directives, ...entry.stages.map((s) => s.directives)]) {
        for (const d of directives) {
            const kw = d[0]?.toLowerCase();
            if (kw === undefined) continue;

            if (kw === 'rgbgen') {
                const form = d[1]?.toLowerCase() ?? '';
                if (!RGBGEN_BENIGN.has(form)) dropped.push(`rgbGen ${form}`);
                continue;
            }

            if (VISUALLY_LOSSY.has(kw)) dropped.push(d.join(' '));
        }
    }

    /*
     `GT0` and `GE128` are the two Q3 tests a single cutoff can express. `LT128`
     -- draw where the image is *more* transparent -- is an inverted test that a
     cutoff cannot say at all, so it is recorded as a drop rather than quietly
     mapped onto its own opposite.
    */
    for (const s of stages) {
        if (s.alphaFunc === 'LT128') dropped.push('alphaFunc LT128');
    }

    /* ---- pick the albedo and emissive stages ---- */

    type DrawnStage = StageInfo & { readonly path: string };

    const drawn = stages.filter((s): s is DrawnStage => s.path !== null);
    const additive = (s: StageInfo): boolean => s.blend === 'add' || s.blend === 'addAlpha';

    /*
     A shader every one of whose drawn passes is `tcGen environment` names no
     surface at all. See the note on `environmentMapped` above; the *whole*
     shader has to be that way before the flag is set, because the ordinary case
     is a diffuse skin with a chrome highlight added over it, and there the skin
     is the albedo and `rankStage` has already preferred it.
    */
    const environmentMapped = drawn.length > 0 && drawn.every((s) => s.environment);

    const best = (candidates: readonly DrawnStage[]): DrawnStage | null => {
        let winner: DrawnStage | null = null;
        for (const s of candidates) {
            if (winner === null || s.rank > winner.rank) winner = s;
        }
        return winner;
    };

    /*
     An additive pass over a lit surface is a glow map, so it is the emissive and
     never the albedo -- unless it is all there is, in which case it is both, and
     `ImageBlend` says how the one image is restated for each slot.

     What stops that from lighting up every weapon in the game is `isShadedPass`.
     A shader that draws its own skin twice, diffusely and then additively at a
     specular coefficient, is asking for a highlight; a PBR material has one. So a
     *shaded* additive pass is a glow map only when the shader has nothing else --
     at which point it is an effect surface, its colour has to come from
     somewhere, and emitted is the only thing it can be.
    */
    const surface = drawn.filter((s) => !additive(s));
    const albedoStage = best(surface) ?? best(drawn);
    const emissiveStage =
        drawn.find((s) => additive(s) && (surface.length === 0 || !s.shaded)) ?? null;

    let albedo: string | null = albedoStage?.path ?? null;
    let albedoBlend: ImageBlend =
        albedoStage === null ? 'opaque' : imageBlendOf(albedoStage.blend, albedoStage.alphaFunc);
    let emissive: string | null = emissiveStage?.path ?? null;

    /* ---- transparency: `FinishShader`'s rule, and only it ---- */

    const stage0 = stages[0];
    const blended = stage0 !== undefined && stage0.blend !== 'none';

    /*
     The alpha test is read off the *albedo* stage rather than off any stage,
     because an `alphaFunc` belongs to the pass that carries it -- Q3 puts
     `GLS_ATEST_*` in that stage's own state bits -- and the albedo stage is the
     one whose silhouette becomes the material's. Taking it from any stage
     alpha-tested the whole plasma gun on the strength of an `alphaFunc LT128`
     sitting on a pulsing glow pass three stages down.
    */
    const alphaTested = albedoStage?.alphaFunc ?? null;

    const transparency: TransparencyMode = blended
        ? 'blend'
        : alphaTested !== null
          ? 'mask'
          : 'opaque';

    const alphaCutoff = alphaTested === 'GT0' ? 0.01 : 0.5;

    /*
     An opaque material's albedo carries no alpha, whatever blend the stage that
     named it used. Q3 drew that image over an opaque stage 0 and the port keeps
     only one image; whatever the second one's alpha meant, it is not this
     surface's coverage, and meep would divide the colour by it. `am_thornish`'s
     two launch pads are the case: an opaque surface whose best-ranked stage is a
     `blendFunc blend` decal, whose alpha bottoms out at 77.
    */
    if (transparency === 'opaque') albedoBlend = 'opaque';

    // Fall back through the light image and then the editor image. Both are real
    // texture paths and both are better than an untextured surface.
    if (albedo === null) {
        albedo = texturePath(directive(entry.directives, 'q3map_lightimage')?.[1]);
        albedoBlend = 'opaque';
    }
    if (albedo === null) {
        albedo = texturePath(directive(entry.directives, 'qer_editorimage')?.[1]);
        albedoBlend = 'opaque';
    }

    // A surface that emits light but has no additive stage still wants an
    // emissive: `q3map_lightimage` is exactly the texture the light compiler used
    // for the emitted colour.
    if (emissive === null && surfaceLight > 0) {
        emissive = texturePath(directive(entry.directives, 'q3map_lightimage')?.[1]) ?? albedo;
    }

    /*
     An unlit surface emits its own texture, because that is the only way to say
     "not shaded" to a renderer that shades everything (see {@link
     UNLIT_LUMINANCE}). This is what a Q3 flame is: no `$lightmap` stage, no
     `rgbGen lightingDiffuse`, no additive pass either -- two plain
     `blendFunc blend` stages of a fire texture, drawn at full brightness. Shading
     it instead left `oa_dm5` with torches lit by the room they are lighting.

     A `filter` albedo is the exception and has to be: a multiply subtracts light
     rather than adding it, so a fog brush emitting its own grey would be a lamp
     in the shape of a cloud.
    */
    if (emissive === null && unlit && albedo !== null && albedoBlend !== 'filter') {
        emissive = albedo;
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
     Which surfaces are worth a normal map and an ORM, and what they are derived
     from.

     Both are named by the *source* image's virtual path rather than by
     {@link textureKey}, because a generated map belongs to the artwork and not
     to the Q3 blend some stage restated it through: `blocks10` referenced once
     opaque and once as a filter is one stone wall and wants one normal map.

     Four kinds of surface are left out, and each is left out because the map
     would be meaningless rather than merely unhelpful:

     - **No albedo.** Nothing to derive from.
     - **Sky and nodraw.** One is drawn as the environment and the other is not
       drawn at all.
     - **Unlit.** Q3 drew it at its own brightness and this port emits it; a
       normal perturbs a diffuse term it barely has.
     - **Blended.** An additive or filtered stage's image has been restated as
       coverage with the colour thrown away (`texture-out.ts`), so there is no
       surface in it to recover -- and a beam is not a surface anyway.

     That leaves the ordinary opaque and alpha-tested world, prop and character
     surfaces, which is the set the material phase is about.
    */
    const derivedFrom =
        albedo !== null && !isSky && !isNoDraw && !unlit && transparency !== 'blend'
            ? albedo
            : null;

    /*
     One candela per square metre, and that is a placeholder rather than a
     measurement.

     meep adds `material.emissive` straight into the shading result beside a
     diffuse term computed from photometric lights, so the field is a *luminance*
     and a shader on its own gives no way to know one. `convert-map.ts` does have
     a way -- it decides how much flux each `q3map_surfacelight` surface emits, so
     it can divide that by the surface's own area -- and it overwrites this for
     every declared emitter it places a light for.

     What is left here is the case with no declaration at all: an additive pass on
     a beam, a flame, a powerup shell. Q3 drew those at full strength into an LDR
     framebuffer, which says "about as bright as a fully lit wall" and nothing
     more precise. On this port's own maps a lit wall runs roughly 1 to 6 cd/m2
     -- 9 to 58 lux at the places a player stands, times a Q3 texture's albedo,
     over pi -- so unit luminance is the bottom of that band and is where an
     undeclared glow sits until something measures it.

     An earlier version divided `q3map_surfacelight` by 1000 and called the result
     an intensity. It was not in any unit: it put a ceiling panel at 0.3 while the
     wall it lit sat at several cd/m2, which is how the port ended up with light
     fixtures darker than what they illuminated.
    */
    const emissiveLuminance = emissive === null ? 0 : UNLIT_LUMINANCE;

    return {
        name: entry.name,
        albedo,
        albedoBlend,
        normal: derivedFrom,
        orm: derivedFrom,
        emissive,
        emissiveLuminance,
        environmentMapped,
        roughness,
        metallic,
        transparency,
        alphaCutoff,
        doubleSided,
        isSky,
        isNoDraw,
        unlit,
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
