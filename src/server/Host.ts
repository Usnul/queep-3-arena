/*
 * Host.ts -- the simulation authority.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * `test/match.test.ts`'s arrangement -- collision, movers, items, waypoints,
 * bots, weapons, missiles, damage queries, all headless on the shipping backend
 * -- plus a `NetworkSession` in host role and the two things that turns out to
 * need: a pool of entities and a publish pass.
 *
 * **Three facts about the engine shape everything below**, and each of them cost
 * a reading of `NetworkSession.js` to establish rather than a guess.
 *
 * 1. **Nothing is spawned after the first client connects.**
 *    `ReplaceComponentAction.apply` returns silently when
 *    `slot_table.entity_for(network_id) < 0`, and `STATE_BURST` updates existing
 *    entities only. So every networked thing -- 16 player slots, 64 missile
 *    slots, one entity per item, one per mover, one match -- is created before
 *    `start()`, and a rocket is a slot that switches on rather than an entity
 *    that appears. See GAP-038.
 *
 * 2. **The action log is open only inside a tick.** `SimActionExecutor.execute`
 *    writes into `ActionLog.current_buffer()` unconditionally, and that throws
 *    `no frame is open` between ticks. On the host a frame is open only inside
 *    `ServerAuthoritativeServer.#replay_frame`, which is to say during
 *    `onLocalSim(f)`. So the whole world step and the whole publish pass run
 *    from `onLocalSim`, and nowhere else.
 *
 * 3. **`onLocalSim` re-runs for every frame in a rollback window.** Its own
 *    docblock asks for the handler to be idempotent, and a game's world step is
 *    the one thing that cannot be: bots think, missiles fly, items respawn.
 *    The newest-frame gate is the whole defence -- the world runs only when
 *    the frame being replayed is the newest one, and the historical
 *    `ReplaceComponent` records in the log restore the older frames' state on
 *    the way past. See GAP-039.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';

import { BspFile } from '../q3/bsp/BspFile.ts';
import { ClipMap } from '../q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../q3/cm/trace.ts';
import { vec3, type Vec3, type Vec3Like } from '../q3/math.ts';
import { HeadlessPhysics } from '../../tools/pipeline/headless-physics.ts';
import { ItemSystem, type DropTrace } from '../game/Items.ts';
import { buildWaypoints, linkMapPortals, type WaypointGraph } from '../game/Waypoints.ts';
import { spawnPoints } from '../game/Spawns.ts';
import { Bot } from '../game/Bot.ts';
import { BotRuntime, type BotWorld } from '../client/Bots.ts';
import { DEFAULT_DIFFICULTY, difficulty } from '../game/Difficulty.ts';
import { CharacterBodies, type CharacterSlot } from '../client/CharacterBody.ts';
import { Missiles } from '../client/Missiles.ts';
import { DamageQueries } from '../client/DamageQueries.ts';
import {
    WeaponSystem,
    type Damageable,
    type WeaponEvents,
    type WeaponId,
} from '../game/Weapons.ts';
import { PlayerSlot, type StepSink } from '../game/PlayerSlot.ts';
import * as C from '../q3/pmove/constants.ts';
import {
    NetInventory,
    NetItem,
    NetMatch,
    NetMissile,
    NetMover,
    NetPlayerInfo,
    NetPlayerState,
    weaponIndex,
} from '../net/components.ts';
import { EffectKind, type ActionContext, type ProtocolActions } from '../net/actions.ts';
import { registerProtocol } from '../net/registerProtocol.ts';
import { createSession } from '../net/session.ts';
import {
    FRAME_CAPACITY,
    HOST_PEER_ID,
    MAX_CLIENTS,
    MAX_MISSILES,
    SESSION_TICK_SECONDS,
    SIMULATION_DELAY_TICKS,
    TICK_HZ,
    frameMsec,
    frameTimeMs,
} from '../net/protocol.ts';
import { makeRandom } from './random.ts';

/** The solver's step. A constant, so every peer integrates with the same one. */
const SOLVER_DT = SESSION_TICK_SECONDS;

/** Q3's `player_die` to `ClientSpawn` gap. */
const RESPAWN_SECONDS = 2;

interface SceneEntity {
    classname?: string;
    _originQ3: number[];
    target?: unknown;
    targetname?: unknown;
    model?: unknown;
    spawnflags?: unknown;
}

interface Scene {
    entities: SceneEntity[];
    submodels: { minsQ3: number[]; maxsQ3: number[] }[];
}

export interface HostOptions {
    map: string;
    /** How many bots to fill the map with, from the spawns the humans do not take. */
    bots?: number;
    difficulty?: string;
    /** Where `assets/built` lives. */
    assetRoot: string;
    /** Seeds every draw the simulation makes; the same seed is the same match. */
    seed?: number;
    fragLimit?: number;
    /**
     * Host-side input buffer, in frames. Defaults to
     * {@link SIMULATION_DELAY_TICKS}.
     *
     * Tunable because `NETWORK_PLAN.md` §7's risk list says to raise it if
     * `onRewind` fires every tick, and it does -- see D-173.
     */
    simulationDelayTicks?: number;
}

/**
 * One player slot's worth of host-side state.
 *
 * A slot exists for the whole match whether anyone is in it or not, because
 * the entity behind it does. `connected` is what says whether it is a player.
 */
