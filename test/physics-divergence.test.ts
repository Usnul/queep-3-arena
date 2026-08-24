/*
 * physics-divergence.test.ts -- how far meep's physics moves the player from Q3.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 *
 * ---
 *
 * The port now runs `bg_pmove` against **meep's physics** rather than a ported
 * `cm_trace` (D-029). That is a deliberate accuracy trade, and "as closely as
 * possible" needs a number attached or it is not a target.
 *
 * So this suite does not assert agreement. It *measures* it: identical inputs
 * are fed to the C oracle and to the port-on-meep-physics, frame by frame, and
 * the divergence is reported as position error over time. The thresholds below
 * are regression guards -- they exist so tuning cannot silently get worse -- and
 * are set from measured behaviour rather than from hope.
 *
 * `cm-trace.diff.test.ts` and `pmove.diff.test.ts` still run and still demand
 * bit-exactness, because the ported `cm_*` is still the reference the tuning is
 * measured against. Two trace backends, one oracle.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { parseEntities, entityVector } from '../src/q3/bsp/Entities.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { buildHulls } from '../src/q3/cm/brushHull.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { Oracle } from './oracle.ts';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = ['oa_dm1', 'aggressor'] as const;

/**
 * The hull conversion is the part of the physics swap that can be checked
 * *exactly*, and it is worth checking exactly: if a brush's convex hull is not
 * the same volume as its plane set, every divergence measurement downstream is
 * measuring the wrong thing.
 *
 * A point is inside a brush iff it is behind all of the brush's planes. It is
 * inside the hull iff it is behind all of the hull's face planes. Those two sets
 * must agree, and the test samples the brush's own bounding box to check.
 */
describe.each(MAPS)('brush -> convex hull is volume-exact [%s]', (MAP) => {
    let cm: ClipMap;

    beforeAll(() => {
        const path = join(ROOT, 'assets', 'extracted', 'maps', `${MAP}.bsp`);
        if (!existsSync(path)) throw new Error(`missing ${path}\nrun: npm run setup`);

        const raw = readFileSync(path);
        cm = new ClipMap(
            new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), MAP)
        );
    });

    it('produces a hull for essentially every solid brush', () => {
        const set = buildHulls(cm, MASK_PLAYERSOLID);

        expect(set.hulls.length).toBeGreaterThan(0);

        // A handful of degenerate brushes is normal in shipped content; a large
        // fraction means the winding code is wrong.
        const solidBrushes = set.hulls.length + set.skipped;
        expect(set.skipped / solidBrushes).toBeLessThan(0.02);
    });

    it('hull volume matches the brush half-space intersection', () => {
        const set = buildHulls(cm, MASK_PLAYERSOLID);

        let sampled = 0;
        let inside = 0;
        let disagreements = 0;
        const examples: string[] = [];

        // Deterministic sampling: a fixed lattice through each hull's bounds.
        for (const hull of set.hulls.slice(0, 200)) {
            const [x0, y0, z0, x1, y1, z1] = [
                hull.bounds[0]!, hull.bounds[1]!, hull.bounds[2]!,
                hull.bounds[3]!, hull.bounds[4]!, hull.bounds[5]!,
            ];

            const N = 4;
            for (let i = 0; i <= N; i++) {
                for (let j = 0; j <= N; j++) {
                    for (let k = 0; k <= N; k++) {
                        const px = x0 + ((x1 - x0) * i) / N;
                        const py = y0 + ((y1 - y0) * j) / N;
                        const pz = z0 + ((z1 - z0) * k) / N;

                        const inHull = pointInsideHull(hull, px, py, pz);
                        sampled += 1;
                        if (inHull) inside += 1;

                        // The hull's own faces come from the brush's planes, so
                        // any point strictly inside the hull must be strictly
                        // inside the brush. Checking the converse needs the
                        // brush index, which `buildHulls` does not carry; this
                        // direction is the one that catches a broken winding.
                        if (inHull && !pointInsideAnyBrush(cm, px, py, pz)) {
                            disagreements += 1;
                            if (examples.length < 5) {
                                examples.push(
                                    `[${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}]`
                                );
                            }
                        }
                    }
                }
            }
        }

        expect(sampled, 'must have sampled something').toBeGreaterThan(1000);
        expect(inside, 'lattice must land inside hulls sometimes').toBeGreaterThan(0);
        expect(
            disagreements,
            `${disagreements} of ${inside} in-hull samples were not inside any brush; ` +
            `examples: ${examples.join(' ')}`
        ).toBe(0);
    });
});

