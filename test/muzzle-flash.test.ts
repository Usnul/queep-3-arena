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
 * See D-115.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ParticleEmitter } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleEmitter.js';

import { ViewWeapon, type CameraPose, type ViewWeaponState } from '../src/client/ViewWeapon.ts';
import { Effects } from '../src/client/Effects.ts';
import { Arena } from '../src/client/Arena.ts';
import { Shadows } from '../src/client/Shadows.ts';
import {
    hasFlashModel,
    MUZZLE_FLASH_SECONDS,
    muzzleFlashLight,
    type MuzzleFlashLight,
} from '../src/client/muzzleFlash.ts';
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

const PIECES: Readonly<Record<string, number>> = {
    'models/weapons2/shotgun/shotgun.md3': 2,
    'models/weapons2/rocketl/rocketl.md3': 3,
    'models/weapons2/gauntlet/gauntlet.md3': 1,
};

function stubLibrary() {
    return {
        definition(name: string) {
            if (name.endsWith('_hand.md3')) {
                return { tags: [{ name: 'tag_weapon', origin: HAND_TAG }] };
            }

            const flash = FLASH_TAGS[name];
            if (flash === undefined) return PIECES[name] === undefined ? null : { tags: [] };

            return { tags: [{ name: 'tag_flash', origin: flash }] };
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
     The gauntlet, and OA's prox launcher: a model with no `tag_flash`. Q3 lights
     these from the player's own origin, which is roughly where the fallback puts
     them, so declining is the faithful answer rather than a hole.
    */
    it('is declined by a weapon whose model ships no flash tag', () => {
        const { view } = drawing('WP_GAUNTLET');

        expect(view.drawnWeapon, 'the gauntlet is drawn').toBe('WP_GAUNTLET');
        expect(view.flash('WP_GAUNTLET'), 'but it has no muzzle to flash').toBe(false);
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

    it('falls back to the world when the player has no gun to flash', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = newArena(ecd);
        arena.viewWeapon = view;

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
        arena.muzzleFlash([64, 0, 0], FORWARD, 'WP_GAUNTLET', 0);

        const flash = onlyLight(ecd);
        expect(flash.x, 'the gauntlet has no flash tag, so the shot lights itself').toBeCloseTo(
            64 * S,
            6
        );
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
