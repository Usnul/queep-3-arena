/*
 * patch-collision.test.ts -- curved surfaces are solid.
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
 * The reported symptom was that `am_thornish`'s round columns were not
 * colliders. They were not brushes either: they are `MST_PATCH` surfaces, and
 * the collision came entirely from the brush lump, so a player walked through
 * fourteen of the eighteen columns on the map. Measured before the fix: a
 * player box swept along the axis of each one passed straight through, and
 * `pointContents` found nothing but a `BOTCLIP` hint at the centre.
 *
 * Two things have to be true, and the second is the one that is easy to lose.
 * A curved surface has to be **solid** -- that is the bug. And a *concave*
 * curved surface has to stay **open**, because the cheap way to make the first
 * one true is to hand meep the patch as a single shape, and `shape_cast`
 * collides against a shape's convex hull. That makes a column solid and an
 * archway solid too, and the second failure is much worse than the bug: the
 * corridor under the arch becomes a wall, silently, on a map that loads fine.
 *
 * So the synthetic cases below are not decoration. The flat patch pins *where*
 * the solid is, which no map-level assertion can see because putting it in the
 * wrong place still produces collision -- just four units off the surface. The
 * dome and the bowl are the same nine control points wound opposite ways, and
 * pin that the decomposition reads concavity from the drawn side rather than
 * from the shape of the point cloud.
 *
 * The two are asked opposite questions about the same winding on purpose. The
 * winding decides the *shape* -- dome or bowl -- and it decides nothing about
 * which side of a sheet is solid, because Q3's patch facets have no sides. Both
 * halves of that are load-bearing and both have a case here; see D-139.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { tessellatePatch, type PatchVertex } from '../src/q3/bsp/patch.ts';
import {
    ClipMap,
    CONTENTS,
    MASK_PLAYERSOLID,
    PLANE_STRIDE,
    type ClipMapPatch,
} from '../src/q3/cm/ClipMap.ts';
import { buildPatchHulls, patchToHulls, COLLISION_LEVEL } from '../src/q3/cm/patchHull.ts';
import { buildHulls, type BrushHull } from '../src/q3/cm/brushHull.ts';
import { createTrace, traceHullList } from '../src/q3/cm/trace.ts';
import { parseEntities, entityVector } from '../src/q3/bsp/Entities.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';

/** Q3's standing player box. */
const MINS = [-15, -15, -24];
const MAXS = [15, 15, 32];

function loadMap(name: string): ClipMap {
    const raw = readFileSync(join(process.cwd(), 'assets', 'extracted', 'maps', `${name}.bsp`));
    return new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), name)
    );
}

/** A point is inside a convex facet when it is behind every one of its planes. */
function inside(hull: BrushHull, x: number, y: number, z: number): boolean {
    for (let i = 0; i < hull.planes.length; i += 4) {
        const d =
            hull.planes[i]! * x +
            hull.planes[i + 1]! * y +
            hull.planes[i + 2]! * z -
            hull.planes[i + 3]!;
        if (d > 0) return false;
    }
    return true;
}

function solidAt(hulls: readonly BrushHull[], x: number, y: number, z: number): boolean {
    for (const hull of hulls) {
        const b = hull.bounds;
        if (x < b[0]! || y < b[1]! || z < b[2]! || x > b[3]! || y > b[4]! || z > b[5]!) continue;
        if (inside(hull, x, y, z)) return true;
    }
    return false;
}

function blank(x: number, y: number, z: number): PatchVertex {
    return { x, y, z, s: 0, t: 0, lms: 0, lmt: 0, nx: 0, ny: 0, nz: 0, r: 1, g: 1, b: 1, a: 1 };
}

/** A `ClipMapPatch` from a list of control points, row-major. */
function synthetic(
    width: number,
    height: number,
    points: readonly (readonly [number, number, number])[]
): ClipMapPatch {
    expect(points.length).toBe(width * height);
    const control = new Float32Array(width * height * 3);
    points.forEach((p, i) => {
        control[i * 3] = p[0];
        control[i * 3 + 1] = p[1];
        control[i * 3 + 2] = p[2];
    });
    return {
        surface: 0,
        width,
        height,
        control,
        contents: CONTENTS.SOLID,
        surfaceFlags: 0,
    };
}

