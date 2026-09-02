/*
 * player-slot.test.ts -- the extraction changed nothing, and a rewind can undo it.
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
 * Two properties, and the second is the one the whole netcode rests on.
 *
 * **The extraction is a no-op.** `PlayerSlot.step` is `PlayerController.update`
 * with the input sampling and the pose history taken out. The reference
 * implementation below is a copy of what `update` did before the split --
 * literally the same statements in the same order, reading the same fields --
 * driven by the same commands, so a difference between the two is a difference
 * the extraction introduced. It is a copy on purpose: an equivalence test that
 * imports the thing it is checking proves nothing, and the shipping suite
 * (`player-controller.test.ts`, 69 cases) is what protects the *behaviour* once
 * this copy goes stale.
 *
 * **A frame is exactly what `load` and `store` carry.** The host rewinds by
 * restoring two replicated components and replaying, so any state the step
 * carries between frames outside those components would survive the rewind
 * while everything around it went back -- and the run would continue from a
 * mixture of two frames, drifting, with no other symptom. So: run 300 frames,
 * take a copy through `store`, run on, come back through `load`, run the same
 * 300 frames again, and require the two runs to agree to the last bit at every
 * step. That fails on the day somebody adds a counter to `PlayerSlot`.
 *
 * The scripted input is `meepmove.test.ts`'s strafe-jump chain, because it is
 * the movement this port is about and because it exercises everything a frame
 * can carry: the ground normal changes every landing, `jumpHeld` latches and
 * releases, the bob cycle advances only on the ground, and the velocity is
 * large enough that a 1e-7 divergence is visible within fifty frames.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { createPmoveHost } from '../src/game/PmoveHost.ts';
import { PlayerMovement } from '../src/client/MeepMove.ts';
import { newInventory } from '../src/game/Items.ts';
import { weaponStats, type WeaponId } from '../src/game/Weapons.ts';
import {
    BUTTON_CROUCH,
    PlayerSlot,
    SILENT_SINK,
    type StepClock,
    type StepSink,
} from '../src/game/PlayerSlot.ts';
import { NetInventory, NetPlayerState } from '../src/net/components.ts';
import { frameMsec, frameTimeMs } from '../src/net/protocol.ts';
import * as C from '../src/q3/pmove/constants.ts';
import {
    createUserCmd,
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type UserCmd,
} from '../src/q3/pmove/types.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** The engine's own step, which is what `PlayerSystem` hands the solver. */
const DT = 0.016666666666;

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

let physics: HeadlessPhysics;
let spawns: number[][];

{
    const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
    );
    const scene = JSON.parse(
        readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')
    ) as Scene;
    physics = await HeadlessPhysics.create(cm);
    spawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);
}

/* ------------------------------------------------------------------ *
 * The reference: `PlayerController.update` before the split
 * ------------------------------------------------------------------ */

const BOBMOVE_RUN = 0.4;
const BOBMOVE_WALK = 0.3;
const BOBMOVE_DUCKED = 0.5;

/**
 * The pre-extraction step, transcribed.
 *
 * Deliberately a transcription rather than a call: it is the control, and a
 * control that shares code with the subject is not one. The only thing changed
 * from the original is that the command arrives as an argument instead of being
 * built from a keyboard, which is the split under test.
 */
class ReferenceController {
    readonly pmove = createPmoveHost({
        cm: physics.cm,
        spawnQ3: spawns[0]!,
        physics,
        movers: () => null,
        startHealth: newInventory().health,
    });

    readonly ps = this.pmove.ps;
    readonly inventory = newInventory();
    readonly movement = new PlayerMovement(physics, this.pmove.ps.origin);

    weapon: WeaponId = 'WP_MACHINEGUN';
    cooldownMs = 0;
    dryFireCooldownMs = 0;

    readonly shots: number[] = [];
    readonly landings: number[] = [];

    update(cmd: UserCmd, msec: number, dt: number, timeMs: number): void {
        this.ps.stats[C.STAT_HEALTH] = this.inventory.health;

        const own = this.pmove.cmd;
        own.serverTime = timeMs;
        own.angles.set(cmd.angles);
        own.moves.set(cmd.moves);
        own.buttons = cmd.buttons;
        own.weapon = cmd.weapon;

        const crouching = (cmd.buttons & BUTTON_CROUCH) !== 0;

        const move = this.movement.step(this.pmove, crouching, dt);
        if (move.landed) this.landings.push(move.landingSpeed);

        this.updateBobCycle(msec);
        this.fireIfReady(msec);
    }

