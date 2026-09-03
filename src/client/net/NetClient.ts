/*
 * NetClient.ts -- the client half, with nothing drawn.
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
 * Everything a joined client does except draw: a `NetworkSession` in client
 * role, one `PlayerSlot` for the local player predicted forward every frame, a
 * pool of entities the host's INITIAL_SYNC lands in, and the reconciliation
 * short-circuit that keeps the whole thing from rewinding once a tick.
 *
 * It takes an input source and an event sink rather than a keyboard and a
 * renderer, so the same class runs under Node in `test/net/rig.ts` and in the
 * browser behind `?join=`. That is not an abstraction for its own sake -- the
 * loopback test is the only place the prediction can be checked *against the
 * host's own numbers*, and a client that needed a canvas could not be in one.
 *
 * **The client creates its own pool and the host's INITIAL_SYNC fills it.**
 * `#apply_initial_sync` creates an entity for any `network_id` it does not
 * know, so strictly the client could start empty -- but then its entity ids
 * would depend on packet order and its physics bodies would be built in a
 * different sequence from the host's, which is the one thing §4.6 asks not to
 * happen. Building the same pool in the same order on both sides makes the
 * slot table's mapping the identity and keeps the two broadphases the same
 * shape.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import { OwnerAwareScope } from '@woosh/meep-engine/src/engine/network/replication/ScopeFilter.js';
import { EntityObserver } from '@woosh/meep-engine/src/engine/ecs/EntityObserver.js';
import { uint8_array_hash } from '@woosh/meep-engine/src/core/collection/array/typed/uint8_array_hash.js';
import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import { BinaryBuffer } from '@woosh/meep-engine/src/core/binary/BinaryBuffer.js';
import type { SimAction } from '@woosh/meep-engine/src/engine/network/sim/SimAction.js';

import type { ClipMap } from '../../q3/cm/ClipMap.ts';
import type { PhysicsTraceBackend } from '../../game/PmoveHost.ts';
import type { MoverHost } from '../MeepMove.ts';
import { CharacterBodies, type BodyDataset, type CharacterSlot } from '../CharacterBody.ts';
import { PlayerSlot, type StepSink } from '../../game/PlayerSlot.ts';
import {
    NetInventory,
    NetItem,
    NetMatch,
    NetMissile,
    NetPlayerInfo,
    NetPlayerState,
} from '../../net/components.ts';
import { NetInventoryAdapter, NetPlayerStateAdapter } from '../../net/adapters.ts';
import type {
    ActionContext,
    EffectEventData,
    HitEventData,
    PickupEventData,
    ProtocolActions,
} from '../../net/actions.ts';
import { registerProtocol } from '../../net/registerProtocol.ts';
import { createSession } from '../../net/session.ts';
import {
    FRAME_CAPACITY,
    HOST_PEER_ID,
    MAX_CLIENTS,
    MAX_MISSILES,
    SESSION_TICK_SECONDS,
    TICK_HZ,
    frameMsec,
    frameTimeMs,
} from '../../net/protocol.ts';
import type { UserCmd } from '../../q3/pmove/types.ts';

/** The solver's step. The same constant the host uses; see §4.6. */
const SOLVER_DT = SESSION_TICK_SECONDS;

/**
 * Where a slot nobody is playing keeps its body, matching `Host.buildPools`.
 *
 * A million units down, and spaced sideways so the parked bodies do not
 * depenetrate each other either. Both numbers are the host's; they are repeated
 * rather than imported because `src/client` must not reach into `src/server`,
 * and `test/net-loopback.test.ts` holds the two to the same value.
 */
const PARKED_SLOT_DEPTH = -1e6;
const PARKED_SLOT_SPACING = 64;

/**
 * What the client is told to do each frame, and what it reports back.
 *
 * The browser fills `sample` from `PlayerController.sampleCommand()`; a test
 * fills it from a script. Everything else is presentation and is optional.
 */
export interface ClientHooks {
    /** This frame's input. Called once per predicted frame, never during replay. */
    sample(frame: number): UserCmd;
    /** A shot the local player predicted. The host's own shot is authoritative. */
    predictedFire?(weapon: string, frame: number): void;
    effect?(event: EffectEventData): void;
    hit?(event: HitEventData): void;
    pickup?(event: PickupEventData): void;
}

/**
 * As much of a physics world as a joined client needs.
 *
 * Structural rather than either concrete class, because both ends of this port
 * hand it something different and neither is wrong: the rig and the host pass
 * `HeadlessPhysics`, the browser passes its `PhysicsWorld`'s system beside the
 * render world's own dataset -- which is the dataset the character bodies have
 * always gone in on that side. The four members here are the whole of what is
 * used: the trace the player's sweeps run on, the system the bodies live in,
 * the dataset their components are registered against, and the ignore set that
 * keeps a character from sweeping against itself.
 */
