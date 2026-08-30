/*
 * pmove.ts -- Quake III player movement.
 *
 * Ported from OpenArena's `code/game/bg_pmove.c` and `code/game/bg_slidemove.c`.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) OpenArena contributors
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * **This is the one file in the port where nothing may drift.** Strafe-jumping,
 * air control, ramp jumps and stair stepping are emergent from the exact
 * arithmetic here and in `cm/trace.ts`; the brief makes movement fidelity
 * non-negotiable and everything else replaceable, and this is the everything
 * else's foundation.
 *
 * So it is a transcription, not a reimplementation. Same function names, same
 * order, same branch structure, same epsilons, float32 arithmetic throughout
 * (DECISIONS.md D-019). Where the C looks wrong or redundant it is copied
 * anyway, with a comment saying so. `test/pmove.diff.test.ts` runs it against
 * the same code compiled to WebAssembly and demands they agree.
 *
 * What is **not** ported, and why:
 *
 * - `PM_Weapon`, `PM_BeginWeaponChange`, `PM_FinishWeaponChange`,
 *   `PM_TorsoAnimation`: weapon state machine and torso animation. They write
 *   `weaponTime`, `weaponstate` and `torsoAnim`, none of which feed back into
 *   position or velocity. Phase 3 needs them; movement does not. See D-022.
 * - `PM_GrappleMove`: OpenArena's grapple is off in deathmatch.
 * - Capsule traces: see D-018.
 */

import {
    f32,
    vec3,
    dot,
    copy,
    set,
    clear,
    add,
    subtract,
    scale as vscale,
    vectorMA,
    cross,
    length as vlength,
    normalize,
    normalize2,
    angleVectors,
    short2angle,
    snapVector,
    PITCH,
    type Vec3,
} from '../math.ts';

import { createTrace, type TraceResult } from '../cm/trace.ts';
import { CONTENTS, SURF, MASK_WATER } from '../cm/ClipMap.ts';
import type { Pmove, PmoveLocal, PlayerState } from './types.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from './types.ts';
import * as C from './constants.ts';

/* ------------------------------------------------------------------ *
 * Module state.
 *
 * `pm` and `pml` are file-scope globals in the C and are kept that way here.
 * Threading them through forty functions would obscure the correspondence with
 * the original for no benefit -- pmove is single-threaded and re-entrant only
 * through `Pmove` -> `PmoveSingle`.
 * ------------------------------------------------------------------ */

let pm: Pmove;

const pml: PmoveLocal = {
    forward: vec3(),
    right: vec3(),
    up: vec3(),
    frametime: 0,
    msec: 0,
    walking: false,
    groundPlane: false,
    groundTrace: createTrace(),
    impactSpeed: 0,
    previous_origin: vec3(),
    previous_velocity: vec3(),
    previous_waterlevel: 0,
};

/** Scratch vectors, hoisted so the movement path allocates nothing. */
const t_wishvel = vec3();
const t_wishdir = vec3();
const t_vec = vec3();
const t_point = vec3();
const t_end = vec3();
const t_up = vec3();
const t_down = vec3();
const t_start_o = vec3();
const t_start_v = vec3();
const t_primal_velocity = vec3();
const t_endVelocity = vec3();
const t_endClipVelocity = vec3();
const t_clipVelocity = vec3();
const t_dir = vec3();
const t_flatforward = vec3();
const t_spot = vec3();
const t_planes: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3()];

const t_trace = createTrace();
const t_trace2 = createTrace();

function resetLocals(): void {
    clear(pml.forward);
    clear(pml.right);
    clear(pml.up);
    pml.frametime = 0;
    pml.msec = 0;
    pml.walking = false;
    pml.groundPlane = false;
    pml.impactSpeed = 0;
    clear(pml.previous_origin);
    clear(pml.previous_velocity);
    pml.previous_waterlevel = 0;

    const g = pml.groundTrace;
    g.allsolid = false;
    g.startsolid = false;
    g.fraction = 1;
    g.endpos[0] = 0; g.endpos[1] = 0; g.endpos[2] = 0;
    g.planeNormal[0] = 0; g.planeNormal[1] = 0; g.planeNormal[2] = 0;
    g.planeDist = 0;
    g.surfaceFlags = 0;
    g.contents = 0;
    g.entityNum = 0;
}

/* ------------------------------------------------------------------ *
 * Events and touch list
 * ------------------------------------------------------------------ */

function PM_AddEvent(newEvent: number): void {
    BG_AddPredictableEventToPlayerstate(newEvent, 0, pm.ps);
}

/** `BG_AddPredictableEventToPlayerstate` from bg_misc.c. */
function BG_AddPredictableEventToPlayerstate(
    newEvent: number,
    eventParm: number,
    ps: PlayerState
): void {
    ps.events[ps.eventSequence & (C.MAX_PS_EVENTS - 1)] = newEvent;
    ps.eventParms[ps.eventSequence & (C.MAX_PS_EVENTS - 1)] = eventParm;
    ps.eventSequence += 1;
}

function PM_AddTouchEnt(entityNum: number): void {
    if (entityNum === C.ENTITYNUM_WORLD) return;
    if (pm.numtouch === C.MAXTOUCH) return;

    // See if it is already added.
    for (let i = 0; i < pm.numtouch; i++) {
        if (pm.touchents[i] === entityNum) return;
    }

    pm.touchents[pm.numtouch] = entityNum;
    pm.numtouch += 1;
}

/* ------------------------------------------------------------------ *
 * Animation helpers
 * ------------------------------------------------------------------ */

function PM_StartLegsAnim(anim: number): void {
    if (pm.ps.pm_type >= C.PM_DEAD) return;
    if (pm.ps.legsTimer > 0) return; // a high priority animation is running

    pm.ps.legsAnim = ((pm.ps.legsAnim & C.ANIM_TOGGLEBIT) ^ C.ANIM_TOGGLEBIT) | anim;
}

function PM_ContinueLegsAnim(anim: number): void {
    if ((pm.ps.legsAnim & ~C.ANIM_TOGGLEBIT) === anim) return;
    if (pm.ps.legsTimer > 0) return;

    PM_StartLegsAnim(anim);
}

function PM_ForceLegsAnim(anim: number): void {
    pm.ps.legsTimer = 0;
    PM_StartLegsAnim(anim);
}

/* ------------------------------------------------------------------ *
 * PM_ClipVelocity
 * ------------------------------------------------------------------ */

/**
 * Slide off a plane.
 *
 * Note the asymmetry: `backoff` is *multiplied* by `overbounce` when moving into
 * the plane and *divided* by it when moving away. `OVERCLIP` is 1.001, so this
 * pushes very slightly out of surfaces -- which is what stops a player sinking
 * into a floor over successive frames, and is part of why ramp jumps work.
 */
function PM_ClipVelocity(
    inVec: ArrayLike<number>,
    normal: ArrayLike<number>,
    out: Vec3,
    overbounce: number
): void {
    let backoff = dot(inVec, normal);

    if (backoff < 0) {
        backoff = f32(backoff * overbounce);
    } else {
        backoff = f32(backoff / overbounce);
    }

    for (let i = 0; i < 3; i++) {
        const change = f32(normal[i]! * backoff);
        out[i] = f32(inVec[i]! - change);
    }
}

/* ------------------------------------------------------------------ *
 * PM_Friction
 * ------------------------------------------------------------------ */