/** The tessellation's own outward normal at the first cell, which is the drawn side. */
function drawnNormal(patch: ClipMapPatch): [number, number, number] {
    const control: PatchVertex[] = [];
    for (let i = 0; i < patch.width * patch.height; i++) {
        control.push(
            blank(patch.control[i * 3]!, patch.control[i * 3 + 1]!, patch.control[i * 3 + 2]!)
        );
    }
    const t = tessellatePatch(control, patch.width, patch.height, COLLISION_LEVEL);

    // `tessellatePatch` winds `(a, c, b)` with `b = a + 1` and `c = a + width`,
    // so the front face normal is `cross(rowStep, colStep)`.
    const a = t.vertices[0]!;
    const b = t.vertices[1]!;
    const c = t.vertices[t.width]!;
    const rx = c.x - a.x;
    const ry = c.y - a.y;
    const rz = c.z - a.z;
    const cx = b.x - a.x;
    const cy = b.y - a.y;
    const cz = b.z - a.z;
    const nx = ry * cz - rz * cy;
    const ny = rz * cx - rx * cz;
    const nz = rx * cy - ry * cx;
    const len = Math.hypot(nx, ny, nz);
    return [nx / len, ny / len, nz / len];
}

/** The same nine points with each row reversed, which reverses the winding. */
function reversedRows(
    points: readonly (readonly [number, number, number])[],
    width: number
): (readonly [number, number, number])[] {
    const out: (readonly [number, number, number])[] = [];
    for (let i = 0; i < points.length; i += width) {
        for (let k = width - 1; k >= 0; k--) out.push(points[i + k]!);
    }
    return out;
}

const FLAT: [number, number, number][] = [
    [-64, -64, 0], [0, -64, 0], [64, -64, 0],
    [-64, 0, 0], [0, 0, 0], [64, 0, 0],
    [-64, 64, 0], [0, 64, 0], [64, 64, 0],
];

describe('a flat patch', () => {
    /*
     A 3x3 control grid lying in the z = 0 plane. One facet, and the thing worth
     asserting is where its volume is: a patch is a sheet, the collider has to be
     given a thickness, and where that thickness goes decides what height a
     player stands at on every curved floor in the game.

     This used to assert that the solid went *behind the drawn side*, and that
     was the bug rather than the fix. Q3's patch facets are zero-thickness and
     collide from both faces, so a mapper has never had a reason to wind a
     collision patch one way rather than the other -- and on `am_thornish` 54% of
     the near-horizontal patch cells came out with their solid on the upward
     side, including the nodraw caps over the corner jump pads, which put the
     player four units above the pad and above its push trigger entirely. The
     shell straddles the sheet now, so the error is the standoff either way round
     rather than nothing or everything.

     The pair of cases below is the whole point: the same nine points wound both
     ways have to produce the *same* solid, because the winding is not
     information. See DECISIONS.md D-139.
    */
    const patch = synthetic(3, 3, FLAT);
    const reversed = synthetic(3, 3, reversedRows(FLAT, 3));

    it('becomes exactly one convex facet', () => {
        const out = patchToHulls(patch);
        expect(out.hulls.length).toBe(1);
        expect(out.dropped).toBe(0);
    });

    it('straddles the surface rather than hanging behind it', () => {
        const out = patchToHulls(patch);
        const [nx, ny, nz] = drawnNormal(patch);

        // A quarter unit either side of the sheet, which is inside the shell.
        expect(solidAt(out.hulls, -nx * 0.25, -ny * 0.25, -nz * 0.25)).toBe(true);
        expect(solidAt(out.hulls, nx * 0.25, ny * 0.25, nz * 0.25)).toBe(true);

        // Two units either side, which is well outside it in both directions.
        expect(solidAt(out.hulls, -nx * 2, -ny * 2, -nz * 2)).toBe(false);
        expect(solidAt(out.hulls, nx * 2, ny * 2, nz * 2)).toBe(false);
    });

    it('puts the solid in the same place wound either way', () => {
        const forward = patchToHulls(patch).hulls;
        const backward = patchToHulls(reversed).hulls;

        // The two windings genuinely are opposite, or this proves nothing.
        expect(drawnNormal(reversed)[2]).toBeCloseTo(-drawnNormal(patch)[2], 6);

        expect(backward.length).toBe(forward.length);
        for (let z = -2; z <= 2; z += 0.125) {
            expect([z, solidAt(backward, 0, 0, z)]).toEqual([z, solidAt(forward, 0, 0, z)]);
        }
    });

    it('does not extend past the control grid', () => {
        const [hull] = patchToHulls(patch).hulls;
        expect(hull).toBeDefined();
        for (let a = 0; a < 2; a++) {
            expect(hull!.bounds[a]!).toBeGreaterThanOrEqual(-65);
            expect(hull!.bounds[a + 3]!).toBeLessThanOrEqual(65);
        }
    });
});

