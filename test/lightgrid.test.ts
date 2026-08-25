/*
 * lightgrid.test.ts -- the baked irradiance volume, and the fit to it.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Two halves, tested differently on purpose.
 *
 * The **reader** is a port of `R_LoadLightGrid` and there is a ground truth for
 * it: the lattice geometry is not stored in the file, it is recomputed, and the
 * lump length is an exact cross-check on having recomputed it right. Asserted
 * against all six shipped maps.
 *
 * The **fit** has no ground truth -- turning a sampled irradiance field back
 * into sources is an inverse problem with no unique answer -- so it is tested
 * on the properties the design claims: it closes a deficit, it does not fight
 * lights that are already there, it does not over-deliver, and it puts a light
 * on the side of the sample the light came from. Synthetic geometry, because a
 * property is easier to falsify when the answer is arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import {
    DEFAULT_GRID_SIZE,
    decodeDirection,
    gridSizeFrom,
    readLightGrid,
} from '../src/q3/bsp/LightGrid.ts';
import {
    fitGridLights,
    luma,
    sitesFromGrid,
    type GridSite,
    type SceneLight,
} from '../tools/pipeline/lightgrid.ts';

const BUILT = join(process.cwd(), 'assets', 'built');
const MAPS = ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish'];

function bspOf(name: string): BspFile {
    const raw = readFileSync(join(BUILT, name, 'collision.bsp'));
    return new BspFile(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        name
    );
}

/* ------------------------------------------------------------------ *
 * The reader
 * ------------------------------------------------------------------ */

describe('R_LoadLightGrid', () => {
    it.each(MAPS)('recomputes the lattice to the exact point count [%s]', (name) => {
        /*
         The load-bearing assertion of the whole feature.

         Nothing in the BSP says how big the lightgrid is. `bounds` comes from
         the world model's bounds snapped outward-then-inward to the cell size,
         plus one -- four chances to be off by one, and every one of them still
         decodes 8 bytes per cell into a plausible-looking sample at the wrong
         place. `readLightGrid` throws when its arithmetic disagrees with the
         lump length, so reaching this line at all is the check; the rest is
         making the numbers visible.
        */
        const grid = readLightGrid(bspOf(name));

        expect(grid, `${name} has no lightgrid`).not.toBeNull();
        if (grid === null) return;

        const [nx, ny, nz] = grid.bounds;
        expect(
            nx * ny * nz,
            `${name}: lattice ${nx}x${ny}x${nz} at ${grid.size.join(',')}`
        ).toBe(grid.count);

        // Every shipped map uses Q3's default cell size, so a change here means
        // the worldspawn key started being read (or stopped).
        expect(grid.size, `${name} gridsize`).toEqual([...DEFAULT_GRID_SIZE]);
    });

    it.each(MAPS)('places cell zero at the lattice origin and cell n at its far corner [%s]', (name) => {
        const grid = readLightGrid(bspOf(name))!;
        const [nx, ny, nz] = grid.bounds;

        for (let i = 0; i < 3; i++) {
            expect(grid.at(0).origin[i]).toBeCloseTo(grid.origin[i]!, 6);
        }

        const last = grid.at(grid.count - 1).origin;
        expect(last[0]).toBeCloseTo(grid.origin[0]! + (nx - 1) * grid.size[0]!, 6);
        expect(last[1]).toBeCloseTo(grid.origin[1]! + (ny - 1) * grid.size[1]!, 6);
        expect(last[2]).toBeCloseTo(grid.origin[2]! + (nz - 1) * grid.size[2]!, 6);
    });

    it.each(MAPS)('holds real light, not zeroes [%s]', (name) => {
        /*
         A reader that returns the right *shape* of nothing looks identical to a
         working one right up until the lighting is missing. `oa_dm5` is the map
         this feature exists for and it must be the map with samples in it.
        */
        const grid = readLightGrid(bspOf(name))!;

        let lit = 0;
        let brightest = 0;

        for (let i = 0; i < grid.count; i++) {
            const s = grid.at(i);
            const brightness = luma(s.ambient) + luma(s.directed);
            if (brightness > 0) lit += 1;
            if (brightness > brightest) brightest = brightness;
        }

        expect(lit, `${name}: cells with any light`).toBeGreaterThan(grid.count * 0.1);
        expect(brightest, `${name}: brightest cell`).toBeGreaterThan(64);
    });

    it('decodes lat/long the way R_SetupEntityLightingGrid does', () => {
        /** Component-wise, because `toEqual` distinguishes -0 from 0 and cos does not. */
        const near = (got: readonly number[], want: readonly number[]): void => {
            for (let i = 0; i < 3; i++) expect(got[i]!).toBeCloseTo(want[i]!, 6);
        };

        // lng is the polar angle from +Z and lat the azimuth, despite the names.
        // Straight up: lng = 0.
        near(decodeDirection(0, 40), [0, 0, 1]);

        // Quarter turn of polar puts it in the XY plane, at the azimuth.
        near(decodeDirection(64, 0), [1, 0, 0]);
        near(decodeDirection(64, 64), [0, 1, 0]);
        near(decodeDirection(64, 128), [-1, 0, 0]);

        // Half a turn of polar is straight down.
        near(decodeDirection(128, 0), [0, 0, -1]);

        // Always a unit vector, over the whole byte space.
        for (let lng = 0; lng < 256; lng += 7) {
            for (let lat = 0; lat < 256; lat += 11) {
                const d = decodeDirection(lng, lat);
                expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
            }
        }
    });

    it('reads an unlit cell as up rather than as a direction', () => {
        // `0, 0` is what q3map2 writes where there is no directed light, and it
        // decodes to a legal vector. Treating it as real would put a light above
        // every dark cell in the map.
        expect(decodeDirection(0, 0)).toEqual([0, 0, 1]);
    });

    it('takes gridsize off worldspawn when it is there', () => {
        expect(gridSizeFrom([{ classname: 'worldspawn', gridsize: '96 96 160' }]))
            .toEqual([96, 96, 160]);

        // ...and Q3's default when it is not, or when it is nonsense.
        expect(gridSizeFrom([{ classname: 'worldspawn' }])).toEqual([...DEFAULT_GRID_SIZE]);
        expect(gridSizeFrom([])).toEqual([...DEFAULT_GRID_SIZE]);
        expect(gridSizeFrom([{ classname: 'worldspawn', gridsize: '0 64 128' }]))
            .toEqual([...DEFAULT_GRID_SIZE]);
        expect(gridSizeFrom([{ classname: 'worldspawn', gridsize: 'wide' }]))
            .toEqual([...DEFAULT_GRID_SIZE]);
    });
});

