/*
 * PvsScope.ts -- what one client is told about, and what it is not.
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
 * `SV_BuildClientSnapshot`'s relevance test, as meep's `scope_filter`.
 *
 * **`NETWORK_PLAN.md`'s premise here was wrong and this is the correction.**
 * The plan said "meep replicates every changed component to everybody with no
 * per-client baseline and no filtering", and asked whether the engine offered a
 * relevance hook beyond `OwnerAwareScope` before one was built here. It does,
 * and it is fully wired: `NetworkSession` takes a `scope_filter` option,
 * `Replicator.pack_for_peer` consults `is_entity_in_scope(peer_id, network_id)`
 * for every action and drops a packet that ends up holding nothing, and
 * **component mutations are actions** -- `net_mutate_component` becomes a
 * `ReplaceComponentAction` in the action log. So the filter covers the whole of
 * the replication traffic and not just the game's own events. The half of the
 * premise that was right is the baseline: there is no delta compression against
 * each client's acknowledged snapshot, so an in-scope component costs its full
 * bytes every time it changes.
 *
 * **This filter has to do `OwnerAwareScope`'s job as well as its own**, and
 * finding that out is what the measurement below was for. `NetworkSession`
 * installs `scope_filter || new OwnerAwareScope(...)`, so supplying one
 * *replaces* the default rather than adding to it -- and the default is not a
 * nicety. Its own docblock says why: the host must not echo a client-owned
 * entity's actions back to that client, "otherwise the executor would re-apply
 * them on top of the client's prediction", and the authoritative state for
 * those entities goes out-of-band through `send_auth_state` instead. A first
 * version of this class answered the visibility question alone and made the
 * traffic on `am_thornish` **10.2% larger** while culling 0.1% of it, which is
 * the shape of an echo rather than the shape of a filter. So the test is the
 * conjunction: not the recipient's own, **and** visible from where they are.
 *
 * **It is off by default, and the reason is a presentation gap rather than a
 * doubt about the culling.** When a slot leaves a client's PVS its
 * `NetPlayerState` stops arriving, and `NetPresentationSystem` draws any slot
 * whose replicated `connected` is set -- so a culled player freezes mid-stride
 * instead of disappearing. Q3 does not have this problem because an entity
 * absent from a snapshot is absent from `cg_entities` and is not drawn.
 * Fixing it means the client knowing that a slot's state is stale, which
 * `NetPlayerState` carries no way to say. See D-192.
 */

import type { ClipMap } from '../q3/cm/ClipMap.ts';
import { clusterAt, clusterVisible, type Visibility } from '../q3/cm/pvs.ts';

/** What the filter needs to know about the host's roster. */
export interface ScopeRoster {
    /** The slot a peer is playing, or -1 for a peer with no slot. */
    slotForPeer(peerId: number): number;
    /**
     * The peer that owns `networkId`, or -1 for the host's own things.
     *
     * `OwnerAwareScope`'s question, asked through the roster so this class
     * needs no `ReplicationSlotTable` of its own -- which it could not have,
     * because `scope_filter` is a constructor option and the slot table does
     * not exist until `session.start()`.
     */
    ownerOfNetworkId(networkId: number): number;
    /** Where a slot's eyes are, in Q3 units, or null for an empty slot. */
    originOfSlot(slot: number): ArrayLike<number> | null;
    /**
     * What `network_id` refers to: a slot, a missile, an item, or the match.
     *
     * Returned as a point rather than as a kind, because that is all the test
     * needs -- and null means "always relevant", which is the answer for the
     * match entity and for anything whose position is not meaningful.
     */
    originOfNetworkId(networkId: number): ArrayLike<number> | null;
}

export class PvsScope {
    private readonly cm: ClipMap;
    private readonly vis: Visibility;
    private readonly roster: ScopeRoster;

    /** Culled and kept, since the host started. Read by the bandwidth census. */
    culled = 0;
    kept = 0;
    /** Of the culled, the ones the owner rule alone would have caught. */
    culledAsOwn = 0;

    /**
     * The cluster each peer's own slot is in, recomputed once a frame.
     *
     * `pack_for_peer` asks about every action for a peer in one go, and
     * `clusterAt` is a BSP descent -- 121 clusters and a few hundred nodes on
     * `oa_dm1`, so about ten plane tests. Doing it per action rather than per
     * peer per frame is the difference between a filter that saves bandwidth
     * and one that spends the CPU the bandwidth was for, which matters because
     * REPORT section 5's other table is about host CPU growing superlinearly.
     */
    private readonly clusterForPeer = new Map<number, number>();

    constructor(options: { cm: ClipMap; visibility: Visibility; roster: ScopeRoster }) {
        this.cm = options.cm;
        this.vis = options.visibility;
        this.roster = options.roster;
    }

    /** Call once per host frame, before the packing pass. */
    beginFrame(peers: readonly number[]): void {
        this.clusterForPeer.clear();

        for (const peer of peers) {
            const slot = this.roster.slotForPeer(peer);
            if (slot < 0) continue;

            const origin = this.roster.originOfSlot(slot);
            if (origin === null) continue;

            this.clusterForPeer.set(
                peer,
                clusterAt(this.cm, origin[0]!, origin[1]!, origin[2]!)
            );
        }
    }

    /**
     * meep's `scope_filter` contract.
     *
     * **A peer with no slot, and an entity with no position, are both always in
     * scope.** The first is a peer mid-join whose slot is not assigned yet, and
     * sending it everything is what makes its INITIAL_SYNC complete; the second
     * is the match entity, whose frag limit is not somewhere in the level.
     * Both fail open, which is the direction that keeps the game correct: a
     * filter that guesses "not relevant" produces a player who is invisible.
     */
    is_entity_in_scope(peerId: number, networkId: number): boolean {
        /*
         `OwnerAwareScope`'s rule, first and unconditionally: a client's own
         entity never goes back to it over the action stream, whether or not it
         can see itself. Counted separately so the visibility figure the census
         reports is the visibility figure and not this plus that.
        */
        if (this.roster.ownerOfNetworkId(networkId) === peerId) {
            this.culled += 1;
            this.culledAsOwn += 1;
            return false;
        }

        const from = this.clusterForPeer.get(peerId);
        if (from === undefined) {
            this.kept += 1;
            return true;
        }

        const to = this.roster.originOfNetworkId(networkId);
        if (to === null) {
            this.kept += 1;
            return true;
        }

        const cluster = clusterAt(this.cm, to[0]!, to[1]!, to[2]!);
        const visible = clusterVisible(this.vis, from, cluster);

        if (visible) this.kept += 1;
        else this.culled += 1;

        return visible;
    }

    /** Fraction of relevance questions answered "no". Zero before any traffic. */
    get culledFraction(): number {
        const total = this.culled + this.kept;
        return total === 0 ? 0 : this.culled / total;
    }

    /** The same, counting only the ones visibility decided. */
    get culledByVisibilityFraction(): number {
        const total = this.culled + this.kept;
        return total === 0 ? 0 : (this.culled - this.culledAsOwn) / total;
    }

    reset(): void {
        this.culled = 0;
        this.kept = 0;
        this.culledAsOwn = 0;
    }
}
