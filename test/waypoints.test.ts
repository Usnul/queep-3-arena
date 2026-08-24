/*
 * waypoints.test.ts -- the navigation graph, on real maps.
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
 * The graph has no oracle and no ground truth: there is no correct answer to
 * "how much of this map should be navigable", only better and worse. So the
 * tests pin two things instead.
 *
 * The *properties* -- a link is symmetric, a drop is not, A* returns a
 * connected route, a route's first and last nodes are the ones asked for -- are
 * absolute and are asserted exactly.
 *
 * The *quality* is a regression guard with the measured number in the message,
 * deliberately set below what the build currently achieves rather than at it.
 * A guard at the current value fails on noise; one an order of magnitude below
 * catches the thing that actually goes wrong, which is a change that quietly
 * disconnects half a map.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { buildWaypoints, linkMapPortals, type TraceLike } from '../src/game/Waypoints.ts';

interface Scene {
    entities: { classname?: string; _originQ3: number[]; target?: unknown; targetname?: unknown; model?: unknown }[];
    submodels: { minsQ3: number[]; maxsQ3: number[] }[];
}

function load(mapName: string): { scene: Scene; trace: TraceLike } {
    const built = join(process.cwd(), 'assets', 'built', mapName);
    const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as Scene;
    const raw = readFileSync(join(built, 'collision.bsp'));

    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );

    const trace: TraceLike = (start, mins, maxs, end, mask) => {
        const out = createTrace();
        boxTrace(out, cm, start, end, mins, maxs, mask);
        return out;
    };

    return { scene, trace };
}

describe('the navigation graph', () => {
    const { scene, trace } = load('oa_dm1');
    const graph = buildWaypoints(scene.submodels[0]!, trace);
    const portals = linkMapPortals(graph, scene.entities, scene.submodels);

    it('samples the map into a usable number of nodes', () => {
        // 766 at the time of writing; the guard is that it is a graph rather
        // than a handful of points or a runaway.
        expect(graph.stats.nodes).toBeGreaterThan(300);
        expect(graph.stats.nodes).toBeLessThan(4000);
        expect(graph.stats.links).toBeGreaterThan(graph.stats.nodes);
    });

    it('links symmetrically, and drops only one way', () => {
        for (const node of graph.nodes) {
            for (const other of node.links) {
                expect(
                    graph.nodes[other]!.links,
                    `${node.index} links ${other} but not the reverse`
                ).toContain(node.index);
            }
        }

        let asymmetric = 0;
        for (const node of graph.nodes) {
            for (const exit of node.exits) {
                if (exit.kind !== 'drop') continue;
                // A drop goes down, so the far end must be lower.
                expect(graph.nodes[exit.to]!.origin[2]).toBeLessThan(node.origin[2]);
                if (!graph.nodes[exit.to]!.links.includes(node.index)) asymmetric += 1;
            }
        }

        // Every drop should be one-way; a drop that is also a walk link is a
        // link the walk pass should have found.
        expect(asymmetric).toBe(graph.stats.drops);
    });

    it('finds the map\'s teleporter', () => {
        expect(portals.teleports).toBe(1);
        expect(portals.jumppads).toBe(0);
    });

    it('returns routes that are actually connected', () => {
        const members = graph.mainBody();
        const inBody: number[] = [];
        for (let i = 0; i < members.length; i++) if (members[i] === 1) inBody.push(i);

        expect(inBody.length).toBeGreaterThan(100);

        /*
         Destinations come from `reachableFrom`, not from the component.
         `mainBody` is *weakly* connected -- it follows one-way drops in both
         directions to decide membership -- so two nodes can be in it and have
         no directed route between them, which is exactly what a drop means.
         The first version of this test asserted a route between any two members
         and failed on the first pair separated by a ledge, correctly.
        */
        let checked = 0;

        for (let attempt = 0; attempt < 20; attempt++) {
            const from = inBody[(attempt * 7919) % inBody.length]!;

            const reachable = graph.reachableFrom(from);
            const targets: number[] = [];
            for (let i = 0; i < reachable.length; i++) if (reachable[i] === 1 && i !== from) targets.push(i);
            if (targets.length === 0) continue;

            const to = targets[(attempt * 104729 + 13) % targets.length]!;

            const route = graph.path(from, to);
            checked += 1;

            expect(route.length, `no route from ${from} to ${to}`).toBeGreaterThan(0);
            expect(route[0]).toBe(from);
            expect(route[route.length - 1]).toBe(to);

            /*
             Every consecutive pair must be a real edge. A* that returns a
             plausible-looking list of nodes with a gap in it produces a bot
             that walks confidently into a wall, and nothing else in the system
             would notice.
            */
            for (let i = 1; i < route.length; i++) {
                const previous = graph.nodes[route[i - 1]!]!;
                const step = route[i]!;
                const connected =
                    previous.links.includes(step) ||
                    previous.exits.some((exit) => exit.to === step);
                expect(connected, `route step ${route[i - 1]} -> ${step} is not an edge`).toBe(true);
            }
        }

        expect(checked).toBeGreaterThan(15);
    });

    it('keeps most of the map in one piece', () => {
        /*
         Measured at 53% when this was written, having been 29% before drop
         links and 3% before the floor sample replaced item-entity nodes. The
         guard is at 35%: comfortably below the current value, comfortably above
         the versions that did not work.
        */
        expect(
            graph.stats.largestComponent,
            `largest component ${(graph.stats.largestComponent * 100).toFixed(0)}%`
        ).toBeGreaterThan(0.35);
    });

    it('snaps a spawn point into the main body', () => {
        const spawn = scene.entities.find((e) => e.classname === 'info_player_deathmatch');
        expect(spawn).toBeDefined();

        const node = graph.nearestInMainBody(spawn!._originQ3);
        expect(node).toBeGreaterThanOrEqual(0);
        expect(graph.mainBody()[node]).toBe(1);

        // And from there, most of the main body is reachable.
        const reachable = graph.reachableFrom(node);
        let count = 0;
        for (let i = 0; i < reachable.length; i++) count += reachable[i]!;

        expect(count).toBeGreaterThan(100);
    });
});

describe('jump pads as graph edges', () => {
    it('wires oa_dm7\'s four pads, which its levels depend on', () => {
        const { scene, trace } = load('oa_dm7');
        const graph = buildWaypoints(scene.submodels[0]!, trace);

        const before = graph.stats.largestComponent;
        const portals = linkMapPortals(graph, scene.entities, scene.submodels);

        expect(portals.jumppads).toBe(4);

        // The pads only help if they join things that were apart.
        expect(graph.stats.largestComponent).toBeGreaterThanOrEqual(before);

        const pads = graph.nodes.flatMap((n) => n.exits.filter((e) => e.kind === 'jumppad'));
        expect(pads).toHaveLength(4);
        // A pad is worth taking: its cost must beat walking the same span.
        for (const pad of pads) expect(pad.cost).toBeLessThan(64);
    });
});
