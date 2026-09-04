/*
 * gap045-measure.ts -- what actually happens to a published-once component,
 * measured in this port rather than argued about.
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
 * GAP-045 says a component published once on change is sometimes never
 * delivered on a loopback. This script does not assume that. It asks four
 * questions, and the third decides whether "delivered" was ever the right word.
 *
 *   1. **The census.** How many slots end a match disagreeing with the host, in
 *      each of three publish regimes: once per change (the defect as first
 *      seen), the shipped ten-frame republish, and unconditionally every frame
 *      (the control that made the symptom go away). The regimes are imposed
 *      from outside by writing `Host.infoResends`, so `Host.ts` is not edited
 *      to measure it.
 *   2. **`NetItem.present`.** The same publish-on-change path, where a lost
 *      update is a gameplay bug and not a cosmetic one. Not previously
 *      measured; REPORT.md GAP-045 says it should be.
 *   3. **Did it arrive?** Per client, per slot, per item: a flag that is
 *      cleared whenever the host's value changes and set whenever a probe finds
 *      the client agreeing with the host. A client that ends up disagreeing
 *      with the flag set **had the value and lost it**; with the flag clear it
 *      never got it. Those are different defects in different parts of the
 *      engine, and the whole report turns on which one this is.
 *   4. **The load.** `net_mutate_component` events per frame by component type,
 *      how many entities are replicated, and how many components each carries.
 *      These are the numbers meep asked for after GAP-043, one gap late.
 *
 * **Where the probes are, and why it matters.** Sampling once a frame is not
 * enough, and the first version of this script was wrong for exactly that
 * reason: the inbound mutation is applied and the reconciliation runs inside
 * the *same* `client.net.step()`, so a value applied and then undone before the
 * step returns is invisible from outside. That version reported zero
 * withdrawals and would have had this report say "never delivered" on no
 * evidence -- the same shape of mistake as D-179 and D-181. So the probes are
 * inside the step: after every inbound frame group is applied
 * (`Replicator.onFrameApplied`), and on both sides of every rewind
 * (`ServerAuthoritativeClient.onBeforeReconcile` / `onReconcileComplete`).
 *
 * Every number is taken at the port's current `TICK_HZ`, which is 30 (D-184).
 * The measurements in REPORT.md GAP-045 were taken at 60 and are not assumed to
 * still hold.
 *
 * Run it with `node tools/repro/gap045-measure.ts`. Prints a report; exits 0
 * whatever it finds, because this is an instrument and not a gate.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';

import { NetRig, type RigClient } from '../../test/net/rig.ts';
import { REPLICATED } from '../../src/net/components.ts';
import { MAX_CLIENTS, TICK_HZ } from '../../src/net/protocol.ts';
import * as C from '../../src/q3/pmove/constants.ts';
import { FORWARDMOVE, RIGHTMOVE, type UserCmd } from '../../src/q3/pmove/types.ts';

/** Seconds of match, matching `net-match.test.ts`. */
const SECONDS = 45;
const FRAMES = SECONDS * TICK_HZ;

/** `usercmd_t.angles` are 16-bit; the same three lines as the net tests. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/**
 * `net-match.test.ts`'s `hunt`, copied rather than imported because a test file
 * is not a module a tool should depend on. Aims at the nearest live bot from
 * replicated state and holds the trigger, walking so that pickups get taken --
 * which matters here, because pickups are what move `NetItem.present`.
 */
function hunt(cmd: UserCmd, frame: number, self: RigClient): void {
    const net = self.net;
    const me = net.ownSlot.state.origin;

    let bestYaw = 0;
    let bestPitch = 0;
    let bestDistance = Infinity;

    for (const slot of net.players) {
        if (slot.index === net.slotIndex) continue;
        if (slot.info.isBot === 0) continue;
        if (slot.state.alive === 0) continue;

        const dx = slot.state.origin[0]! - me[0]!;
        const dy = slot.state.origin[1]! - me[1]!;
        const dz = slot.state.origin[2]! + 16 - (me[2]! + 26);

        const distance = Math.hypot(dx, dy, dz);
        if (distance >= bestDistance) continue;

        bestDistance = distance;
        bestYaw = (Math.atan2(dy, dx) * 180) / Math.PI;
        bestPitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    }

    cmd.angles[0] = angleToShort(bestPitch);
    cmd.angles[1] = angleToShort(bestYaw);
    cmd.moves[FORWARDMOVE] = 96;
    cmd.moves[RIGHTMOVE] = Math.sin(frame / 90) * 80;

    if (bestDistance < Infinity) cmd.buttons |= C.BUTTON_ATTACK;
}

