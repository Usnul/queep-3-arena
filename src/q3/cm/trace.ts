/*
 * trace.ts -- CM_BoxTrace and CM_PointContents.
 *
 * Ported line-for-line from ioquake3's `code/qcommon/cm_trace.c` and
 * `cm_test.c`.
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
 * This is the file the rest of the port's movement fidelity rests on, and it is
 * deliberately a *transcription* rather than a reimplementation: same control
 * flow, same epsilon placement, same order of comparisons, C names preserved in
 * comments. Where a reader would reasonably ask "why like that", the answer is
 * "because `cm_trace.c` does it like that" and the differential test in
 * `test/` is what proves it still does.
 *
 * The one structural difference: capsule tracing is not ported. OpenArena uses
 * bounding boxes for players (`pm->trace` is always called with a box, and
 * `CM_BoxTrace` is invoked with `capsule = qfalse` everywhere in the movement
 * path), so the capsule branches are dead code for this port. See D-018.
 */

import {
    ClipMap,
    PLANE_STRIDE,
    SURFACE_CLIP_EPSILON,
    CONTENTS,
} from './ClipMap.ts';
import type { BrushHull } from './brushHull.ts';

import { v3_dot } from '@woosh/meep-engine/src/core/geom/vec3/v3_dot.js';

/* ------------------------------------------------------------------ *
 * Arithmetic.
 *
 * Plain float64, which is what JavaScript has, and `DotProduct` is meep's
 * `v3_dot` rather than a local one. This file used to wrap every multiply and
 * add in `Math.fround` so the port reproduced the C's `float` rounding step for
 * step; D-174 struck that, and the measured cost is set out there.
 *
 * `TraceWork` still stores its vectors in `Float32Array`, because the C's
 * `trace_t` and `vec3_t` are `float` and that is also what goes on the wire.
 * Storage is the one place the width is still Q3's; the arithmetic in between
 * is the engine's.
 * ------------------------------------------------------------------ */

/** `trace_t` from `q_shared.h`. */
export interface TraceResult {
    allsolid: boolean;
    startsolid: boolean;
    fraction: number;
    endpos: [number, number, number];
    planeNormal: [number, number, number];
    planeDist: number;
    surfaceFlags: number;
    contents: number;
    entityNum: number;
}

export function createTrace(): TraceResult {
    return {
        allsolid: false,
        startsolid: false,
        fraction: 1,
        endpos: [0, 0, 0],
        planeNormal: [0, 0, 0],
        planeDist: 0,
        surfaceFlags: 0,
        contents: 0,
        entityNum: 0,
    };
}

/**
 * `traceWork_t`.
 *
 * Held as a reusable object rather than allocated per trace: pmove issues on the
 * order of ten traces per frame and this is on the movement hot path. The
 * engine does the same thing with a stack local; the difference is only that JS
 * would otherwise allocate.
 */
class TraceWork {
    trace = createTrace();

    /*
     Float32Array, not plain arrays: these hold what the C holds in `float`
     fields, and the width they round to is the one the wire format and the
     `trace_t` above use.
    */
    readonly start = new Float32Array(3);
    readonly end = new Float32Array(3);

    /** size[0] = mins, size[1] = maxs, both recentred so the box is symmetric. */
    readonly sizeMin = new Float32Array(3);
    readonly sizeMax = new Float32Array(3);

    /** `offsets[signbits]` -- vector to the appropriate corner. 8 x 3. */
    readonly offsets = new Float32Array(24);

    readonly boundsMin = new Float32Array(3);
    readonly boundsMax = new Float32Array(3);

    readonly extents = new Float32Array(3);

    isPoint = false;
    contents = 0;
    maxOffset = 0;
}

const tw = new TraceWork();

/** `MAX_POSITION_LEAFS` in cm_local.h. */
const MAX_POSITION_LEAFS = 1024;
const positionLeafs = new Int32Array(MAX_POSITION_LEAFS);

/**
 * `leafList_t.bounds` -- the box the *leaf walk* uses, which is deliberately not
 * `tw.bounds`.
 *
 * `CM_PositionTest` expands the player box by one unit on every axis before
 * choosing leaves, so a box resting exactly on a surface still finds the leaf
 * below it. That expansion belongs to leaf selection only: `CM_TestBoxInBrush`
 * still rejects brushes against the *unexpanded* `tw->bounds`.
 *
 * Writing the expanded box into `tw.bounds` instead -- which is what this did
 * first, because the C uses a local `leafList_t` and the distinction is easy to
 * miss -- makes the axial rejection one unit too generous, and a player standing
 * on a floor tests as inside it. Symptom: crouch, release crouch, and
 * `PM_CheckDuck`'s headroom trace reports solid, so the player never stands up.
 */
const leafBoundsMin = new Float32Array(3);
const leafBoundsMax = new Float32Array(3);

/* ------------------------------------------------------------------ *
 * CM_TraceThroughBrush
 * ------------------------------------------------------------------ */

