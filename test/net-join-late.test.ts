/*
 * net-join-late.test.ts -- joining a match that has been running for a while.
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
 * The engine has no answer for this and the shape of the hole is specific.
 *
 * A client's session frame counter starts at 0 in `start()`. The host's is
 * wherever the match has got to. The `onInitialSync` handler is handed the
 * host's `frame_number` and **ignores it**, and `#local_frame` is `#private`,
 * so there is no supported way to tell a client what time it is. Meanwhile the
 * host trims pending actions older than `sim_frame - frame_capacity + 1`, so a
 * client that joins a host at frame 6000 tagging its inputs 0, 1, 2 has every
 * one of them dropped, silently, for ever: it moves on its own screen, it never
 * moves on the host's, and nothing anywhere reports a problem.
 *
 * The workaround is to tick the session forward with the input sampler
 * silenced until its own counter catches up, which is the only lever there is.
 * This file is what says the workaround works, and what it costs -- because the
 * cost is the interesting part of a workaround that runs a loop 28,801 times.
 */

import { describe, expect, it } from 'vitest';

import { NetRig } from './net/rig.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import { SIMULATION_DELAY_TICKS } from '../src/net/protocol.ts';

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** The same tight circle `net-loopback.test.ts` walks, for the same reason. */
function circleWalk(cmd: { angles: Int16Array; moves: Int8Array }, frame: number): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

describe('a client joining a host at frame 6000', () => {
    it('is playing within a second, and the host sees it move', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 0, seed: 42 });

        rig.step(6000);
        expect(rig.host.currentFrame).toBe(6000);

        const client = await rig.join('late', 1);

        /*
         Aligned, and aligned to the host's frame plus the lead rather than to
         zero. Without this the client's first input would be tagged frame 0
         against a host that trimmed frame 0 out of its ring ninety seconds ago.
        */
        expect(client.net.currentFrame).toBeGreaterThanOrEqual(6000);
        expect(client.net.currentFrame).toBeLessThanOrEqual(6000 + SIMULATION_DELAY_TICKS + 4);

        const slotIndex = client.net.slotIndex;
        let previous = [...rig.host.slots[slotIndex]!.state.origin];
        let walked = 0;

        client.script = circleWalk;
        for (let n = 0; n < 120; n++) {
            rig.step(1);
            const now = [...rig.host.slots[slotIndex]!.state.origin];
            walked += Math.hypot(now[0]! - previous[0]!, now[1]! - previous[1]!);
            previous = now;
        }

        /*
         Two seconds, not one, and the difference is the join itself: the client
         does not predict until INITIAL_SYNC has landed, which is the host tick
         after `connect`, and the first commands then have to reach a host that
         is four frames behind its own wall clock. Measured: 99 units of path in
         the first second and about 350 in the first two, against 320 u/s of run
         speed -- so roughly the first thirty frames are the handshake.
        */
        expect(walked, "the host never saw the late joiner's input").toBeGreaterThan(200);

        /*
         And the host's input buffer has settled. `buffer_depth_for_peer` is
         `max_received_frame - current_sim_frame`, so a positive number means
         the peer is sending ahead of the simulation, which is the whole point
         of `simulation_delay_ticks`. Measured at 3 against a delay of 4 -- one
         short, because the rig delivers the client's packets after the host has
         already ticked, which is the tightest honest arrangement a loopback can
         have.
        */
        const depth = rig.host.session.server!.buffer_depth_for_peer(client.net.peerId);
        expect(depth).toBeGreaterThan(0);
        expect(depth).toBeLessThanOrEqual(SIMULATION_DELAY_TICKS);
    });

    it('settles to the same reconcile rate as a client that was there all along', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 0, seed: 42 });
        rig.step(6000);

        const client = await rig.join('late', 1);
        client.script = circleWalk;

        const at = (frames: number): number => {
            while (rig.host.currentFrame < 6000 + frames) rig.step(1);
            return client.net.reconcileCount;
        };

        const after2s = at(120);
        const after5s = at(300);
        const after20s = at(1200);

        // eslint-disable-next-line no-console
        console.log(
            `[net-join-late] reconciles after join: 2 s ${after2s}, 5 s ${after5s}, ` +
                `20 s ${after20s}; never-predicted ${client.net.shortCircuitNoRing}, ` +
                `disagreed ${client.net.shortCircuitDisagreed}`
        );

        /*
         A join is a transient and then a rate. The transient is real and has a
         cause: the client's first predicted frame loads the state INITIAL_SYNC
         delivered, which is several frames older than the frame being
         predicted, so the two disagree until the AUTH_STATE corrections have
         walked the client up to the present. Measured at about thirty over the
         first two seconds.

         What matters is what happens after: from five seconds on the rate is
         one per second, which is exactly the health bleed of D-170 and is the
         same rate a client that joined at frame zero pays. So the *join* costs
         a burst and costs nothing afterwards.
        */
        const transient = after2s;
        const steadyRate = (after20s - after5s) / 15;

        expect(transient).toBeLessThan(60);
        expect(steadyRate, 'the late joiner never settles').toBeLessThan(1.5);
    });
});

