/*
 * surface-metadata.test.ts -- what a surface is made of, asked of the body.
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
 * Quake III decides whether a bullet leaves a mark inside the collision trace:
 * `CM_TraceThroughBrush` finds the side the sweep entered and reports its
 * `surfaceFlags`, and `CG_MissileHitWall` tests `SURF_NOIMPACT`. This port kept
 * that arrangement long after its trace stopped being a brush walk, so the shot
 * path opened the clipmap for a question it was already holding a physics body
 * for -- and the comment defending it claimed a broadphase "has no opinion about
 * surface flags".
 *
 * **A broadphase has whatever opinion is attached to it.** `SurfaceMetadata`
 * rides on every body built from level geometry and carries the flags per face;
 * `PhysicsTrace` reports them off the face the sweep entered. This is the two
 * halves of that as numbers: the data really is per-face and really did survive
 * the conversion, and the physics trace really does answer the question the
 * ported one used to have to.
 *
 * See D-204, and `brushHull.ts` for the loop that used to throw the flags away
 * under a comment saying they could not be carried.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { MASK_SHOT } from '../src/game/Weapons.ts';
import { brushToHull } from '../src/q3/cm/brushHull.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { SurfaceMetadata } from '../src/client/SurfaceMetadata.ts';
import { movePlanes } from '../src/client/PhysicsWorld.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';

const MAP = 'oa_dm1';

let cm: ClipMap;
let physics: HeadlessPhysics;

beforeAll(async () => {
    const raw = readFileSync(join(process.cwd(), 'assets', 'built', MAP, 'collision.bsp'));
    cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), MAP)
    );
    physics = await HeadlessPhysics.create(cm);
}, 120_000);

describe('the flags a brush carries into its hull', () => {
    it('are per face, and a real map has faces that disagree', () => {
        let hulls = 0;
        let mixed = 0;
        let flagged = 0;
        const values = new Set<number>();

        for (let brush = 0; brush < cm.numBrushes; brush++) {
            const hull = brushToHull(cm, brush);
            if (hull === null) continue;

            hulls += 1;

            expect(
                hull.sideFlags.length,
                'a hull has a flag per plane or the two are not parallel'
            ).toBe(hull.planes.length / 4);

            const first = hull.sideFlags[0]!;
            let differs = false;
            for (let i = 0; i < hull.sideFlags.length; i++) {
                const v = hull.sideFlags[i]!;
                values.add(v);
                if (v !== 0) flagged += 1;
                if (v !== first) differs = true;
            }
            if (differs) mixed += 1;
        }

        // eslint-disable-next-line no-console
        console.log(
            `[surface-metadata] ${MAP}: ${hulls} brush hulls, ${flagged} faces with flags, ` +
                `${mixed} brushes whose faces disagree, ${values.size} distinct values`
        );

        /*
         **The assertion that makes the rest of this worth anything.** A per-face
         array that is all zeros, or all the same value, would pass every other
         check in this file while carrying nothing -- which is exactly what the
         old code did, deliberately, with a comment explaining why it had to.
         A real map has brushes that are one shader on top and another on the
         sides, and if this ever reports zero the conversion has stopped carrying
         them again.
        */
        expect(mixed, 'no brush on the map has faces that differ').toBeGreaterThan(0);
        expect(values.size, 'every face on the map reports the same flags').toBeGreaterThan(1);
    });
});

describe('SurfaceMetadata', () => {
    it('picks the face a contact normal belongs to', () => {
        const meta = new SurfaceMetadata();
        // A unit box: +x, -x, +y, -y, +z, -z, with a different value on each.
        meta.planes = Float32Array.from([
            1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1,
        ]);
        meta.sideFlags = Int32Array.from([1, 2, 4, 8, 16, 32]);

        expect(meta.flagsFor(1, 0, 0)).toBe(1);
        expect(meta.flagsFor(-1, 0, 0)).toBe(2);
        expect(meta.flagsFor(0, 0, 1), 'the ceiling was read as a wall').toBe(16);
        expect(meta.flagsFor(0, 0, -1)).toBe(32);

        /*
         Off a corner, where a contact legitimately sits between two faces. The
         more aligned wins, which is the side Q3's `leadside` names -- the one
         the sweep entered through.
        */
        expect(meta.flagsFor(0.9, 0, 0.44)).toBe(1);
        expect(meta.flagsFor(0.44, 0, 0.9)).toBe(16);

        // And the whole volume at once, for a question that is not about a face.
        expect(meta.anyFlags).toBe(1 | 2 | 4 | 8 | 16 | 32);
    });

    it('answers nothing for a body with no faces, rather than throwing', () => {
        expect(new SurfaceMetadata().flagsFor(0, 0, 1)).toBe(0);
    });
});

