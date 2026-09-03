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
 * The engine had no answer for this and the shape of the hole was specific.
 *
 * A client's session frame counter starts at -1. The host's is wherever the
 * match has got to. The `onInitialSync` handler was handed the host's
 * `frame_number` and **ignored it** -- the parameter was named
 * `_frame_number` -- and `#local_frame` was `#private`, so there was no
 * supported way to tell a client what time it is. Meanwhile the host trims
 * pending actions older than `sim_frame - frame_capacity + 1`, so a client that
 * joined a host at frame 6000 tagging its inputs 0, 1, 2 had every one of them
 * dropped, silently, for ever: it moved on its own screen, it never moved on
 * the host's, and nothing anywhere reported a problem.
 *
 * **meep 3.14.6 seeks the counter itself** and `NetClient.fastForward` came out
 * with D-188. So this file no longer measures a workaround; it measures the
 * property the workaround existed to produce -- a joining client lands on the
 * host's clock -- and it measures it for a host that has been up for an hour,
 * because that is the case where getting it wrong is total and silent.
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
         Nothing is aligned yet, and that is the shape of the change: the seek
         happens inside `onInitialSync`, which is the host tick after the
         connect, where the workaround used to have run the counter up before
         the connect. A session that has started and not synced is at -1.
        */
        expect(client.net.synced).toBe(false);
        expect(client.net.currentFrame).toBeLessThan(1);

        let stepsToSync = 0;
        while (!client.net.synced && stepsToSync < 30) {
            rig.step(1);
            stepsToSync += 1;
        }

        /*
         Aligned, and aligned to the host's frame plus a lead rather than to
         zero. Without this the client's first input would be tagged frame 0
         against a host that trimmed frame 0 out of its ring ninety seconds ago.

         The lead is the engine's, not this port's: `seek_to_frame(frame_number
         + 1 + target_buffer_depth)` with `TimeDilation`'s initial target of 2,
         so three frames past the snapshot's own frame, and the host has ticked
         `stepsToSync` times while the snapshot was in flight. The workaround
         used to guess `SIMULATION_DELAY_TICKS + 2`, which is more; the range
         below still bounds both, because what matters here is that it is near
         6000 rather than near zero.
        */
        expect(stepsToSync, 'INITIAL_SYNC never landed').toBeLessThan(30);
        expect(client.net.currentFrame).toBeGreaterThanOrEqual(6000);
        expect(client.net.currentFrame).toBeLessThanOrEqual(6000 + SIMULATION_DELAY_TICKS + 4);

        const slotIndex = client.net.slotIndex;
        let previous = [...rig.host.playerById(slotIndex)!.state.origin];
        let walked = 0;

        client.script = circleWalk;
        for (let n = 0; n < 120; n++) {
            rig.step(1);
            const now = [...rig.host.playerById(slotIndex)!.state.origin];
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

describe('the alignment the engine now performs', () => {
    it("lands a joiner on the host's clock at a cost the age of the match is not in", async () => {
        const measured: { age: number; ms: number; steps: number; lead: number }[] = [];

        /*
         The same four ages the workaround was measured over, so the two tables
         can be read against each other. The last is ten minutes of match; the
         workaround needed 4,801 iterations of its loop to cover it and 28,801
         for an hour.
        */
        for (const age of [0, 600, 6000, 36000]) {
            const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 0, seed: 42 });
            rig.step(age);

            const hostFrame = rig.host.currentFrame;
            const client = await rig.join('late', 1);

            let steps = 0;
            while (!client.net.synced && steps < 30) {
                rig.step(1);
                steps += 1;
            }

            measured.push({
                age,
                ms: client.align.milliseconds,
                steps,
                lead: client.net.currentFrame - hostFrame,
            });
        }

        // eslint-disable-next-line no-console
        console.log(
            '[net-join-late] engine alignment: ' +
                measured
                    .map(
                        (m) =>
                            `${m.age} frames -> ${m.ms.toFixed(2)} ms / ${m.steps} host ticks / ` +
                            `lead ${m.lead}`
                    )
                    .join('; ')
        );

        /*
         What this asserts, and why it is worth a test at all now that the loop
         is gone.

         The property is **flatness**. `NetworkSession.seek_to_frame` is an
         assignment, so the join costs the same for a host that has been up for
         ten minutes as for one that started this frame -- where the workaround
         cost 4,801 iterations for the first and 1 for the second. Asserting a
         duration would be asserting this machine, so what is asserted is that
         the alignment does not scale: the wall clock is bounded by a constant
         that the 36,000-frame case would blow through by two orders of
         magnitude if a loop were still running, and the *number of host ticks*
         it takes -- the honest unit, since the seek happens on a dispatch --
         is identical at every age.

         Measured: 0.06-0.23 ms at every age, **1** host tick at every age, and
         a lead of **4** frames past the host's simulation frame at every age --
         3 of them the engine's `frame_number + 1 + target_buffer_depth` and the
         fourth the host tick that carried the snapshot. Against 4,801 loop
         iterations and 14 ms for the 36,000-frame case before.
        */
        for (const m of measured) {
            expect(m.ms, 'the join is doing work proportional to the match age').toBeLessThan(5);
            expect(m.steps, 'INITIAL_SYNC never landed').toBeLessThan(30);
        }

        const steps = measured.map((m) => m.steps);
        expect(new Set(steps).size, 'the join took longer for an older host').toBe(1);

        const leads = measured.map((m) => m.lead);
        expect(new Set(leads).size, "the lead depends on the host's age").toBe(1);

        /*
         And the lead is the engine's: `frame_number + 1 + target_buffer_depth`
         against `TimeDilation`'s initial target of 2, measured from the host's
         simulation frame at the moment of the connect. Bounded rather than
         pinned to 3, because the target is the engine's to change and what this
         port needs is that the number is small and positive -- a joiner has to
         tag its inputs *ahead* of the host or they arrive for a frame already
         run.
        */
        for (const m of measured) {
            expect(m.lead, 'a joiner is tagging inputs the host has already run').toBeGreaterThan(0);
            expect(m.lead).toBeLessThanOrEqual(SIMULATION_DELAY_TICKS + 4);
        }
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

        const firstSeesSecond = [...first.net.playerById(second.net.slotIndex)!.state.origin];
        const secondSeesFirst = [...second.net.playerById(first.net.slotIndex)!.state.origin];

        let firstWatched = 0;
        let secondWatched = 0;
        let previousA = firstSeesSecond;
        let previousB = secondSeesFirst;

        for (let n = 0; n < 180; n++) {
            rig.step(1);
            const a = [...first.net.playerById(second.net.slotIndex)!.state.origin];
            const b = [...second.net.playerById(first.net.slotIndex)!.state.origin];
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
        const hostSecond = rig.host.playerById(second.net.slotIndex)!.state.origin;
        const seen = first.net.playerById(second.net.slotIndex)!.state.origin;
        const lag = Math.hypot(seen[0]! - hostSecond[0]!, seen[1]! - hostSecond[1]!);
        expect(lag, 'a remote slot is further behind than a frame of travel').toBeLessThan(64);
    });

    it('gives them different ids and takes one away when it leaves', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 2, clients: 2, seed: 8 });

        const [a, b] = rig.clients;
        expect(a!.net.slotIndex).toBe(0);
        expect(b!.net.slotIndex).toBe(1);

        rig.step(30);

        expect(rig.host.playerById(0)!.connected).toBe(true);
        expect(rig.host.playerById(1)!.connected).toBe(true);

        rig.host.release(b!.net.peerId);

        /*
         Gone rather than marked absent: there is no entry for a player who is
         not here (D-194), so the id is free and the population is one smaller.
        */
        expect(rig.host.playerById(1), 'the host kept the leaver').toBeUndefined();
        expect(rig.host.lowestFreeSlot(), 'the freed id was not reoffered').toBe(1);
        expect(rig.host.players.length).toBe(3);

        /*
         The host keeps running with the id missing from the middle of its
         roster -- which is a stronger statement than it used to be. It used to
         mean a slot sitting there disconnected; it now means the ids are not
         contiguous and nothing iterates them as though they were.
        */
        rig.step(60);
        expect(rig.host.players.map((p) => p.index).sort((x, y) => x - y)).toEqual([0, 14, 15]);
        for (const player of rig.host.players) {
            for (const v of player.state.origin) expect(Number.isFinite(v)).toBe(true);
        }
    });
});
