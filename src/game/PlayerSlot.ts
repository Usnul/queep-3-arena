/*
 * PlayerSlot.ts -- one player's frame, on whichever machine is running it.
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
 * Q3's `ClientThink_real`, and the reason it is its own file is networking.
 *
 * `PlayerController` used to be three things wearing one coat: it sampled the
 * keyboard and the mouse, it advanced the simulation, and it kept the pose
 * history the camera is drawn from. A networked game needs the middle third to
 * run in three places -- on the host for every slot, on a client for its own
 * slot as a prediction, and on that same client again for every frame of a
 * reconciliation replay -- and two of those three have no keyboard and no
 * camera. So the middle third is here, ECS-free and renderer-free, and
 * `PlayerController` keeps the other two.
 *
 * **Every input is an argument and every output is state.** `step` reads a
 * `usercmd_t` and a clock and writes `ps`, the `MoveState` and the inventory;
 * it holds no accumulator, no wall clock and no counter of its own. That is not
 * tidiness, it is the property a rollback needs: the host rewinds by restoring
 * two replicated components and replaying, so any number the step carried
 * between frames outside those components would survive the rewind while
 * everything around it went back, and the replay would run from a mixture of
 * two frames. {@link load} and {@link store} are the whole of what a frame
 * carries, and `test/player-slot.test.ts` asserts a run is bit-identical across
 * a round trip through them mid-flight.
 *
 * **The one deviation from `NETWORK_PLAN.md` §3.4**: the plan has `step`
 * compute `msec = frameMsec(frame)` itself. It takes the millisecond from the
 * caller instead, because single-player must stay bit-identical through this
 * step and single-player does not have a frame number -- it has
 * `PlayerController`'s sub-millisecond carry over `deltaSeconds`, which spends
 * 16, 17, 16, 17, 17 where `frameMsec` spends 16, 17, 17, 16, 17. Both sum
 * exactly and both only ever spend 16 or 17; they are not the same sequence, and
 * a test suite that drives the controller at 125 Hz would have every timed
 * quantity in it doubled by the swap. So the clock is an argument: the
 * networked path passes `frameMsec(frame)` and single-player passes its carry,
 * and neither has to know about the other.
 */

import { createPmoveHost, type MoverSource, type PhysicsTraceBackend } from './PmoveHost.ts';
import { newInventory, type Inventory } from './Items.ts';
import { weaponStats, type WeaponId } from './Weapons.ts';
import {
    NET_PMF_WALKING,
    NET_WEAPONS,
    NET_WEAPON_COUNT,
    weaponAt,
    weaponIndex,
    type NetInventory,
    type NetPlayerState,
} from '../net/components.ts';
import { clamp } from '@woosh/meep-engine/src/core/math/clamp.js';

import { PlayerMovement, type MoverHost } from '../client/MeepMove.ts';
import type { ClipMap } from '../q3/cm/ClipMap.ts';
import { vec3, type Vec3Like } from '../q3/math.ts';
import { Pmove as runPmove } from '../q3/pmove/pmove.ts';
import { advanceBobCycle, isWalking } from './bobCycle.ts';
import * as C from '../q3/pmove/constants.ts';
import {
    FORWARDMOVE,
    RIGHTMOVE,
    type Pmove,
    type PlayerState,
    type UserCmd,
} from '../q3/pmove/types.ts';

/**
 * Crouch, as a command button. **Not Q3's.**
 *
 * Q3 has no crouch bit: `PM_CheckDuck` reads `cmd.upmove < 0`, and a player
 * holding jump and crouch together therefore does not duck. This port's
 * `MeepMove` took the crouch as a separate boolean argument from the start
 * (`MoveCommand.crouch`, "crouch is a held key rather than an axis here"), which
 * was fine while the only caller was the machine the key was pressed on.
 *
 * It is not fine on a wire: a host has no keyboard, so anything the step reads
 * must be inside the `usercmd_t` the client sent. Bit 32 is free -- Q3 uses
 * 1, 2, 4, 8 and 16, and the ported `bg_pmove` tests only 1, 2, 4 and 16 -- so
 * the crouch travels as a button and the behaviour is unchanged, including the
 * jump-and-crouch case, which this port answers "ducked" and Q3 answers
 * "not ducked".
 */