interface Slot {
    readonly index: number;
    readonly entity: number;
    readonly slot: PlayerSlot;
    readonly body: CharacterSlot | null;
    readonly state: NetPlayerState;
    readonly inventory: NetInventory;
    readonly info: NetPlayerInfo;
    /** Peer that owns this slot, or -1 for a free one. */
    peerId: number;
    /** Set for a slot a bot is playing; the bot drives the same `PlayerSlot`. */
    bot: Bot | null;
    connected: boolean;
    alive: boolean;
    /** Seconds until respawn; negative while alive. */
    respawnIn: number;
    /** Whole seconds counted for `ClientTimerActions`' bleed. */
    bleedAccumulator: number;
    /** Last frame this slot's weapon actually fired; keys the side effect. */
    lastFiredFrame: number;
    readonly mins: Float64Array;
    readonly maxs: Float64Array;
}

interface MissileEntry {
    readonly entity: number;
    readonly component: NetMissile;
    /** `Projectile.id` currently in this pool slot, or -1. */
    projectileId: number;
}

export class Host {
    readonly entityManager: EntityManager;
    readonly world: EntityComponentDataset;
    readonly physics: HeadlessPhysics;
    readonly cm: ClipMap;
    readonly session: NetworkSession;
    /** Assigned once, in `create`, after the session exists. */
    actions!: ProtocolActions;

    readonly items: ItemSystem;
    readonly weapons: WeaponSystem;
    readonly graph: WaypointGraph;
    readonly bots: BotRuntime;

    readonly slots: Slot[] = [];
    readonly spawns: number[][];

    /** The match entity's replicated state. */
    readonly match = new NetMatch();

    private readonly bodies: CharacterBodies;
    /** Filled by `buildPools`; the action context reads it lazily. */
    private readonly slotByEntity = new Map<number, Slot>();
    private readonly missilePool: MissileEntry[] = [];
    private readonly itemEntities: { entity: number; component: NetItem }[] = [];
    private readonly matchEntity: number;
    private readonly random: () => number;
    private readonly events: HostWeaponEvents;

    /** Wall frame; `session.tick` advances it and the sim runs `- delay` behind. */
    private wallFrame = 0;

    /** Highest frame the world step has actually run for. */
    private simulatedThrough = -1;

    private constructor(parts: {
        entityManager: EntityManager;
        world: EntityComponentDataset;
        physics: HeadlessPhysics;
        cm: ClipMap;
        items: ItemSystem;
        graph: WaypointGraph;
        bodies: CharacterBodies;
        weapons: WeaponSystem;
        bots: BotRuntime;
        spawns: number[][];
        random: () => number;
        events: HostWeaponEvents;
        matchEntity: number;
        session: NetworkSession;
    }) {
        this.entityManager = parts.entityManager;
        this.world = parts.world;
        this.physics = parts.physics;
        this.cm = parts.cm;
        this.items = parts.items;
        this.graph = parts.graph;
        this.bodies = parts.bodies;
        this.weapons = parts.weapons;
        this.bots = parts.bots;
        this.spawns = parts.spawns;
        this.random = parts.random;
        this.events = parts.events;
        this.matchEntity = parts.matchEntity;
        this.session = parts.session;
    }

