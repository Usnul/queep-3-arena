/*
 * ClipMap.ts -- Quake III collision model.
 *
 * Ported from ioquake3's `code/qcommon/cm_load.c`.
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
 * The brush/plane/leaf data `CM_BoxTrace` walks. Structure-of-arrays over typed
 * arrays rather than objects: a trace touches thousands of planes and the whole
 * point of this file existing separately from the renderer's BSP reader is that
 * it is on the movement hot path.
 *
 * **Planes are stored as `Float32Array`.** The C engine's `cplane_t` holds
 * `float`, and the trace's plane-selection decisions turn on exact comparisons
 * of dot products against those values. Holding them as `float64` would start
 * every trace from slightly different inputs than the oracle does. Arithmetic is
 * still done in double, which is *more* accurate than the C, not less -- the
 * divergence that leaves is bounded and is what the differential test measures.
 */

import { BspFile } from '../bsp/BspFile.ts';

/** `cm_local.h`. Q3 offsets clipped surfaces by 1/8 unit. */
export const SURFACE_CLIP_EPSILON = 0.125;

/** `q_shared.h` content flags, as far as movement is concerned. */
export const CONTENTS = {
    SOLID: 1,
    LAVA: 8,
    SLIME: 16,
    WATER: 32,
    FOG: 64,
    NOTTEAM1: 0x0080,
    NOTTEAM2: 0x0100,
    NOBOTCLIP: 0x0200,
    AREAPORTAL: 0x8000,
    PLAYERCLIP: 0x10000,
    MONSTERCLIP: 0x20000,
    TELEPORTER: 0x40000,
    JUMPPAD: 0x80000,
    CLUSTERPORTAL: 0x100000,
    DONOTENTER: 0x200000,
    BOTCLIP: 0x400000,
    MOVER: 0x800000,
    ORIGIN: 0x1000000,
    BODY: 0x2000000,
    CORPSE: 0x4000000,
    DETAIL: 0x8000000,
    STRUCTURAL: 0x10000000,
    TRANSLUCENT: 0x20000000,
    TRIGGER: 0x40000000,
    NODROP: 0x80000000,
} as const;

export const MASK_ALL = -1;
export const MASK_SOLID = CONTENTS.SOLID;
export const MASK_PLAYERSOLID = CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.BODY;
export const MASK_DEADSOLID = CONTENTS.SOLID | CONTENTS.PLAYERCLIP;
export const MASK_WATER = CONTENTS.WATER | CONTENTS.LAVA | CONTENTS.SLIME;

/** `q_shared.h` surface flags used by movement. */
export const SURF = {
    NODAMAGE: 0x1,
    SLICK: 0x2,
    SKY: 0x4,
    LADDER: 0x8,
    NOIMPACT: 0x10,
    NOMARKS: 0x20,
    FLESH: 0x40,
    NODRAW: 0x80,
    HINT: 0x100,
    SKIP: 0x200,
    NOLIGHTMAP: 0x400,
    POINTLIGHT: 0x800,
    METALSTEPS: 0x1000,
    NOSTEPS: 0x2000,
    NONSOLID: 0x4000,
    LIGHTFILTER: 0x8000,
    ALPHASHADOW: 0x10000,
    NODLIGHT: 0x20000,
    DUST: 0x40000,
} as const;

/** Plane stride in `planes`: normal x, y, z, dist. */
export const PLANE_STRIDE = 4;

/**
 * `PlaneTypeForNormal` from `q_shared.h`: 0/1/2 for a plane whose normal is
 * exactly axial, 3 otherwise. The trace's tree walk takes a much cheaper path
 * for axial planes, and *which* path it takes changes the arithmetic, so this
 * has to agree with the C exactly.
 */
function planeTypeForNormal(x: number, y: number, z: number): number {
    if (x === 1.0 || x === -1.0) return 0;
    if (y === 1.0 || y === -1.0) return 1;
    if (z === 1.0 || z === -1.0) return 2;
    return 3;
}

/** `SetPlaneSignbits`: one bit per negative normal component. */
function planeSignbits(x: number, y: number, z: number): number {
    let bits = 0;
    if (x < 0) bits |= 1;
    if (y < 0) bits |= 2;
    if (z < 0) bits |= 4;
    return bits;
}

/**
 * The collision data of one BSP.
 *
 * Patch (curved surface) collision is **not** loaded -- see DECISIONS.md D-017.
 * `numPatches` reports how many the map has so callers can tell whether a given
 * level is affected.
 */
export class ClipMap {
    readonly name: string;

    /** 4 floats per plane: normal xyz, dist. */
    readonly planes: Float32Array;
    /** Per plane: `PlaneTypeForNormal`. */
    readonly planeTypes: Uint8Array;
    /** Per plane: `SetPlaneSignbits`. */
    readonly planeSignbits: Uint8Array;
    readonly numPlanes: number;

    /** 9 ints per node: planeNum, children[2], mins[3], maxs[3]. */
    readonly nodes: Int32Array;
    readonly numNodes: number;

    /** 12 ints per leaf; see `BspFile.leafs`. */
    readonly leafs: Int32Array;
    readonly numLeafs: number;

    readonly leafBrushes: Int32Array;
    readonly leafSurfaces: Int32Array;

    /** 3 ints per brush: firstSide, numSides, shaderNum. */
    readonly brushes: Int32Array;
    /** Per brush: contentFlags of its shader. */
    readonly brushContents: Int32Array;
    /** 6 floats per brush: mins xyz, maxs xyz, from its first six sides. */
    readonly brushBounds: Float32Array;
    /** Scratch, one per brush: the `checkcount` de-duplication the C uses. */
    readonly brushCheckcount: Int32Array;
    readonly numBrushes: number;