/**
 * How `NetPlayerInfo` is published for a run.
 *
 * `Host.publishInfo` sets `infoResends[i]` to `INFO_RESEND_FRAMES` when `equals`
 * reports a change, then decrements and mutates while it is positive. Writing
 * that array from outside imposes any of the three regimes without touching
 * `Host.ts`:
 *
 *  - `once`: zero the counters *after* each step, so the publish the change
 *    itself triggered is the only one. The defect as GAP-045 first saw it.
 *  - `resend`: leave the counters alone. What ships today.
 *  - `always`: raise the counters *before* each step, so `left > 0` on every
 *    frame whether or not anything changed. The control that made the symptom
 *    disappear.
 */
type Regime = 'once' | 'resend' | 'always';

/** The private field this reaches, named once so the casts stay in one place. */
type HostResends = { infoResends: Uint8Array };

/**
 * One tracked value: what the client says, what the host says, and whether the
 * two have agreed at any probe since the host last changed its mind.
 *
 * That flag is the whole instrument. A high-water mark would do for `kills`,
 * which only ever rises, and gives a **false pass** for `NetItem.present`,
 * which falls -- the first version of this script reported an item the client
 * had never seen taken as "delivered then withdrawn", because the client's
 * high-water of 1 is trivially at or above the host's current 0. Agreement
 * since the last host-side change is the same question asked in a way that
 * does not depend on which direction the value moved.
 */
interface Tracked {
    /** Host value at the last probe, as a comparable string. */
    host: string;
    /** Set at a probe where the client agreed; cleared when the host changes. */
    agreedSinceChange: boolean;
    /** Frame of the host's most recent change, for the timeline. */
    changedAt: number;
}

/** A reconciliation, as its two brackets report it. */
interface Reconcile {
    serverFrame: number;
    /** The `network_id` the AUTH_STATE was about. */
    networkId: number;
    replayed: number;
}

/** A client's copy of a replicated value being moved off the host's by a rewind. */
interface Reversion {
    frame: number;
    client: number;
    /** `slot 13` or `item 7`. */
    what: string;
    /** The clobbered entity's own `network_id`. */
    networkId: number;
    before: string;
    after: string;
    host: string;
    reconcile: Reconcile;
}

interface Disagreement {
    line: string;
    /** True when the client had held the host's current value and lost it. */
    everHeld: boolean;
}

interface RunResult {
    regime: Regime;
    /** Whether the rewind was suppressed for this run. */
    suppressRewind: boolean;
    frames: number;
    /** Slots whose `kills`/`deaths` disagreed with the host at the end. */
    staleInfo: Disagreement[];
    /** Items whose `present` disagreed with the host at the end. */
    staleItems: Disagreement[];
    /** Every value a rewind moved off the host's, mid-step. */
    reversions: Reversion[];
    /** Reconciliations per client. */
    reconciles: number[];
    /** `net_mutate_component` events, by component type name. */
    mutations: Map<string, number>;
    /** `net_mutate_component` events per host frame. */
    perFrame: number[];
}

/**
 * One match, instrumented.
 *
 * @param regime how `NetPlayerInfo` is published
 * @param census whether to walk the world for the entity/component census
 */
