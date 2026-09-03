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
import { advanceBobCycle, isWalking } from '../game/bobCycle.ts';
import {
    MoverSystem,
    type MoverEvents,
    type TeleportDestination,
} from '../game/Movers.ts';
import { WorldEffects, type EffectTarget } from '../game/WorldEffects.ts';
import { boxTrace, createTrace } from '../q3/cm/trace.ts';
import { vec3, type Vec3, type Vec3Like } from '../q3/math.ts';
import { HeadlessPhysics } from '../../tools/pipeline/headless-physics.ts';
import { ItemSystem, type DropTrace } from '../game/Items.ts';
import { buildWaypoints, linkMapPortals, type WaypointGraph } from '../game/Waypoints.ts';
import { spawnPoints } from '../game/Spawns.ts';
import { Bot } from '../game/Bot.ts';
import { BotRuntime, type BotTarget, type BotWorld } from '../client/Bots.ts';
import { DEFAULT_DIFFICULTY, difficulty } from '../game/Difficulty.ts';
import { CharacterBodies, type CharacterSlot } from '../client/CharacterBody.ts';
import { Missiles } from '../client/Missiles.ts';
import { DamageQueries } from '../client/DamageQueries.ts';
import {
    NO_ATTACKER,
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
    NET_PMF_WALKING,
    weaponIndex,
} from '../net/components.ts';
import {
    EffectKind,
    WORLD_OWNER,
    type ActionContext,
    type ProtocolActions,
} from '../net/actions.ts';
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

/**
 * One entry from the built `scene.json`.
 *
 * The index signature is what makes this assignable to `MoverEntity`, which is
 * `Record<string, unknown>` plus a classname and an origin: `MoverSystem` reads
 * arbitrary keys off a brush entity (`speed`, `lip`, `wait`, `dmg`, `height`)
 * through its own `num`/`str` helpers rather than through a typed shape, because
 * the set of keys is the map's and not the port's.
 */
interface SceneEntity extends Record<string, unknown> {
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
    /**
     * Action-log ring depth, in frames. Defaults to {@link FRAME_CAPACITY}.
     *
     * Tunable because it bounds three horizons at once -- rollback depth,
     * back-fill range and retransmit window -- and the third is the one a slow
     * link exhausts: `Replicator.pack_for_peer` silently credits a frame that
     * has aged out of the ring (`if (!has_frame(frame)) { last_packed = frame;
     * continue; }`), so anything still unacked when it ages out is gone.
     */
    frameCapacity?: number;
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

/**
 * `MoverEvents`, routed to whichever slot is being tested right now.
 *
 * The events fire synchronously from inside `MoverSystem.fire`, which is inside
 * `touch`, which the host calls **once per slot** -- so "the current slot" is a
 * well-defined thing for exactly the length of one call, and `slot` is set
 * immediately before it. One `MoverSystem` and one clock with N recorders is
 * the arrangement the `advance`/`touch` split was made for; N mover systems
 * would give each player their own `nextFire` per trigger, so a pad two players
 * crossed together would fire twice as the same trigger.
 *
 * Sound is not routed anywhere. A teleport and a jump pad both make a noise in
 * Q3 and both are presentation: the joined client's `effect` hook still counts
 * and drops every `EffectEvent` (see `main.ts`), so a teleport sound would be
 * the first transient this port presented over the wire and it belongs with the
 * rest of them rather than ahead of them. D-191 records the shortfall.
 */
class HostMoverEvents implements MoverEvents {
    /** The recorder the next `touch` belongs to, or null between slots. */
    slot: WorldEffects | null = null;

    moverSound(): void {
        // Host-side, and nothing on a headless host listens.
    }

    teleport(destination: TeleportDestination): void {
        this.slot?.teleport(destination.origin, destination.angle);
    }

    hurt(damage: number): void {
        this.slot?.hurt(damage);
    }

