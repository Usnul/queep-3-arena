/*
 * muzzle-flash.test.ts -- where a weapon's flash light is, and whose it is.
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
 * Written because the flash was a light at the shot's origin, and the shot's
 * origin is `CalcMuzzlePoint`: fourteen units straight out from the eye, at eye
 * height, on the view axis. That is the right point for a *shot* and the wrong
 * one for a *lamp* -- it sits dead centre in front of the player's face, so
 * firing lit the room from the middle of the screen and the gun in your hands
 * threw no light of its own at all.
 *
 * Three things are pinned here, and the first is the complaint:
 *
 *   - the light is on the barrel. `tag_flash` is the point the people who made
 *     the model put there for exactly this, and the assertion is that the light
 *     lands off the view axis, on the side the gun is on.
 *   - it stays there. A light dropped at the point the trigger was pulled is one
 *     the player runs out of; this one is placed every frame of its life.
 *   - the fallback is real. Only the local player has a gun on screen, so every
 *     other shooter -- and the player when their gun is not drawn -- still gets
 *     a light, at the origin the simulation reported.
 *
 * See D-115. And D-158, which is the same complaint reported a second time,
 * because two of the thirteen weapons ship no `tag_flash` and were still being
 * lit fourteen units in front of the eye -- one of them the gauntlet, which
 * every player spawns holding. The muzzle is now asked of the model in three
 * steps rather than one, and "a flash the gun declines" is down to the two
 * refusals that are about there being no *gun*.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ParticleEmitter } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleEmitter.js';

import {
    handOffset,
    muzzleOffset,
    ViewWeapon,
    type CameraPose,
    type ViewWeaponState,
} from '../src/client/ViewWeapon.ts';
import { ModelLibrary } from '../src/client/map/loadModels.ts';
import type { ModelBundle } from '../src/client/map/SceneBundle.ts';
import { Effects } from '../src/client/Effects.ts';
import { Arena } from '../src/client/Arena.ts';
import { Shadows } from '../src/client/Shadows.ts';
import {
    hasFlashModel,
    MUZZLE_FLASH_SECONDS,
    muzzleFlashLight,
    type MuzzleFlashLight,
} from '../src/client/muzzleFlash.ts';
import { angleVectors, vec3 } from '../src/q3/math.ts';
import balance from '../src/game/balance.generated.json' with { type: 'json' };

/** Scene units per Q3 unit. */
const S = 1 / 32;

/** Corrective type for `traverseEntities`; see `first-person.test.ts`. GAP-001. */
type Traverse = (
    classes: unknown[],
    visitor: (light: Light, transform: Transform) => void
) => void;

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([]);
    return ecd;
}

