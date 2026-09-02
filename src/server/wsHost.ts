/*
 * wsHost.ts -- the host on a real socket.
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
 * A `ws` server, the hello of `NETWORK_PLAN.md` §4.3, and a loop.
 *
 * **The hello is out of band, on the socket, before the transport exists**, and
 * it has to be, for two reasons that are both the engine's:
 *
 *  - ownership is decided when a `NetworkIdentity` attaches and INITIAL_SYNC
 *    goes out on the host tick *after* `session.connect`, so the host has to
 *    pick a slot and write `owner_peer_id` before it connects the peer -- a
 *    join message arriving later is too late (GAP-040);
 *  - the client cannot tag an input until it knows what frame it is
 *    (GAP-042), and the only place to tell it is a message the client reads
 *    before it hands the socket to `WebSocketTransport` -- once the transport
 *    is listening, every frame is a packet and a JSON one is a malformed
 *    packet.
 *
 * So: one text frame from the host, then binary for ever. The client parses the
 * text frame, aligns, and only then constructs its transport.
 *
 * **`ws` satisfies `WebSocketTransport` without an adapter.** The engine's own
 * docblock lists what it duck-types against -- `binaryType`, `addEventListener`
 * for message/close/error/open, `send`, `close`, `readyState` -- and Node's `ws`
 * has all of them. The one thing to watch is that `ws` delivers a Node `Buffer`
 * for a binary frame rather than an `ArrayBuffer`, and the adapter drops
 * anything that is neither `ArrayBuffer` nor string, silently. `binaryType` is
 * therefore set to `'arraybuffer'` on the server socket as well, which `ws`
 * honours.
 */

import { WebSocketServer, type WebSocket } from 'ws';

import { WebSocketTransport } from '@woosh/meep-engine/src/engine/network/transport/adapters/WebSocketTransport.js';

import { Host, type HostOptions } from './Host.ts';
import {
    MAX_CLIENT_PEER_ID,
    MIN_CLIENT_PEER_ID,
    PROTOCOL_VERSION,
    SESSION_TICK_SECONDS,
} from '../net/protocol.ts';
import { truncateUtf8 } from '../net/adapters.ts';
import { MAX_NAME_BYTES } from '../net/components.ts';

/** What the host sends a client that is being let in. */
export interface Hello {
    peer: number;
    slot: number;
    frame: number;
    map: string;
    bots: number;
    /**
     * How many items the host's `ItemSystem` spawned.
     *
     * The client loads the same map and could count them itself, and that is
     * exactly why this is here: `ItemSystem.spawn` *rejects* an item whose drop
     * trace starts in a solid, so the count is a function of the collision
     * backend as well as of the map, and the two ends do not have to be running
     * the same one. The pools are built from this number on both sides and a
     * silent disagreement is a corrupt wire rather than a missing shard, so the
     * client checks it against its own and refuses the join if they differ.
     */
    items: number;
    /** The protocol the host speaks; the client has already sent its own. */
    v: number;
}

/** What the host sends a client that is not. */
export interface Refusal {
    refused: string;
}

export interface WsHostOptions extends HostOptions {
    port?: number;
    /** Called with every line the host would print. Defaults to `console.log`. */
    log?: (line: string) => void;
}

const DEFAULT_PORT = 5300;

export class WsHost {
    readonly host: Host;
    readonly server: WebSocketServer;

    private readonly log: (line: string) => void;
    private readonly peerOf = new Map<WebSocket, number>();
    private nextPeer = MIN_CLIENT_PEER_ID;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastTickMs = 0;
    private accumulator = 0;

    /** How many fixed steps the loop has had to drop to catch up. */
    droppedSteps = 0;

    private constructor(host: Host, server: WebSocketServer, log: (line: string) => void) {
        this.host = host;
        this.server = server;
        this.log = log;
    }

    static async create(options: WsHostOptions): Promise<WsHost> {
        const host = await Host.create(options);
        const port = options.port ?? DEFAULT_PORT;
        const log = options.log ?? ((line: string) => console.log(line));

        const server = new WebSocketServer({ port });
        const wsHost = new WsHost(host, server, log);

        server.on('connection', (socket, request) => {
            wsHost.accept(socket, request?.url ?? '');
        });

        log(
            `queep host: ${options.map}, ${options.bots ?? 0} bots, protocol v${PROTOCOL_VERSION}, ` +
                `listening on ws://localhost:${port}`
        );

        return wsHost;
    }

