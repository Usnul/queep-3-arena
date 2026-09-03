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
    type RemoteCharacter,
} from '../src/app/netSystems.ts';
import { MAX_CLIENTS } from '../src/net/protocol.ts';
import { FORWARDMOVE } from '../src/q3/pmove/types.ts';
import type { LegsAnimation, TorsoAnimation } from '../src/client/Characters.ts';

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

interface Seen {
    rig: NetRig;
    recorders: Map<number, Recorder>;
    missiles: MissileLog;
    /** Distance between the drawn position and the host's, per frame, per bot. */
    lag: number[];
    /** How far a bot moved between consecutive frames, for scale. */
    step: number[];
}

let seen: Seen;

beforeAll(async () => {
    const rig = await NetRig.create({ map: 'oa_dm1', bots: 3, clients: 1, seed: 77, warmup: 40 });
    const client = rig.clients[0]!;

    // Walking, so the bots have somebody to chase and the remote motion under
    // test is motion rather than a still frame.
    client.script = (cmd, frame) => {
        cmd.angles[1] = Math.round((frame * 2 * 65536) / 360) & 65535;
        cmd.moves[FORWARDMOVE] = 96;
    };

    const recorders = new Map<number, Recorder>();
    const missiles = new MissileLog();
    const system = new NetPresentationSystem({
        client: client.net,
        missiles,
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

    for (let n = 0; n < 600; n++) {
        rig.step(1);
        missiles.frame = n;
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

    seen = { rig, recorders, missiles, lag, step };
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

        expect(drawn.length, 'no bot was ever drawn').toBe(3);

        const meanLag = mean(lag);
        const meanStep = mean(step);

        // eslint-disable-next-line no-console
        console.log(
            `[net-presentation] ${drawn.length} bots drawn over 600 frames: ` +
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

        expect(spawns.length, 'no missile was ever drawn in 600 frames with 3 bots').toBeGreaterThan(
            0
        );

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

        expect(missiles.advanced, 'the roll was never advanced').toBe(600);
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
