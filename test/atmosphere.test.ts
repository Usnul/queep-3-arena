/*
 * atmosphere.test.ts -- a preset is four numbers off a table, and every way of getting it wrong is silent.
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
 * `attachWorldAtmosphere` writes one transform and one component, and nothing
 * downstream of it validates either. Shade poses its unit cube by whatever
 * transform it is handed and the shader multiplies by whatever density it is
 * given, so a box built inside out, a density off by two orders of magnitude
 * and a particle whose diameter falls outside the phase-function LUT all render
 * a picture rather than raising anything. What is asserted here is the set of
 * things that can quietly stop being true:
 *
 *   - **the particle is applied before the extinction.** `target_extinction` is
 *     a setter that divides by the *current* particle's cross-section, so the
 *     two writes do not commute -- and the wrong order is a factor of 250 in
 *     density with no symptom but a wall of white;
 *   - **every preset names an entry that exists.** `MieParticleName` is
 *     `keyof typeof MIE_PARTICLES_STANDARD_PRECOMPUTED`, so a typo is a compile
 *     error today; this is the guard for the day the table is widened to
 *     `string`, or built from something the compiler cannot see;
 *   - **every particle's diameter is inside the Jendersie-d'Eon bake range.**
 *     Outside it, `jendersie_deon_get_fog_params` clamps, and the medium
 *     silently scatters like a particle it is not;
 *   - **the extinctions stay in the city-haze band.** This shipped once at
 *     0.005/m, which Koschmieder calls fog, and the report was that it looked
 *     like fog;
 *   - **the box stays much larger than the map and much smaller than the far
 *     plane.** Both bounds are load-bearing and they pull opposite ways: too
 *     small and the medium's own edge is in frame, too large and a sky ray
 *     accumulates enough haze to repaint the skybox;
 *   - **the Q3 -> meep axis swap negates *and reverses* the y interval**, whose
 *     mistake is a box in the mirrored half of the map or one with a negative
 *     extent.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EntityComponentDataset }
    from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ParticipatingMedia }
    from '@woosh/meep-engine/src/engine/graphics3/ParticipatingMedia.js';
import { MIE_PARTICLES_STANDARD_PRECOMPUTED }
    from '@woosh/meep-engine/src/core/math/physics/mie/MIE_PARTICLES_STANDARD_PRECOMPUTED.js';
import { rgb_to_luminance } from '@woosh/meep-engine/src/core/color/rgb_to_luminance.js';
import {
    FOG_PARAMETERS_JENDERSIE_DEON_PARTICLE_DIAMETER_MAX as PHASE_D_MAX,
} from '@woosh/meep-engine/src/shade/renderer/shader/chunk/atmosphere/phase/jd/FOG_PARAMETERS_JENDERSIE_DEON_PARTICLE_DIAMETER_MAX.js';
import {
    FOG_PARAMETERS_JENDERSIE_DEON_PARTICLE_DIAMETER_MIN as PHASE_D_MIN,
} from '@woosh/meep-engine/src/shade/renderer/shader/chunk/atmosphere/phase/jd/FOG_PARAMETERS_JENDERSIE_DEON_PARTICLE_DIAMETER_MIN.js';

import {
    atmosphereFor,
    attachWorldAtmosphere,
    mediumFor,
    skyOpticalDepthOf,
    visibilityOf,
    worldBoxOf,
    DEFAULT_ATMOSPHERE,
    EXTINCTION_MAX,
    EXTINCTION_MIN,
    FADE_DISTANCE,
    MAP_ATMOSPHERE,
    WORLD_MARGIN,
    type AtmospherePreset,
} from '../src/client/Atmosphere.ts';
import { CAMERA_CLIP_FAR } from '../src/client/lens.ts';
import type { SceneBundle } from '../src/client/map/SceneBundle.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/**
 * Every map the pipeline has actually built, read off disk rather than listed.
 *
 * A hardcoded list would pass forever after a map was added and never given an
 * atmosphere, which is the failure this is here to catch.
 */
const BUILT_MAPS = readdirSync(BUILT).filter((name) => {
    const dir = join(BUILT, name);
    if (!statSync(dir).isDirectory()) return false;
    try {
        return statSync(join(dir, 'collision.bsp')).isFile();
    } catch {
        return false;
    }
});

function loadBundle(name: string): SceneBundle {
    return JSON.parse(readFileSync(join(BUILT, name, 'scene.json'), 'utf8')) as SceneBundle;
}

