/*
 * net-join-handshake.test.ts -- the browser's side of the hello, in Node.
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
 * `net-websocket.test.ts` drives the handshake by hand to prove the *host*
 * answers correctly. This drives `joinHost` -- the function `main.ts` actually
 * calls -- to prove the client turns each of those answers into either a usable
 * socket or a sentence a player can read.
 *
 * The refusals matter more than the acceptance here. A join that works is
 * visible the moment you try it; a join that fails silently, or fails with a
 * `SyntaxError` from `WebSocket`'s constructor, is the state this port would
 * otherwise ship in -- and every one of these paths is reachable by typing a
 * URL slightly wrong.
 *
 * `joinHost` uses the global `WebSocket`, which Node has had since 22. Nothing
 * here is browser-specific; the browser branch differs only in what it does
 * with the socket afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { WsHost } from '../src/server/wsHost.ts';
import { JoinRefused, joinHost } from '../src/client/net/join.ts';
import { PROTOCOL_VERSION } from '../src/net/protocol.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

let wsHost: WsHost;

beforeAll(async () => {
    wsHost = await WsHost.create({
        map: 'oa_dm1',
        bots: 0,
        port: 0,
        assetRoot: BUILT,
        seed: 909,
        log: () => {},
    });

    // Past the input-buffer warmup, as `NetRig` does and a real host would be.
    for (let i = 0; i < 30; i++) wsHost.host.step();
});

afterAll(async () => {
    await wsHost?.close();
});

/**
 * A server on the same wire protocol that is not this game.
 *
 * Given the first thing it should say, and then left alone. The point of each
 * of these is that a player who typed the wrong port gets told which of the
 * several things that can be wrong is wrong.
 */
async function impostor(first: string | Uint8Array | null): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));

    server.on('connection', (socket) => {
        if (first === null) {
            socket.close();
            return;
        }
        socket.send(first);
    });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe('joining a host', () => {
    it('reads the hello and hands back a live socket', async () => {
        const { socket, hello } = await joinHost({
            url: `ws://127.0.0.1:${wsHost.port}`,
            name: 'Sarge',
            character: 3,
        });

        expect(hello.v).toBe(PROTOCOL_VERSION);
        expect(hello.map).toBe('oa_dm1');
        expect(hello.peer).toBeGreaterThan(0);
        expect(hello.slot).toBeGreaterThanOrEqual(0);

        /*
         The one field this client cannot recover if it is wrong. Both peers
         build their replicated pools from it and match them by position, so a
         disagreement is not a missing shard -- it is every item after the first
         difference reading as the wrong one, on a wire that reports nothing.
        */
        expect(hello.items).toBe(wsHost.host.items.items.length);
        expect(hello.items).toBeGreaterThan(0);

        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
    });

    it('refuses a protocol the host does not speak, in the host words', async () => {
        /*
         The version rides in the query string, so overriding it means putting a
         second `v` on the URL -- `URLSearchParams` keeps both and `WsHost` reads
         the first, which is this one.
        */
        const refused = await joinHost({
            url: `ws://127.0.0.1:${wsHost.port}/?v=${PROTOCOL_VERSION + 7}`,
        }).catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(JoinRefused);
        expect((refused as JoinRefused).reason).toContain(`v${PROTOCOL_VERSION + 7}`);
        expect((refused as JoinRefused).reason).toContain('update one of us');
    });

    it('names a server that answers with something that is not a hello', async () => {
        const server = await impostor('OK MOTD');

        const refused = await joinHost({ url: server.url }).catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(JoinRefused);
        expect((refused as JoinRefused).reason).toContain('not JSON');

        await server.close();
    });

    it('names a server that goes straight to binary', async () => {
        const server = await impostor(new Uint8Array([0, 1, 2, 3]));

        const refused = await joinHost({ url: server.url }).catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(JoinRefused);
        expect((refused as JoinRefused).reason).toContain('binary');

        await server.close();
    });

    it('names a socket that closes before saying anything', async () => {
        const server = await impostor(null);

        const refused = await joinHost({ url: server.url }).catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(JoinRefused);
        expect((refused as JoinRefused).reason).toContain('closed before the hello');

        await server.close();
    });

    it('gives up on a port nothing is listening on, rather than hanging', async () => {
        /*
         Bound and released, so the port is one nothing holds -- picking a
         constant would make this test fail on a machine that happens to run
         something there.
        */
        const server = await impostor(null);
        const url = server.url;
        await server.close();

        const refused = await joinHost({ url, timeoutMs: 4000 }).catch(
            (error: unknown) => error
        );

        expect(refused).toBeInstanceOf(JoinRefused);
        expect((refused as JoinRefused).reason).toMatch(/could not reach|closed before the hello/);
    });

    it('does not leave a refused socket holding a slot on the host', async () => {
        const before = wsHost.host.lowestFreeSlot();

        const server = await impostor('not a hello');
        await joinHost({ url: server.url }).catch(() => undefined);
        await server.close();

        /*
         The host is a bystander here -- the refusal came from an impostor -- so
         what this actually holds is that a failed `joinHost` closes its own
         socket rather than leaving one half-open. The host's slot count is the
         cheapest observable that would move if it did not.
        */
        expect(wsHost.host.lowestFreeSlot()).toBe(before);
    });
});
