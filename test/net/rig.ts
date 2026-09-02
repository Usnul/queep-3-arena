/*
 * rig.ts -- a host and N clients in one process, on one clock.
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
 * The whole netcode as a unit test, which is the single biggest thing
 * `engine/network` gives this port: `LoopbackTransport` queues bytes and hands
 * them over only when `deliver_all()` is called, so a test decides exactly when
 * every packet arrives. No timers, no sockets, no sleeping, and a run that
 * reproduces.
 *
 * `step()` advances every clock in one fixed order -- host, deliver, clients,
 * deliver -- and that order is the whole definition of "zero latency" here: a
 * packet the host sent this frame is in the client's hands before the client
 * ticks, and a command the client sent is in the host's before the host ticks
 * again. Anything slower is `SimulatedTransport`'s job in step 7.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LoopbackTransport } from '@woosh/meep-engine/src/engine/network/transport/LoopbackTransport.js';
import { SimulatedTransport } from '@woosh/meep-engine/src/engine/network/transport/adapters/SimulatedTransport.js';

import { BspFile } from '../../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../../tools/pipeline/headless-physics.ts';
import { Host } from '../../src/server/Host.ts';
import { NetClient, type ClientHooks } from '../../src/client/net/NetClient.ts';
import type { EffectEventData, HitEventData, PickupEventData } from '../../src/net/actions.ts';
import { MIN_CLIENT_PEER_ID, SESSION_TICK_SECONDS } from '../../src/net/protocol.ts';
import { createUserCmd, type UserCmd } from '../../src/q3/pmove/types.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** Fills a command for a frame; the rig's stand-in for a keyboard. */
export type Script = (cmd: UserCmd, frame: number, client: RigClient) => void;

/** A command that does nothing, which is what an unscripted client sends. */
export const IDLE: Script = () => {};

/**
 * What the two peers are joined by.
 *
 * `'loopback'` is `LoopbackTransport`: bytes queue and are handed over exactly
 * when the rig says so, which is what makes the zero-latency case a unit test
 * rather than a race.
 *
 * A `Link` object is `SimulatedTransport`, which is the engine's model of a real
 * one -- loss sampled per send, delivery scheduled at `now + latency + jitter`,
 * and **reordering as a consequence** rather than as a setting, exactly as a UDP
 * path reorders. Its clock is injected, so the rig drives simulated time from
 * its own step counter and the run still reproduces.
 */
export type Link =
    | 'loopback'
    | {
          latency_ms: number;
          jitter_ms: number;
          loss_pct: number;
          seed?: number;
      };

/** The two adapters, as much of them as the rig drives. */
interface RigTransport {
    deliverDue(nowMs: number): void;
    droppedCount(): number;
}

export interface RigClient {
    readonly net: NetClient;
    readonly physics: HeadlessPhysics;
    readonly transport: RigTransport;
    /** Replace at any time; called once per predicted frame. */
    script: Script;
    readonly effects: EffectEventData[];
    readonly hits: HitEventData[];
    readonly pickups: PickupEventData[];
    readonly predictedShots: number[];
    /** What the frame-alignment workaround cost this client. See GAP-042. */
    readonly align: { calls: number; milliseconds: number; target: number };
}

export interface RigOptions {
    map: string;
    bots?: number;
    clients?: number;
    seed?: number;
    /** Frames to run the host alone before any client joins. */
    warmup?: number;
    difficulty?: string;
    /** How the peers are joined. Defaults to `'loopback'`. */
    link?: Link;
    /** Host-side input buffer, in frames. */
    simulationDelayTicks?: number;
    /** Action-log ring depth, in frames. Applied to both peers. */
    frameCapacity?: number;
}

export class NetRig {
    readonly host: Host;
    readonly clients: RigClient[] = [];

    /** The link every client is joined by. */
    readonly link: Link;

    /** Action-log ring depth handed to both peers; undefined uses the default. */
    private frameCapacity: number | undefined;

    /**
     * Simulated wall time, in milliseconds, advanced one tick per `step`.
     *
     * `SimulatedTransport` schedules delivery against an injected clock, so
     * driving that clock from the step counter rather than from `Date.now`
     * keeps an 80 ms link exactly 80 ms in every run on every machine. A rig
     * that read the wall clock would measure the test runner.
     */
    private clockMs = 0;

    /** Every effect the host queued, in the order it queued them. */
    readonly hostEffects: { frame: number; kind: number; owner: number }[] = [];

    private constructor(host: Host, link: Link) {
        this.host = host;
        this.link = link;
    }

