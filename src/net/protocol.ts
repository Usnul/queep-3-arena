/*
 * protocol.ts -- the constants host and client both have to agree on.
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
 * Everything under `src/net/` is shared by the Node host and the browser
 * client, so nothing here may import meep's graphics, audio or DOM modules --
 * this file has no imports at all, and the ones beside it import only from
 * `engine/network` and `core/`.
 *
 * Two clocks meet in this file and they are not the same clock.
 *
 * **The engine's step** is `EntityManager.fixedUpdateStepSize`, whose default
 * is `0.016666666666` -- sixty-one-thousandths short of 1/60, and short in the
 * direction that matters (see {@link SESSION_TICK_SECONDS}). It is what the
 * solver integrates with, and D-110 keeps it at the engine's default.
 *
 * **The frame clock** is Q3's integer millisecond, which `MoverSystem` and
 * `PlayerController` have always carried as a whole-millisecond accumulator so
 * that `level.time` stays an integer and the sequence sums exactly: 16, 17, 17,
 * 16, 17, 17 ... {@link frameMsec} is that same sequence derived from the frame
 * *number* instead of from an accumulator, which is the property a networked
 * game needs and an accumulator cannot give: two machines that have run a
 * different number of frames must still compute the same millisecond for frame
 * N. An accumulator answers "how much time has passed here"; this answers "what
 * is frame N worth", and only the second is a shared fact.
 */

/**
 * Bumped whenever the wire format changes in any way a peer could
 * misinterpret: a component's field list, the `replicate()` order, an action's
 * payload, or the hello. A mismatch is refused at the hello, before a
 * `NetworkSession` exists on either side -- there is no version negotiation and
 * there is not going to be one.
 */
export const PROTOCOL_VERSION = 1;

/** Q3's `MAX_CLIENTS`. A slot is an entity for the whole match; see §3.1. */
export const MAX_CLIENTS = 16;

/**
 * The missile pool. Nothing is spawned after the first client connects
 * (`ReplaceComponentAction.apply` returns silently for an unknown network id,
 * and `STATE_BURST` updates existing entities only), so every missile that will
 * ever fly exists before the match starts and is recycled.
 *
 * 64 against Q3's own `MAX_GENTITIES` of 1024 is a judgement rather than a
 * port: a plasma gun at 10 rounds a second with a 10-second fuse is the worst
 * case in the game and it tops out around 100 in flight, but only if nothing it
 * fires ever hits anything.
 */
export const MAX_MISSILES = 64;

/** The session's tick rate. Ties to the engine's fixed step; see below. */
export const TICK_HZ = 30;

/**
 * What to hand `session.tick()` for exactly one session step.
 *
 * `NetworkSession.tick` keeps its own accumulator and steps while
 * `accumulator >= tick_period_ms`, so it is driven in *its* period rather than
 * in the engine's. The two are not interchangeable and the difference is not
 * academic: `EntityManager.fixedUpdateStepSize` is `0.016666666666`, and
 *
 *     0.016666666666 * 1000 = 16.666666666 < 1000 / 60 = 16.666666666666666
 *
 * so a session driven with the engine's step never reaches its period on the
 * first call, skips that step, and then runs one step per call for ever --
 * permanently one frame behind where the caller thinks it is. Handing it its
 * own period makes the arithmetic exact (`0 + p >= p`, remainder exactly 0) and
 * one call is one frame from the first call onward.
 *
 * `test/net-clock.test.ts` asserts both halves rather than trusting this
 * paragraph.
 */
export const SESSION_TICK_SECONDS = 1 / TICK_HZ;

/**
 * Depth of the action-log ring, in frames, on both roles.
 *
 * The engine's default is 32 (0.53 s at 60 Hz) and its own docblock says to
 * raise it for high-RTT links: the same number bounds the rollback depth, the
 * back-fill range for a freshly-connected peer, and how long an unacked frame
 * stays resendable. 64 is 1.07 s, which covers any link this port will be
 * played over and costs one buffer per frame per orchestrator.
 */
export const FRAME_CAPACITY = 64;

/**
 * Host-side input buffer, in frames (the engine's default). `server.tick(wall)`
 * simulates `wall - SIMULATION_DELAY_TICKS`, so a client's input for frame F
 * has four frames to arrive before the host needs it and rollback stays rare.
 */
export const SIMULATION_DELAY_TICKS = 4;

/** The host's peer id. `NetworkSession` defaults a host to this; named anyway. */
export const HOST_PEER_ID = 0;

/**
 * Peer ids run `0..254`; `0xFF` is the engine's `SENDER_LOCAL`. The host is 0,
 * so a client is somewhere in `1..254` and the host hands one out per socket.
 */
export const MIN_CLIENT_PEER_ID = 1;
export const MAX_CLIENT_PEER_ID = 254;

/**
 * The millisecond frame `n` is worth, as Q3 counts them.
 *
 * `floor((n + 1) * 1000 / TICK_HZ) - floor(n * 1000 / TICK_HZ)`: the exact
 * period boundary crossed twice, so the difference between consecutive floors
 * is one of the two integers either side of it and `TICK_HZ` of them sum to
 * exactly 1000 with no accumulated error, for ever, on any machine that can do
 * integer arithmetic. At 60 Hz that is 16 and 17; at 30 it is 33 and 34.
 *
 * Written in terms of `TICK_HZ` rather than with the ratio folded in, which it
 * was until the rate moved: `50 / 3` is `1000 / 60` pre-divided, and a constant
 * that silently means "and the tick rate is 60" is exactly the sort of thing
 * that survives a rate change and produces a clock two per cent wrong. The
 * multiplication is exact for any frame number this port will reach -- one
 * frame is 1000 by the time it is divided, and doubles are exact to 2^53.
 *
 * Derived from the frame number and not from a running total, so a host at
 * frame 6000 and a client that has just fast-forwarded to 6000 agree about
 * frame 6000 without having agreed about anything before it.
 *
 * @param frame a non-negative sim frame number
 * @returns 16 or 17
 */
export function frameMsec(frame: number): number {
    return (
        Math.floor(((frame + 1) * 1000) / TICK_HZ) - Math.floor((frame * 1000) / TICK_HZ)
    );
}

/**
 * Total milliseconds elapsed at the *start* of `frame`, i.e. the sum of
 * `frameMsec(0 .. frame - 1)`. Closed form, so a late joiner does not walk six
 * thousand frames to find out what time it is.
 */
export function frameTimeMs(frame: number): number {
    return Math.floor((frame * 1000) / TICK_HZ);
}