/** A bundle carrying nothing but a name and the world's bounds. */
function bundleWithWorld(
    minsQ3: number[],
    maxsQ3: number[],
    { worldScale = 1 / 32, name = 'test_map' } = {}
): SceneBundle {
    return {
        name,
        worldScale,
        submodels: [
            // Model 1 first, so a reader taking `submodels[0]` gets a mover's
            // bounds instead of the world's.
            { model: 1, meshes: [], minsQ3: [0, 0, 0], maxsQ3: [1, 1, 1], numBrushes: 1 },
            { model: 0, meshes: [], minsQ3, maxsQ3, numBrushes: 1 },
        ],
    } as unknown as SceneBundle;
}

const PARTICLES = MIE_PARTICLES_STANDARD_PRECOMPUTED as unknown as Record<
    string,
    { radius: number; cross_section_extinction: number[]; cross_section_scattering: number[]; g: number }
>;

/** Every preset that ships, the default included. */
const ALL_PRESETS: [string, AtmospherePreset][] = [
    ['<default>', DEFAULT_ATMOSPHERE],
    ...Object.entries(MAP_ATMOSPHERE),
];

describe('the preset table', () => {
    it('covers every map the pipeline has built', () => {
        expect(BUILT_MAPS.length).toBeGreaterThan(0);

        for (const map of BUILT_MAPS) {
            expect(
                Object.prototype.hasOwnProperty.call(MAP_ATMOSPHERE, map),
                `${map} has no atmosphere and would silently take the default`
            ).toBe(true);
        }
    });

    it('names no map the pipeline does not build', () => {
        // The other direction: a renamed map leaves a preset behind that reads
        // as tuned and is reaching nothing.
        for (const map of Object.keys(MAP_ATMOSPHERE)) {
            expect(BUILT_MAPS, `${map} is in the table but is not a built map`)
                .toContain(map);
        }
    });

    describe.each(ALL_PRESETS)('%s', (_label, preset) => {
        it('names a particle that exists in meep\'s library', () => {
            expect(Object.keys(PARTICLES)).toContain(preset.particle);
        });

        it('sits inside the city-haze band', () => {
            expect(preset.extinction).toBeGreaterThanOrEqual(EXTINCTION_MIN);
            expect(preset.extinction).toBeLessThanOrEqual(EXTINCTION_MAX);
        });

        it('has a particle the phase function can actually look up', () => {
            /*
             `jendersie_deon_get_fog_params` clamps its argument into the range
             its lookup texture was baked over. A particle outside it renders
             with the phase of the nearest one that is inside, so the preset
             says one thing and the picture shows another, with nothing
             anywhere to say so.
            */
            const diameterMicron = PARTICLES[preset.particle]!.radius * 2 * 1e6;

            expect(diameterMicron).toBeGreaterThan(PHASE_D_MIN);
            expect(diameterMicron).toBeLessThan(PHASE_D_MAX);
        });

        it('leaves the sky to the map', () => {
            /*
             The one part of the box's size that reaches a frame. Above about
             0.4 the skybox stops being the map's -- `oa_dm7`'s courtyard goes
             from blue to mauve at 600 m of margin -- and below about 0.05 there
             is no aerial perspective on it at all.
            */
            const tau = skyOpticalDepthOf(preset);

            expect(tau).toBeGreaterThan(0.05);
            expect(tau).toBeLessThan(0.4);
        });

        it('carries a note saying why', () => {
            expect(preset.why.length).toBeGreaterThan(0);
        });
    });

    it('falls back to the default for a map it does not name', () => {
        expect(atmosphereFor('some_locally_converted_map')).toBe(DEFAULT_ATMOSPHERE);
        expect(atmosphereFor('am_thornish')).toBe(MAP_ATMOSPHERE['am_thornish']);
    });

    it('is not reachable through a prototype key', () => {
        // `MAP_ATMOSPHERE[map] ?? DEFAULT` would hand back Object.prototype's
        // own member for a map called `constructor` or `toString`.
        expect(atmosphereFor('constructor')).toBe(DEFAULT_ATMOSPHERE);
        expect(atmosphereFor('toString')).toBe(DEFAULT_ATMOSPHERE);
    });
});

