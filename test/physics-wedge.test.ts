/*
 * physics-wedge.test.ts -- no invisible obstacles.
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
 * The reported symptom was a spot where the player could not move left or right
 * and could only creep forwards and back along an invisible line. That is what
 * `PM_SlideMove` does when it is handed two contradictory contact planes: it
 * clips velocity against the first, achieves nothing, retries, accumulates the
 * second, and projects the result onto the line where they meet. Three planes
 * and it stops entirely.
 *
 * The divergence harness never saw it, because it measures *displacement* along
 * scripted input and a wedge is a place you have to already be standing. So this
 * asks the question directly and geometrically: at every standing position on
 * the map, can the player leave?
 *
 * The clipmap is the control. A spot the clipmap says is open in every direction
 * and the physics says is closed in every direction is a wedge, and there must
 * be none. Genuinely enclosed spots -- the inside of a pillar the floor sampler
 * found, an alcove one box wide -- are counted separately and not judged, since
 * the clipmap agrees they are enclosed.
 *
 * That is the *static* question, and asking only it turned out to be a mistake.
 * It passed clean on a build where a player pressing into a wall could not move
 * at all, because a single 32-unit sweep is not what pmove does: pmove
 * accelerates, clips, retries, steps and pushes down, and the ways it can fail
 * to make progress are not visible in one trace. So the second half of this file
 * asks the dynamic question -- run pmove and see whether the player *goes*
 * anywhere -- with the same clipmap control.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { vec3 } from '../src/q3/math.ts';
import { Pmove as runPmove } from '../src/q3/pmove/pmove.ts';
import {
    createPlayerState, createUserCmd, FORWARDMOVE, RIGHTMOVE, UPMOVE,
    type Pmove, type PlayerState,
} from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { buildWaypoints, type TraceLike } from '../src/game/Waypoints.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';

/** Q3's standing player box. */
const MINS = [-15, -15, -24];
const MAXS = [15, 15, 32];

/** One stride, which is far enough to be blocked by anything real. */
const PROBE = 32;

const DIRECTIONS: [number, number][] = [];
for (let i = 0; i < 8; i++) {
    DIRECTIONS.push([Math.cos((i * Math.PI) / 4) * PROBE, Math.sin((i * Math.PI) / 4) * PROBE]);
}

interface Scan {
    readonly sampled: number;
    readonly wedges: number;
    readonly enclosed: number;
    readonly worst: string[];
}

/**
 * A map, and every place on it a player can stand.
 *
 * The floor sampler already knows how to find those, so it doubles as the
 * sample set for both halves of this file. It traces the same collision the
 * player moves through, which is the point.
 */
function load(mapName: string): { cm: ClipMap; graph: ReturnType<typeof buildWaypoints> } {
    const built = join(process.cwd(), 'assets', 'built', mapName);
    const raw = readFileSync(join(built, 'collision.bsp'));
    const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
        submodels: { minsQ3: number[]; maxsQ3: number[] }[];
    };

    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );

    const trace: TraceLike = (start, mins, maxs, end, mask) => {
        const out = createTrace();
        boxTrace(out, cm, start, end, mins, maxs, mask);
        return out;
    };

    return { cm, graph: buildWaypoints(scene.submodels[0]!, trace) };
}

function scan(mapName: string): Scan {
    const { cm, graph } = load(mapName);
    const physics = new HeadlessPhysics(cm);

    const clip = createTrace();
    const phys = createTrace();

    let wedges = 0;
    let enclosed = 0;
    const worst: string[] = [];

    for (const node of graph.nodes) {
        const o = node.origin;

        let blockedClip = 0;
        let blockedPhysics = 0;

        for (const [dx, dy] of DIRECTIONS) {
            const end = [o[0] + dx, o[1] + dy, o[2]];

            boxTrace(clip, cm, o, end, MINS, MAXS, MASK_PLAYERSOLID);
            physics.trace(phys, o, end, MINS, MAXS, MASK_PLAYERSOLID);

            if (clip.fraction < 0.99) blockedClip += 1;
            if (phys.fraction < 0.99) blockedPhysics += 1;
        }

        if (blockedClip >= 6) {
            enclosed += 1;
            continue;
        }

        if (blockedClip <= 2 && blockedPhysics >= 6) {
            wedges += 1;
            if (worst.length < 5) {
                worst.push(
                    `${o.map((v) => v.toFixed(0)).join(',')}: ` +
                    `clipmap blocks ${blockedClip}/8, physics blocks ${blockedPhysics}/8`
                );
            }
        }
    }

    return { sampled: graph.nodes.length, wedges, enclosed, worst };
}

