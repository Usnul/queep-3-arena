/*
 * measure-divergence.ts -- how far physics-backed movement drifts from Q3.
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
 * The tuning instrument for D-029.
 *
 * `bg_pmove` now traces against meep's physics rather than the ported
 * `cm_trace`. That is an accuracy trade taken deliberately, and "match as
 * closely as possible" is only actionable with a number attached. This runs the
 * same input stream through three configurations:
 *
 *   1. the C oracle (ground truth),
 *   2. the port on the ported clipmap (bit-exact against 1, the control),
 *   3. the port on meep physics (the thing being tuned).
 *
 * and reports how far 3 drifts from 1 over time. Because 2 is bit-exact, any
 * divergence in 3 is attributable entirely to the collision backend rather than
 * to the port.
 *
 * Runs headless under Node: `PhysicsSystem` and `shape_cast` have no browser
 * dependency, which is worth noting on its own -- it is what makes this
 * measurable in CI rather than by eye.
 *
 * Usage:  node tools/measure-divergence.ts [map...]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { parseEntities, entityVector } from '../src/q3/bsp/Entities.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { vec3 } from '../src/q3/math.ts';
import { Pmove as runPmove } from '../src/q3/pmove/pmove.ts';
import {
    createPlayerState,
    createUserCmd,
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type Pmove,
    type PlayerState,
} from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';
import { Oracle } from '../test/oracle.ts';
import { HeadlessPhysics } from './pipeline/headless-physics.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FRAMES = 240;
const EPISODES = 24;

/** `PM_Weapon`'s own early-out, so the unported weapon code cannot skew events. */
const PERS_TEAM = 3;
const TEAM_SPECTATOR = 3;

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Pattern {
    readonly name: string;
    readonly step: (frame: number, rand: () => number) => {
        forward: number;
        right: number;
        up: number;
        yawDelta: number;
    };
}

const PATTERNS: readonly Pattern[] = [
    {
        name: 'strafe-jump',
        step: (frame) => ({
            forward: 127,
            right: 127,
            up: frame % 2 === 0 ? 127 : 0,
            yawDelta: -140,
        }),
    },
    {
        name: 'bunny-hop',
        step: () => ({ forward: 127, right: 0, up: 127, yawDelta: 0 }),
    },
    {
        name: 'walk-into-walls',
        step: (frame) => ({
            forward: 127,
            right: 0,
            up: 0,
            yawDelta: frame % 60 === 0 ? 2000 : 0,
        }),
    },
    {
        name: 'chaos',
        step: (_f, rand) => ({
            forward: Math.floor(rand() * 255) - 127,
            right: Math.floor(rand() * 255) - 127,
            up: Math.floor(rand() * 255) - 127,
            yawDelta: Math.floor(rand() * 4000) - 2000,
        }),
    },
];

function makePmove(
    ps: PlayerState,
    trace: Pmove['trace'],
    pointcontents: Pmove['pointcontents']
): Pmove {
    return {
        ps,
        cmd: createUserCmd(),
        tracemask: MASK_PLAYERSOLID,
        debugLevel: 0,
        noFootsteps: false,
        gauntletHit: false,
        framecount: 0,
        numtouch: 0,
        touchents: new Int32Array(C.MAXTOUCH),
        mins: vec3(),
        maxs: vec3(),
        watertype: 0,
        waterlevel: 0,
        xyspeed: 0,
        pmove_fixed: 0,
        pmove_msec: 8,
        pmove_float: 0,
        pmove_flags: 0,
        trace,
        pointcontents,
    };
}

function initPlayerState(ps: PlayerState, spawn: readonly number[], yaw: number): void {
    ps.commandTime = 0;
    ps.pm_type = C.PM_NORMAL;
    ps.gravity = 800;
    ps.speed = 320;
    ps.groundEntityNum = C.ENTITYNUM_NONE;
    ps.clientNum = 0;
    ps.stats[C.STAT_HEALTH] = 100;
    ps.origin[0] = spawn[0]!;
    ps.origin[1] = spawn[1]!;
    ps.origin[2] = spawn[2]!;
    ps.velocity[0] = 0;
    ps.velocity[1] = 0;
    ps.velocity[2] = 0;
    ps.delta_angles[1] = yaw;
    ps.viewheight = C.DEFAULT_VIEWHEIGHT;
    ps.weapon = 1;
    ps.ammo[1] = 100;
    ps.persistant[PERS_TEAM] = TEAM_SPECTATOR;
    ps.pm_flags = 0;
    ps.pm_time = 0;
    ps.bobCycle = 0;
    ps.eventSequence = 0;
}