    private updateBobCycle(msec: number): void {
        const ps = this.ps;
        const cmd = this.pmove.cmd;

        if (ps.groundEntityNum === C.ENTITYNUM_NONE) return;

        if (cmd.moves[FORWARDMOVE] === 0 && cmd.moves[RIGHTMOVE] === 0) {
            if (Math.hypot(ps.velocity[0]!, ps.velocity[1]!) < 5) ps.bobCycle = 0;
            return;
        }

        const bobmove =
            (ps.pm_flags & C.PMF_DUCKED) !== 0
                ? BOBMOVE_DUCKED
                : (cmd.buttons & C.BUTTON_WALKING) !== 0
                  ? BOBMOVE_WALK
                  : BOBMOVE_RUN;

        ps.bobCycle = Math.trunc(ps.bobCycle + bobmove * msec) & 255;
    }

    private fireIfReady(msec: number): void {
        this.cooldownMs -= msec;

        if ((this.pmove.cmd.buttons & C.BUTTON_ATTACK) === 0) return;
        if (this.cooldownMs > 0) return;

        const ammo = this.inventory.ammo[this.weapon] ?? 0;
        if (ammo === 0) {
            this.dryFireCooldownMs -= msec;
            if (this.dryFireCooldownMs <= 0) this.dryFireCooldownMs = 500;
            return;
        }
        if (ammo > 0) this.inventory.ammo[this.weapon] = ammo - 1;

        this.shots.push(this.ps.origin[2]! + this.ps.viewheight);

        this.cooldownMs = weaponStats(this.weapon).fireRateMs;
    }
}

/* ------------------------------------------------------------------ *
 * The scripted input
 * ------------------------------------------------------------------ */

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/**
 * `meepmove.test.ts`'s chain: hold forward and one strafe key, turn steadily,
 * and jump whenever the ground allows it. 250 frames of run-up, then 350 of the
 * chain, with the trigger held from frame 300 so the weapon timing is exercised
 * too.
 */
function scriptedCommand(cmd: UserCmd, frame: number, grounded: boolean): UserCmd {
    const inChain = frame >= 250;
    const yaw = inChain ? (frame - 250) * 0.35 : 0;

    cmd.angles[0] = 0;
    cmd.angles[1] = angleToShort(yaw);
    cmd.angles[2] = 0;
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[RIGHTMOVE] = inChain ? 127 : 0;
    cmd.moves[UPMOVE] = inChain && grounded ? 127 : 0;
    cmd.buttons = frame >= 300 ? C.BUTTON_ATTACK : 0;
    cmd.weapon = 0;

    return cmd;
}

interface Trace {
    origin: number[];
    velocity: number[];
    viewangles: number[];
    bobCycle: number;
    weaponTime: number;
    ammo: number;
    groundEntityNum: number;
    pmFlags: number;
    viewheight: number;
}

function traceOf(slot: PlayerSlot): Trace {
    return {
        origin: [...slot.ps.origin],
        velocity: [...slot.ps.velocity],
        viewangles: [...slot.ps.viewangles],
        bobCycle: slot.ps.bobCycle,
        weaponTime: slot.weaponTime,
        ammo: slot.inventory.ammo['WP_MACHINEGUN'] ?? 0,
        groundEntityNum: slot.ps.groundEntityNum,
        pmFlags: slot.ps.pm_flags,
        viewheight: slot.ps.viewheight,
    };
}

function traceOfReference(ref: ReferenceController): Trace {
    return {
        origin: [...ref.ps.origin],
        velocity: [...ref.ps.velocity],
        viewangles: [...ref.ps.viewangles],
        bobCycle: ref.ps.bobCycle,
        weaponTime: ref.cooldownMs,
        ammo: ref.inventory.ammo['WP_MACHINEGUN'] ?? 0,
        groundEntityNum: ref.ps.groundEntityNum,
        pmFlags: ref.ps.pm_flags,
        viewheight: ref.ps.viewheight,
    };
}

function newSlot(): PlayerSlot {
    return new PlayerSlot({
        cm: physics.cm,
        spawnQ3: spawns[0]!,
        physics,
        moverHost: physics,
    });
}

/** A sink that records what the step reported, so the two can be compared. */
function recordingSink(): StepSink & { shots: number[]; landings: number[]; dry: number } {
    const out = {
        shots: [] as number[],
        landings: [] as number[],
        dry: 0,
        fired(_w: WeaponId, eye: ArrayLike<number>) {
            out.shots.push(eye[2]!);
        },
        dryFired() {
            out.dry += 1;
        },
        landed(speed: number) {
            out.landings.push(speed);
        },
    };
    return out;
}