function traceThroughBrush(cm: ClipMap, brushIndex: number): void {
    const numsides = cm.brushes[brushIndex * 3 + 1]!;
    if (numsides === 0) return;

    const firstSide = cm.brushes[brushIndex * 3]!;

    let enterFrac = -1.0;
    let leaveFrac = 1.0;
    let clipplane = -1;
    let leadside = -1;

    let getout = false;
    let startout = false;

    const planes = cm.planes;
    const sx = tw.start[0];
    const sy = tw.start[1];
    const sz = tw.start[2];
    const ex = tw.end[0];
    const ey = tw.end[1];
    const ez = tw.end[2];

    for (let i = 0; i < numsides; i++) {
        const sideIndex = firstSide + i;
        const planeIndex = cm.brushSides[sideIndex * 2]!;
        const p = planeIndex * PLANE_STRIDE;

        const nx = planes[p]!;
        const ny = planes[p + 1]!;
        const nz = planes[p + 2]!;

        // Adjust the plane distance appropriately for mins/maxs.
        const sb = cm.planeSignbits[planeIndex]! * 3;
        const dist = planes[p + 3]! - v3_dot(tw.offsets[sb]!, tw.offsets[sb + 1]!, tw.offsets[sb + 2]!, nx, ny, nz);

        const d1 = v3_dot(sx, sy, sz, nx, ny, nz) - dist;
        const d2 = v3_dot(ex, ey, ez, nx, ny, nz) - dist;

        if (d2 > 0) getout = true; // endpoint is not in solid
        if (d1 > 0) startout = true;

        // Completely in front of face -- no intersection with the entire brush.
        if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return;

        // Doesn't cross the plane -- the plane isn't relevant.
        if (d1 <= 0 && d2 <= 0) continue;

        if (d1 > d2) {
            // enter
            let f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2);
            if (f < 0) f = 0;
            if (f > enterFrac) {
                enterFrac = f;
                clipplane = planeIndex;
                leadside = sideIndex;
            }
        } else {
            // leave
            let f = (d1 + SURFACE_CLIP_EPSILON) / (d1 - d2);
            if (f > 1) f = 1;
            if (f < leaveFrac) leaveFrac = f;
        }
    }

    // All planes checked and the trace was not completely outside the brush.
    if (!startout) {
        // Original point was inside the brush.
        tw.trace.startsolid = true;
        if (!getout) {
            tw.trace.allsolid = true;
            tw.trace.fraction = 0;
            tw.trace.contents = cm.brushContents[brushIndex]!;
        }
        return;
    }

    if (enterFrac < leaveFrac) {
        if (enterFrac > -1 && enterFrac < tw.trace.fraction) {
            if (enterFrac < 0) enterFrac = 0;
            tw.trace.fraction = enterFrac;
            if (clipplane !== -1) {
                const p = clipplane * PLANE_STRIDE;
                tw.trace.planeNormal[0] = cm.planes[p]!;
                tw.trace.planeNormal[1] = cm.planes[p + 1]!;
                tw.trace.planeNormal[2] = cm.planes[p + 2]!;
                tw.trace.planeDist = cm.planes[p + 3]!;
            }
            if (leadside !== -1) {
                tw.trace.surfaceFlags = cm.sideSurfaceFlags[leadside]!;
            }
            tw.trace.contents = cm.brushContents[brushIndex]!;
        }
    }
}

/* ------------------------------------------------------------------ *
 * CM_TestBoxInBrush
 * ------------------------------------------------------------------ */

function testBoxInBrush(cm: ClipMap, brushIndex: number): void {
    const numsides = cm.brushes[brushIndex * 3 + 1]!;
    if (numsides === 0) return;

    const b = brushIndex * 6;
    if (
        tw.boundsMin[0] > cm.brushBounds[b + 3]! ||
        tw.boundsMin[1] > cm.brushBounds[b + 4]! ||
        tw.boundsMin[2] > cm.brushBounds[b + 5]! ||
        tw.boundsMax[0] < cm.brushBounds[b]! ||
        tw.boundsMax[1] < cm.brushBounds[b + 1]! ||
        tw.boundsMax[2] < cm.brushBounds[b + 2]!
    ) {
        return;
    }

    const firstSide = cm.brushes[brushIndex * 3]!;
    const planes = cm.planes;

    // The first six planes are the axial planes, so only the remainder matter.
    for (let i = 6; i < numsides; i++) {
        const sideIndex = firstSide + i;
        const planeIndex = cm.brushSides[sideIndex * 2]!;
        const p = planeIndex * PLANE_STRIDE;

        const nx = planes[p]!;
        const ny = planes[p + 1]!;
        const nz = planes[p + 2]!;

        const sb = cm.planeSignbits[planeIndex]! * 3;
        const dist = planes[p + 3]! - v3_dot(tw.offsets[sb]!, tw.offsets[sb + 1]!, tw.offsets[sb + 2]!, nx, ny, nz);

        const d1 = v3_dot(tw.start[0]!, tw.start[1]!, tw.start[2]!, nx, ny, nz) - dist;

        // Completely in front of face -- no intersection.
        if (d1 > 0) return;
    }

    // Inside this brush.
    tw.trace.startsolid = true;
    tw.trace.allsolid = true;
    tw.trace.fraction = 0;
    tw.trace.contents = cm.brushContents[brushIndex]!;
}

/* ------------------------------------------------------------------ *
 * Leaf iteration
 * ------------------------------------------------------------------ */

/** `cLeaf_t` field indices within `ClipMap.leafs` (12 ints per leaf). */
const LEAF_FIRST_SURFACE = 8;
const LEAF_NUM_SURFACES = 9;
const LEAF_FIRST_BRUSH = 10;
const LEAF_NUM_BRUSHES = 11;