interface LitPoint {
    readonly light: Light;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** Every light in the scene, with where it is. */
function litPoints(ecd: EntityComponentDataset): LitPoint[] {
    const found: LitPoint[] = [];
    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    traverse([Light, Transform], (light, transform) => {
        found.push({
            light,
            x: transform.position.x,
            y: transform.position.y,
            z: transform.position.z,
        });
    });

    return found;
}

function onlyLight(ecd: EntityComponentDataset): LitPoint {
    const lights = litPoints(ecd);
    expect(lights.length, 'exactly one flash, never two for one shot').toBe(1);
    return lights[0]!;
}

/* ------------------------------------------------------------------ *
 * The stub bundle
 *
 * Two tags per weapon, and the numbers are shaped like the real ones: OA's
 * hands tag puts the gun forward, down and to the right of the eye, and
 * `tag_flash` is most of the way down the barrel and slightly above the model
 * origin. Round numbers so the arithmetic can be read off the assertion.
 * ------------------------------------------------------------------ */

/** `tag_weapon` on the hands model, in the bundle's model axes. */
const HAND_TAG = [8, -4, 12] as const;

/** `tag_flash` per world model, same axes: x forward, y up, z right. */
const FLASH_TAGS: Readonly<Record<string, readonly number[]>> = {
    'models/weapons2/shotgun/shotgun.md3': [20, 2, 0],
    'models/weapons2/rocketl/rocketl.md3': [16, 4, 0],
    // The gauntlet has no muzzle, and OA ships it no flash tag. Absent here too.
};

/**
 * `tag_barrel`, which is what the gauntlet has instead -- OA's marks it at
 * (11.02, -0.59, 0.07), where the blade hangs. Round numbers here, same shape.
 */
const BARREL_TAGS: Readonly<Record<string, readonly number[]>> = {
    'models/weapons2/gauntlet/gauntlet.md3': [10, -2, 0],
};

/**
 * The model's own bounds, which is all a model with no tags at all has to say.
 * OA's prox launcher is the one, and D-158 measures its front rather than
 * putting the light back in the middle of the screen.
 */
const BOUNDS: Readonly<Record<string, { mins: number[]; maxs: number[] }>> = {
    'models/weapons/proxmine/proxmine.md3': { mins: [-10, -2, -4], maxs: [12, 6, 4] },
};

const PIECES: Readonly<Record<string, number>> = {
    'models/weapons2/shotgun/shotgun.md3': 2,
    'models/weapons2/rocketl/rocketl.md3': 3,
    'models/weapons2/gauntlet/gauntlet.md3': 1,
    'models/weapons/proxmine/proxmine.md3': 1,
};

const NO_BOUNDS = { mins: [0, 0, 0], maxs: [0, 0, 0] };

function stubLibrary() {
    return {
        definition(name: string) {
            if (name.endsWith('_hand.md3')) {
                return { ...NO_BOUNDS, tags: [{ name: 'tag_weapon', origin: HAND_TAG }] };
            }

            if (PIECES[name] === undefined) return null;

            const tags: { name: string; origin: readonly number[] }[] = [];

            const flash = FLASH_TAGS[name];
            if (flash !== undefined) tags.push({ name: 'tag_flash', origin: flash });

            const barrel = BARREL_TAGS[name];
            if (barrel !== undefined) tags.push({ name: 'tag_barrel', origin: barrel });

            return { ...(BOUNDS[name] ?? NO_BOUNDS), tags };
        },
        components(name: string): ShadedGeometry[] | null {
            const count = PIECES[name];
            if (count === undefined) return null;
            return Array.from({ length: count }, () => new ShadedGeometry());
        },
    };
}

/** Looking straight down the camera's +Z, from `eye`. */
/**
 * A shooter's forward, for the events that now carry one.
 *
 * The muzzle flash is directional -- Q3 hangs an oriented `flashModel` on
 * `tag_flash` and the particles that stand in for it are thrown down the barrel
 * -- so the event carries `AngleVectors`' forward beside the muzzle. Q3's +x,
 * which is straight ahead of an unturned player.
 */
const FORWARD: readonly [number, number, number] = [1, 0, 0];

function pose(eye: readonly [number, number, number]): CameraPose {
    return { position: { x: eye[0], y: eye[1], z: eye[2] }, rotation: new Quaternion() };
}

function held(weapon: string, visible = true, firing = false): ViewWeaponState {
    return { weapon, speed: 0, bobCycle: 0, visible, firing };
}

/** A view weapon holding `weapon`, already drawn for one frame. */
function drawing(weapon: string): { ecd: EntityComponentDataset; view: ViewWeapon } {
    const ecd = newDataset();
    const view = new ViewWeapon(ecd as never, stubLibrary() as never);

    view.update(pose([0, 0, 0]), 0.016, held(weapon));

    return { ecd, view };
}

/* ------------------------------------------------------------------ *
 * The complaint
 * ------------------------------------------------------------------ */

describe('the flash is on the gun, not on the player', () => {
    /**
     * The bug, as the picture it made.
     *
     * `CalcMuzzlePoint` is on the view axis by construction -- it is the eye
     * plus fourteen units of `forward` -- so a light there has *no* sideways or
     * vertical offset from the eye at all, whichever way the player is facing.
     * That is what "centred on the player" means numerically, and it is what
     * this refuses.
     */
    it('lands off the view axis, on the side the gun is drawn', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        expect(view.flash('WP_SHOTGUN'), 'the gun takes its own flash').toBe(true);
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        const flash = onlyLight(ecd);

        /*
         The camera's frame is +X left, +Y up, +Z forward, and the hands tag puts
         the gun 12 units to the right of the eye and 4 below it. The flash rides
         the model from there: 20 units further down the barrel and 2 back up.
        */
        expect(flash.x, '12 units to the right of the eye, not on the axis').toBeCloseTo(-12 * S, 3);
        expect(flash.y, '4 down from the hands tag and 2 back up the model').toBeCloseTo(-2 * S, 3);
        expect(flash.z, '8 units out to the gun, 20 more to the muzzle').toBeCloseTo(28 * S, 3);

        // And the thing the old light could never be: away from where the eye is
        // looking, by more than the shot origin's own 14 units are long.
        expect(Math.hypot(flash.x, flash.y), 'off the view axis').toBeGreaterThan(0.3);
    });

    /**
     * Which end of the barrel, checked by moving the barrel.
     *
     * A rocket launcher's flash tag is further up and less far forward than a
     * shotgun's, so swapping weapons has to move the light even though the eye
     * and the hands tag have not moved. If the light were placed from anything
     * but the model's own tag, both weapons would light the same point.
     */
    it('is the weapon own muzzle, and moves when the weapon changes', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        const shotgun = onlyLight(ecd);

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        view.flash('WP_ROCKET_LAUNCHER');
        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        const launcher = onlyLight(ecd);

        expect(launcher.z, "the launcher's muzzle is 4 units nearer the eye").toBeCloseTo(
            shotgun.z - 4 * S,
            3
        );
        expect(launcher.y, 'and 2 units higher up the model').toBeCloseTo(shotgun.y + 2 * S, 3);
    });

    /**
     * It follows, which is the half a fire-and-forget light gets wrong.
     *
     * Fifty milliseconds is half a metre at Q3's run speed. A light left at the
     * point the trigger was pulled is behind the player by then, and a
     * machinegun leaves ten of them a second strung out down the corridor.
     */
    it('rides the gun for the whole life of the flash', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        view.flash('WP_SHOTGUN');

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        const first = onlyLight(ecd);

        // A frame of running: three metres along, which is faster than the game.
        view.update(pose([0, 0, 3]), 0.016, held('WP_SHOTGUN'));
        const later = onlyLight(ecd);

        /*
         Not to the last decimal, and the slack is the sway:
         `CG_CalculateWeaponPosition`'s idle drift never stops, so the gun -- and
         the light welded to it -- wanders a fraction of a millimetre between two
         frames of a standing player. Three metres against a fraction of a
         millimetre is the comparison being made.
        */
        expect(later.z - first.z, 'the light went with the player').toBeCloseTo(3, 4);
        expect(
            Math.abs(later.x - first.x),
            'and is still on the barrel, not left behind on the axis'
        ).toBeLessThan(0.001);
    });

    it('goes out when the flash is over, and leaves nothing in the scene', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), MUZZLE_FLASH_SECONDS / 2, held('WP_SHOTGUN'));
        expect(litPoints(ecd).length, 'still lit halfway through').toBe(1);
        expect(view.flashLit).toBe(true);

        view.update(pose([0, 0, 0]), MUZZLE_FLASH_SECONDS, held('WP_SHOTGUN'));
        expect(litPoints(ecd).length, 'and out at the end of it').toBe(0);
        expect(view.flashLit).toBe(false);
    });

    it('is one light however many shots are fired through it', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        for (let i = 0; i < 50; i++) {
            view.flash('WP_SHOTGUN');
            view.update(pose([i * 0.1, 0, 0]), 0.016, held('WP_SHOTGUN'));
        }

        expect(litPoints(ecd).length, 'the flash entity is built once and re-pointed').toBe(1);
    });
});

