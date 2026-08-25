/*
 * bench-match.ts -- what a deathmatch costs, measured without a renderer.
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
 * The reproducer for REPORT.md section 5's simulation numbers, and the answer to
 * a question the browser could not be made to answer: of the CPU a match spends
 * per frame, how much is meep's physics and how much is the ported Q3 rule
 * running in front of it?
 *
 * That split is the price of GAP-019 and GAP-020, and until it had a number it
 * was an argument. `PhysicsTrace` calls `shape_cast` and `overlap_shape`, and
 * then calls `traceBrushList` -- the ported `CM_TraceThroughBrush` -- over the
 * brushes those two found. Running the same match on the pure clipmap backend
 * gives the other end of the scale.
 *
 * Usage:  node tools/bench-match.ts [map...]
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace, type TraceResult } from '../src/q3/cm/trace.ts';
import { ItemSystem, type DropTrace } from '../src/game/Items.ts';
import { buildWaypoints, linkMapPortals } from '../src/game/Waypoints.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { Bot } from '../src/game/Bot.ts';
import { BotRuntime, type BotWorld } from '../src/client/Bots.ts';
import { WeaponSystem, type Damageable, type WeaponEvents } from '../src/game/Weapons.ts';
import { vec3 } from '../src/q3/math.ts';
import { HeadlessPhysics } from './pipeline/headless-physics.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `sv_fps` on a Q3 server. */
const TICK = 1 / 125;
const SECONDS = 30;
const BOTS = 6;

/** Counts only; the presentation layer is what this is measuring the absence of. */
class Counters implements WeaponEvents {
    shots = 0;
    impacts = 0;
    explosions = 0;
    damage = 0;
    projectiles = 0;

    muzzleFlash(): void { this.shots += 1; }
    bulletImpact(): void { this.impacts += 1; }
    explosion(): void { this.explosions += 1; }
    hit(_t: Damageable, damage: number): void { this.damage += damage; }
    projectileSpawned(): void { this.projectiles += 1; }
    projectileMoved(): void {}
    projectileGone(): void {}
}

interface Row {
    readonly backend: string;
    readonly buildMs: number;
    readonly navMs: number;
    readonly frameUs: number;
    readonly traces: number;
    readonly travelled: number;
    readonly shots: number;
    readonly pickups: number;
}