/*
 The same nine control points, wound both ways.

 The winding no longer decides which side of a sheet is solid -- the flat pair
 above pins that it does not -- but it still decides the *shape*, and that is
 what these two are for. Wound one way these points are a dome, convex from the
 front, and one facet is the right answer. Wound the other they are a bowl you
 stand inside, and the same single facet would fill the bowl to its rim. Nothing
 distinguishes the two cases except the winding, which is why they are tested as
 a pair rather than as one example of each.
*/
const DOME: [number, number, number][] = [
    [-128, -128, 128], [0, -128, -128], [128, -128, 128],
    [-128, 0, 128], [0, 0, -128], [128, 0, 128],
    [-128, 128, 128], [0, 128, -128], [128, 128, 128],
];

/** Reversing each row reverses the winding, so the drawn side swaps. */
const BOWL = reversedRows(DOME, 3);

describe('a patch that is convex from its drawn side', () => {
    const patch = synthetic(3, 3, DOME);

    it('survives as a single facet', () => {
        const out = patchToHulls(patch);
        expect(out.hulls.length).toBe(1);
        expect(out.dropped).toBe(0);
    });

    it('is solid on the far side of the curve', () => {
        const out = patchToHulls(patch);
        // The dip bisects to z = 0 at the middle; the volume is above it.
        expect(solidAt(out.hulls, 0, 0, 20)).toBe(true);
    });
});

describe('a patch that is concave from its drawn side', () => {
    /*
     This is the archway case in miniature, and the one that decides whether
     the fix is safe to ship. Handing the whole patch to meep as one shape
     gives GJK the convex hull, which is this bowl filled level with its rim --
     and on a real map that is a corridor turned into a wall by a change whose
     stated purpose was to make columns solid.
    */
    const patch = synthetic(3, 3, BOWL);

    it('does not survive as a single facet', () => {
        const out = patchToHulls(patch);
        expect(out.hulls.length).toBeGreaterThan(1);
        expect(out.dropped).toBe(0);
    });

    it('leaves the space inside the curve open', () => {
        const out = patchToHulls(patch);

        /*
         Up the bowl's axis from just above its floor. The convex hull of this
         patch contains every one of these points; the decomposition must not.
        */
        for (const z of [20, 40, 60]) {
            expect(solidAt(out.hulls, 0, 0, z)).toBe(false);
        }
    });

    it('is still solid at the surface, and thin', () => {
        const out = patchToHulls(patch);

        /*
         The trough's wall passes through `z = 32` at `x = 64`, and the shell is
         centred on it rather than hung under it. Sampled mid-facet on purpose:
         where two facets meet at a convex crease their shells splay apart and
         leave a notch, which is not solid and a sample taken exactly on a crease
         would say so.

         The open samples are what pin the thickness. Two units under the surface
         used to be inside the shell and is now outside it, which is the whole of
         the change in `FACET_THICKNESS`: a facet that ran four units deep ran
         four units *proud* wherever the winding was the other way round.
        */
        expect(solidAt(out.hulls, 64, 0, 32)).toBe(true);
        expect(solidAt(out.hulls, 64, 0, 30)).toBe(false);
        expect(solidAt(out.hulls, 64, 0, 35)).toBe(false);
    });
});

const PATCH_MAPS = ['am_thornish', 'oa_dm5'];

/**
 * Every classname that places a player.
 *
 * `am_thornish` is a CTF map and carries no `info_player_deathmatch` at all, so
 * matching only that one silently tested nothing on the map the bug was
 * reported against -- which is why the set is spelled out and the count is
 * asserted below.
 */
const SPAWN_CLASSES = new Set([
    'info_player_deathmatch',
    'info_player_start',
    'team_CTF_redspawn',
    'team_CTF_bluespawn',
]);

