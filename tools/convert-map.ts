/*
 * convert-map.ts -- turn a Quake III BSP into a meep-ready scene bundle.
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
 * Output, under `assets/built/<map>/`:
 *
 *   scene.json      materials, mesh table, lights, entities, statistics
 *   geometry.bin    interleaved vertices and indices for every mesh
 *   textures/*      referenced textures, TGA converted to PNG
 *
 * The runtime reads `scene.json`, slices `geometry.bin` into meep `Geometry`
 * objects and builds one entity per mesh. Nothing in this file imports meep --
 * the pipeline runs in Node and the engine is a browser concern.
 *
 * Usage:  node tools/convert-map.ts <mapname> [<mapname>...]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    BspFile,
    MST,
    VERT_STRIDE_F32,
    VERT_XYZ,
    VERT_ST,
    VERT_LIGHTMAP,
    VERT_NORMAL,
    VERT_COLOR_BYTES,
    VERT_STRIDE_BYTES,
    type BspSurface,
} from '../src/q3/bsp/BspFile.ts';
import { parseEntities, entityVector, entityNumber } from '../src/q3/bsp/Entities.ts';
import { ShaderIndex } from './pipeline/shader-index.ts';
import {
    derivedTextureKey,
    textureCache,
    textureCounts,
    textureKey,
    texturePathOf,
    writeDerivedTexture,
    type TextureCache,
    writeTexture,
} from './pipeline/texture-out.ts';
import { tessellatePatch, type PatchVertex } from '../src/q3/bsp/patch.ts';
import { UNLIT_LUMINANCE, type ImageBlend, type PbrMaterial } from './pipeline/shader-to-pbr.ts';
import { readLightGrid } from '../src/q3/bsp/LightGrid.ts';
import {
    fitGridLights,
    luma,
    residualOf,
    sitesFromGrid,
    LUX_PER_BYTE,
    type GridSite,
    type SceneLight,
} from './pipeline/lightgrid.ts';
import { ClipMap, MASK_SOLID, SURF } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');
/** Where `tools/generate-material-maps.ts` leaves the normal and ORM images. */
const MATERIAL_MAPS = join(ROOT, 'assets', 'generated', 'materials');

/* ------------------------------------------------------------------ *
 * Coordinate system.
 *
 * Q3 is Z-up, right-handed. meep (like glTF) is Y-up, right-handed. The
 * mapping is (x, y, z) -> (x, z, -y): determinant +1, so handedness and
 * therefore triangle winding are preserved and no index reversal is needed.
 *
 * Geometry *is* scaled, by exactly 1/32, and the simulation is not. meep's
 * lighting is physically based -- `PointLight.intensity` is candela and
 * `intensity_lumens` is lumens -- so inverse-square falloff is computed in
 * whatever unit the scene is authored in. In raw Q3 units a ceiling light sits
 * ~300 units from the floor, and lighting it to a sane brightness needs
 * intensities in the millions; the scene renders essentially black until it does.
 * Metres are the unit the engine's defaults, and its audio attenuation and
 * physics, are all calibrated for.
 *
 * So the split is: the simulation runs in Q3 units, because `bg_pmove` is full of
 * literal constants -- jump velocity 270, step height 18, the 1/8-unit velocity
 * snap -- whose relationships *are* the movement feel; and the presentation layer
 * multiplies by 1/32 on the way out. 1/32 rather than 0.0254 (a Q3 unit as one
 * inch) for two reasons: it puts the 56-unit player at 1.75 m instead of an
 * implausible 1.42 m, and it is a power of two, so the conversion is exact in
 * binary floating point and adds no rounding error of its own. See DECISIONS.md
 * D-011.
 * ------------------------------------------------------------------ */

/**
 * Scene units per Q3 unit. See the note above -- this is the only place the two
 * coordinate systems meet on the pipeline side.
 */
const WORLD_SCALE = 1 / 32;

/**
 * Grid cells dimmer than this are not sites.
 *
 * Most of the lattice is inside solid geometry, where q3map2 had nothing to
 * sample and wrote zeroes: `oa_dm5` has 3,410 cells and 980 with any light in
 * them. A small floor rather than zero also drops the near-black cells in
 * sealed voids, which are real samples of nothing.
 */
const GRID_MIN_BYTES = 8;

/**
 * What a map's local lights ship at, against what the lighting solution sized
 * them to.
 *
 * A Q3 emissive surface is not a light. It is a bright texture:
 * `q3map_surfacelight` told the *compiler* to radiate from that face, and the
 * runtime then drew the face itself as an unlit image, with no emissive term
 * anywhere in the renderer. The port turns that one directive into two things
 * that both reach the picture -- the fixture's own glowing face (D-093) and the
 * point lights reconstructed from the same surfaces (D-078, D-105) -- and then
 * meep counts the pair again in a way Q3 never did:
 *
 * - `material.emissive` is added straight into the shading result, so the face
 *   is bright on its own -- `chunk_shade_standard_material_direct.js`;
 * - the brick4 bake traces the loaded scene several bounces deep, and its path
 *   tracer accumulates `shading_material.emissive` at every hit as well as
 *   sampling the scene's lights (`chunk_render_trace_path.js`), so the glowing
 *   face and the point light in front of it both land in the probe -- which
 *   every shading point then samples as its ambient term (D-107).
 *
 * The lights were fitted against q3map2's lightgrid, and that field is the
 * whole of Q3's lighting -- direct and bounced, in a renderer with no emissive
 * term and no GI at runtime. Delivering it with point lights and *then* adding
 * a glowing face and a baked bounce on top of them puts more light in the room
 * than the field ever claimed was there, which is what the maps look like.
 *
 * So the local lights ship at 70% of what the fit sized them to. It is a fixed
 * fraction rather than a derived one, and it is a judgement: how much of a
 * fixture's emission comes back through the face and the bounce depends on the
 * room it is in, so there is no single number that is *correct* here, only one
 * that is close over six maps.
 *
 * Three things it deliberately does not do.
 *
 * **It is applied after the fit, not before.** `fitGridLights` solves for the
 * output that best matches the baked field; handing it lights already cut by
 * 30% just means it sizes them back up, or fills the hole it opened with
 * lights of its own, and the shipped picture is unchanged. The reduction only
 * survives if nothing measures against the bake afterwards -- which is why
 * `lightingResidualShipped` exists to record what it costs.
 *
 * **It does not touch the emissive faces.** They are derived from the same
 * flux, so scaling before that derivation would dim them by 30% too. The face
 * is the leg that was *already* being counted: trimming it as well would keep
 * the double count in exactly the proportion it is in now and make every light
 * fixture in the game dimmer than the mapper drew it. The two views of one
 * emission (D-093) are now a view of the emission and a view of the emission
 * minus what the face and the bounce contribute, which is the honest statement
 * of what this is -- and the invariant is still mechanical, so
 * `materials.test.ts` still checks the pair against each other, through this
 * constant.
 *
 * **It does not touch the reach.** `radius` is where the renderer stops
 * evaluating a light, not the falloff, so leaving it puts the shipped field at
 * exactly 0.7 of the fitted one everywhere the fitted one was not zero: a
 * dimming and nothing else. Scaling it by `sqrt(0.7)` would hold the absolute
 * cutoff lux instead and move where every light stops in by 16%, which is a
 * change of shape nobody asked for. The discontinuity at the cutoff gets 30%
 * smaller for free.
 *
 * The sun is excluded, and not only because it was asked to be. A directional
 * light was not reconstructed from a surface and has no face in the scene to be
 * counted twice with: it stands in for q3map2's sky, and its intensity is read
 * off the same baked field by a different route entirely.
 *
 * The lights fitted to the lightgrid take it as well, and for them it is not a
 * double-count correction -- they came out of no surface and have no emissive
 * twin. What it is there is the same statement applied to the same kind of
 * object: they were fitted to the same field, alongside the surface lights and
 * against the same targets, and a solution where half the lights carry a
 * correction and half do not is not one anyone can reason about afterwards.
 */
