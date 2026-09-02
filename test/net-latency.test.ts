/*
 * net-latency.test.ts -- the same match over a link that delays, loses and reorders.
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
 * Written to answer "does this netcode need an ordered, reliable transport, or
 * is it a UDP-shaped thing being carried over TCP?" (D-173). It answered a
 * different and more useful question first: on meep 3.14.3 the host rolled back
 * on 893 of 900 frames at **40 ms of clean, lossless, in-order delay**, and the
 * client's prediction agreed with the host on one AUTH_STATE in a thousand. No
 * transport touches that. GAP-043 was filed; 3.14.4 fixed it, and the first
 * suite below is the regression test.
 *
 * `SimulatedTransport` is the instrument: loss sampled per send, delivery at
 * `now + latency + jitter`, and **reordering as a consequence of jitter** rather
 * than as a switch. The rig drives its clock from its own step counter, so a
 * link is the same link on every machine.
 *
 * **How to count a delivered event, because getting it wrong is easy and I did.**
 * The host keeps dispatching for as long as it runs and the client is
 * permanently a link's-worth of frames behind, so comparing the two totals at an
 * arbitrary stop reports the in-flight window as loss -- it read as 8.6% of
 * muzzle flashes going missing on a *lossless* link, which is not true.
 * Draining without the host is worse: `flush_outbound` only sends when the host
 * ticks, so stopping it strands the tail permanently. The sound method is a
 * **cutoff frame** -- count what the host dispatched by frame C, keep both peers
 * running until the client has applied a frame at or past C, and only then
 * compare.
 */

import { describe, expect, it } from 'vitest';

import { NetRig, type Link, type RigClient } from './net/rig.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** The same tight circle the other net suites walk, for the same reason. */
function circleWalk(cmd: { angles: Int16Array; moves: Int8Array }, frame: number): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

interface Outcome {
    label: string;
    predicted: number;
    reconciles: number;
    hitRate: number;
    comparisons: number;
    rewinds: number;
    rewindDepth: number;
    /** Events the host dispatched up to the cutoff frame. */
    dispatched: number;
    /** Events the client had applied once it caught up past the cutoff. */
    received: number;
    caughtUp: boolean;
    droppedPackets: number;
    inputsAgedOut: number;
    hostWalked: number;
    finite: boolean;
}

async function run(
    label: string,
    link: Link,
    options: { seconds?: number; bots?: number } = {}
): Promise<Outcome> {
    const seconds = options.seconds ?? 20;

    const rig = await NetRig.create({
        map: 'oa_dm1',
        bots: options.bots ?? 4,
        clients: 1,
        seed: 23,
        link,
    });

    const client: RigClient = rig.clients[0]!;
    client.script = circleWalk;

    let rewinds = 0;
    let depthTotal = 0;
    rig.host.session.server!.onRewind.add((_top: number, _target: number, depth: number) => {
        rewinds += 1;
        depthTotal += depth;
    });

    /*
     The newest host frame this client has applied. `onFrameApplied` fires once
     per frame group the replicator applies, which is exactly "the client has
     caught up to here".
    */
    let appliedThrough = -1;
    (
        client.net.session.peer as unknown as {
            replicator: { onFrameApplied: { add(fn: (p: number, f: number) => void): void } };
        }
    ).replicator.onFrameApplied.add((_peer, frame) => {
        if (frame > appliedThrough) appliedThrough = frame;
    });

    const slot = rig.host.slots[client.net.slotIndex]!;
    let previous = [...slot.state.origin];
    let walked = 0;

    for (let n = 0; n < 60 * seconds; n++) {
        rig.step(1);
        const now = [...slot.state.origin];
        walked += Math.hypot(now[0]! - previous[0]!, now[1]! - previous[1]!);
        previous = now;
    }

    const cutoffFrame = rig.host.currentFrame;
    const dispatched = rig.hostEffects.length;

    // Both peers keep running until the client has passed the cutoff.
    for (let n = 0; n < 600 && appliedThrough < cutoffFrame; n++) rig.step(1);

    const net = client.net;
    const comparisons = net.shortCircuitHits + net.shortCircuitMisses;

    return {
        label,
        predicted: net.predictedFrames,
        reconciles: net.reconcileCount,
        hitRate: comparisons === 0 ? 0 : net.shortCircuitHits / comparisons,
        comparisons,
        rewinds,
        rewindDepth: rewinds === 0 ? 0 : depthTotal / rewinds,
        dispatched,
        received: Math.min(client.effects.length, dispatched),
        caughtUp: appliedThrough >= cutoffFrame,
        droppedPackets: rig.droppedPackets,
        inputsAgedOut: rig.host.session.server!.pending_dropped_count(),
        hostWalked: walked,
        finite: [...slot.state.origin].every(Number.isFinite),
    };
}