    /**
     * A socket arrived. Decide, answer, and only then hand it to the session.
     *
     * Every refusal closes the socket with a JSON reason rather than a WebSocket
     * close code, because a close code is four digits and a player wants a
     * sentence.
     */
    private accept(socket: WebSocket, url: string): void {
        const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');

        const version = Number(query.get('v') ?? '0');
        if (version !== PROTOCOL_VERSION) {
            this.refuse(
                socket,
                `protocol v${version} against this host's v${PROTOCOL_VERSION}; update one of us`
            );
            return;
        }

        const slot = this.host.lowestFreeSlot();
        if (slot < 0) {
            this.refuse(socket, 'server full');
            return;
        }

        const peer = this.takePeerId();
        if (peer < 0) {
            this.refuse(socket, 'no peer id free');
            return;
        }

        const name = truncateUtf8(query.get('name') || `player${slot}`, MAX_NAME_BYTES);
        const character = Number(query.get('character') ?? '0') | 0;

        const record = this.host.admit(peer, name, character);

        const hello: Hello = {
            peer,
            slot: record.index,
            frame: this.host.currentFrame,
            map: this.host.cm.name,
            bots: this.host.slots.filter((s) => s.bot !== null).length,
            items: this.host.items.items.length,
            v: PROTOCOL_VERSION,
        };

        /*
         The text frame, then the transport. In this order and never the other:
         the transport's message listener would parse this JSON as a packet, and
         a `MalformedPacketError` on the first byte of a session is a confusing
         way to say hello.
        */
        socket.send(JSON.stringify(hello));

        socket.binaryType = 'arraybuffer';
        this.peerOf.set(socket, peer);

        socket.on('close', () => this.drop(socket, 'socket closed'));
        socket.on('error', () => this.drop(socket, 'socket error'));

        this.host.session.connect(peer, new WebSocketTransport({ socket: socket as never }));

        this.log(`+ ${name} joined as peer ${peer} in slot ${record.index} at frame ${hello.frame}`);
    }

    private refuse(socket: WebSocket, reason: string): void {
        const refusal: Refusal = { refused: reason };
        try {
            socket.send(JSON.stringify(refusal));
        } finally {
            socket.close();
        }
        this.log(`- refused a connection: ${reason}`);
    }

    private drop(socket: WebSocket, why: string): void {
        const peer = this.peerOf.get(socket);
        if (peer === undefined) return;
        this.peerOf.delete(socket);

        this.host.release(peer);
        this.host.session.drop_peer(peer, why);
        this.log(`- peer ${peer} left: ${why}`);
    }

    /**
     * The lowest peer id nobody is using.
     *
     * Peer ids are `0..254` with the host at 0 and `0xFF` reserved as the
     * engine's `SENDER_LOCAL`, so this is a small space and reuse is normal
     * rather than exceptional -- a server that ran for a day would exhaust it
     * otherwise.
     */
    private takePeerId(): number {
        const taken = new Set(this.peerOf.values());
        for (let n = 0; n < MAX_CLIENT_PEER_ID - MIN_CLIENT_PEER_ID + 1; n++) {
            const candidate =
                MIN_CLIENT_PEER_ID +
                ((this.nextPeer - MIN_CLIENT_PEER_ID + n) % (MAX_CLIENT_PEER_ID - MIN_CLIENT_PEER_ID + 1));
            if (taken.has(candidate)) continue;
            this.nextPeer = candidate + 1 > MAX_CLIENT_PEER_ID ? MIN_CLIENT_PEER_ID : candidate + 1;
            return candidate;
        }
        return -1;
    }

    /* ------------------------------------------------------------------ *
     * The loop
     * ------------------------------------------------------------------ */

    /**
     * Run the simulation on wall time.
     *
     * `setTimeout(1)` rather than `setInterval`, because an interval that
     * cannot keep up queues callbacks and then runs them back to back, which
     * turns a hitch into a burst. A timeout plus an accumulator degrades by
     * *dropping* time instead, and says so in the log.
     */
    start(): void {
        if (this.timer !== null) return;
        this.lastTickMs = performance.now();

        const pump = (): void => {
            const now = performance.now();
            const elapsed = now - this.lastTickMs;
            this.lastTickMs = now;

            this.accumulator += elapsed / 1000;

            let steps = 0;
            while (this.accumulator >= SESSION_TICK_SECONDS && steps < MAX_STEPS_PER_PUMP) {
                this.accumulator -= SESSION_TICK_SECONDS;
                this.host.step();
                steps += 1;
            }

            /*
             Behind by more than the catch-up budget: throw the arrears away and
             log it. Carrying them means the next pump runs the cap again and
             the host never catches up while every client sees a hitch; dropping
             them means the match jumps once and then runs. A GC pause longer
             than a fifth of a second is the usual cause and hiding it would be
             hiding the one number that explains a bad evening.
            */
            if (this.accumulator >= SESSION_TICK_SECONDS) {
                const dropped = Math.floor(this.accumulator / SESSION_TICK_SECONDS);
                this.droppedSteps += dropped;
                this.accumulator = 0;
                this.log(`! host fell behind by ${dropped} steps (${(dropped / 60).toFixed(2)} s)`);
            }

            this.timer = setTimeout(pump, 1);
        };

        this.timer = setTimeout(pump, 1);
    }

    stop(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    async close(): Promise<void> {
        this.stop();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    get port(): number {
        const address = this.server.address();
        return typeof address === 'object' && address !== null ? address.port : -1;
    }
}

/**
 * Catch-up budget, in steps. Twelve is a fifth of a second, which is
 * `PmoveSingle`'s own 200 ms ceiling and the same number `PlayerController`
 * clamps a step to.
 */
const MAX_STEPS_PER_PUMP = 12;