export interface ClientPhysics extends PhysicsTraceBackend {
    readonly system: MoverHost['system'];
    readonly ecd: BodyDataset;
    readonly traceIgnores: Set<number>;
}

export interface NetClientOptions {
    cm: ClipMap;
    physics: ClientPhysics;
    /** Peer id the host handed out in the hello. */
    peerId: number;
    /** Player slot the host put this client in. */
    slotIndex: number;
    spawnQ3: readonly number[];
    hooks: ClientHooks;
    /** How many item entities the map has; the pool must match the host's. */
    itemCount: number;
    /** Action-log ring depth, in frames. Must match the host's. */
    frameCapacity?: number;
}

/** One remote or local slot, as the client holds it. */
export interface ClientSlot {
    readonly index: number;
    readonly entity: number;
    readonly state: NetPlayerState;
    readonly inventory: NetInventory;
    readonly info: NetPlayerInfo;
    readonly body: CharacterSlot | null;
}

export class NetClient {
    readonly entityManager: EntityManager;
    readonly world: EntityComponentDataset;
    readonly session: NetworkSession;
    readonly actions: ProtocolActions;

    /** The local player's simulation. The only thing this client predicts. */
    readonly slot: PlayerSlot;

    /**
     * The players this client knows about. Not a table with holes in it.
     *
     * Dense and discovered: one entry per player the host has told this client
     * exists, and nothing for an id nobody is using. Look one up by its
     * game-level id with {@link playerById}.
     */
    readonly players: ClientSlot[] = [];
    readonly missiles: { entity: number; component: NetMissile }[] = [];
    readonly items: { entity: number; component: NetItem }[] = [];
    readonly match = new NetMatch();

    readonly peerId: number;
    readonly slotIndex: number;

    /** Counters the HUD and the tests read. */
    reconcileCount = 0;
    replayFrames = 0;
    shortCircuitHits = 0;
    shortCircuitMisses = 0;
    /**
     * The two reasons a short-circuit misses, counted apart.
     *
     * `noRing` is a frame this client never predicted -- the session runs 0 to 3
     * ticks per call under time dilation, so a step that ran none leaves a gap
     * the host still sends AUTH_STATE for. `disagreed` is a real difference
     * between what the host says and what this client computed, and is the only
     * one of the two that means anything is wrong.
     */
    shortCircuitNoRing = 0;
    shortCircuitDisagreed = 0;
    predictedFrames = 0;

    /**
     * Reconciliations the engine gave up on, new in meep 3.15.0.
     *
     * **This is a real loss of replicated state and it used to be silent.**
     * `ServerAuthoritativeClient` rewinds to `server_frame - 1` before applying
     * an AUTH_STATE, and when the action log has already rolled past that frame
     * the rewind throws and the reconciliation is skipped -- taking with it
     * whatever that window carried for every entity *other* than the one the
     * AUTH_STATE names. An owner that publishes on change never sends it again,
     * so it is gone. Until 3.15.0 the engine caught the throw and returned;
     * `onReconcileAbandoned` is the same event with a signal attached.
     *
     * Counted here rather than acted on, because the repair is a
     * `RECOVERY_REQUEST`/`STATE_BURST` round trip this port does not implement
     * (D-167 lists resume and recovery as follow-ups). What it buys today is
     * that the failure is *visible*: measured at 34 over 45 s with six clients
     * on a 150 ms link with 5% loss, and 2 on a loopback. See D-193.
     */
    reconcileAbandoned = 0;

    /**
     * Records that arrived from a peer and were reapplied by a replay.
     *
     * meep 3.15.0's counter for GAP-045's fix doing work: before it, a rewind
     * about one entity discarded every other entity's published state in the
     * window. Non-zero means the repair is running. Measured in the thousands
     * over a 45-second match, which is the scale of what used to be thrown
     * away.
     */
    get replayedArrived(): number {
        return (
            this.session.client as unknown as { replayed_arrived_count?: number }
        ).replayed_arrived_count ?? 0;
    }

    /**
     * The owned slot's bytes at the end of every predicted frame.
     *
     * This is what the AUTH_STATE short-circuit hashes against: when the host
     * says "at frame F your slot was *this*", the ring answers "at frame F I
     * predicted *that*", and equal hashes mean there is nothing to reconcile.
     * Without it the client rewinds and replays its whole lead every single
     * tick, which is the engine's documented default and costs about ten
     * movement steps a frame.
     */
    private readonly ring = new Map<number, number>();

    /**
     * Every slot's body, the local player's included.
     *
     * Public because the application shares them: the browser's
     * `CharacterBodySystem` places its characters from this set, and building a
     * second one on the same physics world would put two boxes on every player.
     */
    readonly bodies: CharacterBodies;
    private readonly hooks: ClientHooks;
    private readonly matchEntity: number;
    private readonly cmScratch: BinaryBuffer;
    private readonly stateAdapter = new NetPlayerStateAdapter();
    private readonly inventoryAdapter = new NetInventoryAdapter();