async function run(
    regime: Regime,
    { census = false, suppressRewind = false } = {}
): Promise<RunResult> {
    const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 2, seed: 6006 });

    const host = rig.host;
    const resends = (host as unknown as HostResends).infoResends;
    for (const client of rig.clients) client.script = hunt;

    /*
     The causal intervention, and the reason this script can say "because"
     rather than "alongside".

     `ServerAuthoritativeClient.#handle_auth_state` short-circuits the rewind
     when the expected and measured scalars agree within `reconcile_epsilon`.
     Widening that to `Infinity` makes every comparison agree, so no rewind ever
     runs. Nothing else changes: the host publishes the same mutations, the
     transport carries the same bytes, the client applies them the same way.

     This is a diagnostic and not a fix -- a client that never reconciles is a
     client whose prediction is never corrected, and this port needs that
     correction. It is here to answer one question: if the rewinds stop, does
     the staleness stop with them?
    */
    if (suppressRewind) {
        for (const client of rig.clients) {
            const orchestrator = client.net.session.client as unknown as {
                reconcile_epsilon: number;
            } | null;
            if (orchestrator !== null) orchestrator.reconcile_epsilon = Infinity;
        }
    }

    /* ---------------- what the host publishes ---------------- */

    /*
     Wrapping `sendEvent` rather than `Host.mutate`, because `mutate` is private
     and because the event is what the engine actually sees -- if the two ever
     disagreed, the event is the one that counts.
    */
    const mutations = new Map<string, number>();
    const perFrame: number[] = [];
    let frameMutations = 0;
    const world = host.world as unknown as {
        sendEvent(entity: number, name: string, event: unknown): void;
    };
    const realSendEvent = world.sendEvent.bind(world);
    world.sendEvent = (entity: number, name: string, event: unknown): void => {
        if (name === 'net_mutate_component') {
            const type = (event as { component_type?: { typeName?: string; name?: string } })
                .component_type;
            const key = type?.typeName ?? type?.name ?? '(unknown)';
            mutations.set(key, (mutations.get(key) ?? 0) + 1);
            frameMutations += 1;
            if (key === 'NetPlayerInfo') {
                const si = slotOfEntity.get(entity);
                if (si !== undefined) {
                    publishedPerSlot.set(si, (publishedPerSlot.get(si) ?? 0) + 1);
                }
            }
        }
        realSendEvent(entity, name, event);
    };

    /* ---------------- what the clients hold ---------------- */

    /** `kills/deaths` of a slot, as the comparable string the tracker uses. */
    const slotValue = (info: { kills: number; deaths: number }): string =>
        `${info.kills}/${info.deaths}`;

    /** The host's own truth for an item is `ItemSystem`, not its own component. */
    const hostItemPresent = (i: number): string => {
        const item = host.items.items[i];
        return item !== undefined && item.present ? '1' : '0';
    };

    const clients = rig.clients;
    const slotTracks: Tracked[][] = clients.map(() =>
        Array.from({ length: MAX_CLIENTS }, () => ({
            host: '',
            agreedSinceChange: false,
            changedAt: -1,
        }))
    );
    const itemTracks: Tracked[][] = clients.map((c) =>
        c.net.items.map(() => ({ host: '', agreedSinceChange: false, changedAt: -1 }))
    );

    const reversions: Reversion[] = [];
    const reconcileTotals = clients.map(() => 0);
    let currentFrame = 0;

    /*
     Where each slot's `NetPlayerInfo` bytes came from, on client 0.

     Three code paths write that component, and telling them apart is the
     clearest single piece of evidence there is: `ReplaceComponentAction.apply`
     off the action stream, `RewindEngine.#restore_prior_state` undoing one, and
     `onApplyAuthState` deserializing the AUTH_STATE payload. The adapter is the
     one place all three meet, so it is wrapped once and the caller is
     identified by which bracket the call falls inside.
    */
    const provenance = new Map<string, Map<number, number>>();
    let phase = 'action-stream';
    if (census) {
        const registry = clients[0]!.net.session.binary_registry as unknown as {
            getAdapter(name: string): { deserialize(buffer: unknown, value: unknown): void };
        };
        const infoAdapter = registry.getAdapter('NetPlayerInfo');
        const realDeserialize = infoAdapter.deserialize.bind(infoAdapter);
        const slotOfInfo = new Map<unknown, number>();
        // Over the population, not `0..MAX_CLIENTS`; see D-194.
        for (const p of clients[0]!.net.players) slotOfInfo.set(p.info, p.index);

        infoAdapter.deserialize = (buffer: unknown, value: unknown): void => {
            realDeserialize(buffer, value);
            const si = slotOfInfo.get(value);
            if (si === undefined) return;
            let byPhase = provenance.get(phase);
            if (byPhase === undefined) {
                byPhase = new Map();
                provenance.set(phase, byPhase);
            }
            byPhase.set(si, (byPhase.get(si) ?? 0) + 1);
        };

        /*
         The rewind is bracketed by wrapping `rewind_to` rather than by a signal:
         `onApplyAuthState` fires after `NetworkSession`'s own handler has
         already deserialized, so a handler added here would tag the auth-state
         writes as whatever the previous phase was. Wrapping the method is the
         only bracket that closes before the next path opens.
        */
        const orchestrator = clients[0]!.net.session.client as unknown as {
            rewind_engine: { rewind_to(current: number, target: number): void };
            onBeforeReconcile: { add(fn: () => void): void };
            onReconcileComplete: { add(fn: () => void): void };
        };
        const engine = orchestrator.rewind_engine;
        const realRewindTo = engine.rewind_to.bind(engine);
        engine.rewind_to = (current: number, target: number): void => {
            phase = 'rewind';
            try {
                realRewindTo(current, target);
            } finally {
                phase = 'auth-state-apply';
            }
        };
        // A reconcile with nothing to rewind still applies the auth state.
        orchestrator.onBeforeReconcile.add(() => {
            phase = 'auth-state-apply';
        });
        orchestrator.onReconcileComplete.add(() => {
            phase = 'action-stream';
        });
    }

    /** What the host published, per slot, for the provenance table. */
    const publishedPerSlot = new Map<number, number>();
    const slotOfEntity = new Map<number, number>();
    /*
     Over the population rather than over `0..MAX_CLIENTS`: a player exists only
     while somebody is in it (D-194), so a loop to sixteen dereferences absences.
    */
    for (const player of host.players) slotOfEntity.set(player.entity, player.index);

    /** `NetworkIdentity.network_id` of a client-side entity, for attribution. */
    const networkIdOf = (ci: number, entity: number): number => {
        const identity = (
            clients[ci]!.net.world as unknown as {
                getComponent(e: number, k: Function): { network_id?: number } | undefined;
            }
        ).getComponent(entity, NetworkIdentity);
        return identity?.network_id ?? -1;
    };

    /**
     * One probe: for every tracked value, note whether the client agrees with
     * the host right now, and reset the flag if the host has changed its mind
     * since the last probe.
     */
    const probe = (ci: number): void => {
        const client = clients[ci]!;

        for (const hostPlayer of host.players) {
            const si = hostPlayer.index;
            const track = slotTracks[ci]![si]!;
            const hostNow = slotValue(hostPlayer.info);
            if (hostNow !== track.host) {
                track.host = hostNow;
                track.agreedSinceChange = false;
                track.changedAt = currentFrame;
            }
            const seen = client.net.playerById(si);
            if (seen !== undefined && slotValue(seen.info) === hostNow) {
                track.agreedSinceChange = true;
            }
        }

        for (let ii = 0; ii < client.net.items.length; ii++) {
            const track = itemTracks[ci]![ii]!;
            const hostNow = hostItemPresent(ii);
            if (hostNow !== track.host) {
                track.host = hostNow;
                track.agreedSinceChange = false;
                track.changedAt = currentFrame;
            }
            if (String(client.net.items[ii]!.component.present) === hostNow) {
                track.agreedSinceChange = true;
            }
        }
    };

    clients.forEach((client, ci) => {
        const peer = client.net.session.peer as unknown as {
            replicator: {
                onFrameApplied: { add(fn: (peerId: number, frame: number) => void): void };
            };
        };
        // Every inbound frame group, the moment it has been applied.
        peer.replicator.onFrameApplied.add(() => probe(ci));

        const orchestrator = client.net.session.client as unknown as {
            onBeforeReconcile: { add(fn: (serverFrame: number, networkId: number) => void): void };
            onReconcileComplete: { add(fn: (serverFrame: number, replayed: number) => void): void };
        } | null;
        if (orchestrator === null) return;

        let pendingId = -1;
        let beforeSlots = new Map<number, string>();
        let beforeItems: string[] = [];

        orchestrator.onBeforeReconcile.add((_serverFrame, networkId) => {
            pendingId = networkId;
            probe(ci);
            /*
             Keyed by the player's game-level id rather than by array position:
             the roster is a set of players who exist, so position is arrival
             order and means nothing across two samples (D-194).
            */
            beforeSlots = new Map(client.net.players.map((s) => [s.index, slotValue(s.info)]));
            beforeItems = client.net.items.map((e) => String(e.component.present));
        });

        orchestrator.onReconcileComplete.add((serverFrame, replayed) => {
            const reconcile: Reconcile = { serverFrame, networkId: pendingId, replayed };
            reconcileTotals[ci] = (reconcileTotals[ci] ?? 0) + 1;
            pendingId = -1;

            /*
             A reversion is: the client agreed with the host before the rewind,
             and does not after it. Stated that way rather than as "the value
             went down", so it catches `NetItem.present` falling to zero as
             readily as `kills` rising -- the direction is not the point.
            */
            for (const hostPlayer of host.players) {
                const si = hostPlayer.index;
                const was = beforeSlots.get(si);
                if (was === undefined) continue;
                const hostNow = slotValue(hostPlayer.info);
                const mine = client.net.playerById(si);
                if (mine === undefined) continue;
                const now = slotValue(mine.info);
                if (was !== hostNow || now === hostNow) continue;
                reversions.push({
                    frame: currentFrame,
                    client: ci,
                    what: `slot ${si}`,
                    networkId: networkIdOf(ci, mine.entity),
                    before: was,
                    after: now,
                    host: hostNow,
                    reconcile,
                });
            }

            for (let ii = 0; ii < beforeItems.length; ii++) {
                const was = beforeItems[ii];
                if (was === undefined) continue;
                const hostNow = hostItemPresent(ii);
                const now = String(client.net.items[ii]!.component.present);
                if (was !== hostNow || now === hostNow) continue;
                reversions.push({
                    frame: currentFrame,
                    client: ci,
                    what: `item ${ii}`,
                    networkId: networkIdOf(ci, client.net.items[ii]!.entity),
                    before: was,
                    after: now,
                    host: hostNow,
                    reconcile,
                });
            }

            beforeSlots = new Map();
            beforeItems = [];
            probe(ci);
        });
    });

    /* ---------------- the match ---------------- */

    for (let frame = 0; frame < FRAMES; frame++) {
        currentFrame = frame;
        if (regime === 'always') resends.fill(200);
        frameMutations = 0;

        rig.step();

        perFrame.push(frameMutations);
        if (regime === 'once') resends.fill(0);
        for (let ci = 0; ci < clients.length; ci++) probe(ci);
    }

    // A few frames of quiet, so the last publish has landed before comparing --
    // the same settling `net-match.test.ts` does.
    for (let i = 0; i < 8; i++) {
        currentFrame = FRAMES + i;
        if (regime === 'always') resends.fill(200);
        rig.step();
        if (regime === 'once') resends.fill(0);
        for (let ci = 0; ci < clients.length; ci++) probe(ci);
    }

    /* ---------------- what was left ---------------- */

    const staleInfo: Disagreement[] = [];
    const staleItems: Disagreement[] = [];

    clients.forEach((client, ci) => {
        for (const hostPlayer of host.players) {
            const si = hostPlayer.index;
            const theirs = slotValue(hostPlayer.info);
            const seen = client.net.playerById(si);
            const mine = seen === undefined ? '(absent)' : slotValue(seen.info);
            if (mine === theirs) continue;
            staleInfo.push({
                line:
                    `client ${client.net.slotIndex} slot ${si}: ${mine} against the ` +
                    `host's ${theirs} (host last changed it on frame ${slotTracks[ci]![si]!.changedAt})`,
                everHeld: slotTracks[ci]![si]!.agreedSinceChange,
            });
        }

        for (let ii = 0; ii < client.net.items.length; ii++) {
            const theirs = hostItemPresent(ii);
            const mine = String(client.net.items[ii]!.component.present);
            if (mine === theirs) continue;
            staleItems.push({
                line:
                    `client ${client.net.slotIndex} item ${ii}: present=${mine} against ` +
                    `the host's ${theirs} (host last changed it on frame ${itemTracks[ci]![ii]!.changedAt})`,
                everHeld: itemTracks[ci]![ii]!.agreedSinceChange,
            });
        }
    });

    if (census) {
        printCensus(rig, perFrame);
        printProvenance(rig, publishedPerSlot, provenance);
    }

    world.sendEvent = realSendEvent;

    return {
        regime,
        suppressRewind,
        frames: FRAMES,
        staleInfo,
        staleItems,
        reversions,
        reconciles: reconcileTotals,
        mutations,
        perFrame,
    };
}