    static async create(options: HostOptions): Promise<Host> {
        const mapName = options.map;
        const built = `${options.assetRoot}/${mapName}`;

        const { readFileSync } = await import('node:fs');
        const raw = readFileSync(`${built}/collision.bsp`);
        const cm = new ClipMap(
            new BspFile(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                mapName
            )
        );
        const scene = JSON.parse(readFileSync(`${built}/scene.json`, 'utf8')) as Scene;

        const physics = await HeadlessPhysics.create(cm);

        const trace: DropTrace = (start, mins, maxs, end, mask) => {
            const out = createTrace();
            physics.trace(out, start, end, mins, maxs, mask);
            return out;
        };

        const items = new ItemSystem();
        items.spawn(scene.entities, trace);

        const graph = buildWaypoints(
            scene.submodels[0] ?? { minsQ3: [-4096, -4096, -4096], maxsQ3: [4096, 4096, 4096] },
            trace
        );
        linkMapPortals(graph, scene.entities, scene.submodels);

        const bodies = new CharacterBodies(
            { system: physics.system, ecd: physics.ecd },
            physics.ecd,
            physics.traceIgnores
        );
        const missiles = new Missiles(physics.system, physics.ecd, bodies);
        const damageQueries = new DamageQueries(physics.system, bodies);

        const events = new HostWeaponEvents();
        const weapons = new WeaponSystem(cm, events, missiles, damageQueries);

        const entrances = spawnPoints(scene.entities);
        const spawns = entrances.points.map((e) => e._originQ3);
        if (spawns.length === 0) throw new Error(`${mapName} has no spawn points`);

        const random = makeRandom(options.seed ?? 0x5eed);

        /*
         The waypoint graph's node origins are standing positions; a spawn is
         nine units below one, as Q3's own `SelectSpawnPoint` places a client.
        */
        const snap = (origin: number[]): number[] => {
            const node = graph.nearestInMainBody(origin);
            if (node < 0) return origin;
            const n = graph.nodes[node]!.origin;
            return [n[0]!, n[1]!, n[2]! - 9];
        };
        const snapped = spawns.map(snap);

        // Declared here so `botWorld`'s closures can reach the host that does
        // not exist yet; assigned below, before anything calls them.
        let hostRef: Host | null = null;

        const botWorld: BotWorld = {
            graph,
            items: items.items,
            visible: (fromQ3, toQ3) => weapons.visible(fromQ3, toQ3),
            /*
             Step 6 replaces this pair with a `targets()` over every connected,
             alive human. Until then a host with one client behaves exactly as
             single-player does, which is what makes the loopback test's
             assertions about bots comparable to `match.test.ts`'s.
            */
            playerOrigin: () => hostRef!.firstHumanOrigin(),
            playerAlive: () => hostRef!.anyHumanAlive(),
            spawns: snapped,
            fire: (bot, eye, angles, weapon) => {
                weapons.fire(weapon, eye, angles, bot.id, (random() * 0x10000) | 0);
            },
        };

        const bots = new BotRuntime(botWorld, null);
        bots.setDifficulty(difficulty(options.difficulty ?? DEFAULT_DIFFICULTY));
        /*
         Every draw the match makes comes off one seeded generator, so the same
         seed is the same match. `BotRuntime.random` covers the two choices a
         bot makes for itself; `botWorld.fire` above seeds the weapon spread
         from the same source, and `mortality` picks respawn points from it.
         `Q_crandom` is untouched and still lays out the pellets (D-026).
        */
        bots.random = random;

        const entityManager = new EntityManager();
        const world = new EntityComponentDataset();
        entityManager.attachDataset(world);
        await new Promise<void>((resolve, reject) => {
            entityManager.startup(resolve, reject);
        });

        const matchEntity = world.createEntity();

        const session = createSession({
            entity_manager: entityManager,
            role: 'host',
            local_peer_id: HOST_PEER_ID,
            simulation_delay_ticks: options.simulationDelayTicks ?? SIMULATION_DELAY_TICKS,
            tick_rate_hz: TICK_HZ,
            frame_capacity: FRAME_CAPACITY,
            /*
             Off. The rig drives every clock by hand, and a wall-clock reaper
             inside a deterministic test is a test that fails on a slow machine.
             `wsHost.ts` turns it back on, where a silent socket is a real event.
            */
            connection_timeout_ms: 0,
        });

        const host = new Host({
            entityManager,
            world,
            physics,
            cm,
            items,
            graph,
            bodies,
            weapons,
            bots,
            spawns: snapped,
            random,
            events,
            matchEntity,
            session,
        });
        hostRef = host;

        host.match.fragLimit = options.fragLimit ?? 0;
        host.match.phase = 1;

        /*
         The context's closures reach the host's slots through a map that
         `buildPools` fills, so it can be built before there are any -- which it
         has to be: `registerProtocol` defines the action classes and every
         `replicate` call, and all of that has to happen before `start()`.
        */
        host.actions = registerProtocol(session, world, host.actionContext());

        /*
         Then start, and only then build the pools. `NetworkSystem` is what
         allocates a `NetworkIdentity`'s `network_id` and it is registered by
         `start()`; the session's own identity observer is connected there too.
         An entity built before either exists is a networked thing nothing knows
         about, which presents as a client whose world is missing exactly the
         entities the host made first.
        */
        await session.start();

        host.buildPools(options.bots ?? 0);
        host.startSession();

        return host;
    }

    /* ------------------------------------------------------------------ *
     * Pools -- every networked entity, before the first connect
     * ------------------------------------------------------------------ */

    private buildPools(botCount: number): void {
        const world = this.world;

        // The match entity first, so it takes the lowest network id.
        world.addComponentToEntity(this.matchEntity, new NetworkIdentity());
        world.addComponentToEntity(this.matchEntity, this.match);

        for (let i = 0; i < MAX_CLIENTS; i++) {
            const entity = world.createEntity();
            const body = this.bodies.create(i);

            const slot = new PlayerSlot({
                cm: this.cm,
                spawnQ3: this.spawns[i % this.spawns.length]!,
                physics: this.physics,
                moverHost: body.host,
            });

            const state = new NetPlayerState();
            const inventory = new NetInventory();
            const info = new NetPlayerInfo();

            const record: Slot = {
                index: i,
                entity,
                slot,
                body,
                state,
                inventory,
                info,
                peerId: -1,
                bot: null,
                connected: false,
                alive: false,
                respawnIn: -1,
                bleedAccumulator: 0,
                lastFiredFrame: -1,
                mins: new Float64Array(3),
                maxs: new Float64Array(3),
            };

            /*
             A slot nobody is in is parked far below the map, and each one at
             its own spot.

             Every slot has a character body from the first frame, because the
             pool has to exist before anyone connects -- but a body is *solid*,
             and `MAX_CLIENTS` is 16 while `oa_dm1` has nine spawn points, so
             sixteen bodies placed at `spawns[i % spawns.length]` put two
             players' worth of collision on seven of them. Measured before this:
             a joining player was depenetrated 63 units downward on its first
             step, out through the floor, and fell for ever with
             `groundEntityNum` still reporting ENTITYNUM_WORLD -- because
             `MeepMove` was right about standing on something and the something
             was another slot.

             `sync` skips an entry whose closure returns nothing, but that only
             leaves the body wherever it last was; the parking spot is what puts
             it somewhere harmless. Spaced by 64 units so the parked bodies do
             not depenetrate each other either.
            */
            const parked = vec3(record.index * 64, 0, -1e6);
            body.track(() => (record.connected ? record.slot.ps.origin : parked));

            const identity = new NetworkIdentity();
            world.addComponentToEntity(entity, identity);
            world.addComponentToEntity(entity, state);
            world.addComponentToEntity(entity, inventory);
            world.addComponentToEntity(entity, info);

            this.slots.push(record);
            this.slotByEntity.set(entity, record);
            this.weapons.targets.push(this.damageableFor(record));
        }

        for (let i = 0; i < MAX_MISSILES; i++) {
            const entity = world.createEntity();
            const component = new NetMissile();
            world.addComponentToEntity(entity, new NetworkIdentity());
            world.addComponentToEntity(entity, component);
            this.missilePool.push({ entity, component, projectileId: -1 });
        }

        for (const item of this.items.items) {
            const entity = world.createEntity();
            const component = new NetItem();
            component.index = item.index;
            component.present = item.present ? 1 : 0;
            world.addComponentToEntity(entity, new NetworkIdentity());
            world.addComponentToEntity(entity, component);
            this.itemEntities.push({ entity, component });
        }

        /*
         Movers are a pool too, and this host has none: `MoverSystem` needs the
         map's brush entities as kinematic bodies, which `HeadlessPhysics` does
         not build (model 0 only). Step 5 gives the host `PhysicsWorld.addMover`
         and the pool fills; the component and its adapter already exist so that
         the wire format does not change when it does. Recorded rather than
         silently absent -- see GAP-041.
        */

        // Bots take the highest slots, humans the lowest, so a joining human
        // never has to wait for a bot to be moved out of the way.
        const wanted = Math.min(botCount, MAX_CLIENTS - 1, this.spawns.length - 1);
        for (let n = 0; n < wanted; n++) {
            const index = MAX_CLIENTS - 1 - n;
            this.fillWithBot(this.slots[index]!, n);
        }

        this.bodies.sync();
    }