describe('the physics trace, asked what it hit', () => {
    /**
     * A point on one face of a hull: the mean of the vertices lying on its plane.
     *
     * The winding that produced the face is not kept, but every vertex of it is
     * in `vertices` and is on the plane by construction, so averaging the ones
     * that satisfy the plane equation recovers a point inside the polygon. Convex,
     * so the mean of its corners is interior.
     */
    function faceCentre(hull: { vertices: Float32Array; planes: Float32Array }, face: number) {
        const p = face * 4;
        const nx = hull.planes[p]!;
        const ny = hull.planes[p + 1]!;
        const nz = hull.planes[p + 2]!;
        const d = hull.planes[p + 3]!;

        let cx = 0;
        let cy = 0;
        let cz = 0;
        let n = 0;

        for (let i = 0; i < hull.vertices.length; i += 3) {
            const x = hull.vertices[i]!;
            const y = hull.vertices[i + 1]!;
            const z = hull.vertices[i + 2]!;
            if (Math.abs(x * nx + y * ny + z * nz - d) > 0.1) continue;
            cx += x;
            cy += y;
            cz += z;
            n += 1;
        }

        return n < 3 ? null : { x: cx / n, y: cy / n, z: cz / n, nx, ny, nz };
    }

    /**
     * Whether two faces of this hull are equally entitled to a contact normal.
     *
     * A quarter of a degree of separation between the best and second-best
     * alignment; below that the seam is what was struck and "which face" has no
     * single answer.
     */
    function ambiguous(
        hull: { planes: Float32Array; sideFlags: Int32Array },
        normal: ArrayLike<number>
    ): boolean {
        let best = -Infinity;
        let second = -Infinity;

        for (let i = 0; i < hull.sideFlags.length; i++) {
            const p = i * 4;
            const dot =
                hull.planes[p]! * normal[0]! +
                hull.planes[p + 1]! * normal[1]! +
                hull.planes[p + 2]! * normal[2]!;
            if (dot > best) {
                second = best;
                best = dot;
            } else if (dot > second) {
                second = dot;
            }
        }

        return best - second < 1e-3;
    }

    it('reports the flags the ported clipmap trace reports, off the body', () => {
        /*
         **Aimed at the faces that carry flags, rather than fired at the map and
         hoped over.** The first version of this swept a grid straight down and
         compared what it found: 112 segments hit the same surface both ways and
         all 112 agreed -- on **zero**, because an ordinary floor has no flags.
         An agreement about nothing is what the vacuity check in this file exists
         to catch, and it caught it.

         So the segments come from the geometry: for every face on the map whose
         shader sets anything at all, a short sweep onto that face from eight
         units outside it. Which faces those are is the map's business and the
         count is printed rather than named.
        */
        const ported = createTrace();
        const meep = createTrace();

        let compared = 0;
        let agreed = 0;
        let nonZero = 0;
        let onEdge = 0;

        for (let brush = 0; brush < cm.numBrushes; brush++) {
            const hull = brushToHull(cm, brush);
            if (hull === null) continue;

            for (let face = 0; face < hull.sideFlags.length; face++) {
                if (hull.sideFlags[face] === 0) continue;

                const at = faceCentre(hull, face);
                if (at === null) continue;

                const from = [at.x + at.nx * 8, at.y + at.ny * 8, at.z + at.nz * 8];
                const to = [at.x - at.nx * 2, at.y - at.ny * 2, at.z - at.nz * 2];

                boxTrace(ported, cm, from, to, ZERO, ZERO, MASK_SHOT);
                physics.trace(meep, from, to, ZERO, ZERO, MASK_SHOT);

                if (ported.fraction >= 1 || meep.fraction >= 1) continue;
                // Only where the two stopped in the same place; a different
                // surface is a different question.
                if (Math.abs(ported.fraction - meep.fraction) > 0.02) continue;

                /*
                 **Contacts on an edge are excluded, and named rather than
                 tolerated.** The two implementations pick the face differently
                 and only agree because the answers coincide: Q3's `leadside` is
                 the plane with the largest *entering fraction*, and
                 `SurfaceMetadata` takes the plane most *aligned* with the
                 contact normal. Where the sweep lands squarely on a face those
                 are the same face. Where it lands on the seam between two, they
                 need not be, and neither is wrong -- so the comparison is over
                 the contacts where "which face" has one answer.

                 Measured before this exclusion existed: **73 of 74**, with the
                 one disagreement being exactly this. Excluding by a property of
                 the contact rather than by a pass threshold is what keeps that
                 from being a number nobody can interpret later.
                */
                if (ambiguous(hull, meep.planeNormal)) {
                    onEdge += 1;
                    continue;
                }

                compared += 1;
                if (ported.surfaceFlags === meep.surfaceFlags) agreed += 1;
                if (meep.surfaceFlags !== 0) nonZero += 1;
            }
        }

        // eslint-disable-next-line no-console
        console.log(
            `[surface-metadata] ${compared} sweeps onto a flagged face stopped in the same ` +
                `place both ways with one face to name: ${agreed} report identical flags, ` +
                `${nonZero} non-zero; ${onEdge} landed on a seam and were skipped`
        );

        expect(compared, 'no sweep landed, so this measured nothing').toBeGreaterThan(20);

        /*
         Exactly, not mostly. Both are reading the same shader off the same brush
         side; the only way they can disagree is if one of them is not reading it
         at all -- which is what the physics trace did until D-204, reporting a
         flat zero for every surface in the game.
        */
        expect(agreed, 'the physics trace does not report the surface it hit').toBe(compared);
        expect(nonZero, 'every surface reported zero, so the agreement is vacuous').toBeGreaterThan(
            0
        );
    });
});

