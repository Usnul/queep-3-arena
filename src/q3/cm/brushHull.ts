/*
 * brushHull.ts -- turn Quake III brushes into convex hulls.
 *
 * Ported from the winding routines in ioquake3's `code/qcommon/cm_polylib.c`
 * (`BaseWindingForPlane`, `ChopWindingInPlace`).
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
 * meep's physics collides against shapes; Q3 stores its collision volumes as
 * *plane sets*. A brush is the intersection of its half-spaces, which is
 * exactly a convex polyhedron, so the conversion is lossless: same volume, same
 * faces, just expressed as vertices instead of planes.
 *
 * That matters for fidelity. The alternative -- building collision from the
 * render geometry -- would be wrong in both directions: Q3 maps carry
 * `playerclip` brushes that block movement and draw nothing, and detail brushes
 * that draw and do not block. Using the brushes keeps both behaviours.
 *
 * The method is `cm_polylib.c`'s: start each face as a huge quad lying on its
 * plane, then clip it against every other plane of the brush. What survives is
 * that face's polygon, already wound correctly.
 */

import { ClipMap, PLANE_STRIDE } from './ClipMap.ts';

/** `MAX_MAP_BOUNDS` in cm_polylib.c -- the initial quad is this big. */
const MAX_MAP_BOUNDS = 1024 * 1024;

/** Winding chop epsilon, as `CM_ChopWindingInPlace` is called with. */
const CHOP_EPSILON = 0.1;

/**
 * Vertices closer than this are treated as the same point.
 *
 * Q3 planes are stored as float32 and a brush corner is computed independently
 * on each of the three faces meeting there, so the three results differ in the
 * last bits. Without welding, a six-sided box yields 24 vertices instead of 8
 * and the hull's support function gets a cloud of near-duplicates.
 */
const WELD_EPSILON = 0.01;

const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_ON = 2;

export interface BrushHull {
    /**
     * Index of the brush this came from, in the clipmap it was built against.
     *
     * Carried so the contact-plane rule can be answered by the *ported*
     * `CM_TraceThroughBrush` rather than re-derived from `planes`. Re-deriving
     * it is how the physics backend ended up handing pmove the floor's normal
     * for a horizontal move -- see `traceBrushList`.
     */
    readonly brush: number;
    /** Flat `(x, y, z)` per vertex, in Q3 coordinates. */
    readonly vertices: Float32Array;
    /** Three indices per triangle, wound CCW as seen from outside. */
    readonly indices: Uint32Array;
    readonly contents: number;
    /** Axis-aligned bounds, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
    readonly bounds: Float32Array;
    /**
     * The brush's own planes, four floats each: outward normal then distance,
     * in Q3 coordinates.
     *
     * Carried alongside the triangles because the *plane set* is what Q3's
     * contact semantics are defined over. meep's narrowphase answers "which
     * body, and how far"; picking *which face* that contact belongs to is a Q3
     * rule, and it needs these. See `PhysicsWorld.trace`.
     */
    readonly planes: Float32Array;
}

/** `BaseWindingForPlane` -- a huge quad lying on the plane. */
function baseWinding(nx: number, ny: number, nz: number, dist: number): number[] {
    // Find the major axis.
    let max = -MAX_MAP_BOUNDS;
    let axis = -1;

    const a = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
    for (let i = 0; i < 3; i++) {
        if (a[i]! > max) {
            axis = i;
            max = a[i]!;
        }
    }

    if (axis === -1) return [];

    // An up vector that is not parallel to the normal.
    let ux = 0;
    let uy = 0;
    let uz = 0;
    if (axis === 0 || axis === 1) uz = 1;
    else ux = 1;

    // Make it perpendicular to the normal, then normalise.
    const d = ux * nx + uy * ny + uz * nz;
    ux -= d * nx;
    uy -= d * ny;
    uz -= d * nz;
    const ulen = Math.hypot(ux, uy, uz);
    if (ulen < 1e-9) return [];
    ux /= ulen;
    uy /= ulen;
    uz /= ulen;

    // Origin is the plane's closest point to the world origin.
    const ox = nx * dist;
    const oy = ny * dist;
    const oz = nz * dist;

    // right = up x normal
    const rx = uy * nz - uz * ny;
    const ry = uz * nx - ux * nz;
    const rz = ux * ny - uy * nx;

    const U = MAX_MAP_BOUNDS;

    return [
        ox - rx * U + ux * U, oy - ry * U + uy * U, oz - rz * U + uz * U,
        ox + rx * U + ux * U, oy + ry * U + uy * U, oz + rz * U + uz * U,
        ox + rx * U - ux * U, oy + ry * U - uy * U, oz + rz * U - uz * U,
        ox - rx * U - ux * U, oy - ry * U - uy * U, oz - rz * U - uz * U,
    ];
}