export const BUTTON_CROUCH = 32;

/**
 * What a frame is worth, decided by the caller.
 *
 * Four numbers rather than one, because they come from three different places
 * and conflating them is how a networked simulation drifts:
 *
 * - `frame` is the sim frame number. The step does not read it; it hands it to
 *   the sink, which uses it to key side effects that must not repeat under a
 *   rollback replay.
 * - `msec` is Q3's integer millisecond -- every timer in the game runs on it.
 * - `dt` is what the solver integrates with, in seconds. Not `msec / 1000`:
 *   `MeepMove` has always been handed the engine's exact step and rounding it
 *   to the millisecond would change the movement.
 * - `timeMs` is `usercmd_t.serverTime`, the running total. Supplied rather than
 *   accumulated so that a replayed frame gets the same value it got the first
 *   time.
 */
export interface StepClock {
    readonly frame: number;
    readonly msec: number;
    readonly dt: number;
    readonly timeMs: number;
}

/**
 * What the step reports, for whoever is running it to act on.
 *
 * Three callbacks rather than return values because two of them are optional
 * per frame and the third carries four arguments. The host's sink fires the
 * weapon and the client's plays a predicted flash; the single-player sink does
 * both, which is what it has always done.
 */
export interface StepSink {
    /**
     * A round left the barrel. Ammunition and the cooldown are already spent.
     *
     * `frame` comes with it so the host can refuse to fire the same shot twice
     * when a rollback replays the command that caused it.
     */
    fired(
        weapon: WeaponId,
        eyeQ3: Vec3Like,
        anglesQ3: ArrayLike<number>,
        frame: number
    ): void;

    /** The trigger is held on an empty weapon, at most twice a second. */
    dryFired(): void;

    /** The player arrived on the ground; `speed` is the fall speed at contact. */
    landed(speed: number): void;
}

/** A sink that ignores everything, for a peer with nothing to play. */
export const SILENT_SINK: StepSink = {
    fired() {},
    dryFired() {},
    landed() {},
};

export interface PlayerSlotOptions {
    cm: ClipMap;
    spawnQ3: readonly number[];
    /** `pm->trace` on meep's physics; null runs the ported `cm_trace`. */
    physics?: PhysicsTraceBackend | null;
    /**
     * Non-null runs the shipping movement path (D-071). Null runs the ported
     * `bg_pmove` whole, which is `?move=q3` and is single-player only.
     */
    moverHost?: MoverHost | null;
}

export class PlayerSlot {
    readonly pmove: Pmove;
    readonly ps: PlayerState;

    /**
     * Health, armour, ammo and owned weapons.
     *
     * Here rather than beside the presentation because Q3 keeps it in
     * `playerState_t` next to the movement state, and because firing consults
     * it every frame.
     */
    readonly inventory: Inventory = newInventory();

    /** Currently selected weapon. The command carries the choice; this holds it. */
    weapon: WeaponId = 'WP_MACHINEGUN';

    /**
     * Brush entities the ported clipmap has to be clipped against. Ignored on
     * the physics backend, which sees movers as bodies.
     */
    movers: MoverSource | null = null;

    /** Non-null when movement runs on meep's solver, which is the default. */
    private readonly movement: PlayerMovement | null;

    /** Milliseconds until the current weapon can fire again. Replicated. */
    private cooldownMs = 0;

    /**
     * Rate limit for the empty click. **Deliberately not replicated**: it gates
     * a sound and nothing else, so a rollback that leaves it stale costs one
     * click, and putting it on the wire would cost two bytes a frame per slot
     * for ever.
     */
    private dryFireCooldownMs = 0;

    constructor(options: PlayerSlotOptions) {
        /*
         `createPmoveHost` is the shared setup bots use too. A bot moving
         through a different `pmove_t` is a bot playing a different game, and
         the difference shows up as bots taking jumps the player cannot.
        */
        this.pmove = createPmoveHost({
            cm: options.cm,
            spawnQ3: options.spawnQ3,
            physics: options.physics ?? null,
            movers: () => this.movers,
            startHealth: this.inventory.health,
        });

        this.ps = this.pmove.ps;

        this.movement =
            options.moverHost == null ? null : new PlayerMovement(options.moverHost, this.ps.origin);
    }