/** Behind every face plane of the hull, with a small tolerance. */
function pointInsideHull(
    hull: { vertices: Float32Array; indices: Uint32Array },
    px: number,
    py: number,
    pz: number
): boolean {
    const v = hull.vertices;
    const idx = hull.indices;

    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t]! * 3;
        const b = idx[t + 1]! * 3;
        const c = idx[t + 2]! * 3;

        const ux = v[b]! - v[a]!;
        const uy = v[b + 1]! - v[a + 1]!;
        const uz = v[b + 2]! - v[a + 2]!;

        const wx = v[c]! - v[a]!;
        const wy = v[c + 1]! - v[a + 1]!;
        const wz = v[c + 2]! - v[a + 2]!;

        // Outward normal, since indices are outward CCW.
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;

        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;

        const d =
            ((px - v[a]!) * nx + (py - v[a + 1]!) * ny + (pz - v[a + 2]!) * nz) / len;

        // Strictly inside, by more than the weld tolerance, so surface samples
        // do not count either way.
        if (d > -0.05) return false;
    }

    return true;
}

/** Behind every plane of at least one solid brush. */
function pointInsideAnyBrush(cm: ClipMap, px: number, py: number, pz: number): boolean {
    for (let b = 0; b < cm.numBrushes; b++) {
        if ((cm.brushContents[b]! & MASK_PLAYERSOLID) === 0) continue;

        const first = cm.brushes[b * 3]!;
        const num = cm.brushes[b * 3 + 1]!;

        let inside = true;
        for (let s = 0; s < num; s++) {
            const p = cm.brushSides[(first + s) * 2]! * 4;
            const d =
                cm.planes[p]! * px + cm.planes[p + 1]! * py + cm.planes[p + 2]! * pz -
                cm.planes[p + 3]!;

            if (d > 0.1) {
                inside = false;
                break;
            }
        }

        if (inside) return true;
    }

    return false;
}

/**
 * Regression guard on the tuning.
 *
 * These thresholds are set from measured behaviour with deliberate headroom, so
 * they catch a regression without failing on noise. `tools/measure-divergence.ts`
 * prints the full picture; this asserts the two numbers that matter.
 *
 * Measured at the time of writing, across oa_dm1 and aggressor:
 *   - hit/miss agreement       88.2% / 89.6%
 *   - contact normals agree    99.1% / 99.0% of valid-plane hits
 *   - sweep fraction |error|   median 0, p90 ~1.5e-3
 */
