/*
 * SurfaceMetadata.ts -- what a piece of level geometry is made of, on the body.
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
 * Quake III answers "does a bullet leave a mark here" out of the collision
 * trace: `CM_TraceThroughBrush` finds the side the sweep entered through and
 * reports that side's `surfaceFlags`, and `CG_MissileHitWall` tests
 * `SURF_NOIMPACT`. That is a sound design for an engine whose trace *is* the
 * brush walk, and this port kept it long after it stopped being one -- so the
 * shot path opened the clipmap for a question it was already holding a physics
 * body for, and the comment justifying that said a broadphase "has no opinion
 * about surface flags".
 *
 * **A broadphase has whatever opinion you attach to it.** meep bodies are
 * entities; an entity carries components; a component can carry the material
 * facts about the geometry that body was built from. So this rides beside
 * `RigidBody` and `Collider` on every piece of level collision, and anything
 * holding a cast result can ask it -- the weapons, the footsteps, the acoustics,
 * anything later. Nothing has to know that a BSP was involved.
 *
 * **Per side, because that is the honest granularity and it was free.** The
 * flags belong to a brush's *faces*, not to the brush: a box can be sky on top
 * and stone everywhere else. `BrushHull` now carries one value per plane, in
 * plane order, so {@link SurfaceMetadata.flagsFor} picks the face whose outward
 * normal best matches the contact normal. For a patch facet -- one shader across
 * the piece -- every entry is the same and the match cannot be wrong.
 *
 * See D-204, and `brushHull.ts` for the loop that used to throw this away.
 */

import type { BrushHull } from '../q3/cm/brushHull.ts';

/**
 * The material facts about one body's geometry.
 *
 * A plain class rather than an interface because it is a component: meep keys
 * components by their constructor, so the type has to exist at runtime.
 */
export class SurfaceMetadata {
    static readonly typeName = 'SurfaceMetadata';

    /** Q3 `CONTENTS_*` for the volume: solid, playerclip, lava, water. */
    contents = 0;

    /**
     * Outward plane per face, four floats each -- normal then distance.
     *
     * The hull's own, shared rather than copied: these are built once at load
     * and never written, and a level has tens of thousands of them.
     */
    planes: Float32Array = EMPTY_PLANES;

    /** Q3 `SURF_*` per face, in {@link planes} order. */
    sideFlags: Int32Array = EMPTY_FLAGS;

    static from(hull: BrushHull): SurfaceMetadata {
        const meta = new SurfaceMetadata();
        meta.contents = hull.contents;
        meta.planes = hull.planes;
        meta.sideFlags = hull.sideFlags;
        return meta;
    }

    /**
     * The flags of the face a contact with this normal belongs to.
     *
     * The normal is in **Q3 axes**, pointing out of the surface, which is what
     * every caller in this port already has: `TraceResult.planeNormal` is Q3's
     * and `PhysicsTrace` converts meep's before it gets here.
     *
     * Nearest by dot product rather than exact, because a contact normal is a
     * narrowphase result and a plane is authored data -- they agree to a few
     * ulps at best, and on a bevelled brush the contact can legitimately sit on
     * an edge between two faces. Picking the more aligned of the two is the same
     * answer Q3's `leadside` gives, which is the side the sweep *entered*
     * through.
     */
    flagsFor(nx: number, ny: number, nz: number): number {
        const planes = this.planes;
        const count = this.sideFlags.length;
        if (count === 0) return 0;

        let best = -Infinity;
        let at = 0;

        for (let i = 0; i < count; i++) {
            const p = i * 4;
            const dot = planes[p]! * nx + planes[p + 1]! * ny + planes[p + 2]! * nz;
            if (dot > best) {
                best = dot;
                at = i;
            }
        }

        return this.sideFlags[at]!;
    }

    /** Every face's flags, ORed. For a question that is about the volume. */
    get anyFlags(): number {
        let all = 0;
        for (let i = 0; i < this.sideFlags.length; i++) all |= this.sideFlags[i]!;
        return all;
    }
}

const EMPTY_PLANES = new Float32Array(0);
const EMPTY_FLAGS = new Int32Array(0);