    /** The solver's own record: ground normal, jump-held, posture. */
    get moveState(): PlayerMovement['moveState'] | null {
        return this.movement === null ? null : this.movement.moveState;
    }

    /**
     * One simulation frame for this slot.
     *
     * The order is `ClientThink_real`'s and `PlayerController.update`'s before
     * it, and every line of it is load-bearing somewhere: the health mirror is
     * what lets `PM_UpdateViewAngles` refuse to turn a corpse, the bob cycle is
     * the only thing that makes footsteps and gun sway agree between the two
     * solvers, and the fire decision has to happen after the move so a shot
     * leaves from where the player ended up.
     */
    step(cmd: UserCmd, clock: StepClock, sink: StepSink): void {
        const ps = this.ps;

        /*
         The one `playerState_t` field nothing else maintains. Three places in
         `bg_pmove` read it -- `PM_UpdateViewAngles` refuses to turn a corpse,
         `PmoveSingle` drops `CONTENTS_BODY` from the trace mask so a corpse
         falls through players, and the medium-fall event is suppressed for the
         dead -- and before this line none of them ever saw a dead player.
        */
        ps.stats[C.STAT_HEALTH] = this.inventory.health;

        /*
         The command is copied into the `pmove_t`'s own rather than swapped in.
         Both solvers read `pmove.cmd` back out -- `PM_UpdateViewAngles` writes
         through it, the `walking` and `moving` getters read it, and the ported
         path *mutates* it (`PM_CmdScale` clears BUTTON_WALKING for a run) --
         so the step needs a command it owns.
        */
        const own = this.pmove.cmd;
        own.serverTime = clock.timeMs;
        own.angles.set(cmd.angles);
        own.moves.set(cmd.moves);
        own.buttons = cmd.buttons;
        own.weapon = cmd.weapon;

        this.selectFromCommand(cmd.weapon);

        if (this.movement === null) {
            const wasAirborne = ps.groundEntityNum === C.ENTITYNUM_NONE;
            const fallSpeed = -ps.velocity[2]!;

            runPmove(this.pmove);

            /*
             `PM_CrashLand` raises `EV_FALL_*` on the ported path and there is
             no event queue here to read it from, so the landing is detected the
             way it is on the other path -- airborne, then not. Q3's own
             suppression for a jump does not apply: a jump leaves the ground
             rather than arriving on it.
            */
            if (wasAirborne && ps.groundEntityNum !== C.ENTITYNUM_NONE) {
                sink.landed(fallSpeed);
            }
        } else {
            const crouch = (own.buttons & BUTTON_CROUCH) !== 0;
            const move = this.movement.step(this.pmove, crouch, clock.dt);
            if (move.landed) sink.landed(move.landingSpeed);
            /*
             ...and then the one thing `PM_Footsteps` did that the replacement
             does not. Q3's whole gait -- the footstep sounds, the view bob and
             the gun's sway -- is one counter on `playerState_t`, and the
             kinematic path retired the function that turns it. Left
             unmaintained it sits at zero for the whole game, so anything
             reading it gets a player who never takes a step, and anything
             reconstructing it from something else gets a second answer that can
             disagree with the ported path -- and did (D-081).
            */
            advanceBobCycle(this.ps, this.pmove.cmd, clock.msec);
        }

        this.fireIfReady(clock, sink);
    }

