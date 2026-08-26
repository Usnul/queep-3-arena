/*
 * PlayerController.ts -- drive `bg_pmove` from browser input.
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
 * The boundary between the two coordinate systems and the two unit scales.
 *
 * - The **simulation** runs in Q3 units and Q3 axes (Z up), because `bg_pmove`
 *   does and that is oracle-verified.
 * - The **presentation** runs in metres and meep axes (Y up).
 *
 * So this class owns exactly one conversion, in one direction, once per frame:
 * `ps.origin` (Q3) -> camera `Transform.position` (meep). Nothing else in the
 * client needs to know either convention. See DECISIONS.md D-011.
 *
 * Input comes from meep's own devices -- `engine.devices.keyboard` and
 * `engine.devices.pointer` -- rather than from raw DOM listeners. That is not a
 * style preference: raw listeners on the canvas do not work at all, because the
 * canvas and the whole view stack above it are `pointer-events: none` and the
 * stack is what the devices listen on. See GAP-017.
 *
 * `pointer.on.move` hands over `(position, event, delta)` and the third argument
 * is already the pointer-lock movement, so the look code reads it directly
 * rather than reaching into the event.
 */

import { ClipMap } from '../q3/cm/ClipMap.ts';
import { Pmove as runPmove } from '../q3/pmove/pmove.ts';
import {
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type Pmove,
    type PlayerState,
} from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';
import { weaponStats, type WeaponId } from '../game/Weapons.ts';
import { newInventory, type Inventory } from '../game/Items.ts';
import { PlayerMovement, type MoverHost } from './MeepMove.ts';
import {
    createPmoveHost,
    type MoverSource,
    type PhysicsTraceBackend,
} from '../game/PmoveHost.ts';
import { takePointerLock } from './pointerLock.ts';

/*
 Re-exported because `main.ts` and `PhysicsWorld` both name it, and moving the
 definition into `PmoveHost` should not move every import with it.
*/
export type { PhysicsTraceBackend };

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

/**
 * `PM_Footsteps`' cycle rates, per millisecond, with Q3's own comments on them:
 * "faster speeds bob faster" and "ducked characters bob much faster". There is a
 * third, 0.3 for `BUTTON_WALKING`, and nothing in this port binds a walk key.
 */
const BOBMOVE_RUN = 0.4;
const BOBMOVE_DUCKED = 0.5;

interface TransformLike {
    position: { set(x: number, y: number, z: number): void };
    rotation: RotationLike;
}

interface RotationLike {
    _lookRotation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): unknown;
}

/**
 * Point a meep rotation along Q3 view angles.
 *
 * Exported rather than inlined into `writeCamera` because the view weapon is
 * placed in this frame and the test that checks where it lands has to build the
 * same one. A hand-copied axis swap in the test would be a test of the copy
 * (D-076), and this is the swap that has been the subject of two bugs.
 *
 * Q3 forward is `(cos(yaw)cos(pitch), sin(yaw)cos(pitch), -sin(pitch))` with
 * pitch positive *downwards*, mapped through the same `(x, y, z) -> (x, z, -y)`
 * the geometry went through. The result puts the view direction on the
 * rotation's local **+Z**, which is Shade's own camera convention -- there is no
 * inversion anywhere, and `camera_sync_from_transform` exists in meep to say so.
 */
export function orientToQ3Angles(viewanglesQ3: ArrayLike<number>, out: RotationLike): void {
    const pitchRad = (viewanglesQ3[0]! * Math.PI) / 180;
    const yawRad = (viewanglesQ3[1]! * Math.PI) / 180;

    const cp = Math.cos(pitchRad);

    const fx = Math.cos(yawRad) * cp;
    const fy = Math.sin(yawRad) * cp;
    const fz = -Math.sin(pitchRad);

    out._lookRotation(fx, fz, -fy, 0, 1, 0);
}

/*
 Key names are meep's, from `input/devices/KeyCodes.js`, not DOM `event.code`.
 `keyboard.keys.<name>.is_down` is a live switch, so movement polls it once a
 frame instead of maintaining a held-key set -- which also means a key released
 while the window was unfocused cannot get stuck down.
*/
const KEY_FORWARD = ['w', 'up_arrow'];
const KEY_BACK = ['s', 'down_arrow'];
const KEY_LEFT = ['a', 'left_arrow'];
const KEY_RIGHT = ['d', 'right_arrow'];
const KEY_JUMP = ['space'];
const KEY_CROUCH = ['ctrl', 'c', 'shift'];

