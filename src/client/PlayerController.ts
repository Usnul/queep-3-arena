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
import { angleVectors, vec3, type Vec3, type Vec3Like } from '../q3/math.ts';
import { PM_PreviewViewAngles } from '../q3/pmove/pmove.ts';
import {
    createUserCmd,
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type PlayerState,
    type UserCmd,
} from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';
import {
    isWeaponId,
    WEAPON_ORDER as Q3_WEAPON_ORDER,
    type WeaponId,
} from '../game/Weapons.ts';
import type { Inventory } from '../game/Items.ts';
import type { MoverHost } from './MeepMove.ts';
import { BUTTON_CROUCH, PlayerSlot, type StepSink } from '../game/PlayerSlot.ts';
import type { MoverSource, PhysicsTraceBackend } from '../game/PmoveHost.ts';
import { takePointerLock } from './pointerLock.ts';
import {
    DEAD_VIEW_PITCH,
    DEAD_VIEW_ROLL,
    firstPersonView,
    viewPose,
    ViewKick,
    type ViewPose,
} from './viewOffset.ts';

/*
 Re-exported because `main.ts` and `PhysicsWorld` both name it, and moving the
 definition into `PmoveHost` should not move every import with it.
*/
export type { PhysicsTraceBackend };

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

/**
 * The part of a meep `Transform` this writes. Exported because the systems in
 * `app/systems.ts` hold one to hand back in, and a second hand-written copy of
 * the shape would be a second thing that can stop matching.
 */
export interface TransformLike {
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
    /*
     `AngleVectors` rather than the two lines this used to be, because the third
     angle now carries something. `CG_OffsetFirstPersonView` rolls the view about
     its own forward -- the strafe lean, the per-stride sway, the 40 degrees a
     corpse lies at -- and a rotation built from a world-up basis throws every
     one of them away silently: the forward is identical, so a test that asserts
     where the gun points still passes on a camera that never tilts.

     Up rather than world-up is also *more* correct at roll zero rather than
     merely equivalent: `_lookRotation` orthonormalises, and Q3's up at any pitch
     lies in the plane of the forward and the world up, so the basis it lands on
     is the one this always produced.
    */
    angleVectors(viewanglesQ3, t_forward, null, t_up);

    out._lookRotation(
        t_forward[0]!,
        t_forward[2]!,
        -t_forward[1]!,
        t_up[0]!,
        t_up[2]!,
        -t_up[1]!
    );
}

/** Scratch for {@link orientToQ3Angles}, which runs once per rendered frame. */
const t_forward: Vec3 = vec3();
const t_up: Vec3 = vec3();

/** `cg.refdefViewAngles`: the aim plus the view offsets, built per frame. */
const scratchAngles: Vec3 = vec3();

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
const KEY_CROUCH = ['ctrl', 'c'];
/*
 `+speed`, and shift held it here for one release because crouch had it. Q3's
 shift does not crouch: `cl_run` is on by default, so holding it *walks* -- half
 speed, a slower bob and silent feet. It is a modifier over the whole command
 rather than a key of its own, which is why it is `CL_KeyMove`'s `movespeed` and
 not another `moves` term. See `WALK_MOVESPEED`.
*/
const KEY_WALK = ['shift'];

/**
 * `CL_KeyMove`'s two `movespeed` values.
 *
 * Q3 does not have a walk *state*: it fills the command with a shorter vector
 * and lets `PM_CmdScale` do the rest, which is `speed * max / (127 * total)` --
 * so a 64-magnitude command asks for 64/127 of `ps.speed`, about 161 u/s, and
 * every other term (friction, air control, the duck clamp) keeps working
 * against it unchanged. Reproducing that as a speed multiplier somewhere in the
 * motor would be the letter over the spirit, and would need a second copy of
 * the rule that stops diagonals being faster.
 *
 * `BUTTON_WALKING` rides along because it is what the *presentation* reads:
 * `PM_Footsteps` slows the bob and plays no footfall from it, and the ported
 * path picks that up for free.
 */
const RUN_MOVESPEED = 127;
const WALK_MOVESPEED = 64;