/* ------------------------------------------------------------------ *
 * When the gun cannot take it
 * ------------------------------------------------------------------ */

describe('a flash the gun declines', () => {
    it('is declined by a weapon that is not the one on screen', () => {
        const { view } = drawing('WP_SHOTGUN');

        expect(view.flash('WP_ROCKET_LAUNCHER')).toBe(false);
    });

    it('is declined by a corpse, which has no gun drawn', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN', false));

        expect(view.flash('WP_SHOTGUN')).toBe(false);
        expect(litPoints(ecd).length).toBe(0);
    });

    /*
     And the one that is *not* a refusal any more. See D-158: a weapon whose
     model ships no `tag_flash` used to decline and be lit at `CalcMuzzlePoint`
     instead -- which for the gauntlet, one of the two weapons every player
     spawns holding, made the commonest flash in the game the exact light on the
     view axis D-115 is named for.
    */
    it('is taken by a weapon whose model ships no flash tag, and lit on the gun', () => {
        const { ecd, view } = drawing('WP_GAUNTLET');

        expect(view.drawnWeapon, 'the gauntlet is drawn').toBe('WP_GAUNTLET');
        expect(view.flash('WP_GAUNTLET'), 'and a drawn gun has a front').toBe(true);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
        const flash = onlyLight(ecd);

        /*
         `tag_barrel`, where the blade goes: the hands tag puts the gun 8 units
         out, 4 down and 12 to the right, and the blade is 10 further down the
         model and 2 below its origin.
        */
        expect(flash.z, 'down the gauntlet, not down the view').toBeCloseTo(18 * S, 3);
        expect(flash.x, 'on the side the gun is drawn').toBeCloseTo(-12 * S, 3);
        expect(flash.y, 'and below the crosshair').toBeCloseTo(-6 * S, 3);

        expect(
            Math.hypot(flash.x, flash.y),
            'off the view axis, which is the whole complaint'
        ).toBeGreaterThan(0.3);
    });

    /*
     A model that marks nothing at all -- OA's prox launcher carries no tags on
     its world model, so there is no authored point to read and the front of its
     own bounds is measured instead.
    */
    it('is taken by a model with no tags at all, and lit at the front of it', () => {
        const { ecd, view } = drawing('WP_PROX_LAUNCHER');

        expect(view.drawnWeapon, 'the prox launcher is drawn').toBe('WP_PROX_LAUNCHER');
        expect(view.flash('WP_PROX_LAUNCHER'), 'and it still has a front').toBe(true);

        view.update(pose([0, 0, 0]), 0.016, held('WP_PROX_LAUNCHER'));
        const flash = onlyLight(ecd);

        // Bounds 12 forward, y -2..6 and z -4..4: the centre of the front face.
        expect(flash.z, 'the front of the model, from a hands tag 8 out').toBeCloseTo(20 * S, 3);
        expect(flash.y, '4 below the eye and 2 up the middle of the face').toBeCloseTo(-2 * S, 3);
        expect(flash.x, 'on the side the gun is drawn').toBeCloseTo(-12 * S, 3);
    });

    it('is dropped when the gun is put away mid-flash', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');

        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.001, held('WP_SHOTGUN'));
        expect(litPoints(ecd).length).toBe(1);

        // Killed with the flash still up: the gun leaves and the light with it.
        view.update(pose([0, 0, 0]), 0.001, held('WP_SHOTGUN', false));
        expect(litPoints(ecd).length, 'no light hanging where the corpse fell').toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * Whose flash it is
 * ------------------------------------------------------------------ */

describe('Arena sends a flash to the gun only when the gun is the shooter', () => {
    /** An arena with no map behind it; `muzzleFlash` never asks the clipmap. */
    function newArena(ecd: EntityComponentDataset): Arena {
        return new Arena(ecd as never, {} as never);
    }

    it("puts the local player's flash on the barrel and not at the shot origin", () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = newArena(ecd);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        // The shot is reported 100 units out along Q3's +X, which is a long way
        // from the eye this view weapon is drawn at.
        arena.muzzleFlash([100, 0, 0], FORWARD, 'WP_SHOTGUN', 0);
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        const flash = onlyLight(ecd);
        expect(flash.x, 'on the gun, not 100 units away where the shot was').toBeCloseTo(
            -12 * S,
            3
        );
    });

    it("leaves a bot's flash in the world, where the shot was", () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = newArena(ecd);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        // 2000+ is a bot, per `roster.ts`.
        arena.muzzleFlash([64, 0, 32], FORWARD, 'WP_SHOTGUN', 2001);

        const flash = onlyLight(ecd);
        // Q3 (x, y, z) -> meep (x, z, -y), in metres.
        expect(flash.x).toBeCloseTo(64 * S, 6);
        expect(flash.y).toBeCloseTo(32 * S, 6);
        expect(flash.z).toBeCloseTo(0, 6);

        expect(view.flashLit, 'and the gun in your hands did not flash').toBe(false);
    });

    /*
     The refusal that is left, and it is about the *gun* rather than the tag:
     `WP_RAILGUN` is not in this bundle, so nothing is drawn and there is nothing
     to hang a light on. D-158 took the other two refusals away -- a weapon whose
     model ships no `tag_flash` is still drawn, and a drawn gun has a front.
    */
    it('falls back to the world when the player has no gun to flash', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = newArena(ecd);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_RAILGUN'));
        expect(view.drawnWeapon, 'nothing on screen to take it').toBe('');

        arena.muzzleFlash([64, 0, 0], FORWARD, 'WP_RAILGUN', 0);

        const flash = onlyLight(ecd);
        expect(flash.x, 'no model, so the shot lights itself').toBeCloseTo(64 * S, 6);
    });

    it("puts the gauntlet's flash on the gauntlet, not in the middle of the screen", () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = newArena(ecd);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
        arena.muzzleFlash([64, 0, 0], FORWARD, 'WP_GAUNTLET', 0);
        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));

        const flash = onlyLight(ecd);
        expect(flash.z, 'on the blade, not 64 units out where the swing was').toBeCloseTo(
            18 * S,
            3
        );
        expect(Math.hypot(flash.x, flash.y), 'and off the view axis').toBeGreaterThan(0.3);
    });

    it('lights the world when nothing has handed it a view weapon', () => {
        const ecd = newDataset();
        const arena = newArena(ecd);

        arena.muzzleFlash([64, 0, 0], FORWARD, 'WP_SHOTGUN', 0);

        expect(onlyLight(ecd).x).toBeCloseTo(64 * S, 6);
    });
});

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

