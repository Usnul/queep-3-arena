/*
 * pmove.diff.test.ts -- differential test: TypeScript Pmove vs the C.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 *
 * ---
 *
 * The point of the oracle. Both sides get the same `playerState_t`, the same
 * `usercmd_t` stream and the same BSP, and are stepped frame by frame; any
 * divergence is reported with the frame it first appeared on.
 *
 * **Episodes, not single frames.** A single `Pmove` call proves very little:
 * movement bugs compound. A wrong contact normal produces a millimetre of
 * position error on the frame it happens and a metre thirty frames later, and
 * the interesting behaviour -- strafe jumping, ramp jumps, stair climbing --
 * only exists across frames. So the suite runs episodes of 240 frames from real
 * spawn points, with input patterns chosen to provoke the specific behaviours
 * the brief calls non-negotiable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { parseEntities, entityVector } from '../src/q3/bsp/Entities.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, pointContents, createTrace } from '../src/q3/cm/trace.ts';
import { vec3 } from '../src/q3/math.ts';
import { Pmove as runPmove } from '../src/q3/pmove/pmove.ts';
import {
    createPlayerState,
    createUserCmd,
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type Pmove,
} from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';

/**
 * `persistant[PERS_TEAM]`, and the value that makes `PM_Weapon` return
 * immediately.
 *
 * The port does not implement the weapon state machine (D-022) and it raises
 * events, so the oracle's `eventSequence` would run ahead of the port's for a
 * reason that has nothing to do with movement. Rather than excluding
 * `eventSequence` from the comparison -- which would also hide a genuinely
 * missing *movement* event, the failure mode this suite most needs to catch --
 * the oracle is configured so the C takes `PM_Weapon`'s own first early-out:
 *
 *     if ( pm->ps->persistant[PERS_TEAM] == TEAM_SPECTATOR || ... ) return;
 *
 * `PERS_TEAM` is read nowhere else in `bg_pmove.c` or `bg_slidemove.c`
 * (verified by grep), so this disables exactly the unported subsystem and
 * nothing else. No C is modified.
 */
const PERS_TEAM = 3;
const TEAM_SPECTATOR = 3;
import { Oracle, type PsField } from './oracle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Patch-free, so D-017 cannot mask a divergence. */
const MAPS = ['oa_dm1', 'aggressor', 'oa_dm2'] as const;

const FRAMES_PER_EPISODE = 240;
const EPISODES_PER_MAP = 40;

/** `ps` fields compared every frame. Position and velocity are the point. */
const COMPARED_INT: PsField[] = [
    'commandTime', 'pm_type', 'bobCycle', 'pm_flags', 'pm_time',
    'gravity', 'speed', 'groundEntityNum', 'movementDir',
    'viewheight', 'eventSequence', 'jumppad_ent', 'pmove_framecount',
];

const COMPARED_VEC: PsField[] = ['origin', 'velocity', 'viewangles'];

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

/**
 * Input patterns.
 *
 * Purely random input rarely produces a strafe jump -- the manoeuvre needs jump
 * held while forward and one strafe axis are combined with a steadily turning
 * yaw. Named patterns make the interesting behaviours actually occur, and make a
 * failure say which one broke.
 */
type Pattern = (frame: number, rand: () => number) => {
    forward: number;
    right: number;
    up: number;
    yawDelta: number;
    pitchDelta: number;
    buttons: number;
};