describe('building the medium', () => {
    describe.each(ALL_PRESETS)('%s', (_label, preset) => {
        it('reaches the density its own particle implies, not the default particle\'s', () => {
            /*
             The regression that matters. `ParticipatingMedia` is constructed
             holding meep's fog droplet, whose luminous cross-section is
             1.68e-10; continental haze is 6.67e-13, 250 times smaller. Writing
             `target_extinction` before swapping the particle leaves the fog
             density in place, and the medium then extinguishes 250x what the
             preset asked for -- which is not fog, it is a solid white wall, and
             it raises nothing.
            */
            const particle = PARTICLES[preset.particle]!;
            const expected = preset.extinction
                / rgb_to_luminance(...(particle.cross_section_extinction as [number, number, number]));

            const medium = mediumFor(preset);

            expect(medium.density / expected).toBeCloseTo(1, 9);
            expect(medium.target_extinction).toBeCloseTo(preset.extinction, 12);
        });

        it('copies the library entry rather than referencing it', () => {
            /*
             The arrays inside `MIE_PARTICLES_STANDARD_PRECOMPUTED` are not
             frozen. Two media built from one entry that shared its arrays would
             be one medium wearing two hats, and tuning either would retune both.
            */
            const a = mediumFor(preset);
            const b = mediumFor(preset);

            expect(a.particle_spec.extinction).not.toBe(b.particle_spec.extinction);
            expect(a.particle_spec.extinction)
                .not.toBe(PARTICLES[preset.particle]!.cross_section_extinction);

            a.particle_spec.extinction[0] = 123;
            expect(b.particle_spec.extinction[0]).not.toBe(123);
            expect(PARTICLES[preset.particle]!.cross_section_extinction[0]).not.toBe(123);
        });

        it('carries the library entry\'s own g and radius', () => {
            const particle = PARTICLES[preset.particle]!;
            const medium = mediumFor(preset);

            expect(medium.particle_spec.g).toBe(particle.g);
            expect(medium.particle_spec.radius).toBe(particle.radius);
        });

        it('gives a density that is finite, positive and usable', () => {
            const medium = mediumFor(preset);

            expect(Number.isFinite(medium.density)).toBe(true);
            expect(medium.density).toBeGreaterThan(0);
            expect(medium.fade_distance).toBe(FADE_DISTANCE);
        });
    });

    it('throws on a particle that is not in the library', () => {
        expect(() => mediumFor({
            particle: 'NOT_A_PARTICLE' as AtmospherePreset['particle'],
            extinction: 0.001,
            why: 'test',
        })).toThrow(/MIE_PARTICLES_STANDARD_PRECOMPUTED/);
    });

    it('reports visibility by Koschmieder', () => {
        // 0.001/m is very nearly 4 km, which is what a weather report calls haze.
        expect(visibilityOf(0.001)).toBeCloseTo(3912, 6);
        expect(visibilityOf(0.005)).toBeLessThan(1000);
    });
});