for (const name of PATCH_MAPS) {
    const built = existsSync(join(process.cwd(), 'assets', 'built', name, 'collision.bsp'));

    describe(`patch facets [${name}]`, () => {
        it.skipIf(!built)('leaves no holes in the collision surface', () => {
            const cm = loadMap(name);
            const world = cm.models[0]!;
            const set = buildPatchHulls(
                cm,
                MASK_PLAYERSOLID,
                world.firstSurface,
                world.numSurfaces
            );

            expect(cm.patches.length).toBeGreaterThan(0);
            expect(set.hulls.length).toBeGreaterThan(0);
            // A dropped cell is a patch a player can walk through part of.
            expect(set.dropped).toBe(0);
        });

        it.skipIf(!built)('keeps every facet inside the map', () => {
            const cm = loadMap(name);
            const world = cm.models[0]!;
            const set = buildPatchHulls(
                cm,
                MASK_PLAYERSOLID,
                world.firstSurface,
                world.numSurfaces
            );

            /*
             `hullFromPlanes` starts each face as a quad a million units across,
             so an unbounded plane set comes back as a facet the size of the
             world rather than as a failure. The map's own bounds are the check.
            */
            for (const hull of set.hulls) {
                for (let a = 0; a < 3; a++) {
                    expect(hull.bounds[a]!).toBeGreaterThanOrEqual(world.mins[a]! - 64);
                    expect(hull.bounds[a + 3]!).toBeLessThanOrEqual(world.maxs[a]! + 64);
                }
            }
        });

        it.skipIf(!built)('does not bury a spawn point', () => {
            const cm = loadMap(name);
            const raw = readFileSync(
                join(process.cwd(), 'assets', 'extracted', 'maps', `${name}.bsp`)
            );
            const bsp = new BspFile(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                name
            );
            const world = cm.models[0]!;
            const set = buildPatchHulls(
                cm,
                MASK_PLAYERSOLID,
                world.firstSurface,
                world.numSurfaces
            );

            /*
             The over-blocking check that a map can actually answer. A facet
             that grew past the surface it came from lands somewhere a player
             is meant to stand, and a spawn point is a position the map author
             guaranteed is clear.
            */
            const spawns = parseEntities(bsp.entityString).filter((e) =>
                SPAWN_CLASSES.has(e.classname)
            );
            expect(spawns.length).toBeGreaterThan(0);

            for (const spawn of spawns) {
                const origin = entityVector(spawn, 'origin', [0, 0, 0]);
                expect(solidAt(set.hulls, origin[0]!, origin[1]!, origin[2]!)).toBe(false);
            }
        });
    });
}

describe('am_thornish round columns', () => {
    const built = existsSync(
        join(process.cwd(), 'assets', 'built', 'am_thornish', 'collision.bsp')
    );

    /*
     The columns the bug was reported against, by the centre of each one. Found
     by grouping the map's tall cylinder-ish patch surfaces by their footprint;
     all fourteen are 128 units across and about 1080 tall, in five stacked
     segments of a 9x3 control grid.
    */
    const COLUMNS: [number, number][] = [
        [-256, -1248], [-256, 1248], [0, -512], [0, 0], [0, 512],
        [256, -1536], [256, 1536], [768, -1536], [768, 1536],
        [1024, -512], [1024, 0], [1024, 512], [1280, -1248], [1280, 1248],
    ];

    it.skipIf(!built)('stop a player sweeping through them', async () => {
        const cm = loadMap('am_thornish');
        const physics = await HeadlessPhysics.create(cm);
        const trace = createTrace();

        const through: string[] = [];

        for (const [cx, cy] of COLUMNS) {
            /*
             Straight through the middle, entering from far enough out to be in
             open air. The column's radius is 64 and the player box is 30
             across, so anything that reaches the axis has passed through solid
             geometry.
            */
            const z = -100;
            physics.trace(
                trace,
                [cx - 160, cy, z],
                [cx + 160, cy, z],
                MINS,
                MAXS,
                MASK_PLAYERSOLID
            );

            const stopBefore = trace.fraction * 320 - 160;
            if (trace.fraction >= 1 || stopBefore > -20) through.push(`(${cx},${cy})`);
        }

        expect(through).toEqual([]);
    });

    it.skipIf(!built)('leave the gaps between them walkable', async () => {
        const cm = loadMap('am_thornish');
        const physics = await HeadlessPhysics.create(cm);
        const trace = createTrace();

        /*
         The columns at (0,0) and (0,512) are 512 apart with 384 units of clear
         floor between them. A decomposition that over-blocks closes that gap,
         and the map's whole middle with it.
        */
        physics.trace(trace, [0, 200, -100], [0, 312, -100], MINS, MAXS, MASK_PLAYERSOLID);
        expect(trace.fraction).toBe(1);
        expect(trace.startsolid).toBe(false);
    });
});

