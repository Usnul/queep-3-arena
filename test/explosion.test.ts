/*
 * explosion.test.ts -- how big a detonation's flash is, and what colour it is.
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
 * `Effects.explosion` answered two questions with one constant each, for every
 * weapon in the game alike: 12,000 lumens of light, and a warm particle ramp.
 * Both were authored against a rocket and neither said so, so a plasma bolt --
 * whose blast is a sixth of a rocket's across and whose every other colour is
 * blue -- lit the room as hard as a rocket and threw an orange fireball while
 * doing it. D-163 corrected the flash's *hue*; this is the other two thirds.
 *
 * Two rules replace the two constants, and each is pinned here by the property
 * that makes it a rule rather than a second tuning:
 *
 *   - **flux goes with the square of the radius**, so illuminance at the edge of
 *     a flash is the same for every weapon and only the size of the lit sphere
 *     moves. The rocket is unchanged by construction, which is what keeps
 *     `muzzleFlash.ts`'s whole lumens column -- scaled against "the explosion's
 *     12,000 lm" through D-115, D-160 and D-161 -- still measured against the
 *     thing it was measured against.
 *   - **the fireball's hue is measured off Q3's artwork and its brightness is
 *     not.** `extract-explosion-colors.ts` reads the additive stages of the
 *     shader `CG_MissileHitWall` names per weapon; the runtime carries each
 *     measured chromaticity to the luminance the tuned ramp had at that stop.
 *     The substitution is therefore brightness-preserving by construction, and
 *     the check that it is *sound* is that the rocket comes back as the ramp
 *     that was authored for it.
 *
 * See D-166.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { ParticleEmitter } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleEmitter.js';
import { ParticleParameters } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleParameters.js';

import { Effects } from '../src/client/Effects.ts';
import { Shadows } from '../src/client/Shadows.ts';
import measured from '../src/client/explosionColors.generated.json' with { type: 'json' };
import balance from '../src/game/balance.generated.json' with { type: 'json' };

/** Corrective type for `traverseEntities`; see `first-person.test.ts`. GAP-001. */
type Traverse = (classes: unknown[], visitor: (component: never) => void) => void;

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([]);
    return ecd;
}

/**
 * The ramp `Effects.ts` still owns the brightness of.
 *
 * Copied rather than imported, deliberately. An assertion derived from the
 * implementation agrees with any implementation, including a wrong one; and
 * this ramp is a look decision, so a change to it should have to come here and
 * face what is asserted about it rather than sliding through.
 */
const TUNED = [
    [1, 0.95, 0.7, 1],
    [1, 0.5, 0.15, 0.9],
    [0.4, 0.1, 0.05, 0],
];

const L = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

interface Detonation {
    /** Luminous intensity, candela, as the component holds it. */
    readonly candela: number;
    /** The light's reach, scene metres. */
    readonly reach: number;
    /** The fireball's colour track: three RGBA stops. */
    readonly ramp: number[][];
    /** Where those stops sit in a particle's life. */
    readonly times: number[];
}

/** One detonation, read back out of the components it actually built. */
function detonate(radiusQ3: number, weapon?: string): Detonation {
    const ecd = newDataset();
    const effects = new Effects(ecd as never, new Shadows(null, 'off'));

    effects.explosion([0, 0, 0], radiusQ3, weapon);

    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    const lights: Light[] = [];
    traverse([Light, Transform], (light: never) => lights.push(light as Light));
    expect(lights.length, 'exactly one flash per detonation').toBe(1);

    const emitters: ParticleEmitter[] = [];
    traverse([ParticleEmitter, Transform], (e: never) => emitters.push(e as ParticleEmitter));

    /*
     The fireball is the additive one; the other is smoke, which stays grey for
     every weapon because smoke has no weapon colour and never had.
    */
    expect(emitters.length, 'a fireball and its smoke').toBe(2);

    const layer = (emitters[0] as unknown as { layers: { get(i: number): unknown } }).layers.get(0);
    const tracks = (
        layer as {
            parameterTracks: {
                getTrackByName(name: string): { track: { toJSON(): unknown } } | undefined;
            };
        }
    ).parameterTracks;

    const color = tracks.getTrackByName(ParticleParameters.Color);
    expect(color, 'the fireball has no colour track').toBeDefined();

    const json = color!.track.toJSON() as { data: number[]; positions: number[] };

    const ramp: number[][] = [];
    for (let i = 0; i < json.data.length; i += 4) ramp.push(json.data.slice(i, i + 4));

    return {
        candela: lights[0]!.intensity.getValue(),
        reach: lights[0]!.distance.getValue(),
        ramp,
        times: [...json.positions],
    };
}

const lumens = (d: Detonation): number => d.candela * 4 * Math.PI;

