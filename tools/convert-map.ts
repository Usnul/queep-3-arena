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

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
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
    textureCache,
    textureCounts,
    textureKey,
    texturePathOf,
    writeTexture,
    type TextureCache,
} from './pipeline/texture-out.ts';
import { tessellatePatch, type PatchVertex } from './pipeline/patch.ts';
import type { ImageBlend, PbrMaterial } from './pipeline/shader-to-pbr.ts';
import { readLightGrid } from '../src/q3/bsp/LightGrid.ts';
import { fitGridLights, sitesFromGrid, type SceneLight } from './pipeline/lightgrid.ts';
import { ClipMap, MASK_SOLID, SURF } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');

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
 * Lux per byte of sampled lightgrid irradiance.
 *
 * The grid's bytes are q3map2's own scale with no physical unit on them and
 * meep's lights are photometric, so this number bridges two systems that never
 * agreed. It is measured rather than chosen: on each map whose surface-light
 * reconstruction the demo already accepts, take the median illuminance the
 * reconstruction delivers at the places a player stands and divide it by the
 * median grid brightness at those same places.
 *
 *   oa_dm1  8.7 lux / 103.7 = 0.084     aggressor    20.2 / 104.1 = 0.194
 *   oa_dm4 32.6 lux / 160.9 = 0.202     am_thornish  57.6 /  48.3 = 1.193
 *
 * Fourteen times between the ends of that, which is worth saying plainly: the
 * surface-light route is itself only approximately calibrated, and a map with
 * 147 bright shader lights over open ground is not measuring the same thing as
 * one with 22 in corridors. The median of the four, 0.198, is the robust middle
 * and is what ships. It puts the two fitted maps at 9.0 and 31.8 lux median --
 * inside the 8.7 to 32.6 band the accepted maps already span, which is the
 * property that matters. See D-078.
 */
const LUX_PER_BYTE = 0.2;

/**
 * Grid cells dimmer than this are not sites.
 *
 * Most of the lattice is inside solid geometry, where q3map2 had nothing to
 * sample and wrote zeroes: `oa_dm5` has 3,410 cells and 980 with any light in
 * them. A small floor rather than zero also drops the near-black cells in
 * sealed voids, which are real samples of nothing.
 */
const GRID_MIN_BYTES = 8;

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
    readonly emissive: string | null;
    readonly emissiveLuminance: number;
    readonly roughness: number;
    readonly metallic: number;
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
    blend: ImageBlend
): Promise<string | null> {
    return writeTexture(index, EXTRACTED, virtualPath, outDir, written, blend);
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
    const textureDir = join(outDir, 'textures');
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
                    albedo: pbr.albedo === null ? null : textureKey(pbr.albedo, pbr.albedoBlend),
                    albedoBlend: pbr.albedoBlend,
                    emissive: pbr.emissive,
                    emissiveLuminance: pbr.emissiveLuminance,
                    roughness: pbr.roughness,
                    metallic: pbr.metallic,
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
        // enough to tell a ceiling panel from a light strip.
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
     * Luminance, in cd/m2, for each material that emitted light. See the block
     * below the clustering loop.
     */
    const emissiveLuminance = new Map<number, number>();

    for (const [shaderNum, g] of groups) {
        const pbr = pbrByShaderNum[shaderNum]!;
        if (pbr.surfaceLight <= 0) continue;

        const before = lights.length;
        const claimed: boolean[] = new Array(g.lightSamples.length).fill(false);

        for (let i = 0; i < g.lightSamples.length; i++) {
            if (claimed[i]) continue;

            const seed = g.lightSamples[i]!;
            let sx = seed.x, sy = seed.y, sz = seed.z, n = 1;
            claimed[i] = true;

            for (let j = i + 1; j < g.lightSamples.length; j++) {
                if (claimed[j]) continue;
                const o = g.lightSamples[j]!;
                if (Math.hypot(o.x - seed.x, o.y - seed.y, o.z - seed.z) < CLUSTER_RADIUS) {
                    sx += o.x; sy += o.y; sz += o.z; n += 1;
                    claimed[j] = true;
                }
            }

            lights.push({
                x: sx / n,
                y: sy / n,
                z: sz / n,
                /*
                 meep point lights are photometric: `intensity` is candela and
                 `intensity_lumens` is lumens. That makes `q3map_surfacelight`
                 unusually easy to map -- q3map2's units are already roughly
                 proportional to emitted power, and the typical range (1000-2000
                 for a ceiling fixture, 200-500 for a trim strip) lines up with
                 real luminous flux almost 1:1. So it is passed through as lumens
                 and the runtime does the lm -> cd conversion the engine
                 documents.

                 Clamped at 20000 lm because a handful of OA lava and sky shaders
                 declare values in the tens of thousands, which as real light
                 would white out the room they are in.
                */
                lumens: Math.min(pbr.surfaceLight, 20000),
                // Cutoff radius, in metres.
                radius: Math.min(60, 6 + pbr.surfaceLight / 120),
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

         The port already decides how much light a surface emits -- that is the
         cluster above, `surfaceLight` lumens of it -- so the fixture's face has
         a right answer rather than a taste: a Lambertian emitter radiating flux
         F over area A has luminance F / (pi * A). Emissive and point light stop
         being two unrelated guesses and become two views of one emission.

         It comes out conservative against real fixtures, which is a good sign
         that nothing here is inflated: `base_light/ceil1_38` lands at 96 cd/m2
         and `gothic_light/ironcrosslt2_20000` at 1,600, against roughly 2,000
         to 8,000 for the diffuser of an office ceiling panel.
        */
        const clusters = lights.length - before;
        let area = 0;
        for (const model of modelGroups) {
            const mg = model.get(shaderNum);
            if (mg !== undefined) area += groupArea(mg);
        }

        if (area > 0) {
            const flux = Math.max(clusters, 1) * Math.min(pbr.surfaceLight, 20000);
            emissiveLuminance.set(g.materialIndex, flux / (Math.PI * area));
        }
    }

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
            // q3map_sun intensity is q3map2's own scale; 100 is a bright
            // midday sun there. meep's `make_sunlight` defaults to 2.2, so the
            // divisor lands a typical map near that.
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

            gridLights = fit.lights;
            gridFit = { before: fit.residualBefore, after: fit.residualAfter, sites: fit.sites };

            for (const l of gridLights) lights.push(l);
        }
    }

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
        if (luminance !== undefined && materials[i]!.emissive !== null) {
            materials[i] = { ...materials[i]!, emissiveLuminance: luminance };
        }
    }

    for (const m of materials) {
        if (m.albedo !== null) {
            textureFor[m.albedo] = await convertTexture(
                index,
                texturePathOf(m.albedo),
                textureDir,
                written,
                m.albedoBlend
            );
        }
        if (m.emissive !== null) {
            textureFor[m.emissive] = await convertTexture(
                index,
                m.emissive,
                textureDir,
                written,
                'opaque'
            );
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
        (gridFit !== null && gridLights.length > 0
            ? ` (${gridLights.length} fitted to ${gridFit.sites} lightgrid cells, ` +
              `RMS ${(gridFit.before * 100).toFixed(0)}% -> ${(gridFit.after * 100).toFixed(0)}%)`
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