/**
 * Weapon select, matching Q3's number-row bindings.
 *
 * The order is `weapon_t`'s, which is also the order the mouse wheel cycles --
 * gauntlet first, then up through the list. It is not the order of increasing
 * power, and Q3 players know it by muscle memory, so it is kept.
 */
const WEAPON_ORDER: readonly WeaponId[] = [
    'WP_GAUNTLET',
    'WP_MACHINEGUN',
    'WP_SHOTGUN',
    'WP_GRENADE_LAUNCHER',
    'WP_ROCKET_LAUNCHER',
    'WP_LIGHTNING',
    'WP_RAILGUN',
    'WP_PLASMAGUN',
    'WP_BFG',
];

const KEY_WEAPON: ReadonlyMap<string, WeaponId> = new Map([
    ['1', 'WP_GAUNTLET'],
    ['2', 'WP_MACHINEGUN'],
    ['3', 'WP_SHOTGUN'],
    ['4', 'WP_GRENADE_LAUNCHER'],
    ['5', 'WP_ROCKET_LAUNCHER'],
    ['6', 'WP_LIGHTNING'],
    ['7', 'WP_RAILGUN'],
    ['8', 'WP_PLASMAGUN'],
    ['9', 'WP_BFG'],
] as const);

/* ------------------------------------------------------------------ *
 * The shape of meep's input devices, structurally.
 *
 * Written out rather than imported so the controller stays testable without an
 * engine, and so the generated `.d.ts`'s `readonly keys: any` does not leak an
 * `any` into every key read (GAP-001).
 * ------------------------------------------------------------------ */

export interface InputSwitch {
    readonly is_down: boolean;
}

export interface InputSignal<H> {
    add(handler: H): void;
    remove(handler: H): void;
}

/** `(position, event, delta)`; the third is the pointer-lock movement. */
export type PointerMoveHandler = (
    position: unknown,
    event: unknown,
    delta: { readonly x: number; readonly y: number }
) => void;

/**
 * `(delta, position, event)`. The delta is the device's own normalisation of the
 * wheel event -- each axis is already `sign()`ed to -1, 0 or +1, because raw
 * `WheelEvent` deltas differ in both magnitude and unit between browsers.
 */
export type WheelHandler = (
    delta: { readonly x: number; readonly y: number; readonly z: number },
    position: unknown,
    event: unknown
) => void;

export interface InputDevices {
    readonly keyboard: {
        readonly keys: Readonly<Record<string, InputSwitch | undefined>>;
        readonly on: {
            readonly down: InputSignal<(event: KeyboardEvent) => void>;
        };
    };
    readonly pointer: {
        readonly mouseButtonLeft: InputSwitch;
        readonly on: {
            readonly move: InputSignal<PointerMoveHandler>;
            readonly down: InputSignal<(position: unknown, event: unknown) => void>;
            readonly wheel: InputSignal<WheelHandler>;
        };
    };
}

/**
 * Q3 sends view angles as 16-bit fixed point. Keeping the browser's mouse deltas
 * in the same representation means the port's angle handling is exercised the
 * way the game's is, including the wrap that makes yaw circular.
 */
const ANGLE_PER_PIXEL = 12;

export class PlayerController {
    readonly ps: PlayerState;
    private readonly pmove: Pmove;
    private readonly element: HTMLElement;
    private readonly devices: InputDevices;

    /** 16-bit view angles, as `usercmd_t.angles` carries them. */
    private yaw = 0;
    private pitch = 0;

    private time = 0;
    private attached = false;

    /** Set true while the pointer is locked; movement input is ignored otherwise. */
    active = false;

    /**
     * Health, armour, ammo and owned weapons.
     *
     * Lives here rather than in `Arena` because Q3 keeps it in `playerState_t`
     * next to the movement state, and because weapon selection and firing both
     * have to consult it every frame.
     */
    readonly inventory: Inventory = newInventory();

    /** Currently selected weapon. */
    weapon: WeaponId = 'WP_MACHINEGUN';

