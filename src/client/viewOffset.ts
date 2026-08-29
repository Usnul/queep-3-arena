/*
 * viewOffset.ts -- `CG_OffsetFirstPersonView`: what the head does that the feet did not.
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
 * The port put the camera at `origin + viewheight` looking down `ps.viewangles`
 * and stopped there, which is `CG_CalcViewValues` and none of the seventy lines
 * after it. Q3 is a game you feel through a head that is never quite still: it
 * leans into a strafe, it rolls and pitches with each stride, it rises with the
 * bob, it dips when you land and it settles when you crouch. Take all of that
 * away and the movement is numerically identical and reads as a camera on rails
 * -- which is how it was reported.
 *
 * This is that function, and it is deliberately **not** meep's
 * `FirstPersonPlayerController`. That controller is a much larger model of the
 * same idea -- lean springs with half-lives, yaw-rate banking, breath, exertion,
 * stride phase, footfall impact springs -- and it is a good one; it is also a
 * model of a *different* game. Q3's whole camera is five cvars and a sine, and
 * the thing being asked for here is Q3's feel. Where the engine's controller was
 * worth reading was its shape rather than its numbers: it keeps the pose out of
 * the solver and composes offsets onto it, which is what the split between
 * {@link ViewKick} and {@link firstPersonView} is.
 *
 * # The five cvars, and what each is worth
 *
 * | cvar          | default | what it does                                        |
 * |---------------|---------|-----------------------------------------------------|
 * | `cg_runpitch` | 0.002   | nose down as you run forward, up as you back off     |
 * | `cg_runroll`  | 0.005   | roll away from the direction you strafe              |
 * | `cg_bobpitch` | 0.002   | per-stride nod, tripled while crouched               |
 * | `cg_bobroll`  | 0.002   | per-stride sway, alternating feet, tripled crouched  |
 * | `cg_bobup`    | 0.005   | per-stride rise, clamped to 6 units                  |
 *
 * `cg_runroll` is the big one and it is what "lean" means here: at Q3's 320
 * unit/s strafe it is 1.6 degrees of roll, held for as long as the key is held
 * and released as you stop. It is the difference between turning and *leaning
 * into* a turn.
 *
 * The bob terms are scaled by a speed floored at 200 -- `cg.xyspeed > 200 ?
 * cg.xyspeed : 200` -- so the bob is visible at a walk and grows with a run,
 * where the *rate* does not (see `bob.ts`).
 *
 * # What Q3 has here that this does not
 *
 * `cg.kick_angles` and `cg.kick_origin` are added by the C and are **never
 * written** anywhere in OpenArena's cgame -- two reads, no writes -- so they are
 * always zero and are not ported. The underwater fov warp and the intermission
 * camera belong to states this port has no equivalent of. The dead view *is*
 * here, because dying is a state the port has.
 */

import { angleVectors, vec3, type Vec3 } from '../q3/math.ts';
import { bobFracSin, bobOddCycle } from './bob.ts';

/* ---- `cg_local.h`'s timings, in milliseconds ---- */

/** How long a crouch or a stand takes to settle the eye. */
const DUCK_TIME = 100;

/** The dip on landing, and the recovery from it. */
const LAND_DEFLECT_TIME = 150;
const LAND_RETURN_TIME = 300;

/** How long a stair step is smoothed over. */
const STEP_TIME = 200;

/** The most stair the eye will ever be lagging behind the feet. */
const MAX_STEP_CHANGE = 32;

/** The damage kick's throw and its recovery. */
const DAMAGE_DEFLECT_TIME = 100;
const DAMAGE_RETURN_TIME = 400;

/* ---- `cg_main.c`'s cvar table ---- */

const CG_RUNPITCH = 0.002;
const CG_RUNROLL = 0.005;
const CG_BOBUP = 0.005;
const CG_BOBPITCH = 0.002;
const CG_BOBROLL = 0.002;

/** `CG_OffsetFirstPersonView`: the bob is scaled by at least this much speed. */
const BOB_MIN_SPEED = 200;

/** `origin[2] += bob`, and no further however fast you are going. */
const MAX_BOB_HEIGHT = 6;

