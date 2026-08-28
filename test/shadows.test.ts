/*
 * shadows.test.ts -- which lights cast, and the four ways that goes wrong.
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
 * A shadow setting fails in ways a screenshot taken at the wrong moment does
 * not show, and this port has no screenshots at all -- the preview browser runs
 * it in a hidden tab where `requestAnimationFrame` never fires. So the four that
 * can actually happen are asserted from the CPU side:
 *
 *   - **The flag is written somewhere nothing reads.** Shade's own light has a
 *     `casts_shadow` and `LightSystem3` overwrites it from the component on
 *     every `refresh`, so the obvious place is the wrong one. `writes through
 *     the observable the engine binds to` is the guard, and it uses meep's real
 *     `Light` rather than a stand-in for exactly that reason.
 *   - **A light created before the setting was read never hears about it.** The
 *     map's lights are built while five other loads are in flight and the menu
 *     does not exist yet; `follow` is what closes that gap, and a light that is
 *     followed and then not rewritten is invisible until someone changes the
 *     mode twice.
 *   - **A light created after it hears the wrong answer.** The effect lights are
 *     built thousands of times a match and ask once each.
 *   - **A stored value from a build that spelled the modes differently.** The
 *     menu hands over whatever `coerce` let through, and `coerce` only knows the
 *     option list it was given.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';

import { Effects } from '../src/client/Effects.ts';
import {
    asShadowMode,
    NO_SHADOWS,
    SHADOW_MODE_DEFAULT,
    SHADOW_MODES,
    Shadows,
    type LightRole,
    type ShadowMode,
} from '../src/client/Shadows.ts';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The one property of `Renderer` the policy reaches, and a record of writes. */
function fakeGraphics() {
    return {
        renderer: {
            feature_shadows_enabled: true,
        },
    };
}

/**
 * A stand-in light: the `castShadow` half of the component and nothing else.
 *
 * It counts its writes as well as holding the value, because "kept what it had"
 * and "was rewritten with the same value" are the same state and different
 * outcomes -- the second one raises `onChanged` on a real component and drags a
 * GPU light-table republish behind it.
 */
interface LightStub {
    writes: number;
    readonly castShadow: { set(v: boolean): void; getValue(): boolean };
}

function stubLight(initial = false): LightStub {
    let value = initial;

    const light: LightStub = {
        writes: 0,
        castShadow: {
            set(v: boolean): void {
                light.writes++;
                value = v;
            },
            getValue(): boolean {
                return value;
            },
        },
    };

    return light;
}

function newDataset(): EntityComponentDataset {
    // As `first-person.test.ts` builds one: `Effects` registers what it needs.
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([]);
    return ecd;
}

/** Corrective type for `traverseEntities`; see `first-person.test.ts`. GAP-001. */
type Traverse = (
    classes: unknown[],
    visitor: (light: Light, transform: Transform) => void
) => void;

function lightsIn(ecd: EntityComponentDataset): Light[] {
    const found: Light[] = [];
    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    traverse([Light, Transform], (light) => {
        found.push(light);
    });

    return found;
}

/* ------------------------------------------------------------------ *
 * The policy
 * ------------------------------------------------------------------ */

describe('which lights cast', () => {
    /**
     * The whole matrix, written out rather than derived.
     *
     * Derived from the implementation it would agree with any implementation,
     * including the wrong one. The row that matters is the middle: `sun` is what
     * this port shipped before there was a setting, and a change that made it
     * mean anything else would be a silent regression in the default look of
     * every arena for anyone who had chosen it.
     */
    const matrix: Record<ShadowMode, Record<LightRole, boolean>> = {
        off: { sun: false, world: false, effect: false },
        sun: { sun: true, world: false, effect: false },
        all: { sun: true, world: true, effect: true },
    };

    for (const mode of SHADOW_MODES) {
        for (const role of ['sun', 'world', 'effect'] as const) {
            const expected = matrix[mode][role];

            it(`${mode}: a ${role} light ${expected ? 'casts' : 'does not'}`, () => {
                expect(new Shadows(null, mode).casts(role)).toBe(expected);
            });
        }
    }

    it('starts with every light casting, which is what the request was', () => {
        expect(SHADOW_MODE_DEFAULT).toBe('all');

        const shadows = new Shadows();

        expect(shadows.mode).toBe('all');
        expect(shadows.casts('world')).toBe(true);
        expect(shadows.casts('effect')).toBe(true);
        expect(shadows.casts('sun')).toBe(true);
    });

    it('gives a light source with no policy the flag it had before there was one', () => {
        for (const role of ['sun', 'world', 'effect'] as const) {
            expect(NO_SHADOWS.casts(role)).toBe(false);
        }
    });
});