/**
 * `cg_local.h`'s `WEAPON_SELECT_TIME`: how long the weapon rack stays up.
 *
 * 1400 ms after the last change, which is Q3's own number and is long enough to
 * cycle two notches without the readout blinking between them.
 */
const WEAPON_SELECT_TIME = 1400;

/**
 * How much of a one-step rise is a stair rather than a ramp, as a multiple of
 * the horizontal distance covered in the same step.
 *
 * Q3 does not need this: `PM_StepSlideMove` raises `EV_STEP_*` only when the
 * plain slide was blocked and the step-up rescued it, so walking up an incline
 * raises no event at all. `KinematicMover` performs the same explicit step-up
 * and reports nothing about it -- `MoveResult` is `hit`, `landed` and
 * `landingSpeed` -- so the event has to be inferred from the pose, and the thing
 * it has to be told apart from is a ramp.
 *
 * The steepest surface Q3 will walk up has a normal `z` of 0.7
 * (`MIN_WALK_NORMAL`), which is a slope of `sqrt(1 - 0.49) / 0.7 = 1.02`: a
 * player on the limit gains a hair more height than ground. Anything above that
 * ratio was not walked up, it was stepped onto. The margin is for the ramp whose
 * last step lands partly on the flat above it.
 */
const STAIR_RISE_RATIO = 1.2;

/** `PM_StepSlideMove` ignores a rise below this, and so does the inference. */
const STAIR_MIN_RISE = 2;

/**
 * What the mouse wheel cycles: `weapon_t`, filtered to what this port can fire.
 *
 * It used to be nine names written out here, and it stopped at `WP_BFG` --
 * which is where Q3's list stops being the *original* game's. `weapon_t` has
 * four more after it, and three of them are weapons `am_thornish` places on the
 * floor: the nailgun, the prox launcher and the chaingun. Picking one up
 * autoswitched to it, as `Pickup_Weapon` does, and then there was no way back to
 * it -- not a key, not the wheel -- so the second time you held a chaingun was
 * never. That reads exactly like "this weapon does not draw in first person",
 * which is how it was reported.
 *
 * Derived from the extracted enum rather than retyped, and filtered by
 * `isWeaponId` rather than by a list: a weapon reaches this only if
 * `balance.weapons` has numbers for it, which is the same crossing D-114 built
 * and the same one `give` uses. That leaves exactly the grappling hook out,
 * which is not a damage weapon and has nothing here to fire.
 */
export const WEAPON_ORDER: readonly WeaponId[] = Q3_WEAPON_ORDER.filter(isWeaponId);

/**
 * The number row, which is Q3's own default binds and stops at nine.
 *
 * `weapon 1` through `weapon 9`, and nothing past them: Team Arena added
 * `weapon 10`..`weapon 13` as console commands and bound none of them, so the
 * four weapons after the BFG have never had a key in any shipping Quake III.
 * Inventing one here would be inventing a binding rather than porting one, and
 * the wheel already reaches them -- see {@link WEAPON_ORDER}, which is where the
 * fix for "I could not get back to the chaingun" actually lives.
 */
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
    /**
     * The simulation half, which the host and a networked client also run.
     *
     * Public because everything downstream of a player -- weapons, items, the
     * HUD, character placement -- reads `ps` and the inventory off it, and
     * because `PlayerSystem` drives the step through it. What stays on this
     * class is what a headless peer has no use for: the keyboard, the mouse
     * accumulator, and the two-step pose history the camera is blended from.
     */
    readonly slot: PlayerSlot;

    private readonly element: HTMLElement;
    private readonly devices: InputDevices;

    /** 16-bit view angles, as `usercmd_t.angles` carries them. */
    private yaw = 0;
    private pitch = 0;

    private time = 0;

    /** Sub-millisecond remainder of the step, carried rather than rounded off. */
    private msecCarry = 0;

    private attached = false;

    /** Set true while the pointer is locked; movement input is ignored otherwise. */
    active = false;

