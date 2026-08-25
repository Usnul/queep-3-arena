/*
 * MeepMove.ts -- Quake III's motor, meep's collision.
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
 * "Port Q3 in spirit, not in body." (D-071.)
 *
 * The port previously ran `bg_pmove.c` whole, including `PM_SlideMove`,
 * `PM_StepSlideMove` and `PM_GroundTrace`, and bent meep's physics into
 * answering `pm->trace` with Q3's exact contact semantics. That cost three gap
 * entries, two of which turned out not to be gaps at all, and about 250 lines of
 * machinery whose only purpose was to make a general-purpose sweep reproduce a
 * 1999 brush-interval test.
 *
 * This module is the other answer. It keeps the half of Q3 movement that *is*
 * the game and hands the other half to the engine:
 *
 *   Q3 keeps (the spirit)          meep takes (the body)
 *   ─────────────────────          ─────────────────────
 *   PM_CmdScale                    recover (depenetration)
 *   PM_Friction                    sweep-and-slide, crease-aware
 *   PM_Accelerate  <- strafe-jump  stairs
 *   wishdir / wishspeed            ground categorise + stick
 *   JUMP_VELOCITY, gravity         contact normals, standoff
 *
 * The split is not arbitrary: it is the seam `DESIGN_COLLISION.md` describes.
 * The control layer produces a desired velocity; `KinematicMover.move` produces
 * the position actually reached, the velocity corrected for what was hit, and
 * the ground state. Strafe jumping lives entirely on the left-hand side --
 * `PM_Accelerate` caps `addspeed` against the projection of current velocity
 * onto `wishdir`, and that projection is why moving sideways while looking
 * forward gains speed. No trace is involved in it. So the trick survives the
 * swap intact, which is the whole bet this file makes.
 *
 * What does not survive is listed in D-071 and measured in
 * `test/meepmove.test.ts`. The short version: contact fractions differ, so a
 * ramp jump launches at a slightly different angle and a corner is rounded
 * rather than clipped. `bg_pmove` is still here, still bit-exact against the C,
 * and still reachable with `?move=q3` -- as a reference and an A/B, not as the
 * shipping path.
 */