/**
 * `ChopWindingInPlace` -- clip a polygon against a plane, keeping the back side.
 *
 * Q3 clips against the *negated* plane when building a brush face, because a
 * brush's planes point outwards and the volume is behind all of them. Passing
 * the negated plane and keeping the front is the same thing; this keeps the
 * front, and callers negate.
 */
function chopWinding(
    points: number[],
    nx: number,
    ny: number,
    nz: number,
    dist: number
): number[] {
    const count = points.length / 3;
    if (count === 0) return points;

    const dists = new Float64Array(count + 1);
    const sides = new Int32Array(count + 1);
    let front = 0;
    let back = 0;

    for (let i = 0; i < count; i++) {
        const dot =
            points[i * 3]! * nx + points[i * 3 + 1]! * ny + points[i * 3 + 2]! * nz - dist;
        dists[i] = dot;

        if (dot > CHOP_EPSILON) {
            sides[i] = SIDE_FRONT;
            front += 1;
        } else if (dot < -CHOP_EPSILON) {
            sides[i] = SIDE_BACK;
            back += 1;
        } else {
            sides[i] = SIDE_ON;
        }
    }

    sides[count] = sides[0]!;
    dists[count] = dists[0]!;

    if (front === 0) return []; // entirely clipped away
    if (back === 0) return points; // entirely kept

    const out: number[] = [];

    for (let i = 0; i < count; i++) {
        const px = points[i * 3]!;
        const py = points[i * 3 + 1]!;
        const pz = points[i * 3 + 2]!;

        if (sides[i] === SIDE_ON) {
            out.push(px, py, pz);
            continue;
        }

        if (sides[i] === SIDE_FRONT) {
            out.push(px, py, pz);
        }

        if (sides[i + 1] === SIDE_ON || sides[i + 1] === sides[i]) continue;

        // Split point on the edge to the next vertex.
        const j = (i + 1) % count;
        const qx = points[j * 3]!;
        const qy = points[j * 3 + 1]!;
        const qz = points[j * 3 + 2]!;

        const t = dists[i]! / (dists[i]! - dists[i + 1]!);

        // The C snaps to the plane on axial normals to avoid round-off; the same
        // trick keeps axis-aligned brush corners exactly on their planes, which
        // matters because most Q3 geometry is axial.
        out.push(
            nx === 1 ? dist : nx === -1 ? -dist : px + t * (qx - px),
            ny === 1 ? dist : ny === -1 ? -dist : py + t * (qy - py),
            nz === 1 ? dist : nz === -1 ? -dist : pz + t * (qz - pz)
        );
    }

    return out;
}

/**
 * Build a convex hull for one brush.
 *
 * Returns `null` for brushes that produce no usable geometry -- degenerate
 * brushes exist in shipped maps, and one of them should not abort a level load.
 */