describe('every weapon brings its own light', () => {
    const weapons = Object.keys(balance.weapons);

    /*
     Coverage rather than transcription: the colours are read off
     `CG_RegisterWeapon` and cited where they are written, and what a test can
     add is that a weapon arriving in a future extraction is noticed here rather
     than silently falling to the white default. Same shape as `items.test.ts`'s
     rule over the item table (D-114).
    */
    it('has an entry for every weapon in the balance table', () => {
        const white = weapons.filter((w) => {
            const flash = muzzleFlashLight(w);
            return flash.color[0] === 1 && flash.color[1] === 1 && flash.color[2] === 1;
        });

        expect(white, 'these fell through to `CG_RegisterWeapon`s default arm').toEqual([]);
    });

    it('gives each one a colour, a reach and a brightness that can be seen', () => {
        for (const weapon of weapons) {
            const flash: MuzzleFlashLight = muzzleFlashLight(weapon);

            expect(flash.reachQ3, `${weapon} reaches somewhere`).toBeGreaterThan(0);
            expect(flash.lumens, `${weapon} is brighter than nothing`).toBeGreaterThan(0);
            expect(Math.max(...flash.color), `${weapon} is not black`).toBeGreaterThan(0);
        }
    });

    /*
     The families Q3 groups by, and the reason to have a table at all: a plasma
     flash is blue where a machinegun's is yellow, and the two rounds fired from
     the same barrel share a colour.
    */
    it('groups the weapons the way `flashDlightColor` does', () => {
        const colorOf = (weapon: string): readonly number[] => muzzleFlashLight(weapon).color;

        expect(colorOf('WP_MACHINEGUN'), 'MAKERGB( 1, 1, 0 )').toEqual([1, 1, 0]);
        expect(colorOf('WP_CHAINGUN'), 'the same round, the same flash').toEqual(
            colorOf('WP_MACHINEGUN')
        );
        expect(colorOf('WP_SHOTGUN')).toEqual(colorOf('WP_MACHINEGUN'));

        expect(colorOf('WP_PLASMAGUN'), 'MAKERGB( 0.6, 0.6, 1.0 )').toEqual([0.6, 0.6, 1]);
        expect(colorOf('WP_LIGHTNING')).toEqual(colorOf('WP_PLASMAGUN'));

        expect(colorOf('WP_RAILGUN'), 'MAKERGB( 1, 0.5f, 0 )').toEqual([1, 0.5, 0]);
        expect(colorOf('WP_BFG'), 'MAKERGB( 1, 0.7f, 1 )').toEqual([1, 0.7, 1]);

        expect(
            colorOf('WP_ROCKET_LAUNCHER'),
            'the launchers are orange, and not the same orange'
        ).not.toEqual(colorOf('WP_GRENADE_LAUNCHER'));
    });

    /**
     * The settings reach the light, on both paths.
     *
     * `Effects` builds a light per shot and `ViewWeapon` keeps one and re-points
     * it, so the same weapon has to come out the same either way -- otherwise
     * the player's own plasma gun and a bot's would be different colours.
     */
    it('writes the same light whichever path builds it', () => {
        const world = newDataset();
        new Effects(world as never, new Shadows(null, 'all')).muzzleFlash(
            [0, 0, 0],
            FORWARD,
            'WP_PLASMAGUN'
        );

        const { ecd, view } = drawing('WP_SHOTGUN');
        // The shotgun is what the stub bundle has a flash tag for; the weapon the
        // light is *configured* from is the one the shot names.
        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        const onGun = onlyLight(ecd).light;
        const inWorld = onlyLight(world).light;

        const settings = muzzleFlashLight('WP_SHOTGUN');
        expect(onGun.type.getValue()).toBe(LightType.POINT);
        expect(inWorld.type.getValue()).toBe(LightType.POINT);

        expect(onGun.distance.getValue()).toBeCloseTo(settings.reachQ3 * S, 6);
        expect(onGun.intensity.getValue()).toBeCloseTo(settings.lumens / (4 * Math.PI), 6);
        expect([onGun.color.r, onGun.color.g, onGun.color.b]).toEqual([...settings.color]);

        const plasma = muzzleFlashLight('WP_PLASMAGUN');
        expect(inWorld.distance.getValue()).toBeCloseTo(plasma.reachQ3 * S, 6);
        expect([inWorld.color.r, inWorld.color.g, inWorld.color.b]).toEqual([...plasma.color]);
    });

    /*
     `Shadows` is asked at the moment the flash is raised rather than followed,
     for the reason `shadows.test.ts` states: these lights are shorter than the
     interval anyone can change a setting in. The gun's flash outlives them all
     -- it is built once and kept -- so it has to ask again per shot.
     */
    it('asks the shadow setting again on every shot, because the light is kept', () => {
        const ecd = newDataset();
        const shadows = new Shadows(null, 'all');
        const view = new ViewWeapon(ecd as never, stubLibrary() as never, shadows);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(onlyLight(ecd).light.castShadow.getValue()).toBe(true);

        shadows.setMode('sun');
        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(onlyLight(ecd).light.castShadow.getValue(), 'the menu row took effect').toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 * The visible half
 * ------------------------------------------------------------------ */

/*
 * `weaponInfo->flashModel`, as particles.
 *
 * The light has been the whole of this port's muzzle flash since D-115, which
 * lights the room and shows the shooter nothing -- Q3 also hangs a small
 * additive model on `tag_flash` for the same twenty milliseconds. That is now a
 * burst on the emitter path, and it has the same two-muzzle problem the light
 * has: the player's own comes off the gun's `tag_flash` and everyone else's off
 * `CalcMuzzlePoint`.
 *
 * What is worth asserting is the wiring rather than the artwork. A burst raised
 * at the wrong point, in the wrong direction, or twice per shot is a defect; how
 * many sparks it throws is a number somebody will tune.
 */
describe('a shot throws a burst out of the muzzle', () => {
    /** Every burst raised, with what it was told. */
    function recorder(): {
        calls: { position: number[]; direction: number[]; weapon: string }[];
        muzzleFlashParticles(
            position: readonly number[],
            direction: readonly number[],
            weapon: string
        ): void;
    } {
        const calls: { position: number[]; direction: number[]; weapon: string }[] = [];
        return {
            calls,
            muzzleFlashParticles(position, direction, weapon): void {
                calls.push({ position: [...position], direction: [...direction], weapon });
            },
        };
    }

    it('raises one burst per shot, and none for a frame with no shot in it', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');
        const particles = recorder();
        view.particles = particles;

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(particles.calls.length, 'a burst nobody asked for').toBe(0);

        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(particles.calls.length).toBe(1);

        // The light is still up for the rest of its fifty milliseconds; the
        // burst is not re-raised behind it.
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(particles.calls.length, 'the burst repeated while the light lived').toBe(1);
        expect(view.flashLit, 'the light went out early').toBe(true);

        // Track the dataset is real, so this is the same gun the light is on.
        expect(litPoints(ecd).length).toBe(1);
    });

    it('puts the burst on `tag_flash`, exactly where the light is', () => {
        const { ecd, view } = drawing('WP_SHOTGUN');
        const particles = recorder();
        view.particles = particles;

        view.flash('WP_SHOTGUN');
        view.update(pose([2, 3, 4]), 0.016, held('WP_SHOTGUN'));

        const light = onlyLight(ecd);
        const [x, y, z] = particles.calls[0]!.position;

        /*
         The same point, not merely a nearby one. Both come off the gun's own
         `tag_flash` in the frame that drew it, and the whole reason the burst is
         raised from `update` rather than from `flash` is that a shot arrives
         from the simulation, where the only muzzle available is last frame's.
        */
        expect(x).toBeCloseTo(light.x, 9);
        expect(y).toBeCloseTo(light.y, 9);
        expect(z).toBeCloseTo(light.z, 9);
    });

    it('throws it down the barrel and not down the view', () => {
        const { view } = drawing('WP_SHOTGUN');
        const particles = recorder();
        view.particles = particles;

        // Face along the camera's own +Z, which is where an unturned view looks.
        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        const d = particles.calls[0]!.direction;
        expect(Math.hypot(d[0]!, d[1]!, d[2]!), 'not a unit direction').toBeCloseTo(1, 6);

        /*
         A converted model points +x down its own length and `MODEL_TO_VIEW`
         turns that onto the camera's forward, so the burst must come out of the
         *front* of the gun. The sway tilts it by a fraction of a degree; the
         test is the sign, because the sign is what a wrong quaternion order
         gets wrong -- and it would come out sideways or backwards, not slightly
         off.
        */
        expect(d[2]!, 'the burst is not going where the gun points').toBeGreaterThan(0.99);
    });

    it('names the weapon in hand, so the burst is the colour the light is', () => {
        const { view } = drawing('WP_SHOTGUN');
        const particles = recorder();
        view.particles = particles;

        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        expect(particles.calls[0]!.weapon).toBe('WP_SHOTGUN');
    });

    it('drops a burst whose gun left the screen before it could be drawn', () => {
        const { view } = drawing('WP_SHOTGUN');
        const particles = recorder();
        view.particles = particles;

        // Shot and killed inside the same frame boundary.
        view.flash('WP_SHOTGUN');
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN', false));
        expect(particles.calls.length, 'a burst at a muzzle that is not there').toBe(0);

        // And it does not turn up late, when the gun comes back.
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(particles.calls.length).toBe(0);
    });

    it('draws nothing at all when nothing has handed it an emitter', () => {
        const { view } = drawing('WP_SHOTGUN');

        // `particles` is null until `main.ts` sets it; a test that only wants
        // the light half of this class must not have to.
        view.flash('WP_SHOTGUN');
        expect(() => view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'))).not.toThrow();
        expect(view.flashLit, 'and the light still works').toBe(true);
    });
});

/*
 * The other muzzle: a shooter with no gun on screen.
 *
 * `Effects.muzzleFlash` raises both halves for them -- the light at
 * `CalcMuzzlePoint` and the burst at the same point, along the shooter's own
 * forward -- because a bot firing at you should be visible as more than a
 * change in the room's lighting.
 */
describe('a shooter with no gun on screen still throws a burst', () => {
    it('raises an emitter beside the light, at the shot origin', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        effects.muzzleFlash([64, 0, 32], [1, 0, 0], 'WP_MACHINEGUN');

        const positions: { x: number; y: number; z: number }[] = [];
        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (emitter: unknown, transform: Transform) => void
        ) => void;

        traverse([ParticleEmitter, Transform], (_emitter, transform) => {
            positions.push({ x: transform.position.x, y: transform.position.y, z: transform.position.z });
        });

        expect(positions.length, 'no burst for a shot with no gun on screen').toBe(1);
        // Q3 (x, y, z) -> meep (x, z, -y), in metres -- the light's own map.
        expect(positions[0]!.x).toBeCloseTo(64 * S, 6);
        expect(positions[0]!.y).toBeCloseTo(32 * S, 6);
        expect(positions[0]!.z).toBeCloseTo(0, 6);
    });

    it('does not raise one for a shot the gun took', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = new Arena(ecd as never, {} as never);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        /*
         Both halves go to the gun or neither does. `Arena` asks the view weapon
         first and only falls through to the world on a refusal, so a shot the
         gun accepted must leave no world emitter behind -- otherwise every shot
         you fire draws two flashes, one of them half a metre in front of your
         face.
        */
        arena.muzzleFlash([100, 0, 0], FORWARD, 'WP_SHOTGUN', 0);

        let emitters = 0;
        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (emitter: unknown) => void
        ) => void;
        traverse([ParticleEmitter], () => {
            emitters += 1;
        });

        expect(emitters, 'the world drew a flash for a shot the gun took').toBe(0);
    });
});

