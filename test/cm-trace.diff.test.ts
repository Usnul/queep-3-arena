/*
 * cm-trace.diff.test.ts -- differential test: TypeScript CM_BoxTrace vs the C.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 *
 * ---
 *
 * Traces are tested before movement is, because a movement divergence caused by
 * a trace divergence is very hard to attribute: pmove issues up to ten traces a
 * frame and clips velocity against their planes, so one wrong contact normal
 * becomes a metre of position error twenty frames later. Proving the trace first
 * turns that into a two-stage bisection.
 *
 * Cases are randomised but seeded, so a failure is reproducible from the seed
 * printed in the message.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, pointContents, createTrace } from '../src/q3/cm/trace.ts';
import { Oracle } from './oracle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Maps with **zero** `MST_PATCH` surfaces, so the port's missing patch collision
 * (D-017) cannot mask a real divergence in what *is* ported. 25 of the 72 maps in
 * the OA set qualify; these five span two orders of magnitude of brush count and
 * include both tight indoor geometry and a large open one.
 *
 * Patch-bearing maps get their own suite once patch collision exists.
 */
const MAPS = ['oa_dm1', 'aggressor', 'oa_dm2', 'q3dm6ish', 'islanddm'] as const;

function bspPath(map: string): string {
    return join(ROOT, 'assets', 'extracted', 'maps', `${map}.bsp`);
}

/** Player bounding box, `bg_public.h`. */
const PLAYER_MINS = [-15, -15, -24] as const;
const PLAYER_MAXS = [15, 15, 32] as const;

/**
 * Divergence thresholds.
 *
 * They were both **zero** until D-174: the port reproduced the C's `float`
 * rounding step for step, so the two agreed bit for bit and there was no reason
 * to allow slack. The arithmetic is float64 now, and these are the measured cost
 * of that -- 100,000 sweeps over the five maps below, the port before the change
 * against the port after it, which is the same comparison as against the C
 * because the before was bit-exact:
 *
 * | quantity                              | worst of 100,000 |
 * |---------------------------------------|------------------|
 * | `fraction`                            | 1.0e-5           |
 * | `endpos`, any component               | 1.6e-2 units     |
 * | `allsolid` / `startsolid` disagreeing | 0                |
 * | hit vs miss disagreeing               | 0                |
 * | `contents` disagreeing                | 0                |
 * | plane normal off by > 1e-4            | 0                |
 *
 * So the *discrete* answers -- did it hit, what did it hit, is the box inside
 * something -- are still compared exactly, and are the assertions that matter:
 * a trace bug changes which brush was hit, not the fifth decimal of where.
 * `endpos` gets the looser bound of the two because it is
 * `start + fraction * (end - start)`, so a fraction error is multiplied by the
 * sweep length, and `islanddm` is 20,000 units across.
 *
 * Both are still four orders of magnitude below anything a real bug produces.
 */
const FRACTION_TOLERANCE = 1e-4;
const POSITION_TOLERANCE = 0.1;

/**
 * Inputs are rounded to float32 before either side sees them.
 *
 * The oracle receives its coordinates through `HEAPF32`, so whatever the
 * generator produced arrives there already rounded to 32 bits. Handing the
 * TypeScript port the unrounded float64 would mean the two are not being given
 * the same trace, and `endpos` would differ for a reason that has nothing to do
 * with the port. This survives D-174 because it is about the *inputs*: the
 * port's arithmetic is float64 now, but both sides still have to start from the
 * same numbers.
 */
const asF32 = (v: number): number => Math.fround(v);

/** Mulberry32 -- small, seedable, and identical run to run. */
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