export const LOCAL_LIGHT_SCALE = 0.7;

/** Vertex layout written to geometry.bin, in floats. */
/*
 * Quake III triangles are wound *clockwise* seen from the front.
 *
 * Measured, not assumed: across `aggressor`'s 3,272 world triangles, the winding
 * agrees with the stored vertex normal exactly **zero** times. `oa_dm1` is 158
 * of 7,506, and those are degenerate slivers. Patch tessellation is the same
 * (6 of 88,384 on `oa_dm5`), and so is MD3 (0 of 204 on the rocket launcher).
 * The convention is uniform across every kind of Q3 geometry, which is why
 * `brushHull.ts` already reverses its own windings for the same reason -- Q3's
 * `BaseWindingForPlane` is clockwise from outside too.
 *
 * glTF and meep want counter-clockwise front faces, so every index triple is
 * reversed on the way out. Leaving them alone renders a level entirely
 * back-facing: you see the far side of each room through the near side, and the
 * floor under your feet is culled. It is not obviously *wrong* at a glance --
 * walls are still walls -- which is how it survived several sessions.
 */

const OUT_STRIDE = 12; // position(3) normal(3) uv(2) uv1(2) colour(2, packed rg/ba)

interface MeshGroup {
    readonly materialIndex: number;
    positions: number[];
    normals: number[];
    uvs: number[];
    uvs1: number[];
    colors: number[];
    indices: number[];
    /** Accumulated for point-light placement on emissive surfaces. */
    lightSamples: { x: number; y: number; z: number; area: number }[];
}

interface SceneMaterial {
    readonly name: string;
    /** Key into the bundle's texture table -- see `textureKey`, not a bare path. */
    readonly albedo: string | null;
    /** The Q3 blend the albedo image was written for. */
    readonly albedoBlend: ImageBlend;
    /** Generated tangent-space normal map, keyed like `albedo`; `null` if none. */
    readonly normal: string | null;
    /** Generated ORM -- G roughness, B metalness, R 1.0; `null` if none. */
    readonly orm: string | null;
    /** Q3 drew this surface without any lighting; see `UNLIT_LUMINANCE`. */
    readonly unlit: boolean;
    /**
     * Every pass was `tcGen environment`, so every image above is written flat.
     *
     * Carried on the material like `unlit` is, and for the same reason: the
     * texture pass below runs over `materials` rather than over the shaders, and
     * has to write the same images the keys were built from. The runtime reads
     * neither -- a key already says which file to load.
     */
    readonly environmentMapped: boolean;
    readonly emissive: string | null;
    readonly emissiveLuminance: number;
    readonly roughness: number;
    readonly metallic: number;
    /** See `PbrMaterial.transmission`; 0 for all but glass and clear water. */
    readonly transmission: number;
    /** See `PbrMaterial.ior`. */
    readonly ior: number;
    readonly transparency: string;
    readonly alphaCutoff: number;
    readonly doubleSided: boolean;
    readonly surfaceLight: number;
}

function q3ToMeep(x: number, y: number, z: number): [number, number, number] {
    return [x * WORLD_SCALE, z * WORLD_SCALE, -y * WORLD_SCALE];
}

/** Axis swap without the scale, for normals and other directions. */
function q3ToMeepDirection(x: number, y: number, z: number): [number, number, number] {
    return [x, z, -y];
}

/**
 * Summed triangle area of a mesh group, in scene square metres.
 *
 * Exact rather than the bounding-box proxy `recordLightSample` uses, because
 * this one divides a luminous flux: a factor of two in the area is a factor of
 * two in how bright a light fixture looks.
 */
function groupArea(g: MeshGroup): number {
    let area = 0;

    for (let i = 0; i + 2 < g.indices.length; i += 3) {
        const p = [g.indices[i]!, g.indices[i + 1]!, g.indices[i + 2]!].map((v) => [
            g.positions[v * 3]!,
            g.positions[v * 3 + 1]!,
            g.positions[v * 3 + 2]!,
        ]);

        const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
        const v = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];

        area +=
            0.5 *
            Math.hypot(
                u[1]! * v[2]! - u[2]! * v[1]!,
                u[2]! * v[0]! - u[0]! * v[2]!,
                u[0]! * v[1]! - u[1]! * v[0]!
            );
    }

    return area;
}

/** Read one BSP draw vertex into a `PatchVertex`. */
function readVertex(f: Float32Array, b: Uint8Array, index: number): PatchVertex {
    const o = index * VERT_STRIDE_F32;
    const cb = index * VERT_STRIDE_BYTES + VERT_COLOR_BYTES;
    return {
        x: f[o + VERT_XYZ]!,
        y: f[o + VERT_XYZ + 1]!,
        z: f[o + VERT_XYZ + 2]!,
        s: f[o + VERT_ST]!,
        t: f[o + VERT_ST + 1]!,
        lms: f[o + VERT_LIGHTMAP]!,
        lmt: f[o + VERT_LIGHTMAP + 1]!,
        nx: f[o + VERT_NORMAL]!,
        ny: f[o + VERT_NORMAL + 1]!,
        nz: f[o + VERT_NORMAL + 2]!,
        r: b[cb]! / 255,
        g: b[cb + 1]! / 255,
        b: b[cb + 2]! / 255,
        a: b[cb + 3]! / 255,
    };
}