const PATTERNS: Record<string, Pattern> = {
    /** The canonical strafe jump: hold forward + right, turn right, hold jump. */
    strafeJumpRight: (frame) => ({
        forward: 127,
        right: 127,
        up: frame % 2 === 0 ? 127 : 0,
        yawDelta: -140,
        pitchDelta: 0,
        buttons: 0,
    }),

    strafeJumpLeft: (frame) => ({
        forward: 127,
        right: -127,
        up: frame % 2 === 0 ? 127 : 0,
        yawDelta: 140,
        pitchDelta: 0,
        buttons: 0,
    }),

    /** Continuous bunny hop straight ahead -- exercises the Pmove sub-step jump latch. */
    bunnyHop: () => ({
        forward: 127,
        right: 0,
        up: 127,
        yawDelta: 0,
        pitchDelta: 0,
        buttons: 0,
    }),

    /** Walk into geometry -- stair stepping and PM_SlideMove plane accumulation. */
    walkIntoWalls: (frame) => ({
        forward: 127,
        right: 0,
        up: 0,
        yawDelta: frame % 60 === 0 ? 2000 : 0,
        pitchDelta: 0,
        buttons: 0,
    }),

    /** Crouch, uncrouch, move -- PM_CheckDuck's stand-up trace. */
    duckWalk: (frame) => ({
        forward: 127,
        right: frame % 40 < 20 ? 90 : -90,
        up: frame % 30 < 15 ? -127 : 0,
        yawDelta: 40,
        pitchDelta: 0,
        buttons: 0,
    }),

    /** Fully random, to reach states the scripted patterns never do. */
    chaos: (_frame, rand) => ({
        forward: Math.floor(rand() * 255) - 127,
        right: Math.floor(rand() * 255) - 127,
        up: Math.floor(rand() * 255) - 127,
        yawDelta: Math.floor(rand() * 4000) - 2000,
        pitchDelta: Math.floor(rand() * 2000) - 1000,
        buttons: rand() < 0.1 ? C.BUTTON_WALKING : 0,
    }),
};

