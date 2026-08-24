/*
 * BspFile.ts -- reader for Quake III BSP (IBSP version 46).
 *
 * Ported from the lump layout in ioquake3's `code/qcommon/qfiles.h` and the
 * loaders in `code/qcommon/cm_load.c` and `code/renderercommon/tr_bsp.c`.
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
 * This reader is shared by the offline asset pipeline (which turns the render
 * lumps into meep geometry) and the runtime (which keeps the collision lumps as
 * the clipmap `cm_trace` walks). One reader rather than two, because a
 * disagreement between them about, say, plane winding would show up as a
 * physics bug that looks like a rendering bug.
 *
 * Lumps are exposed as typed-array views over the original buffer wherever the
 * on-disk layout allows it -- no per-record object allocation. A 30 MB BSP has
 * ~200k vertices and ~10k brush sides; materialising those as objects costs more
 * than the parse.
 */

export const BSP_IDENT = 0x50534249; // 'IBSP' little-endian
export const BSP_VERSION = 46;

export const LUMP = {
    ENTITIES: 0,
    SHADERS: 1,
    PLANES: 2,
    NODES: 3,
    LEAFS: 4,
    LEAFSURFACES: 5,
    LEAFBRUSHES: 6,
    MODELS: 7,
    BRUSHES: 8,
    BRUSHSIDES: 9,
    DRAWVERTS: 10,
    DRAWINDEXES: 11,
    FOGS: 12,
    SURFACES: 13,
    LIGHTMAPS: 14,
    LIGHTGRID: 15,
    VISIBILITY: 16,
} as const;

export const HEADER_LUMPS = 17;

/** `mapSurfaceType_t` in qfiles.h. */
export const MST = {
    BAD: 0,
    PLANAR: 1,
    PATCH: 2,
    TRIANGLE_SOUP: 3,
    FLARE: 4,
} as const;

export const LIGHTMAP_WIDTH = 128;
export const LIGHTMAP_HEIGHT = 128;

/** Bytes per record, straight from the C structs. */
const SIZEOF = {
    shader: 64 + 4 + 4, // char[MAX_QPATH=64], int surfaceFlags, int contentFlags
    plane: 4 * 4, // float normal[3], float dist
    node: 4 + 4 * 2 + 4 * 3 + 4 * 3, // int planeNum, int children[2], int mins[3], int maxs[3]
    leaf: 4 * 12,
    leafSurface: 4,
    leafBrush: 4,
    model: 4 * 3 + 4 * 3 + 4 * 4,
    brush: 4 * 3, // int firstSide, numSides, shaderNum
    brushSide: 4 * 2, // int planeNum, shaderNum
    drawVert: 4 * 3 + 4 * 2 + 4 * 2 + 4 * 3 + 4, // xyz, st, lightmap, normal, byte color[4]
    drawIndex: 4,
    fog: 64 + 4 + 4,
    surface: 4 * 26,
    lightmap: LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3,
} as const;

export interface BspLumpRange {
    readonly offset: number;
    readonly length: number;
}

/**
 * A shader reference from `LUMP_SHADERS`. These are *names*, not shader code:
 * the string is looked up in the `.shader` scripts, and where no script defines
 * it the name doubles as a texture path. The port resolves both offline.
 */
export interface BspShaderRef {
    readonly name: string;
    readonly surfaceFlags: number;
    readonly contentFlags: number;
}

/** One entry from `LUMP_SURFACES` -- a draw surface. */
export interface BspSurface {
    readonly shaderNum: number;
    readonly fogNum: number;
    readonly surfaceType: number;
    readonly firstVert: number;
    readonly numVerts: number;
    readonly firstIndex: number;
    readonly numIndexes: number;
    readonly lightmapNum: number;
    readonly lightmapX: number;
    readonly lightmapY: number;
    readonly lightmapWidth: number;
    readonly lightmapHeight: number;
    readonly lightmapOrigin: readonly [number, number, number];
    /** For patches, `[0]` and `[1]` are LOD bounds rather than lightmap axes. */
    readonly lightmapVecs: readonly [
        readonly [number, number, number],
        readonly [number, number, number],
        readonly [number, number, number],
    ];
    readonly patchWidth: number;
    readonly patchHeight: number;
}

