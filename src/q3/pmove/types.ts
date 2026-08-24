/*
 * types.ts -- playerState_t, usercmd_t and pmove_t.
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
 * Objects with `Float32Array` vectors rather than a flat typed-array struct.
 * The flat version would be faster and is what a shipping game would want; this
 * shape is chosen because the port has to be readable *next to the C* for the
 * differential test to be worth anything, and `ps.velocity[2] -= ...` reads the
 * same in both.
 *
 * Only the `playerState_t` fields pmove touches are here. The rest of the struct
 * is server and rendering state that phase 3 adds where it needs it.
 */

import { vec3, type Vec3 } from '../math.ts';
import {
    MAX_PS_EVENTS,
    MAX_STATS,
    MAX_PERSISTANT,
    MAX_POWERUPS,
    MAX_WEAPONS,
    ENTITYNUM_NONE,
} from './constants.ts';
import type { TraceResult } from '../cm/trace.ts';

export interface PlayerState {
    commandTime: number;
    pm_type: number;
    bobCycle: number;
    pm_flags: number;
    pm_time: number;

    origin: Vec3;
    velocity: Vec3;

    weaponTime: number;
    gravity: number;
    speed: number;
    /** `int[3]` -- added to command angles to get the view direction. */
    delta_angles: Int32Array;

    groundEntityNum: number;

    legsTimer: number;
    legsAnim: number;
    torsoTimer: number;
    torsoAnim: number;

    movementDir: number;

    grapplePoint: Vec3;

    eFlags: number;

    eventSequence: number;
    events: Int32Array;
    eventParms: Int32Array;

    externalEvent: number;
    externalEventParm: number;
    externalEventTime: number;

    clientNum: number;
    weapon: number;
    weaponstate: number;

    viewangles: Vec3;
    viewheight: number;

    damageEvent: number;
    damageYaw: number;
    damagePitch: number;
    damageCount: number;

    stats: Int32Array;
    persistant: Int32Array;
    powerups: Int32Array;
    ammo: Int32Array;

    generic1: number;
    loopSound: number;
    jumppad_ent: number;

    pmove_framecount: number;
    jumppad_frame: number;
    entityEventSequence: number;
}

export function createPlayerState(): PlayerState {
    return {
        commandTime: 0,
        pm_type: 0,
        bobCycle: 0,
        pm_flags: 0,
        pm_time: 0,
        origin: vec3(),
        velocity: vec3(),
        weaponTime: 0,
        gravity: 0,
        speed: 0,
        delta_angles: new Int32Array(3),
        groundEntityNum: ENTITYNUM_NONE,
        legsTimer: 0,
        legsAnim: 0,
        torsoTimer: 0,
        torsoAnim: 0,
        movementDir: 0,
        grapplePoint: vec3(),
        eFlags: 0,
        eventSequence: 0,
        events: new Int32Array(MAX_PS_EVENTS),
        eventParms: new Int32Array(MAX_PS_EVENTS),
        externalEvent: 0,
        externalEventParm: 0,
        externalEventTime: 0,
        clientNum: 0,
        weapon: 0,
        weaponstate: 0,
        viewangles: vec3(),
        viewheight: 0,
        damageEvent: 0,
        damageYaw: 0,
        damagePitch: 0,
        damageCount: 0,
        stats: new Int32Array(MAX_STATS),
        persistant: new Int32Array(MAX_PERSISTANT),
        powerups: new Int32Array(MAX_POWERUPS),
        ammo: new Int32Array(MAX_WEAPONS),
        generic1: 0,
        loopSound: 0,
        jumppad_ent: 0,
        pmove_framecount: 0,
        jumppad_frame: 0,
        entityEventSequence: 0,
    };
}

/**
 * `usercmd_t`.
 *
 * `angles` is `short[3]` in Q3 and the wrapping is load-bearing:
 * `PM_UpdateViewAngles` adds `delta_angles` and relies on 16-bit overflow to
 * make yaw circular. Stored as `Int16Array` so that wrapping happens by itself.
 *
 * `forwardmove`/`rightmove`/`upmove` are `signed char`, and pmove reads their
 * exact magnitude (`PM_CmdScale` divides by 127, `PM_CheckJump` tests `>= 10`),
 * so `Int8Array` rather than plain numbers.
 */
export interface UserCmd {
    serverTime: number;
    angles: Int16Array;
    buttons: number;
    weapon: number;
    /** Index 0 forwardmove, 1 rightmove, 2 upmove. */
    moves: Int8Array;
}

export function createUserCmd(): UserCmd {
    return {
        serverTime: 0,
        angles: new Int16Array(3),
        buttons: 0,
        weapon: 0,
        moves: new Int8Array(3),
    };
}

export const FORWARDMOVE = 0;
export const RIGHTMOVE = 1;
export const UPMOVE = 2;

/** `pmove_t`. The trace callbacks are how pmove reaches the world. */
export interface Pmove {
    ps: PlayerState;
    cmd: UserCmd;

    tracemask: number;
    debugLevel: number;
    noFootsteps: boolean;
    gauntletHit: boolean;

    framecount: number;

    numtouch: number;
    touchents: Int32Array;

    mins: Vec3;
    maxs: Vec3;

    watertype: number;
    waterlevel: number;

    xyspeed: number;

    pmove_fixed: number;
    pmove_msec: number;

    /** OpenArena: disables the per-frame velocity snap except on slick surfaces. */
    pmove_float: number;
    /** OpenArena: dmflags that reach movement (`DF_NO_BUNNY`, `DF_FAST_WATER_MOVE`). */
    pmove_flags: number;

    trace(
        results: TraceResult,
        start: ArrayLike<number>,
        mins: ArrayLike<number>,
        maxs: ArrayLike<number>,
        end: ArrayLike<number>,
        passEntityNum: number,
        contentMask: number
    ): void;

    pointcontents(point: ArrayLike<number>, passEntityNum: number): number;
}

/** `pml_t` -- pmove locals, cleared at the start of every `PmoveSingle`. */
export interface PmoveLocal {
    forward: Vec3;
    right: Vec3;
    up: Vec3;
    frametime: number;

    msec: number;

    walking: boolean;
    groundPlane: boolean;
    groundTrace: TraceResult;

    impactSpeed: number;

    previous_origin: Vec3;
    previous_velocity: Vec3;
    previous_waterlevel: number;
}
