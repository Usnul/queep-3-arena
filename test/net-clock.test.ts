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
import { NetClientSystem } from '../src/app/netSystems.ts';
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
    it('is only ever the two integers either side of the period', () => {
        /*
         Written against `TICK_HZ` rather than against 16 and 17, which is what
         it said until the rate moved to 30. A clock test that names the numbers
         one rate produces is a test that has to be edited to pass at another --
         and editing a clock test to make it pass is exactly how a two per cent
         drift ships. The property is rate-free: every frame is one of the two
         integers bracketing `1000 / TICK_HZ`, and nothing else ever appears.
        */
        const period = 1000 / TICK_HZ;
        const low = Math.floor(period);
        const high = Math.ceil(period);

        const seen = new Set<number>();
        for (let frame = 0; frame < 100_000; frame++) {
            seen.add(frameMsec(frame));
        }

        const sorted = [...seen].sort((a, b) => a - b);
        expect(sorted).toEqual(low === high ? [low] : [low, high]);
    });

    it('sums to exactly 1000 over any TICK_HZ consecutive frames', () => {
        for (let start = 0; start < 600; start++) {
            let total = 0;
            for (let frame = start; frame < start + TICK_HZ; frame++) {
                total += frameMsec(frame);
            }
            expect(total, `frames ${start}..${start + TICK_HZ}`).toBe(1000);
        }
    });

    it('never drifts from wall time, a million frames in', () => {
        /*
         The property an accumulator cannot have. A running total of 16.666...
         is 4.6 hours of double-precision addition by frame 1e6; this is two
         integer divisions, so the millisecond at frame N is the same number
         however you got to N.
        */
        expect(frameTimeMs(1_000_000)).toBe(Math.floor(1_000_000_000 / TICK_HZ));
        expect(frameTimeMs(TICK_HZ)).toBe(1000);
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

    it('advances at its own rate rather than its callers', async () => {
        const { em, session } = await hostSession();

        const CALLS = 600;
        for (let call = 0; call < CALLS; call++) {
            session.tick(em.fixedUpdateStepSize);
        }

        /*
         Stated as the arithmetic rather than as a number, because the number
         is a function of two rates and this test used to hard-code the answer
         for one pairing of them. The session steps while its accumulator holds
         a period, so the frames it has run are the whole periods in the time it
         was handed -- and `current_frame` counts from -1, hence the minus one.

         The engine's step being *short* of 1/60 (see above) is what makes this
         a floor rather than an equality: at 60 Hz it costs the first step and
         never another, and at 30 it costs nothing visible because two short
         steps still clear one long period after the third.
        */
        const totalMs = CALLS * em.fixedUpdateStepSize * 1000;
        const expected = Math.floor(totalMs / session.tick_period_ms) - 1;

        expect(session.current_frame).toBe(expected);

        session.stop();
    });
});

