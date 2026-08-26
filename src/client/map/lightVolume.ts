/*
 * lightVolume.ts -- give the map's lights the size the renderer wants them to have.
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
 * Shade's lights are spheres. `Light.radius` is "how big is the light source,
 * used for area lighting calculations", it reaches the GPU as
 * `PointLight.radius` / `DirectionalLight.disk_radius`, and three separate
 * parts of the shading path read it:
 *
 * - `light_sphere_distance_attenuation` caps the inverse-square falloff at
 *   `1 / r^2` once the receiver is at or inside the emitter, instead of running
 *   away to the 1 cm floor it uses when there is no radius;
 * - `re_direct_physical` takes `sin(theta_source)` from it, bends the specular
 *   lobe to the representative point on the sphere and widens the roughness by
 *   the source's solid angle, instead of a mirror-sharp point highlight;
 * - the same value drives the soft-horizon wrap that replaces `saturate(N.L)`,
 *   and the SDF shadow tracer's penumbra for the sun.
 *
 * All three are off at `radius = 0`, which is what a map's lights get, because
 * **the ECS `Light` component has no source-size field** -- `LightSystem3`
 * copies colour, intensity, shadow flag, cone angle, penumbra and distance onto
 * Shade's light and there is nothing to copy for extent. See GAP-030.
 *
 * So the size is applied here, to Shade's own lights, after `loadMap` has built
 * the entities the engine's system mirrors. The association is by position: a
 * map light's translation is the `x, y, z` of the bundle record it came from,
 * copied through two transforms unchanged. Anything else in the collection --
 * an effect's light, if one has been raised by the time this runs -- stands at
 * no bundle position, is left alone, and is counted.
 */

import type { BundleLight, BundleSun } from './SceneBundle.ts';

/** The part of Shade's `Light` this needs. `radius` is the source's extent. */
export interface ShadeLightLike {
    radius: number;
    readonly isPointLight?: boolean;
    readonly isDirectionalLight?: boolean;
    readonly transform_global: {
        readonly translation_x: number;
        readonly translation_y: number;
        readonly translation_z: number;
    };
}

/** The part of Shade's `LightCollection` this needs. */
export interface LightCollectionLike {
    readonly elements: readonly ShadeLightLike[];
    needsUpdate: boolean;
}

export interface LightVolumeReport {
    /** Point lights that were matched to a bundle light and sized. */
    readonly sized: number;
    /** Point lights in the collection that no bundle light stands at. */
    readonly unmatched: number;
    /** Bundle lights with no light in the collection standing at them. */
    readonly unclaimed: number;
    /** Directional lights given the sun's angular radius. */
    readonly suns: number;
    /** Bundle lights that carried no `sourceRadius`; see `volumeOf`. */
    readonly stale: number;
}

/**
 * Angular radius of the sun, taken from `make_sunlight`.
 *
 * Not a length: a directional light's `disk_radius` is `sin(theta)` for the
 * half-angle the source subtends, so this is 0.37 of a degree. The true figure
 * is 0.0046 -- the solar radius over one astronomical unit, a quarter of a
 * degree -- and the engine's is a little generous against it. Its number rather
 * than the textbook one because it is the sun every other meep scene is lit by,
 * and because on this side of the argument generous means a softer shadow edge,
 * which is the direction a Q3 arena wants.
 *
 * The one number here that is the same on every map: `q3map_sun` says which way
 * the sun is and how bright, and nothing anywhere says how big, because there
 * is only one right answer for how big the sun is.
 *
 * It buys the penumbra. The sun is the one light in a converted map that casts
 * shadows, and at zero every shadow edge in the level is a hard line.
 */
export const SUN_ANGULAR_RADIUS = 0.006475;

/**
 * What a light gets when the bundle does not say.
 *
 * `assets/` is not in the repository, so a checkout whose maps were converted
 * before source radii existed is an ordinary thing to have rather than a
 * hypothetical. Writing `undefined` into `radius` puts a NaN in the GPU light
 * table, which is the kind of failure that shows up as "the lighting looks
 * wrong" three days later, so a stale bundle gets the size a fitted light would
 * have had (`GRID_SOURCE_RADIUS`, kept as a literal because the pipeline is
 * Node's side of the fence) and the caller gets a count it can complain about.
 */
const FALLBACK_SOURCE_RADIUS = 0.25;

/**
 * Millimetre buckets. Two distinct light fixtures are never this close.
 *
 * Bucketed rather than compared exactly because nothing promises the position
 * survives `Transform` and `Transform64` bit for bit -- today it does, and a
 * test that only passes while that holds is a test that will one day stop
 * meaning anything. The residual risk is a value astride a bucket boundary,
 * which cannot happen while the round trip is exact and which surfaces as an
 * `unmatched` count rather than as a wrong radius if it ever does.
 */
function key(x: number, y: number, z: number): string {
    return `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

/** False for a bundle written before source radii existed, or a corrupt one. */
function hasVolume(light: BundleLight): boolean {
    return Number.isFinite(light.sourceRadius) && light.sourceRadius > 0;
}

function volumeOf(light: BundleLight): number {
    return hasVolume(light) ? light.sourceRadius : FALLBACK_SOURCE_RADIUS;
}

/**
 * Size every light in `lights` that this map put there.
 *
 * @param lights Shade's light collection, i.e. `EngineHarness.shadeScene(engine).lights`
 * @param bundleLights `bundle.lights`, in any order
 * @param sun `bundle.sun`; when null the map has no directional light to size
 */
export function applyLightVolumes(
    lights: LightCollectionLike,
    bundleLights: readonly BundleLight[],
    sun: BundleSun | null
): LightVolumeReport {
    /*
     A queue per position rather than a single entry, so that two bundle lights
     that landed in the same millimetre are consumed once each and the counts
     below stay a partition. Coincident lights are not expected -- the surface
     clusterer merges anything within three metres -- but "not expected" and
     "counted wrongly if it happens" are different states.
    */
    const wanted = new Map<string, number[]>();
    let stale = 0;

    for (const light of bundleLights) {
        if (!hasVolume(light)) stale += 1;

        const k = key(light.x, light.y, light.z);
        const queue = wanted.get(k);

        if (queue === undefined) wanted.set(k, [volumeOf(light)]);
        else queue.push(volumeOf(light));
    }

    let sized = 0;
    let unmatched = 0;
    let suns = 0;

    for (const light of lights.elements) {
        if (light.isDirectionalLight === true) {
            // The map's sun, and nothing else adds one. A map without a
            // `q3map_sun` has no directional light for this to be about.
            if (sun !== null) {
                light.radius = SUN_ANGULAR_RADIUS;
                suns += 1;
            }
            continue;
        }

        if (light.isPointLight !== true) continue;

        const t = light.transform_global;
        const queue = wanted.get(key(t.translation_x, t.translation_y, t.translation_z));
        const radius = queue?.shift();

        if (radius === undefined) {
            unmatched += 1;
            continue;
        }

        light.radius = radius;
        sized += 1;
    }

    let unclaimed = 0;
    for (const queue of wanted.values()) unclaimed += queue.length;

    /*
     A light already uploaded to the GPU keeps the values it was uploaded with:
     the table is rebuilt only when the collection's version moves, and changing
     a light in place does not move it. `LightSystem3` says the same thing about
     its own writes, in more words.
    */
    if (sized > 0 || suns > 0) lights.needsUpdate = true;

    return { sized, unmatched, unclaimed, suns, stale };
}