    private fillWithBot(record: Slot, ordinal: number): void {
        const spawnIndex = 1 + (ordinal % Math.max(1, this.spawns.length - 1));

        const bot = new Bot({
            id: record.index,
            name: `bot${ordinal + 1}`,
            character: `bot${ordinal + 1}`,
            cm: this.cm,
            spawnQ3: this.spawns[spawnIndex]!,
            physics: this.physics,
            movers: () => ({ movers: [] }),
            moverHost: record.body?.host ?? { system: this.physics.system, ecd: this.physics.ecd },
            /*
             The third of a bot's three draws, and the last `Math.random` left
             in a networked match: `Bot.random` is the aim error's correlated
             wander and the per-engagement awareness threshold (D-162). Without
             it here the same seed produced a different fight every run --
             measured as a loopback test that asked whether any bot had fired a
             rocket in forty seconds and answered yes about two times in three.
            */
            random: this.random,
        });

        this.bots.spawn(bot, null);

        record.bot = bot;
        record.connected = true;
        record.alive = true;
        record.info.name = bot.name;
        record.info.isBot = 1;
        record.info.character = ordinal + 1;

        record.body?.track(() => (record.connected ? bot.origin : PARKED_BOT));

        this.spawnSlot(record, spawnIndex);
    }

    /* ------------------------------------------------------------------ *
     * The session
     * ------------------------------------------------------------------ */

    private startSession(): void {
        const server = this.session.server;
        if (server === null) throw new Error('Host: session is not in host role');

        server.onLocalSim.add((frame: number) => this.onLocalSim(frame));
    }

    /**
     * The world step, gated to the newest frame.
     *
     * `onLocalSim` fires once per frame in the replay window, oldest first, and
     * a rollback makes that window several frames deep. The world step is not
     * idempotent -- bots think, missiles fly, items respawn -- so it runs only
     * for the newest frame and the older ones get their state back from the
     * action log's own `ReplaceComponent` records. The client inputs for those
     * older frames have already been applied by the time this fires, which is
     * the part that matters: a late command still moves the player it belongs
     * to, it just resolves against a world that has since gone on.
     */
    private onLocalSim(frame: number): void {
        if (frame <= this.simulatedThrough) return;
        this.simulatedThrough = frame;

        this.worldStep(frame);
        this.publish(frame);
        this.dispatchEvents();
    }

    /**
     * Turn the frame's queued `WeaponEvents` into event actions.
     *
     * **Inside `onLocalSim`, because that is the only place the action log is
     * open.** `SimActionExecutor.execute` writes into
     * `ActionLog.current_buffer()` unconditionally and that throws
     * `no frame is open` between ticks, so an event dispatched from the caller
     * after `session.tick` returns is an exception rather than a packet -- which
     * is how the first version of this found out.
     *
     * Dispatching from inside a handler that a rollback re-runs would be the
     * obvious hazard, and the newest-frame gate above is what removes it: this
     * runs exactly once per frame that actually happened. The actions
     * themselves declare no affected components, so the rewind engine never
     * touches them and the replicator sends each one until it is acked.
     */
    private dispatchEvents(): void {
        const events = this.events;

        for (const pending of events.pending) {
            const action = new this.actions.EffectEvent();
            action.kind = pending.kind;
            action.weapon = pending.weapon;
            action.owner = pending.owner;
            action.origin.set(pending.origin);
            action.aux.set(pending.aux);
            action.radius = pending.radius;
            this.session.send(action as never);
            events.dispatched.push({ kind: pending.kind, owner: pending.owner });
        }
        events.pending.length = 0;

        for (const hit of events.hits) {
            const action = new this.actions.HitEvent();
            action.attacker = hit.attacker;
            action.victim = hit.victim;
            action.damage = hit.damage;
            this.session.send(action as never);
        }
        events.hits.length = 0;

        for (const pickup of events.pickups) {
            const action = new this.actions.PickupEvent();
            action.slot = pickup.slot;
            action.item = pickup.item;
            this.session.send(action as never);
        }
        events.pickups.length = 0;
    }

