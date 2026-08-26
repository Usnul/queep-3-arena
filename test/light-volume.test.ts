/*
 * light-volume.test.ts -- the map's lights are spheres, and this is the seam that makes them so.
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
 * `applyLightVolumes` is a workaround for GAP-030 and it has the failure mode
 * every workaround of its shape has: it reaches for objects it does not own, by
 * a correspondence nothing enforces, and when the correspondence breaks it does
 * not throw -- it silently leaves the lights as delta sources, which is exactly
 * the picture the port had before any of this. So what is asserted here is not
 * "the radius was written" but the three things that could quietly stop being
 * true:
 *
 *   - lights are matched to the bundle by *position*, and each bundle light is
 *     spent once, so a scene light that is not the map's gets nothing;
 *   - a bundle from an older conversion, which `assets/` being untracked makes
 *     an ordinary thing to have, produces a usable radius and a count that says
 *     so, rather than a NaN in the GPU light table;
 *   - the collection is invalidated, because a light changed in place after
 *     upload keeps the values it was uploaded with.
 */

import { describe, expect, it } from 'vitest';

import {
    applyLightVolumes,
    SUN_ANGULAR_RADIUS,
    type LightCollectionLike,
    type ShadeLightLike,
} from '../src/client/map/lightVolume.ts';
import type { BundleLight, BundleSun } from '../src/client/map/SceneBundle.ts';

function bundleLight(
    x: number,
    y: number,
    z: number,
    sourceRadius: number
): BundleLight {
    return { x, y, z, lumens: 1000, radius: 12, sourceRadius };
}

function point(x: number, y: number, z: number): ShadeLightLike {
    return {
        radius: 0,
        isPointLight: true,
        transform_global: { translation_x: x, translation_y: y, translation_z: z },
    };
}

function directional(): ShadeLightLike {
    return {
        radius: 0,
        isDirectionalLight: true,
        transform_global: { translation_x: 0, translation_y: 2048, translation_z: 0 },
    };
}

function collection(elements: ShadeLightLike[]): LightCollectionLike {
    return { elements, needsUpdate: false };
}

const SUN: BundleSun = { color: [1, 1, 1], intensity: 3, direction: [0, -1, 0] };

describe('sizing the lights a map brought with it', () => {
    it('gives each light the size its own bundle record carries', () => {
        const lights = [point(1, 2, 3), point(-4, 0.5, 8)];
        const scene = collection(lights);

        const report = applyLightVolumes(
            scene,
            [bundleLight(-4, 0.5, 8, 0.75), bundleLight(1, 2, 3, 0.3)],
            null
        );

        // Matched by position, not by order: the bundle is handed over reversed.
        expect(lights[0]!.radius).toBe(0.3);
        expect(lights[1]!.radius).toBe(0.75);
        expect(report).toMatchObject({ sized: 2, unmatched: 0, unclaimed: 0, stale: 0 });
    });

    it('invalidates the collection, because an uploaded light does not re-read itself', () => {
        const scene = collection([point(0, 0, 0)]);

        applyLightVolumes(scene, [bundleLight(0, 0, 0, 0.4)], null);

        expect(scene.needsUpdate).toBe(true);
    });

    it('leaves alone a light the map did not put there', () => {
        /*
         A muzzle flash or an explosion is a point light in the same collection
         and is not this pass's business -- its size is the effect's decision.
         The count is what says so out loud.
        */
        const flash = point(10, 1, 10);
        const scene = collection([point(0, 0, 0), flash]);

        const report = applyLightVolumes(scene, [bundleLight(0, 0, 0, 0.4)], null);

        expect(flash.radius).toBe(0);
        expect(report).toMatchObject({ sized: 1, unmatched: 1, unclaimed: 0 });
    });

    it('counts a bundle light that no scene light stands at', () => {
        // The failure that matters: `LightSystem3` never linked, so the picture
        // is unchanged and nothing in the engine says a word about it.
        const report = applyLightVolumes(collection([]), [bundleLight(0, 0, 0, 0.4)], null);

        expect(report).toMatchObject({ sized: 0, unmatched: 0, unclaimed: 1 });
    });

    it('spends each of two coincident bundle lights once', () => {
        const lights = [point(2, 2, 2), point(2, 2, 2)];

        const report = applyLightVolumes(
            collection(lights),
            [bundleLight(2, 2, 2, 0.2), bundleLight(2, 2, 2, 0.9)],
            null
        );

        expect(lights.map((l) => l.radius).sort()).toEqual([0.2, 0.9]);
        expect(report).toMatchObject({ sized: 2, unclaimed: 0 });
    });

    it('gives the sun an angular radius, and only when the map has one', () => {
        const withSun = directional();
        applyLightVolumes(collection([withSun]), [], SUN);
        expect(withSun.radius).toBe(SUN_ANGULAR_RADIUS);

        /*
         `disk_radius` is a sine, not a length. A quarter of a degree is small
         enough that this reads as a mistake at a glance, so it is pinned: the
         same number as a *metre* would be a light the size of a marble and the
         same number of degrees would be a sun a hundred times too small.
        */
        expect(SUN_ANGULAR_RADIUS).toBeLessThan(0.01);
        expect(SUN_ANGULAR_RADIUS).toBeGreaterThan(0.004);

        const noSun = directional();
        const report = applyLightVolumes(collection([noSun]), [], null);
        expect(noSun.radius).toBe(0);
        expect(report.suns).toBe(0);
    });

    it('survives a bundle converted before source radii existed', () => {
        const stale = { x: 0, y: 0, z: 0, lumens: 1000, radius: 12 } as unknown as BundleLight;
        const light = point(0, 0, 0);

        const report = applyLightVolumes(collection([light]), [stale], null);

        expect(Number.isFinite(light.radius), 'a NaN here reaches the GPU').toBe(true);
        expect(light.radius).toBeGreaterThan(0);
        expect(report).toMatchObject({ sized: 1, stale: 1 });
    });

    it('tolerates the float round trip a position makes through two transforms', () => {
        /*
         The bundle value is copied into a `Transform`, then recomposed into a
         `Transform64` and read back. Nothing in that path is lossy today, and
         matching on exact equality would be a test that passes until it is one.
        */
        const light = point(1.2345678, -9.87654321, 0.0000004);
        applyLightVolumes(
            collection([light]),
            [bundleLight(1.2345674, -9.87654325, 0, 0.6)],
            null
        );

        expect(light.radius).toBe(0.6);
    });
});