/* ------------------------------------------------------------------ *
 * The fit
 * ------------------------------------------------------------------ */

/** Illuminance at a point from a set of lights. The fit's own arithmetic. */
function lux(lights: readonly SceneLight[], at: readonly [number, number, number]): number {
    let v = 0;
    for (const l of lights) {
        const d2 = (l.x - at[0]) ** 2 + (l.y - at[1]) ** 2 + (l.z - at[2]) ** 2;
        if (Math.sqrt(d2) > l.radius) continue;
        v += l.lumens / (4 * Math.PI) / Math.max(d2, 1e-4);
    }
    return v;
}

function site(
    at: [number, number, number],
    luxValue: number,
    toward: [number, number, number] = [0, 1, 0],
    distance = 3
): GridSite {
    return { at, toward, lux: luxValue, color: [1, 1, 1], distance };
}

describe('fitting lights to a sampled field', () => {
    it('lights a field that has no lights at all', () => {
        const sites = [
            site([0, 0, 0], 20),
            site([4, 0, 0], 20),
            site([8, 0, 0], 20),
        ];

        const fit = fitGridLights(sites, []);

        expect(fit.lights.length, 'nothing was placed').toBeGreaterThan(0);
        for (const s of sites) {
            expect(lux(fit.lights, s.at), `site ${s.at.join(',')}`).toBeGreaterThan(4);
        }
        expect(fit.residualAfter).toBeLessThan(fit.residualBefore);
    });

    it('adds nothing where the existing lights already meet the target', () => {
        /*
         The property that keeps this from ruining the four maps whose shader
         reconstruction already works. It is not a special case in the code --
         the deficit is simply negative everywhere -- and it is asserted because
         "it happens not to fire" is a claim, not a design.
        */
        const sites = [site([0, 0, 0], 10), site([2, 0, 0], 10), site([4, 0, 0], 10)];

        const generous: SceneLight[] = [
            { x: 2, y: 1, z: 0, lumens: 4000, radius: 30 },
        ];

        expect(lux(generous, [0, 0, 0])).toBeGreaterThan(10);
        expect(fitGridLights(sites, generous).lights).toEqual([]);
    });

    it('does not over-deliver, which greedy placement alone does', () => {
        /*
         Twenty-five sites in a plane, all asking for the same modest level. A
         greedy pass sizes each light against the lights placed *before* it and
         the ones after pile on top; measured on the real maps that came out two
         to three times the target. The least-squares sweeps are what stop it,
         and this is the case that fails without them.
        */
        const sites: GridSite[] = [];
        for (let x = 0; x < 5; x++) {
            for (let z = 0; z < 5; z++) sites.push(site([x * 2, 0, z * 2], 15));
        }

        const fit = fitGridLights(sites, []);
        const delivered = sites.map((s) => lux(fit.lights, s.at));
        const mean = delivered.reduce((a, b) => a + b, 0) / delivered.length;

        expect(mean, `mean delivered ${mean.toFixed(1)} lux against a target of 15`)
            .toBeLessThan(15 * 1.6);
        expect(mean).toBeGreaterThan(15 * 0.4);
    });

    it('places the light on the side the light came from', () => {
        const fit = fitGridLights([site([0, 0, 0], 30, [0, 1, 0], 4)], []);

        expect(fit.lights.length).toBe(1);
        const l = fit.lights[0]!;

        expect(l.y, 'placed below the sample instead of above it').toBeCloseTo(4, 6);
        expect(l.x).toBeCloseTo(0, 6);
        expect(l.z).toBeCloseTo(0, 6);
    });

    it('shortens the step when the way to the source is blocked', () => {
        /*
         And keeps a light. The first version put the light *on* the sample,
         which is degenerate -- sizing divides by the distance and so does
         evaluating, so at zero the least-squares pass drove the light to
         nothing and a sample flush against a wall silently got none. This case
         exists because that failed and looked like a fit that had converged.
        */
        const fit = fitGridLights([site([0, 0, 0], 30, [0, 1, 0], 4)], [], {
            blocked: () => true,
        });

        expect(fit.lights.length, 'gave up instead of stepping less far').toBe(1);

        const l = fit.lights[0]!;
        expect(l.y, 'still walked into the ceiling').toBeCloseTo(0.25, 6);
        expect(lux([l], [0, 0, 0]), 'lit the sample it was placed for')
            .toBeGreaterThan(30 * 0.5);
    });

    it('carries the sampled colour', () => {
        const red: GridSite = {
            at: [0, 0, 0], toward: [0, 1, 0], lux: 30, color: [1, 0.2, 0.1], distance: 3,
        };

        expect(fitGridLights([red], []).lights[0]!.color).toEqual([1, 0.2, 0.1]);
    });

    it('respects its own ceiling on the number of lights', () => {
        // Sixty sites far enough apart that none of them helps another.
        const sites = Array.from({ length: 60 }, (_, i) => site([i * 200, 0, 0], 30));

        expect(fitGridLights(sites, [], { maxLights: 8 }).lights.length)
            .toBeLessThanOrEqual(8);
    });
});

