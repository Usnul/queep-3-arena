/*
 * net-delivery.test.ts -- did every frame the host sent actually run?
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
 * GAP-043's residual, and GAP-047, which is the instrument that was supposed to
 * measure it.
 *
 * The question is one sentence: **a frame arrived and was dropped below the
 * applied watermark -- had it already run, or did it never run at all?** From
 * outside they look identical, because the action stream re-sends every
 * unconfirmed frame every tick and most frames carry nothing anybody would
 * miss. meep 3.14.6 added `delivery_stats(peer)` to answer it, and its
 * `skipped_unapplied` reports 10, 29 and 214 frames on links this port cares
 * about while its docblock says the number should stay at zero.
 *
 * This file answers the question without asking that counter, and then says
 * which part of the counter is trustworthy. The answer has two halves and both
 * matter:
 *
 *   1. **There is a real residual, it is small, and it is mostly a join.** On a
 *      lossless 150 ms link with 40 ms of jitter, ten frames out of ~540 were
 *      put on the wire and never applied -- **nine of the ten inside the first
 *      six seconds after the join**, one after. With 5% loss on top: thirteen,
 *      ten of them inside the six. At 40 ms and 80 ms: none at all, anywhere.
 *      So GAP-043's residual does survive on the default
 *      `max_packets_per_tick`, at 1.9% of frames on the worst link, and it
 *      clusters where the rewind burst and the coherence dip also live -- the
 *      second or two while `TimeDilation` walks to its buffer depth.
 *
 *   2. **`skipped_unapplied` is not that number.** It is 214 where the honest
 *      count is 10, and 10 where the honest count is 0. Filtered to the slices
 *      that can actually lose a frame -- heads -- it lands within one of the
 *      honest count at every link measured. The rest is the receiver counting
 *      its own held slices, and it keeps climbing for as long as the peers run.
 *
 * **How the honest count is taken**, since the whole difficulty of this bug is
 * that nothing reports it. `onFrameApplied` fires once per frame group applied,
 * so the set of frames the client ever ran is exactly knowable. Every inbound
 * packet declares the frame range it covers in its slice header, so the union
 * of those ranges is what the host actually put on the wire for this client. A
 * frame in the union and not in the applied set was delivered and dropped.
 * `unpack_from_peer` is wrapped to capture the headers -- the one piece of
 * instrumentation here that reaches past the public surface, and it reads
 * rather than changes anything.
 *
 * **Two traps this measurement has to dodge**, both of which produced wrong
 * answers on the way here:
 *
 *   - **The slice header object is reused** across receives, so recording the
 *     reference gives every packet the last packet's range. Copied on capture.
 *     Uncopied, this read as "all 150 counting packets were non-heads" at one
 *     link and "all 9 were heads" at another, which is the same object being
 *     asked twice.
 *   - **The join leaves a legitimate hole.** A joining client's watermark
 *     starts at 0 and INITIAL_SYNC lands it near the host's frame, so frames
 *     8..47 are never sent to it and never applied. Those are not losses. The
 *     census starts three seconds past the first applied frame.
 */

import { describe, expect, it } from 'vitest';

import { NetRig, type Link } from './net/rig.ts';
import { FORWARDMOVE } from '../src/q3/pmove/types.ts';
import { HOST_PEER_ID, TICK_HZ } from '../src/net/protocol.ts';
import * as C from '../src/q3/pmove/constants.ts';

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** The slice header `NetworkPeer` hands the replicator with each packet. */
interface Slice {
    frame_start: number;
    frame_end: number;
    head: boolean;
}

interface Census {
    label: string;
    /** The engine's own counter, for the peer that is the host. */
    skippedUnapplied: number;
    skippedDuplicate: number;
    /** Its increments, split by whether the packet could have lost a frame. */
    headSkips: number;
    nonHeadSkips: number;
    /** Frames the host put on the wire and the client never applied. */
    lost: number;
    /** Which ones, as frames since the first the client applied. */
    lostFrames: number[];
    /** Of those, the ones past the join's convergence. Target is zero. */
    lostAfterSettling: number;
    /** Frames the census covers. */
    measuredFrames: number;
    /** Frames the census covers past the settle window. */
    settledFrames: number;
    eventsDispatched: number;
    eventsReceived: number;
}

