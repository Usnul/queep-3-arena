/*
 * falloff.ts -- how far each sound carries, and the arithmetic that decides it.
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
 * The engine's falloff is `interpolate_irradiance_smith` -- meep's bounded
 * inverse-square approximation -- and this file does not touch it. What it
 * supplies is the pair of distances that curve is evaluated over, per sound,
 * because those are not a shape and they are not one number for the whole game:
 * `distanceMax` is a hard cull,
 *
 *     this.#audible = distance <= description.distanceMax && gain > ...
 *
 * and `LiveEmitterSet` culls loops at the same bound and stops them with a hard
 * cut rather than a fade. So the bound is a real edge in the world, and a single
 * edge for every sound puts a rocket detonating 1400 units away in the same bin
 * as a footstep at the same distance: not quiet, absent.
 *
 * **What is measured and what is authored.** The propagation is measured: a
 * point source spreading spherically loses amplitude as 1/r and intensity as
 * 1/r^2, and {@link cullRadiusQ3} is that relation solved for the distance at
 * which the energy reaches {@link CULL_ENERGY_FRACTION}. The *source level* is
 * authored, and cannot be anything else -- see {@link SOURCE_LEVEL_DB}.
 *
 * See D-149, and D-148 for the version of this that also replaced the curve,
 * which was wrong: this port is not reproducing Q3's mixer, it is running meep's
 * with a baked acoustic simulation behind it, and the falloff function is the
 * engine's business rather than the game's.
 */

import { interpolate_irradiance_smith }
    from '@woosh/meep-engine/src/core/math/physics/irradiance/interpolate_irradiance_smith.js';

/**
 * The fraction of a sound's full-volume energy at which it stops being worth a
 * voice.
 *
 * Intensity, not amplitude: 2% of the energy is `sqrt(0.02)` = 14.1% of the
 * amplitude, which is -17 dB. That is quiet enough to be at the edge of audible
 * against anything else happening, and loud enough that culling much earlier is
 * the audible mistake this file exists to fix.
 *
 * 2% is the middle of the 1-3% band. At 1% the radii grow by 41% and the far
 * tail of every sound in the game is a voice doing almost nothing; at 3% they
 * shrink by 18% and a distant explosion starts to disappear again.
 */
export const CULL_ENERGY_FRACTION = 0.02;

/**
 * Distance multiplier from the full-volume radius to the **audible** radius.
 *
 * Spherical spreading: `I(r) / I(r0) = (r0 / r)^2`. Setting that ratio to
 * {@link CULL_ENERGY_FRACTION} and solving gives `r = r0 / sqrt(fraction)`,
 * which is 7.071 at 2%. This is the physical answer to "how far away can this
 * still be heard", and it is the number the whole table is spaced by.
 */
export const AUDIBLE_RADIUS_FACTOR = 1 / Math.sqrt(CULL_ENERGY_FRACTION);

/**
 * Where along its range `interpolate_irradiance_smith` reaches the cull energy.
 *
 * Solved against the engine's own function rather than against a copy of its
 * algebra, so that a change to meep's `k` moves this with it instead of quietly
 * decalibrating every radius in the game. Bisection, once, at module load.
 *
 * It comes out at 0.326: Smith sheds the first 17 dB inside a third of its
 * range, which is much steeper than spherical spreading and is the whole reason
 * {@link cullRadiusQ3} is not simply {@link AUDIBLE_RADIUS_FACTOR}.
 */
const SMITH_CULL_POSITION = ((): number => {
    const target = Math.sqrt(CULL_ENERGY_FRACTION);

    let low = 0;
    let high = 1;

    // Monotone decreasing in v, so 60 halvings put it well past double precision.
    for (let i = 0; i < 60; i++) {
        const mid = (low + high) / 2;
        if (interpolate_irradiance_smith(mid, 0, 1) > target) low = mid;
        else high = mid;
    }

    return (low + high) / 2;
})();

