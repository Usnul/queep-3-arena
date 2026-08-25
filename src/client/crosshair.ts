/*
 * crosshair.ts -- `CG_DrawCrosshair`'s three rules, without a screen.
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
 * Which image, what colour, how big. All three are Q3's own and all three are
 * arithmetic, so they live here rather than in `Hud`: a function that turns
 * health and armour into a colour can be checked against the C in a test, and
 * the same code inside a DOM class cannot.
 *
 * The port draws no other 2D from `cg_draw.c`. This is the piece that had to
 * exist because a shooter without a reticle is not aimable, and the piece whose
 * rules are worth having rather than inventing.
 */

import { ARMOR_PROTECTION } from '../game/Weapons.ts';

/** `NUM_CROSSHAIRS`, and the ten files `cg_main.c` registers. */
export const NUM_CROSSHAIRS = 10;

/**
 * `cgs.media.crosshairShader[ ca % NUM_CROSSHAIRS ]`, as a URL.
 *
 * The registration loop is `va("gfx/2d/crosshair%c", 'a' + i)`, so
 * `cg_drawCrosshair 4` -- the shipped default -- is `crosshaire`, which is a
 * single dot. That surprises people who expect a cross and it is nonetheless
 * what Q3 draws, which is why all ten convert and the choice is a query
 * parameter rather than a decision made here.
 */
export function crosshairTexture(index: number): string {
    const ca = Math.max(0, Math.trunc(index)) % NUM_CROSSHAIRS;
    const letter = String.fromCharCode('a'.charCodeAt(0) + ca);

    return `/assets/built/fx/crosshair${letter}.png`;
}

/**
 * `CG_GetColorForHealth`, which `cg_crosshairHealth` applies by default.
 *
 * Armour counts toward the colour, but only as far as it can actually absorb:
 * `G_Damage` sends `ARMOR_PROTECTION` of every hit to armour, so armour beyond
 * `health * p / (1 - p)` outlives the health it was protecting and does not make
 * the player any harder to kill. Q3 clamps to exactly that, and the effect in
 * play is that a crosshair on 100 health goes white and stays white until the
 * combined pool drops -- it is a damage indicator, not an armour readout.
 *
 * Returns sRGB components in 0..1. Black at zero health, which is Q3's way of
 * saying "you are dead" without a separate branch.
 */
export function crosshairColor(health: number, armor: number): [number, number, number] {
    if (health <= 0) return [0, 0, 0];

    const max = (health * ARMOR_PROTECTION) / (1 - ARMOR_PROTECTION);
    const effective = health + Math.min(Math.max(armor, 0), max);

    let green: number;
    if (effective > 60) green = 1;
    else if (effective < 30) green = 0;
    else green = (effective - 30) / 30;

    let blue: number;
    if (effective >= 100) blue = 1;
    else if (effective < 66) blue = 0;
    else blue = (effective - 66) / 33;

    return [1, green, blue];
}

/** `ITEM_BLOB_TIME`: how long a pickup swells the crosshair, in seconds. */
export const ITEM_BLOB_SECONDS = 0.2;

/**
 * The pickup pulse, as a multiplier on the crosshair's size.
 *
 * `w *= (1 + f)` where `f` runs 0..1 over `ITEM_BLOB_TIME` -- so it snaps to
 * normal size at the instant of the pickup and grows to double over the next
 * fifth of a second, which is the opposite of what "pulse" suggests and is what
 * the C does. It reads as a flick of the eye rather than a bounce.
 */
export function crosshairScale(pickupAgeSeconds: number): number {
    if (!(pickupAgeSeconds >= 0) || pickupAgeSeconds >= ITEM_BLOB_SECONDS) return 1;

    return 1 + pickupAgeSeconds / ITEM_BLOB_SECONDS;
}