/**
 * `CG_EntityEvent`'s three fall events, as the dip each one asks for.
 *
 * `EV_FALL_SHORT` is -8, `EV_FALL_MEDIUM` -16, `EV_FALL_FAR` -24, and the
 * thresholds are `PM_CrashLand`'s: `delta = (impact speed)^2 * 0.0001`, which
 * crosses 7 at about 265 units/s, 40 at 632 and 60 at 775. Reproduced from the
 * impact speed rather than taken off an event queue because the shipping
 * movement path is `MeepMove` (D-071), which reports `landingSpeed` and raises
 * none of Q3's events.
 */
function landChangeFor(impactSpeed: number): number {
    const delta = impactSpeed * impactSpeed * 0.0001;

    if (delta > 60) return -24;
    if (delta > 40) return -16;
    if (delta > 7) return -8;
    return 0;
}

/**
 * `PM_StepSlideMove`'s buckets: a rise of 2..7 units is a 4-unit step, and so on
 * up to 16.
 *
 * Q3 raises `EV_STEP_4`..`EV_STEP_16` and `CG_EntityEvent` turns the event back
 * into `4 * (event - EV_STEP_4 + 1)`, so the smoothing is quantised to four
 * units and does not track the riser exactly. Kept, because an eye that lags a
 * stair by exactly its own height reads as nailed to the step.
 */
function stepChangeFor(rise: number): number {
    if (rise < 7) return 4;
    if (rise < 11) return 8;
    if (rise < 15) return 12;
    return 16;
}

/**
 * The four timed offsets `cg_t` carries, and the events that set them.
 *
 * Separate from {@link firstPersonView} because these are *state* -- they
 * outlive the frame that started them by up to 450 ms -- while the bob and the
 * lean are pure functions of the player state at the instant they are asked
 * for. Q3 keeps them on `cg_t` for the same reason.
 *
 * Time is milliseconds and is this object's own: {@link advance} is called once
 * per fixed step with that step's `msec`, which is the clock `ps.commandTime`
 * runs on.
 */
export class ViewKick {
    private timeMs = 0;

    /** `cg.landChange` / `cg.landTime`. */
    private landChange = 0;
    private landTime = -1e9;

    /** `cg.duckChange` / `cg.duckTime`. */
    private duckChange = 0;
    private duckTime = -1e9;

    /** `cg.stepChange` / `cg.stepTime`. */
    private stepChange = 0;
    private stepTime = -1e9;

    /** `cg.v_dmg_pitch` / `cg.v_dmg_roll` / `cg.damageTime`. */
    private damagePitch = 0;
    private damageRoll = 0;
    private damageTime = -1e9;

    /** One fixed step of Q3's integer millisecond clock. */
    advance(msec: number): void {
        this.timeMs += msec;
    }

    /**
     * `EV_FALL_*`: the eye dips and comes back.
     *
     * @param impactSpeed downward speed at the moment of contact, Q3 units/s.
     */
    land(impactSpeed: number): void {
        const change = landChangeFor(impactSpeed);
        if (change === 0) return;

        this.landChange = change;
        this.landTime = this.timeMs;
    }

    /**
     * `CG_TransitionPlayerState`: the eye follows a viewheight change over
     * `DUCK_TIME` rather than jumping with it.
     *
     * @param change the *new* viewheight minus the old, Q3 units.
     */
    duck(change: number): void {
        if (change === 0) return;

        this.duckChange = change;
        this.duckTime = this.timeMs;
    }

    /**
     * `EV_STEP_*`: the eye is left behind by the riser and catches up.
     *
     * Q3 accumulates onto whatever is left of a previous step -- two stairs
     * taken inside 200 ms lag by the sum, capped at `MAX_STEP_CHANGE` -- which
     * is what makes a staircase read as a ramp instead of as a series of jolts.
     */
    step(rise: number): void {
        const elapsed = this.timeMs - this.stepTime;
        const remaining =
            elapsed < STEP_TIME ? (this.stepChange * (STEP_TIME - elapsed)) / STEP_TIME : 0;

        this.stepChange = Math.min(remaining + stepChangeFor(rise), MAX_STEP_CHANGE);
        this.stepTime = this.timeMs;
    }