function run(mapName: string, usePhysics: boolean): Row {
    const built = join(ROOT, 'assets', 'built', mapName);
    const raw = readFileSync(join(built, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
        entities: { classname?: string; _originQ3: number[] }[];
        submodels: { minsQ3: number[]; maxsQ3: number[] }[];
    };

    const t0 = performance.now();
    const backend = usePhysics ? new HeadlessPhysics(cm) : null;
    const buildMs = performance.now() - t0;

    /**
     * Every trace the match makes, counted.
     *
     * Counting has to happen *inside* the backend rather than at the call sites,
     * because most traces are pmove's own -- `PM_SlideMove` alone issues several
     * per frame per bot -- and those go through `PmoveHost` without passing any
     * closure this file owns. Counting only the line-of-sight and item-drop
     * traces put the figure out by an order of magnitude, which made the
     * derived per-trace cost look ten times worse than the microbenchmark below
     * says it is.
     *
     * Which also means the clipmap row's count is not comparable: with no
     * physics backend `PmoveHost` calls `boxTrace` directly and there is no seam
     * to count through. Reported as `--` rather than as a smaller number, since
     * a smaller number would read as "the clipmap traces less", and it does not
     * -- it is the same pmove making the same calls.
     */
    let traces = 0;

    const physics = backend === null ? null : {
        trace: (
            out: TraceResult,
            s: ArrayLike<number>, e: ArrayLike<number>,
            mn: ArrayLike<number>, mx: ArrayLike<number>, mask: number
        ): void => {
            traces += 1;
            backend.trace(out, s, e, mn, mx, mask);
        },
        pointContents: (p: ArrayLike<number>): number => backend.pointContents(p),
    };

    const trace: DropTrace = (start, mins, maxs, end, mask): TraceResult => {
        const out = createTrace();
        if (physics !== null) physics.trace(out, start, end, mins, maxs, mask);
        else {
            traces += 1;
            boxTrace(out, cm, start, end, mins, maxs, mask);
        }
        return out;
    };

    const items = new ItemSystem();
    items.spawn(scene.entities, trace);

    const tNav = performance.now();
    const graph = buildWaypoints(
        scene.submodels[0] ?? { minsQ3: [-4096, -4096, -4096], maxsQ3: [4096, 4096, 4096] },
        trace
    );
    linkMapPortals(graph, scene.entities, scene.submodels);
    const navMs = performance.now() - tNav;

    const counters = new Counters();
    const weapons = new WeaponSystem(cm, counters);
    const spawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);

    const snap = (origin: number[]): number[] => {
        const node = graph.nearestInMainBody(origin);
        if (node < 0) return origin;
        const n = graph.nodes[node]!.origin;
        return [n[0]!, n[1]!, n[2]! - 9];
    };

    const home = snap(spawns[0]!);
    const playerOrigin = vec3(home[0]!, home[1]!, home[2]! + 9);

    const player: Damageable = {
        id: 0,
        origin: playerOrigin,
        mins: vec3(-15, -15, -24),
        maxs: vec3(15, 15, 32),
        health: 1e9,
        armor: 0,
        dead: false,
    };
    weapons.targets.push(player);

    const world: BotWorld = {
        graph,
        items: items.items,
        // `physics.trace` counts itself; only the clipmap branch needs counting.
        trace: (start, mins, maxs, end, mask) => {
            const out = createTrace();
            if (physics !== null) physics.trace(out, start, end, mins, maxs, mask);
            else {
                traces += 1;
                boxTrace(out, cm, start, end, mins, maxs, mask);
            }
            return out;
        },
        playerOrigin: () => playerOrigin,
        playerAlive: () => true,
        spawns: spawns.map(snap),
        fire: (bot, eye, angles, weapon) => {
            weapons.fire(weapon, eye, angles, bot.id, 0x1234);
        },
    };

    const runtime = new BotRuntime(world, null);

    for (let i = 1; i <= BOTS && i < spawns.length; i++) {
        const bot = new Bot({
            id: 2000 + i,
            name: `bot${i}`,
            character: `bot${i}`,
            cm,
            spawnQ3: snap(spawns[i]!),
            physics,
            movers: () => ({ movers: [] }),
        });
        runtime.spawn(bot, null);
        weapons.targets.push(bot);
    }

    const startingItems = items.items.filter((i) => i.present).length;
    const last = runtime.bots.map((b) => [b.origin[0]!, b.origin[1]!, b.origin[2]!]);
    let travelled = 0;

    const tracesBefore = traces;
    const frames = Math.floor(SECONDS / TICK);
    const tFrames = performance.now();

    for (let step = 0; step < frames; step++) {
        runtime.update(TICK, TICK * 1000, items.items);
        weapons.update(TICK);
        player.health = 1e9;
        player.dead = false;

        for (let i = 0; i < runtime.bots.length; i++) {
            const b = runtime.bots[i]!;
            const p = last[i]!;
            if (!b.dead) {
                travelled += Math.hypot(
                    b.origin[0]! - p[0]!, b.origin[1]! - p[1]!, b.origin[2]! - p[2]!
                );
            }
            p[0] = b.origin[0]!;
            p[1] = b.origin[1]!;
            p[2] = b.origin[2]!;
        }
    }

    const frameUs = ((performance.now() - tFrames) / frames) * 1000;

    return {
        backend: usePhysics ? 'meep physics' : 'ported clipmap',
        buildMs,
        navMs,
        frameUs,
        traces: traces - tracesBefore,
        travelled,
        shots: counters.shots,
        pickups: startingItems - items.items.filter((i) => i.present).length,
    };
}

/**
 * Where a single trace's time goes, on one map.
 *
 * The match figures say the physics backend costs an order of magnitude more per
 * trace than the ported clipmap. This says which part, and the answer is not the
 * part that decides the result: `traceBrushList` -- the ported Q3 rule that
 * produces the fraction, the plane, `startsolid` and `allsolid` -- is the
 * cheapest line in the table, and the whole ported clipmap answers the entire
 * question for less than a fifth of what `shape_cast` costs on its own.
 *
 * Every figure is the mean of 20,000 calls after a 2,000-call warm-up, with the
 * shapes cached exactly as `PhysicsTrace` caches them, so this is not measuring
 * allocation.
 */