    /** The frame the sampler was last called for; the ring is written after it. */
    private lastPredicted = -1;

    private constructor(parts: {
        entityManager: EntityManager;
        world: EntityComponentDataset;
        session: NetworkSession;
        bodies: CharacterBodies;
        slot: PlayerSlot;
        hooks: ClientHooks;
        peerId: number;
        slotIndex: number;
        matchEntity: number;
    }) {
        this.entityManager = parts.entityManager;
        this.world = parts.world;
        this.session = parts.session;
        this.bodies = parts.bodies;
        this.slot = parts.slot;
        this.hooks = parts.hooks;
        this.peerId = parts.peerId;
        this.slotIndex = parts.slotIndex;
        this.matchEntity = parts.matchEntity;
        this.actions = null as unknown as ProtocolActions;
        this.cmScratch = new BinaryBuffer();
        this.cmScratch.setCapacity(1024);
    }

    static async create(options: NetClientOptions): Promise<NetClient> {
        const entityManager = new EntityManager();
        const world = new EntityComponentDataset();
        entityManager.attachDataset(world);
        await new Promise<void>((resolve, reject) => {
            entityManager.startup(resolve, reject);
        });

        const bodies = new CharacterBodies(
            { system: options.physics.system, ecd: options.physics.ecd },
            options.physics.ecd,
            options.physics.traceIgnores
        );

        const session = createSession({
            entity_manager: entityManager,
            role: 'client',
            local_peer_id: options.peerId,
            tick_rate_hz: TICK_HZ,
            frame_capacity: options.frameCapacity ?? FRAME_CAPACITY,
            connection_timeout_ms: 0,
            // v1 has no reconnect (D-167); a dropped socket is a return to the
            // menu, and the ladder would otherwise sit there retrying a
            // transport factory nobody supplied.
            reconnect: { enabled: false },
        });

        const matchEntity = world.createEntity();

        const client = new NetClient({
            entityManager,
            world,
            session,
            bodies,
            slot: null as unknown as PlayerSlot,
            hooks: options.hooks,
            peerId: options.peerId,
            slotIndex: options.slotIndex,
            matchEntity,
        });

        (client as { actions: ProtocolActions }).actions = registerProtocol(
            session,
            world,
            client.actionContext()
        );

        session.defineInputSampler((frame: number) => client.onPredict(frame));

        await session.start();

        client.buildPools(options);
        client.wireReconciliation();
        client.wireScope();
        client.wireSyncGate();
        client.watchForPlayers();

        return client;
    }

    /* ------------------------------------------------------------------ *
     * The pool, in the host's own order
     * ------------------------------------------------------------------ */

    /**
     * A `NetworkIdentity` owned by whoever should own it.
     *
     * **Set before the component is attached, and that is the whole of it.**
     * `NetworkSession.#on_identity_attached` fills a *negative* `owner_peer_id`
     * with the local peer's and then decides, once and for ever, whether the
     * entity goes into `#remote_entities` -- the set that gets interpolated at
     * render time and normalized before simulation. INITIAL_SYNC does not carry
     * ownership (`NetworkIdentity`'s adapter is a save-game adapter whose own
     * docblock says the component "doesn't go on the wire"), so a client that
     * left the field at -1 would end up owning every entity in the world.
     *
     * Two things break when it does, and neither announces itself. Nothing is
     * ever interpolated, because `#remote_entities` is empty. And the client's
     * `OwnerAwareScope` filters nothing, so every action the host sent -- which
     * the replicator logs into the *receiver's* action log, by design -- is
     * packed straight back to the host, which applies its own state to itself
     * several frames stale. Measured before the fix: the host's slot teleported
     * 64 units down at the first echo and then fell out of the level, with the
     * client's own numbers arriving as the host's authority. See GAP-040.
     */
    private identityOwnedBy(peerId: number): NetworkIdentity {
        const identity = new NetworkIdentity();
        identity.owner_peer_id = peerId;
        return identity;
    }

