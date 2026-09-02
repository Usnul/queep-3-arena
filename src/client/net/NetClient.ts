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
import { uint8_array_hash } from '@woosh/meep-engine/src/core/collection/array/typed/uint8_array_hash.js';
import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import { BinaryBuffer } from '@woosh/meep-engine/src/core/binary/BinaryBuffer.js';
import type { SimAction } from '@woosh/meep-engine/src/engine/network/sim/SimAction.js';

import type { ClipMap } from '../../q3/cm/ClipMap.ts';
import type { HeadlessPhysics } from '../../../tools/pipeline/headless-physics.ts';
import { CharacterBodies, type CharacterSlot } from '../CharacterBody.ts';
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

export interface NetClientOptions {
    cm: ClipMap;
    physics: HeadlessPhysics;
    /** Peer id the host handed out in the hello. */
    peerId: number;
    /** Player slot the host put this client in. */
    slotIndex: number;
    spawnQ3: readonly number[];
    hooks: ClientHooks;
    /** How many item entities the map has; the pool must match the host's. */
    itemCount: number;
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

    readonly slots: ClientSlot[] = [];
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

    private readonly bodies: CharacterBodies;
    private readonly hooks: ClientHooks;
    private readonly matchEntity: number;
    private readonly cmScratch: BinaryBuffer;
    private readonly stateAdapter = new NetPlayerStateAdapter();
    private readonly inventoryAdapter = new NetInventoryAdapter();

    /** The frame the sampler was last called for; the ring is written after it. */
    private lastPredicted = -1;

    /** True while fast-forwarding to the host's frame; the sampler stays quiet. */
    aligning = false;

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
            frame_capacity: FRAME_CAPACITY,
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

        for (let i = 0; i < MAX_CLIENTS; i++) {
            const entity = world.createEntity();
            const body = this.bodies.create(i);

            const state = new NetPlayerState();
            const inventory = new NetInventory();
            const info = new NetPlayerInfo();

            world.addComponentToEntity(
                entity,
                this.identityOwnedBy(i === options.slotIndex ? this.peerId : HOST_PEER_ID)
            );
            world.addComponentToEntity(entity, state);
            world.addComponentToEntity(entity, inventory);
            world.addComponentToEntity(entity, info);

            const record: ClientSlot = { index: i, entity, state, inventory, info, body };
            this.slots.push(record);

            /*
             Every slot's body follows its replicated origin, the local one
             included -- for the local one that is its own prediction, which is
             what makes a client's sweeps collide with the same boxes the host's
             did. `NetWorldSystem` in the plan is these two lines and the sync.
            */
            body.track(() =>
                i === this.slotIndex ? this.slot.ps.origin : record.state.origin
            );
        }

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
         The local player's own simulation, built last so its body is the one
         the pool already made for its slot. `moverHost` carries the filter that
         names that body, so the player does not sweep against itself.
        */
        const ownBody = this.slots[this.slotIndex]!.body!;
        (this as { slot: PlayerSlot }).slot = new PlayerSlot({
            cm: options.cm,
            spawnQ3: options.spawnQ3,
            physics: options.physics,
            moverHost: ownBody.host,
        });

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
     */
    private onPredict(frame: number): SimAction[] {
        if (this.aligning) return [];
        if (!this.synced) return [];

        const identity = this.world.getComponent(
            this.slots[this.slotIndex]!.entity,
            NetworkIdentity
        ) as NetworkIdentity | undefined;
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
            simulates: (entity) => entity === this.slots[this.slotIndex]?.entity,
            stepSlot: (entity, cmd, frame) => {
                const record = this.slots[this.slotIndex];
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
                    this.predictionTrace.set(frame, Float32Array.from(record.state.origin));
                }
                this.bodies.sync();
            },
            effect: (event) => this.hooks.effect?.(event),
            hit: (event) => this.hooks.hit?.(event),
            pickup: (event) => this.hooks.pickup?.(event),
        };
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

        const owned = this.slots[this.slotIndex]!;

        client.onComputeExpected.add(
            (serverFrame: number, networkId: number, buffer: BinaryBuffer) => {
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
    predictionTrace: Map<number, Float32Array> | null = null;

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

    private trimRing(): void {
        const oldest = this.session.current_frame - FRAME_CAPACITY;
        if (oldest < 0) return;
        for (const frame of this.ring.keys()) {
            if (frame < oldest) this.ring.delete(frame);
        }
        // The trace is a diagnostic and is allowed to grow for a whole run;
        // trimming it would be trimming exactly the frames a test compares.

    }

    /** Fast-forward the session to a host frame without sending anything. */
    fastForward(target: number): number {
        this.aligning = true;
        let calls = 0;
        const bulk = 8 * SESSION_TICK_SECONDS;
        while (this.session.current_frame < target) {
            this.session.tick(bulk);
            calls += 1;
            if (calls > 1_000_000) break;
        }
        this.aligning = false;
        return calls;
    }

    get currentFrame(): number {
        return this.session.current_frame;
    }

    /** The slot this client is playing. */
    get ownSlot(): ClientSlot {
        return this.slots[this.slotIndex]!;
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
