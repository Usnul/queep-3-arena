/*
 * falloff.test.ts -- the distance at which each sound stops existing.
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
 * `falloff.ts` is arithmetic over a table, so all of it is checkable here. Three
 * things are worth holding:
 *
 *   - the irradiance relation itself, because the cull radius is derived from it
 *     and a radius that is not where the energy criterion says is a number
 *     somebody picked;
 *   - that the engine's own falloff reaches zero at the radii this file hands
 *     it, because `LiveEmitterSet` cuts a loop dead at `distanceMax` and
 *     documents the assumption that it is already inaudible there;
 *   - that every name the bank ships resolves, since the table is keyed by name
 *     with a family fallback and a typo in either is silent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    AUDIBLE_RADIUS_FACTOR,
    CULL_ENERGY_FRACTION,
    CULL_RADIUS_FACTOR,
    NOMINAL_FULL_VOLUME_Q3,
    audibleRadiusQ3,
    falloffFor,
    fullVolumeRadiusQ3,
    sourceLevelDb,
} from '../src/client/falloff.ts';
import { interpolate_irradiance_smith }
    from '@woosh/meep-engine/src/core/math/physics/irradiance/interpolate_irradiance_smith.js';

const BANK = JSON.parse(
    readFileSync(join(process.cwd(), 'assets', 'built', 'sound', 'sounds.json'), 'utf8')
) as { sounds: Record<string, string[]> };

describe('the irradiance relation the radii come from', () => {
    it('places the audible radius where the intensity has fallen to the stated fraction', () => {
        // I(r)/I(r0) = (r0/r)^2. The whole of AUDIBLE_RADIUS_FACTOR is this
        // solved for r, so the check is that the ratio lands on the fraction.
        for (const fullVolume of [64, 128, 256, 362, 511]) {
            const audible = audibleRadiusQ3(fullVolume);

            expect((fullVolume / audible) ** 2).toBeCloseTo(CULL_ENERGY_FRACTION, 10);
        }
    });

    it('puts distanceMax beyond the audible radius, because Smith is not 1/r', () => {
        /*
         The distinction the second wrong turn missed. Smith reaches zero at
         `distanceMax`, so handing it the audible radius as its bound would make
         the sound silent exactly where physics says it is still at -17 dB. The
         range is stretched until the two agree there instead.
        */
        expect(CULL_RADIUS_FACTOR).toBeGreaterThan(AUDIBLE_RADIUS_FACTOR);

        for (const name of ['impact/rocket', 'player/footstep', 'item/hover']) {
            const f = falloffFor(name);
            expect(f.cullQ3, name).toBeGreaterThan(f.audibleQ3);
            expect(f.audibleQ3, name).toBeGreaterThan(f.fullVolumeQ3);
        }
    });

    it('keeps the cull fraction inside the 1-3% band it was specified from', () => {
        expect(CULL_ENERGY_FRACTION).toBeGreaterThanOrEqual(0.01);
        expect(CULL_ENERGY_FRACTION).toBeLessThanOrEqual(0.03);
    });

    it('doubles the radius for every doubling of amplitude', () => {
        /*
         Amplitude goes as 1/r, so twice the amplitude is twice the radius, and
         twice the amplitude is 20*log10(2) = 6.0206 dB. The table is written in
         round 6 dB steps, which is a factor of 1.9953 -- a doubling to within a
         quarter of a percent, and near enough that reading the table as
         doublings is right. Asserted exactly here so the relation is pinned and
         the rounding is visible rather than assumed away.
        */
        const doubling = 20 * Math.log10(2);

        expect(fullVolumeRadiusQ3(doubling)).toBeCloseTo(NOMINAL_FULL_VOLUME_Q3 * 2, 10);
        expect(fullVolumeRadiusQ3(-doubling)).toBeCloseTo(NOMINAL_FULL_VOLUME_Q3 / 2, 10);
        expect(fullVolumeRadiusQ3(0)).toBe(NOMINAL_FULL_VOLUME_Q3);

        expect(fullVolumeRadiusQ3(6) / NOMINAL_FULL_VOLUME_Q3).toBeCloseTo(1.9953, 4);
    });

    it('reaches the audible radius at the amplitude the fraction implies', () => {
        const { fullVolumeQ3, audibleQ3 } = falloffFor('impact/rocket');

        // sqrt(fraction) is 14.1% of amplitude, which is the -17 dB the audible
        // radius is specified at.
        expect(fullVolumeQ3 / audibleQ3).toBeCloseTo(Math.sqrt(CULL_ENERGY_FRACTION), 10);
    });
});