    private buildPools(options: NetClientOptions): void {
        const world = this.world;

        world.addComponentToEntity(this.matchEntity, this.identityOwnedBy(HOST_PEER_ID));
        world.addComponentToEntity(this.matchEntity, this.match);

        for (let i = 0; i < MAX_MISSILES; i++) {
            const entity = world.createEntity();
            const component = new NetMissile();
            world.addComponentToEntity(entity, this.identityOwnedBy(HOST_PEER_ID));
            world.addComponentToEntity(entity, component);
            this.missiles.push({ entity, component });
        }

        for (let i = 0; i < options.itemCount; i++) {
            const entity = world.createEntity();
            const component = new NetItem();
            component.index = i;
            world.addComponentToEntity(entity, this.identityOwnedBy(HOST_PEER_ID));
            world.addComponentToEntity(entity, component);
            this.items.push({ entity, component });
        }

        /*
         The local player's own simulation and its body, which are the only two
         things about a player this client builds for itself.

         **They are not the networked entity**, and that separation is what
         makes a dynamic roster possible here. The entity arrives in
         INITIAL_SYNC like every other player's and is bound to this pair by
         {@link discoverPlayers}; the simulation and the collision box have to
         exist earlier than that, because `main.ts` hands `slot` to
         `PlayerController` before the socket is even open. A `PlayerSlot` is
         arithmetic over a `pmove_t` and a `CharacterSlot` is a physics body --
         neither is replicated, so neither has to wait.

         `moverHost` carries the filter that names this body, so the player does
         not sweep against itself.
        */
        this.ownBody = this.bodies.create(options.slotIndex);
        (this as { slot: PlayerSlot }).slot = new PlayerSlot({
            cm: options.cm,
            spawnQ3: options.spawnQ3,
            physics: options.physics,
            moverHost: this.ownBody.host,
        });
        this.ownBody.track(() => this.slot.ps.origin);

        this.bodies.sync();
    }

    /**
     * Stop echoing the host's own actions back at it.
     *
     * The replicator's receive path logs every action it applies into the
     * *local* action log -- correctly, because the client's own rewind needs
     * those records -- and its send path then packs `[last_acked + 1 .. current]`
     * from that same log for every connected peer. With the default
     * `AlwaysRelevantScope` a client therefore returns the host's entire state
     * stream to the host, a few frames stale, and the host applies it.
     *
     * `OwnerAwareScope` is the engine's own answer, documented for the server
     * side; it is exactly as necessary on the client, where it leaves the
     * outbound stream carrying only the one entity this peer owns. It is set
     * after `start()` because it needs the peer's slot table, which does not
     * exist until the orchestrator is built.
     */
    private wireScope(): void {
        const peer = this.session.peer;
        if (peer === null) return;
        (peer as unknown as { replicator: { scope_filter: unknown } }).replicator.scope_filter =
            new OwnerAwareScope({
                world: this.world,
                slot_table: (peer as unknown as { slot_table: unknown }).slot_table,
                identity_class: NetworkIdentity,
            });
    }

    /**
     * Do not predict a frame before the host has said what the world looks like.
     *
     * A session starts with every component at its constructed default, so a
     * client that predicts before INITIAL_SYNC lands is stepping a player at the
     * world origin -- and it does not merely produce a wrong picture, it sends
     * the host commands for frames it simulated against nothing. Measured before
     * the gate: four frames of a player falling from (0, 0, 0).
     *
     * The engine has no "ready" signal of its own; `onInitialSync` is the event,
     * and this handler runs after the session's own because the session's was
     * added first (`Signal` dispatches in subscription order).
     */
    private wireSyncGate(): void {
        const peer = this.session.peer;
        if (peer === null) return;
        (peer as unknown as { onInitialSync: { add(fn: () => void): void } }).onInitialSync.add(
            () => {
                this.synced = true;
            }
        );
    }

    /**
     * Watch for players appearing, which is how this client learns anybody is
     * here at all.
     *
     * **There is no spawn replication (GAP-038)**, so an entity a client has
     * never heard of is one no published component can introduce: the host
     * pushes a fresh INITIAL_SYNC instead, and
     * `NetworkSession.#apply_initial_sync` creates a local entity for every
     * `network_id` it does not recognise. By the time anything downstream looks,
     * the entity exists and its components are attached -- what does not exist
     * is this port's record of it.
     *
     * An `EntityObserver` rather than a scan after each sync, because the
     * dataset has no entity iterator and because this is the engine's own
     * answer: the tuple `[NetPlayerState, NetInventory, NetPlayerInfo]`
     * completing *is* the event "a player exists". It fires for the snapshot
     * that creates them and, with `immediate`, for anything already present.
     *
     * A player is recognised by the components it carries rather than by a
     * message saying so, which needs no agreement beyond the component registry
     * both peers already share.
     */
    private watchForPlayers(): void {
        /*
         The callback's declared type is `(components: Array) => void` and what
         it is actually called with is the components followed by the entity id
         -- `args[observer.componentTypeCount] = entity_id` in the dataset. The
         cast is that discrepancy and nothing else; see REPORT section 4.
        */
        const observer = new EntityObserver(
            [NetPlayerState, NetInventory, NetPlayerInfo],
            ((
                state: NetPlayerState,
                inventory: NetInventory,
                info: NetPlayerInfo,
                entity: number
            ) => this.addDiscovered(entity, state, inventory, info)) as unknown as (
                components: unknown[]
            ) => void,
            (() => {
                /*
                 Nothing: a player leaving is `reapPlayer`'s business, and this
                 fires as a side effect of the removal it has already done.
                */
            }) as unknown as (components: unknown[]) => void
        );

        (
            this.world as unknown as {
                addObserver(o: unknown, immediate?: boolean): boolean;
            }
        ).addObserver(observer, true);
    }