describe.each(MAPS)('Pmove differential [%s]', (MAP) => {
    let oracle: Oracle;
    let cm: ClipMap;
    let spawns: [number, number, number][];

    beforeAll(async () => {
        const path = join(ROOT, 'assets', 'extracted', 'maps', `${MAP}.bsp`);
        if (!existsSync(path)) throw new Error(`missing ${path}\nrun: npm run setup`);

        oracle = await Oracle.create();
        oracle.loadBsp(path);

        const raw = readFileSync(path);
        const bsp = new BspFile(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            MAP
        );
        cm = new ClipMap(bsp);

        // Real spawn points, plus the +9 the server applies in
        // `G_SelectSpawnPoint`, so episodes start where a player actually starts.
        spawns = parseEntities(bsp.entityString)
            .filter(
                (e) =>
                    e['classname'] === 'info_player_deathmatch' ||
                    e['classname'] === 'info_player_start'
            )
            .map((e) => {
                const o = entityVector(e, 'origin');
                return [o[0], o[1], o[2] + 9] as [number, number, number];
            });

        expect(spawns.length, 'map must have spawn points').toBeGreaterThan(0);
    });

    it.each(Object.keys(PATTERNS))('agrees over 240 frames [%s]', (patternName) => {
        const pattern = PATTERNS[patternName]!;
        const failures: string[] = [];

        let framesCompared = 0;
        let everLeftGround = 0;
        let maxSpeedSeen = 0;

        for (let episode = 0; episode < EPISODES_PER_MAP; episode++) {
            const rand = rng(0xbeef + episode * 7919 + patternName.length * 131);
            const spawn = spawns[episode % spawns.length]!;

            /* ---- set up both sides identically ---- */

            oracle.reset();

            const ps = createPlayerState();
            const cmd = createUserCmd();

            const startYaw = Math.floor(rand() * 65536) - 32768;

            const init = (): void => {
                ps.commandTime = 0;
                ps.pm_type = C.PM_NORMAL;
                ps.gravity = 800;
                ps.speed = 320;
                ps.groundEntityNum = C.ENTITYNUM_NONE;
                ps.clientNum = 0;
                ps.stats[C.STAT_HEALTH] = 100;
                ps.origin[0] = spawn[0];
                ps.origin[1] = spawn[1];
                ps.origin[2] = spawn[2];
                ps.velocity[0] = 0;
                ps.velocity[1] = 0;
                ps.velocity[2] = 0;
                ps.delta_angles[1] = startYaw;
                ps.viewheight = C.DEFAULT_VIEWHEIGHT;
                ps.weapon = 1;
                ps.ammo[1] = 100;
                ps.persistant[PERS_TEAM] = TEAM_SPECTATOR;
            };

            init();

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

            /* ---- the port's pmove_t ---- */

            const trace = createTrace();

            const pmove: Pmove = {
                ps,
                cmd,
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
                trace(results, start, mins, maxs, end, _passEnt, contentMask) {
                    boxTrace(results, cm, start, end, mins, maxs, contentMask);
                    // The oracle's world trace claims ENTITYNUM_WORLD on a hit;
                    // the port's clipmap must say the same or `groundEntityNum`
                    // diverges immediately.
                    results.entityNum =
                        results.fraction !== 1.0 ? C.ENTITYNUM_WORLD : C.ENTITYNUM_NONE;
                },
                pointcontents(point: ArrayLike<number>, _passEnt: number) {
                    return pointContents(cm, point[0]!, point[1]!, point[2]!);
                },
            };

            let yaw = 0;
            let pitch = 0;
            let time = 0;
            let episodeFailed = false;

            for (let frame = 0; frame < FRAMES_PER_EPISODE && !episodeFailed; frame++) {
                const input = pattern(frame, rand);

                // Frame length varies so the `Pmove` sub-stepping is exercised
                // rather than always taking one step.
                time += 8 + Math.floor(rand() * 25);

                yaw = (yaw + input.yawDelta) | 0;
                pitch = Math.max(-16000, Math.min(16000, pitch + input.pitchDelta));

                cmd.serverTime = time;
                cmd.angles[0] = pitch;
                cmd.angles[1] = yaw;
                cmd.angles[2] = 0;
                cmd.buttons = input.buttons;
                cmd.weapon = 1;
                cmd.moves[FORWARDMOVE] = input.forward;
                cmd.moves[RIGHTMOVE] = input.right;
                cmd.moves[UPMOVE] = input.up;

                oracle.setCmdInt('serverTime', time);
                oracle.setCmdAngles([pitch, yaw, 0]);
                oracle.setCmdInt('buttons', input.buttons);
                oracle.setCmdByte('weapon', 1);
                oracle.setCmdByte('forwardmove', input.forward);
                oracle.setCmdByte('rightmove', input.right);
                oracle.setCmdByte('upmove', input.up);

                runPmove(pmove);
                oracle.pmove({ tracemask: MASK_PLAYERSOLID });

                framesCompared += 1;

                if (ps.groundEntityNum === C.ENTITYNUM_NONE) everLeftGround += 1;
                const sp = Math.hypot(ps.velocity[0]!, ps.velocity[1]!);
                if (sp > maxSpeedSeen) maxSpeedSeen = sp;

                const problems: string[] = [];

                for (const field of COMPARED_VEC) {
                    const want = oracle.getVec(field);
                    const got = field === 'origin' ? ps.origin
                        : field === 'velocity' ? ps.velocity
                        : ps.viewangles;
                    for (let k = 0; k < 3; k++) {
                        if (got[k] !== want[k]) {
                            problems.push(
                                `${field}[${k}] ${got[k]} != ${want[k]}`
                            );
                        }
                    }
                }

                for (const field of COMPARED_INT) {
                    const want = oracle.getInt(field);
                    const got = (ps as unknown as Record<string, number>)[field]!;
                    if (got !== want) {
                        problems.push(`${field} ${got} != ${want}`);
                    }
                }

                if (problems.length > 0) {
                    if (failures.length < 5) {
                        failures.push(
                            `[${patternName}] episode ${episode} frame ${frame} ` +
                            `(spawn ${spawn.map((v) => v.toFixed(0)).join(',')}, ` +
                            `t=${time}):\n    ${problems.slice(0, 6).join('\n    ')}`
                        );
                    }
                    // One divergence poisons the rest of the episode; move on.
                    episodeFailed = true;
                }
            }
        }

        // Guard against a suite that passes because nothing happened.
        expect(framesCompared, 'frames must actually have run').toBeGreaterThan(1000);

        expect(
            failures,
            `${failures.length} divergence(s) over ${framesCompared} frames\n` +
            `(airborne on ${everLeftGround} frames, peak horizontal speed ` +
            `${maxSpeedSeen.toFixed(1)} ups)\n\n` +
            failures.join('\n\n')
        ).toEqual([]);
    });
});