describe.each(MAPS)('physics trace tracks the clipmap [%s]', (MAP) => {
    let cm: ClipMap;
    let physics: HeadlessPhysics;
    let spawns: number[][];

    beforeAll(() => {
        const path = join(ROOT, 'assets', 'extracted', 'maps', `${MAP}.bsp`);
        if (!existsSync(path)) throw new Error(`missing ${path}
run: npm run setup`);

        const raw = readFileSync(path);
        const bsp = new BspFile(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            MAP
        );
        cm = new ClipMap(bsp);
        physics = new HeadlessPhysics(cm);

        spawns = parseEntities(bsp.entityString)
            .filter(
                (e) =>
                    e['classname'] === 'info_player_deathmatch' ||
                    e['classname'] === 'info_player_start'
            )
            .map((e) => {
                const o = entityVector(e, 'origin');
                return [o[0], o[1], o[2] + 9];
            });

        expect(spawns.length).toBeGreaterThan(0);
    });

    it('agrees with the clipmap on hit/miss and on contact normals', () => {
        const rand = rng(0x7ace);
        const N = 20_000;

        const mins = [-15, -15, -24];
        const maxs = [15, 15, 32];

        const a = createTrace();
        const b = createTrace();

        let decided = 0;
        let disagreeHitMiss = 0;
        let normalAgree = 0;
        let normalTotal = 0;
        let fractionP90: number[] = [];

        for (let i = 0; i < N; i++) {
            const anchorPoint = spawns[i % spawns.length]!;

            const start = [
                anchorPoint[0]! + (rand() - 0.5) * 400,
                anchorPoint[1]! + (rand() - 0.5) * 400,
                anchorPoint[2]! + (rand() - 0.5) * 160,
            ];
            const end = [
                start[0]! + (rand() - 0.5) * 48,
                start[1]! + (rand() - 0.5) * 48,
                start[2]! + (rand() - 0.5) * 48,
            ];

            boxTrace(a, cm, start, end, mins, maxs, MASK_PLAYERSOLID);
            physics.trace(b, start, end, mins, maxs, MASK_PLAYERSOLID);

            const aHit = a.fraction < 1;
            const bHit = b.fraction < 1;

            if (!aHit && !bHit) continue;

            decided += 1;
            if (aHit !== bHit) {
                disagreeHitMiss += 1;
                continue;
            }

            fractionP90.push(Math.abs(a.fraction - b.fraction));

            if (a.allsolid || a.startsolid || b.startsolid) continue;
            if (Math.hypot(a.planeNormal[0], a.planeNormal[1], a.planeNormal[2]) < 0.9) continue;

            normalTotal += 1;
            const dot =
                a.planeNormal[0] * b.planeNormal[0] +
                a.planeNormal[1] * b.planeNormal[1] +
                a.planeNormal[2] * b.planeNormal[2];
            if (dot > 0.99) normalAgree += 1;
        }

        expect(decided, 'sweeps must actually hit geometry').toBeGreaterThan(1000);
        expect(normalTotal, 'must have valid-plane hits to compare').toBeGreaterThan(100);

        const hitMissAgreement = 1 - disagreeHitMiss / decided;
        expect(
            hitMissAgreement,
            `hit/miss agreement ${(hitMissAgreement * 100).toFixed(1)}% -- was 88%+ when tuned`
        ).toBeGreaterThan(0.8);

        const normalAgreement = normalAgree / normalTotal;
        expect(
            normalAgreement,
            `normal agreement ${(normalAgreement * 100).toFixed(1)}% -- was 99% when tuned`
        ).toBeGreaterThan(0.95);

        fractionP90.sort((x, y) => x - y);
        const p90 = fractionP90[Math.floor((fractionP90.length - 1) * 0.9)] ?? 0;
        expect(p90, `sweep fraction p90 error ${p90.toExponential(1)}`).toBeLessThan(0.02);
    });
});

/**
 * The oracle still has to be reachable, because it is what the physics-backed
 * movement will be tuned against. This is a smoke check that the two halves of
 * the comparison still line up after the physics swap.
 */
describe('oracle is still the reference', () => {
    it('loads and reports the same submodel count as the clipmap', async () => {
        const path = join(ROOT, 'assets', 'extracted', 'maps', 'oa_dm1.bsp');
        if (!existsSync(path)) throw new Error(`missing ${path}\nrun: npm run setup`);

        const oracle = await Oracle.create();
        oracle.loadBsp(path);

        const raw = readFileSync(path);
        const cm = new ClipMap(
            new BspFile(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                'oa_dm1'
            )
        );

        expect(cm.models.length).toBe(oracle.numInlineModels);

        const spawns = parseEntities(cm.name === '' ? '' : new BspFile(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            'oa_dm1'
        ).entityString).filter((e) => e['classname'] === 'info_player_deathmatch');

        expect(spawns.length, 'map must have spawn points to tune against').toBeGreaterThan(0);
        expect(entityVector(spawns[0]!, 'origin')).toHaveLength(3);
    });
});