/**
 * The range `interpolate_irradiance_smith` has to be given so that it reaches
 * the cull energy at {@link AUDIBLE_RADIUS_FACTOR}.
 *
 * This is the number that took two wrong turns to find, and it is where the
 * engine's curve and the physics are reconciled. Smith is a *bounded* falloff:
 * it reaches exactly zero at `distanceMax`, which is what lets `LiveEmitterSet`
 * cut a loop that has left range without a click. The price is that it is not
 * 1/r -- handed the range where spherical spreading reaches 2% energy, it
 * arrives there at nothing at all and passes 2% a third of the way along.
 *
 * So the range is stretched until the two agree at the one distance that
 * matters. The result tracks true spherical spreading to within about 1.5 dB
 * everywhere out to the audible radius -- the rendered sound *is* an inverse
 * square law over the whole span anyone can hear it -- and then rolls off faster
 * than physics over a tail nobody can, which is exactly the trade a bounded
 * approximation exists to make.
 *
 * 19.6 at 2%, against 7.071 for the audible radius itself.
 */
export const CULL_RADIUS_FACTOR =
    1 + (AUDIBLE_RADIUS_FACTOR - 1) / SMITH_CULL_POSITION;

export const NOMINAL_FULL_VOLUME_Q3 = 256;

/**
 * How much louder than nominal a sound's source is, in decibels.
 *
 * **Authored, and it has to be.** The honest way to derive this would be from
 * the samples, and the samples do not carry it: every file in the bank is
 * mastered to about -1 dBFS peak, so `impact/rocket` measures *quieter* than
 * `weapon/WP_LIGHTNING` (-3.0 against -1.0 over the loudest 50 ms) and a
 * footstep sits 14 dB below a detonation that is 120 dB below it in the world.
 * Recording level is a mix decision that was made before this port existed, and
 * reading a source level out of it would rank a zap above a warhead.
 *
 * The other honest derivation would be from real sound pressure, and that does
 * not survive contact with a game either: ordnance is about 170 dB at a metre
 * and a footfall about 50, and 120 dB of spread means that any mapping which
 * puts the explosion where it belongs puts the footstep inside a metre. Game
 * mixes compress that to a couple of dozen dB, and always have.
 *
 * So these are a mix, ordered by the real acoustics and spaced for a Q3 arena,
 * and the numbers below are the two facts that pin the ends: an arena is about
 * 100 m across, so a detonation has to carry at least that far and a footfall
 * must not. Everything between is placed by which of those it resembles.
 *
 * Keyed by manifest name, with the first path segment as the fallback -- so a
 * map's `world/firesoft` ambience gets `world`'s entry without being listed, and
 * a name whose family is not listed either gets nominal.
 */
const SOURCE_LEVEL_DB: Readonly<Record<string, number>> = {
    /* ---- detonations: the loudest thing in the game and the reason for D-148 and D-149 ---- */

    /*
     +6 dB is a full-volume radius of 512 units and a cull at 3620 -- 113 m,
     which is the whole of any map this port ships. A rocket that lands at the
     far end of `aggressor` is now a thing you hear at about -17 dB rather than
     a thing that does not exist.
    */
    'impact/rocket': 6,
    'impact/prox': 6,

    /* ---- gunfire: loud, and directional cover for where a fight is ---- */

    /*
     +3 dB, a cull at 2560 units (80 m). Q3's own arenas are built so that
     hearing which gun is firing where is a large part of knowing where anyone
     is, and the shot is the loudest part of that.
    */
    'weapon/WP_ROCKET_LAUNCHER': 3,
    'weapon/WP_GRENADE_LAUNCHER': 3,
    'weapon/WP_PROX_LAUNCHER': 3,
    'weapon/WP_BFG': 3,
    'weapon/WP_SHOTGUN': 3,
    'weapon/WP_RAILGUN': 3,

    // A swing, not a shot: the one weapon whose firing sound is a motor at
    // arm's length rather than a report.
    'weapon/WP_GAUNTLET': -6,

    // The rest of `weapon/` is nominal by the family fallback below: a
    // machinegun, a chaingun, a plasma gun and a nailgun are all guns you hear
    // across a room and not across a level.
    weapon: 0,

    /* ---- everything a shot does where it lands ---- */

    /*
     The plasma and BFG detonations are explosions on a smaller scale, and the
     rest are a bullet hitting stone. `impact/flesh` is a body, which is quiet
     and is also the sound that tells you a fight is happening, so it stays
     nominal rather than dropping with the ricochets.
    */
    'impact/plasma': 0,
    'impact/flesh': 0,
    'impact/bullet': -6,
    'impact/nail': -6,
    'impact/lightning': -6,
    impact: 0,

    /* ---- the player's own body, and other people's ---- */

    /*
     Nominal, deliberately. A footfall is nothing like a gunshot in the world --
     it is 100 dB down -- but Q3 is a game in which hearing someone move is how
     you know they are there, and 1810 units (57 m) is about the honest limit of
     that before it becomes a radar. This is the clearest place where the mix
     wins over the physics, which is why it is written down.
    */
    player: 0,

    /* ---- what the level itself does ---- */

    /*
     A door or a platform is a large machine, and hearing one open on the far
     side of a room is a Q3 cue as old as the game. Ambience, teleporters and
     the rest of `world/` stay nominal.
    */
    mover: 3,
    world: 0,

    /* ---- loops that ride something ---- */

    /*
     A rocket in flight is loud and is a warning, so it carries like the gun
     that fired it. The third-person weapon loops and a weapon hovering on its
     pedestal are the opposite: they exist to tell you about something you are
     nearly standing next to, and at nominal range a room full of pedestals is a
     wall of hum competing for the `LOOP_BUDGET`.
    */
    missile: 3,
    firing: -6,
    ready: -6,
    'item/hover': -12,
};