describe('a light that outlives the menu', () => {
    it('is written the moment it is followed, without waiting for a change', () => {
        const light = stubLight();

        new Shadows(null, 'all').follow(light, 'world');

        expect(light.castShadow.getValue()).toBe(true);
        expect(light.writes).toBe(1);
    });

    it('is rewritten when the mode moves, in both directions', () => {
        const shadows = new Shadows(null, 'all');
        const world = shadows.follow(stubLight(), 'world');
        const sun = shadows.follow(stubLight(), 'sun');

        expect([world.castShadow.getValue(), sun.castShadow.getValue()]).toEqual([true, true]);

        shadows.setMode('sun');
        expect([world.castShadow.getValue(), sun.castShadow.getValue()]).toEqual([false, true]);

        shadows.setMode('off');
        expect([world.castShadow.getValue(), sun.castShadow.getValue()]).toEqual([false, false]);

        shadows.setMode('all');
        expect([world.castShadow.getValue(), sun.castShadow.getValue()]).toEqual([true, true]);
    });

    it('counts what it is keeping in step, which is what the load line reports', () => {
        const shadows = new Shadows(null, 'all');

        shadows.followAll([stubLight(), stubLight(), stubLight()], 'world');
        shadows.follow(stubLight(), 'sun');

        expect(shadows.followedCount).toBe(4);
    });

    /*
     The guard against writing the flag somewhere nothing reads. `LightSystem3`
     binds a `refresh` to `component.castShadow.onChanged` and copies the value
     onto Shade's light from there -- so a write that does not raise that signal
     reaches the GPU on the next unrelated property change and not before, which
     is a setting that works intermittently. Real component, real signal.
    */
    it('writes through the observable the engine binds to', () => {
        const light = new Light();
        let fired = 0;

        light.castShadow.onChanged.add(() => {
            fired++;
        });

        new Shadows(null, 'all').follow(light, 'world');

        expect(light.castShadow.getValue()).toBe(true);
        expect(fired).toBe(1);
    });
});

describe('the renderer master switch', () => {
    it('follows the mode, and is the only property touched', () => {
        const graphics = fakeGraphics();
        const shadows = new Shadows(graphics, 'all');

        shadows.apply();
        expect(graphics.renderer.feature_shadows_enabled).toBe(true);

        shadows.setMode('off');
        expect(graphics.renderer.feature_shadows_enabled).toBe(false);

        shadows.setMode('sun');
        expect(graphics.renderer.feature_shadows_enabled).toBe(true);

        expect(Object.keys(graphics.renderer)).toEqual(['feature_shadows_enabled']);
    });

    it('works with no renderer at all, which is what a headless run has', () => {
        const shadows = new Shadows({ renderer: null }, 'all');
        const light = shadows.follow(stubLight(), 'world');

        expect(() => shadows.setMode('off')).not.toThrow();
        expect(light.castShadow.getValue()).toBe(false);
    });
});

describe('a value arriving from the menu or from storage', () => {
    it('takes the three modes and nothing else', () => {
        for (const mode of SHADOW_MODES) expect(asShadowMode(mode)).toBe(mode);

        for (const raw of ['ALL', ' all', 'sunlight', '', 0, 1, true, null, undefined, {}]) {
            expect(asShadowMode(raw)).toBeNull();
        }
    });

    it('keeps what it has when handed something that is not a mode', () => {
        const shadows = new Shadows(null, 'sun');
        const light = shadows.follow(stubLight(), 'world');

        expect(shadows.setMode('ultra')).toBe(false);
        expect(shadows.setMode(2)).toBe(false);
        expect(shadows.setMode(null)).toBe(false);

        expect(shadows.mode).toBe('sun');
        // ...and nothing was rewritten on the way past.
        expect(light.writes).toBe(1);
    });

    it('reports whether anything moved, so a no-op change is not announced', () => {
        const shadows = new Shadows(null, 'all');

        expect(shadows.setMode('all')).toBe(false);
        expect(shadows.setMode('off')).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 * The lights that do not live long enough to be followed
 * ------------------------------------------------------------------ */

describe("an effect's own lights", () => {
    /**
     * Both of them, by the calls that make them.
     *
     * `explosion` also raises particle emitters and a decal, and `muzzleFlash`
     * raises nothing else, so the light is picked out by component rather than
     * by counting entities.
     */
    function lightsFrom(shadows: Shadows | typeof NO_SHADOWS): boolean[] {
        const ecd = newDataset();
        const effects = new Effects(ecd, shadows);

        effects.explosion([0, 0, 0], 120);
        effects.muzzleFlash([0, 0, 0], 'WP_MACHINEGUN');

        const lights = lightsIn(ecd);
        expect(lights.length).toBe(2);

        return lights.map((l) => l.castShadow.getValue());
    }

    it('cast when every light casts', () => {
        expect(lightsFrom(new Shadows(null, 'all'))).toEqual([true, true]);
    });

    it('do not when only the sun does', () => {
        expect(lightsFrom(new Shadows(null, 'sun'))).toEqual([false, false]);
        expect(lightsFrom(new Shadows(null, 'off'))).toEqual([false, false]);
    });

    it('do not when nobody handed the effects a policy', () => {
        expect(lightsFrom(NO_SHADOWS)).toEqual([false, false]);
    });

    /*
     The reason these are asked rather than followed. A flash is 50 to 90 ms and
     a match produces thousands; holding them would be an unbounded list of dead
     components, and the setting cannot matter to a light with six frames left.
    */
    it('are not kept in a list that would grow all match', () => {
        const shadows = new Shadows(null, 'all');
        const ecd = newDataset();
        const effects = new Effects(ecd, shadows);

        for (let i = 0; i < 200; i++) effects.muzzleFlash([i, 0, 0], 'WP_MACHINEGUN');

        expect(shadows.followedCount).toBe(0);
    });
});
