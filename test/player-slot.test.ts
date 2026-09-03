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
import type { Vec3Like } from '../src/q3/math.ts';
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
import { TICK_HZ, frameMsec, frameTimeMs } from '../src/net/protocol.ts';
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
 * control that shares code with the subject is not one. Two things are changed
 * from the original. The command arrives as an argument instead of being built
 * from a keyboard, which is the split under test. And `fireIfReady` carries
 * `PM_Weapon`'s `weaponTime > 0` guard, which the original did not -- see there
 * for why that is a correction to the control rather than a hole in it.
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
        /*
         `bg_pmove.c:1575`, which the pre-extraction code did not have:

             if ( pm->ps->weaponTime > 0 ) {
                 pm->ps->weaponTime -= pml.msec;
             }

         So this line is not a transcription of what was here before, and that
         is deliberate: what was here before was wrong against the C, and a
         control that encodes the defect would hold the port to it for ever.
         The behaviour under test -- when a shot comes out -- is identical
         either way, because the gate below is `> 0` in both. What changes is
         that the counter has a floor. See D-178 and `weaponTime stays inside
         the range the wire can carry` below.
        */
        if (this.cooldownMs > 0) this.cooldownMs -= msec;

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
        fired(_w: WeaponId, eye: Vec3Like) {
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

        /*
         **They are not the same rate any more, and that is the finding.**

         Single-player steps on the engine's fixed update, which is 60 Hz, and
         spends 16 or 17 milliseconds a frame. The networked path steps on the
         session, which is `TICK_HZ` -- 30 since the rate was dropped to halve
         what a match costs on the wire (D-184) -- and spends 33 or 34.

         So the two halves of this port now run `bg_pmove` at different step
         lengths, and `PmoveSingle` is not linear in its step: measured, the
         same strafe-jump chain tops out at 466 units a second at 16 ms and 445
         at 33, and the same commands land the player about forty units apart
         after five seconds. Nobody can play both halves and feel the same game,
         which is a real cost and is written down rather than smoothed over.

         This test is the tripwire for it. If single-player and the wire are
         ever meant to agree again, it is the assertion that will say they do.
        */
        const engineStep = new Set(carried);
        const sessionStep = new Set(closed);

        expect(engineStep, "single-player is no longer on the engine's 60 Hz step").toEqual(
            new Set([16, 17])
        );

        const period = 1000 / TICK_HZ;
        const low = Math.floor(period);
        const high = Math.ceil(period);
        expect(sessionStep, 'the wire is no longer on the session period').toEqual(
            low === high ? new Set([low]) : new Set([low, high])
        );

        /*
         Each sums to its own second, which is the property that matters within
         either half. The closed form spends exactly 1000 ms per `TICK_HZ`
         frames by construction. The carry spends **999** per 60, because it is
         fed `fixedUpdateStepSize` and `0.016666666666 * 1000` is short of
         `50 / 3` -- so a single-player Q3 clock runs a millisecond per second
         slow against the movers' own arithmetic. That is a twentieth of the two
         per cent D-110 removed by replacing rounding with this carry, and it is
         in the other direction. Recorded rather than fixed: changing it changes
         single-player movement.
        */
        let closedSecond = 0;
        for (let frame = 0; frame < TICK_HZ; frame++) closedSecond += frameMsec(frame);
        expect(closedSecond).toBe(1000);

        const carriedTotal = carried.reduce((x, y) => x + y, 0);
        expect(carriedTotal).toBe(999);
    });
});

describe('the weapon cooldown', () => {
    /**
     * `bg_pmove.c:1575` guards the decrement with `weaponTime > 0`, and this
     * port did not.
     *
     * It looks like a formality -- the gate that decides whether a shot comes
     * out is `> 0` either way -- and it is the difference between a bounded
     * counter and an unbounded one. Two things follow from unbounded, and the
     * second is what made this worth finding.
     *
     * `NetPlayerState.weaponTime` is an `int16`, so `clampInt16` saturates it
     * at -32768 after about thirty-three seconds of not shooting: the wire then
     * carries a number that no longer means anything.
     *
     * And an unbounded counter has infinite memory. A predicted client compares
     * a hash of its own slot against a hash of the host's for the same frame,
     * and reconciles when they differ. With no floor, a host and a client that
     * ever disagreed about how many frames had passed could never agree again,
     * so *every* comparison failed for ever. Measured against a real host over
     * a real socket before the guard went back: 300 reconciles in 300 frames,
     * with `origin`, `velocity`, `viewangles`, `bobCycle` and every other field
     * bit-identical and `weaponTime` alone drifting. See D-178.
     */
    it('stays inside the range the wire can carry, however long nobody fires', () => {
        const slot = newSlot();
        const sink = recordingSink();
        const cmd = createUserCmd();

        // A minute of standing still, which is twice what int16 needs to
        // saturate at one frame of milliseconds per frame.
        for (let frame = 0; frame < 60 * 60; frame++) {
            cmd.angles.fill(0);
            cmd.moves.fill(0);
            cmd.buttons = 0;
            cmd.weapon = 0;
            slot.step(cmd, netClock(frame), sink);
        }

        /*
         `PM_Weapon` can take it one frame below zero -- the frame it crosses --
         and never further, because the guard sees a non-positive value on the
         next one.
        */
        expect(slot.weaponTime).toBeLessThanOrEqual(0);
        expect(slot.weaponTime).toBeGreaterThan(-20);

        const state = new NetPlayerState();
        const inventory = new NetInventory();
        slot.store(state, inventory);
        expect(state.weaponTime).toBe(slot.weaponTime);
    });

    it('forgets how long it has been idle, so two peers can agree about it', () => {
        /*
         The property the network needs, stated without a network.

         Two slots reach the same frame having been idle for different lengths
         of time -- which is every client and host that ever ran a different
         number of frames, and under time dilation that is all of them. Then
         both fire the same shot on the same frame. They have to hold the same
         cooldown afterwards, because a client whose slot disagrees with the
         host's about *any* byte reconciles, and one that disagrees about a byte
         nothing ever resets reconciles for ever.

         A floored counter forgets: both are sitting at the floor before the
         shot, so both land on `fireRateMs` after it. An unfloored one
         remembers every frame it has ever seen, and the gap between these two
         -- 40 frames, about 667 ms -- would survive the shot and every shot
         after it. That is the defect this pair of tests exists for.
        */
        const early = newSlot();
        const late = newSlot();
        const sink = recordingSink();
        const cmd = createUserCmd();

        const idle = (slot: PlayerSlot, from: number, to: number): void => {
            for (let frame = from; frame < to; frame++) {
                cmd.angles.fill(0);
                cmd.moves.fill(0);
                cmd.buttons = 0;
                cmd.weapon = 0;
                slot.step(cmd, netClock(frame), sink);
            }
        };

        // 100 frames of idling against 60: the same instant, different histories.
        idle(early, 0, 100);
        idle(late, 40, 100);

        expect(early.weaponTime, 'the idle counters already disagree').toBe(late.weaponTime);

        // And the same shot on the same frame leaves them on the same cooldown.
        cmd.angles.fill(0);
        cmd.moves.fill(0);
        cmd.weapon = 0;
        cmd.buttons = C.BUTTON_ATTACK;
        early.step(cmd, netClock(100), sink);
        late.step(cmd, netClock(100), sink);

        expect(early.weaponTime).toBe(weaponStats(early.weapon).fireRateMs);
        expect(late.weaponTime).toBe(early.weaponTime);
    });
});
