/*
 * net-clock.test.ts -- the two clocks a networked frame runs on.
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
 * Nothing in this file touches a transport. It is about arithmetic, because
 * both of the clocks a networked frame runs on are arithmetic and both of them
 * fail silently.
 *
 * **Q3's millisecond.** `frameMsec` derives the 16/17 pattern from the frame
 * number rather than from a running total, so a host at frame 6000 and a client
 * that has just fast-forwarded to 6000 agree about frame 6000 without having
 * agreed about anything before it. What has to hold is what an accumulator
 * gives for free and a closed form does not: sixty consecutive frames sum to
 * exactly 1000 and no frame is ever worth anything but 16 or 17 ms.
 *
 * **The session's step.** `NetworkSession.tick(dt)` runs its own fixed-step
 * accumulator; it does not call `EntityManager.update` and it does not read
 * `fixedUpdateStepSize`. The obvious thing to hand it -- the engine's own step,
 * which is what the surrounding `fixedUpdate` was called with -- is wrong, and
 * wrong by six hundred picoseconds:
 *
 *     em.fixedUpdateStepSize * 1000 = 16.666666666
 *     session.tick_period_ms        = 16.666666666666666
 *
 * The first is smaller, so the session's `while (accum >= period)` fails on the
 * first call, that step never happens, and the session runs one frame behind
 * its caller for the rest of the match. Nothing reports it. A client one frame
 * behind its own reckoning sends every input tagged with the wrong frame, and
 * the host applies each one to the state before the one the client predicted
 * against -- which presents as constant, small, unexplainable corrections, i.e.
 * as a bad network rather than as a bad constant.
 *
 * So it is asserted here rather than remembered, in both directions: the right
 * argument steps once per call from the first call, and the wrong one is
 * measurably behind and stays behind.
 */

import { describe, expect, it } from 'vitest';

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';

import { createSession } from '../src/net/session.ts';
import {
    FRAME_CAPACITY,
    SESSION_TICK_SECONDS,
    TICK_HZ,
    frameMsec,
    frameTimeMs,
} from '../src/net/protocol.ts';

/**
 * A host session on a bare `EntityManager`: no map, no bodies, no transport,
 * no peers. `simulation_delay_ticks` is 0 rather than the host's own 4 so that
 * `session.current_frame` -- which for a host reads
 * `ServerAuthoritativeServer.current_sim_frame` -- *is* the session's frame
 * counter rather than the counter minus the input buffer. The buffer is a
 * separate property with its own test; this one is about the accumulator.
 */
async function hostSession(): Promise<{ em: EntityManager; session: NetworkSession }> {
    const em = new EntityManager();
    em.attachDataset(new EntityComponentDataset());

    await new Promise<void>((resolve, reject) => {
        em.startup(resolve, reject);
    });

    const session = createSession({
        entity_manager: em,
        role: 'host',
        local_peer_id: 0,
        simulation_delay_ticks: 0,
        tick_rate_hz: TICK_HZ,
        frame_capacity: FRAME_CAPACITY,
    });

    await session.start();

    return { em, session };
}

describe('frameMsec', () => {
    it('is only ever 16 or 17', () => {
        const seen = new Set<number>();
        for (let frame = 0; frame < 100_000; frame++) {
            seen.add(frameMsec(frame));
        }
        expect([...seen].sort((a, b) => a - b)).toEqual([16, 17]);
    });

    it('sums to exactly 1000 over any sixty consecutive frames', () => {
        for (let start = 0; start < 600; start++) {
            let total = 0;
            for (let frame = start; frame < start + 60; frame++) {
                total += frameMsec(frame);
            }
            expect(total).toBe(1000);
        }
    });

    it('never drifts from wall time, a million frames in', () => {
        /*
         The property an accumulator cannot have. A running total of 16.666...
         is 4.6 hours of double-precision addition by frame 1e6; this is two
         integer divisions, so the millisecond at frame N is the same number
         however you got to N.
        */
        expect(frameTimeMs(1_000_000)).toBe(16_666_666);
        expect(frameTimeMs(60)).toBe(1000);
        expect(frameTimeMs(0)).toBe(0);

        let walked = 0;
        for (let frame = 0; frame < 20_000; frame++) {
            expect(frameTimeMs(frame)).toBe(walked);
            walked += frameMsec(frame);
        }
    });
});

describe('NetworkSession.tick, driven by the session period', () => {
    it('advances exactly one frame per call, from the first call', async () => {
        const { session } = await hostSession();

        expect(session.current_frame).toBe(-1);

        for (let call = 0; call < 240; call++) {
            session.tick(SESSION_TICK_SECONDS);
            expect(session.current_frame).toBe(call);
        }

        session.stop();
    });

    it('agrees with the constant the protocol exports', async () => {
        const { session } = await hostSession();
        expect(SESSION_TICK_SECONDS).toBe(session.tick_period_ms / 1000);
        session.stop();
    });
});

describe("NetworkSession.tick, driven by the engine's fixed step", () => {
    it("skips the first step, because the engine's step is short of the period", async () => {
        const { em, session } = await hostSession();

        /*
         The trap, stated as the numbers rather than as the conclusion. If the
         engine ever makes its default exactly 1/60 this assertion is what says
         so, and the workaround below can go.
        */
        expect(em.fixedUpdateStepSize).toBe(0.016666666666);
        expect(em.fixedUpdateStepSize * 1000).toBeLessThan(session.tick_period_ms);

        session.tick(em.fixedUpdateStepSize);
        expect(session.current_frame).toBe(-1);

        session.stop();
    });

    it('stays exactly one frame behind for the rest of the match', async () => {
        const { em, session } = await hostSession();

        for (let call = 0; call < 600; call++) {
            session.tick(em.fixedUpdateStepSize);
        }

        /*
         600 calls, 599 frames. The deficit per call is 6.7e-10 ms, so the
         accumulator never recovers the lost step and never loses a second one
         inside any match anybody will play: it would take about 2.5e10 further
         steps, which is thirteen years at 60 Hz.
        */
        expect(session.current_frame).toBe(598);

        session.stop();
    });
});
