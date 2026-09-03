/*
 * net-websocket.test.ts -- the same host, over a socket that really exists.
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
 * `net-loopback.test.ts` proves the simulation; this proves the plumbing, and
 * they are different failures. A loopback transport hands over a `Uint8Array`
 * the sender just wrote; a WebSocket hands over an `ArrayBuffer` (or, on the
 * server side, a Node `Buffer`) some time later, on another turn of the event
 * loop, after a handshake and a URL query string. Every one of those is
 * somewhere the bytes can stop arriving, and none of them is visible to a test
 * that never opens a port.
 *
 * The host's own `setTimeout` loop is deliberately **not** started. This drives
 * `host.step()` by hand and yields to the event loop between steps, so the test
 * asserts an outcome -- the client's input reached the host and moved it --
 * rather than a frame count that depends on how busy the machine is. A test
 * that raced a wall clock would fail on CI for a reason that has nothing to do
 * with the code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { WebSocketTransport } from '@woosh/meep-engine/src/engine/network/transport/adapters/WebSocketTransport.js';

import { WsHost, type Hello } from '../src/server/wsHost.ts';
import { NetClient } from '../src/client/net/NetClient.ts';
import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { PROTOCOL_VERSION, SESSION_TICK_SECONDS } from '../src/net/protocol.ts';
import { createUserCmd, FORWARDMOVE } from '../src/q3/pmove/types.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** Let the event loop deliver whatever the sockets have queued. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** Host steps taken before any client is allowed in. */
const HOST_WARMUP_STEPS = 30;

let wsHost: WsHost;
const logged: string[] = [];

beforeAll(async () => {
    wsHost = await WsHost.create({
        map: 'oa_dm1',
        bots: 0,
        port: 0, // ephemeral, so a stray host from another run cannot collide
        assetRoot: BUILT,
        seed: 4242,
        log: (line) => logged.push(line),
    });

    // Past the input-buffer warmup, as `NetRig` does and a real host would be.
    for (let i = 0; i < HOST_WARMUP_STEPS; i++) wsHost.host.step();
});

afterAll(async () => {
    await wsHost?.close();
});

/** Open a socket, read the one text frame, and hand back what it said. */
async function hello(query: string): Promise<{ socket: WebSocket; first: string }> {
    const socket = new WebSocket(`ws://127.0.0.1:${wsHost.port}/?${query}`);
    socket.binaryType = 'arraybuffer';

    const first = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no hello within 5 s')), 5000);
        socket.addEventListener('message', (event) => {
            clearTimeout(timer);
            resolve(String((event as MessageEvent).data));
        });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('socket error before hello'));
        });
    });

    return { socket, first };
}

describe('the hello', () => {
    it('tells a joining client its peer, its slot and what frame it is', async () => {
        const { socket, first } = await hello(
            `v=${PROTOCOL_VERSION}&name=Sarge&character=3`
        );

        const parsed = JSON.parse(first) as Hello;

        expect(parsed.v).toBe(PROTOCOL_VERSION);
        expect(parsed.map).toBe('oa_dm1');
        expect(parsed.peer).toBeGreaterThan(0);
        expect(parsed.slot).toBeGreaterThanOrEqual(0);
        /*
         The frame is the whole reason the hello exists in the first place: the
         engine drops `frame_number` from INITIAL_SYNC (GAP-042), so this text
         frame is the only place a client can learn what time it is, and it has
         to arrive before the transport starts treating everything as a packet.

         `HOST_WARMUP_STEPS` steps in, the host's *simulation* frame is
         `steps - simulation_delay_ticks - 1`: `Host.step` hands `session.tick`
         a wall frame that starts at 0, and `ServerAuthoritativeServer.tick`
         simulates `wall - delay`. So the number the client is told is the frame
         its inputs will be applied against, which is the one it needs, and it
         is four behind the host's own wall clock, which is what the buffer is.
        */
        const delay = wsHost.host.session.simulation_delay_ticks;
        expect(parsed.frame).toBe(HOST_WARMUP_STEPS - delay - 1);

        expect(wsHost.host.slots[parsed.slot]!.info.name).toBe('Sarge');
        expect(wsHost.host.slots[parsed.slot]!.info.character).toBe(3);

        socket.close();
        await settle();
    });

    it('refuses a protocol mismatch before a session exists', async () => {
        const { socket, first } = await hello('v=999');
        const parsed = JSON.parse(first) as { refused?: string };

        expect(parsed.refused, 'a mismatched client was let in').toContain('protocol');
        expect(parsed.refused).toContain('v999');

        socket.close();
        await settle();
    });

    it('frees the slot again when the socket closes', async () => {
        const { socket, first } = await hello(`v=${PROTOCOL_VERSION}&name=Brief`);
        const parsed = JSON.parse(first) as Hello;

        expect(wsHost.host.slots[parsed.slot]!.connected).toBe(true);

        socket.close();

        /*
         Polled rather than settled a fixed number of times. A socket close is
         an event loop turn on a machine that may be doing something else, and a
         test that guesses how many turns is a test that fails under load and
         nowhere else -- which is exactly how this one failed the first time the
         whole suite ran in parallel.
        */
        for (let n = 0; n < 200 && wsHost.host.slots[parsed.slot]!.connected; n++) {
            await settle();
        }

        expect(wsHost.host.slots[parsed.slot]!.connected).toBe(false);
        expect(wsHost.host.lowestFreeSlot()).toBeLessThanOrEqual(parsed.slot);
    });
});