    private worldStep(frame: number): void {
        const dt = SOLVER_DT;
        const msec = frameMsec(frame);

        // 1. Bots. Each fills a `usercmd_t` and runs the same movement a human
        //    does; `BotRuntime` owns the tree and the perception.
        this.bots.update(dt, msec, this.items.items);

        // 2. Projectiles age and the missile world syncs; the contacts that
        //    detonate them arrived from the physics step, which ran first.
        this.weapons.update(dt);

        // 3. Items: one clock, then one touch test per live slot.
        this.items.advance(dt);
        for (const record of this.slots) {
            if (!record.connected || !record.alive) continue;
            for (const pickup of this.items.touch(
                record.slot.ps.origin,
                record.slot.inventory,
                true
            )) {
                this.events.pickups.push({ slot: record.index, item: pickup.item.index });
            }

            record.bleedAccumulator += dt;
            while (record.bleedAccumulator >= 1) {
                record.bleedAccumulator -= 1;
                ItemSystem.tickSecond(record.slot.inventory);
            }
        }

        // 4. Movers: none on this host yet (GAP-041).

        // 5. Mortality and respawn.
        for (const record of this.slots) {
            if (!record.connected) continue;
            this.mortality(record, dt);
        }

        // 6. Every body at this frame's pose, so the next frame's sweeps and
        //    the missiles that fly between them see where people actually are.
        this.bodies.sync();
    }

    private mortality(record: Slot, dt: number): void {
        const health = record.bot === null ? record.slot.inventory.health : record.bot.health;

        if (record.alive && health <= 0) {
            record.alive = false;
            record.respawnIn = RESPAWN_SECONDS;
            record.info.deaths += 1;
            this.raiseDeath(record);
            return;
        }

        if (record.alive) return;

        record.respawnIn -= dt;
        if (record.respawnIn > 0) return;

        this.spawnSlot(record, (this.random() * this.spawns.length) | 0);
    }

    /** `ClientSpawn`: a fresh loadout at a chosen spawn point. */
    private spawnSlot(record: Slot, spawnIndex: number): void {
        const spawn = this.spawns[spawnIndex % this.spawns.length]!;

        if (record.bot !== null) {
            record.bot.respawn(spawn);
        } else {
            const ps = record.slot.ps;
            /*
             `+ 9`, which is `G_SelectSpawnPoint`'s own lift and is not
             optional. `createPmoveHost` applies it when it builds a slot and
             `Bot.respawn` applies it on every respawn; a respawn here that
             wrote the raw point put the player nine units into the floor, and
             the solver's depenetration answered by shoving it **63 units
             downward** on its first step -- out through the world, falling for
             ever with `groundEntityNum` still reporting ENTITYNUM_WORLD,
             because it really was standing on something on the way past.
            */
            const spawnZ = spawn[2]! + 9;

            ps.origin[0] = spawn[0]!;
            ps.origin[1] = spawn[1]!;
            ps.origin[2] = spawnZ;
            ps.velocity[0] = 0;
            ps.velocity[1] = 0;
            ps.velocity[2] = 0;
            ps.groundEntityNum = C.ENTITYNUM_NONE;

            const move = record.slot.moveState;
            if (move !== null) {
                move.origin[0] = spawn[0]!;
                move.origin[1] = spawn[1]!;
                move.origin[2] = spawnZ;
                move.velocity[0] = 0;
                move.velocity[1] = 0;
                move.velocity[2] = 0;
                move.grounded = false;
            }

            const inv = record.slot.inventory;
            inv.health = 125;
            inv.armor = 0;
            inv.maxHealth = 100;
            inv.weapons.clear();
            inv.weapons.add('WP_GAUNTLET');
            inv.weapons.add('WP_MACHINEGUN');
            for (const key of Object.keys(inv.ammo)) delete inv.ammo[key];
            inv.ammo['WP_GAUNTLET'] = -1;
            inv.ammo['WP_MACHINEGUN'] = 100;
            record.slot.weapon = 'WP_MACHINEGUN';
            record.slot.weaponTime = 0;
        }

        record.alive = true;
        record.respawnIn = -1;
        record.bleedAccumulator = 0;
    }

    /* ------------------------------------------------------------------ *
     * Publish: game state becomes replicated components
     * ------------------------------------------------------------------ */