describe('am_thornish corner jump pads', () => {
    const built = existsSync(
        join(process.cwd(), 'assets', 'built', 'am_thornish', 'collision.bsp')
    );

    /*
     The measurement D-133 could only work around and D-139 fixes.

     Each corner pad is capped by a `SURF_NODRAW` collision patch -- a flat disc
     at z = -620 over the pad's ring skirt -- and the mapper wound it facing
     *downwards*, which no map and no version of Q3 gives them a reason not to.
     A facet hung behind its winding's front face therefore put four units of
     solid *above* the drawn surface, the player stood on the back of the slab,
     and the pad's `trigger_push` volume -- which spans exactly the four units
     from the surface upwards -- was entirely below their feet. The pad could not
     fire, and `Movers` compensated by testing push triggers against a box
     extended down by the same four units.

     Two things are asserted, and the second is the one that matters. The player
     lands on the *surface the map draws* rather than a slab above it; and where
     they land is inside the trigger, by enough that it is not a coincidence.
    */
    const PADS: [number, number][] = [
        [-432, 1456],
        [1456, 1456],
        [-432, -1456],
        [1456, -1456],
    ];

    /** Where the map draws the pad, and the floor of its push trigger. */
    const SURFACE = -620;

    /**
     * How far above the surface a resting player is left, in Q3 units.
     *
     * `FACET_STANDOFF` -- half of `FACET_THICKNESS` -- plus Q3's own
     * `SURFACE_CLIP_EPSILON`, which `PhysicsTrace` holds the box clear by. Both
     * are deliberate and neither is a tolerance to be widened here: the whole
     * point of the entry is that this number is small.
     */
    const STANDOFF = 0.5 + 0.125;

    it.skipIf(!built)('leave a player on the surface, not four units above it', async () => {
        const cm = loadMap('am_thornish');
        const physics = await HeadlessPhysics.create(cm);
        const trace = createTrace();

        for (const [x, y] of PADS) {
            // Straight down the pad's axis, from clear air well above it.
            const from = -560;
            const to = -680;
            physics.trace(trace, [x, y, from], [x, y, to], [0, 0, 0], [0, 0, 0], MASK_PLAYERSOLID);

            expect(trace.fraction, `no floor found over (${x},${y})`).toBeLessThan(1);
            const stop = from + trace.fraction * (to - from);
            expect(stop, `(${x},${y})`).toBeCloseTo(SURFACE + STANDOFF, 2);
        }
    });

    it.skipIf(!built)('put a resting player inside the push trigger', async () => {
        const cm = loadMap('am_thornish');
        const raw = readFileSync(
            join(process.cwd(), 'assets', 'extracted', 'maps', 'am_thornish.bsp')
        );
        const bsp = new BspFile(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            'am_thornish'
        );
        const physics = await HeadlessPhysics.create(cm);
        const trace = createTrace();

        const pushes = parseEntities(bsp.entityString).filter(
            (e) => e.classname === 'trigger_push' && String(e.model).startsWith('*')
        );
        expect(pushes.length).toBe(8);

        let corners = 0;

        for (const push of pushes) {
            const model = cm.models[Number(String(push.model).slice(1))];
            if (model === undefined) continue;

            const cx = (model.mins[0]! + model.maxs[0]!) / 2;
            const cy = (model.mins[1]! + model.maxs[1]!) / 2;
            if (!PADS.some(([x, y]) => Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1)) continue;
            corners += 1;

            // Drop the standing box down the pad's axis and read off the feet.
            const from = model.maxs[2]! + 64;
            const to = model.mins[2]! - 96;
            physics.trace(
                trace,
                [cx, cy, from + 24],
                [cx, cy, to + 24],
                MINS,
                MAXS,
                MASK_PLAYERSOLID
            );
            expect(trace.fraction, `nothing to stand on at (${cx},${cy})`).toBeLessThan(1);

            const feet = from + trace.fraction * (to - from);

            /*
             `MoverSystem` fires a push trigger on an exact box overlap, so the
             feet have to be under the trigger's ceiling with the box reaching
             its floor. Asserted with a unit of daylight rather than as a bare
             overlap: passing by a hundredth would be passing by luck.
            */
            expect(feet, `(${cx},${cy}) feet above the trigger`).toBeLessThan(model.maxs[2]! - 1);
            expect(feet + (MAXS[2]! - MINS[2]!), `(${cx},${cy})`).toBeGreaterThan(
                model.mins[2]! + 1
            );
        }

        expect(corners).toBe(4);
    });
});