/** One entry from `LUMP_MODELS`. Model 0 is the world; the rest are `*1`, `*2`... */
export interface BspModel {
    readonly mins: readonly [number, number, number];
    readonly maxs: readonly [number, number, number];
    readonly firstSurface: number;
    readonly numSurfaces: number;
    readonly firstBrush: number;
    readonly numBrushes: number;
}

/**
 * `drawVert_t` is 44 bytes: 11 floats' worth, except the last 4 bytes are a
 * `byte[4]` colour. Exposing it as one `Float32Array` plus one `Uint8Array` over
 * the same bytes lets both be read without copying; `VERT_STRIDE_F32` is the
 * stride in float units and `VERT_*` are the offsets within a record.
 */
export const VERT_STRIDE_F32 = 11;
export const VERT_XYZ = 0;
export const VERT_ST = 3;
export const VERT_LIGHTMAP = 5;
export const VERT_NORMAL = 7;
export const VERT_COLOR_BYTES = 40;
export const VERT_STRIDE_BYTES = SIZEOF.drawVert;

function readCString(bytes: Uint8Array, offset: number, max: number): string {
    let end = offset;
    const limit = offset + max;
    while (end < limit && bytes[end] !== 0) end += 1;
    return new TextDecoder('utf-8').decode(bytes.subarray(offset, end));
}

export class BspFile {
    readonly buffer: ArrayBuffer;
    readonly bytes: Uint8Array;
    readonly view: DataView;
    readonly lumps: readonly BspLumpRange[];

    /** Path this was loaded from, for diagnostics. */
    readonly name: string;

    constructor(buffer: ArrayBuffer, name = '<bsp>') {
        this.buffer = buffer;
        this.bytes = new Uint8Array(buffer);
        this.view = new DataView(buffer);
        this.name = name;

        const ident = this.view.getUint32(0, true);
        if (ident !== BSP_IDENT) {
            throw new Error(
                `${name}: not a Quake III BSP (ident 0x${ident.toString(16)}, expected IBSP)`
            );
        }

        const version = this.view.getInt32(4, true);
        if (version !== BSP_VERSION) {
            throw new Error(
                `${name}: BSP version ${version}, expected ${BSP_VERSION}. ` +
                `Version 47 is RTCW/RBSP and is not supported.`
            );
        }

        const lumps: BspLumpRange[] = [];
        for (let i = 0; i < HEADER_LUMPS; i++) {
            const p = 8 + i * 8;
            lumps.push({
                offset: this.view.getInt32(p, true),
                length: this.view.getInt32(p + 4, true),
            });
        }
        this.lumps = lumps;
    }

    private lump(index: number): BspLumpRange {
        const l = this.lumps[index];
        if (l === undefined) throw new Error(`${this.name}: no lump ${index}`);
        if (l.offset < 0 || l.offset + l.length > this.bytes.byteLength) {
            throw new Error(
                `${this.name}: lump ${index} runs outside the file ` +
                `(offset ${l.offset}, length ${l.length}, file ${this.bytes.byteLength})`
            );
        }
        return l;
    }

    /**
     * Number of records in a fixed-stride lump. Throws when the lump length is
     * not a whole number of records -- a corrupt or misidentified file, and much
     * easier to diagnose here than as garbage geometry later.
     */
    private count(index: number, stride: number): number {
        const l = this.lump(index);
        if (l.length % stride !== 0) {
            throw new Error(
                `${this.name}: lump ${index} length ${l.length} is not a multiple of ` +
                `record size ${stride}`
            );
        }
        return l.length / stride;
    }

    private i32(index: number, stride: number): Int32Array {
        const l = this.lump(index);
        // `Int32Array` over the buffer needs 4-byte alignment, which BSP lump
        // offsets do not guarantee. Copy when misaligned rather than throwing an
        // opaque RangeError.
        if (l.offset % 4 === 0) {
            return new Int32Array(this.buffer, l.offset, l.length / 4);
        }
        return new Int32Array(this.buffer.slice(l.offset, l.offset + l.length));
    }