async function census(label: string, link: Link, seconds = 20): Promise<Census> {
    const rig = await NetRig.create({
        map: 'oa_dm1',
        bots: 4,
        clients: 1,
        seed: 23,
        warmup: 40,
        link,
    });

    const client = rig.clients[0]!;
    /*
     The client generates the events it counts. Four bots on `oa_dm1` may or
     may not meet, and a sample decided by pathfinding cannot measure a rate --
     which this suite has now learnt three times (D-187). The machinegun's
     100 ms cooldown is about ten effects a second on every link equally.
    */
    client.script = (cmd, frame) => {
        cmd.angles[1] = angleToShort(frame * 4);
        cmd.moves[FORWARDMOVE] = 127;
        cmd.buttons |= C.BUTTON_ATTACK;
    };

    const replicator = (
        client.net.session.peer as unknown as {
            replicator: {
                unpack_from_peer(p: number, b: unknown, e: number, s?: Slice | null): void;
                onFrameApplied: { add(fn: (peer: number, frame: number) => void): void };
                delivery_stats(p: number): {
                    skipped_unapplied: number;
                    skipped_duplicate: number;
                };
            };
        }
    ).replicator;

    /** Every frame this client applied from the host, in the order it applied them. */
    const applied: number[] = [];
    replicator.onFrameApplied.add((peer, frame) => {
        if (peer === HOST_PEER_ID) applied.push(frame);
    });

    /** The frames every inbound packet declared, and what the counter did on it. */
    const delivered = new Set<number>();
    let headSkips = 0;
    let nonHeadSkips = 0;

    const original = replicator.unpack_from_peer.bind(replicator);
    replicator.unpack_from_peer = (p: number, b: unknown, e: number, s?: Slice | null): void => {
        // Copied now: the header object is reused across receives.
        const slice =
            s === undefined || s === null
                ? null
                : { frame_start: s.frame_start, frame_end: s.frame_end, head: s.head };
        const before = replicator.delivery_stats(p).skipped_unapplied;

        original(p, b, e, s ?? null);

        if (p !== HOST_PEER_ID) return;
        const moved = replicator.delivery_stats(p).skipped_unapplied - before;
        if (slice !== null) {
            for (let f = slice.frame_start; f <= slice.frame_end; f++) delivered.add(f);
            if (slice.head) headSkips += moved;
            else nonHeadSkips += moved;
        }
    };

    for (let n = 0; n < TICK_HZ * seconds; n++) rig.step(1);

    /*
     The cutoff-frame method, because the client is permanently a link's-worth
     of frames behind: count what the host dispatched by frame C, keep both
     peers running until the client has applied a frame at or past C, and only
     then compare. Frames are applied in order, so the moment the watermark
     reaches C the client has run every frame at or below it and none above.
    */
    const cutoff = rig.host.currentFrame;
    const eventsDispatched = rig.hostEffects.filter((e) => e.frame <= cutoff).length;
    let eventsReceived = -1;
    for (let n = 0; n < 600; n++) {
        rig.step(1);
        if (eventsReceived < 0 && applied[applied.length - 1]! >= cutoff) {
            eventsReceived = client.effects.length;
        }
    }

    const appliedSet = new Set(applied);
    const first = applied[0]!;
    /* Three seconds past the first applied frame: past the join's own hole. */
    const from = first + TICK_HZ * 3;

    const lostFrames: number[] = [];
    for (let f = from; f <= cutoff; f++) {
        if (delivered.has(f) && !appliedSet.has(f)) lostFrames.push(f - first);
    }

    /*
     Six seconds, which is the settle window `net-latency.test.ts` uses for the
     rewind burst plus a margin. The join is a transient in more than one
     measurement and this is the one that says whether it is a transient here.
    */
    const settleFrom = TICK_HZ * 6;
    const stats = replicator.delivery_stats(HOST_PEER_ID);

    return {
        label,
        skippedUnapplied: stats.skipped_unapplied,
        skippedDuplicate: stats.skipped_duplicate,
        headSkips,
        nonHeadSkips,
        lost: lostFrames.length,
        lostFrames,
        lostAfterSettling: lostFrames.filter((f) => f >= settleFrom).length,
        measuredFrames: cutoff - from + 1,
        settledFrames: Math.max(0, cutoff - first - settleFrom + 1),
        eventsDispatched,
        eventsReceived: eventsReceived < 0 ? 0 : eventsReceived,
    };
}