    /**
     * `CG_DamageFeedback`, on its `yawByte == 255 && pitchByte == 255` branch.
     *
     * That branch is the one Q3 takes for damage with no direction -- falling,
     * drowning, a `trigger_hurt` -- and it is the only one this port can take:
     * damage reaches the player here as a number, without the attacker position
     * `v_dmg_roll` needs. So every hit throws the head back rather than away
     * from where it came from, which is a real loss of information and is
     * recorded as one rather than faked with a guess.
     *
     * The kick scales with how hurt you already are -- `scale = 40 / health`
     * above 40 health, 1 below it -- and is clamped to 5..10 degrees.
     */
    damage(damage: number, health: number): void {
        if (damage <= 0) return;

        const scale = health < 40 ? 1 : 40 / health;
        const kick = Math.min(10, Math.max(5, damage * scale));

        this.damagePitch = -kick;
        this.damageRoll = 0;
        this.damageTime = this.timeMs;
    }

    /** The vertical offset the three origin timers ask for, Q3 units. */
    originOffset(): number {
        let z = 0;

        // `smooth out duck height changes`
        const duckElapsed = this.timeMs - this.duckTime;
        if (duckElapsed < DUCK_TIME) {
            z -= (this.duckChange * (DUCK_TIME - duckElapsed)) / DUCK_TIME;
        }

        // `add fall height`
        const landElapsed = this.timeMs - this.landTime;
        if (landElapsed < LAND_DEFLECT_TIME) {
            z += this.landChange * (landElapsed / LAND_DEFLECT_TIME);
        } else if (landElapsed < LAND_DEFLECT_TIME + LAND_RETURN_TIME) {
            z += this.landChange * (1 - (landElapsed - LAND_DEFLECT_TIME) / LAND_RETURN_TIME);
        }

        // `CG_StepOffset`
        const stepElapsed = this.timeMs - this.stepTime;
        if (stepElapsed < STEP_TIME) {
            z -= (this.stepChange * (STEP_TIME - stepElapsed)) / STEP_TIME;
        }

        return z;
    }

    /** `[pitch, roll]` in degrees from the damage kick. */
    angleOffset(): [number, number] {
        const elapsed = this.timeMs - this.damageTime;
        if (elapsed < 0) return [0, 0];

        let ratio: number;
        if (elapsed < DAMAGE_DEFLECT_TIME) {
            ratio = elapsed / DAMAGE_DEFLECT_TIME;
        } else {
            ratio = 1 - (elapsed - DAMAGE_DEFLECT_TIME) / DAMAGE_RETURN_TIME;
            if (ratio <= 0) return [0, 0];
        }

        return [ratio * this.damagePitch, ratio * this.damageRoll];
    }
}

/** What the view offset is a function of: `cg.predictedPlayerState`, narrowed. */
export interface ViewInput {
    /** `ps.origin`, Q3 units. */
    readonly originQ3: ArrayLike<number>;
    /** `ps.velocity`, Q3 units per second. */
    readonly velocityQ3: ArrayLike<number>;
    /** `ps.viewangles`, degrees, Q3's `(pitch, yaw, roll)`. */
    readonly viewanglesQ3: ArrayLike<number>;
    /** `ps.viewheight`, Q3 units above `origin`. */
    readonly viewheight: number;
    /** `ps.bobCycle`. */
    readonly bobCycle: number;
    /** `pm_flags & PMF_DUCKED`, which is the solver's answer and not the key's. */
    readonly ducked: boolean;
    /** `stats[STAT_HEALTH] <= 0`, which takes the whole function's early exit. */
    readonly dead: boolean;
}

/**
 * Where the eye is and how it is tilted, for one instant of simulation.
 *
 * Angles are **offsets** rather than absolute: `pitch` and `roll` are what
 * `CG_OffsetFirstPersonView` adds to `cg.refdefViewAngles`, kept separate so a
 * caller can add them to a *live* mouse reading rather than to the one the fixed
 * step happened to end on. Yaw is untouched by the C except when dead, so it is
 * not carried at all.
 */
