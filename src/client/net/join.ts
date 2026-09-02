/*
 * join.ts -- the socket, the hello, and the refusals, before any session exists.
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
 * `NETWORK_PLAN.md` section 4.3's hello, from the client's side. One text frame
 * out of band before the transport exists, because `WebSocketTransport` parses
 * every message it sees as a packet and a `MalformedPacketError` on the first
 * byte of a session is a confusing way to say hello.
 *
 * The whole of this module runs before `NetClient` is built: it decides whether
 * there is a match to join at all, and it is the only place a refusal can still
 * be turned into a sentence for the console. Once it returns, the socket is a
 * transport and everything after it is binary.
 */

import type { Hello, Refusal } from '../../server/wsHost.ts';
import { PROTOCOL_VERSION } from '../../net/protocol.ts';

/**
 * A join the host turned down, or a socket that never opened.
 *
 * Separate from a generic `Error` so `main.ts` can put the host's own sentence
 * on the console rather than a stack: every refusal `WsHost` sends is written
 * to be read by a player, and `reason` is that text verbatim.
 */
export class JoinRefused extends Error {
    readonly reason: string;

    constructor(reason: string) {
        super(`the host refused the join: ${reason}`);
        this.name = 'JoinRefused';
        this.reason = reason;
    }
}

export interface JoinOptions {
    /** `ws://host:port`, as `?join=` gave it. */
    url: string;
    /** `?name=`. The host truncates it to `MAX_NAME_BYTES` and echoes nothing. */
    name?: string;
    /** `?character=`. An index into the model set; the host stores it per slot. */
    character?: number;
    /** How long to wait for the socket and the hello together. */
    timeoutMs?: number;
}

export interface Joined {
    /** Open, with the hello already consumed. Hand it straight to a transport. */
    socket: WebSocket;
    hello: Hello;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Open the socket and read the one text frame the host answers with.
 *
 * Resolves with a socket that has had exactly one message taken off it and is
 * otherwise untouched -- `binaryType` set to `arraybuffer`, no listeners left
 * behind except the close handler the caller has not attached yet. Rejects with
 * a {@link JoinRefused} carrying the host's sentence, or the reason no sentence
 * arrived.
 *
 * The version goes in the query string rather than in a first message from the
 * client, because the host has to be able to refuse a version it cannot parse
 * and a query string is the one part of the handshake that predates any
 * agreement about encoding.
 */
export function joinHost(options: JoinOptions): Promise<Joined> {
    const query = new URLSearchParams({ v: String(PROTOCOL_VERSION) });
    if (options.name !== undefined && options.name !== '') query.set('name', options.name);
    if (options.character !== undefined) query.set('character', String(options.character));

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const separator = options.url.includes('?') ? '&' : '?';
    const socket = new WebSocket(`${options.url}${separator}${query.toString()}`);
    socket.binaryType = 'arraybuffer';

    return new Promise<Joined>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            fail(new JoinRefused(`no answer from ${options.url} within ${timeoutMs} ms`));
        }, timeoutMs);

        /*
         Every exit runs through here, and it closes the socket on the failing
         paths only. A resolved join hands the caller a live socket; a rejected
         one must not leave a half-open connection holding a slot on the host
         until its own timeout notices.
        */
        function done(): void {
            settled = true;
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
        }

        function fail(error: Error): void {
            if (settled) return;
            done();
            try {
                socket.close();
            } catch {
                // Already closing, or never opened. Neither changes the reason.
            }
            reject(error);
        }

        function onMessage(event: MessageEvent): void {
            if (settled) return;

            /*
             A binary first frame means the host skipped the hello and went
             straight to packets, which no version of `WsHost` does -- so it is
             either a different server on that port or a proxy rewriting the
             stream, and both are worth naming rather than parsing.
            */
            if (typeof event.data !== 'string') {
                fail(new JoinRefused('the first message was binary, so this is not a queep host'));
                return;
            }

            let parsed: Partial<Hello & Refusal>;
            try {
                parsed = JSON.parse(event.data) as Partial<Hello & Refusal>;
            } catch {
                fail(new JoinRefused('the hello was not JSON, so this is not a queep host'));
                return;
            }

            if (typeof parsed.refused === 'string') {
                fail(new JoinRefused(parsed.refused));
                return;
            }

            if (typeof parsed.peer !== 'number' || typeof parsed.slot !== 'number') {
                fail(new JoinRefused('the hello carried no peer id'));
                return;
            }

            /*
             The host checks the client's version and this checks the host's, and
             both checks are worth having: the query string tells a new host
             about an old client, and this tells an old client about a new host,
             which is the case where the query string got through unread.
            */
            if (parsed.v !== PROTOCOL_VERSION) {
                fail(
                    new JoinRefused(
                        `the host speaks protocol v${String(parsed.v)} and this client ` +
                            `speaks v${PROTOCOL_VERSION}; update one of us`
                    )
                );
                return;
            }

            done();
            resolve({ socket, hello: parsed as Hello });
        }

        function onError(): void {
            // The event carries no reason by design -- the browser withholds it
            // so a page cannot probe the network -- so the URL is the whole of
            // what can honestly be said.
            fail(new JoinRefused(`could not reach ${options.url}`));
        }

        function onClose(event: CloseEvent): void {
            fail(
                new JoinRefused(
                    `the socket closed before the hello (code ${String(event.code)})`
                )
            );
        }

        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
    });
}