describe('the world box', () => {
    it('swaps Q3 y and z, and reverses y rather than only negating it', () => {
        /*
         Deliberately asymmetric on every axis, so a box built from the wrong
         pair -- or the right pair in the wrong order -- cannot pass by landing
         on the same numbers. In Q3 units: x in [-64, 320], y in [-128, 640],
         z in [-32, 96].
        */
        const box = worldBoxOf(bundleWithWorld([-64, -128, -32], [320, 640, 96]))!;

        expect(box).not.toBeNull();

        // meep x is Q3 x: [-2, 10] m, centre 4, extent 12.
        expect(box.centre[0]).toBeCloseTo(4, 10);
        expect(box.size[0]).toBeCloseTo(12 + WORLD_MARGIN * 2, 10);

        // meep y is Q3 z: [-1, 3] m, centre 1, extent 4.
        expect(box.centre[1]).toBeCloseTo(1, 10);
        expect(box.size[1]).toBeCloseTo(4 + WORLD_MARGIN * 2, 10);

        /*
         meep z is *minus* Q3 y, so [-4, 20] m becomes [-20, 4] m: centre -8,
         extent 24. Negating without reversing gives centre +8 -- the box in the
         mirrored half of the map -- and taking `-minsQ3` as the low end gives
         extent -24, an inside-out box that renders as no fog at all.
        */
        expect(box.centre[2]).toBeCloseTo(-8, 10);
        expect(box.size[2]).toBeCloseTo(24 + WORLD_MARGIN * 2, 10);
    });

    it('takes model 0 rather than the first submodel listed', () => {
        const box = worldBoxOf(bundleWithWorld([-64, -128, -32], [320, 640, 96]))!;

        expect(box.size[0]).toBeGreaterThan(WORLD_MARGIN * 2 + 1);
    });

    it('is null when the bundle predates submodels, rather than guessing a size', () => {
        expect(worldBoxOf({ worldScale: 1 / 32 } as unknown as SceneBundle)).toBeNull();
        expect(
            worldBoxOf({ worldScale: 1 / 32, submodels: [] } as unknown as SceneBundle)
        ).toBeNull();
    });

    it('uses the bundle\'s own worldScale rather than a repeated constant', () => {
        const box = worldBoxOf(bundleWithWorld([0, 0, 0], [64, 64, 64], { worldScale: 1 / 64 }))!;

        expect(box.size[0]).toBeCloseTo(1 + WORLD_MARGIN * 2, 10);
    });

    it('keeps the taper outside anything that is stood in', () => {
        expect(FADE_DISTANCE).toBeLessThan(WORLD_MARGIN);
    });

    it('is much larger than any map, and still well inside the far plane', () => {
        /*
         Both halves matter and they pull opposite ways. Large, because that is
         what was asked for and because a box ending where the geometry does
         puts the medium's own edge in frame. Not *unbounded*, because a sky ray
         runs to the far plane and 600 m of haze in front of an environment map
         that already contains a sky charges twice for the same air -- which is
         a colour grade over the map rather than depth in it. See WORLD_MARGIN.
        */
        expect(WORLD_MARGIN).toBeGreaterThanOrEqual(100);
        expect(WORLD_MARGIN).toBeLessThan(CAMERA_CLIP_FAR / 2);
    });

    describe.each(BUILT_MAPS)('%s', (name) => {
        const bundle = loadBundle(name);
        const world = bundle.submodels!.find((s) => s.model === 0)!;
        const box = worldBoxOf(bundle)!;
        const scale = bundle.worldScale;

        const lo = [
            world.minsQ3[0]! * scale,
            world.minsQ3[2]! * scale,
            -world.maxsQ3[1]! * scale,
        ];
        const hi = [
            world.maxsQ3[0]! * scale,
            world.maxsQ3[2]! * scale,
            -world.minsQ3[1]! * scale,
        ];

        it('contains the map with the margin clear on all six faces', () => {
            for (let axis = 0; axis < 3; axis++) {
                const half = box.size[axis]! * 0.5;

                expect(box.centre[axis]! - half).toBeCloseTo(lo[axis]! - WORLD_MARGIN, 6);
                expect(box.centre[axis]! + half).toBeCloseTo(hi[axis]! + WORLD_MARGIN, 6);
            }
        });

        it('is much larger than the map on every axis', () => {
            /*
             "Much larger" as a number rather than as a word. The tightest of
             the six by this measure is `am_thornish`'s long axis, 128 m of map
             inside a 328 m box; the loosest is `oa_dm1`'s height, 19 m inside
             219. Two and a half times is the floor that holds for all of them.
            */
            for (let axis = 0; axis < 3; axis++) {
                const mapExtent = hi[axis]! - lo[axis]!;

                expect(box.size[axis]! / mapExtent).toBeGreaterThan(2.5);
            }
        });

        it('never lets a view ray inside the map reach the far face', () => {
            /*
             What the margin buys where it matters. A player standing anywhere
             in the map has {@link WORLD_MARGIN} of medium in front of him
             before its edge, in every direction -- so the taper is never in
             frame at close range and the medium looks unbounded from inside a
             room. It stops well short of the far plane on purpose: that is the
             sky's budget, checked separately as the preset's sky optical depth.
            */
            for (let axis = 0; axis < 3; axis++) {
                const half = box.size[axis]! * 0.5;

                expect(lo[axis]! - (box.centre[axis]! - half)).toBeCloseTo(WORLD_MARGIN, 6);
                expect((box.centre[axis]! + half) - hi[axis]!).toBeCloseTo(WORLD_MARGIN, 6);
            }
        });
    });
});