    /**
     * Q3's weapon timing: a fixed cooldown per shot, from the balance table.
     *
     * Counted in the same integer milliseconds the simulation runs on rather
     * than in seconds, so the fire rate is exactly `PM_Weapon`'s `addTime` and
     * does not drift with frame rate.
     *
     * The *decision* is here and the *consequence* is the sink's, which is what
     * lets the host fire a real shot, a client play a predicted flash, and both
     * of them spend the same round of ammunition on the same frame.
     */
    private fireIfReady(clock: StepClock, sink: StepSink): void {
        /*
         `PM_Weapon`'s guard, and it is not decoration:

             if ( pm->ps->weaponTime > 0 ) {
                 pm->ps->weaponTime -= pml.msec;
             }

         This port decremented unconditionally, which fires identically -- the
         test below is `> 0` either way -- and turns the cooldown into an
         unbounded accumulator. Two things came of that. It saturated
         `clampInt16` at -32768 after about half a minute of not shooting, so
         the wire carried a number that no longer meant anything. And, much
         worse, it gave the value infinite memory: a host and a client that ever
         disagreed about how many frames had passed could never agree again,
         because nothing in the arithmetic ever returned to a common floor.

         Measured before the guard went back in, against a real host over a real
         socket: **every** AUTH_STATE disagreed -- 300 of 300 -- with `origin`,
         `velocity`, `viewangles`, `bobCycle` and the rest identical to the last
         bit and `weaponTime` alone drifting, one frame's worth at a time. So
         the client rewound and replayed its whole lead sixty times a second for
         a simulation that agreed about everything a player can see. With the
         guard, that is 92% short-circuited. See D-178.
        */
        if (this.cooldownMs > 0) this.cooldownMs -= clock.msec;

        if ((this.pmove.cmd.buttons & C.BUTTON_ATTACK) === 0) return;
        if (this.cooldownMs > 0) return;

        /*
         `PM_Weapon`: no ammo means no shot and no cooldown reset, so holding
         the button on an empty weapon does nothing rather than dry-firing at
         the weapon's rate. The gauntlet's ammo is -1 and stays there, which is
         why the test is `=== 0` rather than `<= 0`.
        */
        const ammo = this.inventory.ammo[this.weapon] ?? 0;
        if (ammo === 0) {
            this.dryFireCooldownMs -= clock.msec;
            if (this.dryFireCooldownMs <= 0) {
                this.dryFireCooldownMs = 500;
                sink.dryFired();
            }
            return;
        }
        if (ammo > 0) this.inventory.ammo[this.weapon] = ammo - 1;

        const ps = this.ps;
        SCRATCH_EYE[0] = ps.origin[0]!;
        SCRATCH_EYE[1] = ps.origin[1]!;
        SCRATCH_EYE[2] = ps.origin[2]! + ps.viewheight;

        sink.fired(this.weapon, SCRATCH_EYE, ps.viewangles, clock.frame);

        this.cooldownMs = weaponStats(this.weapon).fireRateMs;
    }

    /**
     * `CG_WeaponSelectable`: you must own it and it must have ammo.
     *
     * The answer only; whoever asked decides what to do with a refusal. Q3
     * silently ignores a select of an unusable weapon rather than beeping or
     * switching to the nearest usable one, which matters -- pressing 5 with no
     * rocket launcher must leave you holding what you had, mid-fight.
     */
    /**
     * The weapon the command asks for, if the slot may hold it.
     *
     * `usercmd_t.weapon` is where Q3 puts a weapon change, and it has to be
     * here for the same reason `BUTTON_ATTACK` had to move onto the command in
     * step 2: the step now runs on a machine with no keyboard. A client that
     * set `slot.weapon` directly -- which is what single-player did, and did
     * correctly -- would be telling only itself, and the host's copy of the same
     * slot would keep firing the machinegun while the player's screen showed a
     * rocket launcher. The disagreement is in `NetPlayerState.weapon`, so it
     * also costs the prediction short-circuit on every frame until the next
     * reconcile puts the client back on the host's weapon.
     *
     * **Zero means "no change", so the value is the index plus one.** That is
     * Q3's own convention -- `WP_NONE` is 0 and the weapons start at 1 -- and it
     * is load-bearing rather than cosmetic here: `NET_WEAPONS[0]` is a real
     * weapon, so a raw index would make "I am not asking for anything", which
     * is what every command in the port sent before today, indistinguishable
     * from "give me the gauntlet".
     *
     * `canSelect` for the same reason {@link PlayerController.selectWeapon}
     * checks it: Q3 ignores a select of a weapon you do not have or have no
     * ammunition for, rather than beeping or picking the nearest. A client
     * asking for one it cannot hold is a client that is wrong, or lying, and
     * either way the answer is to keep holding what it had.
     */
    private selectFromCommand(wanted: number): void {
        if (wanted <= 0) return;

        const weapon = weaponAt(wanted - 1);
        if (weapon === this.weapon) return;
        if (!this.canSelect(weapon)) return;

        this.weapon = weapon;
    }