describe('the engine falloff over the radii this file supplies', () => {
    /*
     `interpolate_irradiance_smith` is the curve `Audio.describe` builds with, so
     it is the one asserted here. The falloff is meep's and is not this file's to
     choose -- what is checked is that the radii handed to it produce a curve the
     rest of the engine can rely on.
    */
    const { fullVolumeQ3: min, cullQ3: max } = falloffFor('impact/rocket');
    const gain = (r: number): number => interpolate_irradiance_smith(r, min, max);

    it('is flat inside the full-volume radius', () => {
        expect(gain(0)).toBe(1);
        expect(gain(min / 2)).toBe(1);
        expect(gain(min)).toBe(1);
    });

    it('is at the cull energy exactly at the audible radius', () => {
        // The calibration, end to end: the curve the engine evaluates arrives at
        // -17 dB precisely where the irradiance relation says the sound has
        // 2% of its energy left. This is what CULL_RADIUS_FACTOR is solved for.
        const { audibleQ3 } = falloffFor('impact/rocket');

        expect(gain(audibleQ3)).toBeCloseTo(Math.sqrt(CULL_ENERGY_FRACTION), 6);
    });

    it('tracks true spherical spreading to within 2 dB over the audible span', () => {
        /*
         Smith is a bounded approximation of an inverse square law, and given the
         range above it behaves as one: over the whole span anyone can hear the
         sound, the rendered level is 1/r. Past the audible radius it rolls off
         faster than physics, which is the trade a bounded curve makes and is
         confined to a tail nobody can hear.
        */
        const { fullVolumeQ3, audibleQ3 } = falloffFor('impact/rocket');

        for (let r = fullVolumeQ3; r <= audibleQ3; r += 25) {
            const errorDb = 20 * Math.log10(gain(r) / (fullVolumeQ3 / r));

            expect(Math.abs(errorDb), `${r.toFixed(0)} u`).toBeLessThan(2);
        }
    });

    it('reaches exactly zero at the cull, so the hard cut there is silent', () => {
        // LiveEmitterSet stops a loop leaving range with a cut rather than a
        // fade, on the documented assumption that gain is already ~0 past
        // distanceMax. Smith reaching zero at max is what makes that true, and
        // is why nothing here needs a taper of its own.
        expect(gain(max)).toBe(0);
        expect(gain(max * 2)).toBe(0);
        expect(gain(max * 0.999)).toBeLessThan(0.001);
    });

    it('never rises', () => {
        let previous = 1;

        for (let i = 0; i <= 2000; i++) {
            const g = gain((max * 1.05 * i) / 2000);
            expect(g).toBeLessThanOrEqual(previous + 1e-12);
            previous = g;
        }
    });

    it('makes a detonation louder than a nominal sound at every shared distance', () => {
        // The whole point of a per-sound range: at any given place in the world
        // the warhead is the louder thing, which one shared range cannot say.
        const nominal = falloffFor('player/footstep');

        for (const r of [400, 700, 1000, 1500, 1800]) {
            const ordinary = interpolate_irradiance_smith(r, nominal.fullVolumeQ3, nominal.cullQ3);

            expect(gain(r), `${r} u`).toBeGreaterThan(ordinary);
        }
    });

    it('keeps a detonation audible where a nominal sound has been culled', () => {
        /*
         The reported fault, as an assertion. A nominal sound is gone at its own
         cull, and a rocket landing at that distance has to still be a thing you
         hear -- clear of sopra's -60 dB virtualisation floor by a wide margin,
         not merely non-zero.
        */
        const nominal = falloffFor('player/footstep');
        const beyond = nominal.cullQ3 + 1;

        expect(interpolate_irradiance_smith(beyond, nominal.fullVolumeQ3, nominal.cullQ3)).toBe(0);
        expect(20 * Math.log10(gain(beyond))).toBeGreaterThan(-30);
    });
});