function PM_Friction(): void {
    const vel = pm.ps.velocity;

    copy(t_vec, vel);
    if (pml.walking) {
        t_vec[2] = 0; // ignore slope movement
    }

    const speed = vlength(t_vec);
    if (speed < 1) {
        vel[0] = 0;
        vel[1] = 0; // allow sinking underwater
        return;
    }

    let drop = 0;

    // Ground friction.
    if (pm.waterlevel <= 1) {
        if (pml.walking && (pml.groundTrace.surfaceFlags & SURF.SLICK) === 0) {
            // If getting knocked back, no friction.
            if ((pm.ps.pm_flags & C.PMF_TIME_KNOCKBACK) === 0) {
                const control = speed < C.pm_stopspeed ? C.pm_stopspeed : speed;
                drop = f32(drop + f32(f32(control * C.pm_friction) * pml.frametime));
            }
        }
    }

    // Water friction applies even when just wading.
    if (pm.waterlevel !== 0) {
        drop = f32(
            drop + f32(f32(f32(speed * C.pm_waterfriction) * pm.waterlevel) * pml.frametime)
        );
    }

    if (pm.ps.powerups[C.PW_FLIGHT] !== 0) {
        drop = f32(drop + f32(f32(speed * C.pm_flightfriction) * pml.frametime));
    }

    if (pm.ps.pm_type === C.PM_SPECTATOR) {
        drop = f32(drop + f32(f32(speed * C.pm_spectatorfriction) * pml.frametime));
    }

    let newspeed = f32(speed - drop);
    if (newspeed < 0) newspeed = 0;
    newspeed = f32(newspeed / speed);

    vel[0] = f32(vel[0]! * newspeed);
    vel[1] = f32(vel[1]! * newspeed);
    vel[2] = f32(vel[2]! * newspeed);
}

/* ------------------------------------------------------------------ *
 * PM_Accelerate
 * ------------------------------------------------------------------ */

/**
 * The Quake II style acceleration, which is what produces strafe jumping.
 *
 * `addspeed` is capped against `wishspeed`, but `currentspeed` is the projection
 * of the *existing* velocity onto `wishdir` -- so a player whose velocity is
 * nearly perpendicular to `wishdir` has a small `currentspeed` and gets the full
 * acceleration, on top of the speed they already had. That is the bug, and it is
 * the whole movement game.
 *
 * OpenArena's `DF_NO_BUNNY` branch is the "proper" formulation that removes it.
 * Both are ported because the differential test exercises both.
 */
function PM_Accelerate(wishdir: ArrayLike<number>, wishspeed: number, accel: number): void {
    if ((pm.pmove_flags & C.DF_NO_BUNNY) === 0) {
        const currentspeed = dot(pm.ps.velocity, wishdir);
        const addspeed = f32(wishspeed - currentspeed);
        if (addspeed <= 0) return;

        let accelspeed = f32(f32(accel * pml.frametime) * wishspeed);
        if (accelspeed > addspeed) accelspeed = addspeed;

        for (let i = 0; i < 3; i++) {
            pm.ps.velocity[i] = f32(pm.ps.velocity[i]! + f32(accelspeed * wishdir[i]!));
        }
    } else {
        const wishVelocity = t_vec;
        vscale(wishVelocity, wishdir, wishspeed);

        const pushDir = t_dir;
        subtract(pushDir, wishVelocity, pm.ps.velocity);
        const pushLen = normalize(pushDir);

        let canPush = f32(f32(accel * pml.frametime) * wishspeed);
        if (canPush > pushLen) canPush = pushLen;

        vectorMA(pm.ps.velocity, pm.ps.velocity, canPush, pushDir);
    }
}

/* ------------------------------------------------------------------ *
 * PM_CmdScale
 * ------------------------------------------------------------------ */

/**
 * Scale factor for the command's movement axes.
 *
 * This is what stops diagonal movement being sqrt(2) faster: the axes are
 * divided by the magnitude of the whole 3-vector rather than clamped
 * individually.
 */
function PM_CmdScale(moves: Int8Array): number {
    const fm = moves[FORWARDMOVE]!;
    const rm = moves[RIGHTMOVE]!;
    const um = moves[UPMOVE]!;

    let max = Math.abs(fm);
    if (Math.abs(rm) > max) max = Math.abs(rm);
    if (Math.abs(um) > max) max = Math.abs(um);
    if (max === 0) return 0;

    // The C computes `total` with a double `sqrt` into a `float`.
    const total = f32(Math.sqrt(fm * fm + rm * rm + um * um));

    /*
     `(float)pm->ps->speed * max / ( 127.0 * total )`.
     The numerator is a float-by-int multiply, so it rounds; 127.0 is a double
     literal, so the denominator is computed in double and the division rounds
     once more into the float result.
    */
    return f32(f32(pm.ps.speed * max) / (127.0 * total));
}

/* ------------------------------------------------------------------ *
 * PM_SetMovementDir
 * ------------------------------------------------------------------ */

function PM_SetMovementDir(): void {
    const fm = pm.cmd.moves[FORWARDMOVE]!;
    const rm = pm.cmd.moves[RIGHTMOVE]!;

    if (fm !== 0 || rm !== 0) {
        if (rm === 0 && fm > 0) {
            pm.ps.movementDir = 0;
        } else if (rm < 0 && fm > 0) {
            pm.ps.movementDir = 1;
        } else if (rm < 0 && fm === 0) {
            pm.ps.movementDir = 2;
        } else if (rm < 0 && fm < 0) {
            pm.ps.movementDir = 3;
        } else if (rm === 0 && fm < 0) {
            pm.ps.movementDir = 4;
        } else if (rm > 0 && fm < 0) {
            pm.ps.movementDir = 5;
        } else if (rm > 0 && fm === 0) {
            pm.ps.movementDir = 6;
        } else if (rm > 0 && fm > 0) {
            pm.ps.movementDir = 7;
        }
    } else {
        // If they aren't actively going directly sideways, change the animation
        // to the diagonal so they don't stop too crooked.
        if (pm.ps.movementDir === 2) {
            pm.ps.movementDir = 1;
        } else if (pm.ps.movementDir === 6) {
            pm.ps.movementDir = 7;
        }
    }
}

/* ------------------------------------------------------------------ *
 * PM_CheckJump
 * ------------------------------------------------------------------ */

function PM_CheckJump(): boolean {
    if ((pm.ps.pm_flags & C.PMF_RESPAWNED) !== 0) {
        return false; // don't allow jump until all buttons are up
    }

    if (pm.cmd.moves[UPMOVE]! < 10) {
        return false; // not holding jump
    }

    if ((pm.ps.pm_flags & C.PMF_JUMP_HELD) !== 0) {
        // Clear upmove so PM_CmdScale doesn't lower running speed.
        pm.cmd.moves[UPMOVE] = 0;
        return false;
    }

    pml.groundPlane = false; // jumping away
    pml.walking = false;
    pm.ps.pm_flags |= C.PMF_JUMP_HELD;

    pm.ps.groundEntityNum = C.ENTITYNUM_NONE;
    pm.ps.velocity[2] = C.JUMP_VELOCITY;
    PM_AddEvent(C.EV_JUMP);

    if (pm.cmd.moves[FORWARDMOVE]! >= 0) {
        PM_ForceLegsAnim(C.LEGS_JUMP);
        pm.ps.pm_flags &= ~C.PMF_BACKWARDS_JUMP;
    } else {
        PM_ForceLegsAnim(C.LEGS_JUMPB);
        pm.ps.pm_flags |= C.PMF_BACKWARDS_JUMP;
    }

    return true;
}

/* ------------------------------------------------------------------ *
 * Water
 * ------------------------------------------------------------------ */

function PM_CheckWaterJump(): boolean {
    if (pm.ps.pm_time !== 0) return false;
    if (pm.waterlevel !== 2) return false;

    t_flatforward[0] = pml.forward[0]!;
    t_flatforward[1] = pml.forward[1]!;
    t_flatforward[2] = 0;
    normalize(t_flatforward);

    vectorMA(t_spot, pm.ps.origin, 30, t_flatforward);
    t_spot[2] = f32(t_spot[2]! + 4);

    let cont = pm.pointcontents(t_spot, pm.ps.clientNum);
    if ((cont & CONTENTS.SOLID) === 0) return false;

    t_spot[2] = f32(t_spot[2]! + 16);
    cont = pm.pointcontents(t_spot, pm.ps.clientNum);
    if ((cont & (CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.BODY)) !== 0) {
        return false;
    }

    // Jump out of water.
    vscale(pm.ps.velocity, pml.forward, 200);
    pm.ps.velocity[2] = 350;

    pm.ps.pm_flags |= C.PMF_TIME_WATERJUMP;
    pm.ps.pm_time = 2000;

    return true;
}

