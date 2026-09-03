/*
 * net-relevance.test.ts -- what culling to the PVS would save, measured.
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
 * REPORT section 5 says the same thing from two directions: downstream is
 * 45.8 KB/s per client with six clients and four bots, against a 48 KB/s
 * target, and host CPU grows superlinearly -- 184 µs of marginal cost per
 * client from zero to four and 408 from four to six. Sixteen slots, which the
 * protocol already sizes for, does not fit a 16.6 ms frame. Both tables point
 * at the same missing feature, which is that a client is told about everything.
 *
 * `NETWORK_PLAN.md` asked whether meep offers a relevance hook before one was
 * built here. **It does, and the plan's description of the problem was half
 * wrong**, which is the first thing this file establishes:
 *
 *   - `NetworkSession` takes a `scope_filter`; `Replicator.pack_for_peer`
 *     consults `is_entity_in_scope(peer_id, network_id)` for every action and
 *     writes no packet at all for a peer with nothing in scope. The host
 *     defaults to `OwnerAwareScope`, which answers the narrower question of
 *     whether a client is being sent its own predicted entity back.
 *   - **Component mutations are actions.** `net_mutate_component` becomes a
 *     `ReplaceComponentAction` in the action log, so the filter covers the
 *     whole of the replication traffic rather than only the game's own events.
 *     "No filtering" was wrong.
 *   - **"No per-client baseline" was right.** There is no delta compression
 *     against each client's acknowledged snapshot, so an in-scope component
 *     costs its full bytes every time it changes. Culling removes entities;
 *     it does not make the ones that stay cheaper.
 *
 * So the question is not "can it be done" but "how much is there to win on
 * these maps", and that is a measurement rather than an argument. The answer
 * is **a great deal on one map and nothing at all on another**, which is not
 * what either guess going in would have said:
 *
 *   | map | clusters | pairs visible | KB/s per client, off -> on | saved |
 *   |---|---:|---:|---:|---:|
 *   | `oa_dm1` | 422 | 22% | **42.9 -> 19.3** | **55%** |
 *   | `am_thornish` | 72 | 76% | 41.0 -> 41.0 | 0.1% |
 *
 * `am_thornish` is four alcoves around one hall and compiles to **72** clusters
 * that mostly see each other, so there is nothing to remove; `oa_dm1` is
 * **422** clusters at 56 bytes each and a player can see about a fifth of them.
 * Same netcode, same six paths, same seed. So the feature's value is a property
 * of the **map** rather than of the netcode, and a port that ships both needs
 * the measurement per map rather than a number in a report. That is what this
 * file is for.
 *
 * The packet *count* falls with it -- 14,400 to 10,800 on `oa_dm1`, because a
 * peer with nothing in scope for a frame gets no packet at all -- which is the
 * other table's currency: a quarter fewer packets to pack is host CPU as well
 * as bandwidth.
 */

import { describe, expect, it } from 'vitest';

import { NetRig } from './net/rig.ts';
import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { clusterAt, clusterVisible, readVisibility } from '../src/q3/cm/pvs.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import { TICK_HZ } from '../src/net/protocol.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUILT = join(process.cwd(), 'assets', 'built');

function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

function circleWalk(cmd: { angles: Int16Array; moves: Int8Array }, frame: number): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

/** The visibility lump of a built map, read the way the host reads it. */
function visibilityOf(map: string) {
    const raw = readFileSync(join(BUILT, map, 'collision.bsp'));
    const bsp = new BspFile(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        map
    );
    return readVisibility(bsp.visibility);
}