/**
 * The clock a networked peer hands the step. `frameMsec` off the frame number,
 * the engine's constant for the solver, and the running total closed-form so a
 * replayed frame gets the millisecond it got the first time.
 */
function netClock(frame: number, dt = DT): StepClock {
    return {
        frame,
        msec: frameMsec(frame),
        dt,
        timeMs: frameTimeMs(frame) + frameMsec(frame),
    };
}

const FRAMES = 600;

describe('PlayerSlot against the controller it came out of', () => {
    it('runs 600 frames of the strafe-jump chain bit for bit', () => {
        const slot = newSlot();
        const ref = new ReferenceController();
        const sink = recordingSink();

        const slotCmd = createUserCmd();
        const refCmd = createUserCmd();
        let peak = 0;

        for (let frame = 0; frame < FRAMES; frame++) {
            const clock = netClock(frame);

            /*
             Each side is handed a command built from *its own* grounded state,
             which is the honest arrangement: a jump the reference did not take
             would put the two on different trajectories for a reason that is
             the input's rather than the step's. If they ever disagree about
             being grounded, the traces diverge on the next frame and the
             assertion below names the frame it happened on.
            */
            slot.step(
                scriptedCommand(
                    slotCmd,
                    frame,
                    slot.ps.groundEntityNum !== C.ENTITYNUM_NONE
                ),
                clock,
                sink
            );

            ref.update(
                scriptedCommand(
                    refCmd,
                    frame,
                    ref.ps.groundEntityNum !== C.ENTITYNUM_NONE
                ),
                clock.msec,
                clock.dt,
                clock.timeMs
            );

            expect(traceOf(slot), `frame ${frame}`).toEqual(traceOfReference(ref));

            peak = Math.max(peak, Math.hypot(slot.ps.velocity[0]!, slot.ps.velocity[1]!));
        }

        /*
         And the run was worth running. Peak rather than final speed, because
         `oa_dm1` is a real level and the chain ends against a wall from three
         of its four spawns -- measured: peak 275, 337, 320 and 342 u/s from
         spawns 0..3 against a 320 base, with final speed 0 from all but one.
         A test asserting the final speed would be asserting the map.
        */
        expect(peak, 'the chain never got moving').toBeGreaterThan(250);
        expect(sink.landings.length).toBeGreaterThan(5);
        expect(sink.shots.length).toBeGreaterThan(10);
        expect(sink.shots).toEqual(ref.shots);
        expect(sink.landings).toEqual(ref.landings);
        expect(sink.dry).toBe(0);
    });

    it('spends the ammunition the reference spends', () => {
        const slot = newSlot();
        const ref = new ReferenceController();
        const cmd = createUserCmd();

        for (let frame = 0; frame < FRAMES; frame++) {
            const clock = netClock(frame);
            scriptedCommand(cmd, frame, false);
            slot.step(cmd, clock, SILENT_SINK);
            ref.update(cmd, clock.msec, clock.dt, clock.timeMs);
        }

        const spent = 100 - (slot.inventory.ammo['WP_MACHINEGUN'] ?? 0);
        expect(spent).toBeGreaterThan(0);
        expect(slot.inventory.ammo['WP_MACHINEGUN']).toBe(ref.inventory.ammo['WP_MACHINEGUN']);
    });
});