/* ------------------------------------------------------------------ *
 * GAP-043's first half: the rollback loop, fixed in 3.14.4
 * ------------------------------------------------------------------ */

describe('prediction coherence against pure latency', () => {
    it('does not degrade with delay on a clean link', async () => {
        /*
         Zero bots, and that is the point of this case rather than a
         simplification: a bot shooting the client inflicts damage the client
         cannot predict, so every hit is one legitimate short-circuit miss and
         the rate stops measuring *latency*. With nobody shooting, the only
         unpredictable thing left is Q3's one-second health bleed (D-170),
         which costs about one miss a second on every link equally.
        */
        const outcomes: Outcome[] = [];
        for (const [label, link] of [
            ['loopback', 'loopback'],
            ['10 ms clean', { latency_ms: 10, jitter_ms: 0, loss_pct: 0 }],
            ['40 ms clean', { latency_ms: 40, jitter_ms: 0, loss_pct: 0 }],
            ['80 ms clean', { latency_ms: 80, jitter_ms: 0, loss_pct: 0 }],
        ] as Array<[string, Link]>) {
            outcomes.push(await run(label, link, { bots: 0 }));
        }

        // eslint-disable-next-line no-console
        console.log(
            '\n[net-latency] prediction vs pure latency, 20 s, no bots\n' +
                outcomes
                    .map(
                        (o) =>
                            `  ${o.label.padEnd(12)} short-circuit ` +
                            `${(o.hitRate * 100).toFixed(1).padStart(5)}% of ${o.comparisons}  ` +
                            `reconciles ${String(o.reconciles).padStart(3)}  ` +
                            `host rewinds ${String(o.rewinds).padStart(4)}`
                    )
                    .join('\n')
        );

        for (const o of outcomes) {
            /*
             The GAP-043 regression test. On meep 3.14.3 the 40 ms row read
             0.1% with 893 rewinds in 900 frames, because `flush_outbound`
             re-sends every unacked frame and `ServerAuthoritativeServer.tick`
             chose its rollback window from those retransmissions *before*
             `#replay_frame`'s dedup discarded them. 3.14.4 runs the same
             comparison before choosing the window, and the rate stopped
             depending on latency at all.
            */
            expect(o.hitRate, `${o.label}: prediction coherence collapsed`).toBeGreaterThan(0.9);
            expect(
                o.rewinds,
                `${o.label}: the host is rolling back on a clean link`
            ).toBeLessThan(20);
            expect(o.comparisons, `${o.label}: AUTH_STATE stopped arriving`).toBeGreaterThan(
                20 * 60 * 0.9
            );
        }

        // And it is flat rather than merely passing: 80 ms is as good as none.
        expect(Math.abs(outcomes[3]!.hitRate - outcomes[0]!.hitRate)).toBeLessThan(0.05);
    });
});

/* ------------------------------------------------------------------ *
 * Everything else a real link does
 * ------------------------------------------------------------------ */