    push(velocityQ3: readonly number[]): void {
        this.slot?.push(velocityQ3);
    }
}

/**
 * `EffectTarget` over a host slot, which is `SetClientViewAngle` and a box.
 *
 * `PlayerController` satisfies `EffectTarget` in single-player and a host has no
 * `PlayerController`. Two of the four members are simply forwarded; the other
 * two are the interesting half.
 *
 * **The box comes from `pmove`**, not from a constant, because `PM_CheckDuck`
 * shortens `maxs[2]` from 32 to 16 while crouched and a trigger test against the
 * standing box opens a door you cannot fit through (D-075).
 *
 * **The turn is `SetClientViewAngle`**, which is the one thing a host cannot do
 * by writing `viewangles`: the client owns its aim and would overwrite it on the
 * next command. Q3 writes the *difference* into `delta_angles` --
 * `ANGLE2SHORT(target) - cmd.angles[i]` -- and `PM_UpdateViewAngles` adds that
 * offset to every subsequent command, so the client's own mouse keeps working
 * from the new facing. `deltaAngles` is replicated for exactly this
 * (`NetPlayerState`'s docblock calls it "the host's only way to turn a client"),
 * and until now nothing wrote it.
 */
class SlotEffectTarget implements EffectTarget {
    private readonly slot: PlayerSlot;

    constructor(slot: PlayerSlot) {
        this.slot = slot;
    }

    get ps(): PlayerSlot['ps'] {
        return this.slot.ps;
    }

    get mins(): ArrayLike<number> {
        return this.slot.pmove.mins;
    }

    get maxs(): ArrayLike<number> {
        return this.slot.pmove.maxs;
    }

    setYaw(degrees: number): void {
        const ps = this.slot.ps;
        const cmd = this.slot.pmove.cmd;

        /*
         Yaw only, and pitch and roll levelled, which is `TeleportPlayer`: it
         builds the destination's angles with pitch and roll zero and hands the
         lot to `SetClientViewAngle`. Coming out of a teleporter looking at the
         floor is not a thing Q3 does.
        */
        const shorts = [0, Math.round((degrees * 65536) / 360) & 0xffff, 0];
        for (let i = 0; i < 3; i++) {
            ps.delta_angles[i] = (shorts[i]! - cmd.angles[i]!) | 0;
            ps.viewangles[i] = (shorts[i]! * 360) / 65536;
        }
    }
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

    /**
     * Doors, plats and triggers. One clock; see `HostMoverEvents`.
     *
     * Public because a test needs the trigger bounds to put a player inside
     * one: walking to a jump pad depends on the pathfinding finding it, and a
     * fixture whose subject appears only when the AI cooperates is a fixture
     * that passes by not running (D-187). It is also what a `NetMover` producer
     * will publish from.
     */
    readonly movers: MoverSystem;
    private readonly moverEvents: HostMoverEvents;

    /**
     * One recorder per slot, because the deferred state is per player.
     *
     * `WorldEffects` holds the teleport, push and damage a trigger asked for
     * until the end of the pass -- the events fire from inside the mover
     * iteration and moving a player mid-iteration would have the loop finish
     * against a position that no longer exists. Sharing one across sixteen
     * slots would hand slot 3 the teleport slot 2 stepped into.
     */
    private readonly worldEffects: WorldEffects[] = [];

    /** One `EffectTarget` per slot, built once; see {@link SlotEffectTarget}. */
    private readonly effectTargets: SlotEffectTarget[] = [];

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
        movers: MoverSystem;
        moverEvents: HostMoverEvents;
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
        this.movers = parts.movers;
        this.moverEvents = parts.moverEvents;

        for (let i = 0; i < MAX_CLIENTS; i++) this.worldEffects.push(new WorldEffects());
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

