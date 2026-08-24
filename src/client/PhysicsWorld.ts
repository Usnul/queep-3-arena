/*
 * PhysicsWorld.ts -- the level's collision, as meep physics bodies.
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
 * Every Q3 brush becomes one static `RigidBody` with a `ConvexHullShape3D`
 * collider. The conversion is lossless (see `brushHull.ts`), so the *volumes*
 * are Q3's exactly; what changes is that queries against them are meep's
 * narrowphase rather than a ported `cm_trace`.
 *
 * This module also provides the `pm->trace` implementation `bg_pmove` calls,
 * built on `shape_cast`. That is the seam: pmove's algorithm is untouched --
 * the acceleration, the plane-clipping, the step logic, all of which is where
 * strafe jumping lives -- and only the question "what does this box hit" is
 * answered differently.
 *
 * Bodies live in **meep space** (metres, Y up) because that is where the
 * physics broadphase and the renderer both are; the trace adaptor converts at
 * its own boundary so pmove keeps its Q3 units. See DECISIONS.md D-029.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { shape_cast } from '@woosh/meep-engine/src/engine/physics/queries/shape_cast.js';
import { overlap_shape } from '@woosh/meep-engine/src/engine/physics/queries/overlap_shape.js';
import { PhysicsSurfacePoint } from '@woosh/meep-engine/src/engine/physics/queries/PhysicsSurfacePoint.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';
import { BoxShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/BoxShape3D.js';

import { ClipMap, MASK_PLAYERSOLID, SURFACE_CLIP_EPSILON } from '../q3/cm/ClipMap.ts';
import { buildHulls, type BrushHull } from '../q3/cm/brushHull.ts';
import type { TraceResult } from '../q3/cm/trace.ts';

/** Scene units per Q3 unit. */
const WORLD_SCALE = 1 / 32;
const INV_WORLD_SCALE = 32;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/** Identity rotation; every level body is axis-aligned in world space. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Corrective type for assigning a concrete shape to `Collider.shape`.
 *
 * `AbstractShape3D` declares `equals<T extends AbstractShape3D>(other: T)`,
 * while every concrete subclass declares `equals(other: ThatSubclass)`. The
 * narrowed parameter makes the subclass method incompatible with the base
 * signature, so **no concrete shape is assignable to `AbstractShape3D`** and
 * `collider.shape = new BoxShape3D(...)` is a type error -- for every shape in
 * the hierarchy, against the only field that consumes them.
 *
 * The runtime is fine; this is purely the generated declarations. Corrected with
 * a narrow local type rather than `any`, per the brief. See GAP-012.
 */
type ColliderWithShape = { shape: unknown; friction: number; restitution: number };

export interface PhysicsWorldStats {
    readonly brushes: number;
    readonly bodies: number;
    readonly skipped: number;
    readonly hullMilliseconds: number;
    readonly bodyMilliseconds: number;
}

export class PhysicsWorld {
    readonly system: PhysicsSystem;
    readonly stats: PhysicsWorldStats;

    /** Reused query output; `shape_cast` is an output-parameter API. */
    private readonly hit = new PhysicsSurfacePoint();

    /**
     * Player-box shapes, cached by half-extent.
     *
     * pmove calls `trace` with a handful of distinct boxes -- standing,
     * crouched, and the zero-size point box for bullets -- and building a
     * `BoxShape3D` per call would allocate ten times a frame.
     */
    private readonly boxCache = new Map<string, BoxShape3D>();

    /** Scratch for `overlap_shape`; only the count is used. */
    private readonly overlaps = new Uint32Array(64);

    /** Entity id -> the brush it came from, for contact-plane selection. */
    private readonly hullByEntity = new Map<number, BrushHull>();

    /** Packed body id -> the same, for `overlap_shape` results. */
    private readonly hullByBody = new Map<number, BrushHull>();

    constructor(ecd: EcsDataset, cm: ClipMap) {
        this.system = new PhysicsSystem();

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(RigidBody)) ecd.registerComponentType(RigidBody);
        if (!ecd.isComponentTypeRegistered(Collider)) ecd.registerComponentType(Collider);

        const set = buildHulls(cm, MASK_PLAYERSOLID);

        const t0 = performance.now();
        let bodies = 0;