function pushVertex(group: MeshGroup, v: PatchVertex): number {
    const [x, y, z] = q3ToMeep(v.x, v.y, v.z);
    const [nx, ny, nz] = q3ToMeepDirection(v.nx, v.ny, v.nz);

    const index = group.positions.length / 3;

    group.positions.push(x, y, z);
    group.normals.push(nx, ny, nz);
    /*
     No vertical flip. Both conventions put coordinate zero on the image's *top*
     row, so flipping is not a translation between them, it is a mirror.

     Q3's loaders normalise to top-row-first before upload -- `R_LoadTGA` writes
     the file's bottom-origin rows backwards into the buffer, `R_LoadJPG` takes
     libjpeg's scanlines in order -- and `glTexImage2D` puts buffer row 0 at
     `t = 0`. glTF says the same thing outright: (0, 0) is the upper-left corner
     of the image, and meep's loader passes `TEXCOORD_0` through untouched.

     Measured rather than argued, because a mirrored brick wall is still a brick
     wall and this survived six phases: of the vertical wall faces in `oa_dm1`,
     `aggressor` and `am_thornish`, 2,216 have `t` *falling* as world z rises and
     100 have it rising. Q3 puts an image's top row at the top of the wall, and
     `1 - t` was putting it at the bottom.

     What made it visible is the one surface where up and down are not
     interchangeable: `textures/sfx/beam`, a light shaft whose gradient is bright
     for the top third of the image and black for the rest. Q3 gives its ceiling
     end `t = 0`; the flip sent the bright end to the floor (D-083).
    */
    group.uvs.push(v.s, v.t);
    group.uvs1.push(v.lms, v.lmt);
    group.colors.push(v.r, v.g, v.b);

    return index;
}

/**
 * Thin adapter over the shared writer, kept so the call sites below stay short.
 *
 * The shared version fixed a latent bug this one had: a *repeat* lookup of a
 * missing texture returned `''` where the first lookup returned `null`, so a
 * texture referenced by two materials produced two different values in
 * `scene.json` depending on which material was resolved first.
 */
async function convertTexture(
    index: ShaderIndex,
    virtualPath: string,
    outDir: string,
    written: TextureCache,
    blend: ImageBlend,
    flatten = false
): Promise<string | null> {
    return writeTexture(
        index,
        EXTRACTED,
        virtualPath,
        outDir,
        written,
        blend,
        MATERIAL_MAPS,
        flatten
    );
}