interface Sample {
    /** Distance from the oracle's position, Q3 units. */
    readonly error: number;
    readonly frame: number;
}

async function measure(map: string): Promise<void> {
    const path = join(ROOT, 'assets', 'extracted', 'maps', `${map}.bsp`);
    if (!existsSync(path)) {
        console.error(`missing ${path} -- run: npm run setup`);
        return;
    }

    const oracle = await Oracle.create();
    oracle.loadBsp(path);

    const raw = readFileSync(path);
    const bsp = new BspFile(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        map
    );
    const cm = new ClipMap(bsp);

    const physics = await HeadlessPhysics.create(cm);

    const spawns = parseEntities(bsp.entityString)
        .filter(
            (e) =>
                e['classname'] === 'info_player_deathmatch' ||
                e['classname'] === 'info_player_start'
        )
        .map((e) => {
            const o = entityVector(e, 'origin');
            return [o[0], o[1], o[2] + 9] as [number, number, number];
        });

    if (spawns.length === 0) {
        console.error(`${map}: no spawn points`);
        return;
    }

    console.log(
        `\n${map}: ${cm.numBrushes} brushes -> ${physics.stats.bodies} bodies ` +
        `(${physics.stats.hullMilliseconds.toFixed(0)} ms hulls, ` +
        `${physics.stats.bodyMilliseconds.toFixed(0)} ms bodies, ` +
        `${physics.stats.optimizeMilliseconds.toFixed(0)} ms broadphase)`
    );

    compareTraces(cm, physics, spawns, 0x7ace);

    for (const pattern of PATTERNS) {
        const samples: Sample[] = [];
        let controlMax = 0;
        let divergedAt: number[] = [];

        for (let episode = 0; episode < EPISODES; episode++) {
            const rand = rng(0xbeef + episode * 7919 + pattern.name.length * 131);
            const spawn = spawns[episode % spawns.length]!;
            const startYaw = Math.floor(rand() * 65536) - 32768;

            oracle.reset();

            // Configuration 2: the control, on the ported clipmap.
            const psControl = createPlayerState();
            initPlayerState(psControl, spawn, startYaw);
            const traceOut = createTrace();
            const pmControl = makePmove(
                psControl,
                (r, s, mn, mx, e, _p, mask) => {
                    boxTrace(r, cm, s, e, mn, mx, mask);
                    r.entityNum = r.fraction !== 1.0 ? C.ENTITYNUM_WORLD : C.ENTITYNUM_NONE;
                },
                (p) => physics.pointContents(p)
            );
            void traceOut;

            // Configuration 3: the thing being tuned.
            const psPhysics = createPlayerState();
            initPlayerState(psPhysics, spawn, startYaw);
            const pmPhysics = makePmove(
                psPhysics,
                (r, s, mn, mx, e, _p, mask) => physics.trace(r, s, e, mn, mx, mask),
                (p) => physics.pointContents(p)
            );

            // Configuration 1: the oracle.
            oracle.setInt('commandTime', 0);
            oracle.setInt('pm_type', C.PM_NORMAL);
            oracle.setInt('gravity', 800);
            oracle.setInt('speed', 320);
            oracle.setInt('groundEntityNum', C.ENTITYNUM_NONE);
            oracle.setInt('clientNum', 0);
            oracle.setInt('stats', 100, C.STAT_HEALTH);
            oracle.setVec('origin', spawn);
            oracle.setVec('velocity', [0, 0, 0]);
            oracle.setInt('delta_angles', startYaw, 1);
            oracle.setInt('viewheight', C.DEFAULT_VIEWHEIGHT);
            oracle.setInt('weapon', 1);
            oracle.setInt('ammo', 100, 1);
            oracle.setInt('persistant', TEAM_SPECTATOR, PERS_TEAM);

            let yaw = 0;
            let time = 0;
            let firstDiverge = -1;

            for (let frame = 0; frame < FRAMES; frame++) {
                const input = pattern.step(frame, rand);
                time += 8 + Math.floor(rand() * 25);
                yaw = (yaw + input.yawDelta) | 0;

                for (const pm of [pmControl, pmPhysics]) {
                    pm.cmd.serverTime = time;
                    pm.cmd.angles[0] = 0;
                    pm.cmd.angles[1] = yaw;
                    pm.cmd.angles[2] = 0;
                    pm.cmd.buttons = 0;
                    pm.cmd.weapon = 1;
                    pm.cmd.moves[FORWARDMOVE] = input.forward;
                    pm.cmd.moves[RIGHTMOVE] = input.right;
                    pm.cmd.moves[UPMOVE] = input.up;
                }

                oracle.setCmdInt('serverTime', time);
                oracle.setCmdAngles([0, yaw, 0]);
                oracle.setCmdInt('buttons', 0);
                oracle.setCmdByte('weapon', 1);
                oracle.setCmdByte('forwardmove', input.forward);
                oracle.setCmdByte('rightmove', input.right);
                oracle.setCmdByte('upmove', input.up);

                runPmove(pmControl);
                runPmove(pmPhysics);
                oracle.pmove({ tracemask: MASK_PLAYERSOLID });

                const truth = oracle.getVec('origin');

                const controlError = Math.hypot(
                    psControl.origin[0]! - truth[0],
                    psControl.origin[1]! - truth[1],
                    psControl.origin[2]! - truth[2]
                );
                if (controlError > controlMax) controlMax = controlError;

                const error = Math.hypot(
                    psPhysics.origin[0]! - truth[0],
                    psPhysics.origin[1]! - truth[1],
                    psPhysics.origin[2]! - truth[2]
                );

                samples.push({ error, frame });

                if (firstDiverge === -1 && error > 1) {
                    firstDiverge = frame;
                }
            }

            if (firstDiverge !== -1) divergedAt.push(firstDiverge);
        }

        report(pattern.name, samples, controlMax, divergedAt);
    }
}