    static async create(options: RigOptions): Promise<NetRig> {
        const host = await Host.create({
            map: options.map,
            bots: options.bots ?? 0,
            assetRoot: BUILT,
            seed: options.seed ?? 0x5eed,
            difficulty: options.difficulty,
            simulationDelayTicks: options.simulationDelayTicks,
            frameCapacity: options.frameCapacity,
        });

        const rig = new NetRig(host, options.link ?? 'loopback');
        rig.frameCapacity = options.frameCapacity;

        /*
         Past the input buffer before anybody joins. `ServerAuthoritativeServer.tick`
         simulates `wall - simulation_delay_ticks` and returns early while that is
         negative -- warmup, during which `onTickComplete` does not fire, so no
         INITIAL_SYNC goes out and a client that connected into it would predict
         several frames against an empty world. A real host has been running for
         minutes; this is the smallest honest version of that.
        */
        const warmup = Math.max(options.warmup ?? 0, host.session.simulation_delay_ticks + 1);
        for (let i = 0; i < warmup; i++) rig.stepHostOnly();

        for (let i = 0; i < (options.clients ?? 0); i++) await rig.join(`client${i + 1}`, i + 1);

        return rig;
    }

    /**
     * The hello, join and connect of §4.3, done in-process.
     *
     * The order is the wire order and is load-bearing: the host picks a slot and
     * writes `owner_peer_id` **before** `session.connect`, because INITIAL_SYNC
     * goes out on the host tick after the connect and the client has to receive
     * a world in which its own slot is already its own. Doing it the other way
     * round hands the client a slot owned by the host, which it then never
     * predicts.
     */
    async join(name: string, character: number): Promise<RigClient> {
        const peerId = MIN_CLIENT_PEER_ID + this.clients.length;

        const record = this.host.admit(peerId, name, character);

        const raw = readFileSync(join(BUILT, this.host.cm.name, 'collision.bsp'));
        const cm = new ClipMap(
            new BspFile(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                this.host.cm.name
            )
        );
        const physics = await HeadlessPhysics.create(cm);

        const effects: EffectEventData[] = [];
        const hits: HitEventData[] = [];
        const pickups: PickupEventData[] = [];
        const predictedShots: number[] = [];

        const cmd = createUserCmd();
        let self: RigClient;

        const hooks: ClientHooks = {
            sample: (frame) => {
                cmd.angles.fill(0);
                cmd.moves.fill(0);
                cmd.buttons = 0;
                cmd.weapon = 0;
                self.script(cmd, frame, self);
                return cmd;
            },
            predictedFire: (_weapon, frame) => predictedShots.push(frame),
            effect: (event) =>
                effects.push({
                    kind: event.kind,
                    weapon: event.weapon,
                    owner: event.owner,
                    origin: Float32Array.from(event.origin),
                    aux: Float32Array.from(event.aux),
                    radius: event.radius,
                }),
            hit: (event) =>
                hits.push({ attacker: event.attacker, victim: event.victim, damage: event.damage }),
            pickup: (event) => pickups.push({ slot: event.slot, item: event.item }),
        };

        const net = await NetClient.create({
            cm,
            physics,
            peerId,
            slotIndex: record.index,
            spawnQ3: this.host.spawns[record.index % this.host.spawns.length]!,
            hooks,
            itemCount: this.host.items.items.length,
            frameCapacity: this.frameCapacity,
        });

        net.physicsStep = () => physics.step(SESSION_TICK_SECONDS);

        /*
         The frame alignment workaround of §4.4, in its simplest form: the host
         is at frame F and a session that has just started is at -1, so the
         client's inputs would be tagged with frames the host trimmed out of its
         ring thousands of frames ago. `#local_frame` is `#private`, so the only
         way to move it is to tick the session -- which is what `fastForward`
         does, with the sampler silenced. Step 4 measures what that costs.
        */
        const lead = this.host.session.simulation_delay_ticks + 2;
        const target = Math.max(0, this.host.currentFrame + lead);
        const alignStart = performance.now();
        const calls = net.fastForward(target);
        const align = { calls, milliseconds: performance.now() - alignStart, target };

        const { hostSide, clientSide, hostRig, clientRig } = this.makeLink(peerId);

        this.host.session.connect(peerId, hostSide);
        net.session.connect(0, clientSide);

        self = {
            net,
            physics,
            transport: clientRig,
            script: IDLE,
            effects,
            hits,
            pickups,
            predictedShots,
            align,
        };
        this.clients.push(self);

        // The host's side too, so its queue is drained.
        this.hostTransports.push(hostRig);
        this.rawHostTransports.push(hostSide);

        return self;
    }

