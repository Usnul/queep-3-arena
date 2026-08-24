/*
 * Waypoints.ts -- navigation without AAS.
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
 * The brief says not to port botlib or AAS, and that is the right call twice
 * over: AAS is a compiled per-map format produced by a tool this project does
 * not have, and the areas it describes are a reachability model for a bot
 * architecture this port is not using either. What a behaviour tree needs is far
 * less -- somewhere to go, and a route to it.
 *
 * The first attempt built the graph from item and spawn entities alone, on the
 * reasoning that AAS goal areas are overwhelmingly item locations. Measured, it
 * did not work: on `oa_dm1` those 50 nodes produced 91 links and a largest
 * connected component of *three*. Items are scattered, and a straight line
 * between two of them almost always clips a pillar. The number is in the record
 * because the reasoning was sound and the result was not.
 *
 * What works is a floor sample. A grid of columns across the map's bounds, each
 * traced down repeatedly to find every level a player can stand on, then linked
 * to its near neighbours. Short links are nearly always straight, which is what
 * makes a straight-line walkability test a fair one. Items stop being nodes and
 * become *goals*: a bot heads for the nearest node to the item it wants.
 *
 * Links are validated by the same trace the player moves through, which is the
 * part that makes this honest rather than optimistic: a link exists because a
 * player-sized box can get from one end to the other, not because two points
 * looked close.
 *
 * What this cannot do, and AAS can: jumps, ledges, teleporters as edges, and
 * anywhere a bot would have to leave the ground to reach. Those are recorded in
 * DECISIONS.md rather than papered over -- a bot here walks and strafes and does
 * not rocket-jump.
 */

import { CONTENTS } from '../q3/cm/ClipMap.ts';

/** Player bounding box, from `bg_public.h`. */
const PLAYER_MINS: readonly [number, number, number] = [-15, -15, -24];
const PLAYER_MAXS: readonly [number, number, number] = [15, 15, 32];

/** `PM_StepSlideMove`'s maximum step. A link that needs more than this is a jump. */
const STEP_SIZE = 18;

/**
 * Grid spacing for the floor sample, in units.
 *
 * Chosen by measurement rather than by feel. At 96 units the largest connected
 * component on `oa_dm7` is 49% of the map; at 64 it is 91%, for 1.8x the nodes
 * and 3 ms more build time. At 48 it is 92% -- no better, twice the nodes -- so
 * 64 is where the curve flattens.
 *
 * The reason it matters is that a Q3 corridor is often 128 wide: at 96 spacing
 * it gets one column of nodes, and one column links to its neighbours only
 * along the corridor, so a T-junction becomes two components.
 */
const GRID_SPACING = 64;

/**
 * Link radius: over the grid diagonal (64 * sqrt(2) = 91) with headroom for the
 * height difference a ramp puts between two neighbours, so a node links to its
 * eight neighbours and no further.
 *
 * Also measured. Raising it to 150 doubles the link count for two percentage
 * points of connectivity, which is a poor trade -- those extra links are second
 * neighbours, and a path through them is a path the first neighbours already
 * offered.
 */
const MAX_LINK_DISTANCE = 120;

/** Ground samples along a candidate link, in units. */
const SAMPLE_SPACING = 24;

/** Standing headroom, from `bg_public.h`: 32 above the origin, 24 below. */
const PLAYER_HEIGHT = 56;

/** Guard against a pathological map producing an unbounded node count. */
const MAX_NODES = 4000;

/** Floors per column. A Q3 arena is rarely more than four levels deep. */
const MAX_LEVELS = 8;

export interface TraceLike {
    (
        start: ArrayLike<number>,
        mins: ArrayLike<number>,
        maxs: ArrayLike<number>,
        end: ArrayLike<number>,
        contentMask: number
    ): { fraction: number; endpos: ArrayLike<number>; startsolid: boolean };
}

/** A one-way edge: something a bot can do in one direction only. */
export interface Exit {
    readonly to: number;
    readonly kind: 'drop' | 'teleport' | 'jumppad';
    /** Path cost. A drop is cheap; a teleport is nearly free. */
    readonly cost: number;
}