/*
 * Which weapons have anything to show at the muzzle.
 *
 * `CG_AddPlayerWeapon` builds the flash entity and then bails on
 * `if (!flash.hModel) return;`, which is above the dlight and above
 * `CG_LightningBolt` -- so a weapon with no `_flash.md3` shows nothing at all.
 * Three of the thirteen are in that case and the burst has to know which,
 * because sparks out of a gauntlet is a thing somebody would report.
 */
describe('only the weapons Q3 has a flash model for throw a burst', () => {
    /** What `hasFlashModel` claims, checked against the pk3s it came from. */
    it('names exactly the weapons OpenArena ships no `_flash.md3` for', () => {
        const weapons = (balance.items as { type: string; tag: string; models: string[] }[])
            .filter((i) => i.type === 'IT_WEAPON')
            .map((i) => ({ tag: i.tag, world: i.models[0]!.replace(/\\/g, '/') }));

        expect(weapons.length, 'weapons in the balance table').toBe(13);

        const claimed: string[] = [];
        const onDisk: string[] = [];

        for (const { tag, world } of weapons) {
            const flash = join(
                process.cwd(),
                'assets',
                'extracted',
                `${world.slice(0, -'.md3'.length)}_flash.md3`
            );

            if (!hasFlashModel(tag)) claimed.push(tag);
            if (!existsSync(flash)) onDisk.push(tag);
        }

        expect(claimed.sort(), 'the table and the pk3s disagree').toEqual(onDisk.sort());
        expect(onDisk.sort()).toEqual(
            ['WP_GAUNTLET', 'WP_GRAPPLING_HOOK', 'WP_PROX_LAUNCHER'].sort()
        );
    });

    it('draws no burst for a weapon with nothing to draw', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        effects.muzzleFlash([64, 0, 0], FORWARD, 'WP_GAUNTLET');

        let emitters = 0;
        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (emitter: unknown) => void
        ) => void;
        traverse([ParticleEmitter], () => {
            emitters += 1;
        });

        expect(emitters, 'the gauntlet threw sparks').toBe(0);

        /*
         The light is still there, and deliberately. Q3's `return` is above the
         dlight too, so this is the port's divergence rather than the C's -- a
         shot with no light at all reads as a shot that did not happen (D-115).
         Pinned here so that gating the burst is not read as a licence to gate
         the light without arguing it.
        */
        expect(litPoints(ecd).length, 'the gauntlet stopped lighting its own shot').toBe(1);
    });
});

