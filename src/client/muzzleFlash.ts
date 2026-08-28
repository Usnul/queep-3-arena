/*
 * muzzleFlash.ts -- the light a weapon throws when it fires.
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
 * `CG_RegisterWeapon`'s `flashDlightColor`, and the reach `CG_AddPlayerWeapon`
 * gives the dlight it hangs on `tag_flash`.
 *
 * Two consumers, because a shot has two possible shooters: `ViewWeapon` hangs
 * this light on the gun in your hands, and `Effects` puts one in the world for
 * everyone whose gun is not drawn. One table so the two cannot drift apart.
 *
 * **Total over strings, on purpose.** D-114's rule is that an outside string
 * becomes a `WeaponId` only through `isWeaponId`; there is no crossing to make
 * here because the C has a `default:` arm and so does this -- a weapon with no
 * entry gets a white flash rather than no flash.
 */

import type { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

/** One weapon's flash light. */
export interface MuzzleFlashLight {
    /** Linear RGB. `weaponInfo->flashDlightColor`, verbatim. */
    readonly color: readonly [number, number, number];
    /** How far it reaches, Q3 units: the radius `trap_R_AddLightToScene` is given. */
    readonly reachQ3: number;
    /** Luminous flux, lumens. The port's own number -- see the note below. */
    readonly lumens: number;
}

/**
 * How long a flash lives.
 *
 * The C's `MUZZLE_FLASH_TIME` is **20** ms, and this is not it. 20 ms is one
 * frame at 60 Hz and none at all if a frame runs long, so the faithful number
 * turns a light that should read as a pop into a light that some shots have and
 * others do not. 50 ms is what this port has always used and what the flash was
 * tuned against; the divergence is here rather than buried at a call site.
 */
export const MUZZLE_FLASH_SECONDS = 0.05;

/**
 * `CG_RegisterWeapon`'s `default:` arm: white, and the ordinary reach.
 *
 * Reached by a weapon this table has not been told about -- which is a weapon
 * `balance.weapons` has just grown, since the eleven it has are all below.
 */
const DEFAULT_FLASH: MuzzleFlashLight = { color: [1, 1, 1], reachQ3: 300, lumens: 1750 };

/**
 * Per weapon, and two of the three columns are Q3's own numbers.
 *
 * - `color` is `flashDlightColor` from `CG_RegisterWeapon`, transcribed. It is
 *   the whole of what Q3 varies per weapon, and it is why a plasma flash is
 *   blue and a railgun's is orange.
 * - `reachQ3` is the radius the dlight is added with. 300 is the impulse flash
 *   every weapon gets in `CG_AddPlayerWeapon`; 150 is what the three weapons
 *   that light *continuously while firing* -- gauntlet, lightning, grapple --
 *   are given instead, on the same line that admits the light "also comes from
 *   player center". This port fires those as discrete shots, so they get their
 *   own number rather than the impulse one.
 * - `lumens` is **chosen, not ported**. Q3's dlight has no brightness: it is a
 *   colour and a radius, so every flash in the game is equally bright and only
 *   its reach differs. Photometric units make "physically plausible" and "reads
 *   well" different questions (GAP-011), and this column is the second one --
 *   scaled to the muzzle blast the weapon looks like it should have, against the
 *   explosion's 12,000 lm as the bright end of the scale. The whole column came
 *   down 30% after the first set was seen in play: too hot, and uniformly so,
 *   which is what makes it one number rather than eleven. The ratios between the
 *   weapons survived that and are the part worth keeping.
 *
 * What is **not** here is a source radius, which is the one an area light wants
 * and the one this table would most like to vary: a shotgun's blast is a
 * hand-sized ball of fire and a railgun's is a slit. meep's ECS `Light` has no
 * field for it (GAP-030), so a value here would be a number nothing reads.
 */
const FLASHES: Readonly<Record<string, MuzzleFlashLight>> = {
    // MAKERGB( 0.6, 0.6, 1.0 ), and lit at 150 while firing rather than pulsed.
    WP_GAUNTLET: { color: [0.6, 0.6, 1], reachQ3: 150, lumens: 560 },
    WP_LIGHTNING: { color: [0.6, 0.6, 1], reachQ3: 150, lumens: 1400 },

    // MAKERGB( 1, 1, 0 ): the two weapons firing the same round.
    WP_MACHINEGUN: { color: [1, 1, 0], reachQ3: 300, lumens: 1260 },
    WP_CHAINGUN: { color: [1, 1, 0], reachQ3: 300, lumens: 1260 },

    // MAKERGB( 1, 1, 0 ), and the largest muzzle blast in the game.
    WP_SHOTGUN: { color: [1, 1, 0], reachQ3: 300, lumens: 3150 },

    // MAKERGB( 1, 0.70, 0 ).
    WP_GRENADE_LAUNCHER: { color: [1, 0.7, 0], reachQ3: 300, lumens: 1820 },
    WP_PROX_LAUNCHER: { color: [1, 0.7, 0], reachQ3: 300, lumens: 1820 },

    // MAKERGB( 1, 0.75f, 0 ).
    WP_ROCKET_LAUNCHER: { color: [1, 0.75, 0], reachQ3: 300, lumens: 2450 },

    // MAKERGB( 0.6, 0.6, 1.0 ), but pulsed like the rest.
    WP_PLASMAGUN: { color: [0.6, 0.6, 1], reachQ3: 300, lumens: 1540 },

    // MAKERGB( 1, 0.5f, 0 ).
    WP_RAILGUN: { color: [1, 0.5, 0], reachQ3: 300, lumens: 2100 },

    // MAKERGB( 1, 0.7f, 1 ), and the brightest thing a player carries.
    WP_BFG: { color: [1, 0.7, 1], reachQ3: 300, lumens: 4200 },
};

/** The flash `weapon` throws, or the white default for one with no entry. */
export function muzzleFlashLight(weapon: string): MuzzleFlashLight {
    return FLASHES[weapon] ?? DEFAULT_FLASH;
}

/**
 * Write `weapon`'s flash onto a point light.
 *
 * Both callers own their light component -- `Effects` builds one per shot and
 * throws it away, `ViewWeapon` keeps one and re-points it -- so this sets every
 * field either of them cares about rather than only the ones that changed.
 * Writing to a component already in the scene is supported for four of the five:
 * `color`, `intensity`, `distance` and `castShadow` carry signals that
 * `LightSystem3` subscribes to and refreshes Shade's light from.
 *
 * `type` does **not**. It is read once, in `link`, to decide which Shade light
 * to build, and it is not in the followed set -- so a flash that wanted to be a
 * spot light would have to leave the scene and come back rather than be
 * re-pointed. Every weapon here is a point light, which is why that is a note
 * and not a bug.
 */
export function applyMuzzleFlash(light: Light, weapon: string, castShadow: boolean): void {
    const flash = muzzleFlashLight(weapon);

    light.type.set(LightType.POINT);
    light.color.setRGB(flash.color[0], flash.color[1], flash.color[2]);
    // Lumens to candela, as everywhere else in this port: a point light's
    // intensity is luminous intensity and the table is authored as flux.
    light.intensity.set(flash.lumens / (4 * Math.PI));
    light.distance.set(flash.reachQ3 * WORLD_SCALE);
    light.castShadow.set(castShadow);
}