        /*
         Doors, plats and the triggers that drive them.

         **The triggers work here and the movers do not**, and the difference is
         worth being precise about because GAP-041 reads as though it blocked
         both. A mover has to be *solid* -- a kinematic body the player's sweep
         hits and can stand on -- and `HeadlessPhysics` builds BSP model 0 and
         nothing else, so the host has no such body and a door there blocks
         nobody. A trigger is not solid and never moves: `MoverSystem.touch` is
         a box-overlap test against the bounds the BSP submodel table already
         carries, and it needs no physics world at all. So teleporters, jump
         pads and hurt volumes are reachable on a headless host today, and
         `NETWORK_PLAN.md` step 6's "teleporters and pads through
         `SetClientViewAngle` and velocity writes on the host" was never blocked
         on anything. See D-191.

         The doors and plats are spawned and advanced anyway, because their
         state machine is what a `NetMover` producer will publish from on the day
         the host grows bodies, and a `func_door` whose clock has been running
         since the match started is in the right place when that happens. They
         change nothing observable in the meantime -- nothing reads their
         origins and nothing collides with them.
        */
        const moverEvents = new HostMoverEvents();
        const movers = new MoverSystem(moverEvents);
        movers.spawn(scene.entities, scene.submodels);

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
             Every human in the match, which is the whole difference between a
             host and single-player as far as a bot is concerned. With one
             client this returns one entry and the bots behave exactly as they
             do in `match.test.ts`; with two, both get shot at, which was the
             point of the step.
            */
            targets: () => hostRef!.humanTargets(),
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
            frame_capacity: options.frameCapacity ?? FRAME_CAPACITY,
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
            movers,
            moverEvents,
        });
        hostRef = host;
        events.host = host;

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
            this.effectTargets.push(new SlotEffectTarget(slot));
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

        /*
         And their bob cycle, which nothing else advances.

         A bot drives its own `pmove_t` rather than a `PlayerSlot`, so the
         counter `PlayerSlot` keeps for a human is not kept for a bot -- and
         `storeBot` has published `bobCycle` since step 3 with **zero** in it
         every frame. A dead field on the wire is invisible until something
         reads it, and the thing that reads it is a remote client's footsteps
         (D-190). `bots.update` has just consumed each bot's command, so the
         command that produced this frame's motion is the one the cycle is
         advanced by, exactly as `PM_Footsteps` does inside a `pmove`.
        */
        for (const record of this.slots) {
            const bot = record.bot;
            if (bot === null || !record.connected || !record.alive) continue;
            advanceBobCycle(bot.pmove.ps, bot.pmove.cmd, msec);
        }

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

        /*
         4. Movers: one clock, then one trigger pass per live human slot.

         The split is the same as the items' above and for the same arithmetic
         reason -- `advance` per player would run `level.time` sixteen times a
         frame and open every door on the map sixteen times too fast, which is
         what `MoverSystem` separated `advance` from `touch` for.

         **Human slots only, and bots use no trigger on either path.** A bot is
         not a `PlayerSlot`: it has no `pmove.mins`, and its aim is a private
         accumulator rather than `delta_angles`, so `SlotEffectTarget` does not
         fit one. Single-player has the same hole from the other direction --
         `WorldEffectSystem` is handed the player and nothing else -- so bots
         have never ridden a jump pad or been teleported in this port at all.
         Leaving it symmetric is deliberate: a host whose bots take the pads and
         a single-player game whose bots do not would be two different games,
         and the fix belongs in one place for both. D-191 records it, and
         `linkMapPortals` means the *pathing* already knows the routes exist.
        */
        this.movers.advance(dt);

        for (const record of this.slots) {
            if (!record.connected || !record.alive || record.bot !== null) continue;

            const effects = this.worldEffects[record.index]!;
            const target = this.effectTargets[record.index]!;

            /*
             The recorder for this slot, for the length of this call. The mover
             events fire synchronously from inside `touch`, so this is what
             routes a teleport to the player who stepped on it.
            */
            this.moverEvents.slot = effects;
            const result = effects.applyTouch(target, this.movers, true);
            this.moverEvents.slot = null;

            if (result.damage > 0) {
                record.slot.inventory.health -= result.damage;
                /*
                 And the client is told, so it gets the view kick a
                 `trigger_hurt` gives you in Q3 -- `EV_DAMAGE` there, and the
                 same `HitEvent` a rocket raises here. Owner 255 is the world,
                 which is the convention `EffectEventData` already uses.
                */
                this.events.hits.push({
                    attacker: WORLD_OWNER,
                    victim: record.index,
                    damage: result.damage,
                });
            }
        }

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
            this.score(record);
            this.raiseDeath(record);
            return;
        }

        if (record.alive) return;

        record.respawnIn -= dt;
        if (record.respawnIn > 0) return;

        this.spawnSlot(record, (this.random() * this.spawns.length) | 0);
    }

    /**
     * `player_die`'s scoring, which is not simply "the killer gets a point".
     *
     * `g_combat.c` gives the frag to the attacker when it is somebody else,
     * takes one *from the attacker* when a player killed itself, and takes one
     * from the **victim** when there was no attacker at all -- a fall, lava, the
     * world. That last case is why `kills` is an `int16` on the wire rather than
     * an unsigned count: a score in this game can be negative, and a format that
     * could not carry one would quietly clamp a player who kept falling off the
     * map.
     *
     * Teams are not modelled, so `OnSameTeam` collapses into the self case.
     */
    private score(victim: Slot): void {
        const attackerId = this.lastAttacker[victim.index] ?? NO_ATTACKER;
        this.lastAttacker[victim.index] = NO_ATTACKER;

        const attacker = this.slotById(attackerId);

        if (attacker === null) {
            victim.info.kills -= 1;
            return;
        }

        attacker.info.kills += attacker === victim ? -1 : 1;
    }

    /**
     * Remember who last hurt each slot, so `score` can attribute the death.
     *
     * The last hit wins, which is Q3's rule too -- `player_die` is handed the
     * attacker of the blow that took the health below zero, and nothing keeps a
     * tally of who did the other 90 points. Kept per victim rather than passed
     * along, because the death is noticed a step later, in `mortality`.
     */
    creditDamage(victimId: number, attackerId: number): void {
        if (victimId < 0 || victimId >= this.lastAttacker.length) return;
        this.lastAttacker[victimId] = attackerId & 0xff;
    }

    /** The slot a client id names, or null when it names nobody. */
    private slotById(id: number): Slot | null {
        if (id === NO_ATTACKER) return null;
        const record = this.slots[id];
        return record === undefined || !record.connected ? null : record;
    }

    /**
     * Who last damaged each slot. {@link NO_ATTACKER} where nobody has.
     *
     * Reset on death rather than on spawn, so a player who dies twice to the
     * world in a row is scored the same way both times.
     */
    private readonly lastAttacker = new Uint8Array(MAX_CLIENTS).fill(NO_ATTACKER);

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
            this.publishPresence(record);
            this.publishInfo(record);
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
        /*
         A bot never walks -- `Bot.think` writes `cmd.buttons = 0` every frame,
         so the bit is always clear -- and it is written from the command rather
         than hardcoded, because the day a bot learns to sneak this is where it
         would say so.
        */
        state.pmFlags =
            (ps.pm_flags & 0xffff & ~NET_PMF_WALKING) |
            (isWalking(bot.pmove.cmd) ? NET_PMF_WALKING : 0);
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

    /**
     * A slot's state, while somebody is in it -- and once more when they leave.
     *
     * The `if (record.connected)` this replaces published a connected slot every
     * frame and a disconnected one never, which is right for the first half and
     * silently wrong for the second: the component's `connected` flag went to
     * zero locally and **the change was never sent**, so every client in the
     * match kept the leaver's last position, its last pose and a `connected` of
     * one, for ever. A character standing where somebody logged off, with a
     * body still in the broadphase, and nothing to say otherwise. Found by
     * `test/net-robustness.test.ts`; it is exactly the failure the plan's step 8
     * asks about and nothing before that test looked.
     *
     * The parting publish is repeated for the same window `publishInfo` uses,
     * and for the same reason (GAP-045): this is a single edge, there is no
     * second chance at it, and a lost one is permanent.
     */
    private publishPresence(record: Slot): void {
        if (record.connected) {
            this.presenceResends[record.index] = INFO_RESEND_FRAMES;
            this.mutate(record.entity, NetPlayerState);
            this.mutate(record.entity, NetInventory);
            return;
        }

        const left = this.presenceResends[record.index] ?? 0;
        if (left <= 0) return;

        this.presenceResends[record.index] = left - 1;
        this.mutate(record.entity, NetPlayerState);
    }

    /** Frames of parting publish still owed. See {@link publishPresence}. */
    private readonly presenceResends = new Uint8Array(MAX_CLIENTS);

    /**
     * `NetPlayerInfo`, republished for a few frames after it changes.
     *
     * The obvious arrangement -- publish once, when `equals` says something is
     * different -- loses updates, and does so on a **loopback with no loss at
     * all**. The update is not lost on the wire: it arrives, the client applies
     * it, and then a reconciliation about the client's *own* slot rewinds the
     * whole world past the frame it landed in. `RewindEngine.rewind_to` writes
     * every record's prior state back; what follows repairs only the one
     * `network_id` the AUTH_STATE covered and replays only that client's own
     * input, so nothing puts this component back -- and the host, having
     * published on change, never sends it again. GAP-045 has the measurements,
     * the standalone reproduction (`tools/repro/meep-mutate-rewind.mjs`) and the
     * causal control.
     *
     * So the resends below are a **race and not a repair**: they win where most
     * frames carry no rewind, which is why they fix most of it and not all.
     * Publishing unconditionally every frame is not the fix that ships either --
     * this component carries a **name string** and there are sixteen slots,
     * about 320 bytes a frame of nothing changing against a per-frame action
     * budget measured at 940 (D-177) -- and, measured, it does not close the
     * hole where the rewind rate is high enough. The bounded redundancy is the
     * same trade the action stream makes, send it again a few times rather than
     * hope, and it costs nothing at rest.
     */
    private publishInfo(record: Slot): void {
        const shadow = this.infoShadow(record);

        if (!record.info.equals(shadow)) {
            shadow.copy(record.info);
            this.infoResends[record.index] = INFO_RESEND_FRAMES;
        }

        const left = this.infoResends[record.index] ?? 0;
        if (left <= 0) return;

        this.infoResends[record.index] = left - 1;
        this.mutate(record.entity, NetPlayerInfo);
    }

    /** Frames of republishing still owed per slot. See {@link publishInfo}. */
    private readonly infoResends = new Uint8Array(MAX_CLIENTS);

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

    /**
     * Everyone the bots may shoot at: connected, alive, and not a bot.
     *
     * The three conditions are the whole of the policy and there is nowhere
     * else to look for it. `bot === null` is D-055 -- bots never target each
     * other -- expressed as an absence from this list rather than as a check
     * inside the AI, so `BotRuntime` has no notion of what a bot is and cannot
     * grow one by accident. `connected` keeps an empty slot's parked body out
     * of it, and `alive` stops a bot emptying a magazine into a corpse for the
     * two seconds before it respawns.
     *
     * The array is rebuilt each call rather than kept, because `alive` and
     * `connected` both change and a stale list is a bot shooting at somebody
     * who left. One allocation per bot per frame is the cost; it is a
     * sixteen-element array at worst and the alternative is an invalidation
     * rule nobody would remember to update.
     */
    humanTargets(): BotTarget[] {
        const out: BotTarget[] = [];
        for (const record of this.slots) {
            if (!record.connected || record.bot !== null || !record.alive) continue;
            out.push({ originQ3: record.slot.ps.origin, id: record.index });
        }
        return out;
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

/**
 * How many frames a changed `NetPlayerInfo` is republished for.
 *
 * Ten is a sixth of a second, which is long enough to cross any link this port
 * has measured and short enough that the cost never shows up in a bandwidth
 * census. It is a workaround for GAP-045 rather than a tuning knob: if the
 * engine's single-mutation delivery becomes reliable, this becomes one.
 */
const INFO_RESEND_FRAMES = 10;

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
    /**
     * The host, once it exists, so a hit can be scored where it happens.
     *
     * Set rather than injected because the sink is built before the `Host` that
     * owns it -- `WeaponSystem` needs it in its constructor -- which is the same
     * ordering knot `hostRef` unties for the bot world above.
     */
    host: Host | null = null;

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

    hit(target: Damageable, damage: number, attackerId: number): void {
        this.damage += damage;
        if (target.dead) this.kills += 1;

        /*
         The attacker rides the event now instead of a hard-coded 0xff, which
         means a client can draw a kill feed and, more immediately, that the
         host can score. `credit` is what turns the last hit into a frag; it is
         called on every damaging hit rather than only the fatal one, because
         `dead` is set inside `WeaponSystem.damage` and the death is not noticed
         until `mortality` runs at the end of the frame.
        */
        this.host?.creditDamage(target.id, attackerId);

        this.hits.push({
            attacker: attackerId & 0xff,
            victim: target.id & 0xff,
            damage: Math.min(255, damage),
        });
    }

    projectileSpawned(): void {
        this.projectiles += 1;
    }

    projectileGone(): void {}
}
