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

/**
 * How close to `t = 0` counts as "blocked where it stands", in metres.
 *
 * With the epsilon in the shape rather than in the answer, a contact at the
 * start of the sweep really is at zero; this is float noise, not a tuning knob.
 */
const CONTACT_TOLERANCE = 1e-7;

/** Identity rotation; every level body is axis-aligned in world space. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

export class PhysicsTrace {
    private readonly system: unknown;
    private readonly cm: ClipMap;

    /**
     * Entities every trace passes straight through.
     *
     * This is the level's collision. `pm->trace`, a bot's line of sight and an
     * item's drop to the floor all come through here, and none of them wants to
     * find a *character* or a missile -- the first is what `KinematicMover`'s own
     * sweep is for and the second is not a wall.
     *
     * It has to be a filter rather than a layer, because meep's queries consult
     * the callback and nothing else: `shape_cast` never looks at `layer`, `mask`
     * or the sensor flag. Leaving it out is not a subtle failure -- giving bots
     * bodies without it made every bot's line of sight terminate on its own
     * collider, so no bot ever saw the player again.
     */
    readonly ignored = new Set<number>();

    private readonly notIgnored = (entity: number): boolean => !this.ignored.has(entity);

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

    /** How many of those the last `gatherBrushes` filled. */
    private brushCount = 0;

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
     * The player box, optionally grown, in meep axes.
     *
     * @param grow extra half-extent on every side, in Q3 units.
     */
    private boxShape(
        mins: ArrayLike<number>,
        maxs: ArrayLike<number>,
        grow = 0
    ): BoxShape3D {
        // Half-extents in meep axes: Q3 x -> x, Q3 z -> y, Q3 y -> z.
        const hx = Math.max(1e-4, ((maxs[0]! - mins[0]!) * 0.5 + grow) * WORLD_SCALE);
        const hy = Math.max(1e-4, ((maxs[2]! - mins[2]!) * 0.5 + grow) * WORLD_SCALE);
        const hz = Math.max(1e-4, ((maxs[1]! - mins[1]!) * 0.5 + grow) * WORLD_SCALE);

        const key = `${grow}|${hx},${hy},${hz}`;
        let shape = this.boxCache.get(key);

        if (shape === undefined) {
            shape = BoxShape3D.from(hx, hy, hz);
            this.boxCache.set(key, shape);
        }

        return shape;
    }

    /**
     * The box `overlap_shape` has to be asked with, grown by twice the epsilon.
     *
     * `overlap_shape` answers "which bodies does this shape intersect", and a
     * player standing correctly is *not* intersecting anything -- Q3's epsilon
     * keeps a 1/8 unit gap between the box and every surface it rests on. Asking
     * with the exact box therefore returns nothing at precisely the moment the
     * answer is needed. Inflating it turns "touching" into "overlapping" so the
     * neighbouring brushes at a corner are found.
     */
    private inflatedBoxShape(mins: ArrayLike<number>, maxs: ArrayLike<number>): BoxShape3D {
        return this.boxShape(mins, maxs, SURFACE_CLIP_EPSILON * 2);
    }


    /**
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
     * @returns the fraction Q3's rule gives -- 1 when nothing here blocks the
     *          sweep at all -- or -1 when there was no brush to ask, which
     *          means a body whose hull was never registered.
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

        const count = this.gatherBrushes(primaryEntity, minsQ3, maxsQ3, sx, sy, sz, gatherNeighbours);
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

        out.planeNormal[0] = this.brushTrace.planeNormal[0]!;
        out.planeNormal[1] = this.brushTrace.planeNormal[1]!;
        out.planeNormal[2] = this.brushTrace.planeNormal[2]!;
        out.planeDist = this.brushTrace.planeDist;

        /*
         And Q3's solidity, which is the same function's other output and used
         to be thrown away.

         `CM_TraceThroughBrush` distinguishes three states: outside, which is an
         ordinary contact; `startsolid`, meaning the box began inside a brush
         but the sweep leaves it; and `allsolid`, meaning it began inside and
         never gets out. pmove treats the third as a call for help --
         `PM_GroundTrace` hands it to `PM_CorrectAllSolid`, which jitters the
         player a unit at a time until it finds free space.

         Hardcoding `allsolid = false` disabled that recovery, and the failure
         it produces is total rather than approximate. A trace that starts
         embedded returns fraction 0 with **no plane**, because Q3 sets no plane
         when the sweep never entered one. `PM_GroundTrace` then reads
         `normal[2] = 0 < MIN_WALK_NORMAL` and concludes the player is on a
         slope too steep to stand on; `PM_SlideMove` clips velocity against the
         zero vector, which does nothing, and gets fraction 0 again on the
         retry. The player stops -- permanently, in all three axes, including
         falling. Reported twice: a player stuck in an open corridor, and a bot
         apparently standing in mid-air against a wall. It was not standing on
         anything. It had stopped falling. See D-063.
        */
        out.startsolid = out.startsolid || this.brushTrace.startsolid;
        out.allsolid = out.allsolid || this.brushTrace.allsolid;

        return this.brushTrace.fraction;
    }

    /**
     * The brushes a sweep from this position could touch.
     *
     * `CM_TraceThroughLeaf` tests every brush in the leaf. `shape_cast` reports
     * one body, so the neighbours come from `overlap_shape` and the whole set
     * goes through the same comparison -- otherwise a tie at a corner is broken
     * by whichever body meep reached first, which is not Q3's rule.
     *
     * @returns how many entries of `brushScratch` are valid.
     */
    private gatherBrushes(
        primaryEntity: number,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        sx: number,
        sy: number,
        sz: number,
        gatherNeighbours: boolean
    ): number {
        let count = 0;

        const primary = this.hullByEntity.get(primaryEntity);
        if (primary !== undefined) this.brushScratch[count++] = primary.brush;

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

        this.brushCount = count;
        return count;
    }

    /**
     * Did the last `traceBrushList` already rule on the brush behind this body?
     *
     * `shape_cast` reports the nearest body; Q3 rules per brush over a whole
     * set. When Q3 has said a set does not block and `shape_cast` then names a
     * body from inside that same set, the two are not disagreeing about the
     * world -- they are answering different questions, and Q3's is the one
     * `bg_pmove` was written against.
     */
    private alreadyRuledOn(entity: number): boolean {
        const hull = this.hullByEntity.get(entity);
        if (hull === undefined) return false;

        for (let i = 0; i < this.brushCount; i++) {
            if (this.brushScratch[i] === hull.brush) return true;
        }

        return false;
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

        /*
         **The swept box carries Q3's epsilon.**

         `CM_TraceThroughBrush` does not stop the box where it touches a
         surface. It offsets every plane outward by `SURFACE_CLIP_EPSILON` --
         `f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2)` -- so a trace stops an
         eighth of a unit short, and a resting player floats in that gap. For a
         box against a plane, offsetting the plane by e is the same as growing
         the box by e, so the epsilon belongs in the shape.

         It used to be subtracted from the answer instead: sweep the exact box,
         then pull the contact back by `e / length`. That is the same thing only
         when the sweep *reaches* the surface. A move that ends a twentieth of a
         unit short of the floor does not reach it, so `shape_cast` correctly
         reported no hit at all -- and Q3 blocks that move, because its offset
         plane is already crossed.

         The consequence was that a falling player never landed. The last
         fraction of the fall was always unobstructed, so the move completed,
         the player ended up *below* Q3's resting height, and the next frame
         bounced them back up at the speed they arrived with. Measured on
         `oa_dm1`: the clipmap settles at z = -119.875 with zero velocity;
         this settled nowhere, oscillating forever at +/-78 units a second.

         Nobody saw a bouncing player, because the bounce is under a tenth of a
         unit and the camera is at eye height. What everybody saw was
         `groundEntityNum` stuck at `ENTITYNUM_NONE`, which is what
         `Character.legsFor` reads to choose `LEGS_JUMP` -- so every bot in the
         level stood with its legs tucked up, hovering. See D-064.
        */
        const shape = this.boxShape(minsQ3, maxsQ3, SURFACE_CLIP_EPSILON);

        if (length < 1e-7) {
            /*
             Position test: "am I stuck here", which pmove asks on every
             `PM_CheckDuck` and once per jitter step of `PM_CorrectAllSolid`.

             This used to sweep a hair with `shape_cast` and call any contact
             solid, which conflates *touching* a floor with being *buried* in
             one. That is fatal inside `PM_CorrectAllSolid` specifically: every
             position a standing player jitters to still touches the floor, so
             every one reads as solid, the search fails, and the recovery Q3
             provides for exactly this situation reports that there is no way
             out.

             `CM_TestBoxInBrush` is the function that draws the line, and over a
             zero-length sweep `CM_TraceThroughBrush` reduces to it exactly:
             `d1 === d2` for every plane, so a brush with any plane the box sits
             in front of is skipped, and one the box is behind on every plane
             sets `startsolid` and `allsolid` together. So it is run rather than
             approximated, over the brushes `overlap_shape` finds.
            */
            const cm = this.cm;
            const count = this.gatherBrushes(-1, minsQ3, maxsQ3, sx, sy, sz, true);

            if (cm !== null && count > 0) {
                traceBrushList(
                    this.brushTrace, cm, this.brushScratch, count,
                    startQ3, startQ3, minsQ3, maxsQ3, MASK_PLAYERSOLID
                );

                if (this.brushTrace.startsolid) {
                    out.startsolid = true;
                    out.allsolid = this.brushTrace.allsolid;
                    out.fraction = this.brushTrace.allsolid ? 0 : 1;
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

        if (!shape_cast(this.system, ray, shape, NO_ROTATION, this.hit, this.notIgnored, false)) {
            return;
        }

        /*
         Nothing is subtracted here, and that is the fix rather than an omission.

         Q3's `CM_TraceThroughBrush` computes `f = (d1 - SURFACE_CLIP_EPSILON) /
         (d1 - d2)`, so a Q3 trace always stops 1/8 unit short of the surface and
         a resting player floats in a 1/8 unit gap. `shape_cast` stops exactly at
         contact, which sounds better and is catastrophic: the player lands
         flush, that resting contact blocks every subsequent sweep at `t = 0`,
         and the player freezes one frame after touching down.

         The first version of this subtracted the epsilon from the fraction
         *here*. That is the same thing whenever the sweep reaches the surface
         and silently different when it stops just short -- a move ending a
         twentieth of a unit above the floor is blocked in Q3 and clear in
         `shape_cast`, so the player overshot the resting height, bounced back up
         at landing speed, and never landed at all. 63 of 64 dropped players
         never reached the ground, and because `groundEntityNum` stayed
         `ENTITYNUM_NONE` every bot in the level rendered with its legs tucked up.

         The epsilon is now in the *shape*: `boxShape` grows the swept box by
         `SURFACE_CLIP_EPSILON`, which for a box against a plane is exactly
         offsetting the plane outward by the same amount. See D-064.

         Worth knowing, and found only after this was written: meep's own
         `KinematicMover` takes exactly this as a `skin` constructor option,
         defaulting to 0.005 m. The standoff was never missing from the engine,
         only from the query layer this port builds on. GAP-020 asserted
         otherwise and is withdrawn; D-070 has the correction.
        */
        let fraction = Math.min(1, Math.max(0, this.hit.t / length));

        if (this.hit.t <= CONTACT_TOLERANCE) {
            out.contents = 1;
            out.entityNum = 1022;
            out.endpos[0] = startQ3[0]!;
            out.endpos[1] = startQ3[1]!;
            out.endpos[2] = startQ3[2]!;
            out.fraction = 0;

            /*
             `shape_cast` reports `t = 0` for a box resting *on* a floor, a box
             *touching* a wall it is sliding along, and a box *buried* in one.
             Q3 distinguishes all three and pmove behaves completely differently
             in each, so the ported brush test decides rather than a guess.
            */
            const q3 = this.contactPlane(
                this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3, sx, sy, sz, true
            );

            if (q3 < 0) {
                /*
                 No brush of ours answers for this contact -- a mover, or a body
                 whose hull was never registered. Fall back to `shape_cast`'s own
                 normal, which is GAP-012's wrong answer and the reason this is
                 the last resort rather than the first.
                */
                out.startsolid =
                    overlap_shape(
                        this.system,
                        this.boxShape(minsQ3, maxsQ3) as unknown as never,
                        { x: sx, y: sy, z: sz },
                        NO_ROTATION,
                        this.overlaps,
                        0
                    ) > 0;
                out.planeNormal[0] = this.hit.normal.x;
                out.planeNormal[1] = -this.hit.normal.z;
                out.planeNormal[2] = this.hit.normal.y;
                return;
            }

            // Buried, and the sweep never leaves. `PM_CorrectAllSolid`'s cue.
            if (out.allsolid) return;

            if (q3 < 1) {
                // An ordinary contact at zero distance: stop, with the plane.
                return;
            }

            /*
             Q3 says nothing here blocks, and `shape_cast` says otherwise only
             because the box begins in contact. Two situations reach this line
             and they need the same answer:

             - **Resting against a surface.** A player standing on a floor or
               pressed against a wall is one `SURFACE_CLIP_EPSILON` away from
               it, which is inside the backoff, so *every* sweep from that
               position -- including the ones running parallel to the surface or
               straight away from it -- comes back `t = 0`. Q3 skips a brush the
               box is entirely in front of and lets the move run.
             - **Leaving a brush it started inside.** `CM_TraceThroughBrush`
               sets `startsolid` and returns *without touching `fraction`*.
               `PM_StepSlideMove` depends on this: it probes a step height
               straight up from a position flush with the ground and reads the
               fraction to decide how far it may climb.

             Forcing `fraction = 0` for both is what froze a player mid-corridor
             and left a bot hanging in mid-air against a wall. Every move the
             player asked for was reported blocked by the wall they were already
             touching, `PM_SlideMove` clipped the velocity flat against it and
             got the same answer on the retry, and the step-up probe that would
             have rescued them came back blocked too. Velocity kept accumulating
             to 320 units a second against a position that never changed.

             An earlier version of this file did let the move complete here, as
             a whole-trace `fraction = 1`, and it was eight times worse --
             hit/miss agreement fell from 88% to 10% and the player tunnelled
             through walls -- because Q3's early return is per *brush* and the
             leaf's other brushes still get tested. That is the part to keep.
             The rest of the sweep is a real query, so it is asked as one:
             `skip_initial_overlaps` re-casts past the contact and finds
             whatever is genuinely in the way.
            */
            if (
                !shape_cast(this.system, ray, shape, NO_ROTATION, this.hit, this.notIgnored, true) ||
                (this.hit.t <= CONTACT_TOLERANCE && this.alreadyRuledOn(this.hit.entity))
            ) {
                /*
                 Nothing else is in the way -- or the only thing that is, is a
                 brush Q3 has already said does not block.

                 That second case is not hypothetical and it is not rare. A
                 player running along a wall touches two brushes at once, the
                 floor and the wall; skipping the initial overlap moves past one
                 of them and lands straight on the other, still at zero
                 distance. Clamping that to `fraction = 0` is what wedged a
                 player at full speed in an open corridor: velocity climbing to
                 320 units a second against a position that never changed,
                 because every frame reported the surface they were standing
                 next to as a wall in front of them.
                */
                out.fraction = 1;
                out.endpos[0] = endQ3[0]!;
                out.endpos[1] = endQ3[1]!;
                out.endpos[2] = endQ3[2]!;
                return;
            }

            fraction = Math.min(1, Math.max(0, this.hit.t / length));
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
        const q3 = this.contactPlane(
            this.hit.entity, out, startQ3, endQ3, minsQ3, maxsQ3, sx, sy, sz, false
        );

        // -1 is "no brush of ours covers that body"; 1 is "Q3 says nothing
        // blocks". Both mean there is no Q3 plane to report.
        if (q3 < 0 || q3 >= 1) {
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