function report(
    name: string,
    samples: readonly Sample[],
    controlMax: number,
    divergedAt: readonly number[]
): void {
    const errors = samples.map((s) => s.error).sort((a, b) => a - b);
    const at = (q: number): number => errors[Math.floor((errors.length - 1) * q)] ?? 0;

    const withinOneUnit = errors.filter((e) => e <= 1).length / errors.length;

    // Error at the 1-second mark, roughly, so "drift rate" is legible.
    const early = samples.filter((s) => s.frame < 60).map((s) => s.error);
    const earlyMedian = early.sort((a, b) => a - b)[Math.floor(early.length / 2)] ?? 0;

    const divergeMedian =
        divergedAt.length === 0
            ? null
            : [...divergedAt].sort((a, b) => a - b)[Math.floor(divergedAt.length / 2)];

    console.log(
        `  ${name.padEnd(16)} ` +
        `median ${at(0.5).toFixed(2).padStart(8)}  ` +
        `p90 ${at(0.9).toFixed(2).padStart(8)}  ` +
        `max ${at(1).toFixed(1).padStart(9)}  ` +
        `<=1u ${(withinOneUnit * 100).toFixed(0).padStart(3)}%  ` +
        `first>1u ${divergeMedian === null ? '  never' : `f${String(divergeMedian).padStart(4)}`}  ` +
        `[control max ${controlMax.toExponential(1)}]`
    );

    // Early median under a tenth of a unit means the two agree at the scale a
    // player can perceive; the max is dominated by episodes that separate and
    // then explore different parts of the level, which is expected and is not
    // the number to tune on.
    void earlyMedian;
}

/**
 * Trace-level comparison: the same sweep through both backends.
 *
 * More actionable than the episode numbers, because it isolates the backend
 * from the chaos. Episode divergence is dominated by two runs separating and
 * then exploring different parts of the level; this is the actual per-query
 * difference the tuning can act on.
 */