/*
 * The right angle that made `ParticleEmitterSystem3` throw.
 *
 * The burst is a cone, and meep's `ConicRay` builds the rotation that carries
 * the cone onto its axis as `k = 1 / (1 + dZ)`. That is singular at the south
 * pole and `ConicRay` knows it -- there is an early return for `(0, 0, -1)`
 * above the division, and another for `(0, 0, 1)`. Both compare **exactly**,
 * and `ConicRay.fromJSON` copies the direction it is handed rather than
 * normalising it, so what reaches the division is the caller's own arithmetic.
 *
 * Q3's `AngleVectors` is a float, and a float cosine of ninety degrees is
 * -4.371e-8 rather than zero, because the angle was rounded before the cosine
 * was taken. So a shooter facing exactly along +Y produced an axis that was the
 * south pole to eight digits and not to the early return, `k` came out
 * `Infinity`, `Infinity * 0` made a NaN, and the throw out of `Vector3.set`
 * aborted the whole particle system for that frame -- and for every frame after
 * it, because the emitter throws on its way to the flag that says it is
 * initialised and so is retried until it is retired.
 *
 * The complaint was "several rockets at once", which it was not: one shot at one
 * yaw, from any weapon whose flash the world draws. See D-147.
 */
/** A cone axis, and the sampler that has to be able to rotate onto it. */
interface Cone {
    readonly direction: { readonly x: number; readonly y: number; readonly z: number };
    readonly angle: number;
    sampleRandomDirection(random: () => number, result: Vector3): void;
}

/** The one field of an emitter's layer this file reads. See `cones`. */
interface EmitterLayers {
    readonly layers: {
        get(index: number): { readonly particleVelocityDirection: Cone };
    };
}

