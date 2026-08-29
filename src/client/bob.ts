/*
 * bob.ts -- the gait, as one counter, read the way Q3 reads it.
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
 * `CG_CalcViewValues` turns `ps->bobCycle` into the two quantities every
 * consumer of the gait actually wants:
 *
 *     cg.bobcycle   = ( ps->bobCycle & 128 ) >> 7;
 *     cg.bobfracsin = fabs( sin( ( ps->bobCycle & 127 ) / 127.0 * M_PI ) );
 *
 * Three things downstream read them -- the footstep events, the gun's sway
 * (`CG_CalculateWeaponPosition`) and the view bob (`CG_OffsetFirstPersonView`)
 * -- which is why this is its own module rather than a pair of helpers inside
 * whichever of them was written first. D-082's finding was that keeping a second
 * copy of the counter is how the port ended up with two gaits that disagreed;
 * keeping a second copy of the *arithmetic over* it is the same mistake one step
 * further out. `ViewWeapon` re-exports both so nothing that already imports them
 * from there has to move.
 */

/** One arch of the sine per 128 cycle units; `bobCycle` wraps at 256. */
export const BOB_HALF = 128;

/**
 * `cg.bobfracsin`: `fabs(sin((bobCycle & 127) / 127.0 * M_PI))`.
 *
 * One arch per half-cycle, zero at each end of it. What that arch is a function
 * of is the correction in D-081 and is worth stating where the reader is:
 * `ps->bobCycle` is a **clock**, advanced by `bobmove * msec` in `PM_Footsteps`,
 * so a stride takes 320 ms at a run whatever the player's speed. Sprinting does
 * not bob you faster, it moves you further per bob. Reconstructing this from
 * distance travelled -- which is what the first version of the view weapon did
 * -- runs at better than twice the rate at Q3's own run speed, and what reads as
 * a bob at 3 Hz reads as a shiver at 7.
 *
 * The `127` rather than `128` is the C's and is kept: it means the arch peaks a
 * hair past halfway and never quite returns to zero at the top of the byte.
 */
export function bobFracSin(bobCycle: number): number {
    return Math.abs(Math.sin(((bobCycle & 127) / 127) * Math.PI));
}

/** `cg.bobcycle & 1`: flips every arch, so left and right lean apart. */
export function bobOddCycle(bobCycle: number): boolean {
    return (bobCycle & BOB_HALF) !== 0;
}
