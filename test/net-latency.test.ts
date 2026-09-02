/*
 * net-latency.test.ts -- the same match over a link that loses and reorders.
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
 * This file exists to answer one question with numbers rather than with a
 * paragraph: **does this netcode need an ordered, reliable transport, or is it
 * already a UDP-shaped thing being carried over TCP?**
 *
 * It matters because `WebSocketTransport`'s own docblock says it is "not the
 * right choice for game state -- WebSocket runs over TCP, which means
 * head-of-line blocking under packet loss", and v1 ships on it anyway (D-167).
 * Whether that is a reasonable compromise or a mistake is a measurement, and
 * `SimulatedTransport` is the engine's own instrument for taking it: loss
 * sampled per send, delivery scheduled at `now + latency + jitter`, and
 * **reordering as a consequence of jitter** rather than as a switch -- which is
 * exactly how a datagram path reorders.
 *
 * The rig drives the transport's clock from its own step counter, so an 80 ms
 * link is 80 ms in every run on every machine. A test that read `Date.now`
 * would be measuring the test runner.
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
    hits: number;
    total: number;
    hitRate: number;
    effects: number;
    hostDispatched: number;
    rewinds: number;
    rewindDepth: number;
    droppedPackets: number;
    inputsAgedOut: number;
    hostWalked: number;
    finite: boolean;
}

/** Thirty seconds of one client, four bots and a circle, over `link`. */
async function run(label: string, link: Link, seconds = 30): Promise<Outcome> {
    const rig = await NetRig.create({
        map: 'oa_dm1',
        bots: 4,
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

    const slot = rig.host.slots[client.net.slotIndex]!;
    let previous = [...slot.state.origin];
    let walked = 0;

    for (let n = 0; n < 60 * seconds; n++) {
        rig.step(1);
        const now = [...slot.state.origin];
        walked += Math.hypot(now[0]! - previous[0]!, now[1]! - previous[1]!);
        previous = now;
    }

    const net = client.net;
    const total = net.shortCircuitHits + net.shortCircuitMisses;

    return {
        label,
        predicted: net.predictedFrames,
        reconciles: net.reconcileCount,
        hits: net.shortCircuitHits,
        total,
        hitRate: total === 0 ? 0 : net.shortCircuitHits / total,
        effects: client.effects.length,
        hostDispatched: rig.hostEffects.length,
        rewinds,
        rewindDepth: rewinds === 0 ? 0 : depthTotal / rewinds,
        droppedPackets: rig.droppedPackets,
        inputsAgedOut: rig.host.session.server!.pending_dropped_count(),
        hostWalked: walked,
        finite: [...slot.state.origin].every(Number.isFinite),
    };
}

describe('the netcode over a link that behaves like UDP', () => {
    it('survives loss, jitter and the reordering they cause', async () => {
        const cases: Array<[string, Link]> = [
            ['loopback (0 ms, 0%)', 'loopback'],
            ['LAN    (10 ms, 1 ms jitter, 0.1%)', { latency_ms: 10, jitter_ms: 1, loss_pct: 0.1 }],
            ['broadband (40 ms, 8 ms, 1%)', { latency_ms: 40, jitter_ms: 8, loss_pct: 1 }],
            ['poor  (80 ms, 20 ms, 2%)', { latency_ms: 80, jitter_ms: 20, loss_pct: 2 }],
            ['bad   (150 ms, 40 ms, 5%)', { latency_ms: 150, jitter_ms: 40, loss_pct: 5 }],
        ];

        const outcomes: Outcome[] = [];
        for (const [label, link] of cases) outcomes.push(await run(label, link));

        // eslint-disable-next-line no-console
        console.log(
            '\n[net-latency] 30 s, 1 client + 4 bots, oa_dm1, seed 23\n' +
                outcomes
                    .map(
                        (o) =>
                            `  ${o.label.padEnd(34)} predicted ${String(o.predicted).padStart(4)}  ` +
                            `reconciles ${String(o.reconciles).padStart(4)}  ` +
                            `short-circuit ${(o.hitRate * 100).toFixed(1).padStart(5)}%  ` +
                            `host rewinds ${String(o.rewinds).padStart(4)} @ depth ` +
                            `${o.rewindDepth.toFixed(1).padStart(4)}  ` +
                            `events ${String(o.effects).padStart(4)}/${String(o.hostDispatched).padStart(4)}  ` +
                            `packets lost ${String(o.droppedPackets).padStart(4)}  ` +
                            `inputs aged out ${o.inputsAgedOut}`
                    )
                    .join('\n')
        );

        for (const o of outcomes) {
            /*
             The properties that have to hold on every link, and each one is a
             different way the netcode could have depended on TCP.

             `inputsAgedOut` is the sharp one: `ServerAuthoritativeServer` trims
             pending actions older than `frame_capacity`, so a non-zero count
             means a client's input arrived too late to be simulated at all --
             the player pressed a key and the world never saw it. Zero on every
             link is what says `FRAME_CAPACITY = 64` is big enough for the
             round trips this port will meet.
            */
            expect(o.inputsAgedOut, `${o.label}: an input aged out of the ring`).toBe(0);
            expect(o.finite, `${o.label}: the host's state went non-finite`).toBe(true);
            expect(o.predicted, `${o.label}: the client stopped predicting`).toBeGreaterThan(
                60 * 25
            );
            expect(o.hostWalked, `${o.label}: the host stopped seeing input`).toBeGreaterThan(1000);

            /*
             Every transient event the host dispatched reaches the client.
             These are the actions with no affected components -- muzzle
             flashes, impacts, explosions -- which the replicator re-sends
             until acked and the receiver applies exactly once. Losing one is
             not a correction that heals; it is a gunshot nobody heard.

             Compared against what the *host dispatched on this run* rather
             than against another run's total, and the difference matters:
             the host's world step consumes client input, so a link that
             delays input produces a different match. The first version of
             this compared the LAN run's event count against the loopback's
             and failed at 486 against 840 -- which was two different matches
             being compared, not an event being lost.
            */
            expect(o.hostDispatched, `${o.label}: the host raised nothing`).toBeGreaterThan(0);
        }

        /*
         Exact with no link at all, and asserted there. **Not exact on a
         simulated one**, and that is a defect rather than a tolerance --
         measured at 928 of 945 on a 150 ms / 5% link and at 593 of 596 on a
         40 ms / 1% one, so muzzle flashes, impacts and explosions simply never
         happen on the client. The cause is reordering rather than loss:
         `Replicator.unpack_from_peer` keeps an `#applied_through` watermark per
         peer and skips any frame group at or below it, so a packet carrying
         frames 95..105 that arrives *after* one carrying 100..110 has frames
         95..99 discarded wholesale -- and every event action in them with it.
         State survives that, because the next packet re-sends it; an event has
         only the one chance. GAP-043.

         Reported rather than asserted on the simulated links, and not because
         the number is unwelcome: the engine reads `performance.now()` on its
         fragment-retention and render paths, so a lossy run is **not
         reproducible** even with every seed pinned and the transport clock
         injected. The shortfall is real and appears on every run; which events
         and how many is not. Asserted where it is deterministic, measured
         where it is not, and never asserted at the broken value.
        */
        expect(
            outcomes[0]!.effects,
            'events went missing with no link at all'
        ).toBe(outcomes[0]!.hostDispatched);

        const shortfalls = outcomes
            .slice(1)
            .filter((o) => o.effects < o.hostDispatched)
            .map(
                (o) =>
                    `${o.label.trim()} ${o.effects}/${o.hostDispatched} ` +
                    `(${(100 * (1 - o.effects / o.hostDispatched)).toFixed(1)}% lost)`
            );

        // eslint-disable-next-line no-console
        console.log(
            shortfalls.length === 0
                ? '[net-latency] every event reached the client on every link this run'
                : `[net-latency] TARGET NOT MET -- events lost: ${shortfalls.join('; ')}; ` +
                  `target 0% on every link. See GAP-043.`
        );

        // The lossy links really did lose packets, or this measured nothing.
        expect(outcomes[3]!.droppedPackets).toBeGreaterThan(0);
        expect(outcomes[4]!.droppedPackets).toBeGreaterThan(outcomes[3]!.droppedPackets);
    });

    it('costs reconciliation rather than correctness as the link worsens', async () => {
        const clean = await run('clean', { latency_ms: 10, jitter_ms: 1, loss_pct: 0 }, 20);
        const rough = await run('rough', { latency_ms: 120, jitter_ms: 30, loss_pct: 4 }, 20);

        // eslint-disable-next-line no-console
        console.log(
            `[net-latency] 10 ms/0% -> short-circuit ${(clean.hitRate * 100).toFixed(1)}%, ` +
                `${clean.reconciles} reconciles; ` +
                `120 ms/4% -> ${(rough.hitRate * 100).toFixed(1)}%, ${rough.reconciles} reconciles ` +
                `(${(rough.reconciles / Math.max(1, clean.reconciles)).toFixed(1)}x)`
        );

        /*
         What survives, stated as a bound: the client keeps predicting every
         frame, the host keeps moving, and nothing ages out of the input ring.
        */
        expect(rough.reconciles).toBeGreaterThan(clean.reconciles);
        expect(rough.inputsAgedOut).toBe(0);
        expect(rough.predicted).toBeGreaterThan(clean.predicted * 0.95);
    });

    /**
     * The gate `NETWORK_PLAN.md` §5 step 7 sets, and the one this port does not
     * meet. Written as a measurement with a named target rather than as a
     * passing assertion on the wrong number, because a test that asserted 0.1%
     * would be pinning the defect (see D-173, GAP-043).
     */
    it('records how far the reconciliation loop is from its target', async () => {
        const clean = await run('40 ms, no jitter, no loss', {
            latency_ms: 40,
            jitter_ms: 0,
            loss_pct: 0,
        }, 15);

        // eslint-disable-next-line no-console
        console.log(
            `[net-latency] TARGET NOT MET -- 40 ms of clean, lossless, in-order delay: ` +
                `short-circuit ${(clean.hitRate * 100).toFixed(1)}% (target >90%), ` +
                `host rewinds ${clean.rewinds} of ${15 * 60} frames at mean depth ` +
                `${clean.rewindDepth.toFixed(1)} (§7 target <=6 and rare). ` +
                `See D-173 / GAP-043.`
        );

        /*
         What IS asserted is the shape of the defect, so that a fix moves this
         test rather than leaving it silently true: the rollback rate tracks
         *latency alone*, with neither loss nor jitter involved. If a change
         ever makes a clean 40 ms link stop rolling back on most frames, this
         fails and the gate above should be tightened to match.
        */
        expect(clean.droppedPackets, 'this case is supposed to be lossless').toBe(0);
        expect(
            clean.rewinds,
            'the host stopped rolling back on a clean link -- retighten the target'
        ).toBeGreaterThan(15 * 60 * 0.5);
    });
});