export interface ViewPose {
    /** The eye, Q3 units. */
    readonly eyeQ3: Vec3;
    /** Added to `viewangles[PITCH]`, degrees. */
    pitch: number;
    /** Added to `viewangles[ROLL]`, degrees. */
    roll: number;
    /** True when this is the dead pose, whose angles are absolute. */
    dead: boolean;
}

/** Scratch: this runs once per fixed step, for one player. */
const t_forward: Vec3 = vec3();
const t_right: Vec3 = vec3();
const t_up: Vec3 = vec3();

/** `if dead`: `angles[ROLL] = 40; angles[PITCH] = -15;`. */
export const DEAD_VIEW_ROLL = 40;
export const DEAD_VIEW_PITCH = -15;

/** A fresh pose, for a caller that needs somewhere to write. */
export function viewPose(): ViewPose {
    return { eyeQ3: vec3(), pitch: 0, roll: 0, dead: false };
}

/**
 * `CG_OffsetFirstPersonView`, written into `out`.
 *
 * The order below is the C's, and it matters in one place: the velocity terms
 * are dotted against the view axes *before* the bob is added to the angles, so
 * the lean is a function of where you are looking rather than of where the bob
 * has just tilted you. The other way round couples the two into a wobble that
 * grows with speed.
 */
export function firstPersonView(input: ViewInput, kick: ViewKick, out: ViewPose): void {
    const origin = out.eyeQ3;
    const angles = input.viewanglesQ3;

    origin[0] = input.originQ3[0]!;
    origin[1] = input.originQ3[1]!;
    origin[2] = input.originQ3[2]!;

    /*
     `if dead, fix the angle and don't add any kick`. Absolute rather than an
     offset, which is what `dead` on the pose is for. Q3 also takes the yaw from
     `STAT_DEAD_YAW` -- the server telling the client which way the corpse is
     facing -- which has no equivalent here, so the yaw is left where the player
     left it.
    */
    if (input.dead) {
        out.pitch = DEAD_VIEW_PITCH;
        out.roll = DEAD_VIEW_ROLL;
        out.dead = true;
        origin[2] += input.viewheight;
        return;
    }

    out.dead = false;

    // `add angles based on damage kick`
    const damage = kick.angleOffset();
    let pitch = damage[0];
    let roll = damage[1];

    /*
     `add angles based on velocity`.

     `cg.refdef.viewaxis[1]` is **left**, not right: `AnglesToAxis` negates what
     `AngleVectors` hands back as its second axis. Getting that backwards leans
     you out of a strafe instead of into it, which looks deliberate and is
     exactly wrong.
    */
    angleVectors(angles, t_forward, t_right, t_up);

    const v = input.velocityQ3;
    const alongForward = v[0]! * t_forward[0]! + v[1]! * t_forward[1]! + v[2]! * t_forward[2]!;
    const alongLeft = -(v[0]! * t_right[0]! + v[1]! * t_right[1]! + v[2]! * t_right[2]!);

    pitch += alongForward * CG_RUNPITCH;
    roll -= alongLeft * CG_RUNROLL;

    // `add angles based on bob`
    const fracSin = bobFracSin(input.bobCycle);
    const xySpeed = Math.hypot(v[0]!, v[1]!);
    const speed = xySpeed > BOB_MIN_SPEED ? xySpeed : BOB_MIN_SPEED;
    const crouchScale = input.ducked ? 3 : 1;

    pitch += fracSin * CG_BOBPITCH * speed * crouchScale;

    const bobRoll = fracSin * CG_BOBROLL * speed * crouchScale;
    roll += bobOddCycle(input.bobCycle) ? -bobRoll : bobRoll;

    out.pitch = pitch;
    out.roll = roll;

    // `add view height`
    origin[2] += input.viewheight;

    /*
     `add bob height`, from the *unfloored* speed -- this one is `cg.xyspeed` and
     not the 200 above, so a standing player does not float. Clamped to 6 units,
     which a run reaches at 1200 units/s and a strafe-jump chain exceeds.
    */
    const bob = Math.min(fracSin * xySpeed * CG_BOBUP, MAX_BOB_HEIGHT);
    origin[2] += bob;

    // The duck settle, the landing dip and the stair catch-up.
    origin[2] += kick.originOffset();
}