    /**
     * Brush entities the ported clipmap has to be clipped against.
     *
     * Set after construction, because the mover simulation needs the map's
     * entity list and the controller needs a spawn point from the same list.
     * Ignored entirely on the physics backend, which sees movers as bodies.
     */
    movers: MoverSource | null = null;

    /**
     * True on the frames the attack button is held.
     *
     * Polled from `pointer.mouseButtonLeft` each frame rather than tracked
     * across down/up edges. An edge-tracked flag survives a lost pointer lock,
     * an alt-tab, or a button released over a different element, and the
     * symptom is a weapon that keeps firing after you let go.
     */
    attacking = false;

    /** Raised when the weapon should fire; the arena wires this to `WeaponSystem`. */
    onFire: ((eyeQ3: ArrayLike<number>, anglesQ3: ArrayLike<number>) => void) | null = null;

    /** Raised when the attack button is held on an empty weapon. */
    onDryFire: (() => void) | null = null;

    /** Rate limit for the empty click, so holding fire is a click and not a buzz. */
    private dryFireCooldownMs = 0;

    /** Milliseconds until the current weapon can fire again. */
    private cooldownMs = 0;

    /**
     * @param traceBackend `'physics'` runs `pm->trace` on meep's physics
     *   (D-029, the shipping configuration); `'clipmap'` runs the ported
     *   `cm_trace`, which is bit-exact against the C and is what the physics
     *   backend is tuned against.
     */
    /**
     * @param element the element that owns pointer lock. Must be the one meep's
     *   devices listen on -- `engine.viewStack.el` -- or the lock and the input
     *   end up on different elements and neither works.
     */
    constructor(
        cm: ClipMap,
        element: HTMLElement,
        devices: InputDevices,
        spawnQ3: readonly number[],
        physics: PhysicsTraceBackend | null = null,
        moverHost: MoverHost | null = null
    ) {
        this.element = element;
        this.devices = devices;

        /*
         Movement is built by `createPmoveHost`, which bots use too. The shared
         setup is the point: a bot moving through a different `pmove_t` is a bot
         playing a different game, and the difference would show up as bots
         taking jumps the player cannot.
        */
        this.pmove = createPmoveHost({
            cm,
            spawnQ3,
            physics,
            movers: () => this.movers,
            startHealth: this.inventory.health,
        });

        this.ps = this.pmove.ps;

        /*
         The shipping movement path (D-071).

         `PlayerMovement` runs Q3's motor and hands the resulting velocity to
         meep's `KinematicMover`; the ported `bg_pmove` above stays built and is
         used when this is null, which is what `?move=q3` selects. Both write
         the same `playerState_t`, so nothing downstream -- weapons, items, the
         HUD, character placement -- can tell which one ran.
        */
        this.movement = moverHost === null
            ? null
            : new PlayerMovement(moverHost, this.ps.origin);
    }

    /** Non-null when movement runs on meep's solver, which is the default. */
    private readonly movement: PlayerMovement | null;

    /** Held-key crouch, for the meep-native path; Q3 reads it off `UPMOVE`. */
    private crouching = false;

    attach(): void {
        if (this.attached) return;
        this.attached = true;

        this.devices.keyboard.on.down.add(this.onKeyDown);
        this.devices.pointer.on.move.add(this.onPointerMove);
        this.devices.pointer.on.down.add(this.onPointerDown);
        this.devices.pointer.on.wheel.add(this.onWheel);

        // Pointer lock is a DOM capability, not an input one, so this stays a
        // document listener. It is the only one left.
        document.addEventListener('pointerlockchange', this.onPointerLockChange);
    }

    detach(): void {
        if (!this.attached) return;
        this.attached = false;

        this.devices.keyboard.on.down.remove(this.onKeyDown);
        this.devices.pointer.on.move.remove(this.onPointerMove);
        this.devices.pointer.on.down.remove(this.onPointerDown);
        this.devices.pointer.on.wheel.remove(this.onWheel);

        document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    }

    /**
     * Weapon select only. Movement is polled from the switches instead, because
     * a held key is a state and an edge is a bad way to track one.
     */
    private readonly onKeyDown = (e: KeyboardEvent): void => {
        if (e.code === 'Space') e.preventDefault();

        const digit = e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
        const weapon = KEY_WEAPON.get(digit);
        if (weapon !== undefined) this.selectWeapon(weapon);
    };