/** Every weapon that reaches `Arena.explosion`, with the radius it arrives at. */
const PROJECTILES: readonly (readonly [string, number])[] = [
    ['WP_ROCKET_LAUNCHER', 120],
    ['WP_GRENADE_LAUNCHER', 150],
    ['WP_PROX_LAUNCHER', 150],
    ['WP_PLASMAGUN', 20],
    ['WP_BFG', 120],
    // No `splashRadius`; `Weapons.detonate` uses `CG_MissileHitWall`'s own 12.
    ['WP_NAILGUN', 12],
];

/* ------------------------------------------------------------------ *
 * How much light
 * ------------------------------------------------------------------ */

describe('a detonation throws light in proportion to how big it is', () => {
    /*
     The anchor, and the reason it is an anchor rather than a number among
     numbers: `muzzleFlash.ts` scales its entire lumens column against "the
     explosion's 12,000 lm", and D-160 and D-161 each cut that column by half
     against the same reference. Moving the rocket would silently move the
     meaning of twelve muzzle flashes.
    */
    it('leaves the rocket on the 12,000 lm the whole flash table is scaled against', () => {
        expect(lumens(detonate(120, 'WP_ROCKET_LAUNCHER'))).toBeCloseTo(12000, 6);
    });

    it('scales with the square of the radius, not with the radius', () => {
        const rocket = lumens(detonate(120, 'WP_ROCKET_LAUNCHER'));

        // A sixth of the radius is a thirty-sixth of the light, not a sixth.
        expect(lumens(detonate(20, 'WP_PLASMAGUN'))).toBeCloseTo(rocket / 36, 6);
        expect(lumens(detonate(240, 'WP_ROCKET_LAUNCHER'))).toBeCloseTo(rocket * 4, 6);
    });

    /*
     The property that makes the square the right power rather than a power that
     happens to look better: the reach is `radius * 5`, so this holds the
     illuminance at the edge of a flash fixed. Every explosion is as bright as
     every other at its own scale, and the weapon changes how much of the room is
     inside it.
    */
    it('delivers the same illuminance at the edge of its own reach, whatever detonated', () => {
        const edge = PROJECTILES.map(([weapon, radiusQ3]) => {
            const d = detonate(radiusQ3, weapon);
            return d.candela / (d.reach * d.reach);
        });

        for (const lux of edge) expect(lux).toBeCloseTo(edge[0]!, 9);
    });

    /*
     And the numbers that fall out, because "it scales" and "it scales to
     something sensible" are different claims. A plasma impact used to be 12,000
     lm -- 955 lux a metre away, against the 5.9 lux a median `oa_dm1` fixture
     delivers at three -- so it clipped every nearby surface to white regardless
     of the colour D-163 had just given it.
    */
    it('puts a plasma impact beside the muzzle flash that launched it', () => {
        const plasma = lumens(detonate(20, 'WP_PLASMAGUN'));

        expect(plasma).toBeCloseTo(333.33, 1);

        // 385 lm at the muzzle (`muzzleFlash.ts`), 400 in flight (`MissileView`).
        expect(plasma).toBeGreaterThan(385 / 2);
        expect(plasma).toBeLessThan(400);
    });

    it('does not light a nail like a rocket', () => {
        const nail = lumens(detonate(12, 'WP_NAILGUN'));

        expect(nail).toBeCloseTo(120, 6);
        expect(nail, 'a dart outshining a warhead').toBeLessThan(
            lumens(detonate(120, 'WP_ROCKET_LAUNCHER')) / 50
        );
    });

    /** The radii above are the balance table's, so a change there reaches this. */
    it('is fed the splash radius the weapon actually has', () => {
        const weapons = balance.weapons as Record<string, { splashRadius?: number }>;

        for (const [weapon, radiusQ3] of PROJECTILES) {
            const splash = weapons[weapon]?.splashRadius;

            if (weapon === 'WP_NAILGUN') {
                expect(splash, 'a nail is a dart').toBeUndefined();
                continue;
            }

            expect(splash, `${weapon}'s blast moved`).toBe(radiusQ3);
        }
    });
});

/* ------------------------------------------------------------------ *
 * What colour
 * ------------------------------------------------------------------ */