/**
 * `CM_BoundsIntersect` from `cm_test.c`.
 *
 * **Note the epsilon.** This is not a plain AABB overlap: the C widens the
 * brush by `SURFACE_CLIP_EPSILON` on every axis before testing, so a sweep that
 * merely grazes a brush's bounding box is still handed to
 * `CM_TraceThroughBrush`. Omitting it makes the port silently miss grazing
 * contacts -- which is what it did, on 1 of 4000 randomised sweeps, until the
 * differential test caught it.
 */
function boundsIntersect(
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushBounds: Float32Array,
    b: number
): boolean {
    return !(
        maxs[0]! < (brushBounds[b]! - SURFACE_CLIP_EPSILON) ||
        maxs[1]! < (brushBounds[b + 1]! - SURFACE_CLIP_EPSILON) ||
        maxs[2]! < (brushBounds[b + 2]! - SURFACE_CLIP_EPSILON) ||
        mins[0]! > (brushBounds[b + 3]! + SURFACE_CLIP_EPSILON) ||
        mins[1]! > (brushBounds[b + 4]! + SURFACE_CLIP_EPSILON) ||
        mins[2]! > (brushBounds[b + 5]! + SURFACE_CLIP_EPSILON)
    );
}

function traceThroughLeaf(cm: ClipMap, leafIndex: number): void {
    const base = leafIndex * 12;
    const firstLeafBrush = cm.leafs[base + LEAF_FIRST_BRUSH]!;
    const numLeafBrushes = cm.leafs[base + LEAF_NUM_BRUSHES]!;

    for (let k = 0; k < numLeafBrushes; k++) {
        const brushnum = cm.leafBrushes[firstLeafBrush + k]!;

        if (cm.brushCheckcount[brushnum] === cm.checkcount) continue;
        cm.brushCheckcount[brushnum] = cm.checkcount;

        const contents = cm.brushContents[brushnum]!;
        if ((contents & tw.contents) === 0) continue;

        if (!boundsIntersect(tw.boundsMin, tw.boundsMax, cm.brushBounds, brushnum * 6)) {
            continue;
        }

        traceThroughBrush(cm, brushnum);
        if (tw.trace.fraction === 0) return;
    }

    // Patch collision is not ported here -- see D-017. `cm_patch.c`'s grid walk
    // is what belongs in this loop, and is still missing, so *this* trace
    // passes through curved surfaces. The physics backend does not: it collides
    // against the facets `patchHull.ts` builds, and `traceHullList` below rules
    // on them with the same per-volume test this loop runs on brushes. So the
    // gap is now between the two backends rather than between the port and Q3,
    // and `PmoveHost` picks the physics one whenever it has it.
}

function testInLeaf(cm: ClipMap, leafIndex: number): void {
    const base = leafIndex * 12;
    const firstLeafBrush = cm.leafs[base + LEAF_FIRST_BRUSH]!;
    const numLeafBrushes = cm.leafs[base + LEAF_NUM_BRUSHES]!;

    for (let k = 0; k < numLeafBrushes; k++) {
        const brushnum = cm.leafBrushes[firstLeafBrush + k]!;

        if (cm.brushCheckcount[brushnum] === cm.checkcount) continue;
        cm.brushCheckcount[brushnum] = cm.checkcount;

        if ((cm.brushContents[brushnum]! & tw.contents) === 0) continue;

        testBoxInBrush(cm, brushnum);
        if (tw.trace.allsolid) return;
    }
}

/* ------------------------------------------------------------------ *
 * CM_BoxLeafnums_r -- used only by the position test
 * ------------------------------------------------------------------ */

let leafCount = 0;
let leafOverflowed = false;

function boxLeafnumsR(cm: ClipMap, nodenum: number): void {
    for (;;) {
        if (nodenum < 0) {
            if (leafCount >= MAX_POSITION_LEAFS) {
                leafOverflowed = true;
                return;
            }
            positionLeafs[leafCount++] = -1 - nodenum;
            return;
        }

        const n = nodenum * 9;
        const planeIndex = cm.nodes[n]!;
        const p = planeIndex * PLANE_STRIDE;

        const nx = cm.planes[p]!;
        const ny = cm.planes[p + 1]!;
        const nz = cm.planes[p + 2]!;
        const dist = cm.planes[p + 3]!;

        const s = boxOnPlaneSide(
            leafBoundsMin,
            leafBoundsMax,
            nx,
            ny,
            nz,
            dist,
            cm.planeSignbits[planeIndex]!,
            cm.planeTypes[planeIndex]!
        );

        if (s === 1) {
            nodenum = cm.nodes[n + 1]!;
        } else if (s === 2) {
            nodenum = cm.nodes[n + 2]!;
        } else {
            boxLeafnumsR(cm, cm.nodes[n + 1]!);
            nodenum = cm.nodes[n + 2]!;
        }
    }
}