/**
 * The numbers meep will ask for: what is replicated, and how much of it moves
 * per frame. Counted from the host's live dataset rather than from the
 * constants, because the constants say what was intended.
 */
function printCensus(rig: NetRig, perFrame: number[]): void {
    const host = rig.host;
    const world = host.world as unknown as {
        getComponent(entity: number, klass: Function): unknown;
        entityExists(entity: number): boolean;
    };

    const byCount = new Map<number, number>();
    const byClass = new Map<string, number>();
    let replicated = 0;
    let componentTotal = 0;

    /*
     `NetworkIdentity` is what makes an entity replicated at all -- the engine
     auto-replicates it and it takes type id 0 -- so it is counted alongside the
     seven this port declares. An entity walk rather than a dataset query:
     `EntityComponentDataset` has no public "every entity" iterator, and the
     host's world is a few hundred entities.
    */
    const classes: Function[] = [NetworkIdentity, ...REPLICATED];

    for (let entity = 0; entity < 4096; entity++) {
        if (!world.entityExists(entity)) continue;
        if (world.getComponent(entity, NetworkIdentity) === undefined) continue;
        let carried = 0;
        for (const klass of classes) {
            if (world.getComponent(entity, klass) === undefined) continue;
            carried += 1;
            const name = (klass as { typeName?: string; name: string }).typeName ?? klass.name;
            byClass.set(name, (byClass.get(name) ?? 0) + 1);
        }
        replicated += 1;
        componentTotal += carried;
        byCount.set(carried, (byCount.get(carried) ?? 0) + 1);
    }

    console.log('');
    console.log('--- what is replicated, counted on the host ---');
    console.log(`replicated entities:                  ${replicated}`);
    console.log(`replicated components in total:       ${componentTotal}`);
    console.log(
        `mean components per replicated entity: ${(componentTotal / Math.max(1, replicated)).toFixed(2)}`
    );
    for (const [carried, count] of [...byCount].sort((a, b) => a[0] - b[0])) {
        console.log(
            `  ${count} entit${count === 1 ? 'y' : 'ies'} carrying ${carried} component${carried === 1 ? '' : 's'}`
        );
    }
    console.log('instances by class:');
    for (const [name, count] of [...byClass].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${name.padEnd(18)} ${count}`);
    }

    printDistribution('net_mutate_component events per host frame', perFrame);
}

/**
 * Where each slot's `NetPlayerInfo` came from, on client 0.
 *
 * The asymmetry between the first row and every other row is the finding:
 * the client's own slot is repaired by the AUTH_STATE apply on the very path
 * that clobbers it, because that is the entity the AUTH_STATE is about. Every
 * other slot is clobbered by the same rewind and repaired by nothing.
 */
function printProvenance(
    rig: NetRig,
    published: Map<number, number>,
    provenance: Map<string, Map<number, number>>
): void {
    const client = rig.clients[0]!;
    const own = client.net.slotIndex;

    console.log('');
    console.log(`--- NetPlayerInfo on client ${own}: where each slot's bytes came from ---`);
    console.log('slot  published  action-stream  rewind-undo  auth-state-apply  final vs host');
    for (const hostPlayer of rig.host.players) {
        const si = hostPlayer.index;
        const seen = client.net.playerById(si);
        const theirs = hostPlayer.info;
        const mine = seen?.info ?? theirs;
        const agree =
            seen !== undefined && mine.kills === theirs.kills && mine.deaths === theirs.deaths;
        console.log(
            `${String(si).padStart(4)}${si === own ? '*' : ' '} ` +
                `${String(published.get(si) ?? 0).padStart(9)}  ` +
                `${String(provenance.get('action-stream')?.get(si) ?? 0).padStart(13)}  ` +
                `${String(provenance.get('rewind')?.get(si) ?? 0).padStart(11)}  ` +
                `${String(provenance.get('auth-state-apply')?.get(si) ?? 0).padStart(16)}  ` +
                `${mine.kills}/${mine.deaths} vs ${theirs.kills}/${theirs.deaths}` +
                (agree ? '' : '   <-- STALE')
        );
    }
    console.log(`* this client's own slot -- the only one an AUTH_STATE ever repairs.`);
}

function printDistribution(title: string, samples: number[]): void {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);

    console.log('');
    console.log(`--- ${title} ---`);
    console.log(`mean    ${mean.toFixed(1)}`);
    console.log(`min     ${sorted[0] ?? 0}`);
    console.log(`median  ${at(0.5)}`);
    console.log(`p95     ${at(0.95)}`);
    console.log(`max     ${sorted[sorted.length - 1] ?? 0}`);
}