describe('the plane-set trace', () => {
    /*
     `traceThroughPlanes` is `CM_TraceThroughBrush` rewritten to read its planes
     from an argument, because a patch facet has no brush index to reach the
     original by. A rewrite of the function every movement decision rests on is
     worth pinning to the original rather than to a description of it, so this
     hands both the *same* plane set -- every side of a real brush, verbatim --
     and demands identical output, fraction, plane and solidity flags alike.

     It has to be the same plane set. `brushToHull` keeps only the sides that
     contribute a face, and a brush's redundant sides are its bevels: dropping
     those changes the answer near an edge, in the safe direction, which is a
     property of the hull and not of this function. Comparing against the
     reduced set would fold the two together and pin neither.
    */
    const built = existsSync(join(process.cwd(), 'assets', 'built', 'oa_dm1', 'collision.bsp'));

    it.skipIf(!built)('matches CM_TraceThroughBrush exactly on the same planes', () => {
        const cm = loadMap('oa_dm1');
        const world = cm.models[0]!;
        const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

        /** Every side of a brush, in lump order, as a facet-style plane set. */
        const allSides = (brush: number): Float32Array => {
            const first = cm.brushes[brush * 3]!;
            const count = cm.brushes[brush * 3 + 1]!;
            const out = new Float32Array(count * 4);
            for (let s = 0; s < count; s++) {
                const p = cm.brushSides[(first + s) * 2]! * PLANE_STRIDE;
                out[s * 4] = cm.planes[p]!;
                out[s * 4 + 1] = cm.planes[p + 1]!;
                out[s * 4 + 2] = cm.planes[p + 2]!;
                out[s * 4 + 3] = cm.planes[p + 3]!;
            }
            return out;
        };

        // A fixed generator, so a failure is reproducible rather than seasonal.
        let seed = 987654321;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

        const viaBrush = createTrace();
        const viaPlanes = createTrace();
        let sweeps = 0;

        for (const hull of set.hulls.slice(0, 300)) {
            const b = hull.bounds;
            const cx = (b[0]! + b[3]!) / 2;
            const cy = (b[1]! + b[4]!) / 2;
            const cz = (b[2]! + b[5]!) / 2;
            const r = Math.max(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) + 64;

            const faceted = { ...hull, brush: -1, planes: allSides(hull.brush) };

            for (let k = 0; k < 12; k++) {
                const from = [
                    cx + (rnd() - 0.5) * 2 * r,
                    cy + (rnd() - 0.5) * 2 * r,
                    cz + (rnd() - 0.5) * 2 * r,
                ];
                const to = [
                    cx + (rnd() - 0.5) * 2 * r,
                    cy + (rnd() - 0.5) * 2 * r,
                    cz + (rnd() - 0.5) * 2 * r,
                ];

                traceHullList(viaBrush, cm, [hull], 1, from, to, MINS, MAXS, MASK_PLAYERSOLID);
                traceHullList(viaPlanes, cm, [faceted], 1, from, to, MINS, MAXS, MASK_PLAYERSOLID);

                sweeps += 1;

                expect(viaPlanes.fraction).toBe(viaBrush.fraction);
                expect(viaPlanes.startsolid).toBe(viaBrush.startsolid);
                expect(viaPlanes.allsolid).toBe(viaBrush.allsolid);
                expect(viaPlanes.planeDist).toBe(viaBrush.planeDist);
                for (let i = 0; i < 3; i++) {
                    expect(viaPlanes.planeNormal[i]).toBe(viaBrush.planeNormal[i]);
                }
            }
        }

        expect(sweeps).toBeGreaterThan(3000);
    });
});
