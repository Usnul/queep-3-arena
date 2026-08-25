/*
 * trace-compare.ts -- ask both collision backends the same question.
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
 * `measure-divergence` says how far the physics backend drifts from Q3 over
 * scripted input, and `physics-wedge.test` says whether any of that drift is bad
 * enough to trap a player. Neither answers the question you actually have when
 * someone sends a screenshot of a bot standing in a wall, which is: *at this
 * spot, what do the two backends say, and where do they first disagree?*
 *
 * Two modes.
 *
 *   node tools/trace-compare.ts oa_dm1 point 704,686,24
 *       Sweeps a player box out of that point in a handful of directions and
 *       prints both answers side by side. A single line differing in `frac` or
 *       in the plane normal is the bug, localised.
 *
 *   node tools/trace-compare.ts oa_dm1 walk 656,672,28 0
 *       Runs pmove from there, holding forward at that yaw, under each backend
 *       in turn, and prints the frames where they part company.
 *
 * The clipmap is the control in both: it is bit-exact against the C oracle, so
 * where they differ, it is right.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace, type TraceResult } from '../src/q3/cm/trace.ts';
import { vec3 } from '../src/q3/math.ts';
import { Pmove as runPmove } from '../src/q3/pmove/pmove.ts';
import {
    createPlayerState, createUserCmd, FORWARDMOVE, RIGHTMOVE, UPMOVE,
    type Pmove, type PlayerState,
} from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';
import { HeadlessPhysics } from './pipeline/headless-physics.ts';

/** Q3's standing player box. */
const MINS = [-15, -15, -24];
const MAXS = [15, 15, 32];

const [mapName = 'oa_dm1', mode = 'point', at = '0,0,0', yawArg = '0'] = process.argv.slice(2);

const built = join(process.cwd(), 'assets', 'built', mapName);
const raw = readFileSync(join(built, 'collision.bsp'));
const cm = new ClipMap(
    new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
);
const physics = new HeadlessPhysics(cm);

const origin = at.split(',').map(Number);
const yaw = Number(yawArg);

const clipTrace: Pmove['trace'] = (r, s, mn, mx, e, _p, mask) => boxTrace(r, cm, s, e, mn, mx, mask);
const physTrace: Pmove['trace'] = (r, s, mn, mx, e, _p, mask) => physics.trace(r, s, e, mn, mx, mask);

function describe(t: TraceResult): string {
    return (
        `frac ${t.fraction.toFixed(4)} ` +
        `n=(${Array.from(t.planeNormal).map((v) => v.toFixed(3)).join(',')})` +
        `${t.startsolid ? ' startsolid' : ''}${t.allsolid ? ' allsolid' : ''}`
    );
}

/* ------------------------------------------------------------------ *
 * point
 * ------------------------------------------------------------------ */

function point(): void {
    /*
     One frame of movement, one step, one stride, and the ground trace, which is
     the set pmove actually asks for. Long and short matter separately: a short
     sweep can be dominated by a surface the box already touches, and that is
     where the two backends disagree.
    */
    const directions: [string, number[]][] = [
        ['ground trace (down 0.25)', [0, 0, -0.25]],
        ['step probe (up 18)', [0, 0, 18]],
    ];

    for (let d = 0; d < 8; d++) {
        const a = (d * Math.PI) / 4;
        directions.push([`${d * 45}deg, one frame`, [Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0]]);
        directions.push([`${d * 45}deg, one stride`, [Math.cos(a) * 32, Math.sin(a) * 32, 0]]);
    }

    const a = createTrace();
    const b = createTrace();
    let differences = 0;

    for (const [name, d] of directions) {
        const end = [origin[0]! + d[0]!, origin[1]! + d[1]!, origin[2]! + d[2]!];

        boxTrace(a, cm, origin, end, MINS, MAXS, MASK_PLAYERSOLID);
        physics.trace(b, origin, end, MINS, MAXS, MASK_PLAYERSOLID);

        const same =
            Math.abs(a.fraction - b.fraction) < 1e-3 &&
            a.startsolid === b.startsolid &&
            a.allsolid === b.allsolid &&
            Array.from(a.planeNormal).every((v, i) => Math.abs(v - b.planeNormal[i]!) < 1e-3);

        if (same) continue;

        differences += 1;
        console.log(`${name}`);
        console.log(`    clipmap  ${describe(a)}`);
        console.log(`    physics  ${describe(b)}`);
    }

    console.log(
        differences === 0
            ? `${mapName} ${at}: all ${directions.length} sweeps agree`
            : `${mapName} ${at}: ${differences} of ${directions.length} sweeps disagree`
    );
}