describe('a client over a real socket', () => {
    it('sends input the host acts on, and gets the world back', async () => {
        const { socket, first } = await hello(`v=${PROTOCOL_VERSION}&name=Real&character=1`);
        const parsed = JSON.parse(first) as Hello;

        const raw = await import('node:fs').then((fs) =>
            fs.readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'))
        );
        const cm = new ClipMap(
            new BspFile(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                'oa_dm1'
            )
        );
        const physics = await HeadlessPhysics.create(cm);

        const cmd = createUserCmd();
        let frameCounter = 0;

        const client = await NetClient.create({
            cm,
            physics,
            peerId: parsed.peer,
            slotIndex: parsed.slot,
            spawnQ3: wsHost.host.spawns[parsed.slot % wsHost.host.spawns.length]!,
            itemCount: wsHost.host.items.items.length,
            hooks: {
                sample: () => {
                    cmd.angles.fill(0);
                    cmd.moves.fill(0);
                    cmd.buttons = 0;
                    cmd.weapon = 0;
                    cmd.angles[1] = angleToShort(frameCounter * 4);
                    cmd.moves[FORWARDMOVE] = 127;
                    frameCounter += 1;
                    return cmd;
                },
            },
        });
        client.physicsStep = () => physics.step(SESSION_TICK_SECONDS);

        /*
         Connect, and the engine aligns: INITIAL_SYNC carries the host's frame
         and 3.14.6 seeks this session to it, which is what makes the client's
         first input land inside the host's ring rather than 30 frames behind
         its oldest slot. The hello's own frame is asserted below instead of
         being fed to a loop. GAP-042, D-188.
        */
        client.session.connect(0, new WebSocketTransport({ socket: socket as never }));

        const slot = wsHost.host.slots[parsed.slot]!;
        const before = [...slot.state.origin];
        let walked = 0;
        let previous = before;

        /*
         Six seconds of frames, yielding to the event loop every step so the
         sockets can actually deliver. Slower than real time by a long way, and
         that is fine: what is being tested is that the bytes arrive and mean
         the right thing, not how fast.
        */
        for (let n = 0; n < 360; n++) {
            wsHost.host.step();
            await settle();
            client.step();
            await settle();

            const now = [...slot.state.origin];
            walked += Math.hypot(now[0]! - previous[0]!, now[1]! - previous[1]!);
            previous = now;
        }

        // eslint-disable-next-line no-console
        console.log(
            `[net-websocket] over a real socket: client synced ${client.synced}, ` +
                `predicted ${client.predictedFrames} frames, host walked ${walked.toFixed(0)} units, ` +
                `reconciles ${client.reconcileCount}, short-circuit ${client.shortCircuitHits}/` +
                `${client.shortCircuitHits + client.shortCircuitMisses}`
        );

        // The world arrived.
        expect(client.synced, 'INITIAL_SYNC never landed over the socket').toBe(true);
        expect(client.predictedFrames, 'the client never predicted a frame').toBeGreaterThan(100);

        /*
         And the session seeked itself over a real socket, not just over the
         rig's loopback. A client that had not been aligned would still be
         counting from zero after 360 frames; this one is past the frame the
         hello reported, because it was seeked to it and has run since.
        */
        expect(
            client.currentFrame,
            'the session never took the frame INITIAL_SYNC carried'
        ).toBeGreaterThan(parsed.frame);

        // And the input went the other way.
        expect(walked, 'the host never saw the socket client move').toBeGreaterThan(200);

        // The client's own view agrees with the host's, within a frame of travel.
        const seen = client.ownSlot.state.origin;
        const lag = Math.hypot(seen[0]! - previous[0]!, seen[1]! - previous[1]!);
        expect(lag).toBeLessThan(64);

        socket.close();
        await settle();
    });
});

describe('the host log', () => {
    it('names every join and every refusal', () => {
        const joins = logged.filter((line) => line.startsWith('+'));
        const refusals = logged.filter((line) => line.startsWith('- refused'));

        expect(joins.length).toBeGreaterThan(0);
        expect(refusals.length).toBeGreaterThan(0);
        expect(joins.some((line) => line.includes('Sarge'))).toBe(true);
    });
});