/**
 * `BoxOnPlaneSide` from `q_math.c`: 1 = in front, 2 = behind, 3 = straddling.
 *
 * **The axial fast path is not an optimisation.** It uses `<=` and `>=` against
 * the box extents, where the general path compares accumulated dot products with
 * `>=` and `<`. Those disagree exactly on the boundary -- a box whose face lies
 * precisely on an axial plane is "in front" under the fast path and "straddling"
 * under the general one.
 *
 * Leaving it out was a real bug, and one the trace differential suite could not
 * see: `BoxOnPlaneSide` is reached only from `CM_PositionTest`, which runs only
 * when `start == end`, and randomised sweeps never generate that. It surfaced in
 * the *pmove* suite instead, as a crouched player failing to stand up --
 * `PM_CheckDuck` tests headroom with exactly such a degenerate trace.
 */
function boxOnPlaneSide(
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    nx: number,
    ny: number,
    nz: number,
    dist: number,
    signbits: number,
    type: number
): number {
    // Fast axial cases.
    if (type < 3) {
        if (dist <= mins[type]!) return 1;
        if (dist >= maxs[type]!) return 2;
        return 3;
    }

    let dist1: number;
    let dist2: number;

    switch (signbits) {
        case 0:
            dist1 = v3_dot(nx, ny, nz, maxs[0]!, maxs[1]!, maxs[2]!);
            dist2 = v3_dot(nx, ny, nz, mins[0]!, mins[1]!, mins[2]!);
            break;
        case 1:
            dist1 = v3_dot(nx, ny, nz, mins[0]!, maxs[1]!, maxs[2]!);
            dist2 = v3_dot(nx, ny, nz, maxs[0]!, mins[1]!, mins[2]!);
            break;
        case 2:
            dist1 = v3_dot(nx, ny, nz, maxs[0]!, mins[1]!, maxs[2]!);
            dist2 = v3_dot(nx, ny, nz, mins[0]!, maxs[1]!, mins[2]!);
            break;
        case 3:
            dist1 = v3_dot(nx, ny, nz, mins[0]!, mins[1]!, maxs[2]!);
            dist2 = v3_dot(nx, ny, nz, maxs[0]!, maxs[1]!, mins[2]!);
            break;
        case 4:
            dist1 = v3_dot(nx, ny, nz, maxs[0]!, maxs[1]!, mins[2]!);
            dist2 = v3_dot(nx, ny, nz, mins[0]!, mins[1]!, maxs[2]!);
            break;
        case 5:
            dist1 = v3_dot(nx, ny, nz, mins[0]!, maxs[1]!, mins[2]!);
            dist2 = v3_dot(nx, ny, nz, maxs[0]!, mins[1]!, maxs[2]!);
            break;
        case 6:
            dist1 = v3_dot(nx, ny, nz, maxs[0]!, mins[1]!, mins[2]!);
            dist2 = v3_dot(nx, ny, nz, mins[0]!, maxs[1]!, maxs[2]!);
            break;
        case 7:
            dist1 = v3_dot(nx, ny, nz, mins[0]!, mins[1]!, mins[2]!);
            dist2 = v3_dot(nx, ny, nz, maxs[0]!, maxs[1]!, maxs[2]!);
            break;
        default:
            return 3;
    }

    let sides = 0;
    if (dist1 >= dist) sides = 1;
    if (dist2 < dist) sides |= 2;

    return sides;
}

/* ------------------------------------------------------------------ *
 * CM_PositionTest
 * ------------------------------------------------------------------ */

function positionTest(cm: ClipMap): void {
    for (let i = 0; i < 3; i++) {
        leafBoundsMin[i] = (tw.start[i]! + tw.sizeMin[i]!) - 1;
        leafBoundsMax[i] = (tw.start[i]! + tw.sizeMax[i]!) + 1;
    }

    leafCount = 0;
    leafOverflowed = false;

    cm.checkcount += 1;
    boxLeafnumsR(cm, 0);
    cm.checkcount += 1;

    for (let i = 0; i < leafCount; i++) {
        testInLeaf(cm, positionLeafs[i]!);
        if (tw.trace.allsolid) break;
    }

    void leafOverflowed;
}

/* ------------------------------------------------------------------ *
 * CM_TraceThroughTree
 * ------------------------------------------------------------------ */