function PM_WaterJumpMove(): void {
    // Waterjump has no control, but falls.
    PM_StepSlideMove(true);

    pm.ps.velocity[2] = f32(pm.ps.velocity[2]! - f32(pm.ps.gravity * pml.frametime));
    if (pm.ps.velocity[2]! < 0) {
        // Cancel as soon as we are falling down again.
        pm.ps.pm_flags &= ~C.PMF_ALL_TIMES;
        pm.ps.pm_time = 0;
    }
}

function PM_WaterMove(): void {
    if (PM_CheckWaterJump()) {
        PM_WaterJumpMove();
        return;
    }

    PM_Friction();

    const scale = PM_CmdScale(pm.cmd.moves);

    if (scale === 0) {
        t_wishvel[0] = 0;
        t_wishvel[1] = 0;
        t_wishvel[2] = -60; // sink towards bottom
    } else {
        for (let i = 0; i < 3; i++) {
            t_wishvel[i] = f32(
                f32(f32(scale * pml.forward[i]!) * pm.cmd.moves[FORWARDMOVE]!) +
                f32(f32(scale * pml.right[i]!) * pm.cmd.moves[RIGHTMOVE]!)
            );
        }
        t_wishvel[2] = f32(t_wishvel[2]! + f32(scale * pm.cmd.moves[UPMOVE]!));
    }

    copy(t_wishdir, t_wishvel);
    let wishspeed = normalize(t_wishdir);

    let swimScale = C.pm_swimScale;
    if ((pm.pmove_flags & C.DF_FAST_WATER_MOVE) !== 0) {
        swimScale = C.pm_swimFastScale;
    }

    if (wishspeed > f32(pm.ps.speed * swimScale)) {
        wishspeed = f32(pm.ps.speed * swimScale);
    }

    PM_Accelerate(t_wishdir, wishspeed, C.pm_wateraccelerate);

    // Make sure we can go up slopes easily under water.
    if (pml.groundPlane && dot(pm.ps.velocity, pml.groundTrace.planeNormal) < 0) {
        const vel = vlength(pm.ps.velocity);
        PM_ClipVelocity(
            pm.ps.velocity,
            pml.groundTrace.planeNormal,
            pm.ps.velocity,
            C.OVERCLIP
        );
        normalize(pm.ps.velocity);
        vscale(pm.ps.velocity, pm.ps.velocity, vel);
    }

    PM_SlideMove(false);
}

/* ------------------------------------------------------------------ *
 * Powerup moves
 * ------------------------------------------------------------------ */

function PM_InvulnerabilityMove(): void {
    pm.cmd.moves[FORWARDMOVE] = 0;
    pm.cmd.moves[RIGHTMOVE] = 0;
    pm.cmd.moves[UPMOVE] = 0;
    clear(pm.ps.velocity);
}

function PM_FlyMove(): void {
    PM_Friction();

    const scale = PM_CmdScale(pm.cmd.moves);

    if (scale === 0) {
        t_wishvel[0] = 0;
        t_wishvel[1] = 0;
        t_wishvel[2] = 0;
    } else {
        for (let i = 0; i < 3; i++) {
            t_wishvel[i] = f32(
                f32(f32(scale * pml.forward[i]!) * pm.cmd.moves[FORWARDMOVE]!) +
                f32(f32(scale * pml.right[i]!) * pm.cmd.moves[RIGHTMOVE]!)
            );
        }
        t_wishvel[2] = f32(t_wishvel[2]! + f32(scale * pm.cmd.moves[UPMOVE]!));
    }

    copy(t_wishdir, t_wishvel);
    const wishspeed = normalize(t_wishdir);

    PM_Accelerate(t_wishdir, wishspeed, C.pm_flyaccelerate);

    PM_StepSlideMove(false);
}

/* ------------------------------------------------------------------ *
 * PM_AirMove
 * ------------------------------------------------------------------ */

function PM_AirMove(): void {
    PM_Friction();

    const fmove = pm.cmd.moves[FORWARDMOVE]!;
    const smove = pm.cmd.moves[RIGHTMOVE]!;

    // The C copies `pm->cmd` into a local and scales from that. The copy is
    // pointless -- nothing mutates it -- but is kept in shape here so the two
    // read alike.
    const scale = PM_CmdScale(pm.cmd.moves);

    PM_SetMovementDir();

    // Project moves down to a flat plane.
    pml.forward[2] = 0;
    pml.right[2] = 0;
    normalize(pml.forward);
    normalize(pml.right);

    for (let i = 0; i < 2; i++) {
        t_wishvel[i] = f32(
            f32(pml.forward[i]! * fmove) + f32(pml.right[i]! * smove)
        );
    }
    t_wishvel[2] = 0;

    copy(t_wishdir, t_wishvel);
    let wishspeed = normalize(t_wishdir);
    wishspeed = f32(wishspeed * scale);

    // Not on ground, so little effect on velocity.
    PM_Accelerate(t_wishdir, wishspeed, C.pm_airaccelerate);

    // We may have a ground plane that is very steep even though we don't have a
    // ground entity -- slide along it.
    if (pml.groundPlane) {
        PM_ClipVelocity(
            pm.ps.velocity,
            pml.groundTrace.planeNormal,
            pm.ps.velocity,
            C.OVERCLIP
        );
    }

    PM_StepSlideMove(true);
}

/* ------------------------------------------------------------------ *
 * PM_WalkMove
 * ------------------------------------------------------------------ */

function PM_WalkMove(): void {
    if (pm.waterlevel > 2 && dot(pml.forward, pml.groundTrace.planeNormal) > 0) {
        PM_WaterMove();
        return;
    }

    if (PM_CheckJump()) {
        // Jumped away.
        if (pm.waterlevel > 1) {
            PM_WaterMove();
        } else {
            PM_AirMove();
        }
        return;
    }

    PM_Friction();

    const fmove = pm.cmd.moves[FORWARDMOVE]!;
    const smove = pm.cmd.moves[RIGHTMOVE]!;

    const scale = PM_CmdScale(pm.cmd.moves);

    PM_SetMovementDir();

    // Project moves down to a flat plane.
    pml.forward[2] = 0;
    pml.right[2] = 0;

    // Project the forward and right directions onto the ground plane.
    PM_ClipVelocity(pml.forward, pml.groundTrace.planeNormal, pml.forward, C.OVERCLIP);
    PM_ClipVelocity(pml.right, pml.groundTrace.planeNormal, pml.right, C.OVERCLIP);

    normalize(pml.forward);
    normalize(pml.right);

    for (let i = 0; i < 3; i++) {
        t_wishvel[i] = f32(
            f32(pml.forward[i]! * fmove) + f32(pml.right[i]! * smove)
        );
    }

    copy(t_wishdir, t_wishvel);
    let wishspeed = normalize(t_wishdir);
    wishspeed = f32(wishspeed * scale);

    // Clamp the speed lower if ducking.
    if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
        if (wishspeed > f32(pm.ps.speed * C.pm_duckScale)) {
            wishspeed = f32(pm.ps.speed * C.pm_duckScale);
        }
    }

    // Clamp the speed lower if wading or walking on the bottom.
    if (pm.waterlevel !== 0) {
        // `pm->waterlevel / 3.0` and `1.0 - (1.0 - pm_swimScale) * waterScale`
        // are double expressions in the C, landing in a float local.
        let waterScale = pm.waterlevel / 3.0;
        waterScale = f32(1.0 - (1.0 - C.pm_swimScale) * waterScale);
        if (wishspeed > f32(pm.ps.speed * waterScale)) {
            wishspeed = f32(pm.ps.speed * waterScale);
        }
    }

    // When a player gets hit they temporarily lose full control.
    let accelerate: number;
    if (
        (pml.groundTrace.surfaceFlags & SURF.SLICK) !== 0 ||
        (pm.ps.pm_flags & C.PMF_TIME_KNOCKBACK) !== 0
    ) {
        accelerate = C.pm_airaccelerate;
    } else {
        accelerate = C.pm_accelerate;
    }

    PM_Accelerate(t_wishdir, wishspeed, accelerate);

    if (
        (pml.groundTrace.surfaceFlags & SURF.SLICK) !== 0 ||
        (pm.ps.pm_flags & C.PMF_TIME_KNOCKBACK) !== 0
    ) {
        pm.ps.velocity[2] = f32(pm.ps.velocity[2]! - f32(pm.ps.gravity * pml.frametime));
    }

    const vel = vlength(pm.ps.velocity);

    // Slide along the ground plane.
    PM_ClipVelocity(pm.ps.velocity, pml.groundTrace.planeNormal, pm.ps.velocity, C.OVERCLIP);

    // Don't decrease velocity when going up or down a slope.
    normalize(pm.ps.velocity);
    vscale(pm.ps.velocity, pm.ps.velocity, vel);

    // Don't do anything if standing still.
    if (pm.ps.velocity[0] === 0 && pm.ps.velocity[1] === 0) {
        return;
    }

    PM_StepSlideMove(false);
}

