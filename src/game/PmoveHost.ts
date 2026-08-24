/*
 * PmoveHost.ts -- one movement setup, shared by the player and every bot.
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
 * Extracted from `PlayerController` when bots needed the same thing. Sharing it
 * is not tidiness: a bot that moves through a *different* `pmove` setup is a bot
 * that plays a different game, and the difference would show up as bots taking
 * jumps the player cannot or failing ones the player can. In Q3 the bot and the
 * player go through the same `Pmove` with the same `pmove_t`, differing only in
 * who fills the `usercmd_t`, and that is the property worth preserving.
 *
 * The trace closure is the one place the two collision backends and the mover
 * entity clip are wired in, so every mover, every backend and every collision
 * decision reaches bots and the player identically.
 */

import { boxTrace, pointContents } from '../q3/cm/trace.ts';
import { clipToEntities, type ClippedEntity } from '../q3/cm/entityClip.ts';
import { MASK_PLAYERSOLID, type ClipMap } from '../q3/cm/ClipMap.ts';
import { vec3 } from '../q3/math.ts';
import { createPlayerState, createUserCmd, type Pmove } from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';
import type { TraceResult } from '../q3/cm/trace.ts';

/**
 * What a `pmove` host needs from a physics-backed trace.
 *
 * A structural type rather than an import of `PhysicsWorld`, so the simulation
 * side does not acquire a dependency on the presentation side just to be able
 * to swap collision backends.
 */
export interface PhysicsTraceBackend {
    trace(
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        contentMask: number
    ): void;
}

/** Brush entities the ported clipmap has to be clipped against. */
export interface MoverSource {
    readonly movers: readonly ClippedEntity[];
}

export interface PmoveHostOptions {
    readonly cm: ClipMap;
    readonly spawnQ3: readonly number[];
    readonly physics?: PhysicsTraceBackend | null;
    /**
     * Read on every trace rather than captured, because the mover list exists
     * only after the map's entities are spawned and the host is built before
     * that. Ignored on the physics backend, which sees movers as bodies.
     */
    readonly movers?: () => MoverSource | null;
    readonly startHealth?: number;
}

/**
 * Build a `pmove_t` for one entity.
 *
 * `G_SelectSpawnPoint` lifts a spawn by 9 units before placing a player, which
 * is what stops a spawn point flush with the floor spawning you inside it.
 */
export function createPmoveHost(options: PmoveHostOptions): Pmove {
    const { cm, spawnQ3, physics = null, movers, startHealth = 125 } = options;

    const ps = createPlayerState();
    ps.pm_type = C.PM_NORMAL;
    ps.gravity = 800;
    ps.speed = 320;
    ps.groundEntityNum = C.ENTITYNUM_NONE;
    ps.stats[C.STAT_HEALTH] = startHealth;
    ps.viewheight = C.DEFAULT_VIEWHEIGHT;
    ps.origin[0] = spawnQ3[0] ?? 0;
    ps.origin[1] = spawnQ3[1] ?? 0;
    ps.origin[2] = (spawnQ3[2] ?? 0) + 9;

    return {
        ps,
        cmd: createUserCmd(),
        tracemask: MASK_PLAYERSOLID,
        debugLevel: 0,
        noFootsteps: false,
        gauntletHit: false,
        framecount: 0,
        numtouch: 0,
        touchents: new Int32Array(C.MAXTOUCH),
        mins: vec3(),
        maxs: vec3(),
        watertype: 0,
        waterlevel: 0,
        xyspeed: 0,
        pmove_fixed: 0,
        pmove_msec: 8,
        pmove_float: 0,
        pmove_flags: 0,
        trace(results, start, mins, maxs, end, _passEnt, contentMask) {
            if (physics !== null) {
                // Movers are kinematic bodies, so `shape_cast` already includes
                // them -- world and entities are one query.
                physics.trace(results, start, end, mins, maxs, contentMask);
                return;
            }

            boxTrace(results, cm, start, end, mins, maxs, contentMask);
            results.entityNum =
                results.fraction !== 1.0 ? C.ENTITYNUM_WORLD : C.ENTITYNUM_NONE;

            const source = movers?.() ?? null;
            if (source !== null && source.movers.length > 0) {
                clipToEntities(results, cm, start, end, mins, maxs, contentMask, source.movers);
            }
        },
        pointcontents(point, _passEnt) {
            return pointContents(cm, point[0]!, point[1]!, point[2]!);
        },
    };
}