describe('load and store carry a whole frame', () => {
    it('a run resumed through the components is bit-identical to one that never stopped', () => {
        const straight = newSlot();
        const interrupted = newSlot();
        const cmdA = createUserCmd();
        const cmdB = createUserCmd();

        const state = new NetPlayerState();
        const inventory = new NetInventory();

        const straightTrace: Trace[] = [];
        const interruptedTrace: Trace[] = [];

        for (let frame = 0; frame < FRAMES; frame++) {
            const clock = netClock(frame);

            straight.step(
                scriptedCommand(cmdA, frame, straight.ps.groundEntityNum !== C.ENTITYNUM_NONE),
                clock,
                SILENT_SINK
            );
            straightTrace.push(traceOf(straight));

            /*
             The round trip, mid-flight, on a frame chosen to be airborne in the
             middle of the chain -- which is where the four fields that are not
             in `playerState_t` all have non-default values at once: the ground
             normal is the last surface left, `jumpHeld` is latched, and the
             posture has been set by a solve rather than by a spawn.
            */
            if (frame === 400) {
                interrupted.store(state, inventory);

                // Scribble over the live state, so a `load` that forgot a field
                // cannot pass by leaving that field already correct.
                interrupted.ps.origin.fill(-9999);
                interrupted.ps.velocity.fill(1234);
                interrupted.ps.bobCycle = 77;
                interrupted.ps.pm_flags = 0;
                interrupted.ps.viewheight = 3;
                interrupted.ps.groundEntityNum = C.ENTITYNUM_NONE;
                interrupted.weaponTime = -12345;
                interrupted.inventory.health = 7;
                const move = interrupted.moveState;
                if (move !== null) {
                    move.groundNormal[0] = 0.7;
                    move.groundNormal[1] = 0.7;
                    move.groundNormal[2] = 0.1;
                    move.jumpHeld = !move.jumpHeld;
                    move.ducked = !move.ducked;
                    move.grounded = !move.grounded;
                }

                interrupted.load(state, inventory);
            }

            interrupted.step(
                scriptedCommand(
                    cmdB,
                    frame,
                    interrupted.ps.groundEntityNum !== C.ENTITYNUM_NONE
                ),
                clock,
                SILENT_SINK
            );
            interruptedTrace.push(traceOf(interrupted));

            expect(interruptedTrace[frame], `frame ${frame}`).toEqual(straightTrace[frame]);
        }
    });

    it('round-trips every field, including the four that are not in playerState_t', () => {
        const slot = newSlot();
        const cmd = createUserCmd();

        // Fifty frames of chain, so nothing is at its spawn value.
        for (let frame = 0; frame < 320; frame++) {
            slot.step(
                scriptedCommand(cmd, frame, slot.ps.groundEntityNum !== C.ENTITYNUM_NONE),
                netClock(frame),
                SILENT_SINK
            );
        }

        const state = new NetPlayerState();
        const inventory = new NetInventory();
        slot.store(state, inventory);

        const before = traceOf(slot);
        const moveBefore = {
            groundNormal: [...slot.moveState!.groundNormal],
            jumpHeld: slot.moveState!.jumpHeld,
            ducked: slot.moveState!.ducked,
            grounded: slot.moveState!.grounded,
        };

        slot.load(state, inventory);

        expect(traceOf(slot)).toEqual(before);
        expect([...slot.moveState!.groundNormal]).toEqual(moveBefore.groundNormal);
        expect(slot.moveState!.jumpHeld).toBe(moveBefore.jumpHeld);
        expect(slot.moveState!.ducked).toBe(moveBefore.ducked);
        expect(slot.moveState!.grounded).toBe(moveBefore.grounded);

        // The inventory survives the flattening, weapon set included.
        expect(slot.inventory.weapons.has('WP_MACHINEGUN')).toBe(true);
        expect(slot.inventory.weapons.has('WP_GAUNTLET')).toBe(true);
        expect(slot.inventory.ammo['WP_GAUNTLET']).toBe(-1);
    });
});

describe('the two clocks', () => {
    it('agree over any three frames and differ inside them', () => {
        /*
         The reason `step` takes the millisecond rather than deriving it.
         Single-player carries a sub-millisecond remainder over `deltaSeconds`;
         a networked peer takes `frameMsec` off the frame number. Both spend
         only 16 or 17 and both sum exactly -- and they are not the same
         sequence, so single-player keeps its carry and the wire keeps the
         closed form.
        */
        let carry = 0;
        const carried: number[] = [];
        const closed: number[] = [];
        for (let frame = 0; frame < 60; frame++) {
            carry += DT * 1000;
            const msec = Math.floor(carry);
            carry -= msec;
            carried.push(msec);
            closed.push(frameMsec(frame));
        }

        expect(new Set(carried)).toEqual(new Set([16, 17]));
        expect(new Set(closed)).toEqual(new Set([16, 17]));

        // Different sequences, from the first three frames onward.
        expect(carried).not.toEqual(closed);
        expect(carried.slice(0, 6)).toEqual([16, 17, 16, 17, 17, 16]);
        expect(closed.slice(0, 6)).toEqual([16, 17, 17, 16, 17, 17]);

        /*
         And they do not sum to the same second, which is the measurement worth
         keeping. The closed form spends exactly 1000 ms per 60 frames by
         construction. The carry spends **999**, because it is fed
         `fixedUpdateStepSize`, and `0.016666666666 * 1000` is short of `50 / 3`
         -- so a single-player Q3 clock runs one millisecond per second slow
         against the movers' own arithmetic. That is a twentieth of the two
         percent D-110 removed by replacing rounding with this carry, and it is
         in the other direction. Recorded rather than fixed here: changing it
         changes single-player movement, which this step is required to leave
         alone.
        */
        const carriedTotal = carried.reduce((x, y) => x + y, 0);
        const closedTotal = closed.reduce((x, y) => x + y, 0);
        expect(closedTotal).toBe(1000);
        expect(carriedTotal).toBe(999);
    });
});