    /**
     * Turn this frame's game state into `ReplaceComponent` actions.
     *
     * Every mutation of a replicated component has to go through an action or a
     * rewind restores a value nobody re-applies -- so the game objects are
     * written into the components here and the session is told, once per changed
     * component, through the `net_mutate_component` event it installs a listener
     * for on every entity carrying a `NetworkIdentity`.
     *
     * Moving things publish every frame whether they changed or not, because
     * `InterpolationLog.interpolate` blends `tick_a` against `tick_b` and a
     * component missing from one of them snaps. Everything else publishes on a
     * change, which `equals` decides.
     */
    private publish(frame: number): void {
        for (const record of this.slots) {
            this.storeSlot(record);
            if (record.connected) {
                this.mutate(record.entity, NetPlayerState);
                this.mutate(record.entity, NetInventory);
            }
            this.mutateIfChanged(record.entity, NetPlayerInfo, record.info, this.infoShadow(record));
        }

        this.publishMissiles();

        for (const entry of this.itemEntities) {
            const item = this.items.items[entry.component.index];
            const present = item !== undefined && item.present ? 1 : 0;
            if (entry.component.present === present) continue;
            entry.component.present = present;
            this.mutate(entry.entity, NetItem);
        }

        this.match.simFrame = frame;
        this.match.timeMs = frameTimeMs(frame);
        if (frame % TICK_HZ === 0) this.mutate(this.matchEntity, NetMatch);
    }

    /** `PlayerSlot.store`, plus the fields only the host knows. */
    private storeSlot(record: Slot): void {
        if (record.bot !== null) {
            this.storeBot(record);
        } else {
            record.slot.store(record.state, record.inventory);
        }
        record.state.connected = record.connected ? 1 : 0;
        record.state.alive = record.alive ? 1 : 0;
    }

    /**
     * A bot drives its own `pmove_t` rather than a `PlayerSlot`, so its state is
     * copied across rather than stored.
     *
     * That asymmetry is deliberate and is the smallest change that makes bots
     * networked: `Bot` is a complete `usercmd_t` producer *and* consumer (D-050),
     * and rebuilding it on top of `PlayerSlot` would be a rewrite of the thing
     * `match.test.ts` measures. What the wire needs is the pose, and the pose is
     * on `bot.ps` exactly as it is on a slot's.
     */
    private storeBot(record: Slot): void {
        const bot = record.bot!;
        const ps = bot.pmove.ps;
        const state = record.state;

        state.origin[0] = ps.origin[0]!;
        state.origin[1] = ps.origin[1]!;
        state.origin[2] = ps.origin[2]!;
        state.velocity[0] = ps.velocity[0]!;
        state.velocity[1] = ps.velocity[1]!;
        state.velocity[2] = ps.velocity[2]!;
        state.viewangles[0] = ps.viewangles[0]!;
        state.viewangles[1] = ps.viewangles[1]!;
        state.viewangles[2] = ps.viewangles[2]!;
        state.pmFlags = ps.pm_flags & 0xffff;
        state.pmTime = ps.pm_time;
        state.groundEntityNum = ps.groundEntityNum;
        state.viewheight = ps.viewheight;
        state.bobCycle = ps.bobCycle;
        state.weapon = weaponIndex(bot.weapon);
        state.weaponTime = 0;
        state.groundNormal[0] = 0;
        state.groundNormal[1] = 0;
        state.groundNormal[2] = 1;
        state.jumpHeld = 0;
        state.ducked = 0;

        record.inventory.health = Math.max(0, Math.round(bot.health));
        record.inventory.armor = Math.max(0, Math.round(bot.armor ?? 0));
        record.inventory.maxHealth = 100;
    }

    private readonly infoShadows = new Map<number, NetPlayerInfo>();

    private infoShadow(record: Slot): NetPlayerInfo {
        let shadow = this.infoShadows.get(record.index);
        if (shadow === undefined) {
            shadow = new NetPlayerInfo();
            // Deliberately different from a fresh `NetPlayerInfo`, so the first
            // publish always fires and a client's INITIAL_SYNC is not the only
            // time it ever hears a name.
            shadow.kills = -1;
            this.infoShadows.set(record.index, shadow);
        }
        return shadow;
    }

    private publishMissiles(): void {
        const live = this.weapons.liveProjectiles;

        // Which pool slots are still flying, and free the ones that are not.
        const seen = new Set<number>();
        for (const projectile of live) seen.add(projectile.id);

        for (const entry of this.missilePool) {
            if (entry.projectileId < 0) continue;
            if (seen.has(entry.projectileId)) continue;

            entry.projectileId = -1;
            if (entry.component.active !== 0) {
                entry.component.active = 0;
                this.mutate(entry.entity, NetMissile);
            }
        }

        for (const projectile of live) {
            let entry = this.missilePool.find((e) => e.projectileId === projectile.id);

            if (entry === undefined) {
                entry = this.missilePool.find((e) => e.projectileId < 0);
                if (entry === undefined) continue; // pool full; the shot is invisible

                entry.projectileId = projectile.id;
                /*
                 The generation counter is what makes a reused slot safe to
                 draw: a client blending between two ticks would otherwise see
                 one rocket teleport across the room when a second flight starts
                 in the slot the first one just left.
                */
                entry.component.generation = (entry.component.generation + 1) & 0xff;
                entry.component.active = 1;
                entry.component.weapon = weaponIndex(projectile.weapon);
                entry.component.owner = projectile.ownerId & 0xff;
            }

            entry.component.origin[0] = projectile.origin[0]!;
            entry.component.origin[1] = projectile.origin[1]!;
            entry.component.origin[2] = projectile.origin[2]!;
            entry.component.velocity[0] = projectile.velocity[0]!;
            entry.component.velocity[1] = projectile.velocity[1]!;
            entry.component.velocity[2] = projectile.velocity[2]!;

            this.mutate(entry.entity, NetMissile);
        }
    }

    /** The one way a replicated component changes on this host. */
    private mutate(entity: number, componentType: Function): void {
        this.world.sendEvent(entity, 'net_mutate_component', { component_type: componentType });
    }