    /**
     * Take up a player the observer has just seen.
     *
     * **Which one is this client's is decided by ownership, not by position.**
     * `Host.admit` writes `owner_peer_id` before the snapshot goes out, so the
     * entity whose identity names this peer is the one the local `PlayerSlot`
     * drives. That is strictly better than the array index it replaces: an
     * index had to be agreed by both peers building the same pool in the same
     * order, and ownership is stated on the wire.
     */
    private addDiscovered(
        entity: number,
        state: NetPlayerState,
        inventory: NetInventory,
        info: NetPlayerInfo
    ): void {
        if (this.playerByEntity.has(entity)) return;

        const identity = this.world.getComponent(entity, NetworkIdentity) as
            | NetworkIdentity
            | undefined;
        const mine = identity !== undefined && identity.owner_peer_id === this.peerId;

        /*
         The local player already has its body; everybody else gets one here. A
         remote player's body is what makes this client's sweeps collide with
         the same boxes the host's did, and it follows the replicated origin
         rather than any local simulation.
        */
        const body = mine ? this.ownBody : this.bodies.create(info.playerId);
        if (!mine) body.track(() => state.origin);

        const record: ClientSlot = { index: info.playerId, entity, state, inventory, info, body };

        this.players.push(record);
        this.playerByEntity.set(entity, record);
        if (mine) this.ownEntity = entity;

        this.bodies.sync();
    }

    /** This client's own networked entity, once the snapshot has named it. */
    private ownEntity = -1;

    /** The body the local player sweeps with. Built before the entity exists. */
    private ownBody!: CharacterSlot;

    /** Every player this client knows about, by entity. */
    private readonly playerByEntity = new Map<number, ClientSlot>();

    /**
     * This client's own player, once the snapshot has named it.
     *
     * Undefined before INITIAL_SYNC, which is a state the prediction already
     * gates on (`onPredict` returns nothing until `synced`) -- so a caller that
     * has to handle it is a caller running earlier than it should.
     */
    get ownPlayer(): ClientSlot | undefined {
        return this.playerByEntity.get(this.ownEntity);
    }

    /** The player with this game-level id, or undefined if nobody has it. */
    playerById(id: number): ClientSlot | undefined {
        for (const record of this.players) {
            if (record.index === id) return record;
        }
        return undefined;
    }

    /** False until the host's INITIAL_SYNC has populated the world. */
    synced = false;

    /* ------------------------------------------------------------------ *
     * Prediction
     * ------------------------------------------------------------------ */

    /**
     * The input sampler, which is also the predict step.
     *
     * `NetworkSession` calls this once per client tick, executes what it hands
     * back, records the bytes for replay, and sends them. So sampling, stepping
     * and sending are one call, and a frame that produced no action never
     * happened as far as the host is concerned.
     *
     * **`synced` is the only gate, and since 3.14.6 it is also the alignment.**
     * There was a second one -- `aligning`, held true while `fastForward` ran
     * the session's counter up to the host's -- and the engine now seeks the
     * counter itself on INITIAL_SYNC, on the same dispatch that sets `synced`.
     * So the frames this returns nothing for are exactly the frames before the
     * snapshot lands, and none of them is tagged with a number the host has
     * already trimmed. See GAP-042 and D-188.
     */
    private onPredict(frame: number): SimAction[] {
        if (!this.synced) return [];

        const owned = this.ownPlayer;
        if (owned === undefined) return [];

        const identity = this.world.getComponent(owned.entity, NetworkIdentity) as
            | NetworkIdentity
            | undefined;
        if (identity === undefined || identity.network_id < 0) return [];

        const cmd = this.hooks.sample(frame);

        const action = new this.actions.UserCmdAction();
        action.set(identity.network_id, frame, cmd);

        this.lastPredicted = frame;
        this.predictedFrames += 1;

        return [action as unknown as SimAction];
    }