/* ------------------------------------------------------------------ *
 * PM_DeadMove / PM_NoclipMove
 * ------------------------------------------------------------------ */

function PM_DeadMove(): void {
    if (!pml.walking) return;

    let forward = vlength(pm.ps.velocity);
    forward = f32(forward - 20);

    if (forward <= 0) {
        clear(pm.ps.velocity);
    } else {
        normalize(pm.ps.velocity);
        vscale(pm.ps.velocity, pm.ps.velocity, forward);
    }
}

function PM_NoclipMove(): void {
    // `cg_enableQ` is a cgame cvar that defaults to 0; the Quake-scale
    // viewheight branch is not reachable at the default and is not ported.
    pm.ps.viewheight = C.DEFAULT_VIEWHEIGHT;

    const speed = vlength(pm.ps.velocity);
    if (speed < 1) {
        clear(pm.ps.velocity);
    } else {
        let drop = 0;

        const friction = f32(C.pm_friction * 1.5); // extra friction
        const control = speed < C.pm_stopspeed ? C.pm_stopspeed : speed;
        drop = f32(drop + f32(f32(control * friction) * pml.frametime));

        let newspeed = f32(speed - drop);
        if (newspeed < 0) newspeed = 0;
        newspeed = f32(newspeed / speed);

        vscale(pm.ps.velocity, pm.ps.velocity, newspeed);
    }

    const scale = PM_CmdScale(pm.cmd.moves);

    const fmove = pm.cmd.moves[FORWARDMOVE]!;
    const smove = pm.cmd.moves[RIGHTMOVE]!;

    for (let i = 0; i < 3; i++) {
        t_wishvel[i] = f32(f32(pml.forward[i]! * fmove) + f32(pml.right[i]! * smove));
    }
    t_wishvel[2] = f32(t_wishvel[2]! + pm.cmd.moves[UPMOVE]!);

    copy(t_wishdir, t_wishvel);
    let wishspeed = normalize(t_wishdir);
    wishspeed = f32(wishspeed * scale);

    PM_Accelerate(t_wishdir, wishspeed, C.pm_accelerate);

    vectorMA(pm.ps.origin, pm.ps.origin, pml.frametime, pm.ps.velocity);
}

/* ------------------------------------------------------------------ *
 * Footsteps and landing
 * ------------------------------------------------------------------ */

function PM_FootstepForSurface(): number {
    if ((pml.groundTrace.surfaceFlags & SURF.NOSTEPS) !== 0) {
        return 0;
    }
    if ((pml.groundTrace.surfaceFlags & SURF.METALSTEPS) !== 0) {
        return C.EV_FOOTSTEP_METAL;
    }
    return C.EV_FOOTSTEP;
}

function PM_CrashLand(): void {
    if ((pm.ps.pm_flags & C.PMF_BACKWARDS_JUMP) !== 0) {
        PM_ForceLegsAnim(C.LEGS_LANDB);
    } else {
        PM_ForceLegsAnim(C.LEGS_LAND);
    }

    pm.ps.legsTimer = C.TIMER_LAND;

    // Calculate the exact velocity on landing by solving the quadratic for the
    // moment of impact within the frame.
    const dist = f32(pm.ps.origin[2]! - pml.previous_origin[2]!);
    const vel = pml.previous_velocity[2]!;
    const acc = f32(-pm.ps.gravity);

    const a = f32(acc / 2);
    const b = vel;
    const c = f32(-dist);

    const den = f32(f32(b * b) - f32(f32(4 * a) * c));
    if (den < 0) return;

    /*
     `t = (-b - sqrt(den)) / (2 * a)`.

     `sqrt` returns a *double*, so `-b - sqrt(den)` promotes and the whole
     expression stays in double until it is assigned to the `float t`. Rounding
     the square root early -- which is what this line did first -- shifts `delta`
     by a few ULPs, and `delta` is compared against 1, 7, 40 and 60. A landing
     sitting just under `delta < 1` on one side and just over on the other
     changes whether an event is raised at all, so this showed up as an
     `eventSequence` divergence with position and velocity still in exact
     agreement.
    */
    const t = f32((-b - Math.sqrt(den)) / f32(2 * a));

    let delta = f32(vel + f32(t * acc));
    delta = f32(f32(delta * delta) * 0.0001);

    // Ducking while falling doubles damage.
    if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
        delta = f32(delta * 2);
    }

    if (pm.waterlevel === 3) return;
    if (pm.waterlevel === 2) delta = f32(delta * 0.25);
    if (pm.waterlevel === 1) delta = f32(delta * 0.5);

    if (delta < 1) return;

    // SURF_NODAMAGE is used for bounce pads.
    if ((pml.groundTrace.surfaceFlags & SURF.NODAMAGE) === 0) {
        if (delta > 60) {
            PM_AddEvent(C.EV_FALL_FAR);
        } else if (delta > 40) {
            if (pm.ps.stats[C.STAT_HEALTH]! > 0) {
                PM_AddEvent(C.EV_FALL_MEDIUM);
            }
        } else if (delta > 7) {
            PM_AddEvent(C.EV_FALL_SHORT);
        } else {
            PM_AddEvent(PM_FootstepForSurface());
        }
    }

    pm.ps.bobCycle = 0;
}

/* ------------------------------------------------------------------ *
 * Ground trace
 * ------------------------------------------------------------------ */

function PM_CorrectAllSolid(trace: TraceResult): boolean {
    // Jitter around by a unit on each axis looking for a free spot.
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            for (let k = -1; k <= 1; k++) {
                copy(t_point, pm.ps.origin);
                t_point[0] = f32(t_point[0]! + i);
                t_point[1] = f32(t_point[1]! + j);
                t_point[2] = f32(t_point[2]! + k);

                pm.trace(
                    trace, t_point, pm.mins, pm.maxs, t_point,
                    pm.ps.clientNum, pm.tracemask
                );

                if (!trace.allsolid) {
                    t_point[0] = pm.ps.origin[0]!;
                    t_point[1] = pm.ps.origin[1]!;
                    t_point[2] = f32(pm.ps.origin[2]! - 0.25);

                    pm.trace(
                        trace, pm.ps.origin, pm.mins, pm.maxs, t_point,
                        pm.ps.clientNum, pm.tracemask
                    );
                    copyTrace(pml.groundTrace, trace);
                    return true;
                }
            }
        }
    }

    pm.ps.groundEntityNum = C.ENTITYNUM_NONE;
    pml.groundPlane = false;
    pml.walking = false;

    return false;
}

function PM_GroundTraceMissed(): void {
    if (pm.ps.groundEntityNum !== C.ENTITYNUM_NONE) {
        // Just transitioned into freefall. If they aren't in a jumping animation
        // and the ground is a way off, force one -- otherwise the player
        // backflips down staircases.
        copy(t_point, pm.ps.origin);
        t_point[2] = f32(t_point[2]! - 64);

        pm.trace(
            t_trace2, pm.ps.origin, pm.mins, pm.maxs, t_point,
            pm.ps.clientNum, pm.tracemask
        );

        if (t_trace2.fraction === 1.0) {
            if (pm.cmd.moves[FORWARDMOVE]! >= 0) {
                PM_ForceLegsAnim(C.LEGS_JUMP);
                pm.ps.pm_flags &= ~C.PMF_BACKWARDS_JUMP;
            } else {
                PM_ForceLegsAnim(C.LEGS_JUMPB);
                pm.ps.pm_flags |= C.PMF_BACKWARDS_JUMP;
            }
        }
    }

    pm.ps.groundEntityNum = C.ENTITYNUM_NONE;
    pml.groundPlane = false;
    pml.walking = false;
}