function traceThroughTree(
    cm: ClipMap,
    num: number,
    p1f: number,
    p2f: number,
    p1x: number,
    p1y: number,
    p1z: number,
    p2x: number,
    p2y: number,
    p2z: number
): void {
    if (tw.trace.fraction <= p1f) return; // already hit something nearer

    if (num < 0) {
        traceThroughLeaf(cm, -1 - num);
        return;
    }

    const n = num * 9;
    const planeIndex = cm.nodes[n]!;
    const p = planeIndex * PLANE_STRIDE;
    const type = cm.planeTypes[planeIndex]!;

    const dist = cm.planes[p + 3]!;

    let t1: number;
    let t2: number;
    let offset: number;

    if (type < 3) {
        t1 = (type === 0 ? p1x : type === 1 ? p1y : p1z) - dist;
        t2 = (type === 0 ? p2x : type === 1 ? p2y : p2z) - dist;
        offset = tw.extents[type]!;
    } else {
        const nx = cm.planes[p]!;
        const ny = cm.planes[p + 1]!;
        const nz = cm.planes[p + 2]!;
        t1 = v3_dot(nx, ny, nz, p1x, p1y, p1z) - dist;
        t2 = v3_dot(nx, ny, nz, p2x, p2y, p2z) - dist;
        // "this is silly" -- id's own comment. Preserved because the value
        // participates in the branch below.
        offset = tw.isPoint ? 0 : 2048;
    }

    if (t1 >= offset + 1 && t2 >= offset + 1) {
        traceThroughTree(cm, cm.nodes[n + 1]!, p1f, p2f, p1x, p1y, p1z, p2x, p2y, p2z);
        return;
    }
    if (t1 < -offset - 1 && t2 < -offset - 1) {
        traceThroughTree(cm, cm.nodes[n + 2]!, p1f, p2f, p1x, p1y, p1z, p2x, p2y, p2z);
        return;
    }

    let side: number;
    let frac: number;
    let frac2: number;

    // Put the crosspoint SURFACE_CLIP_EPSILON on the near side.
    if (t1 < t2) {
        const idist = 1.0 / (t1 - t2);
        side = 1;
        frac2 = (t1 + offset + SURFACE_CLIP_EPSILON) * idist;
        frac = (t1 - offset + SURFACE_CLIP_EPSILON) * idist;
    } else if (t1 > t2) {
        const idist = 1.0 / (t1 - t2);
        side = 0;
        frac2 = (t1 - offset - SURFACE_CLIP_EPSILON) * idist;
        frac = (t1 + offset + SURFACE_CLIP_EPSILON) * idist;
    } else {
        side = 0;
        frac = 1;
        frac2 = 0;
    }

    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;

    let midf = p1f + (p2f - p1f) * frac;
    let midx = p1x + frac * (p2x - p1x);
    let midy = p1y + frac * (p2y - p1y);
    let midz = p1z + frac * (p2z - p1z);

    traceThroughTree(
        cm,
        cm.nodes[n + 1 + side]!,
        p1f,
        midf,
        p1x,
        p1y,
        p1z,
        midx,
        midy,
        midz
    );

    if (frac2 < 0) frac2 = 0;
    if (frac2 > 1) frac2 = 1;

    midf = p1f + (p2f - p1f) * frac2;
    midx = p1x + frac2 * (p2x - p1x);
    midy = p1y + frac2 * (p2y - p1y);
    midz = p1z + frac2 * (p2z - p1z);

    traceThroughTree(
        cm,
        cm.nodes[n + 1 + (side ^ 1)]!,
        midf,
        p2f,
        midx,
        midy,
        midz,
        p2x,
        p2y,
        p2z
    );
}

/* ------------------------------------------------------------------ *
 * CM_Trace / CM_BoxTrace
 * ------------------------------------------------------------------ */

/**
 * `CM_BoxTrace`.
 *
 * `model` is a submodel index; 0 means the world and takes the tree walk, any
 * other value tests that submodel's brush list directly, as `CM_ClipHandleToModel`
 * arranges in the C.
 */
/**
 * Set up the shared trace workspace for one sweep.
 *
 * Lifted out of `boxTrace` verbatim so `traceBrushList` can reuse it, and the
 * arithmetic is unchanged by the move -- the differential suite compares
 * `boxTrace` against the C and this is the code it was comparing.
 */
function setupTraceWork(
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushmask: number
): void {
    tw.trace.allsolid = false;
    tw.trace.startsolid = false;
    tw.trace.fraction = 1;
    tw.trace.endpos[0] = 0;
    tw.trace.endpos[1] = 0;
    tw.trace.endpos[2] = 0;
    tw.trace.planeNormal[0] = 0;
    tw.trace.planeNormal[1] = 0;
    tw.trace.planeNormal[2] = 0;
    tw.trace.planeDist = 0;
    tw.trace.surfaceFlags = 0;
    tw.trace.contents = 0;
    tw.trace.entityNum = 0;

    tw.contents = brushmask;

    /*
     Recentre so mins and maxs are symmetric about the trace point. The C
     comment says this "avoids some complications with plane expanding of
     rotated bmodels"; the consequence here is that `tw.start` is *not* the
     caller's start, and the final endpos has to be regenerated from the
     original.
    */
    for (let i = 0; i < 3; i++) {
        const offset = (mins[i]! + maxs[i]!) * 0.5;
        tw.sizeMin[i] = mins[i]! - offset;
        tw.sizeMax[i] = maxs[i]! - offset;
        tw.start[i] = start[i]! + offset;
        tw.end[i] = end[i]! + offset;
    }

    tw.maxOffset = (tw.sizeMax[0]! + tw.sizeMax[1]!) + tw.sizeMax[2]!;

    // offsets[signbits] = vector to the appropriate corner from the origin.
    const o = tw.offsets;
    const n0 = tw.sizeMin;
    const n1 = tw.sizeMax;

    o[0] = n0[0]!;  o[1] = n0[1]!;  o[2] = n0[2]!;
    o[3] = n1[0]!;  o[4] = n0[1]!;  o[5] = n0[2]!;
    o[6] = n0[0]!;  o[7] = n1[1]!;  o[8] = n0[2]!;
    o[9] = n1[0]!;  o[10] = n1[1]!; o[11] = n0[2]!;
    o[12] = n0[0]!; o[13] = n0[1]!; o[14] = n1[2]!;
    o[15] = n1[0]!; o[16] = n0[1]!; o[17] = n1[2]!;
    o[18] = n0[0]!; o[19] = n1[1]!; o[20] = n1[2]!;
    o[21] = n1[0]!; o[22] = n1[1]!; o[23] = n1[2]!;

    for (let i = 0; i < 3; i++) {
        if (tw.start[i]! < tw.end[i]!) {
            tw.boundsMin[i] = tw.start[i]! + tw.sizeMin[i]!;
            tw.boundsMax[i] = tw.end[i]! + tw.sizeMax[i]!;
        } else {
            tw.boundsMin[i] = tw.end[i]! + tw.sizeMin[i]!;
            tw.boundsMax[i] = tw.start[i]! + tw.sizeMax[i]!;
        }
    }
}