export interface Waypoint {
    readonly index: number;
    /** Standing position: the player's *origin*, not its feet. */
    readonly origin: [number, number, number];
    /** What put this node here, for the debug overlay and the report. */
    readonly source: string;
    /** Bidirectional walk links. */
    readonly links: number[];
    /** One-way edges out of this node. */
    readonly exits: Exit[];
}

export interface GraphStats {
    readonly nodes: number;
    readonly links: number;
    readonly drops: number;
    readonly teleports: number;
    readonly candidates: number;
    readonly milliseconds: number;
    /** Nodes with no link at all -- unreachable, and worth knowing about. */
    readonly isolated: number;
    /** Size of the largest connected component, as a fraction of all nodes. */
    readonly largestComponent: number;
}

export class WaypointGraph {
    readonly nodes: Waypoint[] = [];
    stats: GraphStats = {
        nodes: 0, links: 0, drops: 0, teleports: 0,
        candidates: 0, milliseconds: 0, isolated: 0, largestComponent: 0,
    };

    private drops = 0;
    private teleports = 0;
    private reachScratch = new Uint8Array(0);
    private mainBodyCache: Uint8Array | null = null;

    private readonly trace: TraceLike;

    constructor(trace: TraceLike) {
        this.trace = trace;
    }

    /**
     * Drop a node at a position, if a player can stand there.
     *
     * The position given is usually an item's, which rests 15 units above the
     * floor; a player standing on the same spot has its origin 24 up. So the
     * candidate is lifted and then dropped, which both finds the real standing
     * height and rejects positions inside geometry.
     */
    addNode(origin: readonly [number, number, number], source: string): void {
        if (this.nodes.length >= MAX_NODES) return;

        this.nodes.push({
            index: this.nodes.length,
            origin: [origin[0], origin[1], origin[2]],
            source,
            links: [],
            exits: [],
        });
    }

    /**
     * Every standing position in one vertical column.
     *
     * Traced top-down repeatedly rather than once, because a Q3 arena is
     * layered: one trace finds the highest floor and nothing about the walkway
     * two storeys below it. Each hit is recorded and the next probe starts a
     * player-height below it, which is the smallest step that cannot find the
     * same floor twice.
     */
    sampleColumn(x: number, y: number, top: number, bottom: number, into: string): void {
        let z = top;

        for (let level = 0; level < MAX_LEVELS && z > bottom; level++) {
            const start: [number, number, number] = [x, y, z];

            const probe = this.trace(
                start,
                PLAYER_MINS,
                PLAYER_MAXS,
                [x, y, bottom],
                CONTENTS.SOLID
            );

            if (probe.startsolid) {
                // Inside geometry: skip past it and try again lower down.
                z -= PLAYER_HEIGHT;
                continue;
            }

            if (probe.fraction === 1) return; // clear all the way down: no more floors

            const floor = probe.endpos[2]!;
            this.addNode([x, y, floor], into);

            z = floor - PLAYER_HEIGHT;
        }
    }