/**
     * Health, armour, ammo and owned weapons. The slot's, forwarded.
     *
     * Lives beside the movement state because Q3 keeps it in `playerState_t`,
     * and because weapon selection and firing both consult it every frame.
     */
    get inventory(): Inventory {
        return this.slot.inventory;
    }

    /** Currently selected weapon. The slot's, forwarded. */
    get weapon(): WeaponId {
        return this.slot.weapon;
    }

    set weapon(value: WeaponId) {
        this.slot.weapon = value;
    }

    /** `playerState_t`. The slot's, forwarded. */
    get ps(): PlayerState {
        return this.slot.ps;
    }

    /**
     * Brush entities the ported clipmap has to be clipped against.
     *
     * Set after construction, because the mover simulation needs the map's
     * entity list and the controller needs a spawn point from the same list.
     * Ignored entirely on the physics backend, which sees movers as bodies.
     */
    get movers(): MoverSource | null {
        return this.slot.movers;
    }

    set movers(value: MoverSource | null) {
        this.slot.movers = value;
    }

    /**
     * True on the frames the attack button is held.
     *
     * Polled from `pointer.mouseButtonLeft` each frame rather than tracked
     * across down/up edges. An edge-tracked flag survives a lost pointer lock,
     * an alt-tab, or a button released over a different element, and the
     * symptom is a weapon that keeps firing after you let go.
     */
    attacking = false;

    /**
     * `EF_FIRING`: the trigger is held on a weapon that can answer it.
     *
     * A different question from {@link attacking}, and from "a shot was fired".
     * `g_active.c` sets this flag every frame from
     *
     * ```c
     * !( ps->pm_flags & PMF_RESPAWNED ) && ps->pm_type != PM_INTERMISSION
     *     && ( client->buttons & BUTTON_ATTACK ) && client->ps.ammo[ps->weapon]
     * ```
     *
     * so it is up for the *whole* time the button is down and not for the
     * instants a round leaves the barrel -- which is exactly the difference
     * between a barrel that winds up and one that ticks round once per shot.
     * The presentation needs it and nothing else does; `fireIfReady` still owns
     * whether a shot actually happens.
     *
     * {@link attacking} already carries `active && !dead`, which is what the two
     * `pm_` tests amount to here; `active` is repeated below so the getter is
     * total rather than dependent on where `attacking` happens to be written.
     * The ammo test is `!== 0` rather than `> 0` because Q3's is a plain C truth
     * test and the gauntlet's ammo is **-1** -- which is how a weapon with no
     * ammunition at all still spins its blade.
     */
    get firing(): boolean {
        if (!this.attacking || !this.active) return false;

        return (this.inventory.ammo[this.weapon] ?? 0) !== 0;
    }

    /** Raised when the weapon should fire; the arena wires this to `WeaponSystem`. */
    onFire: ((eyeQ3: Vec3Like, anglesQ3: ArrayLike<number>) => void) | null = null;

    /** Raised when the attack button is held on an empty weapon. */
    onDryFire: (() => void) | null = null;

    /**
     * `CG_OffsetFirstPersonView`'s timed offsets, and the events that set them.
     *
     * Owned here because every one of its inputs is: the landing speed comes
     * back from `PlayerMovement.step`, the viewheight change is `PM_CheckDuck`'s,
     * and the stair rise is this class comparing two steps of `ps.origin`.
     */
    private readonly kick = new ViewKick();

    /**
     * The last two fixed steps' eye poses, newest in `view[1]`.
     *
     * The camera is written at *render* rate from a blend of these -- see
     * {@link writeCamera}. Two of them rather than one because the simulation
     * advances 60 times a second and the display does not, and a camera that
     * holds a pose for two frames and then jumps makes everything drawn through
     * it judder: the fixed step is invisible in a rocket that glides and
     * extremely visible in the wall behind it.
     */
    private readonly view: [ViewPose, ViewPose] = [viewPose(), viewPose()];

    /** `ps.viewheight` at the end of the previous step, for the duck settle. */
    private previousViewheight = 0;

    /** `ps.origin[2]` at the end of the previous step, for the stair catch-up. */
    private previousHeight = 0;

    /** Horizontal distance covered by the previous step; see {@link recordView}. */
    private previousStride = 0;

    /**
     * `cg.weaponSelectTime`: milliseconds left on the weapon-select readout.
     *
     * Q3 draws the rack for `WEAPON_SELECT_TIME` after any weapon change and
     * hides it again, which is what the HUD reads this for.
     */
    private weaponSelectMs = 0;

    /** False until the first step has filled both halves of {@link view}. */
    private viewSeeded = false;

    /**
     * @param traceBackend `'physics'` runs `pm->trace` on meep's physics
     *   (D-029, the shipping configuration); `'clipmap'` runs the ported
     *   `cm_trace`, which is the path measured against the C and is what the
     *   physics backend is tuned against.
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
         The simulation, built once and shared with nothing on this path -- but
         the same class the host builds one of per player and a networked client
         builds one of for itself. `?move=q3` is `moverHost === null`, which
         runs the ported `bg_pmove` whole; both solvers write the same
         `playerState_t`, so nothing downstream can tell which one ran.
        */
        this.slot = new PlayerSlot({ cm, spawnQ3, physics, moverHost });
    }

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
        if (!this.slot.canSelect(weapon)) return false;

        /*
         `cg.weaponSelectTime = cg.time`, which `CG_DrawWeaponSelect` counts
         `WEAPON_SELECT_TIME` from. Reset on every successful select, including
         a re-select of the weapon already in hand -- Q3 does the same, and it is
         what lets a player tap a key to *look* at the rack.
        */
        this.weaponSelectMs = WEAPON_SELECT_TIME;

        this.weapon = weapon;
        return true;
    }

    /**
     * `CG_DamageFeedback`: throw the head back, because something hurt.
     *
     * **Told, not inferred, and the difference is a bug this shipped once.** The
     * first version of this watched `inventory.health` fall between two steps
     * and treated any drop as damage. `ClientTimerActions` bleeds one point a
     * second off health above `maxHealth`, and a Q3 player spawns with 125 --
     * so every spawn and every respawn was followed by twenty-five seconds of a
     * once-a-second kick, at the full five degrees, because `CG_DamageFeedback`
     * clamps *up* to five and one point of bleed is otherwise 0.3. It came back
     * described as cyclic jerking of the aim that stopped on its own, which is
     * exactly what it was.
     *
     * Q3 does not infer it either: `CG_DamageFeedback` is driven by
     * `ps->damageEvent`, which `G_Damage` raises and `ClientTimerActions` does
     * not. So this is called by the two things that actually damage the player
     * -- `Arena.hit` for a shot and `WorldEffectSystem` for a `trigger_hurt` --
     * and health that merely goes down is health that merely goes down.
     *
     * Presentation only, exactly as the C is: `CG_DamageFeedback` does not apply
     * the damage, because the server already did. The health is written by the
     * caller.
     *
     * @param damage points of *health* lost. A hit fully absorbed by armour
     *   arrives as zero and is ignored, where Q3 would still kick for it --
     *   `EV_DAMAGE` carries `damage_blood + damage_armor` and this port's hit
     *   event carries only the first. A small loss, and recorded rather than
     *   papered over.
     */
    damaged(damage: number): void {
        this.kick.damage(damage, this.inventory.health);
    }

    /**
     * Is the weapon rack up? `cg.weaponSelectTime` against `WEAPON_SELECT_TIME`.
     *
     * A timeout rather than a key-held state because that is what Q3 does and
     * because the wheel has no "held": the rack appears on a change and leaves
     * on its own, so a player who is switching can see what they are switching
     * to and a player who is not gets their screen back.
     */
    get weaponSelectVisible(): boolean {
        return this.weaponSelectMs > 0;
    }

    /** Owned weapons in `weapon_t` order -- what the rack draws. */
    get ownedWeapons(): WeaponId[] {
        return WEAPON_ORDER.filter((w) => this.inventory.weapons.has(w));
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
     * Advance the simulation by `deltaSeconds`, on the fixed step.
     *
     * The camera is **not** written here any more; {@link writeCamera} is a
     * render-rate call and this only records the pose it blends between. See
     * that method for why.
     */
    update(deltaSeconds: number): void {
        /*
         Q3 works in integer milliseconds, so the fractional part of a step is
         carried rather than rounded away. `MoverSystem` has always done this;
         this used to round instead, and on the engine's 60 Hz fixed step
         rounding gives 17 ms for a 16.667 ms step -- every step, for ever, so
         the player's clock runs two percent fast against the world's. Carrying
         gives 17, 16, 17, 17, 16 ... which sums exactly and is identical from
         one run to the next, which is the property that matters.

         Clamping matches `PmoveSingle`'s own 200 ms ceiling, so a backgrounded
         tab resumes without a teleport. Clamped time is time thrown away, and
         the accumulator is dropped with it -- resuming is a discontinuity by
         definition and carrying a second of arrears into it would be worse.
        */
        this.msecCarry += deltaSeconds * 1000;
        let msec = Math.floor(this.msecCarry);
        this.msecCarry -= msec;

        if (msec > 200) {
            msec = 200;
            this.msecCarry = 0;
        } else if (msec < 1) {
            msec = 1;
        }

        this.time += msec;

        this.sampleCommand();

        this.slot.step(
            this.command,
            { frame: this.frameNumber++, msec, dt: deltaSeconds, timeMs: this.time },
            this.sink
        );

        this.weaponSelectMs = Math.max(0, this.weaponSelectMs - msec);

        this.recordView(msec);
    }

    /**
     * The keyboard and the mouse, as one `usercmd_t`. Nothing else.
     *
     * Public so a networked client can sample without stepping: it hands the
     * command to the session, which executes it as a `UserCmdAction` at the
     * frame it is tagged with, on this machine as a prediction and on the host
     * as the truth. Single-player samples and steps in the same breath, which
     * is what `update` does above.
     *
     * The command is reused between frames. Whoever takes it copies it; holding
     * on to it is holding on to next frame's input as well.
     */
    sampleCommand(): UserCmd {
        const cmd = this.command;

        cmd.angles[0] = this.pitch;
        cmd.angles[1] = this.yaw;
        cmd.angles[2] = 0;
        cmd.buttons = 0;
        cmd.weapon = 0;

        this.attacking =
            this.active && !this.dead && this.devices.pointer.mouseButtonLeft.is_down;

        /*
         `BUTTON_ATTACK` goes on the command rather than staying a field the
         step reads off this object, because the step now runs on a machine with
         no mouse. Q3's own client has always set it; this port never did only
         because the fire decision and the mouse lived in one class. The flag
         beside it stays, because the presentation asks it once a frame for the
         barrel spin and the muzzle glow.
        */
        if (this.attacking) cmd.buttons |= C.BUTTON_ATTACK;

        /*
         And the crouch, which Q3 reads off `UPMOVE`'s sign and this port has
         always taken as a separate held key -- see `BUTTON_CROUCH`. Set outside
         the alive branch below because that is where it has always been
         computed: a dead player holding crouch still carries the flag, and it
         is only the moves that are zeroed.
        */
        if (this.active && this.has(KEY_CROUCH)) cmd.buttons |= BUTTON_CROUCH;

        if (this.active && !this.dead) {
            /*
             `CL_KeyMove`, which scales the whole command rather than any one
             axis: "the walking flag is to keep animations consistent even
             during acceleration and deceleration".
            */
            const walking = this.has(KEY_WALK);
            const movespeed = walking ? WALK_MOVESPEED : RUN_MOVESPEED;

            // Rebuilt from the key every frame, off a `buttons` this method
            // zeroed above. A modifier that latches is the bug this port has
            // already shipped once, in the crouch that could not be released.
            if (walking) cmd.buttons |= C.BUTTON_WALKING;

            cmd.moves[FORWARDMOVE] =
                (this.has(KEY_FORWARD) ? movespeed : 0) + (this.has(KEY_BACK) ? -movespeed : 0);
            cmd.moves[RIGHTMOVE] =
                (this.has(KEY_RIGHT) ? movespeed : 0) + (this.has(KEY_LEFT) ? -movespeed : 0);
            cmd.moves[UPMOVE] =
                (this.has(KEY_JUMP) ? movespeed : 0) + (this.has(KEY_CROUCH) ? -movespeed : 0);
        } else {
            cmd.moves[FORWARDMOVE] = 0;
            cmd.moves[RIGHTMOVE] = 0;
            cmd.moves[UPMOVE] = 0;
        }

        return cmd;
    }

    /**
     * This frame's input. Reused; see {@link sampleCommand}.
     *
     * Its own command rather than the `pmove_t`'s: the step copies it into the
     * one it owns and both solvers then *mutate* that copy (`PM_CmdScale`
     * clears BUTTON_WALKING for a run), so a shared array would hand the next
     * frame's sampler a command the last frame had edited.
     */
    private readonly command: UserCmd = createUserCmd();

    /**
     * The frame the step is told it is running, counted here.
     *
     * Single-player has no shared clock to take one from -- the number exists
     * so the sink can key a side effect by frame, which only the networked host
     * needs to do -- so it is a plain counter and nothing reads it back.
     */
    private frameNumber = 0;

    /**
     * What the step reports back: a shot, an empty click, a landing.
     *
     * All three used to be inline in `update`; they are a sink now because the
     * host plays a real shot where a client plays a predicted flash, and both
     * run the same step to decide it happened.
     */
    private readonly sink: StepSink = {
        fired: (_weapon, eyeQ3, anglesQ3) => {
            this.onFire?.(eyeQ3, anglesQ3);
        },
        dryFired: () => {
            this.onDryFire?.();
        },
        landed: (speed) => {
            this.kick.land(speed);
        },
    };

    /**
     * Snapshot the eye for this step, and raise the events the view kicks need.
     *
     * The two poses are what {@link writeCamera} blends between. Everything here
     * is `CG_TransitionPlayerState`'s work -- the two-frame differences Q3's
     * client takes between snapshots -- done against the previous fixed step
     * rather than against a server snapshot, because there is no server.
     */
    private recordView(msec: number): void {
        const ps = this.ps;

        this.kick.advance(msec);

        /*
         Both of these are *differences* against the previous step, and on the
         first step there is no previous step -- the fields are zero and the
         differences are therefore the player's whole viewheight and their
         absolute altitude. Left ungated that is a 26-unit duck settle and a
         stair dip on the frame the game starts, which reads as the camera
         falling into the floor at spawn.
        */
        if (this.viewSeeded) {
            // `if ( ps->viewheight != ops->viewheight )`: the crouch settle.
            this.kick.duck(ps.viewheight - this.previousViewheight);

            /*
             `EV_STEP_*`, inferred. See `STAIR_RISE_RATIO` for why the horizontal
             distance is in the test and why it has to be the *previous* step's:
             the rise being judged happened over the step that has just run, and
             the stride that produced it is the one measured at the end of the
             one before.

             `STEPSIZE` is the upper bound and it is not belt-and-braces: Q3
             cannot step higher than 18 units, so anything above that was not a
             step at all. It is what keeps a respawn, a teleport and a jump pad
             -- all of which move `ps.origin` from outside the solver -- from
             reading as the tallest stair in the game.
            */
            const rise = ps.origin[2]! - this.previousHeight;

            if (
                this.onGround &&
                rise >= STAIR_MIN_RISE &&
                rise <= C.STEPSIZE &&
                rise > this.previousStride * STAIR_RISE_RATIO
            ) {
                this.kick.step(rise);
            }
        }

        this.previousViewheight = ps.viewheight;
        this.previousHeight = ps.origin[2]!;
        this.previousStride = Math.hypot(ps.velocity[0]!, ps.velocity[1]!) * (msec / 1000);

        // Newest last, oldest first, and the pair is reused rather than rotated
        // so nothing allocates on the fixed step.
        const previous = this.view[0];
        const latest = this.view[1];

        previous.eyeQ3[0] = latest.eyeQ3[0]!;
        previous.eyeQ3[1] = latest.eyeQ3[1]!;
        previous.eyeQ3[2] = latest.eyeQ3[2]!;
        previous.pitch = latest.pitch;
        previous.roll = latest.roll;
        previous.dead = latest.dead;

        firstPersonView(
            {
                originQ3: ps.origin,
                velocityQ3: ps.velocity,
                viewanglesQ3: ps.viewangles,
                viewheight: ps.viewheight,
                bobCycle: ps.bobCycle,
                ducked: this.ducked,
                dead: this.dead,
            },
            this.kick,
            latest
        );

        if (!this.viewSeeded) {
            // The first step has no previous pose to blend from, and blending
            // from the zero one puts the camera at the world origin for a frame.
            this.viewSeeded = true;
            previous.eyeQ3[0] = latest.eyeQ3[0]!;
            previous.eyeQ3[1] = latest.eyeQ3[1]!;
            previous.eyeQ3[2] = latest.eyeQ3[2]!;
            previous.pitch = latest.pitch;
            previous.roll = latest.roll;
            previous.dead = latest.dead;
        }
    }

    /** Horizontal speed, Q3 units/s -- whichever solver produced it. */
    get movementSpeed(): number {
        return this.slot.speed;
    }

    /**
     * The mouse accumulator in `usercmd_t`'s 16-bit units, for {@link writeCamera}.
     *
     * Its own array rather than `pmove.cmd.angles`: that one is the step's, it
     * is read back by `fireIfReady` and by both solvers, and a render-rate write
     * into it would be the presentation editing a simulation input several times
     * per step.
     */
    private readonly liveCommand = new Int16Array(3);

    /** {@link PM_PreviewViewAngles}' answer, degrees. Reused, never allocated. */
    private readonly liveAngles: Vec3 = vec3();

    /**
     * Q3 (Z-up, units) -> meep (Y-up, metres). The only place this happens.
     *
     * **Called once per rendered frame, not once per fixed step**, and that is
     * the fix for the judder that was reported as projectiles moving in jerks.
     * A missile is a physics body carrying `Interpolated`, so meep blends it
     * between fixed steps and it glides; the camera was written on the fixed
     * step and did not, so the *world* advanced in 60 Hz stairs while one bright
     * object in it moved smoothly. Measured on `am_thornish` at 165 Hz before
     * the fix: the camera's x held for two or three frames and then jumped
     * 0.167 m, every time, for ever.
     *
     * Two quantities and two treatments, which is the whole design:
     *
     * - **The eye position and the view kicks are blended** across the step, at
     *   `alpha`. They are simulation outputs, they cannot be recomputed at
     *   render rate without re-running the solver, and being one step behind is
     *   worth 16 ms of position lag nobody can see.
     * - **The view angles are read live**, from the same accumulator the mouse
     *   writes. Blending those would put a frame of lag on *aim*, which in an
     *   arena shooter is the one thing that must not lag. Q3 does not blend them
     *   either -- it re-runs the whole prediction every rendered frame -- and
     *   this is the half of that which is cheap.
     *
     * **Live means the accumulator, and it did not for one release.** This read
     * `ps.viewangles`, which is the accumulator *as of the last fixed step* --
     * `PM_UpdateViewAngles` is the only thing that writes it and only a step
     * runs it. So the eye was blended and the heading was not, and the fix above
     * was half applied: the world's position glided at display rate while the
     * world's heading advanced in 60 Hz stairs. It came back described as the
     * mouse moving the camera in jerks, which is precisely what it is -- at 165
     * Hz the heading holds for two or three frames and then jumps the whole
     * step's worth of turn. {@link PM_PreviewViewAngles} runs the same 16-bit
     * truncation and the same clamp against the live accumulator, writing
     * nothing. See D-155.
     *
     * **The shot still leaves along `ps.viewangles`, and that is not the cost it
     * looks like.** The obvious objection to a live camera is that the view and
     * the bullet now come off different clocks. They do, but `fireIfReady` runs
     * *inside* the step, after `PM_UpdateViewAngles` has already taken this same
     * accumulator -- so a shot goes out along the freshest angle there is, and
     * the only question is how far the last frame the player *saw* was from it.
     * That distance gets **smaller**, because the frame is now current too.
     * Measured on `oa_dm1` at 165 Hz, 3 px of mouse per frame, as the angle
     * between the heading drawn on a frame and the heading the next step fires
     * along: mean 0.557 degrees before, 0.377 after, same 0.593 worst case (the
     * frame that lands on a step, where the two agree by construction). The old
     * camera was not merely jerky, it was showing an aim up to a whole step
     * behind the one the trigger would use.
     *
     * @param alpha `EntityManager.getFixedStepAlpha()`: how far the display is
     *   into the step that has not run yet. 1 lands exactly on the latest pose.
     */
    writeCamera(t: TransformLike, alpha = 1): void {
        const previous = this.view[0];
        const latest = this.view[1];

        const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

        const x = previous.eyeQ3[0]! + (latest.eyeQ3[0]! - previous.eyeQ3[0]!) * a;
        const y = previous.eyeQ3[1]! + (latest.eyeQ3[1]! - previous.eyeQ3[1]!) * a;
        const z = previous.eyeQ3[2]! + (latest.eyeQ3[2]! - previous.eyeQ3[2]!) * a;

        t.position.set(x * WORLD_SCALE, z * WORLD_SCALE, -y * WORLD_SCALE);

        /*
         `ps.viewangles` is in degrees, Q3 convention: pitch positive is *down*.
         The offsets `CG_OffsetFirstPersonView` produces are added to it rather
         than baked into it, because the simulation has to keep aiming down the
         angles the player asked for -- `WeaponSystem.fire` reads the same array
         and a rocket that left along the view bob would be a rocket whose
         accuracy is a function of which foot you were on.

         A dead player's angles are the corpse's outright, not an offset: Q3
         pins roll to 40 and pitch to -15 and stops adding anything at all.
        */
        const ps = this.ps;

        /*
         The accumulator as `usercmd_t` would carry it. Truncating through an
         `Int16Array` rather than masking by hand is what makes this the same
         quantity the step will see: `angles` is a short on Q3's wire, `setYaw`
         writes an unsigned 16-bit yaw and the mouse writes a signed 32-bit one,
         and the array is where those two become one number.
        */
        this.liveCommand[0] = this.pitch;
        this.liveCommand[1] = this.yaw;
        this.liveCommand[2] = 0;

        // False is a view pmove would not have turned -- a corpse or an
        // intermission -- and then `ps.viewangles` is current by definition.
        const view = PM_PreviewViewAngles(ps, this.liveCommand, this.liveAngles)
            ? this.liveAngles
            : ps.viewangles;

        if (latest.dead) {
            scratchAngles[0] = DEAD_VIEW_PITCH;
            scratchAngles[1] = view[1]!;
            scratchAngles[2] = DEAD_VIEW_ROLL;
        } else {
            scratchAngles[0] =
                view[0]! + previous.pitch + (latest.pitch - previous.pitch) * a;
            scratchAngles[1] = view[1]!;
            scratchAngles[2] =
                view[2]! + previous.roll + (latest.roll - previous.roll) * a;
        }

        orientToQ3Angles(scratchAngles, t.rotation);
    }

    /**
     * The player's current bounding box, in Q3 units relative to `ps.origin`.
     *
     * Read from `pmove` rather than assumed, because `PM_CheckDuck` shortens
     * `maxs[2]` from 32 to 16 while crouched -- and a trigger test against the
     * standing box would open a door you cannot fit through.
     */
    get mins(): ArrayLike<number> {
        return this.slot.pmove.mins;
    }

    get maxs(): ArrayLike<number> {
        return this.slot.pmove.maxs;
    }

    /** Face a given Q3 yaw. Used by teleporters, which choose your facing. */
    setYaw(degrees: number): void {
        this.yaw = Math.round((degrees * 65536) / 360) & 65535;
    }

    /** Horizontal speed in Q3 units per second. Scales the view weapon's sway. */
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
        const moves = this.slot.pmove.cmd.moves;
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
     * `BUTTON_WALKING`: is the player holding `+speed`?
     *
     * Read back off the command rather than the key, for the same reason
     * `moving` is: the command is where "active", "dead" and the key have
     * already been resolved into one answer, and it is the same answer both
     * solvers were given.
     */
    get walking(): boolean {
        return (this.slot.pmove.cmd.buttons & C.BUTTON_WALKING) !== 0;
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