/** The `isPoint`/`extents` half, which only a swept trace needs. */
function setupSweepExtents(): void {
    if (tw.sizeMin[0] === 0 && tw.sizeMin[1] === 0 && tw.sizeMin[2] === 0) {
        tw.isPoint = true;
        tw.extents[0] = 0;
        tw.extents[1] = 0;
        tw.extents[2] = 0;
    } else {
        tw.isPoint = false;
        tw.extents[0] = tw.sizeMax[0]!;
        tw.extents[1] = tw.sizeMax[1]!;
        tw.extents[2] = tw.sizeMax[2]!;
    }
}

/** Regenerate `endpos` from the caller's original, unrecentred start and end. */
function finishTrace(
    out: TraceResult,
    start: ArrayLike<number>,
    end: ArrayLike<number>
): void {
    if (tw.trace.fraction === 1) {
        tw.trace.endpos[0] = end[0]!;
        tw.trace.endpos[1] = end[1]!;
        tw.trace.endpos[2] = end[2]!;
    } else {
        for (let i = 0; i < 3; i++) {
            tw.trace.endpos[i] = start[i]! + (tw.trace.fraction * (end[i]! - start[i]!));
        }
    }

    copyTrace(out, tw.trace);
}

/**
 * `CM_TraceThroughBrush` over an explicit list of brushes, and nothing else.
 *
 * The physics backend needs this. meep's `shape_cast` answers "which body, and
 * how far"; *which face of that body the contact belongs to* is a Q3 rule, and
 * the rule is not "the plane with the greatest entry fraction" -- it is that,
 * **plus** the leave-fraction test that decides whether the brush blocks the
 * sweep at all. Re-deriving only the first half means every brush the box merely
 * passes near contributes a candidate plane, so a player walking along a floor
 * gets handed the floor's normal for a horizontal move. `PM_SlideMove` clips
 * against it, achieves nothing, retries, accumulates a second plane, and clamps
 * the player's velocity to the line where the two meet. The symptom is an
 * invisible obstacle you can slide along and not cross.
 *
 * Running the ported brush test instead makes the answer identical to the
 * clipmap's by construction rather than by careful re-reading -- which is what
 * D-030 claimed and did not deliver.
 *
 * @param brushes brush indices to test; duplicates are harmless.
 */
export function traceBrushList(
    out: TraceResult,
    cm: ClipMap,
    brushes: ArrayLike<number>,
    count: number,
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushmask: number
): void {
    cm.checkcount += 1;

    setupTraceWork(start, end, mins, maxs, brushmask);
    setupSweepExtents();

    for (let i = 0; i < count; i++) {
        const brushnum = brushes[i]!;
        if (brushnum < 0 || brushnum >= cm.numBrushes) continue;

        if (cm.brushCheckcount[brushnum] === cm.checkcount) continue;
        cm.brushCheckcount[brushnum] = cm.checkcount;

        if ((cm.brushContents[brushnum]! & tw.contents) === 0) continue;

        traceThroughBrush(cm, brushnum);
        if (tw.trace.fraction === 0) break;
    }

    finishTrace(out, start, end);
}

/**
 * `CM_TraceThroughBrush` against a plane set that is not in the clipmap.
 *
 * A patch facet is a convex volume with no brush behind it -- see
 * `patchHull.ts` -- so the rule that picks its contact plane cannot be reached
 * by brush index. The arithmetic below is `traceThroughBrush`'s, line for line,
 * with three substitutions: the planes come from the argument rather than
 * `cm.planes`, the signbits are computed here rather than looked up, and the
 * contents and surface flags are the hull's rather than the brush's.
 *
 * It is a transcription of a transcription, which is not free, and the
 * alternative was worse. Leaving patch facets out of the rule entirely is not
 * "slightly less accurate": a player resting against a column would have the
 * contact answered by the *floor* they are also touching, the floor does not
 * block a horizontal move, and the move would be allowed straight into the
 * column. The facets have to be in the same comparison as the brushes.
 *
 * **No bevel planes.** `CM_TraceThroughBrush` expands each plane outward by the
 * box's extent along that normal, which is exact per plane and too generous
 * where two of them meet at an angle; q3map2 compensates by giving every brush
 * six axial sides, and `CM_AddFacetBevels` does the same for patch facets. This
 * has neither, so a box is stopped slightly early at a facet's edges. Measured
 * against `oa_dm1`'s brushes with their redundant sides removed -- the same
 * shortfall -- every one of 58 disagreements in 4,800 sweeps was in this
 * direction, and none the other. Blocking early is the failure that keeps
 * players out of walls; the reverse would put them inside one.
 */