describe('the netcode over a link that behaves like UDP', () => {
    it('survives loss, jitter and the reordering they cause', async () => {
        const outcomes: Outcome[] = [];
        for (const [label, link] of [
            ['loopback (0 ms, 0%)', 'loopback'],
            ['LAN (10 ms, 1 ms, 0.1%)', { latency_ms: 10, jitter_ms: 1, loss_pct: 0.1 }],
            ['broadband (40 ms, 8 ms, 1%)', { latency_ms: 40, jitter_ms: 8, loss_pct: 1 }],
            ['poor (80 ms, 20 ms, 2%)', { latency_ms: 80, jitter_ms: 20, loss_pct: 2 }],
            ['bad (150 ms, 40 ms, 5%)', { latency_ms: 150, jitter_ms: 40, loss_pct: 5 }],
        ] as Array<[string, Link]>) {
            outcomes.push(await run(label, link));
        }

        // eslint-disable-next-line no-console
        console.log(
            '\n[net-latency] 20 s, 1 client + 4 bots, oa_dm1, seed 23\n' +
                outcomes
                    .map(
                        (o) =>
                            `  ${o.label.padEnd(28)} short-circuit ` +
                            `${(o.hitRate * 100).toFixed(1).padStart(5)}%  ` +
                            `rewinds ${String(o.rewinds).padStart(3)} @ ${o.rewindDepth.toFixed(1)}  ` +
                            `events ${String(o.received).padStart(3)}/${String(o.dispatched).padStart(3)}  ` +
                            `packets lost ${String(o.droppedPackets).padStart(4)}  ` +
                            `aged out ${o.inputsAgedOut}`
                    )
                    .join('\n')
        );

        for (const o of outcomes) {
            /*
             `inputsAgedOut` is the sharp one: the host trims pending actions
             older than `frame_capacity`, so anything but zero means a player
             pressed a key and the world never saw it.
            */
            expect(o.inputsAgedOut, `${o.label}: an input aged out of the ring`).toBe(0);
            expect(o.finite, `${o.label}: the host's state went non-finite`).toBe(true);
            expect(o.predicted, `${o.label}: the client stopped predicting`).toBeGreaterThan(
                20 * 60 * 0.9
            );
            expect(o.hostWalked, `${o.label}: the host stopped seeing input`).toBeGreaterThan(1000);
            expect(o.caughtUp, `${o.label}: the client never caught up to the cutoff`).toBe(true);
        }

        // The lossy links really did lose packets, or this measured nothing.
        expect(outcomes[3]!.droppedPackets).toBeGreaterThan(0);
        expect(outcomes[4]!.droppedPackets).toBeGreaterThan(outcomes[3]!.droppedPackets);
    });

    it('delivers every event a reordering link can reach it with', async () => {
        const cases: Array<[string, Link]> = [
            ['40 ms, 8 ms jitter, 1% loss', { latency_ms: 40, jitter_ms: 8, loss_pct: 1 }],
            ['80 ms, 20 ms jitter, 2% loss', { latency_ms: 80, jitter_ms: 20, loss_pct: 2 }],
        ];
        const outcomes: Outcome[] = [];
        for (const [label, link] of cases) outcomes.push(await run(label, link));

        const worst = await run('150 ms, 40 ms jitter, 5% loss', {
            latency_ms: 150,
            jitter_ms: 40,
            loss_pct: 5,
        });

        // eslint-disable-next-line no-console
        console.log(
            '[net-latency] events delivered: ' +
                [...outcomes, worst]
                    .map(
                        (o) =>
                            `${o.label} ${o.received}/${o.dispatched} ` +
                            `(${o.droppedPackets} packets lost)`
                    )
                    .join('; ')
        );

        /*
         GAP-043's second half, fixed in meep 3.14.5 (D-177).
         Before: 516/516, then 403/474 and 305/516 -- 15% and 41% of muzzle
         flashes, impacts and explosions never happening on the client. The
         cause was not the watermark on its own: the action stream sent a tick's
         whole owed range as ONE MTU-bounded packet and re-sent it until acked,
         so above roughly 118 bytes of actions per frame at 150 ms the owed
         range outgrew a packet, pinned to the ring floor, and every frame then
         rode exactly one packet. One reordered pair lost it for good, because
         its channel-level ack still credited it. 3.14.5 slices a tick's owed
         range across up to `max_packets_per_tick` packets (default 8), which
         raises the ceiling roughly eightfold and puts a frame on eight
         consecutive ticks' packets.
        */
        for (const o of outcomes) {
            expect(o.received, `${o.label}: events went missing`).toBe(o.dispatched);
        }

        /*
         The worst link is a bound rather than an equality, and the target is
         still zero. This port's load is 529 bytes of actions per frame with
         four bots (see the byte census below), against 3.14.5's ceiling of
         about 940 at 150 ms -- so it sits under the ceiling on average and a
         burst of explosions can still cross it. Measured at 506 of 516. The
         bound is here to catch a regression to 41%, not to bless the residual.
        */
        const lost = 1 - worst.received / worst.dispatched;
        expect(lost, 'the worst link regressed towards the 41% of 3.14.4').toBeLessThan(0.05);
    });

    it('measures the bytes of actions a frame costs, which is what the ceiling is on', async () => {
        /*
         The one number meep asked for, because it is what the whole mechanism
         turns on: the action stream pins whenever a round trip's frames do not
         fit one packet. On 3.14.4 that threshold was about 118 bytes per frame
         at 150 ms and 236 at 80 ms; 3.14.5 raises it roughly eightfold, to
         about 940 at 150 ms.

         Measured on a loopback deliberately: the ack returns inside the same
         step, so the owed range is one frame and an ACTION_STREAM packet
         carries exactly that frame's actions.
        */
        const census: Array<{ bots: number; mean: number; p99: number; max: number }> = [];

        for (const bots of [0, 4, 8]) {
            const rig = await NetRig.create({ map: 'oa_dm1', bots, clients: 1, seed: 23 });
            const client = rig.clients[0]!;
            client.script = circleWalk;

            const hostSide = rig.rawHostTransports[0] as {
                send(bytes: Uint8Array, length: number): number;
            };
            const sizes: number[] = [];
            const original = hostSide.send.bind(hostSide);
            hostSide.send = (bytes: Uint8Array, length: number): number => {
                // 9-byte Channel header, then the packet type; 0 is ACTION_STREAM.
                if (length > 10 && bytes[9] === 0) sizes.push(length - 10);
                return original(bytes, length);
            };

            rig.step(60 * 10);
            sizes.sort((a, b) => a - b);

            census.push({
                bots,
                mean: sizes.reduce((x, y) => x + y, 0) / Math.max(1, sizes.length),
                p99: sizes[Math.floor(sizes.length * 0.99)] ?? 0,
                max: sizes[sizes.length - 1] ?? 0,
            });
        }

        // eslint-disable-next-line no-console
        console.log(
            '[net-latency] action bytes per frame per client: ' +
                census
                    .map(
                        (c) =>
                            `${c.bots} bots mean ${c.mean.toFixed(0)} p99 ${c.p99} max ${c.max}`
                    )
                    .join('; ') +
                ' — 3.14.5 ceiling ≈940 B at 150 ms, ≈1880 B at 80 ms'
        );

        /*
         Asserted against the ceiling rather than against a fixed size, so this
         fails on the day the port's per-frame cost grows enough to pin the
         stream again — which is the failure that used to present as missing
         gunshots rather than as a bandwidth number.
        */
        const CEILING_AT_150MS = 940;
        for (const c of census) {
            expect(
                c.mean,
                `${c.bots} bots: mean action bytes per frame is at the 150 ms ceiling`
            ).toBeLessThan(CEILING_AT_150MS);
        }
    });
});
