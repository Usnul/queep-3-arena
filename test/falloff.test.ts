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
 *   - that the curve is continuous and reaches zero at the cull, because
 *     `LiveEmitterSet` cuts a loop dead there and documents the assumption that
 *     it is already inaudible;
 *   - that every name the bank ships resolves, since the table is keyed by name
 *     with a family fallback and a typo in either is silent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    CULL_ENERGY_FRACTION,
    CULL_RADIUS_FACTOR,
    NOMINAL_FULL_VOLUME_Q3,
    cullRadiusQ3,
    falloffFor,
    fullVolumeRadiusQ3,
    sourceLevelDb,
    sphericalSpreading,
} from '../src/client/falloff.ts';

const BANK = JSON.parse(
    readFileSync(join(process.cwd(), 'assets', 'built', 'sound', 'sounds.json'), 'utf8')
) as { sounds: Record<string, string[]> };

/** `S_SpatializeOrigin`'s distance term, for comparison. */
function q3Gain(distanceQ3: number): number {
    return Math.max(0, 1 - Math.max(0, distanceQ3 - 80) * 0.0008);
}

describe('the irradiance relation the radii come from', () => {
    it('places the cull where the intensity has fallen to the stated fraction', () => {
        // I(r)/I(r0) = (r0/r)^2. The whole of CULL_RADIUS_FACTOR is this solved
        // for r, so the check is that the ratio really lands on the fraction.
        for (const fullVolume of [64, 128, 256, 362, 511]) {
            const cull = cullRadiusQ3(fullVolume);
            const intensityRatio = (fullVolume / cull) ** 2;

            expect(intensityRatio).toBeCloseTo(CULL_ENERGY_FRACTION, 10);
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

    it('reaches the cull radius at the amplitude the fraction implies', () => {
        const { fullVolumeQ3, cullQ3 } = falloffFor('impact/rocket');

        // Untapered, the curve arrives at sqrt(fraction) -- 14.1% of amplitude,
        // which is the -17 dB the cull is specified at. The taper below takes it
        // the rest of the way to zero; this is the physical value it tapers from.
        expect(fullVolumeQ3 / cullQ3).toBeCloseTo(Math.sqrt(CULL_ENERGY_FRACTION), 10);
    });
});

describe('the falloff curve', () => {
    const { fullVolumeQ3: min, cullQ3: max } = falloffFor('impact/rocket');

    it('is flat inside the full-volume radius and gone at the cull', () => {
        expect(sphericalSpreading(0, min, max)).toBe(1);
        expect(sphericalSpreading(min, min, max)).toBe(1);
        expect(sphericalSpreading(max, min, max)).toBe(0);
        expect(sphericalSpreading(max * 2, min, max)).toBe(0);
    });

    it('is 1/r over the part of the range that is not tapered', () => {
        for (const r of [1.5, 2, 3, 4].map((k) => min * k)) {
            expect(sphericalSpreading(r, min, max)).toBeCloseTo(min / r, 10);
        }
    });

    it('never rises, and has no step at the cull', () => {
        // The step is what the taper exists to remove: LiveEmitterSet stops a
        // loop leaving range with a hard cut, so a curve arriving at 14% would
        // click. Walk the whole range and hold both properties at once.
        let previous = 1;
        let largestDrop = 0;

        for (let i = 0; i <= 2000; i++) {
            const r = (max * 1.05 * i) / 2000;
            const g = sphericalSpreading(r, min, max);

            expect(g).toBeLessThanOrEqual(previous + 1e-12);
            largestDrop = Math.max(largestDrop, previous - g);
            previous = g;
        }

        // 1/2000 of the range cannot cost more than a hair of gain anywhere,
        // including across the cull itself.
        expect(largestDrop).toBeLessThan(0.01);
    });

    it('leaves everything before the taper untouched', () => {
        // The taper is the last fifth; before it the curve is exactly 1/r, so a
        // sound at three quarters of its range is unaffected by its existence.
        const r = min + (max - min) * 0.75;
        expect(sphericalSpreading(r, min, max)).toBeCloseTo(min / r, 10);
    });
});

describe('a sound at nominal level against S_SpatializeOrigin', () => {
    /*
     NOMINAL_FULL_VOLUME_Q3 is chosen to reproduce Q3's line rather than to
     replace it, so this is the check on that claim: over the range Q3's line
     covers, a nominal sound stays within 3 dB of it. Q3's own line is not a
     target beyond that -- it reaches exactly zero at 1330 units, which is the
     thing D-148 is undoing.
    */
    const { fullVolumeQ3: min, cullQ3: max } = falloffFor('player/footstep');

    it('tracks it to within 3 dB from 320 to 960 units', () => {
        for (const r of [320, 480, 640, 800, 960]) {
            const ours = sphericalSpreading(r, min, max);
            const theirs = q3Gain(r);
            const errorDb = 20 * Math.log10(ours / theirs);

            expect(Math.abs(errorDb), `${r} u: ${ours.toFixed(3)} vs ${theirs.toFixed(3)}`)
                .toBeLessThan(3);
        }
    });

    it('is still audible where Q3 has reached exactly zero', () => {
        expect(q3Gain(1330)).toBe(0);
        expect(sphericalSpreading(1330, min, max)).toBeGreaterThan(0.1);
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

        expect(falloffFor('impact/rocket').cullQ3).toBeGreaterThan(arenaQ3);
        expect(falloffFor('impact/prox').cullQ3).toBeGreaterThan(arenaQ3);

        expect(falloffFor('impact/bullet').cullQ3).toBeLessThan(arenaQ3 / 3);
        expect(falloffFor('item/hover').cullQ3).toBeLessThan(arenaQ3 / 5);
    });

    it('gives every detonation more reach than the gun that launched it', () => {
        // The shot is loud; the warhead is louder. Ordering rather than values,
        // because the values are a mix and the ordering is the physics.
        for (const [impact, weapon] of [
            ['impact/rocket', 'weapon/WP_ROCKET_LAUNCHER'],
            ['impact/rocket', 'weapon/WP_GRENADE_LAUNCHER'],
            ['impact/prox', 'weapon/WP_PROX_LAUNCHER'],
        ] as const) {
            expect(falloffFor(impact).cullQ3, `${impact} vs ${weapon}`)
                .toBeGreaterThan(falloffFor(weapon).cullQ3);
        }
    });

    it('reaches further than Q3s single range for everything loud, and less for everything small', () => {
        const q3CullQ3 = 80 + 1250;

        for (const loud of ['impact/rocket', 'impact/prox', 'weapon/WP_ROCKET_LAUNCHER',
                            'weapon/WP_RAILGUN', 'mover/door_start']) {
            expect(falloffFor(loud).cullQ3, loud).toBeGreaterThan(q3CullQ3);
        }

        for (const small of ['impact/bullet', 'impact/lightning', 'item/hover',
                             'firing/WP_CHAINGUN', 'weapon/WP_GAUNTLET']) {
            expect(falloffFor(small).cullQ3, small).toBeLessThan(q3CullQ3);
        }
    });
});