    /**
     * `CG_WeaponSelectable`: you must own it and it must have ammo.
     *
     * Q3 silently ignores a select of an unusable weapon rather than beeping or
     * switching to the nearest usable one, which matters -- pressing 5 with no
     * rocket launcher must leave you holding what you had, mid-fight.
     */
    selectWeapon(weapon: WeaponId): boolean {
        if (!this.inventory.weapons.has(weapon)) return false;
        if ((this.inventory.ammo[weapon] ?? 0) === 0) return false;

        this.weapon = weapon;
        return true;
    }

    /** Mouse wheel, cycling through owned weapons in `weapon_t` order. */
    private cycleWeapon(direction: number): void {
        const at = WEAPON_ORDER.indexOf(this.weapon);
        const start = at < 0 ? 0 : at;

        for (let i = 1; i <= WEAPON_ORDER.length; i++) {
            const next =
                (start + direction * i + WEAPON_ORDER.length * i) % WEAPON_ORDER.length;
            if (this.selectWeapon(WEAPON_ORDER[next]!)) return;
        }
    }

    /**
     * The device suppresses the wheel event before it dispatches, so there is no
     * `preventDefault` to call here -- and nothing to call it on: the handler is
     * passed `(delta, position, event)`, and the event comes third.
     */
    private readonly onWheel: WheelHandler = (delta): void => {
        if (!this.active) return;

        // A purely horizontal or zero scroll is not a weapon change.
        if (delta.y === 0) return;

        this.cycleWeapon(delta.y);
    };

    /** First click takes the pointer lock; every click after it fires. */
    private readonly onPointerDown = (): void => {
        if (document.pointerLockElement !== this.element) {
            void takePointerLock(this.element);
        }
    };

    private readonly onPointerLockChange = (): void => {
        this.active = document.pointerLockElement === this.element;
        if (!this.active) this.attacking = false;
    };

    /**
     * @param delta pointer-lock movement, handed over by the device.
     *
     * meep reads `movementX`/`movementY` off the event and passes them as the
     * third argument, so this never touches the raw event -- which is also what
     * makes the device swappable for a gamepad or a replay.
     */
    private readonly onPointerMove: PointerMoveHandler = (_position, _event, delta): void => {
        /*
         A dead player does not turn, and the accumulator stops with the view.

         Freezing the view is `PM_UpdateViewAngles`'s own rule and comes for
         free once `ps.stats` is honest. Freezing the *accumulator* is this
         class's job and does not: without it the mouse keeps integrating
         behind a frozen camera and the whole two seconds of it arrives at once
         on respawn. Q3 avoids the same snap with `ps->delta_angles`, which is
         the server telling the client where it is now looking; there is no
         server here, so the client simply does not move while it is dead.
        */
        if (!this.active || this.dead) return;

        // `| 0` after each accumulation so yaw wraps in 32 bits and is then
        // truncated to 16 by `usercmd_t.angles`, exactly as the engine does.
        this.yaw = (this.yaw - delta.x * ANGLE_PER_PIXEL) | 0;
        this.pitch = (this.pitch + delta.y * ANGLE_PER_PIXEL) | 0;

        // `PM_UpdateViewAngles` clamps to +/-16000 (87.9 degrees) itself, but
        // clamping the raw command too stops the accumulator drifting far past
        // the limit while the player holds the mouse down.
        if (this.pitch > 16000) this.pitch = 16000;
        if (this.pitch < -16000) this.pitch = -16000;
    };

    /** True when any of the named meep keys is down. */
    private has(names: readonly string[]): boolean {
        const keys = this.devices.keyboard.keys;
        for (const name of names) if (keys[name]?.is_down === true) return true;
        return false;
    }