    private readonly hostTransports: RigTransport[] = [];

    /** The unwrapped host-side adapters, for a test that wants their stats. */
    readonly rawHostTransports: object[] = [];

    /**
     * Build the pair, and wrap each one in the two calls the rig makes of it.
     *
     * The two adapters do not share a drain method -- `LoopbackTransport` hands
     * over everything queued (`deliver_all`) and `SimulatedTransport` hands over
     * whatever is due (`tick(now)`) -- so the rig holds a two-method view rather
     * than branching at every call site.
     */
    private makeLink(peerId: number): {
        hostSide: object;
        clientSide: object;
        hostRig: RigTransport;
        clientRig: RigTransport;
    } {
        if (this.link === 'loopback') {
            const hostSide = new LoopbackTransport();
            const clientSide = new LoopbackTransport();
            LoopbackTransport.bind_pair(hostSide, clientSide);
            return {
                hostSide,
                clientSide,
                hostRig: { deliverDue: () => void hostSide.deliver_all(), droppedCount: () => 0 },
                clientRig: {
                    deliverDue: () => void clientSide.deliver_all(),
                    droppedCount: () => 0,
                },
            };
        }

        const clock = (): number => this.clockMs;
        /*
         A different seed per peer and per direction, so the two sides do not
         drop the *same* packet index as each other -- which is what one shared
         generator would do and is not what a real link looks like.
        */
        const base = this.link.seed ?? 1337;
        const shared = {
            latency_ms: this.link.latency_ms,
            jitter_ms: this.link.jitter_ms,
            loss_pct: this.link.loss_pct,
            clock,
        };
        /*
         The cast is the fourth instance of one declaration defect: the
         constructor destructures `random_seed`, the body uses it to seed the
         loss generator, and the JSDoc `@param` block that becomes the parameter
         type does not list it -- so `tsc` rejects the one option that makes a
         lossy run reproducible. Same shape as `NetworkSession`'s
         `frame_capacity`. See REPORT.md section 4.
        */
        type SimOptions = ConstructorParameters<typeof SimulatedTransport>[0];
        const hostSide = new SimulatedTransport({
            ...shared,
            random_seed: base + peerId * 2,
        } as SimOptions);
        const clientSide = new SimulatedTransport({
            ...shared,
            random_seed: base + peerId * 2 + 1,
        } as SimOptions);
        SimulatedTransport.bind_pair(hostSide, clientSide);

        return {
            hostSide,
            clientSide,
            hostRig: {
                deliverDue: (nowMs) => hostSide.tick(nowMs),
                droppedCount: () => hostSide.dropped_count(),
            },
            clientRig: {
                deliverDue: (nowMs) => clientSide.tick(nowMs),
                droppedCount: () => clientSide.dropped_count(),
            },
        };
    }

    /** One frame with nobody connected; used for warmup and for step 4. */
    stepHostOnly(): void {
        this.clockMs += SESSION_TICK_SECONDS * 1000;
        this.host.step();
        this.recordHostEffects();
    }

    /** What the host raised this frame, for the tests to compare against. */
    private recordHostEffects(): void {
        const frame = this.host.currentFrame;
        for (const seen of this.host.weaponEvents.dispatched) {
            this.hostEffects.push({ frame, kind: seen.kind, owner: seen.owner });
        }
        this.host.weaponEvents.dispatched.length = 0;
    }

    /**
     * One frame of everything, in the order that makes zero latency mean zero.
     *
     * Host first, because its authority is what a client reconciles against;
     * then the client transports drain, so every packet the host just sent is
     * applied before the client predicts on top of it; then the clients tick and
     * send; then the host's transports drain, so the commands are in the host's
     * pending log before its next tick opens.
     */
    step(count = 1): void {
        for (let n = 0; n < count; n++) {
            this.clockMs += SESSION_TICK_SECONDS * 1000;

            this.host.step();
            this.recordHostEffects();

            for (const client of this.clients) client.transport.deliverDue(this.clockMs);
            for (const client of this.clients) client.net.step();
            for (const transport of this.hostTransports) transport.deliverDue(this.clockMs);
        }
    }

    /** Packets the simulated link ate, both directions. Zero on a loopback. */
    get droppedPackets(): number {
        let total = 0;
        for (const client of this.clients) total += client.transport.droppedCount();
        for (const transport of this.hostTransports) total += transport.droppedCount();
        return total;
    }

}