describe('NetClientSystem, driven by the engine rather than by the session', () => {
    /**
     * The pacing bug a rate change finds, and the reason this test exists.
     *
     * `fixedUpdate` runs at the engine's rate; `NetClient.step` advances the
     * session by exactly one *session* period. Calling the second once per the
     * first silently asserts that the two rates are equal -- which they were,
     * at 60 Hz, and which stopped being true the day the session moved to 30.
     * A client that steps its session twice per period runs at twice real time:
     * permanently ahead of the host, every AUTH_STATE arriving for a frame it
     * has already predicted past, and `TimeDilation` fighting a clock it cannot
     * slow that far. Constant mis-prediction, from a one-line assumption.
     *
     * `NetRig` cannot see it. It drives the host and each client one call
     * apiece, so both advance one frame per iteration whatever either rate is.
     * That is right for measuring a protocol and blind to how it is driven, so
     * the pacing is held here instead.
     */
    it('runs the session at the session rate, not the engine rate', () => {
        let steps = 0;
        let presented = 0;
        let presentedSeconds = 0;

        const system = new NetClientSystem({
            client: { step: () => (steps += 1) } as never,
            player: {
                updatePresentation: (dt: number) => {
                    presented += 1;
                    presentedSeconds += dt;
                },
            } as never,
        });

        const ENGINE_HZ = 60;
        const SECONDS = 10;
        const calls = ENGINE_HZ * SECONDS;

        // The engine's own step, short of 1/60 and deliberately so -- this is
        // the value `EntityManager` really uses.
        for (let call = 0; call < calls; call++) system.fixedUpdate(0.016666666666);

        expect(
            steps,
            `the session ran ${steps} steps in ${SECONDS} s; it should run ` +
                `${TICK_HZ * SECONDS} at ${TICK_HZ} Hz`
        ).toBe(TICK_HZ * SECONDS);

        /*
         **One presentation tick per simulation step, and this assertion used to
         say the opposite.** It read `toBe(calls)` -- once per engine frame --
         which is what the code did and what the design intended at the time, on
         the grounds that the view kick and the weapon rack are wall-clock things
         no rollback may undo. That reasoning is about *rollback* and is still
         satisfied: the tick runs after `client.step()` returns, outside any
         replay.

         What it got wrong is the rate. `updatePresentation` ends in
         `recordView`, which keeps the two-entry eye-pose history the camera is
         blended between -- copy `latest` down to `previous`, recompute `latest`
         from `ps`. The pair only means anything if exactly one simulation step
         separates them, which is what single-player gets for free from
         `update()`: advance clock, step, present. At 30 Hz on a 60 Hz fixed step
         the old placement recorded two poses per step, one spanning a real 33 ms
         of motion and one spanning nothing at all, so the camera blended half
         its frames over a doubled interval and half over a frozen one. That is a
         30 Hz stutter, and it read as the player jittering while walking rather
         than as a clock.
        */
        expect(
            presented,
            'the presentation clock and the simulation have to advance together'
        ).toBe(steps);

        /*
         And with the *session's* period, not the engine's. The clock inside
         `updatePresentation` is integer Q3 milliseconds; handing it 16.67 ms
         while stepping at 33.3 would run the view kick, the stair detector and
         the rack countdown at half speed -- which is the failure this half
         would otherwise trade for the one above.
        */
        expect(presentedSeconds, 'the presentation clock runs at the wrong rate').toBeCloseTo(
            SECONDS,
            1
        );
    });

    it('does not drift over an hour of frames', () => {
        /*
         The epsilon on the accumulator's comparison, held to account. Without
         it the engine's 3.4e-10 s shortfall loses a step every time the two
         rates would otherwise line up exactly -- which at these rates is every
         second step, so the client would run at nothing at all; with it, an
         hour of frames is an hour of frames.
        */
        let steps = 0;
        const system = new NetClientSystem({
            client: { step: () => (steps += 1) } as never,
            player: { updatePresentation: () => {} } as never,
        });

        const HOURS_OF_FRAMES = 60 * 60 * 60;
        for (let call = 0; call < HOURS_OF_FRAMES; call++) {
            system.fixedUpdate(0.016666666666);
        }

        expect(steps).toBe(TICK_HZ * 60 * 60);
    });

    it('throws arrears away rather than carrying them, after a stall', () => {
        /*
         `WsHost`'s rule, for `WsHost`'s reason: a tab that was backgrounded for
         a minute must not come back and try to simulate a minute. Carrying the
         arrears means running the cap again every frame and never catching up,
         while dropping them costs one jump.
        */
        let steps = 0;
        const system = new NetClientSystem({
            client: { step: () => (steps += 1) } as never,
            player: { updatePresentation: () => {} } as never,
        });

        system.fixedUpdate(60);

        expect(steps, 'a minute of arrears was simulated in one frame').toBeLessThan(8);
        expect(system.droppedSteps, 'the drop was not recorded').toBe(1);

        // And it is running normally again on the next frame.
        const before = steps;
        for (let call = 0; call < 60; call++) system.fixedUpdate(0.016666666666);
        expect(steps - before).toBe(TICK_HZ);
    });
});