        for (const hull of set.hulls) {
            if (this.addStaticHull(ecd, hull)) bodies += 1;
        }

        this.stats = {
            brushes: cm.numBrushes,
            bodies,
            skipped: set.skipped,
            hullMilliseconds: set.milliseconds,
            bodyMilliseconds: performance.now() - t0,
        };
    }

    /**
     * One brush -> one static body.
     *
     * The hull is built around its own centroid and the body is placed there,
     * rather than leaving the vertices in world space with the body at the
     * origin. A convex shape's support function and its AABB are both computed
     * in the body's local frame, so a hull whose vertices sit 2,000 units from
     * its own origin gets a bounding volume 2,000 units across and the
     * broadphase stops discriminating.
     */
    private addStaticHull(ecd: EcsDataset, hull: BrushHull): boolean {
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
         The axis swap has determinant +1, so winding is preserved and the
         indices stay as `brushHull` produced them -- outward CCW, which is what
         `ConvexHullShape3D.from` requires.
        */
        let shape: ConvexHullShape3D;
        try {
            shape = ConvexHullShape3D.from(local, hull.indices);
        } catch {
            // Degenerate hulls exist in shipped maps; one should not abort a load.
            return false;
        }

        const body = new RigidBody();
        body.kind = BodyKind.Static;

        const collider = new Collider() as unknown as ColliderWithShape;
        collider.shape = shape;
        // Q3 surfaces have no friction model; movement friction is entirely
        // `PM_Friction`. Leaving the physics friction at zero keeps the two from
        // fighting each other.
        collider.friction = 0;
        collider.restitution = 0;

        const transform = new Transform();
        transform.position.set(cx * WORLD_SCALE, cz * WORLD_SCALE, -cy * WORLD_SCALE);

        new Entity().add(transform).add(body).add(collider as unknown as Collider).build(ecd);

        return true;
    }

    /**
     * The player box, grown by twice the surface epsilon.
     *
     * `overlap_shape` answers "which bodies does this shape intersect", and a
     * player standing correctly is *not* intersecting anything -- Q3's epsilon
     * keeps a 1/8 unit gap between the box and every surface it rests on. Asking
     * with the exact box therefore returns nothing at precisely the moment the
     * answer is needed. Inflating it by the gap turns "touching" into
     * "overlapping" so the neighbouring brushes at a corner are found.
     */
    private inflatedBoxShape(
        mins: ArrayLike<number>,
        maxs: ArrayLike<number>
    ): BoxShape3D {
        const grow = SURFACE_CLIP_EPSILON * 2;
        const hx = Math.max(1e-4, ((maxs[0]! - mins[0]!) * 0.5 + grow) * WORLD_SCALE);
        const hy = Math.max(1e-4, ((maxs[2]! - mins[2]!) * 0.5 + grow) * WORLD_SCALE);
        const hz = Math.max(1e-4, ((maxs[1]! - mins[1]!) * 0.5 + grow) * WORLD_SCALE);

        const key = `i${hx},${hy},${hz}`;
        let shape = this.boxCache.get(key);

        if (shape === undefined) {
            shape = BoxShape3D.from(hx, hy, hz);
            this.boxCache.set(key, shape);
        }

        return shape;
    }

    private boxShape(mins: ArrayLike<number>, maxs: ArrayLike<number>): BoxShape3D {
        // Half-extents in meep axes: Q3 x -> x, Q3 z -> y, Q3 y -> z.
        const hx = Math.max(1e-4, (maxs[0]! - mins[0]!) * 0.5 * WORLD_SCALE);
        const hy = Math.max(1e-4, (maxs[2]! - mins[2]!) * 0.5 * WORLD_SCALE);
        const hz = Math.max(1e-4, (maxs[1]! - mins[1]!) * 0.5 * WORLD_SCALE);

        const key = `${hx},${hy},${hz}`;
        let shape = this.boxCache.get(key);

        if (shape === undefined) {
            shape = BoxShape3D.from(hx, hy, hz);
            this.boxCache.set(key, shape);
        }

        return shape;
    }


    /**
     * Choose the contact plane the way Q3 would, given the body meep hit.
     *
     * `shape_cast` answers "which body, and how far". *Which face* of that body
     * the contact belongs to is a different question, and the two engines answer
     * it differently: EPA returns the minimum-penetration axis, while
     * `CM_TraceThroughBrush` returns the **latest entering plane** -- the last
     * one the box crosses on its way in.
     *
     * At a flat wall they agree. At a corner they do not, and the disagreement
     * is not cosmetic: measured, `shape_cast` returned `[0, 1, 0]` where Q3
     * returned `[-1, 0, 0]` for a player pressed into a corner. `PM_SlideMove`
     * clipped velocity against the wrong plane, added a contradictory one on the
     * retry, and after two frames hit its five-plane limit and zeroed the
     * player's velocity -- the player simply stopped, wedged, a metre from the
     * corner.
     *
     * So the plane is re-derived here using Q3's rule against the hit brush's
     * own planes. meep's physics still does the spatial work; this restores the
     * one semantic that movement depends on.
     */
    private selectContactPlane(
        entity: number,
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>
    ): boolean {
        const hull = this.hullByEntity.get(entity);
        if (hull === undefined) return false;

        return this.planeFromHull(hull, out, startQ3, endQ3, minsQ3, maxsQ3, -Infinity) > -Infinity;
    }

    /**
     * Q3's latest-entering-plane rule over one brush.
     *
     * Returns the winning entry fraction, or `bestSoFar` unchanged if no plane
     * of this brush beats it. Writing the plane into `out` only when it wins
     * lets the caller run this across several brushes and keep the global best,
     * which is exactly what `CM_TraceThroughLeaf` does when several brushes
     * meet at a corner.
     */
    private planeFromHull(
        hull: BrushHull,
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        bestSoFar: number
    ): number {
        const planes = hull.planes;
        const count = planes.length / 4;
        if (count === 0) return bestSoFar;

        let bestFrac = bestSoFar;
        let bi = -1;

        for (let i = 0; i < count; i++) {
            const nx = planes[i * 4]!;
            const ny = planes[i * 4 + 1]!;
            const nz = planes[i * 4 + 2]!;

            // Expand the plane by the box, exactly as CM_TraceThroughBrush does:
            // offset by the box corner most opposed to the normal.
            const ox = nx < 0 ? maxsQ3[0]! : minsQ3[0]!;
            const oy = ny < 0 ? maxsQ3[1]! : minsQ3[1]!;
            const oz = nz < 0 ? maxsQ3[2]! : minsQ3[2]!;

            const dist = planes[i * 4 + 3]! - (ox * nx + oy * ny + oz * nz);

            const d1 = startQ3[0]! * nx + startQ3[1]! * ny + startQ3[2]! * nz - dist;
            const d2 = endQ3[0]! * nx + endQ3[1]! * ny + endQ3[2]! * nz - dist;

            // Never entered through this plane.
            if (d1 <= 0 && d2 <= 0) continue;
            if (d1 <= d2) continue;

            const f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2);
            if (f > bestFrac) {
                bestFrac = f;
                bi = i;
            }
        }

        if (bi === -1) return bestSoFar;

        out.planeNormal[0] = planes[bi * 4]!;
        out.planeNormal[1] = planes[bi * 4 + 1]!;
        out.planeNormal[2] = planes[bi * 4 + 2]!;
        out.planeDist = planes[bi * 4 + 3]!;

        return bestFrac;
    }

    /**
     * The same rule, across every brush the box is touching.
     *
     * At a corner where two brushes meet, both are blockers at `t = 0` and
     * meep's cast returns whichever it reached first -- a tie it has no reason
     * to break the way Q3 does. `CM_TraceThroughLeaf` tests every brush in the
     * leaf and keeps the greatest entry fraction, so the candidates are gathered
     * here and the same comparison applied. Without this, a player pressed into
     * a corner gets the side wall's normal instead of the front wall's, slides
     * the wrong way, and wedges.
     */
    private selectContactPlaneMulti(
        primaryEntity: number,
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        sx: number,
        sy: number,
        sz: number,
        shape: BoxShape3D
    ): boolean {
        let best = -Infinity;

        const primary = this.hullByEntity.get(primaryEntity);
        if (primary !== undefined) {
            best = this.planeFromHull(primary, out, startQ3, endQ3, minsQ3, maxsQ3, best);
        }

        const found = overlap_shape(
            this.system,
            this.inflatedBoxShape(minsQ3, maxsQ3) as unknown as never,
            { x: sx, y: sy, z: sz },
            NO_ROTATION,
            this.overlaps,
            0
        );

        for (let i = 0; i < found && i < this.overlaps.length; i++) {
            const hull = this.hullByBody.get(this.overlaps[i]!);
            if (hull === undefined || hull === primary) continue;
            best = this.planeFromHull(hull, out, startQ3, endQ3, minsQ3, maxsQ3, best);
        }

        return best > -Infinity;
    }

    /**
     * `pm->trace` on meep's physics.
     *
     * Inputs and outputs are in **Q3 units and Q3 axes**, because that is what
     * `bg_pmove` speaks; the conversion happens here and nowhere else.
     *
     * Two behaviours have to be reproduced rather than inherited, because pmove
     * depends on them and `shape_cast` has its own conventions:
     *
     * - **`startsolid`.** With `skip_initial_overlaps = false`, `shape_cast`
     *   reports a hit at `t = 0` for a shape that already overlaps. pmove reads
     *   `startsolid` to decide whether to jitter out of geometry
     *   (`PM_CorrectAllSolid`), so a `t = 0` hit is reported as `startsolid`.
     * - **The recentred box.** Q3 boxes are asymmetric (`-24` below, `+32`
     *   above) and `CM_Trace` recentres them, tracing the *centre* and offsetting
     *   the result. A swept `BoxShape3D` is symmetric about its own origin, so
     *   the same offset is applied here.
     */
    trace(
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        _contentMask: number
    ): void {
        // Recentre, exactly as `CM_Trace` does.
        const ox = (minsQ3[0]! + maxsQ3[0]!) * 0.5;
        const oy = (minsQ3[1]! + maxsQ3[1]!) * 0.5;
        const oz = (minsQ3[2]! + maxsQ3[2]!) * 0.5;

        const sx = (startQ3[0]! + ox) * WORLD_SCALE;
        const sy = (startQ3[2]! + oz) * WORLD_SCALE;
        const sz = -(startQ3[1]! + oy) * WORLD_SCALE;

        const ex = (endQ3[0]! + ox) * WORLD_SCALE;
        const ey = (endQ3[2]! + oz) * WORLD_SCALE;
        const ez = -(endQ3[1]! + oy) * WORLD_SCALE;

        const dx = ex - sx;
        const dy = ey - sy;
        const dz = ez - sz;
        const length = Math.hypot(dx, dy, dz);

        out.allsolid = false;
        out.startsolid = false;
        out.fraction = 1;
        out.endpos[0] = endQ3[0]!;
        out.endpos[1] = endQ3[1]!;
        out.endpos[2] = endQ3[2]!;
        out.planeNormal[0] = 0;
        out.planeNormal[1] = 0;
        out.planeNormal[2] = 0;
        out.planeDist = 0;
        out.surfaceFlags = 0;
        out.contents = 0;
        out.entityNum = 1023;

        const shape = this.boxShape(minsQ3, maxsQ3);

        if (length < 1e-7) {
            // Position test. A zero-length sweep still has to answer "am I stuck
            // here", which pmove asks on every `PM_CheckDuck`.
            const ray = {
                origin_x: sx, origin_y: sy, origin_z: sz,
                direction_x: 0, direction_y: 1, direction_z: 0,
                tMax: 1e-5,
            };

            if (shape_cast(this.system, ray, shape, NO_ROTATION, this.hit, undefined, false)) {
                if (this.hit.t <= 1e-6) {
                    out.allsolid = true;
                    out.startsolid = true;
                    out.fraction = 0;
                    out.contents = 1;
                    out.entityNum = 1022;
                }
            }
            return;
        }

        const ray = {
            origin_x: sx, origin_y: sy, origin_z: sz,
            direction_x: dx / length, direction_y: dy / length, direction_z: dz / length,
            tMax: length,
        };

        if (!shape_cast(this.system, ray, shape, NO_ROTATION, this.hit, undefined, false)) {
            return;
        }

        /*
         Back the contact off by SURFACE_CLIP_EPSILON.

         This is the single most important tuning parameter of the physics
         swap, and it is not a fudge -- it is Q3's own behaviour. `CM_TraceThroughBrush`
         computes `f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2)`, so a Q3 trace
         always stops 1/8 unit short of the surface and a resting player floats
         in a 1/8 unit gap.

         `shape_cast` stops exactly at contact, which sounds better and is
         catastrophic: the player lands flush on the floor, that resting contact
         then blocks every subsequent sweep at `t = 0`, and the player freezes in
         place one frame after touching down. Measured before this line existed:
         bit-exact agreement for 9 frames of falling, then permanent divergence
         at the moment of landing.
        */
        const backoff = SURFACE_CLIP_EPSILON * WORLD_SCALE;
        const fraction = Math.min(1, Math.max(0, (this.hit.t - backoff) / length));

        if (this.hit.t <= backoff) {
            // Blocked where it stands.
            /*
             Blocked where it stands. Whether that is `startsolid` is a separate
             question, and one `shape_cast` cannot answer: it reports `t = 0`
             both for a box resting *on* a floor and for a box buried *in* one.

             Q3 draws the line precisely -- `CM_TraceThroughBrush` sets
             `startsolid` only when the start point is behind every plane of a
             brush, so touching a surface is not solid. `overlap_shape` asks
             exactly that question, so it is used rather than guessed at.

             The distinction matters: `startsolid` (and worse, `allsolid`) sends
             pmove into `PM_CorrectAllSolid`, which jitters the player a unit in
             each direction hunting for free space. That is right for being
             buried in geometry and wrong for standing on the ground.
            */
            const overlapping = overlap_shape(
                this.system,
                shape as unknown as never,
                { x: sx, y: sy, z: sz },
                NO_ROTATION,
                this.overlaps,
                0
            );

            /*
             Blocked where it stands, with a valid plane for `PM_SlideMove` to
             slide along, and `startsolid` set only if genuinely embedded.

             An attempt was made to be cleverer here. `CM_TraceThroughBrush`
             sets `startsolid` and returns *without touching `fraction`* when the
             sweep starts inside a brush but exits it, so letting the move
             complete looked like the faithful choice. Measured, it was eight
             times worse: hit/miss agreement fell from 88% to 10% and the player
             began tunnelling through walls.

             The reason is that Q3's early return is **per brush** -- the leaf's
             other brushes are still tested and can still stop the sweep. A
             whole-trace `fraction = 1` skips all of them. Recorded because the
             instrument caught a change that read as obviously correct.
            */
            out.startsolid = overlapping > 0;
            out.allsolid = false;
            out.fraction = 0;
            out.contents = 1;
            out.entityNum = 1022;
            out.endpos[0] = startQ3[0]!;
            out.endpos[1] = startQ3[1]!;
            out.endpos[2] = startQ3[2]!;

            if (
                !this.selectContactPlaneMulti(
                    this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3, sx, sy, sz, shape
                )
            ) {
                out.planeNormal[0] = this.hit.normal.x;
                out.planeNormal[1] = -this.hit.normal.z;
                out.planeNormal[2] = this.hit.normal.y;
            }
            return;
        }

        out.fraction = fraction;
        out.contents = 1;
        out.entityNum = 1022;

        for (let i = 0; i < 3; i++) {
            out.endpos[i] = startQ3[i]! + fraction * (endQ3[i]! - startQ3[i]!);
        }

        // meep normal (Y up) -> Q3 normal (Z up): the inverse axis swap.
        if (!this.selectContactPlane(this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3)) {
            out.planeNormal[0] = this.hit.normal.x;
            out.planeNormal[1] = -this.hit.normal.z;
            out.planeNormal[2] = this.hit.normal.y;
            out.planeDist =
                out.planeNormal[0] * out.endpos[0] +
                out.planeNormal[1] * out.endpos[1] +
                out.planeNormal[2] * out.endpos[2];
        }
    }

    /** Convert a Q3 point to meep space, for callers that need it. */
    static toMeep(q3: ArrayLike<number>): [number, number, number] {
        return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
    }

    static get scale(): number {
        return WORLD_SCALE;
    }

    static get inverseScale(): number {
        return INV_WORLD_SCALE;
    }
}