function summarise(result: RunResult): void {
    const label: Record<Regime, string> = {
        once: 'published once, on change (the defect as first seen)',
        resend: 'republished for INFO_RESEND_FRAMES after a change (what ships)',
        always: 'published unconditionally every frame (the control)',
    };

    const verdict = (d: Disagreement): string =>
        `${d.everHeld ? 'HELD IT THEN LOST IT' : 'NEVER ARRIVED       '} ${d.line}`;

    console.log('');
    console.log(
        `=== ${label[result.regime]}` +
            `${result.suppressRewind ? ', WITH THE REWIND SUPPRESSED' : ''} ===`
    );
    console.log(`frames:                        ${result.frames} at ${TICK_HZ} Hz`);
    console.log(`slots disagreeing at the end:  ${result.staleInfo.length}`);
    for (const d of result.staleInfo) console.log(`    ${verdict(d)}`);
    console.log(`items disagreeing at the end:  ${result.staleItems.length}`);
    for (const d of result.staleItems.slice(0, 10)) console.log(`    ${verdict(d)}`);
    if (result.staleItems.length > 10) {
        console.log(`    ... and ${result.staleItems.length - 10} more`);
    }

    const collateral = result.reversions.filter(
        (r) => r.networkId !== r.reconcile.networkId
    ).length;
    console.log(`values a rewind moved off the host's: ${result.reversions.length}`);
    console.log(
        `  ... where the AUTH_STATE was for a DIFFERENT entity: ${collateral} of ${result.reversions.length}`
    );
    for (const r of result.reversions.slice(0, 8)) {
        console.log(
            `    frame ${r.frame}: client ${r.client} ${r.what} (net id ${r.networkId}) ` +
                `${r.before} -> ${r.after} while the host held ${r.host} ` +
                `[AUTH_STATE for net id ${r.reconcile.networkId} at server_frame ` +
                `${r.reconcile.serverFrame}, ${r.reconcile.replayed} replayed]`
        );
    }
    if (result.reversions.length > 8) {
        console.log(`    ... and ${result.reversions.length - 8} more`);
    }

    console.log(`reconciliations per client:    ${result.reconciles.join(', ')}`);
    console.log('mutations published, by component type:');
    for (const [name, count] of [...result.mutations].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${name.padEnd(16)} ${count}`);
    }
}

/**
 * The four configurations, each in its own process.
 *
 * **Why child processes.** Four matches in one process do not reproduce between
 * invocations, and one match in a fresh process does -- measured, twice each
 * way. The engine's client path reads the wall clock
 * (`NetworkSession.#on_frame_applied` feeds `performance.now()` to
 * `AdaptiveRenderDelay`, and `#render_interpolated_entities` reads it again), so
 * how long a step takes changes what the render blend produces, and a process
 * doing four matches spends different amounts of time in each. Running one
 * configuration per process makes each of them repeatable on its own, which is
 * what a number in a bug report has to be.
 */
const CONFIGURATIONS: { regime: Regime; suppressRewind: boolean }[] = [
    { regime: 'once', suppressRewind: false },
    { regime: 'resend', suppressRewind: false },
    { regime: 'always', suppressRewind: false },
    { regime: 'once', suppressRewind: true },
];

/** One line of the side-by-side table, as a child process reports it. */
interface Row {
    name: string;
    staleSlots: number;
    slotsLost: number;
    staleItems: number;
    itemsLost: number;
    reversions: number;
    collateral: number;
    reconciles: number[];
    mutationsPerFrame: number;
}

function rowOf(result: RunResult): Row {
    const total = [...result.mutations.values()].reduce((a, b) => a + b, 0);
    return {
        name: result.suppressRewind ? `${result.regime} (no rewind)` : result.regime,
        staleSlots: result.staleInfo.length,
        slotsLost: result.staleInfo.filter((d) => d.everHeld).length,
        staleItems: result.staleItems.length,
        itemsLost: result.staleItems.filter((d) => d.everHeld).length,
        reversions: result.reversions.length,
        collateral: result.reversions.filter((r) => r.networkId !== r.reconcile.networkId).length,
        reconciles: result.reconciles,
        mutationsPerFrame: Number((total / result.frames).toFixed(1)),
    };
}

const ROW_MARKER = '#ROW#';

function printTable(rows: Row[]): void {
    console.log('');
    console.log('=== side by side ===');
    console.log(
        'regime            stale slots  held-then-lost  stale items  held-then-lost  ' +
            'reversions  collateral  mutations/frame'
    );
    for (const r of rows) {
        console.log(
            `${r.name.padEnd(17)} ${String(r.staleSlots).padStart(11)} ` +
                `${`${r.slotsLost}/${r.staleSlots}`.padStart(15)} ` +
                `${String(r.staleItems).padStart(12)} ` +
                `${`${r.itemsLost}/${r.staleItems}`.padStart(15)} ` +
                `${String(r.reversions).padStart(11)} ` +
                `${`${r.collateral}/${r.reversions}`.padStart(11)} ` +
                `${r.mutationsPerFrame.toFixed(1).padStart(16)}`
        );
    }
}

/** One configuration, in this process, printing its own report. */
async function child(regime: Regime, suppressRewind: boolean, census: boolean): Promise<void> {
    const result = await run(regime, { census, suppressRewind });
    summarise(result);
    console.log(ROW_MARKER + JSON.stringify(rowOf(result)));
}

/** Every configuration, each in a child process. */
function parent(repeats: number): void {
    console.log(`GAP-045 measurement, at the port's current tick rate of ${TICK_HZ} Hz.`);
    console.log(
        'Two clients, four bots, oa_dm1, 45 s, loopback: no loss, no jitter, no reordering.'
    );
    console.log(`Each configuration runs in its own process; ${repeats} repeat(s) of each.`);

    const self = fileURLToPath(import.meta.url);
    const rows: Row[] = [];

    for (let repeat = 0; repeat < repeats; repeat++) {
        for (const [i, config] of CONFIGURATIONS.entries()) {
            const args = [self, '--regime', config.regime];
            if (config.suppressRewind) args.push('--suppress');
            if (i === 1 && repeat === 0) args.push('--census');

            const child = spawnSync(process.execPath, args, {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            });
            const out = child.stdout ?? '';
            for (const line of out.split(/\r?\n/)) {
                if (line.startsWith(ROW_MARKER)) {
                    rows.push(JSON.parse(line.slice(ROW_MARKER.length)) as Row);
                } else if (line.length > 0) {
                    console.log(line);
                }
            }
            if (child.status !== 0) {
                console.error(child.stderr ?? '(no stderr)');
                throw new Error(`child exited ${child.status}`);
            }
        }
    }

    printTable(rows);

    if (repeats > 1) {
        console.log('');
        console.log('=== spread across repeats, per configuration ===');
        for (const config of CONFIGURATIONS) {
            const name = config.suppressRewind ? `${config.regime} (no rewind)` : config.regime;
            const mine = rows.filter((r) => r.name === name);
            const range = (pick: (r: Row) => number): string => {
                const values = mine.map(pick);
                const lo = Math.min(...values);
                const hi = Math.max(...values);
                return lo === hi ? String(lo) : `${lo}-${hi}`;
            };
            console.log(
                `${name.padEnd(17)} stale slots ${range((r) => r.staleSlots).padStart(5)}   ` +
                    `stale items ${range((r) => r.staleItems).padStart(5)}   ` +
                    `reversions ${range((r) => r.reversions).padStart(6)}   ` +
                    `held-then-lost ${range((r) => r.slotsLost + r.itemsLost).padStart(5)}` +
                    ` of ${range((r) => r.staleSlots + r.staleItems).padStart(5)}`
            );
        }
    }
}

const argv = process.argv.slice(2);
const regimeArg = argv.includes('--regime')
    ? (argv[argv.indexOf('--regime') + 1] as Regime | undefined)
    : undefined;

if (regimeArg !== undefined) {
    await child(regimeArg, argv.includes('--suppress'), argv.includes('--census'));
} else {
    const repeatsArg = argv.includes('--repeat')
        ? Number(argv[argv.indexOf('--repeat') + 1])
        : 1;
    parent(Number.isFinite(repeatsArg) && repeatsArg > 0 ? repeatsArg : 1);
}
