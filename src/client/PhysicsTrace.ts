/*
 * PhysicsTrace.ts -- `pm->trace`, answered by meep's physics.
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
 * Extracted from `PhysicsWorld` so the divergence harness measures *this* code
 * rather than a copy of it.
 *
 * The harness used to carry its own duplicate, deliberately, so that a mistake
 * in the coordinate conversion could not cancel itself out of the measurement.
 * That reasoning was thin -- the real independence comes from the bit-exact
 * clipmap control, which is a genuinely separate path -- and the duplication
 * cost real bugs twice. It hid the browser build running with no colliders at
 * all (D-036), and then it hid a contact-plane fix by reporting numbers for the
 * unfixed copy (D-061). Body *construction* still differs between the two --
 * one goes through the ECS, the other calls `link` directly -- because that is
 * a genuine environment difference. The query does not.
 *
 * Inputs and outputs are in **Q3 units and Q3 axes**, because that is what
 * `bg_pmove` speaks; the conversion happens here and nowhere else.
 */

import { shape_cast } from '@woosh/meep-engine/src/engine/physics/queries/shape_cast.js';
import { overlap_shape } from '@woosh/meep-engine/src/engine/physics/queries/overlap_shape.js';
import { PhysicsSurfacePoint } from '@woosh/meep-engine/src/engine/physics/queries/PhysicsSurfacePoint.js';
import { BoxShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/BoxShape3D.js';

import { ClipMap, MASK_PLAYERSOLID, SURFACE_CLIP_EPSILON } from '../q3/cm/ClipMap.ts';
import { traceBrushList, createTrace, type TraceResult } from '../q3/cm/trace.ts';
import type { BrushHull } from '../q3/cm/brushHull.ts';

/** Scene units per Q3 unit. */
const WORLD_SCALE = 1 / 32;

/** Identity rotation; every level body is axis-aligned in world space. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

export class PhysicsTrace {
    private readonly system: unknown;
    private readonly cm: ClipMap;

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

    /** Candidate brush indices handed to the ported per-brush trace. */
    private readonly brushScratch = new Int32Array(80);

    /** Reused output for that trace. */
    private readonly brushTrace: TraceResult = createTrace();

    /** Entity id -> the brush it came from, for contact-plane selection. */
    private readonly hullByEntity = new Map<number, BrushHull>();

    /** Packed body id -> the same, for `overlap_shape` results. */
    private readonly hullByBody = new Map<number, BrushHull>();

    constructor(system: unknown, cm: ClipMap) {
        this.system = system;
        this.cm = cm;
    }

    /** Record which brush a body came from, so its planes can be recovered. */
    register(entity: number, bodyId: number, hull: BrushHull): void {
        this.hullByEntity.set(entity, hull);
        this.hullByBody.set(bodyId, hull);
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
     */    /**
     * The contact plane Q3 would report, for the brushes this sweep is near.
     *
     * meep's `shape_cast` answers "which body, and how far". *Which face of that
     * body the contact belongs to* is a Q3 rule, and the rule is
     * `CM_TraceThroughBrush`: the plane the sweep enters latest, **among brushes
     * the sweep actually enters and leaves on the far side**.
     *
     * The first version of this re-derived only the first half -- greatest entry
     * fraction over a brush's planes -- and skipped the leave-fraction test that
     * decides whether the brush blocks at all. Every brush the box merely passed
     * near then contributed a candidate, and since a player is always standing
     * on a floor, the floor frequently won. pmove would clip a horizontal move
     * against a horizontal plane, achieve nothing, retry, accumulate a second
     * plane and clamp the player to the line where the two meet: an invisible
     * obstacle you can slide along and not cross.
     *
     * Running the ported trace makes the answer identical to the clipmap
     * backend's by construction, which is what D-030 claimed and did not do.
     *
     * @returns the blocking brush's fraction, or -1 when nothing blocks.
     */
    private contactPlane(
        primaryEntity: number,
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        sx: number,
        sy: number,
        sz: number,
        gatherNeighbours: boolean
    ): number {
        const cm = this.cm;
        if (cm === null) return -1;

        let count = 0;

        const primary = this.hullByEntity.get(primaryEntity);
        if (primary !== undefined) this.brushScratch[count++] = primary.brush;

        /*
         At a corner two brushes are both blockers and `shape_cast` returns
         whichever it reached first -- a tie it has no reason to break the way Q3
         does. `CM_TraceThroughLeaf` tests every brush in the leaf, so the
         neighbours are gathered and handed to the same comparison.
        */
        if (gatherNeighbours) {
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
                if (hull === undefined) continue;
                if (count >= this.brushScratch.length) break;
                this.brushScratch[count++] = hull.brush;
            }
        }

        if (count === 0) return -1;

        traceBrushList(
            this.brushTrace,
            cm,
            this.brushScratch,
            count,
            startQ3,
            endQ3,
            minsQ3,
            maxsQ3,
            MASK_PLAYERSOLID
        );

        if (this.brushTrace.fraction === 1 && !this.brushTrace.startsolid) return -1;

        out.planeNormal[0] = this.brushTrace.planeNormal[0]!;
        out.planeNormal[1] = this.brushTrace.planeNormal[1]!;
        out.planeNormal[2] = this.brushTrace.planeNormal[2]!;
        out.planeDist = this.brushTrace.planeDist;

        return this.brushTrace.fraction;
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
                this.contactPlane(
                    this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3, sx, sy, sz, true
                ) < 0
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

        /*
         The plane comes from the brush the sweep actually enters. Falling back
         to `shape_cast`'s own normal -- the minimum-penetration axis -- is
         GAP-012's wrong answer, so it is only used when no brush blocks at all,
         which means the two disagree about whether there is a contact.
        */
        if (
            this.contactPlane(
                this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3, sx, sy, sz, false
            ) < 0
        ) {
            out.planeNormal[0] = this.hit.normal.x;
            out.planeNormal[1] = -this.hit.normal.z;
            out.planeNormal[2] = this.hit.normal.y;
            out.planeDist =
                out.planeNormal[0] * out.endpos[0] +
                out.planeNormal[1] * out.endpos[1] +
                out.planeNormal[2] * out.endpos[2];
        }
    }
}