    private f32(index: number): Float32Array {
        const l = this.lump(index);
        if (l.offset % 4 === 0) {
            return new Float32Array(this.buffer, l.offset, l.length / 4);
        }
        return new Float32Array(this.buffer.slice(l.offset, l.offset + l.length));
    }

    /* ---------------- entities ---------------- */

    /**
     * The raw entity lump: a single string of `{ "key" "value" ... }` blocks.
     * `parseEntities` in `Entities.ts` turns it into records; this is what
     * `trap_GetEntityToken` walked one token at a time.
     */
    get entityString(): string {
        const l = this.lump(LUMP.ENTITIES);
        return readCString(this.bytes, l.offset, l.length);
    }

    /* ---------------- render lumps ---------------- */

    get shaders(): BspShaderRef[] {
        const n = this.count(LUMP.SHADERS, SIZEOF.shader);
        const base = this.lump(LUMP.SHADERS).offset;
        const out: BspShaderRef[] = [];

        for (let i = 0; i < n; i++) {
            const p = base + i * SIZEOF.shader;
            out.push({
                // Q3 paths are case-insensitive; lowercasing here means every
                // later lookup can be a plain string compare.
                name: readCString(this.bytes, p, 64).replace(/\\/g, '/').toLowerCase(),
                surfaceFlags: this.view.getInt32(p + 64, true),
                contentFlags: this.view.getInt32(p + 68, true),
            });
        }

        return out;
    }

    /** All draw vertices as a flat `Float32Array`, stride {@link VERT_STRIDE_F32}. */
    get drawVertsFloat(): Float32Array {
        return this.f32(LUMP.DRAWVERTS);
    }

    /** The same bytes as {@link drawVertsFloat}, for the `byte[4]` colour field. */
    get drawVertsBytes(): Uint8Array {
        const l = this.lump(LUMP.DRAWVERTS);
        return this.bytes.subarray(l.offset, l.offset + l.length);
    }

    get numDrawVerts(): number {
        return this.count(LUMP.DRAWVERTS, SIZEOF.drawVert);
    }

    get drawIndexes(): Int32Array {
        return this.i32(LUMP.DRAWINDEXES, SIZEOF.drawIndex);
    }

    get surfaces(): BspSurface[] {
        const n = this.count(LUMP.SURFACES, SIZEOF.surface);
        const base = this.lump(LUMP.SURFACES).offset;
        const v = this.view;
        const out: BspSurface[] = [];

        for (let i = 0; i < n; i++) {
            const p = base + i * SIZEOF.surface;
            const vec = (o: number): readonly [number, number, number] => [
                v.getFloat32(p + o, true),
                v.getFloat32(p + o + 4, true),
                v.getFloat32(p + o + 8, true),
            ];

            out.push({
                shaderNum: v.getInt32(p, true),
                fogNum: v.getInt32(p + 4, true),
                surfaceType: v.getInt32(p + 8, true),
                firstVert: v.getInt32(p + 12, true),
                numVerts: v.getInt32(p + 16, true),
                firstIndex: v.getInt32(p + 20, true),
                numIndexes: v.getInt32(p + 24, true),
                lightmapNum: v.getInt32(p + 28, true),
                lightmapX: v.getInt32(p + 32, true),
                lightmapY: v.getInt32(p + 36, true),
                lightmapWidth: v.getInt32(p + 40, true),
                lightmapHeight: v.getInt32(p + 44, true),
                lightmapOrigin: vec(48),
                lightmapVecs: [vec(60), vec(72), vec(84)],
                patchWidth: v.getInt32(p + 96, true),
                patchHeight: v.getInt32(p + 100, true),
            });
        }

        return out;
    }

    get numLightmaps(): number {
        return this.count(LUMP.LIGHTMAPS, SIZEOF.lightmap);
    }