    canSelect(weapon: WeaponId): boolean {
        if (!this.inventory.weapons.has(weapon)) return false;
        return (this.inventory.ammo[weapon] ?? 0) !== 0;
    }

    /** Horizontal speed, Q3 units/s -- whichever solver produced it. */
    get speed(): number {
        return Math.hypot(this.ps.velocity[0]!, this.ps.velocity[1]!);
    }

    /** Milliseconds until the weapon can fire again. Negative counts as ready. */
    get weaponTime(): number {
        return this.cooldownMs;
    }

    set weaponTime(value: number) {
        this.cooldownMs = value;
    }
    /* ------------------------------------------------------------------ *
     * The round trip a rollback is made of
     * ------------------------------------------------------------------ */

    /**
     * Overwrite everything a frame carries with what the components say.
     *
     * `UserCmdAction.apply` is `load -> step -> store`, so this and its partner
     * are the entire definition of "where a replay starts from". Anything the
     * step reads that is not restored here is a field a rewind cannot reach,
     * and the symptom of one is drift with no other symptom -- which is why the
     * four `MoveState` fields that are not in `playerState_t` are on the wire at
     * all.
     */
    load(state: NetPlayerState, inventory: NetInventory): void {
        const ps = this.ps;

        ps.origin[0] = state.origin[0]!;
        ps.origin[1] = state.origin[1]!;
        ps.origin[2] = state.origin[2]!;
        ps.velocity[0] = state.velocity[0]!;
        ps.velocity[1] = state.velocity[1]!;
        ps.velocity[2] = state.velocity[2]!;
        ps.viewangles[0] = state.viewangles[0]!;
        ps.viewangles[1] = state.viewangles[1]!;
        ps.viewangles[2] = state.viewangles[2]!;
        ps.delta_angles[0] = state.deltaAngles[0]!;
        ps.delta_angles[1] = state.deltaAngles[1]!;
        ps.delta_angles[2] = state.deltaAngles[2]!;
        /*
         Masked, because bit 2 is this port's and not Q3's: `NET_PMF_WALKING`
         rides in `pmFlags` to save a field (see its docblock) and a live
         `pm_flags` must not carry it -- a solver that later grew a flag on
         that bit would find it already set.
        */
        ps.pm_flags = state.pmFlags & ~NET_PMF_WALKING;
        ps.pm_time = state.pmTime;
        ps.groundEntityNum = state.groundEntityNum;
        ps.viewheight = state.viewheight;
        ps.bobCycle = state.bobCycle;

        this.weapon = weaponAt(state.weapon);
        this.cooldownMs = state.weaponTime;

        /*
         The half that is not in `ps`, and the reason `load` exists rather than
         a component write. `MeepMove` keeps the ground normal, the jump-held
         latch and the posture in its own `MoveState`; a rewind that restored
         only `playerState_t` would put the player back four frames with a
         ground normal from the present.
        */
        const move = this.movement?.moveState;
        if (move !== undefined && move !== null) {
            move.origin[0] = state.origin[0]!;
            move.origin[1] = state.origin[1]!;
            move.origin[2] = state.origin[2]!;
            move.velocity[0] = state.velocity[0]!;
            move.velocity[1] = state.velocity[1]!;
            move.velocity[2] = state.velocity[2]!;
            move.grounded = state.groundEntityNum !== C.ENTITYNUM_NONE;
            move.groundNormal[0] = state.groundNormal[0]!;
            move.groundNormal[1] = state.groundNormal[1]!;
            move.groundNormal[2] = state.groundNormal[2]!;
            move.jumpHeld = state.jumpHeld !== 0;
            move.ducked = state.ducked !== 0;
            move.viewheight = state.viewheight;
        }

        const inv = this.inventory;
        inv.health = inventory.health;
        inv.armor = inventory.armor;
        inv.maxHealth = inventory.maxHealth;
        inv.weapons.clear();
        for (let i = 0; i < NET_WEAPON_COUNT; i++) {
            const tag = NET_WEAPONS[i]!;
            inv.ammo[tag] = inventory.ammo[i]!;
            if ((inventory.weapons & (1 << i)) !== 0) inv.weapons.add(tag);
        }
    }

