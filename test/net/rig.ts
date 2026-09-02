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

export interface RigClient {
    readonly net: NetClient;
    readonly physics: HeadlessPhysics;
    readonly transport: LoopbackTransport;
    /** Replace at any time; called once per predicted frame. */
    script: Script;
    readonly effects: EffectEventData[];
    readonly hits: HitEventData[];
    readonly pickups: PickupEventData[];
    readonly predictedShots: number[];
}

export interface RigOptions {
    map: string;
    bots?: number;
    clients?: number;
    seed?: number;
    /** Frames to run the host alone before any client joins. */
    warmup?: number;
    difficulty?: string;
}

export class NetRig {
    readonly host: Host;
    readonly clients: RigClient[] = [];

    /** Every effect the host queued, in the order it queued them. */
    readonly hostEffects: { frame: number; kind: number; owner: number }[] = [];

    private constructor(host: Host) {
        this.host = host;
    }

    static async create(options: RigOptions): Promise<NetRig> {
        const host = await Host.create({
            map: options.map,
            bots: options.bots ?? 0,
            assetRoot: BUILT,
            seed: options.seed ?? 0x5eed,
            difficulty: options.difficulty,
        });

        const rig = new NetRig(host);

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
        net.fastForward(target);

        const hostSide = new LoopbackTransport();
        const clientSide = new LoopbackTransport();
        LoopbackTransport.bind_pair(hostSide, clientSide);

        this.host.session.connect(peerId, hostSide);
        net.session.connect(0, clientSide);

        self = {
            net,
            physics,
            transport: clientSide,
            script: IDLE,
            effects,
            hits,
            pickups,
            predictedShots,
        };
        this.clients.push(self);

        // Both transports, so the host's queue is drained too.
        (self as { hostTransport?: LoopbackTransport }).hostTransport = hostSide;
        this.hostTransports.push(hostSide);

        return self;
    }

    private readonly hostTransports: LoopbackTransport[] = [];

    /** One frame with nobody connected; used for warmup and for step 4. */
    stepHostOnly(): void {
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
            this.host.step();
            this.recordHostEffects();

            for (const client of this.clients) client.transport.deliver_all();
            for (const client of this.clients) client.net.step();
            for (const transport of this.hostTransports) transport.deliver_all();
        }
    }

}