function PM_GroundTrace(): void {
    t_point[0] = pm.ps.origin[0]!;
    t_point[1] = pm.ps.origin[1]!;
    t_point[2] = f32(pm.ps.origin[2]! - 0.25);

    pm.trace(
        t_trace, pm.ps.origin, pm.mins, pm.maxs, t_point,
        pm.ps.clientNum, pm.tracemask
    );
    copyTrace(pml.groundTrace, t_trace);

    if (t_trace.allsolid) {
        if (!PM_CorrectAllSolid(t_trace)) return;
    }

    if (t_trace.fraction === 1.0) {
        PM_GroundTraceMissed();
        pml.groundPlane = false;
        pml.walking = false;
        return;
    }

    // Check if getting thrown off the ground.
    if (pm.ps.velocity[2]! > 0 && dot(pm.ps.velocity, t_trace.planeNormal) > 10) {
        if (pm.cmd.moves[FORWARDMOVE]! >= 0) {
            PM_ForceLegsAnim(C.LEGS_JUMP);
            pm.ps.pm_flags &= ~C.PMF_BACKWARDS_JUMP;
        } else {
            PM_ForceLegsAnim(C.LEGS_JUMPB);
            pm.ps.pm_flags |= C.PMF_BACKWARDS_JUMP;
        }

        pm.ps.groundEntityNum = C.ENTITYNUM_NONE;
        pml.groundPlane = false;
        pml.walking = false;
        return;
    }

    // Slopes that are too steep are not considered ground.
    if (t_trace.planeNormal[2]! < C.MIN_WALK_NORMAL) {
        pm.ps.groundEntityNum = C.ENTITYNUM_NONE;
        pml.groundPlane = true;
        pml.walking = false;
        return;
    }

    pml.groundPlane = true;
    pml.walking = true;

    // Hitting solid ground ends a waterjump.
    if ((pm.ps.pm_flags & C.PMF_TIME_WATERJUMP) !== 0) {
        pm.ps.pm_flags &= ~(C.PMF_TIME_WATERJUMP | C.PMF_TIME_LAND);
        pm.ps.pm_time = 0;
    }

    if (pm.ps.groundEntityNum === C.ENTITYNUM_NONE) {
        // Just hit the ground.
        PM_CrashLand();

        // Don't do landing time if we were just going down a slope.
        if (pml.previous_velocity[2]! < -200) {
            pm.ps.pm_flags |= C.PMF_TIME_LAND;
            pm.ps.pm_time = 250;
        }
    }

    pm.ps.groundEntityNum = t_trace.entityNum;

    PM_AddTouchEnt(t_trace.entityNum);
}

/* ------------------------------------------------------------------ *
 * Water level and ducking
 * ------------------------------------------------------------------ */

function PM_SetWaterLevel(): void {
    pm.waterlevel = 0;
    pm.watertype = 0;

    t_point[0] = pm.ps.origin[0]!;
    t_point[1] = pm.ps.origin[1]!;
    t_point[2] = f32(pm.ps.origin[2]! + C.MINS_Z + 1);

    let cont = pm.pointcontents(t_point, pm.ps.clientNum);

    if ((cont & MASK_WATER) !== 0) {
        // Integer division in the C: `sample2 / 2` where both are ints.
        const sample2 = pm.ps.viewheight - C.MINS_Z;
        const sample1 = (sample2 / 2) | 0;

        pm.watertype = cont;
        pm.waterlevel = 1;

        t_point[2] = f32(pm.ps.origin[2]! + C.MINS_Z + sample1);
        cont = pm.pointcontents(t_point, pm.ps.clientNum);

        if ((cont & MASK_WATER) !== 0) {
            pm.waterlevel = 2;
            t_point[2] = f32(pm.ps.origin[2]! + C.MINS_Z + sample2);
            cont = pm.pointcontents(t_point, pm.ps.clientNum);
            if ((cont & MASK_WATER) !== 0) {
                pm.waterlevel = 3;
            }
        }
    }
}

function PM_CheckDuck(): void {
    if (pm.ps.powerups[C.PW_INVULNERABILITY] !== 0) {
        if ((pm.ps.pm_flags & C.PMF_INVULEXPAND) !== 0) {
            // The invulnerability sphere has a 42 unit radius.
            set(pm.mins, -42, -42, -42);
            set(pm.maxs, 42, 42, 42);
        } else {
            set(pm.mins, -15, -15, C.MINS_Z);
            set(pm.maxs, 15, 15, 16);
        }
        pm.ps.pm_flags |= C.PMF_DUCKED;
        pm.ps.viewheight = C.CROUCH_VIEWHEIGHT;
        return;
    }

    pm.ps.pm_flags &= ~C.PMF_INVULEXPAND;

    pm.mins[0] = -15;
    pm.mins[1] = -15;
    pm.maxs[0] = 15;
    pm.maxs[1] = 15;
    pm.mins[2] = C.MINS_Z;

    if (pm.ps.pm_type === C.PM_DEAD) {
        pm.maxs[2] = -8;
        pm.ps.viewheight = C.DEAD_VIEWHEIGHT;
        return;
    }

    if (pm.cmd.moves[UPMOVE]! < 0) {
        pm.ps.pm_flags |= C.PMF_DUCKED;
    } else {
        // Stand up if possible.
        if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
            pm.maxs[2] = 32;
            pm.trace(
                t_trace2, pm.ps.origin, pm.mins, pm.maxs, pm.ps.origin,
                pm.ps.clientNum, pm.tracemask
            );
            if (!t_trace2.allsolid) {
                pm.ps.pm_flags &= ~C.PMF_DUCKED;
            }
        }
    }

    if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
        pm.maxs[2] = 16;
        pm.ps.viewheight = C.CROUCH_VIEWHEIGHT;
    } else {
        pm.maxs[2] = 32;
        pm.ps.viewheight = C.DEFAULT_VIEWHEIGHT;
    }
}

/* ------------------------------------------------------------------ *
 * PM_Footsteps
 * ------------------------------------------------------------------ */