    /** The inverse of {@link load}. Every field, every frame. */
    store(state: NetPlayerState, inventory: NetInventory): void {
        const ps = this.ps;

        state.origin[0] = ps.origin[0]!;
        state.origin[1] = ps.origin[1]!;
        state.origin[2] = ps.origin[2]!;
        state.velocity[0] = ps.velocity[0]!;
        state.velocity[1] = ps.velocity[1]!;
        state.velocity[2] = ps.velocity[2]!;
        state.viewangles[0] = ps.viewangles[0]!;
        state.viewangles[1] = ps.viewangles[1]!;
        state.viewangles[2] = ps.viewangles[2]!;
        state.deltaAngles[0] = ps.delta_angles[0]!;
        state.deltaAngles[1] = ps.delta_angles[1]!;
        state.deltaAngles[2] = ps.delta_angles[2]!;
        /*
         The command's walk bit travels with the state, because the state is
         all a client drawing this player has. `store` runs after the step, so
         this is the same `cmd.buttons` `PM_Footsteps` would have tested.
        */
        state.pmFlags =
            (ps.pm_flags & 0xffff & ~NET_PMF_WALKING) |
            (isWalking(this.pmove.cmd) ? NET_PMF_WALKING : 0);
        state.pmTime = ps.pm_time;
        state.groundEntityNum = ps.groundEntityNum;
        state.viewheight = ps.viewheight;
        state.bobCycle = ps.bobCycle;
        state.weapon = weaponIndex(this.weapon);
        state.weaponTime = clampInt16(this.cooldownMs);

        const move = this.movement?.moveState;
        if (move !== undefined && move !== null) {
            state.groundNormal[0] = move.groundNormal[0]!;
            state.groundNormal[1] = move.groundNormal[1]!;
            state.groundNormal[2] = move.groundNormal[2]!;
            state.jumpHeld = move.jumpHeld ? 1 : 0;
            state.ducked = move.ducked ? 1 : 0;
        } else {
            state.groundNormal[0] = 0;
            state.groundNormal[1] = 0;
            state.groundNormal[2] = 1;
            state.jumpHeld = (ps.pm_flags & C.PMF_JUMP_HELD) !== 0 ? 1 : 0;
            state.ducked = (ps.pm_flags & C.PMF_DUCKED) !== 0 ? 1 : 0;
        }

        const inv = this.inventory;
        inventory.health = inv.health;
        inventory.armor = inv.armor;
        inventory.maxHealth = inv.maxHealth;
        let owned = 0;
        for (let i = 0; i < NET_WEAPON_COUNT; i++) {
            const tag = NET_WEAPONS[i]!;
            inventory.ammo[i] = clampInt16(inv.ammo[tag] ?? 0);
            if (inv.weapons.has(tag)) owned |= 1 << i;
        }
        inventory.weapons = owned;
    }
}

/**
 * `NetPlayerState.weaponTime` and `NetInventory.ammo` are `int16`, and Q3's own
 * numbers are nowhere near the edges -- the slowest weapon reloads in 1500 ms
 * and the largest ammo box is 200. Clamped rather than masked so a value that
 * somehow got out of range arrives wrong rather than arriving *negated*, which
 * is what a silent two's-complement wrap does to a cooldown.
 */
function clampInt16(value: number): number {
    return clamp(Math.trunc(value), -32768, 32767);
}

/**
 * Reused so a shot allocates nothing; the sink must not retain it.
 *
 * A `Vec3` rather than the `Float64Array` it was: every number written into it
 * is a `ps.origin` component plus an integer view height, so the wider buffer
 * held no more information, and this is the width the rest of the port's
 * vectors -- and meep's array forms -- expect.
 */
const SCRATCH_EYE = vec3();