function traceThroughPlanes(
    planes: Float32Array,
    contents: number,
    surfaceFlags: number
): void {
    const numsides = planes.length / PLANE_STRIDE;
    if (numsides === 0) return;

    let enterFrac = -1.0;
    let leaveFrac = 1.0;
    let clipplane = -1;
    let hasLeadside = false;

    let getout = false;
    let startout = false;

    const sx = tw.start[0];
    const sy = tw.start[1];
    const sz = tw.start[2];
    const ex = tw.end[0];
    const ey = tw.end[1];
    const ez = tw.end[2];

    for (let i = 0; i < numsides; i++) {
        const p = i * PLANE_STRIDE;

        const nx = planes[p]!;
        const ny = planes[p + 1]!;
        const nz = planes[p + 2]!;

        // Adjust the plane distance appropriately for mins/maxs. `SetPlaneSignbits`
        // is one bit per negative component; the clipmap caches it per plane and
        // a facet's planes are not in the clipmap, so it is derived here.
        let signbits = 0;
        if (nx < 0) signbits |= 1;
        if (ny < 0) signbits |= 2;
        if (nz < 0) signbits |= 4;
        const sb = signbits * 3;

        const dist = planes[p + 3]! - v3_dot(tw.offsets[sb]!, tw.offsets[sb + 1]!, tw.offsets[sb + 2]!, nx, ny, nz);

        const d1 = v3_dot(sx, sy, sz, nx, ny, nz) - dist;
        const d2 = v3_dot(ex, ey, ez, nx, ny, nz) - dist;

        if (d2 > 0) getout = true; // endpoint is not in solid
        if (d1 > 0) startout = true;

        // Completely in front of face -- no intersection with the entire volume.
        if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return;

        // Doesn't cross the plane -- the plane isn't relevant.
        if (d1 <= 0 && d2 <= 0) continue;

        if (d1 > d2) {
            // enter
            let f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2);
            if (f < 0) f = 0;
            if (f > enterFrac) {
                enterFrac = f;
                clipplane = p;
                hasLeadside = true;
            }
        } else {
            // leave
            let f = (d1 + SURFACE_CLIP_EPSILON) / (d1 - d2);
            if (f > 1) f = 1;
            if (f < leaveFrac) leaveFrac = f;
        }
    }

    // All planes checked and the trace was not completely outside the volume.
    if (!startout) {
        // Original point was inside.
        tw.trace.startsolid = true;
        if (!getout) {
            tw.trace.allsolid = true;
            tw.trace.fraction = 0;
            tw.trace.contents = contents;
        }
        return;
    }

    if (enterFrac < leaveFrac) {
        if (enterFrac > -1 && enterFrac < tw.trace.fraction) {
            if (enterFrac < 0) enterFrac = 0;
            tw.trace.fraction = enterFrac;
            if (clipplane !== -1) {
                tw.trace.planeNormal[0] = planes[clipplane]!;
                tw.trace.planeNormal[1] = planes[clipplane + 1]!;
                tw.trace.planeNormal[2] = planes[clipplane + 2]!;
                tw.trace.planeDist = planes[clipplane + 3]!;
            }
            if (hasLeadside) {
                /*
                 One shader across a whole facet, so unlike a brush there is no
                 per-side lookup to do -- see `BrushHull.surfaceFlags`. This is
                 what makes footsteps on a curved floor sound like the curve
                 rather than like default stone.
                */
                tw.trace.surfaceFlags = surfaceFlags;
            }
            tw.trace.contents = contents;
        }
    }
}

/**
 * `CM_TraceThroughBrush` over an explicit list of hulls, brush-backed or not.
 *
 * The list form of `traceBrushList`, and the reason it exists is that the two
 * kinds have to be ruled on *together*. Q3 tests every brush in a leaf and
 * takes the latest entry plane over the whole set; running the brushes as one
 * set and the patch facets as another gives two answers and no rule for
 * choosing between them, which is exactly the tie-breaking-by-arrival-order bug
 * `gatherHulls` was written to avoid.
 *
 * @param hulls hulls to test; duplicates and `undefined` entries are harmless.
 */
export function traceHullList(
    out: TraceResult,
    cm: ClipMap,
    hulls: ArrayLike<BrushHull | undefined>,
    count: number,
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushmask: number
): void {
    cm.checkcount += 1;

    setupTraceWork(start, end, mins, maxs, brushmask);
    setupSweepExtents();

    for (let i = 0; i < count; i++) {
        const hull = hulls[i];
        if (hull === undefined) continue;

        if ((hull.contents & tw.contents) === 0) continue;

        if (hull.brush >= 0) {
            if (hull.brush >= cm.numBrushes) continue;

            // The `checkcount` de-duplication the C uses. Facets have no slot in
            // it, and need none: `traceThroughPlanes` is a pure function of the
            // sweep and the planes, so testing one twice costs time and changes
            // nothing.
            if (cm.brushCheckcount[hull.brush] === cm.checkcount) continue;
            cm.brushCheckcount[hull.brush] = cm.checkcount;

            traceThroughBrush(cm, hull.brush);
        } else {
            traceThroughPlanes(hull.planes, hull.contents, hull.surfaceFlags);
        }

        if (tw.trace.fraction === 0) break;
    }

    finishTrace(out, start, end);
}