function compareTraces(
    cm: ClipMap,
    physics: HeadlessPhysics,
    spawns: readonly (readonly number[])[],
    seed: number
): void {
    const rand = rng(seed);
    const N = 20_000;

    const mins = [-15, -15, -24];
    const maxs = [15, 15, 32];

    const a = createTrace();
    const b = createTrace();

    const fractionErrors: number[] = [];
    let bothMiss = 0;
    let bothHit = 0;
    let onlyClipmap = 0;
    let onlyPhysics = 0;
    let normalAgree = 0;
    let normalDisagree = 0;

    /*
     Sampled *around spawn points*, not uniformly through the level's bounding
     box. A uniform sample is mostly inside solid geometry -- 40,000 uniform
     sweeps yielded 65 comparable hits, because almost every start point was
     buried in a wall. Sampling where a player can actually stand is both more
     representative and vastly more efficient.
    */
    for (let i = 0; i < N; i++) {
        const anchor = spawns[i % spawns.length]!;

        const start = [
            anchor[0]! + (rand() - 0.5) * 400,
            anchor[1]! + (rand() - 0.5) * 400,
            anchor[2]! + (rand() - 0.5) * 160,
        ];
        // Short sweeps, the length a movement frame actually issues.
        const end = [
            start[0]! + (rand() - 0.5) * 48,
            start[1]! + (rand() - 0.5) * 48,
            start[2]! + (rand() - 0.5) * 48,
        ];

        boxTrace(a, cm, start, end, mins, maxs, MASK_PLAYERSOLID);
        physics.trace(b, start, end, mins, maxs, MASK_PLAYERSOLID);

        const aHit = a.fraction < 1;
        const bHit = b.fraction < 1;

        if (!aHit && !bHit) {
            bothMiss += 1;
            continue;
        }
        if (aHit && !bHit) {
            onlyClipmap += 1;
            continue;
        }
        if (!aHit && bHit) {
            onlyPhysics += 1;
            continue;
        }

        bothHit += 1;
        fractionErrors.push(Math.abs(a.fraction - b.fraction));

        /*
         Normals are only comparable where Q3 reports a real surface. When a
         trace starts inside solid, `plane.normal` is left at zero and is
         explicitly not valid -- comparing against it produced a bogus "19%
         agreement" figure until this filter was added. On genuine surface hits
         the two backends agree exactly.
        */
        if (a.allsolid || a.startsolid || b.startsolid) continue;

        const aLen = Math.hypot(a.planeNormal[0], a.planeNormal[1], a.planeNormal[2]);
        if (aLen < 0.9) continue;

        const dot =
            a.planeNormal[0] * b.planeNormal[0] +
            a.planeNormal[1] * b.planeNormal[1] +
            a.planeNormal[2] * b.planeNormal[2];

        if (dot > 0.99) normalAgree += 1;
        else normalDisagree += 1;
    }

    fractionErrors.sort((x, y) => x - y);
    const q = (f: number): number => fractionErrors[Math.floor((fractionErrors.length - 1) * f)] ?? 0;

    const decided = bothHit + onlyClipmap + onlyPhysics;

    console.log(
        `  traces: ${N} sweeps, ${bothMiss} both-miss, ${bothHit} both-hit, ` +
        `${onlyClipmap} clipmap-only, ${onlyPhysics} physics-only ` +
        `(${((1 - (onlyClipmap + onlyPhysics) / Math.max(1, decided)) * 100).toFixed(1)}% agree on hit/miss)`
    );
    console.log(
        `          fraction |err| median ${q(0.5).toExponential(1)}  ` +
        `p90 ${q(0.9).toExponential(1)}  max ${q(1).toExponential(1)}   ` +
        `normals agree ${((normalAgree / Math.max(1, normalAgree + normalDisagree)) * 100).toFixed(1)}% ` +
        `of ${normalAgree + normalDisagree} valid-plane hits`
    );
}

async function main(): Promise<void> {
    const maps = process.argv.slice(2);
    const targets = maps.length > 0 ? maps : ['oa_dm1', 'aggressor'];

    console.log(
        'Divergence of physics-backed pmove from the C oracle, in Q3 units.\n' +
        'Control is the ported cm_trace, which is bit-exact -- its max column\n' +
        'should read as zero, and confirms the harness itself is sound.'
    );

    for (const map of targets) {
        await measure(map);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