/** Where a sound is still at full volume, and where it stops being rendered. */
export interface Falloff {
    /** `distanceMin`: inside this the level does not fall. Q3 units. */
    readonly fullVolumeQ3: number;
    /**
     * How far this can still be heard: where spherical spreading puts it at
     * {@link CULL_ENERGY_FRACTION}. Q3 units. Reported rather than used -- the
     * engine is given {@link Falloff.cullQ3} -- and it is what the table is
     * authored against.
     */
    readonly audibleQ3: number;
    /** `distanceMax`: past here nothing is rendered. Q3 units. */
    readonly cullQ3: number;
}

/**
 * The full-volume radius that a source `levelDb` above nominal reaches.
 *
 * Spherical spreading again, read the other way round: a source that is louder
 * by `levelDb` holds any given level out to `10^(levelDb/20)` times the
 * distance, because amplitude goes as 1/r. +6 dB is twice the radius.
 */
export function fullVolumeRadiusQ3(levelDb: number): number {
    return NOMINAL_FULL_VOLUME_Q3 * Math.pow(10, levelDb / 20);
}

/**
 * How far away this sound can still be heard: the distance at which spherical
 * spreading puts it at {@link CULL_ENERGY_FRACTION} of its full-volume energy.
 *
 * The physical answer, and the one the table is authored against. It is not
 * `distanceMax` -- see {@link cullRadiusQ3}.
 */
export function audibleRadiusQ3(fullVolumeQ3: number): number {
    return fullVolumeQ3 * AUDIBLE_RADIUS_FACTOR;
}

/**
 * `distanceMax`: the range the engine's curve is evaluated over, and the
 * distance past which nothing is rendered at all.
 *
 * Further out than {@link audibleRadiusQ3}, because Smith has to be given room
 * to still be at the cull energy *at* the audible radius rather than at zero.
 * See {@link CULL_RADIUS_FACTOR}.
 */
export function cullRadiusQ3(fullVolumeQ3: number): number {
    return fullVolumeQ3 * CULL_RADIUS_FACTOR;
}

/**
 * The source level for a manifest name: its own entry, then its family's, then
 * nominal.
 *
 * The family is the first path segment, which is how every name in the bank is
 * built -- `impact/rocket`, `world/firesoft`, `item/weapon_railgun`. Map
 * ambience is the reason the fallback exists at all: `convert-sounds.ts` reads
 * those names out of the maps, so the set is open and cannot be enumerated here.
 */
export function sourceLevelDb(name: string): number {
    const exact = SOURCE_LEVEL_DB[name];
    if (exact !== undefined) return exact;

    const slash = name.indexOf('/');
    if (slash < 0) return 0;

    return SOURCE_LEVEL_DB[name.slice(0, slash)] ?? 0;
}

/** Both radii for a manifest name. */
export function falloffFor(name: string): Falloff {
    const fullVolumeQ3 = fullVolumeRadiusQ3(sourceLevelDb(name));

    return {
        fullVolumeQ3,
        audibleQ3: audibleRadiusQ3(fullVolumeQ3),
        cullQ3: cullRadiusQ3(fullVolumeQ3),
    };
}