    private mutateIfChanged(
        entity: number,
        componentType: Function,
        live: { equals(other: never): boolean; copy(other: never): unknown },
        shadow: unknown
    ): void {
        if (live.equals(shadow as never)) return;
        (shadow as { copy(other: unknown): unknown }).copy(live);
        this.mutate(entity, componentType);
    }

    /* ------------------------------------------------------------------ *
     * Joining, and the frame
     * ------------------------------------------------------------------ */

    /** The lowest free slot, or -1 when the server is full. */
    lowestFreeSlot(): number {
        for (const record of this.slots) {
            if (!record.connected) return record.index;
        }
        return -1;
    }

    /**
     * Put a peer in a slot. **Before INITIAL_SYNC, which is the host tick after
     * `session.connect`** -- `NetworkSession.#on_identity_attached` decides
     * ownership at attach time and the slot's identity is long since attached,
     * so this writes `owner_peer_id` directly and the engine's own default never
     * applies.
     */
    admit(peerId: number, name: string, character: number): Slot {
        const index = this.lowestFreeSlot();
        if (index < 0) throw new Error('Host.admit: no free slot');

        const record = this.slots[index]!;
        record.peerId = peerId;
        record.connected = true;
        record.info.name = name;
        record.info.character = character;
        record.info.isBot = 0;
        record.info.kills = 0;
        record.info.deaths = 0;

        const identity = this.world.getComponent(record.entity, NetworkIdentity) as
            | NetworkIdentity
            | undefined;
        if (identity !== undefined) identity.owner_peer_id = peerId;

        this.spawnSlot(record, index % this.spawns.length);
        this.storeSlot(record);

        return record;
    }

    /** Free a slot when its peer goes away. */
    release(peerId: number): void {
        for (const record of this.slots) {
            if (record.peerId !== peerId) continue;
            record.peerId = -1;
            record.connected = false;
            record.alive = false;
            record.info.name = '';
            const identity = this.world.getComponent(record.entity, NetworkIdentity) as
                | NetworkIdentity
                | undefined;
            if (identity !== undefined) identity.owner_peer_id = HOST_PEER_ID;
        }
    }

    /**
     * One host frame: the engine's step, then the session's.
     *
     * The engine first because `PhysicsSystem` has to integrate and dispatch its
     * contacts before the world step reads them -- a missile detonates on a
     * `ContactBegin` and the world step is what turns that into damage.
     */
    step(): void {
        this.physics.step(SOLVER_DT);
        this.session.tick(SESSION_TICK_SECONDS);
        this.wallFrame += 1;
    }

    /** The frame a joining client should align to. */
    get currentFrame(): number {
        return this.session.current_frame;
    }

    get wallFrameNumber(): number {
        return this.wallFrame;
    }

    /* ------------------------------------------------------------------ *
     * The action context
     * ------------------------------------------------------------------ */

    private actionContext(): ActionContext {
        const byEntity = this.slotByEntity;

        return {
            simulates: (entity) => {
                const record = byEntity.get(entity);
                return record !== undefined && record.bot === null && record.connected;
            },
            stepSlot: (entity, cmd, frame) => {
                const record = byEntity.get(entity);
                if (record === undefined) return;

                record.slot.load(record.state, record.inventory);
                record.slot.step(
                    cmd,
                    {
                        frame,
                        msec: frameMsec(frame),
                        dt: SOLVER_DT,
                        timeMs: frameTimeMs(frame) + frameMsec(frame),
                    },
                    this.sinkFor(record, frame)
                );
                record.slot.store(record.state, record.inventory);

                /*
                 Q3's entity-order semantics: two humans moving in the same
                 frame see each other at *this* frame's poses, not the previous
                 one's. So the body is re-homed the moment its slot has moved,
                 rather than once for everybody at the end of the world step.
                */
                this.bodies.sync();
            },
            // The host raised these; applying its own echo would double them.
            effect: () => {},
            hit: () => {},
            pickup: () => {},
        };
    }

    /**
     * The sink a slot's step reports into, keyed by frame.
     *
     * `fired` is the only side effect a rollback could repeat: a command
     * replayed for frame F would fire the shot for frame F a second time. The
     * ammunition and the cooldown are *state* and a rewind restores them, so
     * they take care of themselves; the shot does not, and `lastFiredFrame` is
     * what stops it.
     */
    private sinkFor(record: Slot, frame: number): StepSink {
        return {
            fired: (weapon: WeaponId, eye: Vec3Like, angles: ArrayLike<number>) => {
                if (frame <= record.lastFiredFrame) return;
                record.lastFiredFrame = frame;
                this.weapons.fire(
                    weapon,
                    eye,
                    angles,
                    record.index,
                    (this.random() * 0x10000) | 0
                );
            },
            dryFired: () => {},
            landed: () => {},
        };
    }

    /* ------------------------------------------------------------------ *
     * Helpers the bot world and the weapon system reach through
     * ------------------------------------------------------------------ */