describe('a muzzle pointed exactly along an axis', () => {
    /**
     * Layer 0's cone, as the emitter component actually holds it.
     *
     * Through a cast, because `layers` carries an `@private` that TypeScript
     * reads off the JSDoc -- meaning "the emitter owns its layers", not "nobody
     * may look". The alternative is asserting on the JSON that went in, which
     * would pin the argument rather than what `ConicRay` will divide by.
     */
    function cones(ecd: EntityComponentDataset): { x: number; y: number; z: number }[] {
        const found: { x: number; y: number; z: number }[] = [];
        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (emitter: EmitterLayers) => void
        ) => void;

        traverse([ParticleEmitter], (emitter) => {
            const d = emitter.layers.get(0).particleVelocityDirection.direction;
            found.push({ x: d.x, y: d.y, z: d.z });
        });

        return found;
    }

    /** The burst's cone, when exactly one burst was raised. */
    function onlyCone(ecd: EntityComponentDataset): Cone {
        const found: Cone[] = [];
        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (emitter: EmitterLayers) => void
        ) => void;

        traverse([ParticleEmitter], (emitter) => {
            found.push(emitter.layers.get(0).particleVelocityDirection);
        });

        expect(found.length, 'exactly one burst per shot').toBe(1);
        return found[0]!;
    }

    /*
     Not a hand-written vector: the point is that Q3's own float arithmetic is
     what produces the awkward one, so the test has to go through it. A literal
     here would pass forever after somebody changed `angleVectors`.
    */
    it('is a float right angle, not an exact one', () => {
        const forward = vec3();
        angleVectors([0, 90, 0], forward, null, null);

        expect(forward[1], 'yaw 90 should point along +Y').toBe(1);
        expect(forward[0], 'a float cos(90) that was exactly zero would hide this').not.toBe(0);
        expect(Math.abs(forward[0]!)).toBeLessThan(1e-6);
    });

    it('hands the emitter the pole exactly, so the cone can be rotated onto it', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        const forward = vec3();
        angleVectors([0, 90, 0], forward, null, null);

        effects.muzzleFlash([64, 0, 32], forward, 'WP_MACHINEGUN');

        const [cone] = cones(ecd);
        expect(cone, 'no burst was raised at all').toBeDefined();

        // Q3 +Y is meep -Z. Exactly, or `ConicRay` divides by zero.
        expect(cone!.x).toBe(0);
        expect(cone!.y).toBe(0);
        expect(cone!.z).toBe(-1);
    });

    it('lets the sampler rotate the cone onto it instead of throwing NaN', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        const forward = vec3();
        angleVectors([0, 90, 0], forward, null, null);

        effects.muzzleFlash([64, 0, 32], forward, 'WP_MACHINEGUN');

        /*
         `sampleRandomDirection` is where the throw came from, reached from
         `ParticleEmitter.initialize` once per particle of the immediate
         emission. Driving it here rather than `initialize` is what makes this a
         headless test: the emitter has no particle pool until the render system
         hands it one, and the pool is not what was wrong.
        */
        const cone = onlyCone(ecd);
        const out = new Vector3(0, 0, 0);

        expect(() => cone.sampleRandomDirection(Math.random, out)).not.toThrow();

        const finite = Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
        expect(finite, 'a NaN got through').toBe(true);
        expect(Math.hypot(out.x, out.y, out.z), 'not a unit direction').toBeCloseTo(1, 9);

        // And it landed inside the cone it was asked for, around Q3 +Y.
        expect(Math.acos(-out.z)).toBeLessThanOrEqual(cone.angle + 1e-9);
    });

    /*
     And the other pole, which was never broken -- `k = 1/2` there -- but is
     snapped by the same guard and would be a silent behaviour change if the
     guard ever got the sign wrong.
    */
    it('snaps the north pole too, where the same shot points the other way', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        const forward = vec3();
        angleVectors([0, 270, 0], forward, null, null);

        effects.muzzleFlash([64, 0, 32], forward, 'WP_MACHINEGUN');

        const [cone] = cones(ecd);
        expect(cone!.x).toBe(0);
        expect(cone!.y).toBe(0);
        expect(cone!.z).toBe(1);
    });

    /*
     A direction that is not a pole is left alone apart from being normalised,
     because snapping a general axis would be a bug of its own.
    */
    it('leaves an ordinary direction where it was', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd as never, new Shadows(null, 'off'));

        const forward = vec3();
        angleVectors([0, 45, 0], forward, null, null);

        effects.muzzleFlash([64, 0, 32], forward, 'WP_MACHINEGUN');

        const [cone] = cones(ecd);
        const r = Math.SQRT1_2;
        expect(cone!.x).toBeCloseTo(r, 6);
        expect(cone!.y).toBeCloseTo(0, 9);
        expect(cone!.z).toBeCloseTo(-r, 6);
        expect(Math.hypot(cone!.x, cone!.y, cone!.z), 'not a unit axis').toBeCloseTo(1, 12);
    });
});

/* ------------------------------------------------------------------ *
 * The bundle
 *
 * Everything above runs on a stub with round numbers, which pins the
 * arithmetic and says nothing about the models the game actually loads. These
 * read the built bundle, because the whole of D-158 is a claim about what OA's
 * thirteen weapons do and do not carry.
 * ------------------------------------------------------------------ */

const BUILT = join(process.cwd(), 'assets', 'built');

function bundleLibrary(): ModelLibrary {
    const bundle = JSON.parse(
        readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
    ) as ModelBundle;

    // Geometry is not touched: every assertion below reads `definition`.
    return new ModelLibrary(bundle, new Float32Array(0), new Uint32Array(0), []);
}

const WEAPONS = (balance.items as { type: string; tag: string; models: string[] }[])
    .filter((i) => i.type === 'IT_WEAPON')
    .map((i) => ({ tag: i.tag, world: i.models[0]!.replace(/\\/g, '/') }));