    /**
     * `UserCmdAction.apply` on this peer.
     *
     * A client simulates exactly one slot: its own. The host relays every
     * client's commands to every other client, and applying one of those would
     * be running a second, unowned copy of somebody else's player against a
     * world this client is only predicting -- so they are ignored, which is
     * what `simulates` says.
     */
    private actionContext(): ActionContext {
        return {
            simulates: (entity) => entity === this.ownPlayer?.entity,
            stepSlot: (entity, cmd, frame) => {
                const record = this.ownPlayer;
                if (record === undefined || record.entity !== entity) return;

                this.slot.load(record.state, record.inventory);
                this.slot.step(
                    cmd,
                    {
                        frame,
                        msec: frameMsec(frame),
                        dt: SOLVER_DT,
                        timeMs: frameTimeMs(frame) + frameMsec(frame),
                    },
                    this.sink
                );
                this.slot.store(record.state, record.inventory);

                this.ring.set(frame, this.hashOwned(record));
                if (this.predictionTrace !== null) {
                    this.predictionTrace.set(frame, new NetPlayerState().copy(record.state));
                }
                if (this.inventoryTrace !== null) {
                    this.inventoryTrace.set(frame, new NetInventory().copy(record.inventory));
                }
                this.bodies.sync();
            },
            effect: (event) => this.hooks.effect?.(event),
            hit: (event) => this.hooks.hit?.(event),
            pickup: (event) => this.hooks.pickup?.(event),

            /*
             A player has gone, and the entity that was them goes with it.

             The reap is the application's because removal is the one direction
             replication does not go: a pushed INITIAL_SYNC teaches a connected
             client about an entity it has never heard of, and there is no
             packet type that takes one away -- measured on 3.15.0, where the
             client kept an entity the host had destroyed and re-snapshotted
             without. `PlayerLeft` is the host saying which `network_id` is
             gone; destroying the local copy is something this peer is entitled
             to do, because it is this peer's entity.

             Silent for an id this client never heard of, which is the ordinary
             case for somebody who joined and left between two of its snapshots.
            */
            playerLeft: (event) => this.reapPlayer(event.networkId),
        };
    }

    /**
     * Destroy this client's copy of a player who has left.
     *
     * The host names a `network_id` because that is the only name both peers
     * share for an entity; the local one is looked up through the slot table,
     * the same route `OwnerAwareScope` takes.
     *
     * **Never this client's own.** A `PlayerLeft` for the local player would be
     * this client being told it has left, which the host does not say and
     * which would destroy the entity the prediction is driving. Guarded rather
     * than assumed impossible.
     */
    private reapPlayer(networkId: number): void {
        const table = (
            this.session.peer as unknown as {
                slot_table: { entity_for(id: number): number };
            }
        ).slot_table;

        const entity = table.entity_for(networkId);
        if (entity < 0) return;
        if (entity === this.ownEntity) return;

        const record = this.playerByEntity.get(entity);
        if (record === undefined) return;

        this.playerByEntity.delete(entity);
        const at = this.players.indexOf(record);
        if (at >= 0) this.players.splice(at, 1);

        if (record.body !== null) this.bodies.destroy(record.body.entity);
        if (this.world.entityExists(entity)) this.world.removeEntity(entity);
    }

    /**
     * The predicted side effects.
     *
     * A muzzle flash the client plays for itself, once per frame, keyed the way
     * the host keys its own shot -- so a replay that re-runs the frame does not
     * play a second flash. The damage is not predicted at all: a hitscan is
     * resolved where the host has everyone now, and the client finds out through
     * a `HitEvent`.
     */
    private readonly sink: StepSink = {
        fired: (weapon, _eye, _angles, frame) => {
            if (frame <= this.lastFiredFrame) return;
            this.lastFiredFrame = frame;
            this.hooks.predictedFire?.(weapon, frame);
        },
        dryFired: () => {},
        landed: () => {},
    };

    private lastFiredFrame = -1;

    /* ------------------------------------------------------------------ *
     * Reconciliation
     * ------------------------------------------------------------------ */