describe('the fraction the camera blends its two eye poses with', () => {
    /**
     * A `NetClientSystem` with the engine's own clock underneath it.
     *
     * `entityManager` is `protected` on `System` and is assigned by `addSystem`;
     * a test that wants to drive the alpha has to put one there, and the two
     * members read are the two the alpha reads.
     */
    function withEngine(remainder: () => number): NetClientSystem {
        const system = new NetClientSystem({
            client: { step: () => {} } as never,
            player: { updatePresentation: () => {} } as never,
        });

        (system as unknown as { entityManager: unknown }).entityManager = {
            getFixedStepAlpha: remainder,
            fixedUpdateStepSize: 0.016666666666,
        };

        return system;
    }

    /*
     **This is the other half of "record one pose per session step", and without
     it that change made the judder worse rather than better.** `ViewSystem`
     blends the two recorded poses with `EntityManager.getFixedStepAlpha()`,
     which sweeps 0 to 1 over one *engine* step. Poses recorded once per
     *session* step span two of those at the shipping rates, so the engine's
     alpha runs the whole camera move in the first half of the interval and then
     runs it again in the second: the camera arrives early and jumps back, sixty
     times a second.
    */
    it('spans the session period, not the engine step', () => {
        let steps = 0;
        const system = new NetClientSystem({
            client: { step: () => (steps += 1) } as never,
            player: { updatePresentation: () => {} } as never,
        });

        (system as unknown as { entityManager: unknown }).entityManager = {
            getFixedStepAlpha: () => 0,
            fixedUpdateStepSize: 0.016666666666,
        };

        /*
         Asserted against **whether a step just ran** rather than against a call
         number, because the phase is not the caller's to know: the first fixed
         update of all runs no session step, since half a period of the engine's
         clock is not yet a whole one of the session's. Two engine steps to one
         session step at the shipping rates, so the sequence is
         half-way, on-the-pose, half-way, on-the-pose.
        */
        for (let call = 0; call < 20; call++) {
            const before = steps;
            system.fixedUpdate(0.016666666666);

            if (steps > before) {
                expect(
                    system.alpha,
                    `call ${call} ran a session step and did not land on its pose`
                ).toBeCloseTo(0, 3);
            } else {
                expect(
                    system.alpha,
                    `call ${call} ran no step and should be half way between two poses`
                ).toBeCloseTo(0.5, 3);
            }
        }

        expect(steps, 'two engine steps to one session step').toBe(10);
    });

    it('keeps moving between engine steps, so a fast display is not a slideshow', () => {
        /*
         The accumulator only changes on `fixedUpdate`, so an alpha built from it
         alone would be a staircase with one tread per engine step -- 60 of them
         a second, however many frames the display draws. The part-step the
         engine is currently inside is what fills them in.
        */
        let remainder = 0;
        const system = withEngine(() => remainder);

        system.fixedUpdate(0.016666666666);

        const start = system.alpha;
        remainder = 0.5;
        const middle = system.alpha;
        remainder = 0.99;
        const end = system.alpha;

        expect(middle, 'the alpha is frozen between engine steps').toBeGreaterThan(start);
        expect(end).toBeGreaterThan(middle);

        // Half an engine step is a quarter of a session period, at these rates.
        expect(middle - start).toBeCloseTo(0.25, 2);
    });

    it('never runs past the newest pose it has', () => {
        /*
         The two clocks are read at different moments -- the accumulator as of
         the last `fixedUpdate`, the engine's remainder as of now -- so their sum
         can exceed one period. There is nothing beyond the newest pose to
         extrapolate towards, and 1 is what `ViewSystem` already means by "show
         the newest".

         **Defensive at the shipping rates and not at every rate**, which is why
         it is here rather than assumed away: two engine steps to one session
         step puts the worst honest sum at a whisker under 1, and a slower engine
         step -- or a session rate raised to the engine's, which this port ran at
         until D-184 -- puts it over.
        */
        const system = withEngine(() => 0.999);

        // A whole session period unspent, which is what a 30 Hz engine step
        // against a 30 Hz session leaves behind.
        system.fixedUpdate(0.033333333332);
        system.fixedUpdate(0.033333333332);

        expect(system.alpha).toBeLessThanOrEqual(1);
    });
});