const LINKS: Array<[string, Link]> = [
    ['150 ms clean', { latency_ms: 150, jitter_ms: 0, loss_pct: 0 }],
    ['40 ms, 8 ms jitter, 1% loss', { latency_ms: 40, jitter_ms: 8, loss_pct: 1 }],
    ['80 ms, 20 ms jitter, 2% loss', { latency_ms: 80, jitter_ms: 20, loss_pct: 2 }],
    ['150 ms, 40 ms jitter, lossless', { latency_ms: 150, jitter_ms: 40, loss_pct: 0 }],
    ['150 ms, 40 ms jitter, 5% loss', { latency_ms: 150, jitter_ms: 40, loss_pct: 5 }],
];

describe('every frame the host puts on the wire', () => {
    it('runs on the client, or is counted where the counter can be believed', async () => {
        const rows: Census[] = [];
        for (const [label, link] of LINKS) rows.push(await census(label, link));

        // eslint-disable-next-line no-console
        console.log(
            '\n[net-delivery] 20 s, 1 client firing + 4 bots, oa_dm1, default max_packets_per_tick\n' +
                '  link                             lost  settled  events        counter  = heads + non-heads\n' +
                rows
                    .map(
                        (r) =>
                            `  ${r.label.padEnd(32)}` +
                            `${String(r.lost).padStart(4)}  ` +
                            `${String(r.lostAfterSettling).padStart(7)}  ` +
                            `${String(r.eventsReceived).padStart(4)}/${String(r.eventsDispatched).padEnd(4)}  ` +
                            `${String(r.skippedUnapplied).padStart(6)}  = ` +
                            `${String(r.headSkips).padStart(3)} + ${String(r.nonHeadSkips).padStart(4)}` +
                            (r.lost === 0 ? '' : `   at +${r.lostFrames.join(',+')}`)
                    )
                    .join('\n')
        );

        const clean = rows[0]!;
        const at40 = rows[1]!;
        const at80 = rows[2]!;
        const lossless150 = rows[3]!;

        /*
         **The property, at the links this port is meant to be played over.**
         Nothing the host sends is dropped unapplied at 40 or 80 ms -- not
         "almost nothing", none -- and the event counts agree, which is the
         independent check: a frame that never ran is a frame whose actions
         never ran.
        */
        for (const r of [clean, at40, at80]) {
            expect(
                r.lost,
                `${r.label}: frames were delivered and never applied: ${r.lostFrames.join(',')}`
            ).toBe(0);
        }

        /*
         **And the residual, reported against a target of zero rather than
         asserted at what this build produces.** Ten frames on a *lossless*
         150 ms link with 40 ms of jitter -- 1.9% of the window -- and thirteen
         with 5% loss on top. Lossless is the interesting one: no packet was
         dropped by the link, so those ten were delivered and discarded by the
         receiver, which is GAP-043's residual surviving on the default
         configuration. It is bounded here at 5% to catch a regression towards
         the 41% of 3.14.4, not to bless 1.9%.
        */
        for (const r of [lossless150, rows[4]!]) {
            expect(
                r.lost / r.measuredFrames,
                `${r.label}: unapplied frames got worse; the target is zero`
            ).toBeLessThan(0.05);

            /*
             And the sharper half of the same finding: nine of the ten are
             inside the first six seconds after the join, which is the same
             window the rewind burst and the coherence dip occupy. Bounded
             separately and much tighter, because a residual that is a join
             transient and a residual that is a steady leak are different
             bugs, and only the second one gets worse the longer you play.
            */
            expect(
                r.lostAfterSettling / Math.max(1, r.settledFrames),
                `${r.label}: frames are being lost past the join, not only during it; ` +
                    `the target is zero`
            ).toBeLessThan(0.02);
        }

        /*
         **Which part of `delivery_stats` can be believed, and why the number
         above is computed rather than read.**

         Only a *head* slice can lose a frame for good: `#apply_held_before`
         runs first and raises the watermark, and nothing before a head is ever
         re-sent, so a frame a head finds below the watermark is gone. A
         non-head that starts past the watermark takes `#hold_slice`, which
         validates the bytes by calling `#apply_groups` with `min_frame =
         Infinity` -- so **every frame in a slice the receiver is about to keep
         takes the skip branch on the way in**, none of them has been applied
         yet, and all of them are booked `skipped_unapplied` before being
         applied when the gap fills.

         That is the whole of the discrepancy, and the split measures it: the
         head component tracks the honest count to within one at every link,
         and the non-head component is the artefact. It is asserted here as the
         property we want -- *the counter agrees with reality* -- made to pass
         by the filtering that is this port's workaround, with the unfiltered
         total printed above so the shortfall against its documented target of
         zero stays visible. GAP-047.
        */
        for (const r of rows) {
            expect(
                Math.abs(r.headSkips - r.lost),
                `${r.label}: the head-slice count stopped tracking the frames actually lost ` +
                    `(${r.headSkips} counted, ${r.lost} lost)`
            ).toBeLessThanOrEqual(3);
        }

        /*
         And a link with no reordering is the control: no slice can arrive
         early, so nothing is held, so there is nothing for the validation walk
         to miscount -- and the counter reads zero, at 150 ms of delay, where
         the same latency with jitter reads 214. The counter is not noisy; it
         is specifically confused by holds.
        */
        expect(
            clean.skippedUnapplied,
            'a link with no reordering should give the counter nothing to count'
        ).toBe(0);
        expect(clean.nonHeadSkips).toBe(0);

        /*
         The event shortfall and the frame census are the same phenomenon seen
         from two ends, so they have to move together or one of them is wrong.
         This port's load is about 1.3 effects per frame, so ten lost frames is
         of the order of a dozen lost events; measured 18 against 10 and 24
         against 13. The bound is loose on purpose -- an effect dispatched in
         the last frames before the cutoff can still be in flight -- and its
         job is to catch the two measurements disagreeing about whether
         anything was lost at all.
        */
        for (const r of rows) {
            const shortfall = Math.max(0, r.eventsDispatched - r.eventsReceived);
            if (r.lost === 0) {
                expect(
                    shortfall,
                    `${r.label}: events went missing on a link that lost no frames`
                ).toBeLessThanOrEqual(3);
            } else {
                expect(
                    shortfall,
                    `${r.label}: the event shortfall and the frame census disagree`
                ).toBeLessThanOrEqual(r.lost * 4);
            }
        }
    }, 180000);

    it('is re-sent enough that the counter climbs for as long as the peers run', async () => {
        /*
         One more reason the unfiltered total is not a loss rate: it is not
         even a rate. `skipped_duplicate` is the action stream's redundancy
         being correctly ignored and is expected to be large -- and because the
         hold path books held frames as *unapplied*, the same redundancy pushes
         `skipped_unapplied` up too, for as long as the two peers keep talking.
         Measured on the same link at two run lengths: the honest loss count
         stays where it is and the counter does not.
        */
        const link = { latency_ms: 150, jitter_ms: 40, loss_pct: 0 };
        const short = await census('150 ms, 40 ms jitter, lossless (10 s)', link, 10);
        const long = await census('150 ms, 40 ms jitter, lossless (20 s)', link, 20);

        // eslint-disable-next-line no-console
        console.log(
            `[net-delivery] run length vs the two numbers: 10 s -> lost ${short.lost}, ` +
                `counter ${short.skippedUnapplied}; 20 s -> lost ${long.lost}, ` +
                `counter ${long.skippedUnapplied}`
        );

        /*
         And the two numbers behave differently, which is the point: **the
         honest count is identical at both run lengths** -- ten frames, all of
         them in the first ten seconds -- while the counter goes from 185 to
         214. A loss count that does not grow with the run says the residual is
         a transient; a counter that does grow with the run is counting traffic,
         not loss.
        */
        expect(
            long.lost,
            'the residual started growing with the run, which would make it a leak'
        ).toBeLessThanOrEqual(short.lost + 3);

        for (const r of [short, long]) {
            expect(
                r.lost / r.measuredFrames,
                `${r.label}: unapplied frames got worse; the target is zero`
            ).toBeLessThan(0.05);
        }
    }, 180000);
});