    /**
     * The short-circuit, which is the difference between a client that rewinds
     * once a tick and one that never rewinds at all.
     *
     * `ServerAuthoritativeClient` reconciles on **every** AUTH_STATE unless both
     * `onComputeExpected` and `onMeasureCurrent` have handlers and their scalars
     * agree within `reconcile_epsilon`. AUTH_STATE arrives once a tick per owned
     * entity, so without this the client rewinds and replays its whole lead
     * sixty times a second for a simulation that already agrees.
     *
     * Expected is the FNV-1a of the host's own bytes for `server_frame`;
     * measured is the ring's hash for that frame, which the predict step wrote.
     * The scalars are hashes rather than positions on purpose: a position
     * comparison would pass a client whose ammunition, cooldown or ground normal
     * had drifted, and those are exactly the fields that drift silently.
     */
    private wireReconciliation(): void {
        const client = this.session.client;
        if (client === null) throw new Error('NetClient: session is not in client role');

        /*
         Resolved per call, not captured here.

         This used to be `const owned = this.ownPlayer` at wiring time, which
         worked while every player had a pre-created entity and stopped the day
         they did not: wiring happens in `create`, discovery happens on
         INITIAL_SYNC, so the captured value was `undefined` for ever. Every
         `onComputeExpected` then threw on `.entity`, `Signal` logged "Failed to
         dispatch handler" and carried on, and the short-circuit silently never
         ran -- the client rewound and replayed its whole lead on every single
         AUTH_STATE, at a measured 1.03 reconciliations per frame against a
         budget of 0.05. A swallowed exception in a handler is worth more
         suspicion than a wrong number.
        */
        client.onComputeExpected.add(
            (serverFrame: number, networkId: number, buffer: BinaryBuffer) => {
                const owned = this.ownPlayer;
                if (owned === undefined) return;

                const identity = this.world.getComponent(owned.entity, NetworkIdentity) as
                    | NetworkIdentity
                    | undefined;
                if (identity === undefined || identity.network_id !== networkId) return;

                /*
                 Peek at the auth payload and put the position back: the
                 orchestrator restores it too, but `onApplyAuthState` reads the
                 same buffer straight after and a handler that consumed it would
                 leave the apply reading a component's worth of somebody else's
                 bytes.
                */
                const start = buffer.position;
                const hash = this.hashAuthPayload(buffer);
                buffer.position = start;

                /*
                 And the ring entry for the *same* frame, stashed here rather
                 than looked up again in `onMeasureCurrent`. The orchestrator
                 fires the two signals back to back with nothing in between and
                 hands the second only a `network_id`, so this is where the
                 frame number is available; two lookups would be two chances to
                 answer about different frames.
                */
                this.expectedHash = hash;
                this.measuredHash = this.ringHash(serverFrame);

                client.set_expected(hash);
            }
        );

        client.onMeasureCurrent.add((networkId: number) => {
            const owned = this.ownPlayer;
            if (owned === undefined) return;

            const identity = this.world.getComponent(owned.entity, NetworkIdentity) as
                | NetworkIdentity
                | undefined;
            if (identity === undefined || identity.network_id !== networkId) return;

            const measured = this.measuredHash;

            /*
             A frame the ring no longer has is not a match and must not be
             reported as one. `NaN` fails `Math.abs(a - b) < epsilon`, which is
             exactly the answer wanted: reconcile, because there is nothing to
             compare against.
            */
            if (Number.isNaN(measured)) {
                this.shortCircuitMisses += 1;
                this.shortCircuitNoRing += 1;
            } else if (measured === this.expectedHash) {
                this.shortCircuitHits += 1;
            } else {
                this.shortCircuitMisses += 1;
                this.shortCircuitDisagreed += 1;
            }

            client.set_measured(measured);
        });

        client.onReconcileComplete.add((_serverFrame: number, replayCount: number) => {
            this.reconcileCount += 1;
            this.replayFrames += replayCount;
        });

        /*
         And the reconciliations that did not complete, which is the half that
         had no signal before 3.15.0. Subscribed even though nothing acts on it,
         because an unobserved counter is how GAP-045 stayed open for three
         releases: the failure this reports is silent by construction, and a
         port that cannot see it happen cannot report it either.
        */
        (
            client as unknown as {
                onReconcileAbandoned?: { add(fn: (frame: number, id: number) => void): void };
            }
        ).onReconcileAbandoned?.add(() => {
            this.reconcileAbandoned += 1;
        });
    }

    /** Carried from `onComputeExpected` to `onMeasureCurrent`; see there. */
    private expectedHash = Number.NaN;
    private measuredHash = Number.NaN;

    private hashAuthPayload(buffer: BinaryBuffer): number {
        /*
         AUTH_STATE concatenates every replicated component in `replicate()`
         order. `NetworkIdentity` is first of all -- varint, uint16, uint8 --
         and is read past rather than hashed: its bytes are the same on both
         sides by construction, so including them could only make two agreeing
         peers disagree. The two after it are `NetPlayerState` and
         `NetInventory`, which are exactly what the prediction owns; the rest of
         the payload belongs to components the host writes and the client never
         predicts, so a difference there is not a reconciliation.
        */
        const scratch = this.cmScratch;
        scratch.position = 0;

        const state = SCRATCH_STATE;
        const inventory = SCRATCH_INVENTORY;

        const start = buffer.position;
        // NetworkIdentity, whose adapter is varint + uint16 + uint8.
        buffer.readUintVar();
        buffer.readUint16();
        buffer.readUint8();
        this.stateAdapter.deserialize(buffer, state);
        this.inventoryAdapter.deserialize(buffer, inventory);
        buffer.position = start;

        this.stateAdapter.serialize(scratch, state);
        this.inventoryAdapter.serialize(scratch, inventory);

        return hashBytes(scratch);
    }

    /** The same hash over the client's own prediction. */
    private hashOwned(record: ClientSlot): number {
        const scratch = this.cmScratch;
        scratch.position = 0;
        this.stateAdapter.serialize(scratch, record.state);
        this.inventoryAdapter.serialize(scratch, record.inventory);
        return hashBytes(scratch);
    }