    private damageableFor(record: Slot): Damageable {
        const host = this;
        return {
            id: record.index,
            get origin() {
                return record.bot === null ? record.slot.ps.origin : record.bot.origin;
            },
            mins: vec3(-15, -15, -24),
            maxs: vec3(15, 15, 32),
            get health(): number {
                return record.bot === null ? record.slot.inventory.health : record.bot.health;
            },
            set health(value: number) {
                if (record.bot === null) record.slot.inventory.health = value;
                else record.bot.health = value;
            },
            get armor(): number {
                return record.bot === null ? record.slot.inventory.armor : (record.bot.armor ?? 0);
            },
            set armor(value: number) {
                if (record.bot === null) record.slot.inventory.armor = value;
                else record.bot.armor = value;
            },
            get dead(): boolean {
                return !record.alive;
            },
            set dead(_value: boolean) {
                // Derived from health by `mortality`; nothing sets it directly.
            },
        } as unknown as Damageable & { host: Host };
    }

    firstHumanOrigin(): Vec3 {
        for (const record of this.slots) {
            if (record.connected && record.bot === null && record.alive) {
                return record.slot.ps.origin;
            }
        }
        return FAR_AWAY;
    }

    anyHumanAlive(): boolean {
        for (const record of this.slots) {
            if (record.connected && record.bot === null && record.alive) return true;
        }
        return false;
    }

    /** Every effect the host has raised, for the rig and the tests. */
    get weaponEvents(): HostWeaponEvents {
        return this.events;
    }

    private raiseDeath(record: Slot): void {
        this.events.deaths += 1;
        this.events.pending.push({
            kind: EffectKind.Death,
            weapon: 0,
            owner: record.index,
            origin: [
                record.state.origin[0]!,
                record.state.origin[1]!,
                record.state.origin[2]!,
            ],
            aux: [0, 0, 1],
            radius: 0,
        });
    }
}

/** Somewhere no bot will walk to, for a `BotWorld` with nobody in it. */
const FAR_AWAY = vec3(0, 0, -1e6);

/** Where a bot's body sits if its slot is ever freed. */
const PARKED_BOT = vec3(0, 4096, -1e6);

export interface PendingEffect {
    kind: number;
    weapon: number;
    owner: number;
    origin: number[];
    aux: number[];
    radius: number;
}

/**
 * `WeaponEvents`, turned into a queue of wire events.
 *
 * The host raises these inside the world step, which is inside the open action
 * log frame -- so they *could* be dispatched as actions immediately. They are
 * queued instead and drained by the caller after the step, because a rollback
 * re-runs the newest frame's step and an event dispatched from inside it would
 * be dispatched again. The queue is drained once per completed tick, which is
 * once per frame that actually happened.
 */
export class HostWeaponEvents implements WeaponEvents {
    readonly pending: PendingEffect[] = [];

    shots = 0;
    impacts = 0;
    trails = 0;
    explosions = 0;
    damage = 0;
    kills = 0;
    deaths = 0;
    projectiles = 0;

    readonly hits: { attacker: number; victim: number; damage: number }[] = [];
    readonly pickups: { slot: number; item: number }[] = [];

    /**
     * What was actually dispatched this frame, for a harness to read back.
     *
     * Separate from `pending`, which is drained: a test that wanted to know
     * what the host raised would otherwise have to look before the dispatch,
     * which is inside a private handler.
     */
    readonly dispatched: { kind: number; owner: number }[] = [];

    muzzleFlash(
        originQ3: ArrayLike<number>,
        directionQ3: ArrayLike<number>,
        weapon: WeaponId,
        ownerId: number
    ): void {
        this.shots += 1;
        this.pending.push({
            kind: EffectKind.MuzzleFlash,
            weapon: weaponIndex(weapon),
            owner: ownerId & 0xff,
            origin: [originQ3[0]!, originQ3[1]!, originQ3[2]!],
            aux: [directionQ3[0]!, directionQ3[1]!, directionQ3[2]!],
            radius: 0,
        });
    }

    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>, weapon: WeaponId): void {
        this.impacts += 1;
        this.pending.push({
            kind: EffectKind.BulletImpact,
            weapon: weaponIndex(weapon),
            owner: 0xff,
            origin: [originQ3[0]!, originQ3[1]!, originQ3[2]!],
            aux: [normalQ3[0]!, normalQ3[1]!, normalQ3[2]!],
            radius: 0,
        });
    }

    hitscanTrail(
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        weapon: WeaponId,
        ownerId: number
    ): void {
        this.trails += 1;
        this.pending.push({
            kind: EffectKind.HitscanTrail,
            weapon: weaponIndex(weapon),
            owner: ownerId & 0xff,
            origin: [startQ3[0]!, startQ3[1]!, startQ3[2]!],
            aux: [endQ3[0]!, endQ3[1]!, endQ3[2]!],
            radius: 0,
        });
    }

    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        weapon: WeaponId,
        normalQ3?: ArrayLike<number>
    ): void {
        this.explosions += 1;
        this.pending.push({
            kind: EffectKind.Explosion,
            weapon: weaponIndex(weapon),
            owner: 0xff,
            origin: [originQ3[0]!, originQ3[1]!, originQ3[2]!],
            aux: [normalQ3?.[0] ?? 0, normalQ3?.[1] ?? 0, normalQ3?.[2] ?? 1],
            radius: radiusQ3,
        });
    }

    hit(target: Damageable, damage: number): void {
        this.damage += damage;
        if (target.dead) this.kills += 1;
        this.hits.push({ attacker: 0xff, victim: target.id & 0xff, damage: Math.min(255, damage) });
    }

    projectileSpawned(): void {
        this.projectiles += 1;
    }

    projectileGone(): void {}
}