describe.each(MAPS)('CM_BoxTrace differential [%s]', (MAP) => {
    let oracle: Oracle;
    let cm: ClipMap;
    let worldMin: [number, number, number];
    let worldMax: [number, number, number];

    beforeAll(async () => {
        const BSP_PATH = bspPath(MAP);

        if (!existsSync(BSP_PATH)) {
            throw new Error(
                `missing ${BSP_PATH}\nrun: npm run setup`
            );
        }

        oracle = await Oracle.create();
        oracle.loadBsp(BSP_PATH);

        const raw = readFileSync(BSP_PATH);
        const bsp = new BspFile(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            MAP
        );
        cm = new ClipMap(bsp);

        const world = bsp.models[0]!;
        worldMin = [...world.mins] as [number, number, number];
        worldMax = [...world.maxs] as [number, number, number];
    });

    it('loads the same collision data as the engine', () => {
        expect(cm.models.length).toBe(oracle.numInlineModels);
        // The chosen map must have no patches, or the comparison below is
        // testing the port's known gap rather than its correctness.
        expect(cm.numPatches).toBe(0);
    });

    it('agrees on randomised player-sized sweeps', () => {
        const rand = rng(0x51ee7);
        const N = 20_000;

        let compared = 0;
        let hits = 0;
        const failures: string[] = [];

        const out = createTrace();

        for (let i = 0; i < N; i++) {
            const inBounds = (): [number, number, number] => [
                asF32(worldMin[0] + rand() * (worldMax[0] - worldMin[0])),
                asF32(worldMin[1] + rand() * (worldMax[1] - worldMin[1])),
                asF32(worldMin[2] + rand() * (worldMax[2] - worldMin[2])),
            ];

            const start = inBounds();

            // Mix long sweeps across the level with short ones typical of a
            // movement frame -- the short ones are where the epsilon handling
            // matters and the long ones are where the tree walk does.
            const end: [number, number, number] =
                rand() < 0.5
                    ? inBounds()
                    : [
                          asF32(start[0] + (rand() - 0.5) * 64),
                          asF32(start[1] + (rand() - 0.5) * 64),
                          asF32(start[2] + (rand() - 0.5) * 64),
                      ];

            const expected = oracle.boxTrace(start, PLAYER_MINS, PLAYER_MAXS, end, MASK_PLAYERSOLID);
            boxTrace(out, cm, start, end, PLAYER_MINS, PLAYER_MAXS, MASK_PLAYERSOLID);

            compared += 1;
            if (expected.fraction < 1) hits += 1;

            const problems: string[] = [];

            if (out.allsolid !== expected.allsolid) {
                problems.push(`allsolid ${out.allsolid} != ${expected.allsolid}`);
            }
            if (out.startsolid !== expected.startsolid) {
                problems.push(`startsolid ${out.startsolid} != ${expected.startsolid}`);
            }
            // Exact, and before the tolerance: "stopped at 0.99999" and "went
            // all the way" are different answers, not nearly-equal ones, and a
            // tolerance on `fraction` alone would read them as agreement.
            if ((out.fraction === 1) !== (expected.fraction === 1)) {
                problems.push(
                    `hit/miss: fraction ${out.fraction} vs ${expected.fraction}`
                );
            }
            if (Math.abs(out.fraction - expected.fraction) > FRACTION_TOLERANCE) {
                problems.push(`fraction ${out.fraction} != ${expected.fraction}`);
            }
            for (let k = 0; k < 3; k++) {
                if (Math.abs(out.endpos[k]! - expected.endpos[k]!) > POSITION_TOLERANCE) {
                    problems.push(`endpos[${k}] ${out.endpos[k]} != ${expected.endpos[k]}`);
                }
            }
            // The plane only means anything when something was hit.
            if (expected.fraction < 1 && !expected.allsolid) {
                for (let k = 0; k < 3; k++) {
                    if (Math.abs(out.planeNormal[k]! - expected.planeNormal[k]!) > 1e-4) {
                        problems.push(
                            `normal[${k}] ${out.planeNormal[k]} != ${expected.planeNormal[k]}`
                        );
                    }
                }
            }
            if (out.contents !== expected.contents) {
                problems.push(`contents ${out.contents} != ${expected.contents}`);
            }

            if (problems.length > 0 && failures.length < 8) {
                failures.push(
                    `case ${i}: start=[${start.map((v) => v.toFixed(3))}] ` +
                    `end=[${end.map((v) => v.toFixed(3))}]\n    ${problems.join('\n    ')}`
                );
            }
        }

        // A suite where nothing ever hit anything would pass trivially.
        expect(hits, 'randomised sweeps must actually hit geometry').toBeGreaterThan(compared * 0.1);

        expect(
            failures,
            `${failures.length} divergence(s) of ${compared} sweeps (seed 0x51ee7):\n` +
            failures.join('\n')
        ).toEqual([]);
    });

    /**
     * Position tests -- `start == end`.
     *
     * This case has its own code path in the C (`CM_PositionTest` ->
     * `CM_BoxLeafnums_r` -> `CM_TestBoxInBrush`) and randomised sweeps never
     * generate it, so for a while it was completely untested. Two real bugs were
     * hiding there, and both were found by the *pmove* suite instead, as a
     * crouched player who could never stand up: `PM_CheckDuck` probes headroom
     * with exactly this degenerate trace.
     */
    it('agrees on position tests (start == end)', () => {
        const rand = rng(0x9051);
        const N = 20_000;

        const failures: string[] = [];
        let solidCount = 0;

        const out = createTrace();

        for (let i = 0; i < N; i++) {
            const p: [number, number, number] = [
                asF32(worldMin[0] + rand() * (worldMax[0] - worldMin[0])),
                asF32(worldMin[1] + rand() * (worldMax[1] - worldMin[1])),
                asF32(worldMin[2] + rand() * (worldMax[2] - worldMin[2])),
            ];

            // Alternate standing and crouched boxes: the stand-up probe uses the
            // standing box from a position the crouched one fits in, which is
            // precisely where the boundary behaviour matters.
            const maxs = i % 2 === 0 ? PLAYER_MAXS : ([15, 15, 16] as const);

            const expected = oracle.boxTrace(p, PLAYER_MINS, maxs, p, MASK_PLAYERSOLID);
            boxTrace(out, cm, p, p, PLAYER_MINS, maxs, MASK_PLAYERSOLID);

            if (expected.allsolid) solidCount += 1;

            const problems: string[] = [];
            if (out.allsolid !== expected.allsolid) {
                problems.push(`allsolid ${out.allsolid} != ${expected.allsolid}`);
            }
            if (out.startsolid !== expected.startsolid) {
                problems.push(`startsolid ${out.startsolid} != ${expected.startsolid}`);
            }
            if (out.fraction !== expected.fraction) {
                problems.push(`fraction ${out.fraction} != ${expected.fraction}`);
            }
            if (out.contents !== expected.contents) {
                problems.push(`contents ${out.contents} != ${expected.contents}`);
            }

            if (problems.length > 0 && failures.length < 8) {
                failures.push(
                    `case ${i}: p=[${p.map((v) => v.toFixed(3))}] maxs_z=${maxs[2]}\n    ` +
                    problems.join('\n    ')
                );
            }
        }

        expect(solidCount, 'some sampled boxes must land in solid').toBeGreaterThan(0);
        expect(failures, failures.join('\n')).toEqual([]);
    });

    it('agrees on point contents', () => {
        const rand = rng(0xc047e);
        const N = 20_000;

        const failures: string[] = [];
        let nonZero = 0;

        for (let i = 0; i < N; i++) {
            const p: [number, number, number] = [
                asF32(worldMin[0] + rand() * (worldMax[0] - worldMin[0])),
                asF32(worldMin[1] + rand() * (worldMax[1] - worldMin[1])),
                asF32(worldMin[2] + rand() * (worldMax[2] - worldMin[2])),
            ];

            const expected = oracle.pointContents(p);
            const actual = pointContents(cm, p[0], p[1], p[2]);

            if (expected !== 0) nonZero += 1;

            if (actual !== expected && failures.length < 8) {
                failures.push(
                    `case ${i}: p=[${p.map((v) => v.toFixed(3))}] ` +
                    `got 0x${(actual >>> 0).toString(16)} want 0x${(expected >>> 0).toString(16)}`
                );
            }
        }

        expect(nonZero, 'sampled points must land inside brushes sometimes').toBeGreaterThan(0);
        expect(failures, failures.join('\n')).toEqual([]);
    });
});