describe("a mover's half-spaces", () => {
    it('travel with it, so a moved door is not resolved against the closed one', () => {
        /*
         **The `Transform` was moving and the planes were not.** `shape_cast`
         follows the body and finds a door where it now is; everything that then
         asks *which face* goes through `PhysicsTrace`, which keeps each body's
         `BrushHull` and applies `CM_TraceThroughBrush` to its `planes`. Those
         were written once at the authored position, so an opened door had its
         contacts ruled on against the closed one -- and `alreadyRuledOn` can
         rule a real contact out entirely, which is a player walking through a
         door that is drawn in front of them.

         A mover only translates, so the correction is exact: a plane `(n, d)`
         moved by `t` is `(n, d + n . t)`, and the normals do not move at all.
        */
        // Two faces: +x at 10, and a diagonal, so the dot product is doing work
        // rather than copying one component.
        const k = Math.SQRT1_2;
        const rest = Float32Array.from([1, 0, 0, 10, k, k, 0, 20]);
        const planes = Float32Array.from(rest);

        movePlanes(planes, rest, 5, 3, 0);

        // +x face: 10 + 5 = 15.
        expect(planes[3]).toBeCloseTo(15, 5);
        // diagonal: 20 + (5 + 3) / sqrt(2).
        expect(planes[7]).toBeCloseTo(20 + 8 * k, 5);

        // Normals untouched, which is what makes the rewrite legal in place.
        expect([planes[0], planes[1], planes[2]]).toEqual([1, 0, 0]);
        expect(planes[4]).toBeCloseTo(k, 5);

        /*
         And **from the rest planes every time**, not from the last offset: a
         mover returning to its closed position must land back on its authored
         half-spaces exactly, or a door that has opened and closed a hundred
         times has drifted a hundred times.
        */
        movePlanes(planes, rest, 0, 0, 0);
        expect([...planes]).toEqual([...rest]);
    });
});

const ZERO = [0, 0, 0];
