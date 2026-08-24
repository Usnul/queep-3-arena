/*
 * entityClip.ts -- clip a trace against moving brush entities.
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
 * `SV_ClipMoveToEntities`, reduced to the case this port has: brush entities
 * that translate and never rotate. Q3's own general form is
 * `CM_TransformedBoxTrace`, which rotates the sweep into the entity's frame and
 * the resulting plane back out again; doors, plats and buttons all have zero
 * angles, so the transform degenerates to a subtraction and the plane needs no
 * correction.
 *
 * This exists for the ported-clipmap backend only. With meep's physics the
 * movers are kinematic bodies and `shape_cast` finds them without being asked,
 * which is one of the genuine wins of the swap -- the world trace and the
 * entity trace are the same query.
 */

import type { ClipMap } from './ClipMap.ts';
import { boxTrace, createTrace, type TraceResult } from './trace.ts';

export interface ClippedEntity {
    /** BSP submodel index; `model` in `boxTrace`. */
    readonly model: number;
    /** Current offset from the submodel's authored position, in Q3 units. */
    readonly origin: readonly number[];
}

/** Reused so a trace does not allocate; the clip loop is on the movement path. */
const scratch: TraceResult = createTrace();

/**
 * Clip `out` -- already the result of a world trace -- against every entity.
 *
 * Q3 keeps the *shortest* fraction across the world and all entities, and stops
 * early on `allsolid`. Entity numbers are set so pmove can tell what it is
 * standing on: a player riding a plat has `groundEntityNum` equal to that
 * entity, which is how Q3 knows to carry them along.
 */
export function clipToEntities(
    out: TraceResult,
    cm: ClipMap,
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    brushmask: number,
    entities: readonly ClippedEntity[]
): void {
    if (out.allsolid) return;

    for (const entity of entities) {
        if (out.fraction === 0) return;

        const ox = entity.origin[0] ?? 0;
        const oy = entity.origin[1] ?? 0;
        const oz = entity.origin[2] ?? 0;

        // Into the entity's frame. No rotation, so the plane comes back out
        // unchanged and only the endpoint has to be translated.
        const s0 = start[0]! - ox;
        const s1 = start[1]! - oy;
        const s2 = start[2]! - oz;
        const e0 = end[0]! - ox;
        const e1 = end[1]! - oy;
        const e2 = end[2]! - oz;

        boxTrace(scratch, cm, [s0, s1, s2], [e0, e1, e2], mins, maxs, brushmask, entity.model);

        if (scratch.allsolid || scratch.startsolid) {
            out.startsolid = true;
            if (scratch.allsolid) {
                out.allsolid = true;
                out.fraction = 0;
                out.entityNum = entity.model;
                return;
            }
        }

        if (scratch.fraction < out.fraction) {
            out.fraction = scratch.fraction;
            out.endpos[0] = scratch.endpos[0]! + ox;
            out.endpos[1] = scratch.endpos[1]! + oy;
            out.endpos[2] = scratch.endpos[2]! + oz;
            out.planeNormal[0] = scratch.planeNormal[0]!;
            out.planeNormal[1] = scratch.planeNormal[1]!;
            out.planeNormal[2] = scratch.planeNormal[2]!;
            /*
             The plane distance is measured in the entity's frame, so it has to
             be carried back out along the normal. Q3 does the same thing inside
             `CM_TransformedBoxTrace`; leaving it uncorrected gives pmove a plane
             that is parallel to the real one but in the wrong place, which
             `PM_SlideMove` turns into a player sliding along a surface that is
             not there.
            */
            out.planeDist =
                scratch.planeDist +
                scratch.planeNormal[0]! * ox +
                scratch.planeNormal[1]! * oy +
                scratch.planeNormal[2]! * oz;
            out.surfaceFlags = scratch.surfaceFlags;
            out.contents = scratch.contents;
            out.entityNum = entity.model;
        }
    }
}