/* ------------------------------------------------------------------ *
 * walk
 * ------------------------------------------------------------------ */

const MSEC = 8;
const FRAMES = 200;

function makePmove(ps: PlayerState, trace: Pmove['trace'], pointcontents: Pmove['pointcontents']): Pmove {
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
        pmove_msec: MSEC,
        pmove_float: 0,
        pmove_flags: 0,
        trace,
        pointcontents,
    };
}

function track(trace: Pmove['trace'], pointcontents: Pmove['pointcontents']): number[][] {
    const ps = createPlayerState();

    ps.commandTime = 0;
    ps.pm_type = C.PM_NORMAL;
    ps.gravity = 800;
    ps.speed = 320;
    ps.groundEntityNum = C.ENTITYNUM_NONE;
    ps.clientNum = 0;
    ps.stats[C.STAT_HEALTH] = 100;
    ps.origin[0] = origin[0]!;
    ps.origin[1] = origin[1]!;
    ps.origin[2] = origin[2]!;
    ps.viewheight = C.DEFAULT_VIEWHEIGHT;
    ps.weapon = 1;
    ps.ammo[1] = 100;
    ps.persistant[3] = 3;

    const pm = makePmove(ps, trace, pointcontents);
    const path: number[][] = [];

    for (let f = 0; f < FRAMES; f++) {
        pm.cmd.serverTime = (f + 1) * MSEC;
        pm.cmd.angles[0] = 0;
        pm.cmd.angles[1] = Math.round((yaw * 65536) / 360) | 0;
        pm.cmd.angles[2] = 0;
        pm.cmd.buttons = 0;
        pm.cmd.weapon = 1;
        pm.cmd.moves[FORWARDMOVE] = 127;
        pm.cmd.moves[RIGHTMOVE] = 0;
        pm.cmd.moves[UPMOVE] = 0;
        runPmove(pm);
        path.push([ps.origin[0]!, ps.origin[1]!, ps.origin[2]!, ps.velocity[0]!, ps.velocity[1]!]);
    }

    return path;
}

function walk(): void {
    const control = track(clipTrace, () => 0);
    const test = track(physTrace, (p) => physics.pointContents(p));

    const travel = (path: number[][]) =>
        Math.hypot(path.at(-1)![0]! - origin[0]!, path.at(-1)![1]! - origin[1]!);

    console.log(
        `${mapName} from ${at} at yaw ${yaw}: ` +
        `clipmap walked ${travel(control).toFixed(1)}, physics ${travel(test).toFixed(1)}`
    );

    let reported = 0;

    for (let f = 0; f < FRAMES && reported < 8; f++) {
        const gap = Math.hypot(
            control[f]![0]! - test[f]![0]!,
            control[f]![1]! - test[f]![1]!,
            control[f]![2]! - test[f]![2]!
        );

        // A landing differs by a fraction of a unit and stays that way; only
        // report the frames where the gap opens further.
        const previous = f === 0 ? 0 : Math.hypot(
            control[f - 1]![0]! - test[f - 1]![0]!,
            control[f - 1]![1]! - test[f - 1]![1]!,
            control[f - 1]![2]! - test[f - 1]![2]!
        );

        if (gap < 1 || gap < previous * 1.5) continue;

        reported += 1;
        const fmt = (p: number[]) =>
            `(${p.slice(0, 3).map((v) => v.toFixed(2)).join(',')}) v=(${p.slice(3).map((v) => v.toFixed(0)).join(',')})`;

        console.log(`  f${f}: gap ${gap.toFixed(2)}`);
        console.log(`    clipmap  ${fmt(control[f]!)}`);
        console.log(`    physics  ${fmt(test[f]!)}`);
    }
}

if (mode === 'walk') walk();
else point();