function PM_Footsteps(): void {
    // Calculate speed and cycle to be used for footsteps and bobbing.
    pm.xyspeed = f32(
        Math.sqrt(
            f32(
                f32(pm.ps.velocity[0]! * pm.ps.velocity[0]!) +
                f32(pm.ps.velocity[1]! * pm.ps.velocity[1]!)
            )
        )
    );

    if (pm.ps.groundEntityNum === C.ENTITYNUM_NONE) {
        if (pm.ps.powerups[C.PW_INVULNERABILITY] !== 0) {
            PM_ContinueLegsAnim(C.LEGS_IDLECR);
        }
        // Airborne leaves the position in the cycle intact but doesn't advance.
        if (pm.waterlevel > 1) {
            PM_ContinueLegsAnim(C.LEGS_SWIM);
        }
        return;
    }

    // If not trying to move.
    if (pm.cmd.moves[FORWARDMOVE] === 0 && pm.cmd.moves[RIGHTMOVE] === 0) {
        if (pm.xyspeed < 5) {
            pm.ps.bobCycle = 0; // start at beginning of cycle again
            if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
                PM_ContinueLegsAnim(C.LEGS_IDLECR);
            } else {
                PM_ContinueLegsAnim(C.LEGS_IDLE);
            }
        }
        return;
    }

    let bobmove: number;
    let footstep = false;

    if ((pm.ps.pm_flags & C.PMF_DUCKED) !== 0) {
        bobmove = 0.5; // ducked characters bob much faster
        if ((pm.ps.pm_flags & C.PMF_BACKWARDS_RUN) !== 0) {
            PM_ContinueLegsAnim(C.LEGS_BACKCR);
        } else {
            PM_ContinueLegsAnim(C.LEGS_WALKCR);
        }
        // Ducked characters never play footsteps.
    } else if ((pm.cmd.buttons & C.BUTTON_WALKING) === 0) {
        bobmove = f32(0.4); // faster speeds bob faster
        if ((pm.ps.pm_flags & C.PMF_BACKWARDS_RUN) !== 0) {
            PM_ContinueLegsAnim(C.LEGS_BACK);
        } else if (pm.cmd.moves[RIGHTMOVE]! < 0 && pm.cmd.moves[FORWARDMOVE] === 0) {
            // OpenArena's added strafe animations.
            PM_ContinueLegsAnim(C.LEGS_STRAFE_LEFT);
        } else if (pm.cmd.moves[RIGHTMOVE]! > 0 && pm.cmd.moves[FORWARDMOVE] === 0) {
            PM_ContinueLegsAnim(C.LEGS_STRAFE_RIGHT);
        } else {
            PM_ContinueLegsAnim(C.LEGS_RUN);
        }
        footstep = true;
    } else {
        bobmove = f32(0.3); // walking bobs slow
        if ((pm.ps.pm_flags & C.PMF_BACKWARDS_RUN) !== 0) {
            PM_ContinueLegsAnim(C.LEGS_BACKWALK);
        } else {
            PM_ContinueLegsAnim(C.LEGS_WALK);
        }
    }

    // Check for footstep / splash sounds.
    const old = pm.ps.bobCycle;
    pm.ps.bobCycle = Math.trunc(old + bobmove * pml.msec) & 255;

    // If we just crossed a cycle boundary, play an appropriate footstep event.
    if (((old + 64) ^ (pm.ps.bobCycle + 64)) & 128) {
        if (pm.waterlevel === 0) {
            if (footstep && !pm.noFootsteps) {
                PM_AddEvent(PM_FootstepForSurface());
            }
        } else if (pm.waterlevel === 1) {
            PM_AddEvent(C.EV_FOOTSPLASH);
        } else if (pm.waterlevel === 2) {
            PM_AddEvent(C.EV_SWIM);
        } else if (pm.waterlevel === 3) {
            // No sound when completely underwater.
        }
    }
}

/* ------------------------------------------------------------------ *
 * PM_WaterEvents
 * ------------------------------------------------------------------ */

function PM_WaterEvents(): void {
    // Entering the water.
    if (pml.previous_waterlevel === 0 && pm.waterlevel !== 0) {
        PM_AddEvent(C.EV_WATER_TOUCH);
    }

    // Leaving the water.
    if (pml.previous_waterlevel !== 0 && pm.waterlevel === 0) {
        PM_AddEvent(C.EV_WATER_LEAVE);
    }

    // Head just going under.
    if (pml.previous_waterlevel !== 3 && pm.waterlevel === 3) {
        PM_AddEvent(C.EV_WATER_UNDER);
    }

    // Head just coming out.
    if (pml.previous_waterlevel === 3 && pm.waterlevel !== 3) {
        PM_AddEvent(C.EV_WATER_CLEAR);
    }
}

/* ------------------------------------------------------------------ *
 * PM_DropTimers
 * ------------------------------------------------------------------ */

function PM_DropTimers(): void {
    if (pm.ps.pm_time !== 0) {
        if (pml.msec >= pm.ps.pm_time) {
            pm.ps.pm_flags &= ~C.PMF_ALL_TIMES;
            pm.ps.pm_time = 0;
        } else {
            pm.ps.pm_time -= pml.msec;
        }
    }

    if (pm.ps.legsTimer > 0) {
        pm.ps.legsTimer -= pml.msec;
        if (pm.ps.legsTimer < 0) pm.ps.legsTimer = 0;
    }

    if (pm.ps.torsoTimer > 0) {
        pm.ps.torsoTimer -= pml.msec;
        if (pm.ps.torsoTimer < 0) pm.ps.torsoTimer = 0;
    }
}

/* ------------------------------------------------------------------ *
 * PM_UpdateViewAngles
 * ------------------------------------------------------------------ */

/**
 * Apply the command's angles to the view.
 *
 * `temp` is a `short` in the C, and the truncation is *the mechanism*: yaw is
 * circular because 16-bit addition wraps. Pitch is then clamped to +/-16000,
 * which is 87.9 degrees rather than 90 -- a Q3 player genuinely cannot look
 * straight up.
 */
export function PM_UpdateViewAngles(ps: PlayerState, cmd: { angles: Int16Array }): void {
    if (ps.pm_type === C.PM_INTERMISSION || ps.pm_type === C.PM_SPINTERMISSION) {
        return;
    }

    if (ps.pm_type !== C.PM_SPECTATOR && ps.stats[C.STAT_HEALTH]! <= 0) {
        return;
    }

    for (let i = 0; i < 3; i++) {
        // `short temp = cmd->angles[i] + ps->delta_angles[i]` -- the sum is
        // computed as int and truncated into a short.
        let temp = ((cmd.angles[i]! + ps.delta_angles[i]!) << 16) >> 16;

        if (i === PITCH) {
            if (temp > 16000) {
                ps.delta_angles[i] = 16000 - cmd.angles[i]!;
                temp = 16000;
            } else if (temp < -16000) {
                ps.delta_angles[i] = -16000 - cmd.angles[i]!;
                temp = -16000;
            }
        }

        ps.viewangles[i] = short2angle(temp);
    }
}

/**
 * The angles {@link PM_UpdateViewAngles} *would* write, without writing them.
 *
 * `ps.viewangles` is a fixed-step quantity: it is only current as of the last
 * step that ran. The camera is not -- it is written once per rendered frame --
 * and orienting it from the stale array is what put the player's *heading* back
 * on the simulation's clock while their *position* was being blended. At 165 Hz
 * against a 60 Hz step that is a heading held for two or three frames and then
 * jumped, which reads as a mouse that turns the view in jerks. See D-155.
 *
 * The clamp is the same one and the refusals are the same two -- an intermission
 * and a corpse do not turn -- but the `delta_angles` repair the real function
 * does on a clamped pitch is deliberately *not* done here. That write is how the
 * server tells the client where it is now looking, it belongs to the step, and a
 * render-rate reader that performed it would be a second author of simulation
 * state running at an unbounded rate.
 *
 * @param angles the command angles to preview, in Q3's 16-bit units.
 * @param out receives the degrees, Q3's `(pitch, yaw, roll)`.
 * @returns whether `out` was written. False means pmove would have refused the
 *   update, and the caller should keep reading `ps.viewangles` -- which is then
 *   the correct answer rather than a stale one, because nothing is moving it.
 */
export function PM_PreviewViewAngles(
    ps: PlayerState,
    angles: Int16Array,
    out: Vec3
): boolean {
    if (ps.pm_type === C.PM_INTERMISSION || ps.pm_type === C.PM_SPINTERMISSION) {
        return false;
    }

    if (ps.pm_type !== C.PM_SPECTATOR && ps.stats[C.STAT_HEALTH]! <= 0) {
        return false;
    }

    for (let i = 0; i < 3; i++) {
        let temp = ((angles[i]! + ps.delta_angles[i]!) << 16) >> 16;

        if (i === PITCH) {
            if (temp > 16000) temp = 16000;
            else if (temp < -16000) temp = -16000;
        }

        out[i] = short2angle(temp);
    }

    return true;
}

/* ------------------------------------------------------------------ *
 * bg_slidemove.c
 * ------------------------------------------------------------------ */

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

/**
 * `PM_SlideMove` -- move, clipping velocity against up to five planes.
 *
 * The nested i/j/k loops are the interesting part: after clipping against one
 * plane the result may enter a second, so it clips again; if the doubly-clipped
 * velocity would re-enter the first plane it slides along the *crease* between
 * them instead; and a third plane stops the player dead. That is how corners
 * behave in Q3, and it is why the number is five rather than "enough".
 */