describe.each(['oa_dm1', 'aggressor'])('physics wedges [%s]', (name) => {
    const built = existsSync(join(process.cwd(), 'assets', 'built', name, 'collision.bsp'));

    it.skipIf(!built)('leaves no spot the player cannot walk out of', () => {
        const result = scan(name);

        expect(result.sampled).toBeGreaterThan(200);

        expect(
            result.wedges,
            `${result.wedges} of ${result.sampled} standing positions are wedged ` +
            `(${result.enclosed} genuinely enclosed, which is fine)` +
            (result.worst.length > 0 ? `\n  ${result.worst.join('\n  ')}` : '')
        ).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * The dynamic question: run pmove, and see whether the player moves.
 * ------------------------------------------------------------------ */

/** Long enough to accelerate to full speed and cross a room. */
const WALK_FRAMES = 120;

/** Q3's 125fps-ish command interval. */
const MSEC = 8;

/** `usercmd_t.angles` is 16-bit fixed point over a full turn. */
const toShort = (degrees: number) => Math.round((degrees * 65536) / 360) | 0;

/*
 Two starting heights, because they exercise different failures.

 `0` puts the player flush on the floor, the state the floor sampler produces
 and the one `PM_CorrectAllSolid` exists for. `4` is an ordinary standing
 position that falls the last few units first. A build that reports every
 contact as solid fails the first; a build that reports the surface you are
 already touching as an obstacle in front of you fails the second. Both
 shipped, and only the second was reachable by walking around.
*/
const LIFTS = [0, 4];

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

function spawn(origin: readonly number[]): PlayerState {
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
    // `PM_Weapon` early-outs for spectators, so the unported weapon code cannot
    // interfere with a movement measurement.
    ps.persistant[3] = 3;

    return ps;
}

/** Hold forward at a fixed yaw and report how far the player got, in the plane. */
function walk(
    origin: readonly number[],
    yawDegrees: number,
    trace: Pmove['trace'],
    pointcontents: Pmove['pointcontents'],
    frames = WALK_FRAMES
): { travel: number; end: number[] } {
    const ps = spawn(origin);
    const pm = makePmove(ps, trace, pointcontents);

    for (let f = 0; f < frames; f++) {
        pm.cmd.serverTime = (f + 1) * MSEC;
        pm.cmd.angles[0] = 0;
        pm.cmd.angles[1] = toShort(yawDegrees);
        pm.cmd.angles[2] = 0;
        pm.cmd.buttons = 0;
        pm.cmd.weapon = 1;
        pm.cmd.moves[FORWARDMOVE] = 127;
        pm.cmd.moves[RIGHTMOVE] = 0;
        pm.cmd.moves[UPMOVE] = 0;
        runPmove(pm);
    }

    return {
        travel: Math.hypot(ps.origin[0]! - origin[0]!, ps.origin[1]! - origin[1]!),
        end: [ps.origin[0]!, ps.origin[1]!, ps.origin[2]!],
    };
}

describe.each(['oa_dm1', 'aggressor'])('walking [%s]', (name) => {
    const built = existsSync(join(process.cwd(), 'assets', 'built', name, 'collision.bsp'));

    it.skipIf(!built)('gets as far on meep physics as it does on the clipmap', () => {
        const map = load(name);
        const physics = new HeadlessPhysics(map.cm);

        const clipTrace: Pmove['trace'] = (r, s, mn, mx, e, _p, mask) =>
            boxTrace(r, map.cm, s, e, mn, mx, mask);
        const physTrace: Pmove['trace'] = (r, s, mn, mx, e, _p, mask) =>
            physics.trace(r, s, e, mn, mx, mask);

        /*
         Only forward. `forwardmove = -127` at yaw t and `+127` at yaw t+180
         produce the same wish direction -- `PM_CmdScale` takes the magnitude --
         so back-pedalling is already covered by the opposite heading, and
         running it costs twice the time for none of the coverage. Worth saying
         because the report that started this was specifically about a bot
         walking backwards.
        */
        const stride = Math.max(1, Math.floor(map.graph.nodes.length / 40));
        const stuck: string[] = [];
        let runs = 0;

        for (let n = 0; n < map.graph.nodes.length; n += stride) {
            for (const lift of LIFTS) {
                const o = Array.from(map.graph.nodes[n]!.origin);
                o[2] = o[2]! + lift;

                for (let d = 0; d < 8; d++) {
                    const yaw = d * 45;
                    runs += 1;

                    const control = walk(o, yaw, clipTrace, () => 0);
                    if (control.travel < 150) continue; // nowhere to go anyway

                    const test = walk(o, yaw, physTrace, (p) => physics.pointContents(p));
                    if (test.travel > control.travel * 0.25) continue;

                    /*
                     The two runs diverge by fractions of a unit at a landing and
                     can then take different turns at a junction, so "physics got
                     less far" is not on its own a bug -- one of them may simply
                     have ended up in a corner the map really does have. The
                     control decides: put *it* where the physics run stopped and
                     see whether it can leave either.
                    */
                    const recheck = walk(test.end, yaw, clipTrace, () => 0, 30);
                    if (recheck.travel < 8) continue;

                    stuck.push(
                        `${o.map((v) => v.toFixed(0)).join(',')} yaw ${yaw}: ` +
                        `clipmap walked ${control.travel.toFixed(0)}, physics ${test.travel.toFixed(0)}`
                    );
                }
            }
        }

        expect(runs).toBeGreaterThan(300);
        expect(
            stuck.length,
            `${stuck.length} of ${runs} walks stall on meep physics but not on the clipmap` +
            (stuck.length > 0 ? `\n  ${stuck.slice(0, 6).join('\n  ')}` : '')
        ).toBe(0);
    });
});