export function brushToHull(cm: ClipMap, brushIndex: number): BrushHull | null {
    const firstSide = cm.brushes[brushIndex * 3]!;
    const numSides = cm.brushes[brushIndex * 3 + 1]!;

    if (numSides < 4) return null;

    const vertices: number[] = [];
    const indices: number[] = [];
    const planes: number[] = [];

    /** Weld a point into the vertex list, returning its index. */
    const addVertex = (x: number, y: number, z: number): number => {
        for (let i = 0; i < vertices.length; i += 3) {
            if (
                Math.abs(vertices[i]! - x) < WELD_EPSILON &&
                Math.abs(vertices[i + 1]! - y) < WELD_EPSILON &&
                Math.abs(vertices[i + 2]! - z) < WELD_EPSILON
            ) {
                return i / 3;
            }
        }
        vertices.push(x, y, z);
        return vertices.length / 3 - 1;
    };

    for (let s = 0; s < numSides; s++) {
        const planeIndex = cm.brushSides[(firstSide + s) * 2]!;
        const p = planeIndex * PLANE_STRIDE;

        const nx = cm.planes[p]!;
        const ny = cm.planes[p + 1]!;
        const nz = cm.planes[p + 2]!;
        const dist = cm.planes[p + 3]!;

        let winding = baseWinding(nx, ny, nz, dist);
        if (winding.length === 0) continue;

        // Clip against every other side. Brush planes face outwards and the
        // solid is behind all of them, so each clip keeps the half-space behind
        // the other plane -- hence the negation.
        for (let o = 0; o < numSides && winding.length > 0; o++) {
            if (o === s) continue;

            const op = cm.brushSides[(firstSide + o) * 2]!;
            const q = op * PLANE_STRIDE;

            winding = chopWinding(
                winding,
                -cm.planes[q]!,
                -cm.planes[q + 1]!,
                -cm.planes[q + 2]!,
                -cm.planes[q + 3]!
            );
        }

        const pointCount = winding.length / 3;
        if (pointCount < 3) continue;

        // This side contributes a real face, so its plane is part of the hull.
        planes.push(nx, ny, nz, dist);

        const fan: number[] = [];
        for (let i = 0; i < pointCount; i++) {
            fan.push(addVertex(winding[i * 3]!, winding[i * 3 + 1]!, winding[i * 3 + 2]!));
        }

        /*
         Triangulate as a fan, **reversed**.

         `BaseWindingForPlane` builds its quad as `org -/+ right +/- up`, and
         working the cross product through gives `(p1-p0) x (p2-p1) = -4n` --
         the winding runs *clockwise* seen from outside the brush. Q3 never has
         to care because its own `WindingPlane` compensates by computing
         `CrossProduct(v2, v1)` instead of `v1 x v2`.

         `ConvexHullShape3D.from` documents that it wants outward CCW, so the
         emitted triangles are reversed here. Getting this wrong produces hulls
         that are inside-out: the shape is the right size and in the right place,
         and every collision answer is inverted.
        */
        for (let i = 1; i + 1 < pointCount; i++) {
            const a = fan[0]!;
            const b = fan[i]!;
            const c = fan[i + 1]!;
            // Skip degenerate triangles produced by welding.
            if (a === b || b === c || a === c) continue;
            indices.push(a, c, b);
        }
    }

    if (vertices.length < 12 || indices.length < 12) return null;

    const bounds = new Float32Array(6);
    bounds[0] = bounds[1] = bounds[2] = Infinity;
    bounds[3] = bounds[4] = bounds[5] = -Infinity;

    for (let i = 0; i < vertices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = vertices[i + k]!;
            if (v < bounds[k]!) bounds[k] = v;
            if (v > bounds[k + 3]!) bounds[k + 3] = v;
        }
    }

    return {
        brush: brushIndex,
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        contents: cm.brushContents[brushIndex]!,
        bounds,
        planes: new Float32Array(planes),
    };
}

export interface HullSet {
    readonly hulls: readonly BrushHull[];
    /** Brushes that produced no usable hull. */
    readonly skipped: number;
    readonly milliseconds: number;
}

/**
 * Convert every brush in a range that matches `contentMask`.
 *
 * Only solid-ish brushes are worth turning into physics bodies; triggers and
 * fog are gameplay volumes handled elsewhere.
 *
 * The range matters. The brush lump holds the world's brushes *and* every brush
 * entity's, and a submodel's brushes are a contiguous slice of it. Converting
 * all of them into static bodies -- which is what an unbounded loop does -- nails
 * every door permanently shut at its closed position, and does it silently:
 * the level looks right, and the door's geometry moves while its collision does
 * not.
 *
 * @param firstBrush first brush index, from the model lump.
 * @param numBrushes how many, or `-1` for "to the end".
 */
export function buildHulls(
    cm: ClipMap,
    contentMask: number,
    firstBrush = 0,
    numBrushes = -1
): HullSet {
    const t0 = performance.now();

    const hulls: BrushHull[] = [];
    let skipped = 0;

    const end = numBrushes < 0 ? cm.numBrushes : Math.min(cm.numBrushes, firstBrush + numBrushes);

    for (let i = firstBrush; i < end; i++) {
        if ((cm.brushContents[i]! & contentMask) === 0) continue;

        const hull = brushToHull(cm, i);
        if (hull === null) {
            skipped += 1;
            continue;
        }

        hulls.push(hull);
    }

    return { hulls, skipped, milliseconds: performance.now() - t0 };
}