/* ------------------------------------------------------------------ *
 * End to end, on the map the feature exists for
 * ------------------------------------------------------------------ */

describe('sites from a real map [oa_dm5]', () => {
    const grid = readLightGrid(bspOf('oa_dm5'))!;

    const sites = sitesFromGrid(grid, {
        luxPerByte: 0.2,
        minBytes: 8,
        toScene: (q3) => [q3[0] / 32, q3[2] / 32, -q3[1] / 32],
        defaultDistance: 4,
        minDistance: 1,
        maxDistance: 16,
    });

    it('finds the lit part of a level that reconstructs to nothing from its shaders', () => {
        /*
         `oa_dm5` is the map in Q-006: 107,414 triangles and, before this,
         exactly zero reconstructed point lights, because every one of its light
         sources was a `light` entity and q3map2 deleted them all. The grid is
         the only place its lighting still exists.
        */
        expect(sites.length, 'lit cells').toBeGreaterThan(500);
        expect(sites.length, 'and not the whole lattice').toBeLessThan(grid.count);
    });

    it('estimates a source distance inside the bounds it was given', () => {
        for (const s of sites) {
            expect(s.distance).toBeGreaterThanOrEqual(1);
            expect(s.distance).toBeLessThanOrEqual(16);
        }

        // And not all the same, which is what a broken estimator returns.
        expect(new Set(sites.map((s) => s.distance.toFixed(3))).size).toBeGreaterThan(5);
    });

    it('fits a lighting solution that halves the error against the baked field', () => {
        const fit = fitGridLights(sites, []);

        expect(fit.lights.length, 'lights fitted').toBeGreaterThan(10);
        expect(
            fit.residualAfter,
            `RMS ${(fit.residualBefore * 100).toFixed(0)}% -> ` +
            `${(fit.residualAfter * 100).toFixed(0)}% of mean target`
        ).toBeLessThan(fit.residualBefore * 0.75);
    });
});