export function boxTrace(
    out: TraceResult,
    cm: ClipMap,
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushmask: number,
    model = 0
): void {
    cm.checkcount += 1;

    setupTraceWork(start, end, mins, maxs, brushmask);

    if (cm.numNodes === 0) {
        copyTrace(out, tw.trace);
        return;
    }

    if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) {
        // Position test.
        if (model !== 0) {
            testSubmodel(cm, model);
        } else {
            positionTest(cm);
        }
    } else {
        setupSweepExtents();

        if (model !== 0) {
            traceSubmodel(cm, model);
        } else {
            traceThroughTree(
                cm,
                0,
                0,
                1,
                tw.start[0]!,
                tw.start[1]!,
                tw.start[2]!,
                tw.end[0]!,
                tw.end[1]!,
                tw.end[2]!
            );
        }
    }

    finishTrace(out, start, end);
}

/** A submodel has its own brush list rather than a place in the tree. */
function traceSubmodel(cm: ClipMap, model: number): void {
    const m = cm.models[model];
    if (m === undefined) return;

    for (const brushnum of m.leafBrushes) {
        if (cm.brushCheckcount[brushnum] === cm.checkcount) continue;
        cm.brushCheckcount[brushnum] = cm.checkcount;

        if ((cm.brushContents[brushnum]! & tw.contents) === 0) continue;

        traceThroughBrush(cm, brushnum);
        if (tw.trace.fraction === 0) return;
    }
}

function testSubmodel(cm: ClipMap, model: number): void {
    const m = cm.models[model];
    if (m === undefined) return;

    for (const brushnum of m.leafBrushes) {
        if (cm.brushCheckcount[brushnum] === cm.checkcount) continue;
        cm.brushCheckcount[brushnum] = cm.checkcount;

        if ((cm.brushContents[brushnum]! & tw.contents) === 0) continue;

        testBoxInBrush(cm, brushnum);
        if (tw.trace.allsolid) return;
    }
}

function copyTrace(dst: TraceResult, src: TraceResult): void {
    dst.allsolid = src.allsolid;
    dst.startsolid = src.startsolid;
    dst.fraction = src.fraction;
    dst.endpos[0] = src.endpos[0];
    dst.endpos[1] = src.endpos[1];
    dst.endpos[2] = src.endpos[2];
    dst.planeNormal[0] = src.planeNormal[0];
    dst.planeNormal[1] = src.planeNormal[1];
    dst.planeNormal[2] = src.planeNormal[2];
    dst.planeDist = src.planeDist;
    dst.surfaceFlags = src.surfaceFlags;
    dst.contents = src.contents;
    dst.entityNum = src.entityNum;
}

/* ------------------------------------------------------------------ *
 * CM_PointContents -- cm_test.c
 * ------------------------------------------------------------------ */

/** `CM_PointLeafnum_r`. */
function pointLeafnum(cm: ClipMap, px: number, py: number, pz: number): number {
    let num = 0;

    while (num >= 0) {
        const n = num * 9;
        const planeIndex = cm.nodes[n]!;
        const p = planeIndex * PLANE_STRIDE;
        const type = cm.planeTypes[planeIndex]!;
        const dist = cm.planes[p + 3]!;

        let d: number;
        if (type < 3) {
            d = (type === 0 ? px : type === 1 ? py : pz) - dist;
        } else {
            d = v3_dot(cm.planes[p]!, cm.planes[p + 1]!, cm.planes[p + 2]!, px, py, pz) - dist;
        }

        num = d < 0 ? cm.nodes[n + 2]! : cm.nodes[n + 1]!;
    }

    return -1 - num;
}

/**
 * `CM_PointContents`.
 *
 * Note the C's own quirk, preserved here: for the world it finds the leaf and
 * ORs the contents of every brush the point is inside; for a submodel it walks
 * that submodel's brush list.
 */
export function pointContents(
    cm: ClipMap,
    px: number,
    py: number,
    pz: number,
    model = 0
): number {
    if (cm.numNodes === 0) return 0;

    let brushList: Int32Array;
    let count: number;
    let base: number;

    if (model !== 0) {
        const m = cm.models[model];
        if (m === undefined) return 0;
        brushList = m.leafBrushes;
        count = brushList.length;
        base = 0;
    } else {
        const leaf = pointLeafnum(cm, px, py, pz);
        const l = leaf * 12;
        base = cm.leafs[l + LEAF_FIRST_BRUSH]!;
        count = cm.leafs[l + LEAF_NUM_BRUSHES]!;
        brushList = cm.leafBrushes;
    }

    let contents = 0;

    for (let k = 0; k < count; k++) {
        const brushnum = model !== 0 ? brushList[k]! : brushList[base + k]!;
        const numsides = cm.brushes[brushnum * 3 + 1]!;
        const firstSide = cm.brushes[brushnum * 3]!;

        // See if the point is inside every side of the brush.
        let i = 0;
        for (; i < numsides; i++) {
            const sideIndex = firstSide + i;
            const planeIndex = cm.brushSides[sideIndex * 2]!;
            const p = planeIndex * PLANE_STRIDE;

            const d = v3_dot(cm.planes[p]!, cm.planes[p + 1]!, cm.planes[p + 2]!, px, py, pz) -
                cm.planes[p + 3]!;

            if (d > 0) break;
        }

        if (i === numsides) {
            contents |= cm.brushContents[brushnum]!;
        }
    }

    return contents;
}

export { CONTENTS };