    /** 2 ints per side: planeNum, shaderNum. */
    readonly brushSides: Int32Array;
    /** Per side: surfaceFlags of its shader. */
    readonly sideSurfaceFlags: Int32Array;
    readonly numBrushSides: number;

    /** Submodel table: 6 floats of bounds then firstBrush/numBrushes/firstSurface/numSurfaces. */
    readonly models: {
        readonly mins: readonly [number, number, number];
        readonly maxs: readonly [number, number, number];
        readonly firstBrush: number;
        readonly numBrushes: number;
        readonly firstSurface: number;
        readonly numSurfaces: number;
        /** Leaf synthesised for a submodel, as `CM_InitBoxHull` does for the world. */
        readonly leafBrushes: Int32Array;
    }[];

    /** How many `MST_PATCH` surfaces the map has; see D-017. */
    readonly numPatches: number;

    /** Incremented per trace so a brush in two leafs is only tested once. */
    checkcount = 0;

    constructor(bsp: BspFile) {
        this.name = bsp.name;

        /* ---- planes ---- */

        const rawPlanes = bsp.planes;
        this.numPlanes = bsp.numPlanes;
        this.planes = rawPlanes;
        this.planeTypes = new Uint8Array(this.numPlanes);
        this.planeSignbits = new Uint8Array(this.numPlanes);

        for (let i = 0; i < this.numPlanes; i++) {
            const o = i * PLANE_STRIDE;
            const nx = rawPlanes[o]!;
            const ny = rawPlanes[o + 1]!;
            const nz = rawPlanes[o + 2]!;
            this.planeTypes[i] = planeTypeForNormal(nx, ny, nz);
            this.planeSignbits[i] = planeSignbits(nx, ny, nz);
        }

        /* ---- tree ---- */

        this.nodes = bsp.nodes;
        this.numNodes = bsp.numNodes;
        this.leafs = bsp.leafs;
        this.numLeafs = bsp.numLeafs;
        this.leafBrushes = bsp.leafBrushes;
        this.leafSurfaces = bsp.leafSurfaces;

        /* ---- shaders: contents and surface flags ---- */

        const shaders = bsp.shaders;

        /* ---- brush sides ---- */

        this.brushSides = bsp.brushSides;
        this.numBrushSides = bsp.numBrushSides;
        this.sideSurfaceFlags = new Int32Array(this.numBrushSides);

        for (let i = 0; i < this.numBrushSides; i++) {
            const shaderNum = this.brushSides[i * 2 + 1]!;
            this.sideSurfaceFlags[i] = shaders[shaderNum]?.surfaceFlags ?? 0;
        }

        /* ---- brushes ---- */

        this.brushes = bsp.brushes;
        this.numBrushes = bsp.numBrushes;
        this.brushContents = new Int32Array(this.numBrushes);
        this.brushBounds = new Float32Array(this.numBrushes * 6);
        this.brushCheckcount = new Int32Array(this.numBrushes);

        for (let i = 0; i < this.numBrushes; i++) {
            const firstSide = this.brushes[i * 3]!;
            const numSides = this.brushes[i * 3 + 1]!;
            const shaderNum = this.brushes[i * 3 + 2]!;

            this.brushContents[i] = shaders[shaderNum]?.contentFlags ?? 0;

            /*
             `CM_BoundBrush`: the first six sides of any brush q3map2 emits are
             its axial planes, in the fixed order -x +x -y +y -z +z, so the
             bounds come straight off their distances. This is not a heuristic --
             the compiler guarantees the ordering, and the C relies on it.
            */
            const b = i * 6;
            if (numSides >= 6) {
                this.brushBounds[b] = -this.planeDist(this.sidePlane(firstSide));
                this.brushBounds[b + 3] = this.planeDist(this.sidePlane(firstSide + 1));
                this.brushBounds[b + 1] = -this.planeDist(this.sidePlane(firstSide + 2));
                this.brushBounds[b + 4] = this.planeDist(this.sidePlane(firstSide + 3));
                this.brushBounds[b + 2] = -this.planeDist(this.sidePlane(firstSide + 4));
                this.brushBounds[b + 5] = this.planeDist(this.sidePlane(firstSide + 5));
            }
        }

        /* ---- submodels ---- */

        this.models = bsp.models.map((m) => {
            /*
             `CM_InitBoxHull` gives each submodel a leaf listing its own brushes,
             so a trace against `*1` walks that brush list instead of the tree.
            */
            const brushList = new Int32Array(m.numBrushes);
            for (let i = 0; i < m.numBrushes; i++) brushList[i] = m.firstBrush + i;

            return {
                mins: m.mins,
                maxs: m.maxs,
                firstBrush: m.firstBrush,
                numBrushes: m.numBrushes,
                firstSurface: m.firstSurface,
                numSurfaces: m.numSurfaces,
                leafBrushes: brushList,
            };
        });

        /* ---- patches (counted, not loaded) ---- */

        let patches = 0;
        for (const s of bsp.surfaces) {
            if (s.surfaceType === 2 /* MST_PATCH */) patches += 1;
        }
        this.numPatches = patches;
    }

    /** Plane index of a brush side. */
    sidePlane(sideIndex: number): number {
        return this.brushSides[sideIndex * 2]!;
    }

    planeDist(planeIndex: number): number {
        return this.planes[planeIndex * PLANE_STRIDE + 3]!;
    }

    describe(): Record<string, number | string> {
        return {
            name: this.name,
            planes: this.numPlanes,
            nodes: this.numNodes,
            leafs: this.numLeafs,
            brushes: this.numBrushes,
            brushSides: this.numBrushSides,
            models: this.models.length,
            patches: this.numPatches,
        };
    }
}