describe('the visibility data these maps actually carry', () => {
    it('is present in the collision BSP, which is what makes any of this possible', () => {
        const rows: string[] = [];

        for (const map of ['oa_dm1', 'oa_dm4', 'am_thornish']) {
            const vis = visibilityOf(map);

            /*
             How much of the level an average cluster can see. This is the
             number that decides whether culling is worth anything: a Q3
             deathmatch arena is one big room with alcoves as often as it is a
             warren, and a PVS that answers "yes" to 90% of pairs saves 10%.
            */
            let visiblePairs = 0;
            for (let a = 0; a < vis.numClusters; a++) {
                for (let b = 0; b < vis.numClusters; b++) {
                    if (clusterVisible(vis, a, b)) visiblePairs += 1;
                }
            }
            const total = vis.numClusters * vis.numClusters;

            rows.push(
                `${map}: ${vis.numClusters} clusters, ${vis.clusterBytes} B each, ` +
                    `${((100 * visiblePairs) / Math.max(1, total)).toFixed(0)}% of cluster ` +
                    `pairs mutually visible`
            );

            expect(vis.numClusters, `${map} has no visibility lump`).toBeGreaterThan(0);
            expect(vis.clusterBytes * 8).toBeGreaterThanOrEqual(vis.numClusters);
        }

        // eslint-disable-next-line no-console
        console.log('[net-relevance] ' + rows.join('\n[net-relevance] '));
    });

    it('puts a player in a cluster, and the same player in the same cluster twice', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 1,
            seed: 23,
            warmup: 40,
        });

        const vis = visibilityOf('oa_dm1');
        const seen = new Set<number>();

        rig.step(60);

        for (let n = 0; n < 300; n++) {
            rig.step(1);
            for (const record of rig.host.players) {
                if (!record.connected) continue;
                const o = record.state.origin;
                seen.add(clusterAt(rig.host.cm, o[0]!, o[1]!, o[2]!));
            }
        }

        // eslint-disable-next-line no-console
        console.log(
            `[net-relevance] five players over ten seconds occupied ${seen.size} of ` +
                `${vis.numClusters} clusters: ${[...seen].sort((a, b) => a - b).join(', ')}`
        );

        /*
         Two properties, and the second is the one that catches a broken tree
         descent: every cluster a player is in is a real cluster, and the
         players between them are in more than one -- a descent that always
         returned the same leaf would satisfy the first and not the second.
        */
        for (const cluster of seen) {
            expect(cluster).toBeLessThan(vis.numClusters);
            expect(cluster).toBeGreaterThanOrEqual(-1);
        }
        expect(seen.size, 'every player is in the same cluster, which is a broken descent').
            toBeGreaterThan(1);
    }, 120_000);
});

/**
 * Host-to-client bytes over one run, and how many the filter answered "no" to.
 *
 * The byte count is the one that matters and the question count is not a proxy
 * for it: actions differ in size, a packet that ends up empty is not sent at
 * all so its header goes too, and the channel's own 9 bytes ride on every
 * packet that *is* sent. So both are measured and both are printed.
 */
async function run(
    map: string,
    culling: boolean
): Promise<{ bytes: number; packets: number; culled: number; own: number; asked: number }> {
    const rig = await NetRig.create({
        map,
        bots: 4,
        clients: 6,
        seed: 23,
        warmup: 40,
        pvsCulling: culling,
    });

    for (const client of rig.clients) client.script = circleWalk;

    /*
     Every host-side transport, because the interesting total is what the host
     sends to all six clients rather than to one -- REPORT section 5's figure
     is per client and the saving is not uniform across them.
    */
    let bytes = 0;
    let packets = 0;
    let counting = false;

    for (const raw of rig.rawHostTransports) {
        const side = raw as { send(b: Uint8Array, length: number): number };
        const original = side.send.bind(side);
        side.send = (b: Uint8Array, length: number): number => {
            if (counting) {
                bytes += length;
                packets += 1;
            }
            return original(b, length);
        };
    }

    // Past the join, then a measured stretch.
    rig.step(TICK_HZ * 4);
    rig.host.scope?.reset();
    counting = true;
    rig.step(TICK_HZ * 20);
    counting = false;

    return {
        bytes,
        packets,
        culled: rig.host.scope?.culled ?? 0,
        own: rig.host.scope?.culledAsOwn ?? 0,
        asked: (rig.host.scope?.culled ?? 0) + (rig.host.scope?.kept ?? 0),
    };
}