    /**
     * One 128x128 RGB lightmap page, as raw bytes.
     *
     * These are *not* sRGB and are not linear either: Q3 wrote them with an
     * overbright-bit convention where the renderer multiplied by 2 at draw time.
     * The conversion decides what to do about that; the reader hands back bytes.
     */
    lightmap(index: number): Uint8Array {
        const l = this.lump(LUMP.LIGHTMAPS);
        const at = l.offset + index * SIZEOF.lightmap;
        return this.bytes.subarray(at, at + SIZEOF.lightmap);
    }

    get models(): BspModel[] {
        const n = this.count(LUMP.MODELS, SIZEOF.model);
        const base = this.lump(LUMP.MODELS).offset;
        const v = this.view;
        const out: BspModel[] = [];

        for (let i = 0; i < n; i++) {
            const p = base + i * SIZEOF.model;
            out.push({
                mins: [
                    v.getFloat32(p, true),
                    v.getFloat32(p + 4, true),
                    v.getFloat32(p + 8, true),
                ],
                maxs: [
                    v.getFloat32(p + 12, true),
                    v.getFloat32(p + 16, true),
                    v.getFloat32(p + 20, true),
                ],
                firstSurface: v.getInt32(p + 24, true),
                numSurfaces: v.getInt32(p + 28, true),
                firstBrush: v.getInt32(p + 32, true),
                numBrushes: v.getInt32(p + 36, true),
            });
        }

        return out;
    }

    /* ---------------- collision lumps ---------------- */

    /** `float normal[3], dist` per plane, flat. */
    get planes(): Float32Array {
        return this.f32(LUMP.PLANES);
    }

    get numPlanes(): number {
        return this.count(LUMP.PLANES, SIZEOF.plane);
    }

    /** `planeNum, children[2], mins[3], maxs[3]` per node, flat, stride 9. */
    get nodes(): Int32Array {
        return this.i32(LUMP.NODES, SIZEOF.node);
    }

    get numNodes(): number {
        return this.count(LUMP.NODES, SIZEOF.node);
    }

    /** 12 ints per leaf: cluster, area, mins[3], maxs[3], firstLeafSurface, numLeafSurfaces, firstLeafBrush, numLeafBrushes. */
    get leafs(): Int32Array {
        return this.i32(LUMP.LEAFS, SIZEOF.leaf);
    }

    get numLeafs(): number {
        return this.count(LUMP.LEAFS, SIZEOF.leaf);
    }

    get leafSurfaces(): Int32Array {
        return this.i32(LUMP.LEAFSURFACES, SIZEOF.leafSurface);
    }

    get leafBrushes(): Int32Array {
        return this.i32(LUMP.LEAFBRUSHES, SIZEOF.leafBrush);
    }

    /** 3 ints per brush: firstSide, numSides, shaderNum. */
    get brushes(): Int32Array {
        return this.i32(LUMP.BRUSHES, SIZEOF.brush);
    }

    get numBrushes(): number {
        return this.count(LUMP.BRUSHES, SIZEOF.brush);
    }

    /** 2 ints per side: planeNum, shaderNum. */
    get brushSides(): Int32Array {
        return this.i32(LUMP.BRUSHSIDES, SIZEOF.brushSide);
    }

    get numBrushSides(): number {
        return this.count(LUMP.BRUSHSIDES, SIZEOF.brushSide);
    }

    /* ---------------- summary ---------------- */

    describe(): Record<string, number | string> {
        return {
            name: this.name,
            bytes: this.bytes.byteLength,
            shaders: this.count(LUMP.SHADERS, SIZEOF.shader),
            planes: this.numPlanes,
            nodes: this.numNodes,
            leafs: this.numLeafs,
            brushes: this.numBrushes,
            brushSides: this.numBrushSides,
            drawVerts: this.numDrawVerts,
            drawIndexes: this.count(LUMP.DRAWINDEXES, SIZEOF.drawIndex),
            surfaces: this.count(LUMP.SURFACES, SIZEOF.surface),
            lightmaps: this.numLightmaps,
            models: this.count(LUMP.MODELS, SIZEOF.model),
            entityStringBytes: this.lump(LUMP.ENTITIES).length,
        };
    }
}