import { KinematicMover } from '@woosh/meep-engine/src/engine/control/first-person/collision/KinematicMover.js';
import { BoxShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/BoxShape3D.js';
import { TransformedShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/TransformedShape3D.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

import * as C from '../q3/pmove/constants.ts';
import { vec3, type Vec3 } from '../q3/math.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

/** Q3's standing box, and its crouched form. */
export const STAND_MINS: Vec3 = vec3(-15, -15, -24);
export const STAND_MAXS: Vec3 = vec3(15, 15, 32);
export const CROUCH_MAXS: Vec3 = vec3(15, 15, 16);

/** Identity: the player box never rotates. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The physics facilities this needs, named rather than imported concretely so
 * the headless harness can supply the same system without an `Engine`.
 *
 * `KinematicMover` reaches for `ecd.getComponent(entity, Transform | Collider)`
 * inside its recover pass, and for `physicsSystem.entityOf(bodyId)` to get
 * there. Both are satisfied by the real ECS in the browser and by a two-method
 * stub under Node -- see `tools/pipeline/headless-physics.ts`.
 */
export interface MoverHost {
    readonly system: unknown;
    readonly ecd: unknown;
}

export interface MoveCommand {
    /** `usercmd_t.moves`, -127..127 on each axis. */
    readonly forward: number;
    readonly right: number;
    readonly up: number;
    /** View angles in degrees, Q3 order (pitch, yaw, roll). */
    readonly pitch: number;
    readonly yaw: number;
    /** Crouch is a held key rather than an axis here. */
    readonly crouch: boolean;
}

export interface MoveState {
    /** Q3 units. The player's *feet-relative* origin, as `ps.origin` is. */
    readonly origin: Vec3;
    /** Q3 units per second. */
    readonly velocity: Vec3;
    grounded: boolean;
    /** Q3 axes. `[0, 0, 1]` when airborne. */
    readonly groundNormal: Vec3;
    /** Q3's `PMF_JUMP_HELD`: a jump needs the key released and pressed again. */
    jumpHeld: boolean;
    ducked: boolean;
    /** Eye height above `origin`, Q3 units. */
    viewheight: number;
}

export function createMoveState(originQ3: ArrayLike<number>): MoveState {
    return {
        origin: vec3(originQ3[0]!, originQ3[1]!, originQ3[2]!),
        velocity: vec3(0, 0, 0),
        grounded: false,
        groundNormal: vec3(0, 0, 1),
        jumpHeld: false,
        ducked: false,
        viewheight: C.DEFAULT_VIEWHEIGHT,
    };
}

/* ------------------------------------------------------------------ *
 * The motor -- ported, and deliberately still exact
 * ------------------------------------------------------------------ */

/**
 * `AngleVectors`, forward and right only, and only the horizontal part.
 *
 * Q3 projects the view vectors onto the movement plane before building
 * `wishvel`; on the ground it projects onto the ground plane instead, which is
 * what lets you accelerate up a ramp. Both are here.
 */
function viewVectors(yawDeg: number, forward: Vec3, right: Vec3): void {
    const yaw = (yawDeg * Math.PI) / 180;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);

    forward[0] = cy;
    forward[1] = sy;
    forward[2] = 0;

    right[0] = sy;
    right[1] = -cy;
    right[2] = 0;
}

/**
 * `PM_CmdScale`.
 *
 * Divides by the magnitude of the whole 3-vector rather than clamping each
 * axis, which is what stops diagonal movement being sqrt(2) faster. Kept
 * exactly, because it sets the speed every other number is relative to.
 */
function cmdScale(cmd: MoveCommand, speed: number): number {
    const fm = Math.abs(cmd.forward);
    const rm = Math.abs(cmd.right);
    const um = Math.abs(cmd.up);

    let max = fm;
    if (rm > max) max = rm;
    if (um > max) max = um;
    if (max === 0) return 0;

    const total = Math.sqrt(
        cmd.forward * cmd.forward + cmd.right * cmd.right + cmd.up * cmd.up
    );

    return (speed * max) / (127.0 * total);
}

/**
 * `PM_Friction`, minus the water, flight and spectator terms.
 *
 * Those three are gone because this port has no swimming, no flight powerup and
 * no spectator mode; the ground term is the one that shapes movement and it is
 * unchanged. `pm_stopspeed` is the floor on `control`, and it is why you stop
 * quickly from a walk and slowly from a sprint.
 */
function applyFriction(state: MoveState, dt: number): void {
    const vel = state.velocity;

    // Q3 ignores the vertical component while walking, so running down a slope
    // is not braked by the descent.
    const speed = state.grounded
        ? Math.hypot(vel[0]!, vel[1]!)
        : Math.hypot(vel[0]!, vel[1]!, vel[2]!);

    if (speed < 1) {
        vel[0] = 0;
        vel[1] = 0;
        return;
    }

    let drop = 0;
    if (state.grounded) {
        const control = speed < C.pm_stopspeed ? C.pm_stopspeed : speed;
        drop += control * C.pm_friction * dt;
    }

    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;

    vel[0] = vel[0]! * newspeed;
    vel[1] = vel[1]! * newspeed;
    vel[2] = vel[2]! * newspeed;
}

/**
 * `PM_Accelerate` -- **the** function.
 *
 * `addspeed` is capped against `wishspeed`, but `currentspeed` is the projection
 * of *existing* velocity onto `wishdir`. A player whose velocity is nearly
 * perpendicular to `wishdir` has a small `currentspeed`, so they get the full
 * acceleration on top of the speed they already had, and repeating that every
 * frame while airborne is strafe jumping. It is a bug, it is twenty-five years
 * old, and it is the reason anyone still plays this.
 *
 * It is also entirely velocity-space: no trace, no contact, no collision
 * semantics. That is why the swap to meep's collision leaves it untouched, and
 * it is the single load-bearing claim of this module.
 */
function accelerate(state: MoveState, wishdir: Vec3, wishspeed: number, accel: number, dt: number): void {
    const vel = state.velocity;
    const currentspeed = vel[0]! * wishdir[0]! + vel[1]! * wishdir[1]! + vel[2]! * wishdir[2]!;
    const addspeed = wishspeed - currentspeed;

    if (addspeed <= 0) return;

    let accelspeed = accel * dt * wishspeed;
    if (accelspeed > addspeed) accelspeed = addspeed;

    vel[0] = vel[0]! + accelspeed * wishdir[0]!;
    vel[1] = vel[1]! + accelspeed * wishdir[1]!;
    vel[2] = vel[2]! + accelspeed * wishdir[2]!;
}

/** `PM_ClipVelocity`, used only to project the view vectors onto the ground. */
function clipToPlane(out: Vec3, v: Vec3, normal: Vec3): void {
    const backoff = (v[0]! * normal[0]! + v[1]! * normal[1]! + v[2]! * normal[2]!) * C.OVERCLIP;
    out[0] = v[0]! - normal[0]! * backoff;
    out[1] = v[1]! - normal[1]! * backoff;
    out[2] = v[2]! - normal[2]! * backoff;
}

function normalise(v: Vec3): number {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (len === 0) return 0;
    v[0] = v[0]! / len;
    v[1] = v[1]! / len;
    v[2] = v[2]! / len;
    return len;
}

/* ------------------------------------------------------------------ *
 * The mover
 * ------------------------------------------------------------------ */

export interface MoveResult {
    /** Did the slide hit anything this frame? */
    readonly hit: boolean;
    /** Did the player land this frame -- airborne last frame, grounded now? */
    readonly landed: boolean;
    /** Downward speed at the moment of landing, for the crash-land sound. */
    readonly landingSpeed: number;
}

/**
 * Q3's motor on meep's kinematic solver.
 *
 * One instance per moving character. Holds the mover, the box shapes and the
 * scratch vectors; `step` is allocation-free after construction.
 */
export class MeepMove {
    private readonly mover: KinematicMover;

    /**
     * Standing and crouched boxes, wrapped so their **bottom** is at the
     * shape's own origin.
     *
     * This is `KinematicMover`'s contract and it is not optional. Its ground
     * probes read `position.y` as the feet -- "Reference point is the capsule
     * bottom (`position.y`), matching the feet-at-origin player capsule" -- and
     * its step-up casts a ray at `position.y + stepHeight`, which is only "the
     * highest climbable height" if `position.y` is the sole of the foot. meep's
     * shapes are all centre-origin, so the offset has to come from a
     * `TransformedShape3D` wrapper, exactly as the engine's own
     * `makePostureCapsule` does it.
     *
     * Passing a centre-origin box with a centred position instead is a silent
     * failure and cost an hour here: `_groundedAt` rays down `2 * stepHeight`
     * from `position.y + stepHeight`, which for a 56-unit-tall Q3 box stops 10
     * units *above* the feet and can never reach the floor. The player hangs,
     * ungrounded, gravity cancelled, at the height it spawned.
     */
    private readonly standShape: TransformedShape3D;
    private readonly crouchShape: TransformedShape3D;

    /** Reused: `KinematicMover` mutates these in place. */
    private readonly meepPosition = new Vector3(0, 0, 0);
    private readonly meepVelocity = new Vector3(0, 0, 0);

    private readonly forward: Vec3 = vec3();
    private readonly right: Vec3 = vec3();
    private readonly wishvel: Vec3 = vec3();
    private readonly wishdir: Vec3 = vec3();

    /** Base speed, Q3 units/s. `ps.speed`, which is 320 for a live player. */
    speed = 320;

    /** `ps.gravity`. A Q3 server sets 800 and every map this port ships uses it. */
    gravity = 800;

    constructor(host: MoverHost) {
        /*
         Every constant that has a Q3 counterpart takes Q3's value rather than
         the mover's default, because those are balance numbers and the brief
         keeps balance numbers.

         - `stepHeight` is Q3's `STEPSIZE`, 18 units. The default 0.3 m is 9.6
           units, which would make half the map's steps into walls.
         - `minWalkNormal` is already Q3's 0.7 on both sides -- the mover cites
           `MIN_WALK_NORMAL` by name -- so this is a no-op that documents itself.
         - `skin` stays at the mover's own default. Q3's `SURFACE_CLIP_EPSILON`
           is 1/8 unit (0.0039 m) against the default 0.005 m; the difference is
           a sixth of a millimetre and the mover's value is the one its stair
           and ground-stick bands are tuned against. Overriding it to chase a
           Q3 number would be exactly the body-not-spirit mistake this module
           exists to stop making.
        */
        this.mover = new KinematicMover(host.system as never, host.ecd as never, {
            stepHeight: C.STEPSIZE * WORLD_SCALE,
            minWalkNormal: C.MIN_WALK_NORMAL,
            maxSlideIterations: 4,
        });

        this.standShape = footedBox(STAND_MINS, STAND_MAXS);
        this.crouchShape = footedBox(STAND_MINS, CROUCH_MAXS);
    }

    /**
     * Advance one frame.
     *
     * `dt` is real seconds. Q3 runs pmove on a fixed 8 ms tick and this does
     * not: `KinematicMover` is written for a variable step, the motor is
     * frame-rate independent apart from the friction and acceleration terms
     * which both take `dt` directly, and reproducing Q3's fixed tick would be
     * body rather than spirit. The caller may still subdivide if it wants
     * determinism -- `Bot` does, at 125 Hz.
     */
    step(state: MoveState, cmd: MoveCommand, dt: number): MoveResult {
        const wasGrounded = state.grounded;
        const fallSpeed = -state.velocity[2]!;

        this.duck(state, cmd);

        const jumped = this.tryJump(state, cmd);

        applyFriction(state, dt);
        this.buildWish(state, cmd);

        accelerate(
            state,
            this.wishdir,
            this.wishspeed,
            state.grounded ? C.pm_accelerate : C.pm_airaccelerate,
            dt
        );

        /*
         Gravity, unconditionally.

         Q3 gates this on being airborne and separately snaps the player to the
         ground every frame. The mover does the gating itself and better: it
         drops the downward component *before* the slide when the feet rest on
         walkable ground, so a standing player does not creep down a ramp, and
         it keeps gravity on a too-steep face so the player slides off it. Both
         are `_groundedAt` on the same `minWalkNormal` this was constructed
         with, which is Q3's own 0.7.
        */
        state.velocity[2] = state.velocity[2]! - this.gravity * dt;

        const result = this.resolve(state, dt);

        const landed = !wasGrounded && state.grounded && !jumped;

        return {
            hit: result,
            landed,
            landingSpeed: landed ? fallSpeed : 0,
        };
    }

    /** Scratch, written by `buildWish` and read by `step`. */
    private wishspeed = 0;

    /**
     * `PM_WalkMove` / `PM_AirMove`'s shared middle: wishdir and wishspeed.
     *
     * The only difference between the two in Q3 is which plane the view vectors
     * are projected onto -- the ground plane when walking, the horizontal when
     * airborne -- and that difference is why you can accelerate up a ramp.
     */
    private buildWish(state: MoveState, cmd: MoveCommand): void {
        viewVectors(cmd.yaw, this.forward, this.right);

        if (state.grounded) {
            clipToPlane(this.forward, this.forward, state.groundNormal);
            clipToPlane(this.right, this.right, state.groundNormal);
        }

        normalise(this.forward);
        normalise(this.right);

        for (let i = 0; i < 3; i++) {
            this.wishvel[i] = this.forward[i]! * cmd.forward + this.right[i]! * cmd.right;
        }
        if (!state.grounded) this.wishvel[2] = 0;

        this.wishdir[0] = this.wishvel[0]!;
        this.wishdir[1] = this.wishvel[1]!;
        this.wishdir[2] = this.wishvel[2]!;

        let wishspeed = normalise(this.wishdir);
        wishspeed *= cmdScale(cmd, this.speed);

        // `PM_WalkMove`'s duck clamp.
        if (state.ducked) {
            const capped = this.speed * C.pm_duckScale;
            if (wishspeed > capped) wishspeed = capped;
        }

        this.wishspeed = wishspeed;
    }

    /** `PM_CheckJump`, minus the animation and event bookkeeping. */
    private tryJump(state: MoveState, cmd: MoveCommand): boolean {
        if (cmd.up < 10) {
            state.jumpHeld = false;
            return false;
        }
        if (state.jumpHeld || !state.grounded) return false;

        state.jumpHeld = true;
        state.grounded = false;
        state.velocity[2] = C.JUMP_VELOCITY;
        return true;
    }

    /**
     * `PM_CheckDuck`, reduced.
     *
     * Standing back up needs headroom, and the check for it is an overlap test
     * with the taller box rather than Q3's upward trace -- same question, and
     * the mover's own recover pass would push the player out of a ceiling
     * anyway if this got it wrong.
     */
    private duck(state: MoveState, cmd: MoveCommand): void {
        if (cmd.crouch) {
            state.ducked = true;
            state.viewheight = C.CROUCH_VIEWHEIGHT;
            return;
        }
        if (!state.ducked) return;

        this.toMeep(state.origin, this.meepPosition);
        const blocked = (this.mover.physicsSystem as {
            overlap(
                s: unknown, p: unknown, r: unknown, out: Uint32Array, off: number
            ): number;
        }).overlap(this.standShape, this.meepPosition, NO_ROTATION, SCRATCH_OVERLAP, 0) > 0;

        if (!blocked) {
            state.ducked = false;
            state.viewheight = C.DEFAULT_VIEWHEIGHT;
        }
    }

    /** Hand the desired velocity to meep and read back what happened. */
    private resolve(state: MoveState, dt: number): boolean {
        const shape = state.ducked ? this.crouchShape : this.standShape;

        this.toMeep(state.origin, this.meepPosition);
        this.meepVelocity.set(
            state.velocity[0]! * WORLD_SCALE,
            state.velocity[2]! * WORLD_SCALE,
            -state.velocity[1]! * WORLD_SCALE
        );

        const out = this.mover.move(
            this.meepPosition,
            NO_ROTATION as never,
            shape as never,
            this.meepVelocity,
            dt,
            undefined as never
        );

        this.fromMeep(this.meepPosition, state.origin);

        state.velocity[0] = this.meepVelocity.x / WORLD_SCALE;
        state.velocity[1] = -this.meepVelocity.z / WORLD_SCALE;
        state.velocity[2] = this.meepVelocity.y / WORLD_SCALE;

        state.grounded = out.grounded;
        state.groundNormal[0] = out.groundNormal.x;
        state.groundNormal[1] = -out.groundNormal.z;
        state.groundNormal[2] = out.groundNormal.y;

        return out.hit;
    }

    /**
     * Q3 feet-origin to meep box-centre.
     *
     * `ps.origin` sits 24 units above the soles and the box runs -24..+32, so
     * its centre is 4 units above the origin. `KinematicMover` positions a
     * shape by its centre, so that offset has to be added going in and removed
     * coming out -- and it is half the crouched box's difference, so it depends
     * on the posture.
     */
    private toMeep(originQ3: Vec3, out: Vector3): void {
        out.set(
            originQ3[0]! * WORLD_SCALE,
            (originQ3[2]! + STAND_MINS[2]!) * WORLD_SCALE,
            -originQ3[1]! * WORLD_SCALE
        );
    }

    private fromMeep(position: Vector3, outQ3: Vec3): void {
        outQ3[0] = position.x / WORLD_SCALE;
        outQ3[1] = -position.z / WORLD_SCALE;
        outQ3[2] = position.y / WORLD_SCALE - STAND_MINS[2]!;
    }
}

/** The box a caller should use for a trace or a model, given the posture. */
export function boxForState(state: MoveState): { mins: Vec3; maxs: Vec3 } {
    return { mins: STAND_MINS, maxs: state.ducked ? CROUCH_MAXS : STAND_MAXS };
}

/**
 * The parts of Q3's `playerState_t` this can drive.
 *
 * Declared structurally rather than importing `PlayerState`, so the bridge
 * cannot quietly start depending on the rest of pmove's state -- and so the
 * shape of what meep-native movement actually needs is visible: an origin, a
 * velocity, whether you are standing on something, and how tall you are.
 * Everything else in `playerState_t` is netcode, animation or weapon
 * bookkeeping.
 */
export interface PlayerStateLike {
    readonly origin: Float32Array | number[];
    readonly velocity: Float32Array | number[];
    groundEntityNum: number;
    viewheight: number;
    pm_flags: number;
}

/** `ENTITYNUM_NONE`; Q3's "not standing on anything". */
const ENTITYNUM_NONE = 1022;

/** `ENTITYNUM_WORLD`; anything downstream only tests it against NONE. */
const ENTITYNUM_WORLD = 1023;

/**
 * Adapter: run a frame of meep-native movement over a Q3 `playerState_t`.
 *
 * This exists so the swap is one branch in `PlayerController` rather than a
 * rewrite of everything downstream. Weapons, items, the HUD, the bots and the
 * character placement all read `ps.origin`, `ps.velocity` and
 * `ps.groundEntityNum`, and none of them needs to know which solver wrote them.
 *
 * The `MoveState` is kept alongside the `playerState_t` rather than derived
 * from it each frame, because `grounded` and the ground normal are outputs of
 * the *previous* frame's solve and Q3 has nowhere to put a ground normal.
 */
export class PlayerMovement {
    private readonly move: MeepMove;
    private readonly state: MoveState;

    constructor(host: MoverHost, originQ3: ArrayLike<number>) {
        this.move = new MeepMove(host);
        this.state = createMoveState(originQ3);
    }

    get moveState(): MoveState {
        return this.state;
    }

    /** Q3 units/s, horizontal -- what the speedometer reads. */
    get speed(): number {
        return Math.hypot(this.state.velocity[0]!, this.state.velocity[1]!);
    }

    step(ps: PlayerStateLike, cmd: MoveCommand, dt: number): MoveResult {
        // Anything outside may have moved the player: a teleporter, a jump pad,
        // a respawn, a plat carrying them. `ps` is the authority on entry.
        this.state.origin[0] = ps.origin[0]!;
        this.state.origin[1] = ps.origin[1]!;
        this.state.origin[2] = ps.origin[2]!;
        this.state.velocity[0] = ps.velocity[0]!;
        this.state.velocity[1] = ps.velocity[1]!;
        this.state.velocity[2] = ps.velocity[2]!;

        const result = this.move.step(this.state, cmd, dt);

        ps.origin[0] = this.state.origin[0]!;
        ps.origin[1] = this.state.origin[1]!;
        ps.origin[2] = this.state.origin[2]!;
        ps.velocity[0] = this.state.velocity[0]!;
        ps.velocity[1] = this.state.velocity[1]!;
        ps.velocity[2] = this.state.velocity[2]!;

        ps.groundEntityNum = this.state.grounded ? ENTITYNUM_WORLD : ENTITYNUM_NONE;
        ps.viewheight = this.state.viewheight;

        return result;
    }
}

const SCRATCH_OVERLAP = new Uint32Array(16);

/**
 * Q3 mins/maxs to a meep box whose *bottom* sits at its own origin.
 *
 * `BoxShape3D.from` takes half-extents about the centre; the wrapper lifts it
 * by that half-height so the origin lands on the sole. The engine's own
 * `makePostureCapsule` is the same two lines with a capsule.
 */
function footedBox(mins: Vec3, maxs: Vec3): TransformedShape3D {
    const halfHeight = (maxs[2]! - mins[2]!) * 0.5 * WORLD_SCALE;

    const box = BoxShape3D.from(
        (maxs[0]! - mins[0]!) * 0.5 * WORLD_SCALE,
        halfHeight,
        (maxs[1]! - mins[1]!) * 0.5 * WORLD_SCALE
    );

    /*
     The cast is GAP-013, third instance: `AbstractShape3D.equals` is declared
     `<T extends AbstractShape3D>(other: T) => boolean` and every concrete shape
     narrows it, so no concrete shape is assignable to the abstract type its own
     wrapper takes.
    */
    return TransformedShape3D.from_translation(
        box as unknown as never,
        [0, halfHeight, 0]
    ) as TransformedShape3D;
}