describe('attaching the atmosphere', () => {
    function attach(bundle: SceneBundle, preset?: AtmospherePreset) {
        const ecd = new EntityComponentDataset();
        ecd.registerComponentType(Transform);

        const report = preset === undefined
            ? attachWorldAtmosphere(ecd, bundle)
            : attachWorldAtmosphere(ecd, bundle, preset);

        return { ecd, report };
    }

    it('poses the volume as position = centre and scale = full extent', () => {
        /*
         Not half-extent. Shade's `ParticipatingMediaVolume` is a *unit* cube,
         so the transform's scale is the box's size outright.
        */
        const { ecd, report } = attach(bundleWithWorld([-64, -128, -32], [320, 640, 96]));

        expect(report).not.toBeNull();

        const transform = ecd.getComponent(report!.entity, Transform) as Transform;

        expect(transform.position.x).toBeCloseTo(report!.box.centre[0], 10);
        expect(transform.position.y).toBeCloseTo(report!.box.centre[1], 10);
        expect(transform.position.z).toBeCloseTo(report!.box.centre[2], 10);

        expect(transform.scale.x).toBeCloseTo(report!.box.size[0], 10);
        expect(transform.scale.y).toBeCloseTo(report!.box.size[1], 10);
        expect(transform.scale.z).toBeCloseTo(report!.box.size[2], 10);
    });

    it('picks the preset off the bundle\'s own name', () => {
        const { report } = attach(
            bundleWithWorld([0, 0, 0], [64, 64, 64], { name: 'am_thornish' })
        );

        expect(report!.preset).toBe(MAP_ATMOSPHERE['am_thornish']);
        expect(report!.extinction).toBeCloseTo(MAP_ATMOSPHERE['am_thornish']!.extinction, 12);
    });

    it('lets a caller override the preset', () => {
        const preset: AtmospherePreset = {
            particle: 'SMOKE_PARTICLE_MEDIUM',
            extinction: 0.0011,
            why: 'test',
        };

        const { ecd, report } = attach(bundleWithWorld([0, 0, 0], [64, 64, 64]), preset);
        const medium = ecd.getComponent(report!.entity, ParticipatingMedia) as ParticipatingMedia;

        expect(report!.preset).toBe(preset);
        expect(medium.particle_spec.g).toBe(PARTICLES['SMOKE_PARTICLE_MEDIUM']!.g);
        expect(medium.target_extinction).toBeCloseTo(0.0011, 12);
    });

    it('reports what was applied rather than what was asked for', () => {
        const { ecd, report } = attach(
            bundleWithWorld([0, 0, 0], [64, 64, 64], { name: 'oa_dm1' })
        );
        const medium = ecd.getComponent(report!.entity, ParticipatingMedia) as ParticipatingMedia;

        expect(report!.density).toBe(medium.density);
        expect(report!.extinction).toBe(medium.target_extinction);
        expect(report!.visibility).toBeCloseTo(visibilityOf(medium.target_extinction), 9);
    });

    it('registers the component type, since nothing else in the port uses it', () => {
        const ecd = new EntityComponentDataset();
        ecd.registerComponentType(Transform);

        expect(ecd.isComponentTypeRegistered(ParticipatingMedia)).toBe(false);

        attachWorldAtmosphere(ecd, bundleWithWorld([0, 0, 0], [64, 64, 64]));

        expect(ecd.isComponentTypeRegistered(ParticipatingMedia)).toBe(true);
    });

    it('attaches nothing when the bundle cannot size the box', () => {
        const ecd = new EntityComponentDataset();
        ecd.registerComponentType(Transform);

        expect(attachWorldAtmosphere(ecd, { name: 'x', worldScale: 1 / 32 } as unknown as SceneBundle))
            .toBeNull();

        expect(ecd.isComponentTypeRegistered(ParticipatingMedia)).toBe(false);
    });

    describe.each(BUILT_MAPS)('%s', (name) => {
        it('attaches its own preset with a sane density', () => {
            const { ecd, report } = attach(loadBundle(name));

            expect(report).not.toBeNull();
            expect(report!.preset).toBe(MAP_ATMOSPHERE[name]);

            const medium = ecd.getComponent(report!.entity, ParticipatingMedia) as ParticipatingMedia;

            expect(Number.isFinite(medium.density)).toBe(true);
            expect(medium.density).toBeGreaterThan(0);
            expect(medium.target_extinction).toBeCloseTo(MAP_ATMOSPHERE[name]!.extinction, 12);

            /*
             Koschmieder: haze, not fog. Fog is under a kilometre by definition
             and mist under two; the band's own ceiling is what this checks
             against, so the two cannot drift apart.
            */
            expect(report!.visibility).toBeGreaterThanOrEqual(visibilityOf(EXTINCTION_MAX));
            expect(report!.visibility).toBeGreaterThan(1000);
        });
    });
});