function PM_SlideMove(gravity: boolean): boolean {
    const numbumps = 4;
    let numplanes = 0;
    let bumpcount = 0;

    copy(t_primal_velocity, pm.ps.velocity);

    if (gravity) {
        copy(t_endVelocity, pm.ps.velocity);
        t_endVelocity[2] = f32(t_endVelocity[2]! - f32(pm.ps.gravity * pml.frametime));
        pm.ps.velocity[2] = f32(f32(pm.ps.velocity[2]! + t_endVelocity[2]!) * 0.5);
        t_primal_velocity[2] = t_endVelocity[2]!;

        if (pml.groundPlane) {
            PM_ClipVelocity(
                pm.ps.velocity, pml.groundTrace.planeNormal, pm.ps.velocity, C.OVERCLIP
            );
        }
    }

    let time_left = pml.frametime;

    // Never turn against the ground plane.
    if (pml.groundPlane) {
        numplanes = 1;
        copy(t_planes[0]!, pml.groundTrace.planeNormal);
    } else {
        numplanes = 0;
    }

    // Never turn against the original velocity.
    normalize2(pm.ps.velocity, t_planes[numplanes]!);
    numplanes += 1;

    for (bumpcount = 0; bumpcount < numbumps; bumpcount++) {
        vectorMA(t_end, pm.ps.origin, time_left, pm.ps.velocity);

        pm.trace(
            t_trace, pm.ps.origin, pm.mins, pm.maxs, t_end,
            pm.ps.clientNum, pm.tracemask
        );

        if (t_trace.allsolid) {
            // Completely trapped in another solid: don't build up falling
            // damage, but allow sideways acceleration.
            pm.ps.velocity[2] = 0;
            return true;
        }

        if (t_trace.fraction > 0) {
            copy(pm.ps.origin, t_trace.endpos);
        }

        if (t_trace.fraction === 1) break; // moved the entire distance

        PM_AddTouchEnt(t_trace.entityNum);

        time_left = f32(time_left - f32(time_left * t_trace.fraction));

        if (numplanes >= C.MAX_CLIP_PLANES) {
            // Shouldn't really happen.
            clear(pm.ps.velocity);
            return true;
        }

        // If this is the same plane we hit before, nudge velocity out along it,
        // which fixes some epsilon issues with non-axial planes.
        let i = 0;
        for (i = 0; i < numplanes; i++) {
            if (dot(t_trace.planeNormal, t_planes[i]!) > 0.99) {
                add(pm.ps.velocity, t_trace.planeNormal, pm.ps.velocity);
                break;
            }
        }
        if (i < numplanes) continue;

        copy(t_planes[numplanes]!, t_trace.planeNormal);
        numplanes += 1;

        // Modify velocity so it parallels all of the clip planes.
        for (i = 0; i < numplanes; i++) {
            const into = dot(pm.ps.velocity, t_planes[i]!);
            if (into >= 0.1) continue; // doesn't interact with the plane

            if (-into > pml.impactSpeed) {
                pml.impactSpeed = -into;
            }

            PM_ClipVelocity(pm.ps.velocity, t_planes[i]!, t_clipVelocity, C.OVERCLIP);

            if (gravity) {
                PM_ClipVelocity(t_endVelocity, t_planes[i]!, t_endClipVelocity, C.OVERCLIP);
            }

            // See if there is a second plane the new move enters.
            for (let j = 0; j < numplanes; j++) {
                if (j === i) continue;
                if (dot(t_clipVelocity, t_planes[j]!) >= 0.1) continue;

                PM_ClipVelocity(t_clipVelocity, t_planes[j]!, t_clipVelocity, C.OVERCLIP);

                if (gravity) {
                    PM_ClipVelocity(
                        t_endClipVelocity, t_planes[j]!, t_endClipVelocity, C.OVERCLIP
                    );
                }

                // See if it goes back into the first clip plane.
                if (dot(t_clipVelocity, t_planes[i]!) >= 0) continue;

                // Slide the original velocity along the crease.
                cross(t_dir, t_planes[i]!, t_planes[j]!);
                normalize(t_dir);
                let d = dot(t_dir, pm.ps.velocity);
                vscale(t_clipVelocity, t_dir, d);

                if (gravity) {
                    cross(t_dir, t_planes[i]!, t_planes[j]!);
                    normalize(t_dir);
                    d = dot(t_dir, t_endVelocity);
                    vscale(t_endClipVelocity, t_dir, d);
                }

                // See if there is a third plane the new move enters.
                for (let k = 0; k < numplanes; k++) {
                    if (k === i || k === j) continue;
                    if (dot(t_clipVelocity, t_planes[k]!) >= 0.1) continue;

                    // Stop dead at a triple plane interaction.
                    clear(pm.ps.velocity);
                    return true;
                }
            }

            // Fixed all interactions -- try another move.
            copy(pm.ps.velocity, t_clipVelocity);

            if (gravity) {
                copy(t_endVelocity, t_endClipVelocity);
            }

            break;
        }
    }

    if (gravity) {
        copy(pm.ps.velocity, t_endVelocity);
    }

    // Don't change velocity if in a timer.
    if (pm.ps.pm_time !== 0) {
        copy(pm.ps.velocity, t_primal_velocity);
    }

    return bumpcount !== 0;
}

/**
 * `PM_StepSlideMove` -- slide, then retry a step height higher if that failed.
 *
 * This is stair climbing, and it is *not* a collision feature: it is a second
 * whole slide attempt from 18 units up, followed by a trace back down. Q3
 * players walk up stairs because the move is simply performed twice.
 */
function PM_StepSlideMove(gravity: boolean): void {
    copy(t_start_o, pm.ps.origin);
    copy(t_start_v, pm.ps.velocity);

    if (!PM_SlideMove(gravity)) {
        return; // got exactly where we wanted to go first try
    }

    copy(t_down, t_start_o);
    t_down[2] = f32(t_down[2]! - C.STEPSIZE);
    pm.trace(
        t_trace2, t_start_o, pm.mins, pm.maxs, t_down,
        pm.ps.clientNum, pm.tracemask
    );

    set(t_up, 0, 0, 1);

    // Never step up when you still have up velocity.
    if (
        pm.ps.velocity[2]! > 0 &&
        (t_trace2.fraction === 1.0 || dot(t_trace2.planeNormal, t_up) < 0.7)
    ) {
        return;
    }

    copy(t_up, t_start_o);
    t_up[2] = f32(t_up[2]! + C.STEPSIZE);

    // Test the player position if they were a step height higher.
    pm.trace(
        t_trace2, t_start_o, pm.mins, pm.maxs, t_up,
        pm.ps.clientNum, pm.tracemask
    );
    if (t_trace2.allsolid) {
        return; // can't step up
    }

    const stepSize = f32(t_trace2.endpos[2] - t_start_o[2]!);

    // Try slidemove from this position.
    copy(pm.ps.origin, t_trace2.endpos);
    copy(pm.ps.velocity, t_start_v);

    PM_SlideMove(gravity);

    // Push down the final amount.
    copy(t_down, pm.ps.origin);
    t_down[2] = f32(t_down[2]! - stepSize);
    pm.trace(
        t_trace2, pm.ps.origin, pm.mins, pm.maxs, t_down,
        pm.ps.clientNum, pm.tracemask
    );
    if (!t_trace2.allsolid) {
        copy(pm.ps.origin, t_trace2.endpos);
    }
    if (t_trace2.fraction < 1.0) {
        PM_ClipVelocity(pm.ps.velocity, t_trace2.planeNormal, pm.ps.velocity, C.OVERCLIP);
    }

    /*
     Step events, banded by how far up the player actually moved. These are
     sound cues rather than movement, but they advance `eventSequence`, and the
     differential test compares it -- omitting them showed up as the port being
     exactly one event behind after ~40 frames of strafe jumping, with position
     and velocity in bit-exact agreement.

     Worth stating plainly: this was found by the oracle, not by reading. The
     step-event block sits after an `#if 0` in `bg_slidemove.c` and I stopped
     reading the function at the `PM_ClipVelocity` above.
    */
    const delta = f32(pm.ps.origin[2]! - t_start_o[2]!);
    if (delta > 2) {
        if (delta < 7) {
            PM_AddEvent(C.EV_STEP_4);
        } else if (delta < 11) {
            PM_AddEvent(C.EV_STEP_8);
        } else if (delta < 15) {
            PM_AddEvent(C.EV_STEP_12);
        } else {
            PM_AddEvent(C.EV_STEP_16);
        }
    }
}