async function decompose(mapName: string): Promise<void> {
    const { shape_cast } = await import(
        '@woosh/meep-engine/src/engine/physics/queries/shape_cast.js'
    );
    const { overlap_shape } = await import(
        '@woosh/meep-engine/src/engine/physics/queries/overlap_shape.js'
    );
    const { BoxShape3D } = await import(
        '@woosh/meep-engine/src/core/geom/3d/shape/BoxShape3D.js'
    );
    const { PhysicsSurfacePoint } = await import(
        '@woosh/meep-engine/src/engine/physics/queries/PhysicsSurfacePoint.js'
    );
    const { traceBrushList } = await import('../src/q3/cm/trace.ts');
    const { MASK_PLAYERSOLID, SURFACE_CLIP_EPSILON } = await import('../src/q3/cm/ClipMap.ts');

    const built = join(ROOT, 'assets', 'built', mapName);
    const raw = readFileSync(join(built, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
        entities: { classname?: string; _originQ3: number[] }[];
    };
    const physics = new HeadlessPhysics(cm);

    const points = spawnPoints(scene.entities).points.map((e) => [
        e._originQ3[0]!, e._originQ3[1]!, e._originQ3[2]! + 30,
    ]);

    const MINS = [-15, -15, -24];
    const MAXS = [15, 15, 32];
    const WS = 1 / 32;
    const e = SURFACE_CLIP_EPSILON;
    const NO_ROT = { x: 0, y: 0, z: 0, w: 1 };

    const box = BoxShape3D.from(
        ((MAXS[0]! - MINS[0]!) * 0.5 + e) * WS,
        ((MAXS[2]! - MINS[2]!) * 0.5 + e) * WS,
        ((MAXS[1]! - MINS[1]!) * 0.5 + e) * WS
    );
    const inflated = BoxShape3D.from(
        ((MAXS[0]! - MINS[0]!) * 0.5 + 2 * e) * WS,
        ((MAXS[2]! - MINS[2]!) * 0.5 + 2 * e) * WS,
        ((MAXS[1]! - MINS[1]!) * 0.5 + 2 * e) * WS
    );

    const out = createTrace();
    const hit = new PhysicsSurfacePoint();
    const overlaps = new Uint32Array(64);
    const brushes = new Int32Array(80);

    // Four directions, so the sample is not all floor contacts.
    const dirs = [[64, 0, 0], [0, 64, 0], [0, 0, -64], [45, 45, 0]];
    const from = (i: number): number[] => points[i % points.length]!;
    const to = (i: number): number[] => {
        const s = from(i);
        const d = dirs[i % dirs.length]!;
        return [s[0]! + d[0]!, s[1]! + d[1]!, s[2]! + d[2]!];
    };

    const N = 20_000;

    const time = (label: string, fn: (i: number) => void): void => {
        for (let i = 0; i < 2000; i++) fn(i);
        const t = performance.now();
        for (let i = 0; i < N; i++) fn(i);
        console.log(`  ${label.padEnd(42)} ${(((performance.now() - t) / N) * 1000).toFixed(2)} us`);
    };

    console.log(`\nwhere one trace's time goes [${mapName}]`);

    time('PhysicsTrace.trace -- the shipping path', (i) =>
        physics.trace(out, from(i), to(i), MINS, MAXS, MASK_PLAYERSOLID)
    );
    time('boxTrace -- ported clipmap, whole answer', (i) =>
        boxTrace(out, cm, from(i), to(i), MINS, MAXS, MASK_PLAYERSOLID)
    );
    time('  shape_cast alone', (i) => {
        const s = from(i);
        const E = to(i);
        const dx = (E[0]! - s[0]!) * WS;
        const dy = (E[2]! - s[2]!) * WS;
        const dz = -(E[1]! - s[1]!) * WS;
        const L = Math.hypot(dx, dy, dz);
        shape_cast(
            physics.system,
            {
                origin_x: s[0]! * WS, origin_y: s[2]! * WS, origin_z: -s[1]! * WS,
                direction_x: dx / L, direction_y: dy / L, direction_z: dz / L,
                tMax: L,
            } as never,
            box as never,
            NO_ROT as never,
            hit as never,
            undefined,
            false
        );
    });
    time('  overlap_shape alone', (i) => {
        const s = from(i);
        overlap_shape(
            physics.system,
            inflated as never,
            { x: s[0]! * WS, y: s[2]! * WS, z: -s[1]! * WS } as never,
            NO_ROT as never,
            overlaps,
            0
        );
    });
    time('  traceBrushList over 8 brushes', (i) => {
        for (let k = 0; k < 8; k++) brushes[k] = (i * 7 + k) % cm.numBrushes;
        traceBrushList(out, cm, brushes, 8, from(i), to(i), MINS, MAXS, MASK_PLAYERSOLID);
    });
}

async function main(): Promise<void> {
    const maps = process.argv.slice(2);
    const list = maps.length > 0 ? maps : ['oa_dm1', 'aggressor'];

    console.log(
        `${BOTS} bots plus one standing player, ${SECONDS} s at ${Math.round(1 / TICK)} Hz, ` +
        `no renderer.\n`
    );

    for (const mapName of list) {
        console.log(mapName);

        for (const usePhysics of [true, false]) {
            const r = run(mapName, usePhysics);
            const perFrame = r.traces / (SECONDS / TICK);
            console.log(
                `  ${r.backend.padEnd(15)}` +
                ` bodies ${r.buildMs.toFixed(0).padStart(4)} ms` +
                `  nav ${r.navMs.toFixed(0).padStart(5)} ms` +
                `  frame ${r.frameUs.toFixed(0).padStart(4)} us` +
                `  traces/frame ${(usePhysics ? perFrame.toFixed(1) : '--').padStart(5)}` +
                `  walked ${r.travelled.toFixed(0).padStart(6)}` +
                `  shots ${String(r.shots).padStart(4)}` +
                `  pickups ${String(r.pickups).padStart(3)}`
            );
        }
    }

    await decompose(list[0]!);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) await main();
