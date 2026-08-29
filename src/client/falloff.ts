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
 * Q3 gives every positioned sound one range: flat inside `SOUND_FULLVOLUME` (80
 * units) and linear to nothing 1250 units later. One range for a footstep and
 * for a rocket detonating is not a simplification the port has to keep, and it
 * is wrong in the direction you notice -- a rocket you fired down a hall lands
 * 1400 units away and `EventInstance` drops it outright, because
 * `distanceMax` is a hard cull:
 *
 *     this.#audible = distance <= description.distanceMax && gain > ...
 *
 * and `LiveEmitterSet` culls loops at the same bound, with a hard cut rather
 * than a fade, on the documented assumption that "gain is approximately 0 past
 * `distanceMax`". Both of those make the bound a real edge in the world, so it
 * has to be placed for each sound rather than shared. See D-148.
 *
 * **What is measured and what is authored.** The propagation is measured: a
 * point source spreading spherically loses amplitude as 1/r and intensity as
 * 1/r^2, and {@link cullRadiusQ3} is that relation solved for the distance at
 * which the energy reaches {@link CULL_ENERGY_FRACTION}. The *source level* is
 * authored, and cannot be anything else -- see {@link SOURCE_LEVEL_DB}.
 */

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
 * Distance multiplier from the full-volume radius to the cull radius.
 *
 * Spherical spreading: `I(r) / I(r0) = (r0 / r)^2`. Setting that ratio to
 * {@link CULL_ENERGY_FRACTION} and solving gives `r = r0 / sqrt(fraction)`,
 * which is 7.071 at 2%. Every radius in {@link SOURCE_LEVEL_DB} is one number
 * because of this: authoring the full-volume radius authors the cull radius too.
 */
export const CULL_RADIUS_FACTOR = 1 / Math.sqrt(CULL_ENERGY_FRACTION);

/**
 * The full-volume radius of a sound with no entry, in Q3 units.
 *
 * 256 units is 8 m, against Q3's own `SOUND_FULLVOLUME` of 80, and it is chosen
 * so that spherical spreading from it *reproduces* `S_SpatializeOrigin` over the
 * range `S_SpatializeOrigin` covers rather than replacing it:
 *
 * | distance | Q3 `S_Base` | 1/r from 256 u | error |
 * |---|---|---|---|
 * | 160 u | 0.936 | 1.000 (flat) | +0.6 dB |
 * | 320 u | 0.808 | 0.800 | -0.1 dB |
 * | 640 u | 0.552 | 0.400 | -2.8 dB |
 * | 960 u | 0.296 | 0.267 | -0.9 dB |
 * | 1330 u | 0.000 | 0.192 | audible instead of gone |
 *
 * So a sound that says nothing about itself behaves as it did, and the change is
 * confined to the far end, where Q3's straight line reaches exactly zero and a
 * real one does not.
 */
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
    /* ---- detonations: the loudest thing in the game and the reason for D-148 ---- */

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
     * `distanceMax`: the hard cull, where the energy has reached
     * {@link CULL_ENERGY_FRACTION}. Q3 units.
     */
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

/** The distance at which a source at `fullVolumeQ3` reaches the cull energy. */
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

    return { fullVolumeQ3, cullQ3: cullRadiusQ3(fullVolumeQ3) };
}

/**
 * Where the taper into the cull begins, as a fraction of the range.
 *
 * `LiveEmitterSet` stops a loop that leaves range with a hard cut rather than a
 * fade, and says why: "already inaudible -- gain approximately 0 past
 * `distanceMax`". Spherical spreading does not do that. It arrives at the cull
 * radius at 14.1% of full amplitude by construction, and a loop crossing that
 * boundary would be cut off mid-sample at -17 dB, which is a click rather than a
 * disappearance.
 *
 * So the last fifth of the range is faded into the bound, which makes the
 * engine's assumption true rather than working around it. It costs the tail
 * about 1 dB at four fifths of the range and nothing before that.
 */
const TAPER_FROM = 0.8;

/**
 * Spherical spreading, faded into the cull radius: the falloff curve itself.
 *
 * Shaped for `buildAttenuationCurve`, which samples it densely and fits a
 * keyframed curve to the result.
 *
 * @param distance metres, and so are `min` and `max` -- this is called with
 *     scene units, not Q3 units, because it is the engine that evaluates it.
 */
export function sphericalSpreading(distance: number, min: number, max: number): number {
    if (distance <= min) return 1;
    if (distance >= max) return 0;

    // 1/r in amplitude, which is 1/r^2 in intensity: the irradiance relation.
    const spread = min / distance;

    const taperStart = min + (max - min) * TAPER_FROM;
    if (distance <= taperStart) return spread;

    // smoothstep, so the fade leaves and arrives with zero slope and the join at
    // `taperStart` is not a corner.
    const t = (distance - taperStart) / (max - taperStart);

    return spread * (1 - t * t * (3 - 2 * t));
}
