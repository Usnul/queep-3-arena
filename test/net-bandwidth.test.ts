/*
 * net-bandwidth.test.ts -- what one client actually sends and receives.
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
 * REPORT section 5 has a bandwidth table with both directions in it, and it
 * cannot answer "what does a sixteen-player match cost a client": it was taken
 * at **ten**. This file answers that at the population the protocol is sized
 * for, and it counts every byte that crosses the transport rather than the
 * action payloads inside them -- so channel headers, fragment headers,
 * AUTH_STATE and the time-dilation feedback are all in the number, which is
 * what a network interface would see.
 *
 * **Latency here is one way.** `SimulatedTransport` delays each direction by
 * `latency_ms`, so the 80 ms row below is a 160 ms round trip. REPORT section
 * 5's rows are labelled in RTT; do not read the two tables against each other
 * without halving one of them.
 *
 * **The shape of the answer is two multipliers on one payload**, and neither
 * multiplier is obvious from the per-frame byte census in
 * `net-latency.test.ts`:
 *
 *   - **Fragmentation.** One tick of sixteen players' state is about 2 KB
 *     against a channel payload of 1,191 bytes (MTU 1,200 less a 9-byte
 *     header), so every tick is fragmented. Measured: **93% of the downstream
 *     is FRAGMENT packets** on a loopback, where the action stream has no
 *     redundancy to blame. At ten players it is still 90%, so the crossing is
 *     somewhere below the population this port already supports.
 *   - **The re-send window.** `flush_outbound` packs `[last_acked + 1,
 *     current]` every tick, so each frame is on the wire once per frame of
 *     round trip. On a loopback the ack returns inside the step and the
 *     multiplier is one; at 80 ms one-way it is about five, and the downstream
 *     goes up by about that much. This is the dominant term on any real link
 *     and it is invisible on a loopback.
 *
 * Which is why quantisation is the lever and culling was not (D-195): the
 * payload is multiplied twice before it reaches the wire, so taking bytes out
 * of `NetPlayerState` is worth several times its face value, and getting a tick
 * under the MTU removes the first multiplier outright.
 *
 * **Bots count as players here.** A bot's state is published exactly as a
 * human's is, so eight clients and eight bots is a sixteen-player match as far
 * as the downstream is concerned; what a bot does not produce is upstream, and
 * upstream is per client and does not depend on how many others there are.
 */

import { describe, expect, it } from 'vitest';

import { NetRig, type Link } from './net/rig.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import { MAX_CLIENTS, TICK_HZ } from '../src/net/protocol.ts';
import * as C from '../src/q3/pmove/constants.ts';

/** `Channel`'s header, before the packet type byte. */
const CHANNEL_HEADER_BYTES = 9;

/** meep's target MTU, and the channel payload left inside it. */
const MTU_BYTES = 1200;
const MAX_CHANNEL_PAYLOAD_BYTES = MTU_BYTES - CHANNEL_HEADER_BYTES;

const TYPE_NAMES: Record<number, string> = {
    0: 'ACTION_STREAM',
    3: 'AUTH_STATE',
    4: 'FRAGMENT',
    7: 'TIME_DILATION',
    8: 'INITIAL_SYNC',
};

function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

interface Direction {
    bytes: number;
    packets: number;
    byType: Map<number, number>;
}

interface Census {
    label: string;
    players: number;
    clients: number;
    seconds: number;
    down: Direction;
    up: Direction;
}

function empty(): Direction {
    return { bytes: 0, packets: 0, byType: new Map() };
}

/** KB/s per client. */
function perClient(d: Direction, clients: number, seconds: number): number {
    return d.bytes / clients / seconds / 1024;
}

function share(d: Direction, type: number): number {
    return d.bytes === 0 ? 0 : (d.byType.get(type) ?? 0) / d.bytes;
}

async function census(
    label: string,
    clients: number,
    bots: number,
    link: Link,
    seconds = 20
): Promise<Census> {
    const rig = await NetRig.create({ map: 'oa_dm1', bots, clients, seed: 23, warmup: 40, link });

    /*
     Everybody busy, and each on their own phase: running, jumping and holding
     the trigger. A quiet match measures the floor and this is meant to measure
     what a fight costs -- and phases keep the sixteen from moving as one body,
     which would have them share a cluster and a fight and understate the state
     churn.
    */
    rig.clients.forEach((client, i) => {
        client.script = (cmd, frame) => {
            cmd.angles[1] = angleToShort(frame * 4 + i * 23);
            cmd.moves[FORWARDMOVE] = 127;
            cmd.moves[UPMOVE] = (frame + i * 7) % 30 === 0 ? 127 : 0;
            cmd.buttons |= C.BUTTON_ATTACK;
        };
    });

    const down = empty();
    const up = empty();
    let counting = false;

    const hook = (list: readonly object[], into: Direction): void => {
        for (const raw of list) {
            const side = raw as { send(b: Uint8Array, length: number): number };
            const original = side.send.bind(side);
            side.send = (b: Uint8Array, length: number): number => {
                if (counting) {
                    into.bytes += length;
                    into.packets += 1;
                    const type = length > CHANNEL_HEADER_BYTES ? b[CHANNEL_HEADER_BYTES]! : -1;
                    into.byType.set(type, (into.byType.get(type) ?? 0) + length);
                }
                return original(b, length);
            };
        }
    };

    hook(rig.rawHostTransports, down);
    hook(rig.rawClientTransports, up);

    // Past the join -- which carries a whole-world snapshot and would swamp a
    // twenty-second average -- then a measured stretch.
    rig.step(TICK_HZ * 4);
    counting = true;
    rig.step(TICK_HZ * seconds);
    counting = false;

    return { label, players: clients + bots, clients, seconds, down, up };
}

