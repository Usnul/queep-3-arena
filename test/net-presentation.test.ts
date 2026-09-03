/*
 * net-presentation.test.ts -- what one player sees of another.
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
 * `NETWORK_PLAN.md`'s step 5 originally ended at "a screenshot of tab A shows
 * tab B's character where tab B's HUD says it is". That exit could not be met
 * where this port is developed -- the preview browser cannot get a WebGPU
 * adapter, so the renderer never starts (GAP-044's note) -- and a screenshot
 * would not have measured the interesting part anyway.
 *
 * This is the same claim as a number. `NetPresentationSystem` is typed against
 * three methods rather than against `Character`, so a test can put a recorder
 * behind it and ask what a real match, over a real replication path, actually
 * told it to draw: where each remote player was placed, which animation was
 * chosen, and how far the drawn position sits from the host's own truth.
 *
 * The last of those is the number worth having. A client draws remote players
 * *behind* the present on purpose -- `AdaptiveRenderDelay` samples the
 * interpolation log a few frames back so the motion is smooth -- so the honest
 * question is not "is it exact" but "is the lag bounded and is it the lag we
 * asked for".
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { NetRig } from './net/rig.ts';
import {
    NetPresentationSystem,
    type MissilePresenter,
    type RemoteAudio,
    type RemoteCharacter,
} from '../src/app/netSystems.ts';
import { Footsteps } from '../src/client/Audio.ts';
import { MAX_CLIENTS } from '../src/net/protocol.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import { weaponIndex } from '../src/net/components.ts';
import * as C from '../src/q3/pmove/constants.ts';
import type { LegsAnimation, TorsoAnimation } from '../src/client/Characters.ts';

/** Frames measured. Long enough for a fight to happen and rockets to fly. */
const FRAMES = 2400;

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** The circling walk the rest of the networked suite runs, and for its reasons. */
function circleWalk(
    cmd: { angles: Int16Array; moves: Int8Array; buttons: number; weapon: number },
    frame: number
): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

/** A character that remembers what it was told, instead of drawing it. */
class Recorder implements RemoteCharacter {
    readonly positions: number[][] = [];
    readonly legs: LegsAnimation[] = [];
    readonly torsos: TorsoAnimation[] = [];
    yaw = 0;

    place(originQ3: ArrayLike<number>, yawDegrees: number): void {
        this.positions.push([originQ3[0]!, originQ3[1]!, originQ3[2]!]);
        this.yaw = yawDegrees;
    }

    setLegs(animation: LegsAnimation): void {
        this.legs.push(animation);
    }

    setTorso(animation: TorsoAnimation): void {
        this.torsos.push(animation);
    }

    get last(): number[] {
        return this.positions[this.positions.length - 1] ?? [0, 0, 0];
    }
}

/** A missile pool that remembers what it was told, instead of drawing it. */
class MissileLog implements MissilePresenter {
    readonly events: { at: number; what: string; index: number; weapon?: string }[] = [];
    readonly live = new Set<number>();
    /** Where each slot was last placed, to catch a model that streaks. */
    readonly placed = new Map<number, number[]>();
    readonly jumps: number[] = [];
    frame = 0;
    advanced = 0;

    spawn(index: number, weapon: string): void {
        this.events.push({ at: this.frame, what: 'spawn', index, weapon });
        this.live.add(index);
    }

    despawn(index: number): void {
        this.events.push({ at: this.frame, what: 'despawn', index });
        this.live.delete(index);
        this.placed.delete(index);
    }

    place(index: number, originQ3: ArrayLike<number>): void {
        const at = [originQ3[0]!, originQ3[1]!, originQ3[2]!];
        const before = this.placed.get(index);

        // Only meaningful while the same missile is in the slot; a despawn
        // clears it, so a jump here is a jump of one continuous flight.
        if (before !== undefined && this.live.has(index)) {
            this.jumps.push(
                Math.hypot(at[0]! - before[0]!, at[1]! - before[1]!, at[2]! - before[2]!)
            );
        }

        this.placed.set(index, at);
    }

    advance(): void {
        this.advanced += 1;
    }
}