describe("a fireball is Q3's hue at this port's brightness", () => {
    const MEASURED = measured.explosions as Record<
        string,
        { core: number[]; body: number[]; tail: number[] }
    >;

    /*
     The invariant that makes swapping a hue into a tuned ramp safe at all. The
     ramp's brightness over life is a look decision (GAP-011) and it is not being
     re-decided here; only the hue is. If this fails, some weapon's fireball got
     brighter or dimmer as a side effect of being a different colour.
    */
    it('holds the tuned brightness at every stop, for every weapon', () => {
        for (const [weapon, radiusQ3] of PROJECTILES) {
            const { ramp } = detonate(radiusQ3, weapon);

            for (const [i, stop] of ramp.entries()) {
                expect(L(stop), `${weapon} stop ${i} changed brightness`).toBeCloseTo(
                    L(TUNED[i]!),
                    6
                );
                expect(stop[3], `${weapon} stop ${i} changed alpha`).toBe(TUNED[i]![3]);
            }
        }
    });

    /*
     The calibration. Nothing forces a measured ramp to agree with a hand-tuned
     one; that it does for the weapon the hand-tuned one was authored against is
     the whole evidence that the measurement is picking up what an eye picked up,
     and it is what licenses trusting it for the four weapons nobody tuned. The
     bands `extract-explosion-colors.ts` cuts at are a choice, and this is the
     assertion a future choice has to face.
    */
    it("reproduces the rocket's own tuned ramp, which is what says the measurement is sound", () => {
        const { ramp } = detonate(120, 'WP_ROCKET_LAUNCHER');

        for (const stop of [1, 2]) {
            for (const channel of [0, 1, 2]) {
                expect(
                    Math.abs(ramp[stop]![channel]! - TUNED[stop]![channel]!),
                    `rocket stop ${stop} channel ${channel} drifted from the tuned ramp`
                ).toBeLessThan(0.05);
            }
        }

        /*
         The core is the one stop that does not land inside a twentieth, and it
         is the one where it matters least: both colours are a near-white hot
         centre and their whole disagreement is 0.16 of blue. Pinned as a bound
         rather than hidden, so a band cut that made it worse would fail.
        */
        const core = ramp[0]!;
        expect(Math.min(core[0]!, core[1]!, core[2]!), 'the core stopped being near white')
            .toBeGreaterThan(0.8);
        for (const channel of [0, 1, 2]) {
            expect(Math.abs(core[channel]! - TUNED[0]![channel]!)).toBeLessThan(0.2);
        }
    });

    /** And the complaint this started from, at the other end of the shot. */
    it('gives a plasma impact a blue fireball and a BFG a green one', () => {
        const plasma = detonate(20, 'WP_PLASMAGUN').ramp[1]!;

        expect(plasma[2], 'blue under green').toBeGreaterThan(plasma[1]!);
        expect(plasma[1], 'green under red').toBeGreaterThan(plasma[0]!);

        const bfg = detonate(120, 'WP_BFG').ramp[1]!;

        expect(bfg[1], 'green under red').toBeGreaterThan(bfg[0]!);
        expect(bfg[1], 'green under blue').toBeGreaterThan(bfg[2]!);

        // The rocket is still warm, which is the direction nobody complained about.
        const rocket = detonate(120, 'WP_ROCKET_LAUNCHER').ramp[1]!;
        expect(rocket[0]).toBeGreaterThan(rocket[1]!);
        expect(rocket[1]).toBeGreaterThan(rocket[2]!);
    });

    /*
     The two detonations with no picture behind them. `CG_MissileHitWall` leaves
     `mod` at zero for `WP_NAILGUN`, so Q3 draws a nail no explosion and there is
     nothing to measure; a death is not in the C at all. Both keep the ramp this
     port tuned, rather than borrowing a colour painted for another weapon.
    */
    it('keeps the tuned ramp where Q3 painted no explosion', () => {
        expect(MEASURED.WP_NAILGUN, 'the C draws a nail no fireball').toBeUndefined();

        for (const detonation of [detonate(12, 'WP_NAILGUN'), detonate(90)]) {
            expect(detonation.ramp).toEqual(TUNED);
        }
    });

    /** The generated table's own shape, since the runtime relies on it. */
    it('is measured as chromaticities, normalised to a top channel of one', () => {
        const rows = Object.entries(MEASURED);

        expect(rows.length, 'five shaders, and the prox mine shares the grenade’s').toBe(5);

        for (const [weapon, row] of rows) {
            for (const band of ['core', 'body', 'tail'] as const) {
                const c = row[band];

                expect(c.length, `${weapon}.${band}`).toBe(3);
                expect(Math.max(...c), `${weapon}.${band} is not normalised`).toBeCloseTo(1, 6);
                expect(Math.min(...c), `${weapon}.${band} has a negative channel`)
                    .toBeGreaterThanOrEqual(0);
            }
        }
    });

    /** The stops stay where `CG_MakeExplosion`'s shape put them. */
    it('does not move the ramp in time', () => {
        expect(detonate(120, 'WP_ROCKET_LAUNCHER').times).toEqual([0, 0.3, 1]);
        expect(detonate(20, 'WP_PLASMAGUN').times).toEqual([0, 0.3, 1]);
    });
});