describe('culling to the PVS, on the maps this port ships', () => {
    it('halves the downstream on oa_dm1, which is the map REPORT section 5 was taken on', async () => {
        const off = await run('oa_dm1', false);
        const on = await run('oa_dm1', true);

        const saved = 1 - on.bytes / off.bytes;
        const perClientOff = off.bytes / 6 / 20 / 1024;
        const perClientOn = on.bytes / 6 / 20 / 1024;

        // eslint-disable-next-line no-console
        console.log(
            `[net-relevance] oa_dm1, 6 clients + 4 bots, 20 s\n` +
                `[net-relevance]   off: ${(off.bytes / 1024).toFixed(0)} KB in ` +
                `${off.packets} packets -> ${perClientOff.toFixed(1)} KB/s per client\n` +
                `[net-relevance]   on:  ${(on.bytes / 1024).toFixed(0)} KB in ` +
                `${on.packets} packets -> ${perClientOn.toFixed(1)} KB/s per client\n` +
                `[net-relevance]   ${(100 * saved).toFixed(1)}% of the bytes saved; ` +
                `${on.culled} of ${on.asked} questions culled -- ${on.own} by the owner rule, ` +
                `${on.culled - on.own} by visibility`
        );

        /*
         **The result.** 42.9 KB/s per client becomes **19.3**, which is 55% of
         the bytes and a quarter of the packets: 65,935 of the 112,974 relevance
         questions are answered "not visible", against 14,410 the owner rule
         catches on its own. That is the feature both of REPORT section 5's
         tables were pointing at, and on this map it is worth what they implied.

         For scale, section 5's own figure is 45.8 KB/s where the baseline here
         is 42.9 -- a different window and a different script, not a
         disagreement, and the ratio is what this test is about.

         Asserted as a floor rather than a value: the exact figure is this map,
         these six paths and this seed, and pinning it would make a bot taking a
         different corridor a test failure. What is held is that the filter is
         doing substantial work, because a regression to nil is silent
         otherwise -- and that the *visibility* half is doing it, not the owner
         rule, which is the assertion a first version of this class would have
         failed.
        */
        expect(
            (on.culled - on.own) / Math.max(1, on.asked),
            'visibility stopped culling anything on oa_dm1'
        ).toBeGreaterThan(0.2);

        expect(saved, 'culling stopped saving bytes on oa_dm1').toBeGreaterThan(0.25);

        /*
         And the match still works with the filter in place, which is the part
         that would break first.
        */
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 6,
            seed: 23,
            warmup: 40,
            pvsCulling: true,
        });
        for (const client of rig.clients) client.script = circleWalk;
        rig.step(TICK_HZ * 12);

        expect(rig.host.session.server!.pending_dropped_count()).toBe(0);
        for (const record of rig.host.players) {
            for (const v of record.state.origin) expect(Number.isFinite(v)).toBe(true);
        }
        for (const client of rig.clients) {
            expect(client.net.synced, 'a client stopped being synced under culling').toBe(true);
            expect(client.net.predictedFrames).toBeGreaterThan(TICK_HZ * 4);
        }
    }, 300_000);

    it('saves nothing on am_thornish, which makes this a fact about maps', async () => {
        /*
         The contrast, and the reason the conclusion is not "culling works".
         `am_thornish` is four corner alcoves around one hall and compiles to
         **72** clusters, 76% of whose pairs are mutually visible -- so a player
         can see most of the level and there is nothing to remove. Same netcode,
         same six paths, same seed.
        */
        const off = await run('am_thornish', false);
        const on = await run('am_thornish', true);

        const saved = 1 - on.bytes / off.bytes;

        // eslint-disable-next-line no-console
        console.log(
            `[net-relevance] am_thornish, 6 clients + 4 bots, 20 s: ` +
                `${(off.bytes / 1024).toFixed(0)} KB off, ${(on.bytes / 1024).toFixed(0)} KB on ` +
                `(${(100 * saved).toFixed(1)}% saved); ${on.culled} of ${on.asked} culled -- ` +
                `${on.own} by the owner rule, ${on.culled - on.own} by visibility`
        );

        /*
         **Fifty-two.** Out of 97,320 questions, visibility answers "no" fifty-two
         times on this map, and the traffic is 41.0 KB/s per client either way.
         Everything else the filter culls here is the owner rule, which the
         engine's own default was already doing.

         Two assertions, and the interesting one is the ceiling: a filter that
         culled a large slice of a map this open would be culling players who
         *can* see each other, which is the failure you lose a fight to and the
         one direction this must not be wrong in. The floor is that the owner
         rule is still running -- 14,400 of the culls are it, which is one per
         client per frame, and losing them is the echo bug this class was
         written wrong once already.
        */
        expect(
            (on.culled - on.own) / Math.max(1, on.asked),
            'visibility culled a slice of an open map, which means it is culling the visible'
        ).toBeLessThan(0.1);

        expect(on.own, 'the owner rule stopped running, so the host is echoing').toBeGreaterThan(
            1000
        );
    }, 300_000);
});