/**
 * Every footfall the presentation asked for, with the frame and the slot.
 *
 * The same trick as `MissileLog`: `RemoteAudio` is two methods, so what would
 * otherwise need an `AudioContext` and a pair of ears becomes a list.
 */
class AudioLog implements RemoteAudio {
    frame = 0;

    readonly steps: { frame: number; slot: number; z: number }[] = [];
    readonly landings: { frame: number; slot: number; z: number }[] = [];

    footstep(slot: number, originQ3: ArrayLike<number>): void {
        this.steps.push({ frame: this.frame, slot, z: originQ3[2]! });
    }

    land(slot: number, originQ3: ArrayLike<number>): void {
        this.landings.push({ frame: this.frame, slot, z: originQ3[2]! });
    }
}

interface Seen {
    rig: NetRig;
    recorders: Map<number, Recorder>;
    missiles: MissileLog;
    audio: AudioLog;
    /** Distance between the drawn position and the host's, per frame, per bot. */
    lag: number[];
    /** How far a bot moved between consecutive frames, for scale. */
    step: number[];
}

let seen: Seen;

beforeAll(async () => {
    /*
     Four bots and a seed that produces a fight. Three bots on seed 77 walked a
     whole match without anybody firing a rocket, which left the missile half of
     this file asserting things about an empty pool -- a fixture that passes by
     never exercising what it tests.
    */
    const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 23, warmup: 40 });
    const client = rig.clients[0]!;

    /*
     The same circling walk every other networked fixture uses, rather than one
     invented here. That is not tidiness: a slower turn and no jump took the
     client on a path where the bots never once got line of sight, so the host
     fired **zero** shots in eighty seconds and the missile assertions below
     were about a pool that had never held anything. Sharing the walk shares the
     match everything else in the suite is measured against.
    */
    client.script = (cmd, frame) => {
        circleWalk(cmd, frame);
        cmd.weapon = weaponIndex('WP_ROCKET_LAUNCHER') + 1;
        cmd.buttons |= C.BUTTON_ATTACK;
    };

    /*
     **The client fires the rockets, not a bot.** These assertions are about
     presenting a *replicated* missile, and every version of this fixture that
     waited on the AI to produce one was silently vacuous sooner or later: three
     bots on seed 77 played a whole match without firing a rocket, and handing a
     bot a launcher only moved the dependency to whether the bot ever saw
     anybody -- which stopped happening again the moment meep 3.14.6 changed
     where a joining client starts and therefore where it walks.

     A test whose subject appears only when the pathfinding cooperates is a test
     that passes by not running. The client's own trigger is deterministic: the
     host grants the weapon, `NetInventory` replicates it, `usercmd_t.weapon`
     selects it (D-182) and the cooldown does the rest.
    */
    const mine = rig.host.slots[client.net.slotIndex]!;
    mine.slot.inventory.weapons.add('WP_ROCKET_LAUNCHER');
    mine.slot.inventory.ammo['WP_ROCKET_LAUNCHER'] = 400;

    const recorders = new Map<number, Recorder>();
    const missiles = new MissileLog();
    const audio = new AudioLog();
    const system = new NetPresentationSystem({
        client: client.net,
        missiles,
        audio,
        characterFor: (slot) => {
            let recorder = recorders.get(slot);
            if (recorder === undefined) {
                recorder = new Recorder();
                recorders.set(slot, recorder);
            }
            return recorder;
        },
    });

    const lag: number[] = [];
    const step: number[] = [];
    const previous = new Map<number, number[]>();

    // Warm the link, then measure a steady stretch.
    rig.step(120);

    for (let n = 0; n < FRAMES; n++) {
        rig.step(1);
        missiles.frame = n;
        audio.frame = n;
        system.update(1 / 60);

        for (const slot of client.net.slots) {
            if (slot.info.isBot === 0) continue;
            if (slot.state.connected === 0 || slot.state.alive === 0) continue;

            const drawn = recorders.get(slot.index)!.last;

            /*
             The host's *published* component, not `record.slot.ps`. A bot has
             no `PlayerSlot` -- it drives its own `pmove_t` and `storeBot` is
             what copies it out -- so `slot.ps.origin` for a bot slot is an
             array nothing ever writes. Reading it made the first version of
             this test report 746 units of lag against a stationary zero and
             call it a render delay.
            */
            const truth = rig.host.slots[slot.index]!.state.origin;

            lag.push(
                Math.hypot(drawn[0]! - truth[0]!, drawn[1]! - truth[1]!, drawn[2]! - truth[2]!)
            );

            const before = previous.get(slot.index);
            if (before !== undefined) {
                step.push(
                    Math.hypot(
                        truth[0]! - before[0]!,
                        truth[1]! - before[1]!,
                        truth[2]! - before[2]!
                    )
                );
            }
            previous.set(slot.index, [truth[0]!, truth[1]!, truth[2]!]);
        }
    }

    seen = { rig, recorders, missiles, audio, lag, step };
}, 120_000);

