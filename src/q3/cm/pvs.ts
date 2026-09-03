/*
 * pvs.ts -- `CM_ClusterPVS`, and what a client is allowed to know about.
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
 * A Q3 BSP carries a precomputed visibility set: for every cluster, a bit per
 * cluster saying whether any point in the first can see any point in the
 * second. `SV_BuildClientSnapshot` walks it to decide what goes in a client's
 * snapshot, which is how a sixteen-player Q3 server fits on a modem: a player
 * two rooms away costs nothing at all, not a smaller update.
 *
 * **The lump is in this port's collision BSP**, which is the thing that made
 * this worth writing rather than estimating -- 23,640 bytes on `oa_dm1`, 121
 * clusters at 16 bytes each plus the header. `tools/convert-map.ts` keeps it,
 * and the reason it does is that it keeps the whole lump table rather than the
 * lumps somebody thought collision needed.
 *
 * Two things this file deliberately does not do:
 *
 *   - **No area portals.** Q3's `CM_ClusterPVS` is the coarse test and
 *     `SV_BuildClientSnapshot` refines it with `areaportal` state, so a closed
 *     door can hide a room the PVS says is visible. That needs the mover
 *     simulation to be solid on the host, which is GAP-041, and it only ever
 *     *removes* entities -- so leaving it out is conservative in the direction
 *     that keeps the game correct.
 *   - **No `CM_LeafCluster` for a box.** Q3 tests a client's own leaf against
 *     each entity's `clusternums`, which for a big entity is up to sixteen
 *     clusters. Every replicated thing in this port is a point -- a player, a
 *     missile, an item -- so one cluster each is exact rather than an
 *     approximation.
 */

import type { ClipMap } from './ClipMap.ts';

/** 12 ints per leaf; `cluster` is the first and `area` the second. */
const LEAF_STRIDE = 12;
const LEAF_CLUSTER = 0;

/** 9 ints per node: plane, then the two children. */
const NODE_STRIDE = 9;
const NODE_CHILDREN = 1;

/** 4 floats per plane: normal then distance. */
const PLANE_STRIDE = 4;

/**
 * The visibility lump, as `CM_ClusterPVS` reads it.
 *
 * Q3's layout is `int numClusters; int clusterBytes; byte data[]`, and the
 * bit for "cluster `a` can see cluster `b`" is
 * `data[a * clusterBytes + (b >> 3)] & (1 << (b & 7))`.
 */
export interface Visibility {
    readonly numClusters: number;
    readonly clusterBytes: number;
    readonly data: Uint8Array;
}

/**
 * `CM_PointLeafnum_r`, then the leaf's cluster.
 *
 * A negative cluster is Q3's "outside the map" -- a leaf in solid, or one the
 * compiler found unreachable. `CM_ClusterPVS` treats that as *everything is
 * visible*, which is the conservative answer and the one that keeps a player
 * who has fallen out of the world visible to everybody rather than invisible.
 */
export function clusterAt(cm: ClipMap, px: number, py: number, pz: number): number {
    let num = 0;

    while (num >= 0) {
        const n = num * NODE_STRIDE;
        const planeIndex = cm.nodes[n]!;
        const p = planeIndex * PLANE_STRIDE;
        const type = cm.planeTypes[planeIndex]!;
        const dist = cm.planes[p + 3]!;

        let d: number;
        if (type < 3) {
            d = (type === 0 ? px : type === 1 ? py : pz) - dist;
        } else {
            d =
                cm.planes[p]! * px +
                cm.planes[p + 1]! * py +
                cm.planes[p + 2]! * pz -
                dist;
        }

        num = d < 0 ? cm.nodes[n + NODE_CHILDREN + 1]! : cm.nodes[n + NODE_CHILDREN]!;
    }

    const leaf = -1 - num;
    return cm.leafs[leaf * LEAF_STRIDE + LEAF_CLUSTER]!;
}

/**
 * `CM_ClusterPVS`: can anything in `from` see anything in `to`?
 *
 * **True when either cluster is out of range**, which is `CM_ClusterPVS`'
 * own behaviour -- it returns the all-ones row for a negative cluster. A
 * visibility test that fails open is a player who is drawn when they need not
 * be; one that fails closed is a player who is invisible, which is a bug you
 * lose a fight to.
 */
export function clusterVisible(vis: Visibility, from: number, to: number): boolean {
    if (from < 0 || from >= vis.numClusters) return true;
    if (to < 0 || to >= vis.numClusters) return true;

    const byte = vis.data[from * vis.clusterBytes + (to >> 3)];
    if (byte === undefined) return true;

    return (byte & (1 << (to & 7))) !== 0;
}

/**
 * Read the header and the rows out of `BspFile.visibility`.
 *
 * Returns a set with `numClusters: 0` for a map compiled without visibility,
 * which `clusterVisible` then answers "yes" to for every pair -- so a
 * `-novis` map replicates exactly as it does today rather than going blank.
 */
export function readVisibility(lump: Uint8Array): Visibility {
    const EMPTY: Visibility = { numClusters: 0, clusterBytes: 0, data: new Uint8Array(0) };
    if (lump.byteLength < 8) return EMPTY;

    const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
    const numClusters = view.getInt32(0, true);
    const clusterBytes = view.getInt32(4, true);

    if (numClusters <= 0 || clusterBytes <= 0) return EMPTY;

    const need = numClusters * clusterBytes;
    if (lump.byteLength - 8 < need) return EMPTY;

    return { numClusters, clusterBytes, data: lump.subarray(8, 8 + need) };
}