async function convertMap(mapName: string, index: ShaderIndex): Promise<void> {
    const bspPath = join(EXTRACTED, 'maps', `${mapName}.bsp`);
    if (!existsSync(bspPath)) {
        throw new Error(`no such map: ${bspPath}`);
    }

    const raw = readFileSync(bspPath);
    const bsp = new BspFile(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        mapName
    );

    const outDir = join(BUILT, mapName);
    /*
     Emptied rather than added to. A conversion decides the *name* of a file from
     what it did to the image, so a run that restates something differently
     leaves the old name behind: turning on the de-lit albedos renamed 33 of the
     model bundle's textures to `.delit.png` and left 33 orphans beside them,
     which is a third of the bundle in files nothing references.
    */
    const textureDir = join(outDir, 'textures');
    rmSync(textureDir, { recursive: true, force: true });
    mkdirSync(textureDir, { recursive: true });

    const shaders = bsp.shaders;
    const surfaces = bsp.surfaces;
    const verts = bsp.drawVertsFloat;
    const vertBytes = bsp.drawVertsBytes;
    const indexes = bsp.drawIndexes;
    const models = bsp.models;

    /* ---- resolve materials ---- */

    const materials: SceneMaterial[] = [];
    const pbrByShaderNum: (PbrMaterial | null)[] = [];
    const materialIndexByShaderNum = new Map<number, number>();

    for (let i = 0; i < shaders.length; i++) {
        const pbr = index.material(shaders[i]!.name);
        pbrByShaderNum.push(pbr);
    }

    /* ---- group surfaces by material ---- */

    const stats = {
        planar: 0,
        patch: 0,
        triangleSoup: 0,
        flare: 0,
        skipped: 0,
        skySurfaces: 0,
        noDraw: 0,
    };

    /*
     One group map per BSP model. Model 0 is the world; 1..n are brush entities
     -- doors, plats, buttons -- which move, so their surfaces have to stay in
     their own vertex blocks. Merging them into the world welds every door
     permanently open, which is what happens if you only ever read model 0's
     surface range and wonder why the level has no doors in it.
    */
    const modelGroups: Map<number, MeshGroup>[] = models.map(() => new Map<number, MeshGroup>());
    let groups = modelGroups[0]!;

    const groupFor = (shaderNum: number): MeshGroup => {
        let g = groups.get(shaderNum);
        if (g === undefined) {
            const pbr = pbrByShaderNum[shaderNum]!;
            let mi = materialIndexByShaderNum.get(shaderNum);
            if (mi === undefined) {
                mi = materials.length;
                materials.push({
                    name: pbr.name,
                    albedo:
                        pbr.albedo === null
                            ? null
                            : textureKey(pbr.albedo, pbr.albedoBlend, pbr.environmentMapped),
                    albedoBlend: pbr.albedoBlend,
                    normal:
                        pbr.normal === null
                            ? null
                            : derivedTextureKey(pbr.normal, 'normal', pbr.environmentMapped),
                    orm:
                        pbr.orm === null
                            ? null
                            : derivedTextureKey(pbr.orm, 'orm', pbr.environmentMapped),
                    unlit: pbr.unlit,
                    environmentMapped: pbr.environmentMapped,
                    emissive:
                        pbr.emissive === null
                            ? null
                            : textureKey(pbr.emissive, 'opaque', pbr.environmentMapped),
                    emissiveLuminance: pbr.emissiveLuminance,
                    roughness: pbr.roughness,
                    metallic: pbr.metallic,
                    transmission: pbr.transmission,
                    ior: pbr.ior,
                    transparency: pbr.transparency,
                    alphaCutoff: pbr.alphaCutoff,
                    doubleSided: pbr.doubleSided,
                    surfaceLight: pbr.surfaceLight,
                });
                materialIndexByShaderNum.set(shaderNum, mi);
            }
            g = {
                materialIndex: mi,
                positions: [],
                normals: [],
                uvs: [],
                uvs1: [],
                colors: [],
                indices: [],
                lightSamples: [],
            };
            groups.set(shaderNum, g);
        }
        return g;
    };

    for (let mi = 0; mi < models.length; mi++) {
        groups = modelGroups[mi]!;
        const model = models[mi]!;
        emitSurfaceRange(model.firstSurface, model.firstSurface + model.numSurfaces);
    }
    groups = modelGroups[0]!;

    function emitSurfaceRange(from: number, to: number): void {
    for (let si = from; si < to; si++) {
        const surf = surfaces[si]!;
        const pbr = pbrByShaderNum[surf.shaderNum]!;

        if (pbr.isNoDraw) {
            stats.noDraw += 1;
            continue;
        }

        if (pbr.isSky) {
            // Sky is the environment, not geometry. Q3 drew a box; meep has an
            // environment map, so the surfaces are dropped and the sky shader is
            // recorded for the runtime to set up an environment from.
            stats.skySurfaces += 1;
            continue;
        }

        if (surf.surfaceType === MST.FLARE) {
            // A flare is a screen-space sprite around a light source. Replaced by
            // a meep particle/light at the same position (brief section 2).
            stats.flare += 1;
            continue;
        }

        if (surf.surfaceType === MST.PATCH) {
            stats.patch += 1;
            emitPatch(surf, groupFor(surf.shaderNum), pbr);
            continue;
        }

        if (surf.surfaceType === MST.PLANAR || surf.surfaceType === MST.TRIANGLE_SOUP) {
            if (surf.surfaceType === MST.PLANAR) stats.planar += 1;
            else stats.triangleSoup += 1;
            emitIndexed(surf, groupFor(surf.shaderNum), pbr);
            continue;
        }

        stats.skipped += 1;
    }
    }

    function emitIndexed(surf: BspSurface, group: MeshGroup, pbr: PbrMaterial): void {
        const base = group.positions.length / 3;

        for (let v = 0; v < surf.numVerts; v++) {
            pushVertex(group, readVertex(verts, vertBytes, surf.firstVert + v));
        }

        for (let i = 0; i < surf.numIndexes; i++) {
            group.indices.push(base + indexes[surf.firstIndex + i]!);
        }

        if (pbr.surfaceLight > 0 && surf.numVerts > 0) {
            recordLightSample(group, surf.firstVert, surf.numVerts);
        }
    }

    function emitPatch(surf: BspSurface, group: MeshGroup, pbr: PbrMaterial): void {
        const control: PatchVertex[] = [];
        for (let v = 0; v < surf.numVerts; v++) {
            control.push(readVertex(verts, vertBytes, surf.firstVert + v));
        }

        let tess;
        try {
            tess = tessellatePatch(control, surf.patchWidth, surf.patchHeight);
        } catch (e) {
            console.warn(`  patch surface skipped: ${(e as Error).message}`);
            stats.skipped += 1;
            return;
        }

        const base = group.positions.length / 3;
        for (const v of tess.vertices) pushVertex(group, v);
        for (const i of tess.indices) group.indices.push(base + i);

        if (pbr.surfaceLight > 0 && surf.numVerts > 0) {
            recordLightSample(group, surf.firstVert, surf.numVerts);
        }
    }

    /**
     * Record the centroid and rough area of an emissive surface.
     *
     * q3map2 stripped every `light` entity from the entity lump after baking, so
     * the only surviving record of where a map's light came from is which
     * surfaces carry a `q3map_surfacelight` shader. Placing a point light at each
     * such surface reconstructs the map's intended lighting as *dynamic* lights,
     * which is what makes clustered lighting worth showing. See DECISIONS.md
     * D-012.
     */
    function recordLightSample(group: MeshGroup, firstVert: number, numVerts: number): void {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let v = 0; v < numVerts; v++) {
            const o = (firstVert + v) * VERT_STRIDE_F32;
            const x = verts[o]!;
            const y = verts[o + 1]!;
            const z = verts[o + 2]!;
            cx += x; cy += y; cz += z;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        cx /= numVerts; cy /= numVerts; cz /= numVerts;

        // Extent of the largest two axes, as a stand-in for surface area: good
        // enough to tell a ceiling panel from a light strip, which is what the
        // cluster's `sourceRadiusOf` needs it for. Exact for the axis-aligned
        // quad most Q3 light faces are, generous for a tilted one, and generous
        // again for a patch, where these are the control points and the surface
        // is inside their hull.
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const sorted = [dx, dy, dz].sort((a, b) => b - a);
        const area = Math.max(1, sorted[0]! * sorted[1]!);

        const [mx, my, mz] = q3ToMeep(cx, cy, cz);
        group.lightSamples.push({ x: mx, y: my, z: mz, area });
    }

    /* ---- pack geometry ---- */

    const meshes: {
        material: number;
        vertexOffset: number;
        vertexCount: number;
        indexOffset: number;
        indexCount: number;
    }[] = [];

    let totalVerts = 0;
    let totalIndices = 0;
    for (const map of modelGroups) {
        for (const g of map.values()) {
            totalVerts += g.positions.length / 3;
            totalIndices += g.indices.length;
        }
    }

    const vertexData = new Float32Array(totalVerts * OUT_STRIDE);
    const indexData = new Uint32Array(totalIndices);

    let vCursor = 0;
    let iCursor = 0;

    /** `submodelMeshes[i]` indexes into `meshes` for BSP model `i`. Model 0 is the world. */
    const submodelMeshes: number[][] = models.map(() => []);

    for (let modelIndex = 0; modelIndex < modelGroups.length; modelIndex++) {
    for (const g of modelGroups[modelIndex]!.values()) {
        const count = g.positions.length / 3;
        if (count === 0 || g.indices.length === 0) continue;

        const vertexOffset = vCursor;

        for (let i = 0; i < count; i++) {
            const o = (vCursor + i) * OUT_STRIDE;
            vertexData[o] = g.positions[i * 3]!;
            vertexData[o + 1] = g.positions[i * 3 + 1]!;
            vertexData[o + 2] = g.positions[i * 3 + 2]!;
            vertexData[o + 3] = g.normals[i * 3]!;
            vertexData[o + 4] = g.normals[i * 3 + 1]!;
            vertexData[o + 5] = g.normals[i * 3 + 2]!;
            vertexData[o + 6] = g.uvs[i * 2]!;
            vertexData[o + 7] = g.uvs[i * 2 + 1]!;
            vertexData[o + 8] = g.uvs1[i * 2]!;
            vertexData[o + 9] = g.uvs1[i * 2 + 1]!;
            vertexData[o + 10] = g.colors[i * 3]!;
            vertexData[o + 11] = g.colors[i * 3 + 1]!;
        }

        /*
         Indices are stored relative to the mesh's own vertex block, so the
         runtime can hand each mesh a standalone Geometry without rebasing --
         and every triple is reversed, because Q3 winds clockwise from the front
         and glTF winds counter-clockwise. See the note above `OUT_STRIDE`.

         Reversed here rather than at each emitter so the world surfaces, the
         patch tessellation and the brush-entity submodels cannot drift apart:
         they are all measured to share the convention, so they share the fix.
        */
        for (let i = 0; i + 2 < g.indices.length; i += 3) {
            indexData[iCursor + i] = g.indices[i]!;
            indexData[iCursor + i + 1] = g.indices[i + 2]!;
            indexData[iCursor + i + 2] = g.indices[i + 1]!;
        }

        submodelMeshes[modelIndex]!.push(meshes.length);
        meshes.push({
            material: g.materialIndex,
            vertexOffset,
            vertexCount: count,
            indexOffset: iCursor,
            indexCount: g.indices.length,
        });

        vCursor += count;
        iCursor += g.indices.length;
    }
    }

    /* ---- lights ---- */

    /**
     * Cluster emissive surface samples so a ceiling of 40 light panels becomes
     * ~40 lights rather than 400 -- one per surface would put several lights
     * inside the same fixture and blow the intensity out.
     */
    const lights: SceneLight[] = [];
    const CLUSTER_RADIUS = 96 * WORLD_SCALE; // 96 Q3 units, in scene metres

    /**
     * How big the emitter is, from how much of it there is.
     *
     * Shade's lights are spheres, not points: `radius` is the source's own
     * extent and it drives three separate things -- the near-field cap in
     * `light_sphere_distance_attenuation`, the solid angle the
     * representative-point specular lobe is widened by (`sin_src`), and the
     * soft-horizon wrap that replaces `saturate(N.L)` at the terminator. Left
     * at its default of zero all three collapse and the light is a delta
     * source: a hot spot on the ceiling it hangs from, a mirror-sharp highlight
     * on every glossy surface, and a knife edge where the light stops.
     *
     * A fixture is not a delta source and this pipeline knows exactly how big
     * each one is, because it clustered the emitting surfaces itself. A sphere
     * of radius `sqrt(A / pi)` has the same projected area from every direction
     * as a face of area `A` seen head-on, which is the equivalence all three of
     * those uses rest on.
     *
     * It is a sphere standing in for a flat face, and the substitution is exact
     * only for the far field: the sphere has a depth the panel does not, so a
     * point a few centimetres from the fixture sits inside it and is softened
     * slightly more than the panel alone would soften it. That is the direction
     * the error should go -- it is the hot spot this is here to remove -- but it
     * is a reason to keep the radius bounded rather than to let it follow the
     * area indefinitely.
     *
     * The bounds are the two ends where that stops describing a fixture:
     *
     * - **5 cm floor.** A trim strip a few units across would come out at a
     *   centimetre or two, which is the renderer's own delta-source fallback
     *   and buys nothing. Nothing in a Q3 map emits from smaller than a bulb.
     * - **1 m ceiling.** Past about 3 square metres of face the emitter is a
     *   lava pool or a sky brush rather than a lamp, and one sphere at its
     *   centroid is already the wrong model for it. Letting the radius follow
     *   the area there would flatten every surface within several metres --
     *   inside the sphere, attenuation is constant and the terminator is gone.
     *   Clamping keeps it a light; it does not make the pool's light dimmer,
     *   because attenuation past `r` is inverse-square either way.
     */
    const MIN_SOURCE_RADIUS = 0.05;
    const MAX_SOURCE_RADIUS = 1;

    /** @param faceArea summed emitting area of one cluster, in Q3 units squared */
    function sourceRadiusOf(faceArea: number): number {
        const metres2 = faceArea * WORLD_SCALE * WORLD_SCALE;

        return Math.min(
            MAX_SOURCE_RADIUS,
            Math.max(MIN_SOURCE_RADIUS, Math.sqrt(metres2 / Math.PI))
        );
    }

    /**
     * Luminance, in cd/m2, for each material that emitted light. Filled in
     * after the lightgrid fit, because until that has run the port does not yet
     * know how much light comes out of these surfaces. See the block below the
     * clustering loop.
     */
    const emissiveLuminance = new Map<number, number>();

    /**
     * Total emitting area of each material that declared a surface light, in
     * square metres.
     *
     * Kept because the fixture's face is derived from the light coming out of
     * it and that number is not final until the fit has run: a material's
     * emissive is its calibrated flux over its area, so the flux has to be
     * summed back up per material afterwards.
     */
    const emissiveArea = new Map<number, number>();

    for (const [shaderNum, g] of groups) {
        const pbr = pbrByShaderNum[shaderNum]!;
        if (pbr.surfaceLight <= 0) continue;

        const claimed: boolean[] = new Array(g.lightSamples.length).fill(false);

        for (let i = 0; i < g.lightSamples.length; i++) {
            if (claimed[i]) continue;

            const seed = g.lightSamples[i]!;
            let sx = seed.x, sy = seed.y, sz = seed.z, n = 1;
            let faceArea = seed.area;
            claimed[i] = true;

            for (let j = i + 1; j < g.lightSamples.length; j++) {
                if (claimed[j]) continue;
                const o = g.lightSamples[j]!;
                if (Math.hypot(o.x - seed.x, o.y - seed.y, o.z - seed.z) < CLUSTER_RADIUS) {
                    sx += o.x; sy += o.y; sz += o.z; n += 1;
                    faceArea += o.area;
                    claimed[j] = true;
                }
            }

            lights.push({
                x: sx / n,
                y: sy / n,
                z: sz / n,
                material: g.materialIndex,
                /*
                 A starting point, not an answer. meep point lights are
                 photometric -- `intensity` is candela, `intensity_lumens` is
                 lumens -- and this used to hand `q3map_surfacelight` straight
                 over as lumens on the reasoning that q3map2's range lines up
                 with real luminous flux almost 1:1.

                 It does not. The directive is a per-unit-area quantity, so
                 reading it as a per-fixture flux ignores how much surface is
                 emitting: on `oa_dm1` that gave ten 0.2 m2 torch quads 3,787 lm
                 each and the 38 m2 lava lake beside them 666, which is a
                 thousandfold spread in radiance across one map and put 90% of
                 its light in 2% of its emitting area. Against the baked
                 lightgrid the error is not even a consistent scale: on `oa_dm4`
                 `gothic_light/ironcrosslt2_20000` now ships at 0.22 of what it
                 declared and `gothic_light/skulllight01` at 5.4 times, which is
                 a 25-fold disagreement between two shaders in one level.

                 So the number stays -- it is the mapper's own statement that
                 light comes out of here, and its *relative* ordering within a
                 shader set is worth something -- and the lightgrid fit sizes it
                 (D-105). Where a map has no lightgrid this is what ships, which
                 is why the 20,000 lm clamp is still here: a handful of OA lava
                 and sky shaders declare values in the tens of thousands.
                */
                lumens: Math.min(pbr.surfaceLight, 20000),
                /*
                 Provisional cutoff radius, in metres. The fit recomputes it
                 from what the light ends up emitting and how bright the region
                 it lights is; this is what a map with no lightgrid keeps, and
                 what seeds the fit's own placement pass.
                */
                radius: Math.min(60, 6 + pbr.surfaceLight / 120),
                sourceRadius: sourceRadiusOf(faceArea),
            });
        }

        /*
         The fixture's own face, in the same units as the light coming out of it.

         meep adds `material.emissive` straight into the shading result --
         `outgoing_light = diffuse + specular + emissive` -- so it is a
         luminance, in cd/m2, sitting beside a diffuse term computed from lights
         in candela. `q3map_surfacelight / 1000` was neither: it put a ceiling
         panel at 0.3 while the wall it lit sat at several cd/m2, so every light
         fixture in the game was *darker than what it illuminated*.

         The port already decides how much light a surface emits -- the clusters
         above, and then the lightgrid fit that sizes them (D-105) -- so the
         fixture's face has a right answer rather than a taste: a Lambertian
         emitter radiating flux F over area A has luminance F / (pi * A).
         Emissive and point light stop being two unrelated guesses and become
         two views of one emission.

         Which is why only the *area* is recorded here. The flux is not known
         yet: it was `q3map_surfacelight` per cluster when this was written, and
         that number is now a starting point the fit is free to move. Deriving
         the face from the pre-fit flux would put the two views back out of
         agreement in exactly the way this block exists to prevent.
        */
        let area = 0;
        for (const model of modelGroups) {
            const mg = model.get(shaderNum);
            if (mg !== undefined) area += groupArea(mg);
        }

        if (area > 0) emissiveArea.set(g.materialIndex, area);
    }

    /**
     * How many of `lights` came out of surfaces.
     *
     * The lightgrid fit appends its own after these and returns these in place,
     * so this is the boundary between the two routes for the rest of the
     * function.
     */
    const surfaceCount = lights.length;

    /* ---- sun ---- */

    const suns = index.suns();
    let sun: { color: number[]; intensity: number; direction: number[] } | null = null;

    /** Unit vector toward the sun, Q3 axes. Null when the map has no sun. */
    let sunTowardQ3: [number, number, number] | null = null;

    for (const shader of shaders) {
        const s = suns.get(shader.name);
        if (s === undefined) continue;

        // Q3 gives the direction the light comes *from*, as compass degrees plus
        // elevation. Convert to a direction vector the light travels along.
        const az = (s.degrees * Math.PI) / 180;
        const el = (s.elevation * Math.PI) / 180;
        const fx = Math.cos(az) * Math.cos(el);
        const fy = Math.sin(az) * Math.cos(el);
        const fz = Math.sin(el);
        const [dx, dy, dz] = q3ToMeepDirection(-fx, -fy, -fz);
        sunTowardQ3 = [fx, fy, fz];

        sun = {
            color: [...s.color],
            /*
             Fallback only, and on the wrong scale -- see the block that
             measures this off the lightgrid. `make_sunlight`'s 2.2 default is
             meep's artist-facing convention, not lux, and a map with no baked
             grid to measure against has nothing better to offer.
            */
            intensity: Math.min(s.intensity / 45, 6),
            direction: [dx, dy, dz],
        };
        break;
    }

    /* ---- lightgrid fill ---- */

    /**
     * The other thing q3map2 baked, and the half of the lighting the shader
     * route cannot see.
     *
     * `q3map_surfacelight` only carries a map's lighting if its author lit it
     * with surface shaders. Two of the six here did not: `oa_dm5` reconstructed
     * to **zero** lights over 107,414 triangles and `oa_dm7` left 70 of 79
     * player positions under a lux, because their light came from `light`
     * entities and q3map2 deletes those after baking. `LUMP_LIGHTGRID` is the
     * only surviving record of it, and it does survive -- on all six maps here
     * the lattice arithmetic predicts the lump length exactly.
     *
     * This runs *after* the surface lights and fills what they left short, so a
     * map already lit by its shaders gets nothing added. See Q-006 and D-078.
     */
    let gridLights: SceneLight[] = [];
    let gridFit: { before: number; after: number; sites: number } | null = null;
    /**
     * The cells the fit was measured against, or null on a map with no baked
     * lightgrid.
     *
     * Kept past the block below so the *shipped* lights can be measured against
     * the same targets after `LOCAL_LIGHT_SCALE` has been applied to them.
     */
    let gridSites: readonly GridSite[] | null = null;

    {
        const grid = readLightGrid(bsp);

        if (grid !== null) {
            const cm = new ClipMap(bsp);
            const probe = createTrace();
            const ZERO: [number, number, number] = [0, 0, 0];

            /** Scene metres and meep axes back to Q3 units and Q3 axes. */
            const toQ3 = (m: readonly [number, number, number]): [number, number, number] =>
                [m[0] / WORLD_SCALE, -m[2] / WORLD_SCALE, m[1] / WORLD_SCALE];

            /*
             Can this point see sky? Trace toward the sun and ask what stopped
             it. A sealed room always stops the trace, so `fraction === 1` alone
             would find nothing; what matters is whether the thing it hit is a
             sky surface. Q3 marks those `SURF_SKY` and q3map2 replaced them with
             the sun's light, which is why a site that can see one is already lit
             and must not be given a point light standing in for the sun.
            */
            const seesSky = (q3: readonly [number, number, number]): boolean => {
                if (sunTowardQ3 === null) return false;

                const end: [number, number, number] = [
                    q3[0] + sunTowardQ3[0] * 65536,
                    q3[1] + sunTowardQ3[1] * 65536,
                    q3[2] + sunTowardQ3[2] * 65536,
                ];

                boxTrace(probe, cm, q3, end, ZERO, ZERO, MASK_SOLID);
                return probe.fraction === 1 || (probe.surfaceFlags & SURF.SKY) !== 0;
            };

            const sites = sitesFromGrid(grid, {
                luxPerByte: LUX_PER_BYTE,
                minBytes: GRID_MIN_BYTES,
                toScene: (q3) => q3ToMeep(q3[0], q3[1], q3[2]),
                litBySun: seesSky,
                // Metres. A Q3 ceiling sits ~128 units above head height, which
                // is the 4 m default; the bounds are half a grid cell at the
                // near end and a large room at the far.
                defaultDistance: 128 * WORLD_SCALE,
                minDistance: 32 * WORLD_SCALE,
                maxDistance: 512 * WORLD_SCALE,
            });

            const fit = fitGridLights(sites, lights, {
                blocked: (from, to) => {
                    const a = toQ3(from);
                    const b = toQ3(to);
                    boxTrace(probe, cm, a, b, ZERO, ZERO, MASK_SOLID);
                    return probe.fraction < 1 || probe.startsolid;
                },
            });

            /*
             The surface lights come back measured rather than declared. In
             place and index for index, because the emissive faces below are
             summed out of the first `surfaceCount` entries of this array.
            */
            for (let i = 0; i < fit.surface.length; i++) lights[i] = fit.surface[i]!;

            gridLights = fit.lights;
            gridFit = { before: fit.residualBefore, after: fit.residualAfter, sites: fit.sites };
            gridSites = sites;

            /*
             What a sun-facing surface receives, in the same lux the rest of
             this file works in.

             `q3map_sun`'s intensity is q3map2's own scale and the divisor that
             used to convert it -- 45, chosen so a typical map landed near
             meep's `make_sunlight` default of 2.2 -- was calibrating against
             the engine's *artist-facing* convention while every point light in
             the port is in real photometric units. The sun came out at 3.3 lux
             on `am_thornish`, which is less than one of its torches at seven
             metres, and 5 to 67 times under what the grid says arrives at the
             cells that can see sky.

             No single divisor fixes it: `q3map_sun 150` is worth 43.8 lux on
             `aggressor` and 17.3 on `am_thornish`. So it is read off the same
             baked field as everything else. The directed component is what
             q3map2 recorded arriving from the dominant direction, and at a cell
             with a clear line to the sky that direction is the sun.
            */
            if (sun !== null) {
                const lit: number[] = [];

                for (let i = 0; i < grid.count; i++) {
                    const sample = grid.at(i);
                    const directed = luma(sample.directed);
                    if (luma(sample.ambient) + directed < GRID_MIN_BYTES) continue;
                    if (!seesSky(sample.origin)) continue;
                    lit.push(directed * LUX_PER_BYTE);
                }

                /*
                 The median, and only when there are enough cells for one to
                 mean anything. A map with a sun shader whose sky is a sliver --
                 `oa_dm4` has nineteen such cells, and its "sun" is a red glow
                 pointed straight down -- is not measuring a sun, and the
                 declared value is the better guess there.
                */
                if (lit.length >= 32) {
                    lit.sort((a, b) => a - b);
                    sun.intensity = lit[Math.floor(lit.length / 2)]!;
                }
            }
        }
    }

    /*
     The fixture's face, now that the port knows how much light comes out of it.

     `emissiveArea` was recorded during clustering and each light carries the
     material it came out of; the flux is whatever the lights ended up at, which
     is the fit's answer where
     there was a lightgrid to fit against and the shader's declared value where
     there was not. Either way the face and the light it casts are one emission
     described twice, which is the property D-093 established and D-105 has to
     keep.
    */
    {
        const flux = new Map<number, number>();

        for (let i = 0; i < surfaceCount; i++) {
            const m = lights[i]!.material!;
            flux.set(m, (flux.get(m) ?? 0) + lights[i]!.lumens);
        }

        for (const [material, area] of emissiveArea) {
            emissiveLuminance.set(material, (flux.get(material) ?? 0) / (Math.PI * area));
        }
    }

    /*
     A surface light the fit drove to nothing is a fixture the baked field says
     contributes no measurable light -- a glowing window on `oa_dm1`, whose room
     is lit by the torches in it. Dropping it costs a GPU light and nothing
     else: its face still glows, because `emissive` above is not this number.
    */
    const lit = lights.slice(0, surfaceCount).filter((l) => l.lumens > 1);
    const darkened = surfaceCount - lit.length;

    lights.splice(0, surfaceCount, ...lit);

    for (const l of gridLights) lights.push(l);

    /*
     And the port's own de-rating, last, over every light the map put in the
     world. See `LOCAL_LIGHT_SCALE`: the emissive faces above are derived from
     the flux the fit settled on and this is applied after them on purpose, the
     drop threshold just above is the fit's own statement and is read before it,
     and `sun` is not in this array.
    */
    for (const l of lights) l.lumens *= LOCAL_LIGHT_SCALE;

    /*
     What the *shipped* lights deliver against the baked field, as against what
     the fit sized them to deliver.

     The two are the same number until something changes the lights after the
     fit has run, and `LOCAL_LIGHT_SCALE` is exactly that. Without this the
     bundle would carry a residual describing a set of lights it does not
     contain -- and `lightingResidualAfter`'s whole reason for being written
     down is that a build which quietly stops agreeing with the bake looks
     identical from every other statistic here.

     Measured over the same cells, with the same function, so the pair is
     comparable. It also carries the dropped dark fixtures, which the fit's own
     number does not; they were under a lumen each, so the difference between
     the two is the de-rating and rounding.
    */
    const shippedResidual = gridSites === null ? null : residualOf(gridSites, lights);

    /* ---- textures ---- */

    const written = textureCache();
    const textureFor: Record<string, string | null> = {};

    /*
     A material names its textures by `textureKey` rather than by virtual path,
     because the same image can be referenced through two different Q3 blends and
     then has to be written twice. An emissive is always `opaque`: it is the
     colour an additive pass added, and that pass's alpha would only dim it.
    */
    /*
     A surface on a brush entity -- a lit door panel -- has geometry but no
     cluster, because only the world model places lights. `Math.max(clusters, 1)`
     above gives it one fixture's worth of flux over its own area, which is the
     same statement for a surface the light pass never reached.
    */
    for (let i = 0; i < materials.length; i++) {
        const luminance = emissiveLuminance.get(i);
        if (luminance === undefined || materials[i]!.emissive === null) continue;

        /*
         A surface can be both declared and unlit -- lava is -- and the two say
         different things. "Q3 drew this without shading it" is a floor on how it
         looks; "the port credits it with F lumens over A" is a floor on how it
         looks given what it emits. Neither is an upper bound, so the larger is
         the better-informed of the two: it keeps a torch at the thousands its own
         flux implies, and stops 666 lumens spread over 38 square metres of lava
         from making lava dimmer than an ordinary unlit texture.

         The floor covers a *declared* emitter too, and until D-105 it did not
         have to: flux was one cluster's worth of `q3map_surfacelight` and so
         never zero. The fit can drive a fixture to nothing now, and a fixture
         the baked field says casts no measurable light is still a fixture --
         `e8/e8jumpspawn02b` on `am_thornish` went to 0.00 cd/m2 and stopped
         glowing at all. Whatever Q3 declared a light source cannot come out
         dimmer than a beam nobody declared anything about.
        */
        const declared = materials[i]!.surfaceLight > 0;
        const floor = materials[i]!.unlit || declared ? UNLIT_LUMINANCE : 0;
        materials[i] = {
            ...materials[i]!,
            emissiveLuminance: Math.max(luminance, floor),
        };
    }

    for (const m of materials) {
        if (m.albedo !== null) {
            textureFor[m.albedo] = await convertTexture(
                index,
                texturePathOf(m.albedo),
                textureDir,
                written,
                m.albedoBlend,
                m.environmentMapped
            );
        }
        if (m.emissive !== null) {
            textureFor[m.emissive] = await convertTexture(
                index,
                texturePathOf(m.emissive),
                textureDir,
                written,
                'opaque',
                m.environmentMapped
            );
        }

        /*
         The generated maps go in the same table under their own keys, and only
         when there is a file. A `null` in this table means "the shader named this
         image and it is not on disk"; a texture the generator has not reached is
         a different statement, and the material's own `normal` already makes it.
        */
        for (const map of ['normal', 'orm'] as const) {
            const key = m[map];
            if (key === null) continue;

            const file = await writeDerivedTexture(
                MATERIAL_MAPS,
                texturePathOf(key),
                map,
                textureDir,
                written,
                m.environmentMapped
            );
            if (file !== null) textureFor[key] = file;
        }
    }

    /* ---- entities ---- */

    const entities = parseEntities(bsp.entityString).map((e) => {
        const [ox, oy, oz] = entityVector(e, 'origin');
        const [mx, my, mz] = q3ToMeep(ox, oy, oz);
        return {
            ...e,
            _origin: [mx, my, mz],
            _originQ3: [ox, oy, oz],
            _angle: entityNumber(e, 'angle', 0),
        };
    });

    /* ---- write ---- */

    writeFileSync(join(outDir, 'geometry.bin'), Buffer.concat([
        Buffer.from(vertexData.buffer, vertexData.byteOffset, vertexData.byteLength),
        Buffer.from(indexData.buffer, indexData.byteOffset, indexData.byteLength),
    ]));

    const scene = {
        name: mapName,
        generator: 'queep-3-arena tools/convert-map.ts',
        coordinateSystem: 'meep Y-up, metres',
        worldScale: WORLD_SCALE,
        vertexStride: OUT_STRIDE,
        vertexLayout: ['position:3', 'normal:3', 'uv0:2', 'uv1:2', 'color_rg:2'],
        vertexBytes: vertexData.byteLength,
        indexBytes: indexData.byteLength,
        materials,
        textures: textureFor,
        meshes,
        /*
         Which meshes belong to which BSP model. `submodels[0]` is the world and
         the runtime draws it as one static batch; 1..n are brush entities, and
         the runtime gives each its own transform so it can be moved. The
         bounds and centre come straight from the model lump -- Q3 movers rotate
         about the *model's* centre, not about the world origin.
        */
        submodels: models.map((m, i) => ({
            model: i,
            meshes: submodelMeshes[i]!,
            minsQ3: m.mins,
            maxsQ3: m.maxs,
            numBrushes: m.numBrushes,
        })),
        lights,
        sun,
        entities,
        stats: {
            ...stats,
            materials: materials.length,
            meshes: meshes.length,
            vertices: totalVerts,
            triangles: totalIndices / 3,
            lights: lights.length,
            entities: entities.length,
            texturesWritten: textureCounts(written).written,
            texturesMissing: textureCounts(written).missing,
            submodels: models.length - 1,
            /*
             How far the lighting is from the field q3map2 baked, as RMS
             illuminance error over the fitted cells, relative to their mean
             target. `Before` is the shader route on its own, `after` is what
             the fit solved for, and `shipped` is what this bundle's lights
             actually deliver -- the same set again after the deliberate
             `LOCAL_LIGHT_SCALE` de-rating, which is why it is the worse of the
             two on all six maps here. That gap is the price of the correction
             and not a defect in it.

             Written into the bundle rather than only logged because it is the
             one number that says whether this map's lighting is *right*, as
             against merely present, and a build that quietly stops agreeing
             with the bake looks identical from every other statistic here.
             `Shipped` is here for the same reason one step further out: the
             port now disagrees with the bake on purpose, and a number for how
             much is the difference between a stated cost and a drift nobody
             is measuring. Absent, rather than zero, on a map with no lightgrid
             to measure against -- there is a difference between agreeing with
             the bake and having no bake. See D-105 and D-150.
            */
            ...(gridFit === null ? {} : {
                lightingSites: gridFit.sites,
                lightingResidualBefore: gridFit.before,
                lightingResidualAfter: gridFit.after,
                lightingResidualShipped: shippedResidual ?? 0,
            }),
            /*
             The fraction of the fitted output the lights in this bundle carry.
             Written down because `assets/built/` is committed and this is the
             one thing about a bundle's lighting that no other statistic here
             moves with: a tree built before `LOCAL_LIGHT_SCALE` existed, or
             before it last changed, is otherwise indistinguishable from one
             built after it.
            */
            localLightScale: LOCAL_LIGHT_SCALE,
        },
    };

    writeFileSync(join(outDir, 'scene.json'), JSON.stringify(scene));

    /*
     The BSP itself, so the runtime can build its collision model from the same
     bytes the oracle does. Not re-encoded into a bespoke format: `ClipMap` reads
     the lumps directly, and a second representation would be a second thing that
     can disagree with `cm_trace.c` about plane winding -- which would present as
     a physics bug that looks like a rendering bug.
    */
    copyFileSync(bspPath, join(outDir, 'collision.bsp'));

    console.log(
        `${mapName}: ${meshes.length} meshes, ${totalVerts} verts, ${totalIndices / 3} tris, ` +
        `${materials.length} materials, ${lights.length} lights` +
        (gridFit !== null
            ? ` (${gridLights.length} fitted and ${surfaceCount - darkened} ` +
              `calibrated against ${gridFit.sites} lightgrid cells, ` +
              `RMS ${(gridFit.before * 100).toFixed(0)}% -> ` +
              `${(gridFit.after * 100).toFixed(0)}%, ` +
              `${((shippedResidual ?? 0) * 100).toFixed(0)}% shipped ` +
              `at ${LOCAL_LIGHT_SCALE * 100}%` +
              (darkened > 0 ? `, ${darkened} surface lights dropped as dark` : '') + ')'
            : '') +
        `, ${scene.stats.texturesWritten} textures` +
        (scene.stats.texturesMissing > 0 ? ` (${scene.stats.texturesMissing} missing)` : '') +
        (sun !== null ? ', sun' : '')
    );
}

async function main(): Promise<void> {
    const maps = process.argv.slice(2);
    if (maps.length === 0) {
        console.error('usage: node tools/convert-map.ts <mapname> [<mapname>...]');
        process.exit(2);
    }

    console.log('loading shader scripts...');
    const index = new ShaderIndex(EXTRACTED).load();
    const s = index.stats();
    console.log(
        `  ${s.scriptFiles} files, ${s.entries} entries, ${s.unique} unique, ` +
        `${s.collisions} name collisions, ${s.parseWarnings.length} warnings`
    );

    for (const m of maps) {
        await convertMap(m, index);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