describe('the frame-alignment workaround', () => {
    it('costs a loop whose length is the age of the match', async () => {
        const measured: { frame: number; calls: number; ms: number }[] = [];

        for (const age of [0, 600, 6000, 36000]) {
            const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 0, seed: 42 });
            rig.step(age);
            const client = await rig.join('late', 1);
            measured.push({
                frame: age,
                calls: client.align.calls,
                ms: client.align.milliseconds,
            });
        }

        // eslint-disable-next-line no-console
        console.log(
            '[net-join-late] frame alignment: ' +
                measured
                    .map((m) => `${m.frame} frames -> ${m.calls} calls / ${m.ms.toFixed(1)} ms`)
                    .join('; ')
        );

        /*
         The loop asks for eight frames a call and averages **seven and a half**,
         which is D-167's six hundred picoseconds turning up a third time:
         `8 * (1 / 60) * 1000` is 133.33333333333331 and eight of the session's
         own periods is 133.33333333333333, so the accumulator falls one step
         short on every other call. 801 calls to cover 6,006 frames, 4,801 for
         36,006, and 28,801 for the 216,000 frames of a one-hour-old match --
         which is the number `NETWORK_PLAN.md` §4.4 asked for, and it measured
         **62.5 ms** on this machine against the 250 ms threshold the plan set
         for "consider making the host restart its frame count per match". It is
         comfortably under, so the host keeps one counter for its whole life and
         the workaround stays a loop.

         Asserted as a shape rather than as a duration: the call count is
         arithmetic and reproduces, and the milliseconds are a machine.
        */
        for (const m of measured) {
            expect(m.calls).toBeGreaterThan(0);
            expect(m.calls * 8, 'the loop cannot have covered the distance').toBeGreaterThanOrEqual(
                m.frame
            );
            expect(m.calls).toBeLessThanOrEqual(Math.ceil(m.frame / 7) + 8);
        }
        expect(measured[3]!.calls).toBeGreaterThan(measured[2]!.calls);
    });
});

describe('two clients, joined at different times', () => {
    it('each sees the other move', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 0, seed: 42 });

        rig.step(6000);
        const first = await rig.join('first', 1);
        first.script = circleWalk;

        rig.step(3000);
        expect(rig.host.currentFrame).toBeGreaterThanOrEqual(9000);

        const second = await rig.join('second', 2);
        second.script = (cmd, frame) => {
            cmd.angles[1] = angleToShort(-frame * 4);
            cmd.moves[FORWARDMOVE] = 127;
        };

        expect(second.net.slotIndex).not.toBe(first.net.slotIndex);

        // Let both settle, then watch each one's view of the other.
        rig.step(60);

        const firstSeesSecond = [...first.net.slots[second.net.slotIndex]!.state.origin];
        const secondSeesFirst = [...second.net.slots[first.net.slotIndex]!.state.origin];

        let firstWatched = 0;
        let secondWatched = 0;
        let previousA = firstSeesSecond;
        let previousB = secondSeesFirst;

        for (let n = 0; n < 180; n++) {
            rig.step(1);
            const a = [...first.net.slots[second.net.slotIndex]!.state.origin];
            const b = [...second.net.slots[first.net.slotIndex]!.state.origin];
            firstWatched += Math.hypot(a[0]! - previousA[0]!, a[1]! - previousA[1]!);
            secondWatched += Math.hypot(b[0]! - previousB[0]!, b[1]! - previousB[1]!);
            previousA = a;
            previousB = b;
        }

        expect(firstWatched, 'the first client never saw the second move').toBeGreaterThan(100);
        expect(secondWatched, 'the second client never saw the first move').toBeGreaterThan(100);

        /*
         And each one's view of the other is the host's, not a stale copy: at
         the end of a step every remote component has been restored to canonical
         form, so this compares numbers rather than a render blend.
        */
        const hostSecond = rig.host.slots[second.net.slotIndex]!.state.origin;
        const seen = first.net.slots[second.net.slotIndex]!.state.origin;
        const lag = Math.hypot(seen[0]! - hostSecond[0]!, seen[1]! - hostSecond[1]!);
        expect(lag, 'a remote slot is further behind than a frame of travel').toBeLessThan(64);
    });

    it('puts them in different slots and frees one when it leaves', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 2, clients: 2, seed: 8 });

        const [a, b] = rig.clients;
        expect(a!.net.slotIndex).toBe(0);
        expect(b!.net.slotIndex).toBe(1);

        rig.step(30);

        expect(rig.host.slots[0]!.connected).toBe(true);
        expect(rig.host.slots[1]!.connected).toBe(true);

        rig.host.release(b!.net.peerId);

        expect(rig.host.slots[1]!.connected).toBe(false);
        expect(rig.host.slots[1]!.peerId).toBe(-1);

        // And the freed slot is the next one handed out.
        expect(rig.host.lowestFreeSlot()).toBe(1);

        // The host keeps running with a hole in the middle of its roster.
        rig.step(60);
        for (const slot of rig.host.slots) {
            for (const v of slot.state.origin) expect(Number.isFinite(v)).toBe(true);
        }
    });
});