/** The muzzle measured from the eye, in Q3's own forward/right/up. */
function fromTheEye(
    library: ModelLibrary,
    weapon: { tag: string; world: string }
): { forward: number; right: number; up: number } {
    const hand = handOffset(library, weapon.tag)!;
    const muzzle = muzzleOffset(library, weapon.world)!;

    // `hand` is the camera's -- x left, y up, z forward -- and `muzzle` is the
    // model's -- x forward, y up, z right. The same sum `barrelOffset` makes.
    return {
        forward: hand[2] + muzzle[0],
        right: -hand[0] + muzzle[2],
        up: hand[1] + muzzle[1],
    };
}

describe('every weapon OpenArena ships has a muzzle to be lit at', () => {
    /**
     * The complaint, as a property of all thirteen rather than of eleven.
     *
     * `CalcMuzzlePoint` is `forward * 14` and nothing else, so its `right` and
     * `up` are exactly zero however the player is facing -- that is what "in
     * your face" means numerically. Every weapon's muzzle now clears it in all
     * three: further out than fourteen units, on the right where the gun is
     * drawn, and below the crosshair.
     */
    it('puts it off the view axis, in front of the eye and on the gun side', () => {
        const library = bundleLibrary();

        expect(WEAPONS.length, 'weapons in the balance table').toBe(13);

        for (const weapon of WEAPONS) {
            expect(muzzleOffset(library, weapon.world), `${weapon.tag} has no muzzle`).not.toBeNull();

            const { forward, right, up } = fromTheEye(library, weapon);

            expect(forward, `${weapon.tag} is nearer than CalcMuzzlePoint`).toBeGreaterThan(14);
            expect(right, `${weapon.tag} is not on the side the gun is drawn`).toBeGreaterThan(3);
            expect(up, `${weapon.tag} is not below the crosshair`).toBeLessThan(0);
            expect(
                Math.hypot(right, up),
                `${weapon.tag} is on the view axis, which is the bug`
            ).toBeGreaterThan(5);
        }
    });

    /**
     * Which step of the cascade each weapon takes, named rather than counted.
     *
     * The list is the interesting part: if a pipeline change drops the tags, or
     * OA's assets are swapped for ones that carry more of them, this is where
     * the port finds out -- and the second and third rows are the only reason
     * {@link muzzleOffset} exists at all.
     */
    it('reads a tag for twelve of them and measures the thirteenth', () => {
        const library = bundleLibrary();

        const authored: string[] = [];
        const barrelled: string[] = [];
        const measured: string[] = [];

        for (const { tag, world } of WEAPONS) {
            const tags = library.definition(world)!.tags;

            if (tags.some((t) => t.name === 'tag_flash')) authored.push(tag);
            else if (tags.some((t) => t.name === 'tag_barrel')) barrelled.push(tag);
            else measured.push(tag);
        }

        expect(authored.length, 'weapons whose author marked a muzzle').toBe(11);
        expect(barrelled, 'the gauntlet has a blade mount and no muzzle').toEqual(['WP_GAUNTLET']);
        expect(measured, "OA's prox launcher marks nothing at all").toEqual(['WP_PROX_LAUNCHER']);
    });

    /**
     * What the third step is worth, measured against the muzzles that *were*
     * authored -- which is the only check available for a number no modeller
     * wrote down.
     *
     * Only the weapons it would actually be reached for are comparable: one
     * file, no barrel model, so the front of the bounds is the front of the
     * gun. On those it lands within a few centimetres of the authored point.
     */
    it('estimates a muzzle within five units of an authored one', () => {
        const library = bundleLibrary();
        let compared = 0;

        for (const { tag, world } of WEAPONS) {
            const def = library.definition(world)!;

            const flash = def.tags.find((t) => t.name === 'tag_flash');
            if (flash === undefined) continue;
            if (library.definition(world.replace(/\.md3$/, '_barrel.md3')) !== null) continue;
            if (tag === 'WP_SHOTGUN') continue; // see below

            const estimate = [
                def.maxs[0]!,
                (def.mins[1]! + def.maxs[1]!) / 2,
                (def.mins[2]! + def.maxs[2]!) / 2,
            ];

            const error = Math.hypot(
                estimate[0]! - flash.origin[0]!,
                estimate[1]! - flash.origin[1]!,
                estimate[2]! - flash.origin[2]!
            );

            expect(error, `${tag}'s front is nowhere near its muzzle`).toBeLessThan(5);
            compared += 1;
        }

        // Three `continue`s above, and a loop that skipped everything would
        // pass silently. Six weapons are one file with a marked muzzle.
        expect(compared, 'nothing was actually compared').toBe(6);
    });

    /**
     * And its failure mode, pinned rather than hidden.
     *
     * `shotgun.md3` carries a second surface that is not the gun: an additive
     * laser-sight beam running from x = 20 to x = 45, which drags the model's
     * bounds twenty-two units past the barrel. The shotgun marks a `tag_flash`,
     * so the estimate is never reached for it -- but a future weapon with a
     * decorative surface and no tags would put its light out in mid-air, and
     * that is the reason the estimate is the last step and not the rule.
     */
    it('would be wrong about the one model that carries something that is not the gun', () => {
        const library = bundleLibrary();
        const def = library.definition('models/weapons2/shotgun/shotgun.md3')!;
        const flash = def.tags.find((t) => t.name === 'tag_flash')!;

        expect(def.maxs[0]! - flash.origin[0]!, 'the laser sight is not the barrel').toBeGreaterThan(
            20
        );
        expect(muzzleOffset(library, 'models/weapons2/shotgun/shotgun.md3')![0], 'so the tag wins')
            .toBeCloseTo(flash.origin[0]!, 6);
    });
});