    /**
     * Advance the simulation by `deltaSeconds` and write the result to a meep
     * transform.
     */
    update(deltaSeconds: number, cameraTransform: TransformLike): void {
        // Q3 works in integer milliseconds. Clamping matches `PmoveSingle`'s own
        // 200 ms ceiling, so a backgrounded tab resumes without a teleport.
        const msec = Math.min(200, Math.max(1, Math.round(deltaSeconds * 1000)));
        this.time += msec;

        /*
         The one `playerState_t` field left that nothing maintained.

         `Bot` mirrors its health into `ps.stats` every frame and this class
         never did, so the player's copy sat at its spawn value forever. Three
         places in `bg_pmove` read it -- `PM_UpdateViewAngles` refuses to turn a
         corpse, `PmoveSingle` drops `CONTENTS_BODY` from the trace mask so a
         corpse can fall through players, and the medium-fall event is
         suppressed for the dead -- and none of them ever saw a dead player.

         Found by asking what `Bot` maintains that this does not, which is the
         same question that found D-072, D-074 and D-075. Unlike those three
         this one predates the movement rewrite and is wrong on both paths.
        */
        this.ps.stats[C.STAT_HEALTH] = this.inventory.health;

        const cmd = this.pmove.cmd;
        cmd.serverTime = this.time;
        cmd.angles[0] = this.pitch;
        cmd.angles[1] = this.yaw;
        cmd.angles[2] = 0;
        cmd.buttons = 0;
        cmd.weapon = 1;

        this.attacking =
            this.active && !this.dead && this.devices.pointer.mouseButtonLeft.is_down;
        this.crouching = this.active && this.has(KEY_CROUCH);

        if (this.active && !this.dead) {
            cmd.moves[FORWARDMOVE] =
                (this.has(KEY_FORWARD) ? 127 : 0) + (this.has(KEY_BACK) ? -127 : 0);
            cmd.moves[RIGHTMOVE] =
                (this.has(KEY_RIGHT) ? 127 : 0) + (this.has(KEY_LEFT) ? -127 : 0);
            cmd.moves[UPMOVE] =
                (this.has(KEY_JUMP) ? 127 : 0) + (this.has(KEY_CROUCH) ? -127 : 0);
        } else {
            cmd.moves[FORWARDMOVE] = 0;
            cmd.moves[RIGHTMOVE] = 0;
            cmd.moves[UPMOVE] = 0;
        }

        if (this.movement === null) {
            runPmove(this.pmove);
        } else {
            this.movement.step(this.pmove, this.crouching, deltaSeconds);
            /*
             ...and then the one thing `PM_Footsteps` did that the replacement
             does not. Q3's whole gait -- the footstep sounds, the view bob and
             the gun's sway -- is one counter on `playerState_t`, and the
             kinematic path (D-071) retired the function that turns it. Left
             unmaintained it sits at zero for the whole game, so a client reading
             it gets a player who never takes a step; a client reconstructing it
             from something else gets a second answer that can disagree with the
             ported path, and did (D-081).
            */
            this.updateBobCycle(msec);
        }

        this.fireIfReady(msec);

        this.writeCamera(cameraTransform);
    }

    /**
     * `PM_Footsteps`' cycle, for the path that no longer runs `PM_Footsteps`.
     *
     * The arithmetic is the C's, including the truncation: `bobCycle` is a byte
     * on Q3's wire, so the fraction of a cycle a frame does not fill is dropped
     * rather than carried, and reproducing that is what keeps the two movement
     * paths agreeing on a quantity a test can compare. It costs a little rate at
     * high frame rates, and it costs Q3 the same.
     *
     * Only the leg animations are missing from the port -- `PM_ContinueLegsAnim`
     * belongs to a character this player does not have -- and the events, which
     * this port raises from `Footsteps` rather than from an event queue.
     */
    private updateBobCycle(msec: number): void {
        const ps = this.ps;
        const cmd = this.pmove.cmd;

        // Airborne leaves the position in the cycle intact but does not advance.
        if (ps.groundEntityNum === C.ENTITYNUM_NONE) return;

        if (cmd.moves[FORWARDMOVE] === 0 && cmd.moves[RIGHTMOVE] === 0) {
            // Come to rest at the start of a stride, so the next one is level.
            if (this.movementSpeed < 5) ps.bobCycle = 0;
            return;
        }

        const bobmove = (ps.pm_flags & C.PMF_DUCKED) !== 0
            ? BOBMOVE_DUCKED
            : BOBMOVE_RUN;

        ps.bobCycle = Math.trunc(ps.bobCycle + bobmove * msec) & 255;
    }

    /** Horizontal speed, Q3 units/s -- whichever solver produced it. */
    get movementSpeed(): number {
        return Math.hypot(this.ps.velocity[0]!, this.ps.velocity[1]!);
    }