/* ------------------------------------------------------------------ *
 * PmoveSingle / Pmove
 * ------------------------------------------------------------------ */

export function PmoveSingle(pmove: Pmove): void {
    pm = pmove;

    pm.numtouch = 0;
    pm.watertype = 0;
    pm.waterlevel = 0;

    if (pm.ps.stats[C.STAT_HEALTH]! <= 0) {
        pm.tracemask &= ~CONTENTS.BODY; // corpses can fly through bodies
    }

    // Make sure the walking button is clear if they are running, to avoid proxy
    // no-footsteps cheats.
    if (
        Math.abs(pm.cmd.moves[FORWARDMOVE]!) > 64 ||
        Math.abs(pm.cmd.moves[RIGHTMOVE]!) > 64
    ) {
        pm.cmd.buttons &= ~C.BUTTON_WALKING;
    }

    if ((pm.cmd.buttons & C.BUTTON_TALK) !== 0) {
        pm.ps.eFlags |= C.EF_TALK;
    } else {
        pm.ps.eFlags &= ~C.EF_TALK;
    }

    // Firing flag for continuous beam weapons.
    if (
        (pm.ps.pm_flags & C.PMF_RESPAWNED) === 0 &&
        pm.ps.pm_type !== C.PM_INTERMISSION &&
        pm.ps.pm_type !== C.PM_NOCLIP &&
        (pm.cmd.buttons & C.BUTTON_ATTACK) !== 0 &&
        pm.ps.ammo[pm.ps.weapon] !== 0
    ) {
        pm.ps.eFlags |= C.EF_FIRING;
    } else {
        pm.ps.eFlags &= ~C.EF_FIRING;
    }

    // Clear the respawned flag if attack and use are cleared.
    if (
        pm.ps.stats[C.STAT_HEALTH]! > 0 &&
        (pm.cmd.buttons & (C.BUTTON_ATTACK | C.BUTTON_USE_HOLDABLE)) === 0
    ) {
        pm.ps.pm_flags &= ~C.PMF_RESPAWNED;
    }

    // If the talk button is down, disallow all other input.
    if ((pm.cmd.buttons & C.BUTTON_TALK) !== 0) {
        pm.cmd.buttons = C.BUTTON_TALK;
        pm.cmd.moves[FORWARDMOVE] = 0;
        pm.cmd.moves[RIGHTMOVE] = 0;
        pm.cmd.moves[UPMOVE] = 0;
    }

    resetLocals();

    // Determine the time.
    pml.msec = pm.cmd.serverTime - pm.ps.commandTime;
    if (pml.msec < 1) {
        pml.msec = 1;
    } else if (pml.msec > 200) {
        pml.msec = 200;
    }
    pm.ps.commandTime = pm.cmd.serverTime;

    copy(pml.previous_origin, pm.ps.origin);
    copy(pml.previous_velocity, pm.ps.velocity);

    pml.frametime = f32(pml.msec * 0.001);

    PM_UpdateViewAngles(pm.ps, pm.cmd);

    angleVectors(pm.ps.viewangles, pml.forward, pml.right, pml.up);

    if (pm.cmd.moves[UPMOVE]! < 10) {
        pm.ps.pm_flags &= ~C.PMF_JUMP_HELD;
    }

    // Decide if backpedaling animations should be used.
    if (pm.cmd.moves[FORWARDMOVE]! < 0) {
        pm.ps.pm_flags |= C.PMF_BACKWARDS_RUN;
    } else if (
        pm.cmd.moves[FORWARDMOVE]! > 0 ||
        (pm.cmd.moves[FORWARDMOVE] === 0 && pm.cmd.moves[RIGHTMOVE] !== 0)
    ) {
        pm.ps.pm_flags &= ~C.PMF_BACKWARDS_RUN;
    }

    if (pm.ps.pm_type >= C.PM_DEAD) {
        pm.cmd.moves[FORWARDMOVE] = 0;
        pm.cmd.moves[RIGHTMOVE] = 0;
        pm.cmd.moves[UPMOVE] = 0;
    }

    if (pm.ps.pm_type === C.PM_SPECTATOR) {
        PM_CheckDuck();
        PM_FlyMove();
        PM_DropTimers();
        return;
    }

    if (pm.ps.pm_type === C.PM_NOCLIP) {
        PM_NoclipMove();
        PM_DropTimers();
        return;
    }

    if (pm.ps.pm_type === C.PM_FREEZE) return;

    if (pm.ps.pm_type === C.PM_INTERMISSION || pm.ps.pm_type === C.PM_SPINTERMISSION) {
        return;
    }

    PM_SetWaterLevel();
    pml.previous_waterlevel = pm.waterlevel;

    PM_CheckDuck();

    PM_GroundTrace();

    if (pm.ps.pm_type === C.PM_DEAD) {
        PM_DeadMove();
    }

    PM_DropTimers();

    if (pm.ps.powerups[C.PW_INVULNERABILITY] !== 0) {
        PM_InvulnerabilityMove();
    } else if (pm.ps.powerups[C.PW_FLIGHT] !== 0) {
        PM_FlyMove();
    } else if ((pm.ps.pm_flags & C.PMF_GRAPPLE_PULL) !== 0) {
        // Grapple is not ported (D-022); OA disables it in deathmatch. The
        // wiggle-in-air part still runs so the branch is not silently different.
        PM_AirMove();
    } else if ((pm.ps.pm_flags & C.PMF_TIME_WATERJUMP) !== 0) {
        PM_WaterJumpMove();
    } else if (pm.waterlevel > 1) {
        PM_WaterMove();
    } else if (pml.walking) {
        PM_WalkMove();
    } else {
        PM_AirMove();
    }

    // `PM_Animate` handles the gesture button and does not affect position.

    PM_GroundTrace();
    PM_SetWaterLevel();

    // `PM_Weapon` and `PM_TorsoAnimation` are not ported -- see D-022.

    PM_Footsteps();

    PM_WaterEvents();

    // Snap velocity. Q3 does this every frame and it is movement-visible, not a
    // bandwidth optimisation.
    if (pm.pmove_float === 0 || (pml.groundTrace.surfaceFlags & SURF.SLICK) !== 0) {
        snapVector(pm.ps.velocity);
    }
}

/**
 * `Pmove` -- chop a command into fixed steps and run `PmoveSingle` on each.
 *
 * The chopping is what makes movement framerate-independent, and the
 * `PMF_JUMP_HELD -> upmove = 20` at the bottom is what makes holding jump
 * continue to bunny-hop across the sub-steps.
 */
export function Pmove(pmove: Pmove): void {
    const finalTime = pmove.cmd.serverTime;

    if (finalTime < pmove.ps.commandTime) {
        return; // should not happen
    }

    if (finalTime > pmove.ps.commandTime + 1000) {
        pmove.ps.commandTime = finalTime - 1000;
    }

    pmove.ps.pmove_framecount =
        (pmove.ps.pmove_framecount + 1) & ((1 << C.PS_PMOVEFRAMECOUNTBITS) - 1);

    while (pmove.ps.commandTime !== finalTime) {
        let msec = finalTime - pmove.ps.commandTime;

        if (pmove.pmove_fixed !== 0) {
            if (msec > pmove.pmove_msec) msec = pmove.pmove_msec;
        } else {
            if (msec > 66) msec = 66;
        }

        pmove.cmd.serverTime = pmove.ps.commandTime + msec;
        PmoveSingle(pmove);

        if ((pmove.ps.pm_flags & C.PMF_JUMP_HELD) !== 0) {
            pmove.cmd.moves[UPMOVE] = 20;
        }
    }
}