/** The mean of a sample, or zero for an empty one. */
function mean(xs: readonly number[]): number {
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe('what a client draws of the other players', () => {
    it('never draws the player whose eyes it is behind', () => {
        const { rig, recorders } = seen;
        const own = rig.clients[0]!.net.slotIndex;

        expect(
            recorders.get(own)?.positions.length ?? 0,
            'the local slot was placed; Q3 draws no model for your own player'
        ).toBe(0);
    });

    it('draws every bot, and only where the host put it', () => {
        const { rig, recorders, lag, step } = seen;

        const drawn = [...recorders.keys()].filter(
            (i) => rig.host.slots[i]!.info.isBot === 1 && recorders.get(i)!.positions.length > 0
        );

        expect(drawn.length, 'no bot was ever drawn').toBe(4);

        const meanLag = mean(lag);
        const meanStep = mean(step);

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] ${drawn.length} bots drawn over ${FRAMES} frames: ` +
                `mean lag behind the host ${meanLag.toFixed(2)} units ` +
                `(${(meanLag / Math.max(meanStep, 1e-6)).toFixed(1)} frames of motion at ` +
                `${meanStep.toFixed(2)} units a frame), worst ${Math.max(...lag).toFixed(2)}`
        );

        /*
         The render delay, as a distance. `AdaptiveRenderDelay` starts at six
         frames and clamps to 2..30, so a bot moving `meanStep` units a frame is
         drawn somewhere under thirty frames of motion behind the host -- and a
         great deal less than that in practice. The bound is on *frames of its
         own motion* rather than on units, because units would be a statement
         about how fast bots run rather than about the netcode.

         Zero would be wrong here, not right: it would mean the client was
         drawing the newest snapshot it had and stuttering between them.
        */
        expect(meanLag, 'remote players are drawn at the host position exactly').toBeGreaterThan(
            0
        );
        expect(
            meanLag / Math.max(meanStep, 1e-6),
            'remote players are drawn further behind than the render delay allows'
        ).toBeLessThan(30);
    });

    it('animates from replicated velocity, not from a guess', () => {
        const { rig, recorders } = seen;

        /*
         Every bot spends a match running, walking, standing and in the air, and
         the four animations are chosen from `velocity`, `groundEntityNum` and
         the sign of the velocity along the view -- all replicated. If any of
         those were arriving as zero the choice would collapse onto one
         animation, which is exactly what this counts.
        */
        const chosen = new Set<LegsAnimation>();
        for (const [slot, recorder] of recorders) {
            if (rig.host.slots[slot]!.info.isBot === 0) continue;
            for (const legs of recorder.legs) chosen.add(legs);
        }

        // eslint-disable-next-line no-console
        console.log(`[net-presentation] leg animations seen: ${[...chosen].sort().join(', ')}`);

        expect(chosen.has('LEGS_RUN'), 'no bot was ever seen running').toBe(true);
        expect(
            chosen.size,
            'every bot held one animation for the whole match; velocity is not arriving'
        ).toBeGreaterThan(1);
    });

    it('parks the slots nobody is in, instead of drawing a stranger', () => {
        const { rig, recorders } = seen;

        let parked = 0;
        for (let i = 0; i < MAX_CLIENTS; i++) {
            const record = rig.clients[0]!.net.slots[i]!;
            if (record.state.connected !== 0) continue;

            const recorder = recorders.get(i);
            if (recorder === undefined || recorder.positions.length === 0) continue;

            parked += 1;
            expect(
                recorder.last[2],
                `slot ${i} is empty and was drawn at z ${recorder.last[2]}`
            ).toBeLessThan(-1000);
        }

        expect(parked, 'no empty slot was exercised; the fixture changed').toBeGreaterThan(0);
    });

    it('puts a model on every missile the host fires, and takes it away again', () => {
        const { missiles } = seen;

        const spawns = missiles.events.filter((e) => e.what === 'spawn');
        const despawns = missiles.events.filter((e) => e.what === 'despawn');
        const weapons = new Set(spawns.map((e) => e.weapon));

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] missiles: ${spawns.length} spawned, ${despawns.length} ` +
                `despawned, ${missiles.live.size} still in the air, weapons ` +
                `${[...weapons].sort().join(', ') || 'none'}; ` +
                `${missiles.advanced} roll updates`
        );

        expect(
            spawns.length,
            `no missile was drawn in ${FRAMES} frames, with a bot handed a rocket launcher`
        ).toBeGreaterThan(0);

        /*
         Everything that appeared has gone away again, except whatever is still
         flying at the last frame. A leak here is a rocket that hangs in the air
         for the rest of the match, which is what a pool without `generation`
         handling looks like from the outside.
        */
        expect(
            spawns.length - despawns.length,
            'more missiles were spawned than were despawned or are still in flight'
        ).toBe(missiles.live.size);

        expect(missiles.advanced, 'the roll was never advanced').toBe(FRAMES);
    });

    it('never lets a reused pool slot streak across the level', () => {
        const { missiles } = seen;

        /*
         The whole reason `NetMissile` carries a `generation`. The host frees a
         pool slot the moment its missile dies and reuses it for the next shot,
         so a slot that is not noticed to have changed hands is a model that
         teleports from where a grenade exploded to where a rocket was just
         fired, drawing a line across the level on the way.

         Measured as the largest single-frame move of a slot that stayed the
         same missile throughout. A rocket travels 900 units a second, so about
         15 a frame; the bound is generous enough to allow the render delay
         moving around and tight enough that a slot changing hands unnoticed --
         hundreds or thousands of units -- fails it.
        */
        const worst = missiles.jumps.length === 0 ? 0 : Math.max(...missiles.jumps);

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] worst single-frame missile move: ${worst.toFixed(1)} units ` +
                `over ${missiles.jumps.length} samples`
        );

        expect(missiles.jumps.length, 'no missile was tracked for more than a frame').toBeGreaterThan(
            0
        );
        expect(worst, 'a pool slot changed hands without being noticed').toBeLessThan(200);
    });
});

describe('what a client hears of the other players', () => {
    it('plays a footstep for every remote slot that walks, and none for itself', () => {
        const { audio, rig, missiles } = seen;
        void missiles;

        const bySlot = new Map<number, number>();
        for (const step of audio.steps) bySlot.set(step.slot, (bySlot.get(step.slot) ?? 0) + 1);

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] footsteps over ${FRAMES} frames: ` +
                [...bySlot.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([slot, n]) => `slot ${slot} ${n}`)
                    .join(', ') +
                `; landings ${audio.landings.length}`
        );

        /*
         Every bot the host is running is heard. Four bots walk for the whole
         measured stretch, so a slot with no steps at all is a slot whose
         `bobCycle` never reached this system -- which is the failure the whole
         arrangement exists to catch, and is silent in a browser because a
         footstep you do not hear sounds like a footstep somewhere else.
        */
        const bots = rig.host.slots.filter((slot) => slot.bot !== null && slot.connected);
        expect(bots.length).toBeGreaterThan(0);
        for (const slot of bots) {
            expect(
                bySlot.get(slot.index) ?? 0,
                `slot ${slot.index} walked a whole match in silence`
            ).toBeGreaterThan(0);
        }

        /*
         And never the local slot. Q3 plays the local player's footsteps through
         `CG_PlayerAnimation` on the predicted state, not from the wire, and a
         second copy from here would double every step the player takes.
        */
        const local = seen.rig.clients[0]!.net.slotIndex;
        expect(bySlot.get(local) ?? 0, 'the client heard its own feet twice').toBe(0);
    });

    it('fires at the rate PM_Footsteps does, not once per frame', () => {
        const { audio } = seen;

        /*
         The number that says the crossing test is doing its job.

         `PM_Footsteps` advances `bobCycle` by `0.4 * msec` while running and
         fires when it crosses 64 or 192, so a player running flat out steps
         every 320 ms -- about ten frames at 30 Hz -- whatever their speed. A
         version of this that fired on any change in the cycle would produce one
         per frame per slot; a version that compared one slot's cycle against
         another's would produce even more.

         Measured at **19.3 frames**, twice the flat-out figure, and that is the
         bots rather than the mechanism: `advanceBobCycle` holds the cycle still
         while a slot is airborne or pressing nothing, and a bot on `oa_dm1` is
         grounded 69% of the time and stops to turn. About 120 steps per bot per
         eighty seconds.

         Measured per slot rather than in total, because four bots stepping
         independently is four times the rate and says nothing about any of them.
        */
        const bySlot = new Map<number, number[]>();
        for (const step of audio.steps) {
            const list = bySlot.get(step.slot) ?? [];
            list.push(step.frame);
            bySlot.set(step.slot, list);
        }

        const gaps: number[] = [];
        for (const frames of bySlot.values()) {
            for (let i = 1; i < frames.length; i++) gaps.push(frames[i]! - frames[i - 1]!);
        }

        expect(gaps.length, 'not enough footsteps to measure a rate').toBeGreaterThan(50);

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] gap between one slot's footsteps: mean ` +
                `${mean(gaps).toFixed(1)} frames over ${gaps.length} intervals`
        );

        /*
         Bounded either side. Below 3 means the crossing test is firing on
         something other than a crossing; above 30 means a whole second of
         running between steps, which is a cycle that is not advancing.
        */
        expect(mean(gaps)).toBeGreaterThan(3);
        expect(mean(gaps)).toBeLessThan(30);
    });

    it('never plays a footstep for a slot in the air', () => {
        /*
         The airborne case is the one `Footsteps` distinguishes with its own
         branch, and it is also the one a naive cycle comparison gets wrong:
         `PM_Footsteps` returns *before* advancing the cycle when
         `groundEntityNum` is `ENTITYNUM_NONE`, so a jumping player's cycle is
         frozen at whatever it held on take-off -- and the frame they land, the
         cycle starts moving again from there. A tracker that only watched the
         cycle would find a crossing mid-jump; one that only watched the ground
         would find a step on landing.

         Re-driven here rather than sampled from the match above, because a bot
         on `oa_dm1` jumps when the pathfinding says to and a fixture that waits
         for that is a fixture that measures whether it happened.
        */
        const tracker = new Footsteps();

        // Running on the ground: the cycle advances and crosses 64.
        expect(tracker.update(50, true, false, false)).toBe(null);
        expect(tracker.update(70, true, false, false)).toBe('step');

        // Airborne. The cycle is frozen at 70, which is what the host sends.
        expect(tracker.update(70, false, false, false)).toBe(null);
        expect(tracker.update(70, false, false, false)).toBe(null);

        /*
         Landing. `Footsteps` reports the landing rather than a step, and this
         is the assertion that distinguishes the two: a frozen cycle crossing
         nothing plus a ground transition is exactly one sound, not two and not
         none.
        */
        expect(tracker.update(70, true, false, false)).toBe('land');

        // And running again from where it left off crosses 192.
        expect(tracker.update(180, true, false, false)).toBe(null);
        expect(tracker.update(200, true, false, false)).toBe('step');
    });

    it('says nothing for a crouching slot, which is the one bit that is replicated', () => {
        const tracker = new Footsteps();

        /*
         `PM_Footsteps` gives a ducked player `bobmove = 0.5` -- a *faster*
         cycle -- and plays no footstep from it, because a crouched player is
         sneaking. So the ducked branch is not "moves less" but "crosses more
         often and is silent", and dropping the flag would make crouching the
         loudest way to cross a room.

         `ducked` is on the wire, unlike `BUTTON_WALKING`, so this one is exact
         rather than inferred -- see `WALK_SPEED_CEILING` for the one that is not.
        */
        expect(tracker.update(50, true, true, false)).toBe(null);
        expect(tracker.update(80, true, true, false)).toBe(null);
    });
});
