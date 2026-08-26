/*
 * statusBar.ts -- what the status bar shows, without a screen.
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
 * `crosshair.ts`'s companion, and it exists for the same reason: which icon,
 * what scale, when to go red are arithmetic over Q3's own tables, and a function
 * that answers them can be checked against the C while the same code inside a
 * DOM class cannot.
 *
 * Q3 drew health, armour and ammo as three numbers and nothing else, so the
 * *bars* this port draws are the port's own -- and a bar needs one thing Q3
 * never had to state: where full is. Everything below is an attempt to answer
 * that out of the shipped tables rather than by picking numbers that look nice.
 */

import {
    ammoItemByTag,
    MAX_AMMO,
    MAX_HEALTH,
    newInventory,
    weaponItemByTag,
} from '../game/Items.ts';

/**
 * Where the health and armour bars are full.
 *
 * `maxHealth * 2` is the ceiling both of them are clamped to -- `Pickup_Armor`
 * and `Pickup_Health`, either side of `Add_Ammo` in `g_items.c`: armour stops at
 * 200, and only mega health and the 5-point bubble go past 100, also to 200.
 * Above it `ClientTimerActions` bleeds one point a second back down, so it is a
 * ceiling rather than a cap.
 *
 * One number for both, which is the point of it: the two bars sit against each
 * other on the left of the screen, share a scale and therefore share their
 * notch spacing, and "80 health and 120 armour" is a thing you can see rather
 * than read.
 */
export const POOL_MAX = MAX_HEALTH * 2;

/**
 * `CG_DrawStatusBar`: at 25 and below, the health number flashes.
 *
 * The C is a four-way branch -- white above 100, orange above 25, *flashing*
 * between orange and red from 25 down to 1, red at zero and below -- and the
 * flash is `(cg.time >> 8) & 1`, a plain toggle every 256 ms. The port draws
 * that as a class and a CSS animation; this constant is where the branch is.
 */
export const LOW_HEALTH = 25;

/**
 * `CG_CheckAmmo`'s prices: what one round of a weapon is worth.
 *
 * Q3 has no per-weapon low-ammo threshold, and it does have this -- the sum it
 * runs over the whole inventory to decide whether to say "LOW AMMO". A rocket
 * is worth 1000 and a bullet 200, so five rockets and twenty-five bullets are
 * the same amount of fight, which is the ratio a HUD wants when it decides
 * whether to alarm the player about one gun.
 */
const AMMO_WORTH_HEAVY = 1000;
const AMMO_WORTH_LIGHT = 200;

/** `CG_CheckAmmo`: at or above this total, the warning goes away. */
const AMMO_WORTH_SAFE = 5000;

/** The weapons `CG_CheckAmmo` prices at {@link AMMO_WORTH_HEAVY}. */
const HEAVY = new Set([
    'WP_ROCKET_LAUNCHER',
    'WP_GRENADE_LAUNCHER',
    'WP_RAILGUN',
    'WP_SHOTGUN',
    'WP_PROX_LAUNCHER',
]);

/** `ClientSpawn`'s loadout, which is one of the three tables `ammoFull` reads. */
const SPAWN_AMMO: Readonly<Record<string, number>> = newInventory().ammo;

/**
 * Q3's "infinite", which is what the gauntlet carries.
 *
 * `ps->ammo[w] > -1` is the test `CG_DrawStatusBar` guards the whole ammo
 * readout with, so a negative count is not a small count -- it is the absence of
 * a count, and the port draws no bar for it at all.
 */
export function ammoIsInfinite(rounds: number): boolean {
    return rounds < 0;
}

/**
 * Where the ammo bar is full, for the weapon in hand.
 *
 * Per weapon rather than one scale for all of them, because a full load differs
 * by a factor of twenty across the rack: `MAX_AMMO` is 200 for everything, and a
 * rocket launcher drawn against 200 reads as empty while holding every rocket
 * on the map. What the bar is for is "how much fight is left in this gun", and
 * that quantity is per gun.
 *
 * The number is the largest amount Q3 itself will hand the player at once: the
 * weapon pickup's own load, a box of its ammunition, or -- for the machinegun,
 * the only weapon where it is the largest of the three -- the spawn loadout.
 * All three are `bg_itemlist` and `ClientSpawn`; none of them is invented here.
 *
 * The fallback is `MAX_AMMO`, and what reaches it is a weapon with no
 * ammunition at all -- the gauntlet, the grappling hook, and an id that is not
 * in the table. None of those draws a bar, so the number is there to keep the
 * function total rather than to be shown; 200 is the only ceiling the game
 * states for all of them.
 */
export function ammoFull(weapon: string): number {
    const full = Math.max(
        weaponItemByTag(weapon)?.quantity ?? 0,
        ammoItemByTag(weapon)?.quantity ?? 0,
        SPAWN_AMMO[weapon] ?? 0
    );

    return full > 0 ? full : MAX_AMMO;
}

/**
 * `CG_CheckAmmo`, asked about one weapon instead of the whole inventory.
 *
 * The C sums every weapon's rounds at the prices above and warns below 5000.
 * Running the same arithmetic over the held weapon alone is where the number
 * beside the crosshair should go red -- five rockets, twenty-five bullets --
 * and it is Q3's arithmetic rather than a threshold this port chose.
 *
 * Infinite ammo is never low; zero always is.
 */
export function ammoIsLow(weapon: string, rounds: number): boolean {
    if (ammoIsInfinite(rounds)) return false;

    const worth = HEAVY.has(weapon) ? AMMO_WORTH_HEAVY : AMMO_WORTH_LIGHT;

    return rounds * worth < AMMO_WORTH_SAFE;
}

/**
 * `cg_weapons[w].weaponIcon`, as a URL.
 *
 * The path is the balance table's own -- `icons/iconw_rocket` -- and
 * `convert-fx.ts` writes the leaf of it into `assets/built/fx`. Both sides read
 * the same field of the same file, so there is no list here to fall out of step
 * with the list of what was converted.
 *
 * Null for an id with no weapon entry, which the HUD draws as no icon rather
 * than as a broken image.
 */
export function weaponIcon(weapon: string): string | null {
    const icon = weaponItemByTag(weapon)?.icon;
    if (icon === undefined || icon === '') return null;

    return `/assets/built/fx/${icon.slice(icon.lastIndexOf('/') + 1)}.png`;
}

/**
 * `WP_ROCKET_LAUNCHER` as "rocket launcher".
 *
 * The id is what the simulation passes around and is not a thing to show
 * anybody. Its one use is the icon's accessible name: the icon is a background
 * image, and a background image is the one kind of picture with no text of its
 * own for a screen reader to reach.
 */
export function weaponLabel(weapon: string): string {
    return weapon.replace(/^WP_/, '').toLowerCase().replace(/_/g, ' ');
}
