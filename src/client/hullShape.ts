/*
 * hullShape.ts -- one Quake III brush, as a meep collision shape.
 *
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Its own module rather than a private method, because three things build
 * bodies out of the same brushes and all three have to agree about where those
 * brushes are: `PhysicsWorld` for the browser, `HeadlessPhysics` for the
 * divergence harness, and `Acoustics.buildOccluderScene` for the offline probe
 * bake. It was written out three times before this, which is precisely the
 * arrangement D-036 records the cost of -- a harness that reports healthy
 * numbers for geometry the browser is not running, and a reverberation measured
 * in a room the runtime does not have.
 */

import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';

import type { BrushHull } from '../q3/cm/brushHull.ts';

/** Scene metres per Q3 unit. D-011: the simulation is unscaled, the scene is not. */
const WORLD_SCALE = 1 / 32;

/** A brush hull as meep geometry: a hull about its own centroid, and where that sits. */
export interface HullShape {
    readonly shape: ConvexHullShape3D;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/**
 * One Q3 brush -> one convex shape in scene metres, placed at its own centroid.
 *
 * The centroid is not cosmetic. A convex shape's support function and its AABB
 * are both computed in the body's local frame, so a hull left in world space
 * with its origin at the map's gets a bounding volume as big as the level, and
 * every broadphase over it -- physics or acoustic -- stops discriminating.
 *
 * Returns null for the degenerate brushes shipped maps contain; one of those
 * should not abort a load or a bake.
 */
export function hullShape(hull: BrushHull): HullShape | null {
    const cx = (hull.bounds[0]! + hull.bounds[3]!) * 0.5;
    const cy = (hull.bounds[1]! + hull.bounds[4]!) * 0.5;
    const cz = (hull.bounds[2]! + hull.bounds[5]!) * 0.5;

    const n = hull.vertices.length / 3;
    const local = new Float32Array(hull.vertices.length);

    for (let i = 0; i < n; i++) {
        // Q3 (x, y, z) -> meep (x, z, -y), scaled, relative to the centroid.
        local[i * 3] = (hull.vertices[i * 3]! - cx) * WORLD_SCALE;
        local[i * 3 + 1] = (hull.vertices[i * 3 + 2]! - cz) * WORLD_SCALE;
        local[i * 3 + 2] = -(hull.vertices[i * 3 + 1]! - cy) * WORLD_SCALE;
    }

    /*
     The axis swap has determinant +1, so winding is preserved and the indices
     stay as `brushHull` produced them -- outward CCW, which is what
     `ConvexHullShape3D.from` requires.
    */
    let shape: ConvexHullShape3D;
    try {
        shape = ConvexHullShape3D.from(local, hull.indices);
    } catch {
        return null;
    }

    return {
        shape,
        x: cx * WORLD_SCALE,
        y: cz * WORLD_SCALE,
        z: -cy * WORLD_SCALE,
    };
}
