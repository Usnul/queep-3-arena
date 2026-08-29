/*
 * impactSound.ts -- the noise a shot makes where it lands.
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
 * `CG_MissileHitWall`'s `sfx`, which is one column of the same `switch (weapon)`
 * that `Effects.MISSILE_MARKS` is another column of.
 *
 * The marks column has been a per-weapon table since phase 3. **The sound column
 * was two constants** -- `Arena.bulletImpact` played `impact/bullet` for anything
 * hitscan and `Arena.explosion` played `impact/rocket` for anything that
 * exploded. So a railgun struck a wall with a machinegun's ricochet, a plasma
 * bolt and a BFG shot detonated with a rocket's blast, the shotgun fired eleven
 * ricochets a trigger pull where the C fires none, and `impact/plasma` sat in
 * the bank with nothing in the port naming it. The C reads both columns off one
 * row; so does this. See D-146.
 *
 * A separate module rather than a constant inside `Arena` for the reason
 * `muzzleFlash.ts` is one: it is a table read off the C, it wants to be checked
 * against the sound bank by a test that has no business constructing an arena,
 * and it has more than one caller -- both halves of the split `CG_MissileHitWall`
 * come back through {@link impactSound}.
 *
 * **Total over strings, on purpose**, and the same rule `muzzleFlash.ts` states:
 * D-114 says an outside string becomes a `WeaponId` only through `isWeaponId`,
 * and there is no crossing to make here because the C has a `default:` arm and
 * so does this.
 */

/**
 * `CG_MissileHitWall`'s `sfx`, as a name in the sound bank.
 *
 * `null` is a row and not an omission. `case WP_SHOTGUN` sets `sfx = 0` and the
 * call site below the switch is guarded by `if ( sfx )`, because eleven pellets
 * landing within a few milliseconds of each other are a spread of *marks* and a
 * single report -- the one the gun already made. The gauntlet is null for a
 * different reason: `Weapon_Gauntlet` damages what it touches and raises no
 * impact event at all, so a swing that stops on a wall never reaches this switch
 * in the C. It reaches it here, because this port traces the gauntlet like any
 * other hitscan weapon, and null is how that difference is kept inaudible.
 */
const IMPACT_SOUNDS: Readonly<Record<string, string | null>> = {
    WP_GAUNTLET: null,
    WP_SHOTGUN: null,

    // `sfx_ric1` / `ric2` / `ric3`, picked between per impact.
    WP_MACHINEGUN: 'impact/bullet',
    /*
     `sfx_chghit` is `weapons/vulcan/wvulimpd.wav`, which OpenArena does not
     ship -- nor its flesh and metal siblings. The chaingun fires the
     machinegun's ammunition through a bigger barrel, so it takes the
     machinegun's ricochet; a substitution, recorded as one.
    */
    WP_CHAINGUN: 'impact/bullet',

    // `sfx_lghit1` / `lghit2` / `lghit3`. No explosion with it: the C says the
    // lightning gun's impact is added with the beam.
    WP_LIGHTNING: 'impact/lightning',

    // `sfx_plasmaexp` for both. The railgun's own `sfx_railg` is commented out
    // in the C, on the line immediately above the assignment that replaces it.
    WP_RAILGUN: 'impact/plasma',
    WP_PLASMAGUN: 'impact/plasma',

    // `sfx_rockexp` for all three: a grenade detonates with a rocket's blast,
    // and so does a BFG shot. Only the shader and the mark radius differ.
    WP_GRENADE_LAUNCHER: 'impact/rocket',
    WP_ROCKET_LAUNCHER: 'impact/rocket',
    WP_BFG: 'impact/rocket',

    // `sfx_proxexp`.
    WP_PROX_LAUNCHER: 'impact/prox',
    /*
     `sfx_nghit` is `weapons/nailgun/wnalimpd.wav`, the default-surface variant,
     which OpenArena does not ship; `wnalimpm` -- the metal one, from the same
     set -- is what it has, and `convert-sounds.ts` maps this name to it. The
     substitution is a surface the port cannot tell apart rather than a weapon
     borrowing another weapon's sound.
    */
    WP_NAILGUN: 'impact/nail',
};

/**
 * `CG_MissileHitWall`'s `default:`, which falls straight into `WP_NAILGUN`.
 *
 * The same fall-through `Effects.DEFAULT_MARK` reads, read the same way: the
 * `default` label sits immediately above `case WP_NAILGUN` with no `break`
 * between them, so a weapon the switch does not name really does make a nail's
 * noise and leave a nail's hole. Written down rather than thrown on, because
 * what it catches is whatever weapon arrives next.
 */
const DEFAULT_IMPACT_SOUND = 'impact/nail';

/**
 * The sound `weapon` makes where its shot lands, or `null` for the weapons Q3
 * deliberately lands in silence.
 *
 * @param weapon a `WP_*` id, or anything at all -- see the module note on why
 *     this is total over strings.
 */
export function impactSound(weapon: string): string | null {
    const named = IMPACT_SOUNDS[weapon];
    return named === undefined ? DEFAULT_IMPACT_SOUND : named;
}