describe('the source level table', () => {
    it('resolves every name in the sound bank', () => {
        const names = Object.keys(BANK.sounds);
        expect(names.length).toBeGreaterThan(90);

        for (const name of names) {
            const level = sourceLevelDb(name);
            expect(Number.isFinite(level), `${name} has no level`).toBe(true);

            const { fullVolumeQ3, cullQ3 } = falloffFor(name);
            expect(fullVolumeQ3, name).toBeGreaterThan(0);
            expect(cullQ3, name).toBeGreaterThan(fullVolumeQ3);
        }
    });

    it('falls back to the family for a name the maps supply', () => {
        // convert-sounds.ts reads target_speaker and worldspawn names out of the
        // built maps, so this set is open and cannot be listed in the table.
        expect(sourceLevelDb('world/firesoft')).toBe(sourceLevelDb('world'));
        expect(sourceLevelDb('world/a_name_no_map_has_yet')).toBe(sourceLevelDb('world'));
    });

    it('falls back to nominal for a family it does not know', () => {
        expect(sourceLevelDb('nonesuch/thing')).toBe(0);
        expect(falloffFor('nonesuch/thing').fullVolumeQ3).toBe(NOMINAL_FULL_VOLUME_Q3);
    });

    it('carries a detonation across the largest map and a ricochet across a room', () => {
        /*
         The two facts the table is spaced by, as an assertion rather than a
         comment. A Q3 arena is about 100 m corner to corner; 32 units is a
         metre. An explosion has to cross that and a bullet impact must not, or
         a firefight two rooms away is indistinguishable from one in this room.
        */
        const arenaQ3 = 100 * 32;

        expect(falloffFor('impact/rocket').audibleQ3).toBeGreaterThan(arenaQ3);
        expect(falloffFor('impact/prox').audibleQ3).toBeGreaterThan(arenaQ3);

        expect(falloffFor('impact/bullet').audibleQ3).toBeLessThan(arenaQ3 / 3);
        expect(falloffFor('item/hover').audibleQ3).toBeLessThan(arenaQ3 / 5);
    });

    it('gives every detonation more reach than the gun that launched it', () => {
        // The shot is loud; the warhead is louder. Ordering rather than values,
        // because the values are a mix and the ordering is the physics.
        for (const [impact, weapon] of [
            ['impact/rocket', 'weapon/WP_ROCKET_LAUNCHER'],
            ['impact/rocket', 'weapon/WP_GRENADE_LAUNCHER'],
            ['impact/prox', 'weapon/WP_PROX_LAUNCHER'],
        ] as const) {
            expect(falloffFor(impact).audibleQ3, `${impact} vs ${weapon}`)
                .toBeGreaterThan(falloffFor(weapon).audibleQ3);
        }
    });

    it('separates loud from quiet around the single range the port used to have', () => {
        /*
         Not a claim about Q3 -- the port runs meep's mixer and this file is not
         trying to be `S_SpatializeOrigin`. 1250 units is simply the one range
         every sound in the game shared before D-149, so it is the useful place
         to check that the table actually spreads things out rather than moving
         them all in one direction.
        */
        const previousRangeQ3 = 1250;

        for (const loud of ['impact/rocket', 'impact/prox', 'weapon/WP_ROCKET_LAUNCHER',
                            'weapon/WP_RAILGUN', 'mover/door_start']) {
            expect(falloffFor(loud).audibleQ3, loud).toBeGreaterThan(previousRangeQ3);
        }

        for (const small of ['impact/bullet', 'impact/lightning', 'item/hover',
                             'firing/WP_CHAINGUN', 'weapon/WP_GAUNTLET']) {
            expect(falloffFor(small).audibleQ3, small).toBeLessThan(previousRangeQ3);
        }
    });
});