    /**
     * Where this client predicted its own slot would be, per frame.
     *
     * `null` in the browser, where nothing reads it. A harness sets it to an
     * empty map and then has the only honest comparison there is: the host's
     * authoritative state for frame F against what this client predicted *for
     * frame F*. Comparing the two peers' current state instead measures the
     * prediction lead -- at 320 u/s and a six-frame lead that is 32 units of
     * "divergence" in a simulation that agrees to the last bit, which is how
     * the first version of the loopback test read a fall as a desync.
     */
    predictionTrace: Map<number, NetPlayerState> | null = null;

    /**
     * The other half of the prediction, and the half that is easy to forget.
     *
     * `hashOwned` hashes `NetPlayerState` *and* `NetInventory`, so a harness
     * that traces only the first can watch every visible field agree while the
     * short-circuit misses on every frame -- which is exactly what happened,
     * and cost an afternoon. Traced beside it for the same reason and read the
     * same way. See D-179.
     */
    inventoryTrace: Map<number, NetInventory> | null = null;

    /** Look the ring up for a server frame; NaN when it has aged out. */
    ringHash(frame: number): number {
        const hash = this.ring.get(frame);
        return hash === undefined ? Number.NaN : hash;
    }

    /* ------------------------------------------------------------------ *
     * The frame
     * ------------------------------------------------------------------ */

    /**
     * One client frame: the engine's step, then the session's.
     *
     * The session's `tick` runs 0 to 3 client ticks under time dilation, each
     * one sampling input, predicting and sending; then `normalize_if_dirty`
     * puts every remote component back into canonical form, because the
     * previous frame's render pass left blended bytes in them and the next
     * thing to read them is simulation.
     */
    step(): void {
        this.physicsStep();
        this.session.tick(SESSION_TICK_SECONDS);

        /*
         And back to canonical, because `tick()` ends with the render pass and
         that pass leaves *blended* bytes in every remote component. Anything
         that reads them next is simulation -- a body's tracked origin, a
         mover's position, an item's presence -- and simulation must not read a
         value that was interpolated for a picture.

         The cast is the second instance of the same declaration bug as
         `frame_capacity`: the method is tagged `@private` in its JSDoc, so the
         generated `.d.ts` declares it private, while `NetworkSession`'s own
         docblock and `NETWORK_PLAN.md` §3.3 both name it as the call an
         application makes at exactly this point. See REPORT.md section 4.
        */
        (this.session as unknown as { normalize_if_dirty(): void }).normalize_if_dirty();
        this.trimRing();
    }

    /** Overridden by the rig; the browser drives physics through `EntityManager`. */
    physicsStep: () => void = () => {};

    /**
     * Put every slot's body where its replicated origin now says it is.
     *
     * `stepSlot` already does this after the local player's own prediction, but
     * a remote slot moves without this client stepping anything -- its origin
     * arrives in an AUTH_STATE and changes under the tracked closure with
     * nothing to notice. `NetWorldSystem` calls this once a fixed step, after
     * the session has normalized, which is the point at which every replicated
     * origin is canonical and none of them is a render-time blend.
     */
    syncBodies(): void {
        this.bodies.sync();
    }

    private trimRing(): void {
        const oldest = this.session.current_frame - FRAME_CAPACITY;
        if (oldest < 0) return;
        for (const frame of this.ring.keys()) {
            if (frame < oldest) this.ring.delete(frame);
        }
        // The trace is a diagnostic and is allowed to grow for a whole run;
        // trimming it would be trimming exactly the frames a test compares.

    }

    get currentFrame(): number {
        return this.session.current_frame;
    }

    /** The slot this client is playing. */
    get ownSlot(): ClientSlot {
        return this.ownPlayer!;
    }

}

const SCRATCH_STATE = new NetPlayerState();
const SCRATCH_INVENTORY = new NetInventory();

/**
 * Hash everything written into `buffer` so far.
 *
 * meep's own `uint8_array_hash`, not a hand-written FNV-1a -- which is what was
 * here first, and which is the same mistake as the hand-written mulberry32 that
 * `src/server/random.ts` used to be (D-172). The value is only ever compared
 * against another value from this same function, so any decent mixer would do;
 * the point is that the engine ships one and this port's job is to use it.
 *
 * **Offset zero, deliberately.** `uint8_array_hash(array, offset, length)`'s
 * second loop bounds itself by `length` where it means `offset + length`, so
 * with a non-zero offset it hashes the first `4 - (length & 3)` bytes of the
 * range and silently ignores the rest -- measured: the same eight bytes hash to
 * 134678269 through `offset = 4` and 82109100 through a `subarray`. Passing the
 * buffer's own start is both what this needs and the only argument that is
 * correct. See REPORT.md section 6.
 */
function hashBytes(buffer: BinaryBuffer): number {
    return uint8_array_hash(buffer.raw_bytes, 0, buffer.position);
}