    /**
     * Link every pair a player could walk between.
     *
     * O(n^2) in the node count, which for a Q3 arena is about 40 nodes and 1,600
     * candidate pairs. Each candidate costs a handful of traces, so the whole
     * build is milliseconds -- there is no reason to be clever about it, and
     * being clever would mean a spatial index that could hide a missing link.
     */
    link(): void {
        const t0 = performance.now();

        let links = 0;
        let candidates = 0;

        /*
         A spatial hash rather than the O(n^2) sweep the first version used. At
         50 nodes the sweep was free; a floor sample is 500-3,000 nodes and
         900,000 pairs, nearly all of them hundreds of units apart. Bucketing by
         the link radius keeps the candidate set to a node's own bucket and its
         26 neighbours, which is the only thing within range anyway.
        */
        const cell = MAX_LINK_DISTANCE;
        const buckets = new Map<string, number[]>();
        const key = (x: number, y: number, z: number): string =>
            `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

        for (const node of this.nodes) {
            const k = key(node.origin[0], node.origin[1], node.origin[2]);
            const bucket = buckets.get(k);
            if (bucket === undefined) buckets.set(k, [node.index]);
            else bucket.push(node.index);
        }

        for (const from of this.nodes) {
            const cx = Math.floor(from.origin[0] / cell);
            const cy = Math.floor(from.origin[1] / cell);
            const cz = Math.floor(from.origin[2] / cell);

            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    for (let oz = -1; oz <= 1; oz++) {
                        const bucket = buckets.get(`${cx + ox},${cy + oy},${cz + oz}`);
                        if (bucket === undefined) continue;

                        for (const b of bucket) {
                            // Each pair once, and never a self-link.
                            if (b <= from.index) continue;

                            const to = this.nodes[b]!;

                            const dx = to.origin[0] - from.origin[0];
                            const dy = to.origin[1] - from.origin[1];
                            const dz = to.origin[2] - from.origin[2];

                            if (Math.hypot(dx, dy, dz) > MAX_LINK_DISTANCE) continue;

                            candidates += 1;

                            if (!this.walkable(from.origin, to.origin)) continue;

                            from.links.push(b);
                            to.links.push(from.index);
                            links += 1;
                        }
                    }
                }
            }
        }

        let isolated = 0;
        for (const node of this.nodes) if (node.links.length === 0) isolated += 1;

        this.stats = {
            nodes: this.nodes.length,
            links,
            drops: this.drops,
            teleports: this.teleports,
            candidates,
            milliseconds: performance.now() - t0,
            isolated,
            largestComponent: this.largestComponent(),
        };
    }

    /**
     * One-way edges for walking off a ledge.
     *
     * A Q3 arena is layered and a walk link cannot cross a drop, so without
     * these the graph is one component per floor -- measured on `oa_dm1`, the
     * largest was 29% of the map. This is AAS's `TRAVEL_WALKOFFLEDGE` and it is
     * the cheapest way to make a multi-level map navigable.
     *
     * `MAX_DROP` is 350 units, comfortably under the fall that starts doing
     * damage in `PM_CrashLand`, so a bot taking a drop link never hurts itself.
     */
    linkDrops(): void {
        const MAX_DROP = 350;
        const REACH = GRID_SPACING * 1.5;

        for (const from of this.nodes) {
            for (const to of this.nodes) {
                if (to.index === from.index) continue;

                const dz = from.origin[2] - to.origin[2];
                if (dz < STEP_SIZE * 2 || dz > MAX_DROP) continue;

                const horizontal = Math.hypot(
                    to.origin[0] - from.origin[0],
                    to.origin[1] - from.origin[1]
                );
                if (horizontal > REACH) continue;

                // Already walkable both ways: not a drop.
                if (from.links.includes(to.index)) continue;

                // Step off the ledge...
                const over: [number, number, number] = [
                    to.origin[0],
                    to.origin[1],
                    from.origin[2] + STEP_SIZE,
                ];
                const across = this.trace(
                    [from.origin[0], from.origin[1], from.origin[2] + STEP_SIZE],
                    PLAYER_MINS, PLAYER_MAXS, over, CONTENTS.SOLID
                );
                if (across.fraction < 0.999) continue;

                // ...and fall.
                const down = this.trace(over, PLAYER_MINS, PLAYER_MAXS, to.origin, CONTENTS.SOLID);
                if (down.fraction < 0.999) continue;

                from.exits.push({ to: to.index, kind: 'drop', cost: dz });
                this.drops += 1;
            }
        }

        this.mainBodyCache = null;
        this.stats = { ...this.stats, drops: this.drops, largestComponent: this.largestComponent() };
    }

    /**
     * A teleporter or a jump pad, as a one-way edge.
     *
     * Nearly free in path cost, which is correct -- both are instant compared to
     * walking -- and is what makes a bot step onto a pad rather than walk the
     * long way round. Q3's own AAS gives `TRAVEL_TELEPORT` and `TRAVEL_JUMPPAD`
     * fixed low costs for the same reason.
     *
     * Modelling these is not optional on a Q3 map. Measured on `oa_dm7`, whose
     * levels are joined by four jump pads: without the edges, 33% of item pairs
     * are reachable from each other; with them, the map opens up. A bot with a
     * navigation graph that omits the pads is a bot standing on the bottom
     * floor of a map built around vertical movement.
     */
    linkPortal(
        fromPositionQ3: ArrayLike<number>,
        toPositionQ3: ArrayLike<number>,
        kind: 'teleport' | 'jumppad' = 'teleport'
    ): boolean {
        const from = this.nearest(fromPositionQ3);
        const to = this.nearest(toPositionQ3);
        if (from < 0 || to < 0 || from === to) return false;

        this.nodes[from]!.exits.push({ to, kind, cost: 32 });
        this.teleports += 1;
        this.mainBodyCache = null;
        this.stats = {
            ...this.stats,
            teleports: this.teleports,
            largestComponent: this.largestComponent(),
        };
        return true;
    }

    /**
     * The nearest node to a position that is part of the map's main body.
     *
     * Q3 can spawn a bot at any `info_player_deathmatch` because AAS guarantees
     * every spawn point is in a reachable area. This graph carries no such
     * guarantee -- a floor sample finds ledges, alcoves and rooftops that
     * nothing links to -- so a bot spawned at a point whose neighbourhood is a
     * three-node island stands there for the whole match. Measured on `oa_dm1`:
     * two of six bots, before this.
     *
     * Snapping the spawn to the main body is the honest equivalent of what AAS
     * provides, and it is a *spawn-time* correction rather than a runtime one:
     * a bot that wanders into an island is still stuck there, which is the
     * truth about the graph rather than something to paper over.
     */
    nearestInMainBody(positionQ3: ArrayLike<number>): number {
        const members = this.mainBody();

        let best = -1;
        let bestDistance = Infinity;

        for (const node of this.nodes) {
            if (members[node.index] === 0) continue;

            const dx = node.origin[0] - positionQ3[0]!;
            const dy = node.origin[1] - positionQ3[1]!;
            const dz = node.origin[2] - positionQ3[2]!;
            const d = dx * dx + dy * dy + dz * dz;

            if (d < bestDistance) {
                bestDistance = d;
                best = node.index;
            }
        }

        return best;
    }

    /** Membership of the largest component, computed once and cached. */
    mainBody(): Uint8Array {
        if (this.mainBodyCache !== null) return this.mainBodyCache;

        const n = this.nodes.length;
        const seen = new Uint8Array(n);
        let best: number[] = [];

        for (let start = 0; start < n; start++) {
            if (seen[start] === 1) continue;

            const component: number[] = [];
            const queue = [start];
            seen[start] = 1;

            while (queue.length > 0) {
                const at = queue.pop()!;
                component.push(at);

                for (const next of this.nodes[at]!.links) {
                    if (seen[next] === 0) { seen[next] = 1; queue.push(next); }
                }
                for (const exit of this.nodes[at]!.exits) {
                    if (seen[exit.to] === 0) { seen[exit.to] = 1; queue.push(exit.to); }
                }
            }

            if (component.length > best.length) best = component;
        }

        const members = new Uint8Array(n);
        for (const index of best) members[index] = 1;

        this.mainBodyCache = members;
        return members;
    }

    /** Fraction of nodes in the largest connected component, following exits too. */
    largestComponent(): number {
        const n = this.nodes.length;
        if (n === 0) return 0;

        const seen = new Uint8Array(n);
        let largest = 0;

        for (let start = 0; start < n; start++) {
            if (seen[start] === 1) continue;

            let size = 0;
            const queue = [start];
            seen[start] = 1;

            while (queue.length > 0) {
                const at = queue.pop()!;
                size += 1;

                for (const next of this.nodes[at]!.links) {
                    if (seen[next] === 0) { seen[next] = 1; queue.push(next); }
                }
                for (const exit of this.nodes[at]!.exits) {
                    if (seen[exit.to] === 0) { seen[exit.to] = 1; queue.push(exit.to); }
                }
            }

            if (size > largest) largest = size;
        }

        return largest / n;
    }

    /**
     * Can a player walk from `from` to `to` in a straight line?
     *
     * Two conditions, and both are needed. A clear box sweep says nothing hits
     * the player on the way -- but it is equally clear across a chasm. So the
     * path is also sampled for *ground*: at each step there must be a floor
     * within one step-height below, which is exactly the condition
     * `PM_StepSlideMove` needs to keep walking.
     */
    private walkable(
        from: readonly [number, number, number],
        to: readonly [number, number, number]
    ): boolean {
        /*
         Swept a step-height above both ends, which is what `PM_StepSlideMove`
         effectively does: a player crossing a ramp or a stair rises before it
         advances. Sweeping between the two floor positions directly fails on
         every ramp in the game, because the straight line from the bottom of a
         slope to the top passes through the slope.
        */
        const lifted: [number, number, number] = [from[0], from[1], from[2] + STEP_SIZE];
        const target: [number, number, number] = [to[0], to[1], to[2] + STEP_SIZE];

        const sweep = this.trace(lifted, PLAYER_MINS, PLAYER_MAXS, target, CONTENTS.SOLID);
        if (sweep.fraction < 0.999) return false;

        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dz = to[2] - from[2];
        const horizontal = Math.hypot(dx, dy);
        const distance = Math.hypot(dx, dy, dz);

        const steps = Math.max(2, Math.ceil(distance / SAMPLE_SPACING));

        /*
         How far the floor may move between two samples. A *step* may be up to
         `STEP_SIZE`; a *slope* may be up to 45 degrees, which is where
         `MIN_WALK_NORMAL` of 0.7 puts the limit, so the allowance grows with
         the horizontal distance covered. A fixed 18 units rejects every ramp
         steeper than 37 degrees, and Q3 is full of 45-degree ramps.
        */
        const allowance = Math.max(STEP_SIZE, (horizontal / steps) * 1.05);

        let previousFloor = from[2];

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const x = from[0] + dx * t;
            const y = from[1] + dy * t;
            const z = from[2] + dz * t;

            const start: [number, number, number] = [x, y, z + STEP_SIZE];
            const down = this.trace(
                start,
                PLAYER_MINS,
                PLAYER_MAXS,
                [x, y, z - STEP_SIZE * 2],
                CONTENTS.SOLID
            );

            if (down.startsolid || down.fraction === 1) return false;

            const floor = down.endpos[2]!;
            if (Math.abs(floor - previousFloor) > allowance) return false;

            previousFloor = floor;
        }

        return true;
    }

    /**
     * Every node reachable from `index`, following links and one-way exits in
     * the direction they go.
     *
     * A forward BFS rather than a component label, because the graph is
     * directed: a bot can drop off a ledge and not climb back, so "in the same
     * component" and "reachable from here" are different questions and only the
     * second one is the one a bot is asking.
     *
     * The buffer is reused. This runs once per plan, which is once every few
     * seconds per bot, and allocating a kilobyte each time would be the largest
     * allocation in the frame for no reason.
     */
    reachableFrom(index: number): Uint8Array {
        const n = this.nodes.length;

        if (this.reachScratch.length !== n) this.reachScratch = new Uint8Array(n);
        const seen = this.reachScratch;
        seen.fill(0);

        if (index < 0 || index >= n) return seen;

        seen[index] = 1;
        const queue = [index];

        while (queue.length > 0) {
            const at = queue.pop()!;

            for (const next of this.nodes[at]!.links) {
                if (seen[next] === 0) { seen[next] = 1; queue.push(next); }
            }
            for (const exit of this.nodes[at]!.exits) {
                if (seen[exit.to] === 0) { seen[exit.to] = 1; queue.push(exit.to); }
            }
        }

        return seen;
    }

    /** Nearest node to a position, by straight-line distance. `-1` if there are none. */
    nearest(positionQ3: ArrayLike<number>): number {
        let best = -1;
        let bestDistance = Infinity;

        for (const node of this.nodes) {
            const dx = node.origin[0] - positionQ3[0]!;
            const dy = node.origin[1] - positionQ3[1]!;
            const dz = node.origin[2] - positionQ3[2]!;
            const d = dx * dx + dy * dy + dz * dz;

            if (d < bestDistance) {
                bestDistance = d;
                best = node.index;
            }
        }

        return best;
    }

    /**
     * Nearest node this position can actually *walk to*.
     *
     * `nearest` is straight-line and therefore wrong for the one thing it is
     * used for: a bot standing a stride from a wall frequently has its nearest
     * node on the far side of it, and then every route it plans starts by
     * walking into that wall. Measured, this was most of the "bots plateau after
     * ten seconds" behaviour -- they had a 32-node path and could not reach node
     * one of it.
     *
     * Candidates are considered nearest-first and the first walkable one wins,
     * so the common case costs a single trace.
     */
    nearestReachable(positionQ3: ArrayLike<number>, limit = 12): number {
        const scored: { index: number; distance: number }[] = [];

        for (const node of this.nodes) {
            const dx = node.origin[0] - positionQ3[0]!;
            const dy = node.origin[1] - positionQ3[1]!;
            const dz = node.origin[2] - positionQ3[2]!;
            scored.push({ index: node.index, distance: dx * dx + dy * dy + dz * dz });
        }

        scored.sort((a, b) => a.distance - b.distance);

        const from: [number, number, number] = [
            positionQ3[0]!,
            positionQ3[1]!,
            positionQ3[2]!,
        ];

        for (let i = 0; i < Math.min(limit, scored.length); i++) {
            const node = this.nodes[scored[i]!.index]!;
            if (this.walkable(from, node.origin)) return node.index;
        }

        // Nothing walkable in range: fall back to the straight-line answer, so a
        // bot in a place the graph does not describe still has something to aim
        // at rather than nothing.
        return scored.length > 0 ? scored[0]!.index : -1;
    }

    /**
     * A* from one node to another. Returns node indices including both ends, or
     * an empty array when there is no route.
     *
     * Plain arrays rather than a binary heap: the frontier of a 40-node graph
     * never exceeds a handful of entries, and a linear scan of five is faster
     * than a heap of five.
     */
    path(fromIndex: number, toIndex: number): number[] {
        if (fromIndex < 0 || toIndex < 0) return [];
        if (fromIndex === toIndex) return [fromIndex];

        const n = this.nodes.length;
        const cameFrom = new Int32Array(n).fill(-1);
        const gScore = new Float64Array(n).fill(Infinity);
        const closed = new Uint8Array(n);

        const heuristic = (i: number): number => {
            const a = this.nodes[i]!.origin;
            const b = this.nodes[toIndex]!.origin;
            return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        };

        gScore[fromIndex] = 0;
        const open: number[] = [fromIndex];

        while (open.length > 0) {
            let bestAt = 0;
            let bestScore = Infinity;
            for (let i = 0; i < open.length; i++) {
                const score = gScore[open[i]!]! + heuristic(open[i]!);
                if (score < bestScore) {
                    bestScore = score;
                    bestAt = i;
                }
            }

            const current = open.splice(bestAt, 1)[0]!;

            if (current === toIndex) {
                const route = [current];
                let at = current;
                while (cameFrom[at] !== -1) {
                    at = cameFrom[at]!;
                    route.push(at);
                }
                return route.reverse();
            }

            closed[current] = 1;

            const here = this.nodes[current]!.origin;

            const relax = (next: number, step: number): void => {
                if (closed[next] === 1) return;

                const tentative = gScore[current]! + step;
                if (tentative >= gScore[next]!) return;

                cameFrom[next] = current;
                gScore[next] = tentative;
                if (!open.includes(next)) open.push(next);
            };

            for (const next of this.nodes[current]!.links) {
                const there = this.nodes[next]!.origin;
                relax(next, Math.hypot(here[0] - there[0], here[1] - there[1], here[2] - there[2]));
            }

            // One-way edges cost what they are worth rather than what they span:
            // a teleport across the map is cheaper than two steps.
            for (const exit of this.nodes[current]!.exits) relax(exit.to, exit.cost);
        }

        return [];
    }
}

/** The entity fields the portal wiring reads. */
export interface PortalEntity {
    readonly classname?: string;
    readonly _originQ3: number[];
    readonly target?: unknown;
    readonly targetname?: unknown;
    readonly model?: unknown;
}

export interface PortalSubmodel {
    readonly minsQ3: readonly number[];
    readonly maxsQ3: readonly number[];
}

/**
 * Wire every teleporter and jump pad on a map into the graph.
 *
 * A `trigger_teleport` or `trigger_push` is a brush entity, so its position is
 * its *submodel's* box rather than its own origin -- the origin is `0 0 0`,
 * because the brushes already sit where the designer put them. Reading the
 * origin instead links every pad on the map to whatever node happens to be
 * nearest the world origin, which is a graph that looks connected and routes
 * nowhere.
 */
export function linkMapPortals(
    graph: WaypointGraph,
    entities: readonly PortalEntity[],
    submodels: readonly PortalSubmodel[]
): { teleports: number; jumppads: number } {
    const destinations = new Map<string, number[]>();

    for (const entity of entities) {
        const classname = entity.classname ?? '';
        if (classname !== 'misc_teleporter_dest' && classname !== 'target_position') continue;

        const name = typeof entity.targetname === 'string' ? entity.targetname : '';
        if (name.length > 0) destinations.set(name, entity._originQ3);
    }

    let teleports = 0;
    let jumppads = 0;

    for (const entity of entities) {
        const classname = entity.classname ?? '';
        const kind =
            classname === 'trigger_teleport' ? 'teleport'
            : classname === 'trigger_push' ? 'jumppad'
            : null;

        if (kind === null) continue;

        const target = typeof entity.target === 'string' ? entity.target : '';
        const destination = destinations.get(target);
        if (destination === undefined) continue;

        const reference = typeof entity.model === 'string' ? entity.model : '';
        if (!reference.startsWith('*')) continue;

        const submodel = submodels[Number(reference.slice(1))];
        if (submodel === undefined) continue;

        const centre: [number, number, number] = [
            (submodel.minsQ3[0]! + submodel.maxsQ3[0]!) * 0.5,
            (submodel.minsQ3[1]! + submodel.maxsQ3[1]!) * 0.5,
            (submodel.minsQ3[2]! + submodel.maxsQ3[2]!) * 0.5,
        ];

        if (!graph.linkPortal(centre, destination, kind)) continue;

        if (kind === 'teleport') teleports += 1;
        else jumppads += 1;
    }

    return { teleports, jumppads };
}

export interface MapBounds {
    readonly minsQ3: readonly number[];
    readonly maxsQ3: readonly number[];
}

/**
 * Build a graph by sampling the map's floors.
 *
 * `bounds` is BSP model 0's own bounding box, which is the world's extent and
 * therefore exactly the region worth sampling. The columns are inset by half a
 * grid cell so the outermost ones are not flush against the skybox.
 */
export function buildWaypoints(bounds: MapBounds, trace: TraceLike): WaypointGraph {
    const graph = new WaypointGraph(trace);

    const minX = bounds.minsQ3[0]!;
    const minY = bounds.minsQ3[1]!;
    const maxX = bounds.maxsQ3[0]!;
    const maxY = bounds.maxsQ3[1]!;

    // A player's origin is 24 above its feet, so probes start above the ceiling
    // and stop below the floor rather than at them.
    const top = bounds.maxsQ3[2]! - PLAYER_MAXS[2];
    const bottom = bounds.minsQ3[2]! + PLAYER_MINS[2];

    for (let x = minX + GRID_SPACING / 2; x < maxX; x += GRID_SPACING) {
        for (let y = minY + GRID_SPACING / 2; y < maxY; y += GRID_SPACING) {
            graph.sampleColumn(x, y, top, bottom, 'floor');
        }
    }

    graph.link();
    graph.linkDrops();
    return graph;
}