    /**
     * Q3's weapon timing: a fixed cooldown per shot, from the balance table.
     *
     * Counted in the same integer milliseconds the simulation runs on rather
     * than in seconds, so the fire rate is exactly the `addTime` value from
     * `PM_Weapon` and does not drift with frame rate.
     */
    private fireIfReady(msec: number): void {
        this.cooldownMs -= msec;

        if (!this.attacking || !this.active) return;
        if (this.cooldownMs > 0) return;
        if (this.onFire === null) return;

        /*
         `PM_Weapon`: no ammo means no shot and no cooldown reset, so holding
         the button on an empty weapon does nothing rather than dry-firing at
         the weapon's rate. Gauntlet's ammo is -1 and stays there.
        */
        const ammo = this.inventory.ammo[this.weapon] ?? 0;
        if (ammo === 0) {
            this.dryFireCooldownMs -= msec;
            if (this.dryFireCooldownMs <= 0) {
                this.dryFireCooldownMs = 500;
                this.onDryFire?.();
            }
            return;
        }
        if (ammo > 0) this.inventory.ammo[this.weapon] = ammo - 1;

        const ps = this.ps;
        const eye = [ps.origin[0]!, ps.origin[1]!, ps.origin[2]! + ps.viewheight];

        this.onFire(eye, ps.viewangles);

        this.cooldownMs = weaponStats(this.weapon).fireRateMs;
    }

    /** Q3 (Z-up, units) -> meep (Y-up, metres). The only place this happens. */
    private writeCamera(t: TransformLike): void {
        const ps = this.ps;

        const eyeZ = ps.origin[2]! + ps.viewheight;

        t.position.set(
            ps.origin[0]! * WORLD_SCALE,
            eyeZ * WORLD_SCALE,
            -ps.origin[1]! * WORLD_SCALE
        );

        // `ps.viewangles` is in degrees, Q3 convention: pitch positive is *down*.
        orientToQ3Angles(ps.viewangles, t.rotation);
    }

    /** Horizontal speed in Q3 units per second, for the debug readout. */
    /**
     * The player's current bounding box, in Q3 units relative to `ps.origin`.
     *
     * Read from `pmove` rather than assumed, because `PM_CheckDuck` shortens
     * `maxs[2]` from 32 to 16 while crouched -- and a trigger test against the
     * standing box would open a door you cannot fit through.
     */
    get mins(): ArrayLike<number> {
        return this.pmove.mins;
    }

    get maxs(): ArrayLike<number> {
        return this.pmove.maxs;
    }

    /** Face a given Q3 yaw. Used by teleporters, which choose your facing. */
    setYaw(degrees: number): void {
        this.yaw = Math.round((degrees * 65536) / 360) & 65535;
    }

    get speed(): number {
        return Math.hypot(this.ps.velocity[0]!, this.ps.velocity[1]!);
    }

    get onGround(): boolean {
        return this.ps.groundEntityNum !== C.ENTITYNUM_NONE;
    }

    /**
     * Is the player *asking* to move, which is what `PM_Footsteps` gates on.
     *
     * Not `speed > 0`: Q3 stops advancing the bob cycle the moment the keys come
     * up, so a slide to a halt stops bobbing straight away rather than coasting.
     * Read off the command rather than the input, so it is false while the
     * pointer is unlocked and false for a corpse, both of which the command fill
     * already handles.
     */
    get moving(): boolean {
        const moves = this.pmove.cmd.moves;
        return moves[FORWARDMOVE] !== 0 || moves[RIGHTMOVE] !== 0;
    }

    /**
     * `PMF_DUCKED`, which is the solver's answer rather than the key's.
     *
     * `PM_CheckDuck` refuses to stand you up under a ceiling, so the flag and
     * the crouch key disagree for as long as you are stuck under one -- and it
     * is the flag the animation and the bob rate follow.
     */
    get ducked(): boolean {
        return (this.ps.pm_flags & C.PMF_DUCKED) !== 0;
    }

    /**
     * Q3's own death test, and the inventory is the authority on it.
     *
     * `ps.stats[STAT_HEALTH]` is a mirror written once a frame in `update`, so
     * reading it here instead would be a frame stale in exactly the frame that
     * matters -- the one the killing shot landed in.
     */
    get dead(): boolean {
        return this.inventory.health <= 0;
    }
}