function report(c: Census): string {
    const types = [...c.down.byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(
            ([t, b]) =>
                `${TYPE_NAMES[t] ?? `type${t}`} ${((100 * b) / c.down.bytes).toFixed(0)}%`
        )
        .join(', ');

    return (
        `  ${c.label.padEnd(26)} ${String(c.players).padStart(2)} players  ` +
        `down ${perClient(c.down, c.clients, c.seconds).toFixed(1).padStart(6)} KB/s  ` +
        `up ${perClient(c.up, c.clients, c.seconds).toFixed(1).padStart(5)} KB/s  ` +
        `host out ${(c.down.bytes / c.seconds / 1024).toFixed(0).padStart(5)} KB/s  [${types}]`
    );
}

describe('what a full match costs on the wire', () => {
    it('is measured both ways, at the population the protocol is sized for', async () => {
        const full = await census('loopback', 8, 8, 'loopback');
        const real = await census('80 ms, 20 jitter, 2%', 8, 8, {
            latency_ms: 80,
            jitter_ms: 20,
            loss_pct: 2,
        });
        const reportShape = await census('loopback, REPORT §5 shape', 6, 4, 'loopback');

        // eslint-disable-next-line no-console
        console.log(
            '\n[net-bandwidth] every byte across the transport, 20 s, everybody firing\n' +
                [full, real, reportShape].map(report).join('\n')
        );

        expect(full.players).toBe(MAX_CLIENTS);

        /*
         **Upstream is small and stays small**, which is the half REPORT never
         measured and the half that is not a problem: a client sends its own
         command and nothing else, so the cost does not grow with the
         population. It grows with the *link*, because the client re-sends its
         unacked frames exactly as the host does.
        */
        expect(perClient(full.up, full.clients, full.seconds)).toBeLessThan(4);
        expect(
            perClient(real.up, real.clients, real.seconds),
            'upstream should still be a fraction of downstream on a real link'
        ).toBeLessThan(perClient(real.down, real.clients, real.seconds) / 4);

        /*
         **Downstream grows with the population**, because every player's state
         goes to every client and there is no per-client baseline. Ten players
         to sixteen is a third more players and about a third more bytes, which
         is the linear term REPORT section 5's host-CPU table found superlinear
         in the other resource.
        */
        expect(
            perClient(full.down, full.clients, full.seconds),
            'sixteen players should cost more than ten'
        ).toBeGreaterThan(perClient(reportShape.down, reportShape.clients, reportShape.seconds));

        /*
         **And most of it is fragments**, on a loopback, where the re-send
         window is one frame deep and cannot be blamed. That is the finding: a
         tick of sixteen players' state does not fit
         `MAX_CHANNEL_PAYLOAD_BYTES`, so every tick is chopped up and every
         chunk carries its own header. Asserted as a majority rather than at 93%
         because the exact share moves with the match; what must not happen
         quietly is it dropping to nothing, which would mean the payload had
         been measured wrong.
        */
        expect(
            share(full.down, 4),
            'a tick of sixteen players no longer fragments -- did the payload shrink?'
        ).toBeGreaterThan(0.5);

        /*
         The per-tick payload, derived rather than asserted, so the MTU crossing
         is visible in the log rather than inferred from a percentage.
        */
        const bytesPerTick = full.down.bytes / full.clients / (full.seconds * TICK_HZ);
        // eslint-disable-next-line no-console
        console.log(
            `[net-bandwidth] one tick to one client at ${full.players} players: ` +
                `${bytesPerTick.toFixed(0)} B against a ${MAX_CHANNEL_PAYLOAD_BYTES} B channel ` +
                `payload -- ${Math.ceil(bytesPerTick / MAX_CHANNEL_PAYLOAD_BYTES)} packets`
        );

        /*
         **The re-send window is the other multiplier and it is the big one.**
         The same match on an 80 ms link costs several times the loopback, and
         the factor is the round trip in frames: `flush_outbound` packs
         `[last_acked + 1, current]` every tick, so a frame is on the wire once
         per frame of round trip. Bounded loosely -- the point is that it is a
         multiple and not a margin.
        */
        const multiplier =
            perClient(real.down, real.clients, real.seconds) /
            perClient(full.down, full.clients, full.seconds);

        // eslint-disable-next-line no-console
        console.log(
            `[net-bandwidth] 80 ms costs ${multiplier.toFixed(1)}x the loopback, which is the ` +
                'round trip in frames: every frame is re-sent until it is acked'
        );

        expect(multiplier, 'the re-send window stopped costing anything').toBeGreaterThan(2);
    }, 900_000);
});
