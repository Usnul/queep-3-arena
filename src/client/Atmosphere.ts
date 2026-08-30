/*
 * Atmosphere.ts -- the air the whole map stands in, as one box of city haze.
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
 * Until this file existed every light in the port was a thing that landed on
 * surfaces. A lamp lit the wall under it and the floor below that, and the
 * space between the three was vacuum: nothing to scatter in, so nothing to see.
 * No shaft of light on any map at any hour.
 *
 * Shade renders participating media -- froxel-integrated in-scattering, with
 * the local lights and the sun's shadow both reaching into the volume -- and
 * the whole subsystem is gated on the scene containing at least one volume.
 * `Renderer` asks `scene.volumetrics.source.volumes.length > 0` and skips the
 * composite pass entirely when the answer is no. So "turn volumetric lighting
 * on" is not a switch anywhere; it is *put a medium in the world*, and this
 * file is that medium.
 *
 * **A medium is a particle and a count of it, and the particle is the half that
 * decides how it looks.** {@link MIE_PARTICLES_STANDARD_PRECOMPUTED} is meep's
 * generated library of real Mie solutions -- twenty entries from 25 nm soot to
 * 15 um pollen, each with per-channel cross-sections, an asymmetry parameter
 * and a single-scattering albedo. `ParticipatingMedia.density` says how many
 * per cubic metre. The first version of this file left the particle at meep's
 * default, which is `FOG_DROPLET_MEDIUM` in all but name -- 5 um water droplets
 * -- and that is why it read as fog rather than as air, at any density. Two
 * separate reasons, and only one of them is the density:
 *
 * - **the phase function is driven by particle diameter, not by density.**
 *   `shader_volumetrics_build_participating_media` packs `diameter_micron` and
 *   `phase_mie_jendersie_deon` looks the lobe up from it. A 10 um droplet has
 *   the sharp forward diffraction peak that makes a lamp in fog wear a halo;
 *   a 0.5 um haze particle does not, and no amount of thinning the fog would
 *   have removed it;
 * - **and the density was meteorologically fog.** Koschmieder puts visibility
 *   at `3.912 / extinction`, so the 0.005/m this shipped at is 780 m -- the
 *   definition of fog is below a kilometre. City haze is 1.5 to 3 km, which is
 *   0.0013 to 0.0026 per metre. See {@link MAP_ATMOSPHERE}.
 *
 * **Which of the two mattered was measured rather than assumed**, because the
 * fix would have been different: swapping only the particle at the *original*
 * 0.005/m, at a fixed camera in `am_thornish`, is not a fog with the haze taken
 * out of it -- it is a hall with air in it. Same optical depth, same lights,
 * same frame. The droplets put a bright halo on every ceiling lamp and washed
 * the whole upper half of the frame; the haze at that identical extinction
 * reads as depth. So the particle was most of the complaint, and the density
 * came down afterwards on its own merits rather than to compensate for it.
 *
 * **One box for the map, and not Q3's fog.** Q3 has its own -- a `fog` lump in
 * the BSP, a `fogNum` on every leaf and brush -- and this is not it, has no
 * relationship to it, and does not read it. That is a per-volume gameplay
 * thing: `CONTENTS_FOG` changes what a trace hits. This is a single global
 * medium, which is the cheapest thing that makes the lights visible in the air.
 *
 * **The box is far larger than the map, and the size is a statement about the
 * sky.** See {@link WORLD_MARGIN}.
 */

import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ParticipatingMedia } from '@woosh/meep-engine/src/engine/graphics3/ParticipatingMedia.js';
import { VolumetricsParticleSpec }
    from '@woosh/meep-engine/src/shade/renderer/volumetrics/ParticipatingMediaVolume.js';
import { MIE_PARTICLES_STANDARD_PRECOMPUTED }
    from '@woosh/meep-engine/src/core/math/physics/mie/MIE_PARTICLES_STANDARD_PRECOMPUTED.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

import type { SceneBundle } from './map/SceneBundle.ts';

/** One entry of meep's generated Mie library, as much of it as this file reads. */
interface MieParticle {
    readonly radius: number;
    readonly cross_section_scattering: readonly number[];
    readonly cross_section_extinction: readonly number[];
    readonly g: number;
}

/** The names in {@link MIE_PARTICLES_STANDARD_PRECOMPUTED}. */
export type MieParticleName = keyof typeof MIE_PARTICLES_STANDARD_PRECOMPUTED;

const PARTICLES = MIE_PARTICLES_STANDARD_PRECOMPUTED as unknown as
    Readonly<Record<MieParticleName, MieParticle>>;

/**
 * What a map's air is made of and how much of it there is.
 *
 * The extinction is the authored quantity rather than the density, because
 * density is per-particle -- 1.5e9 per cubic metre of continental haze and
 * 6.0e6 of fog droplet buy the same darkening -- so two maps written in density
 * could not be compared at a glance. {@link ParticipatingMedia.target_extinction}
 * does that division at attach time.
 */
export interface AtmospherePreset {
    /** Which entry of meep's Mie library the air is made of. */
    readonly particle: MieParticleName;
    /** Luminous extinction per metre. See {@link MAP_ATMOSPHERE} for the band. */
    readonly extinction: number;
    /** Why this map got this. Shown in the console line at load. */
    readonly why: string;
}

/**
 * Continental haze at 0.0020 per metre: what a map gets when it is not named
 * in {@link MAP_ATMOSPHERE}, and the value the six are scattered around.
 *
 * `CONTINENTAL_HAZE_MEDIUM` is meep's own "typical daytime urban/valley haze
 * with gentle desaturation" -- 250 nm ammonium-sulfate surrogate, `g` 0.72, and
 * an albedo of 0.9999, so it scatters essentially everything it takes and
 * darkens nothing. Its extinction runs 5.46e-13 red to 8.29e-13 blue, a ratio
 * of 1.52, which is the whole depth cue: blue is removed half again as fast as
 * red, so distance warms what is behind it and the haze itself reads cool.
 *
 * 0.0020 is 2.0 km of Koschmieder visibility -- a poor-air-quality city day --
 * and it is where it is because both neighbours were looked at, at a fixed
 * camera, rather than reasoned about. At 0.0035 the far wall of `aggressor`'s
 * water room starts to wash and the room reads milky, which is the direction
 * the first attempt was reported for. At 0.0008 `am_thornish`'s long hall is
 * indistinguishable from the same hall with the feature off -- and that is the
 * map with the most distance of the six, so the rest would show less.
 */
export const DEFAULT_ATMOSPHERE: AtmospherePreset = {
    particle: 'CONTINENTAL_HAZE_MEDIUM',
    extinction: 0.0020,
    why: 'default city haze',
};

/**
 * Per map, because the six do not stand in the same weather and are not the
 * same size.
 *
 * **The extinctions come off a measurement, not off taste.** Sightlines were
 * sampled on each map's own collision hull: 256 rays from every spawn point and
 * every `item_`, `weapon_` and `ammo_` entity -- hand-placed by the level author
 * inside playable space, which is what makes them a better sample than anything
 * random -- cast from eye height (`DEFAULT_VIEWHEIGHT`, 26 units up) with
 * azimuth uniform and elevation within 25 degrees of horizontal, which is where
 * a player actually aims. What came back is that a Q3 arena is a much tighter
 * space than it feels like:
 *
 * | map | median | p95 | p99 |
 * |---|---:|---:|---:|
 * | `oa_dm1` | 3.9 m | 15.3 m | 21.5 m |
 * | `oa_dm4` | 3.4 m | 13.1 m | 18.2 m |
 * | `oa_dm5` | 3.8 m | 14.6 m | 21.2 m |
 * | `oa_dm7` | 6.1 m | 24.9 m | 35.9 m |
 * | `aggressor` | 3.9 m | 15.7 m | 20.9 m |
 * | `am_thornish` | 6.3 m | 55.9 m | 94.7 m |
 *
 * Half of every sightline in this game is under six metres.
 *
 * **What that measurement is for is smaller than it looks, and the first
 * attempt got it backwards.** Normalising the extinction so that every map
 * carries the same optical depth at the same *rank* of sightline is the obvious
 * move and it is wrong, because most of what you actually see is not
 * extinction at all -- it is in-scattering around the lights, which depends on
 * the density and not on how far away the wall behind it is. Normalised that
 * way `am_thornish` came out at 0.0008 and had visibly nothing in it, on the
 * one map with room for atmosphere. So the numbers below sit close together
 * around {@link DEFAULT_ATMOSPHERE}, which is the same claim as "the six maps
 * are outdoors on the same afternoon", and the table's real job is the
 * *particle*.
 *
 * The sightlines still earn the +-20% around it: `oa_dm4` is the tightest map
 * of the six and gets the most per metre; `am_thornish` has twice the p95 of
 * the next map and three and a half times the median one, and gets the least,
 * which holds the loss across its 178 m diagonal to 25% rather than 30%. That
 * is the only map where a rail sightline is long enough for the difference to
 * be a fight rather than a look.
 *
 * **The particles come off the map's own sun.** A sun's colour is a statement
 * about what its light travelled through, so a map whose `worldspawn` sun is
 * deep red is a map with dust in the air, and a map with no sun at all is an
 * interior with no weather to have.
 *
 * That is the whole rule; where a map's sun says nothing in particular, it gets
 * {@link DEFAULT_ATMOSPHERE}'s particle.
 */
export const MAP_ATMOSPHERE: Readonly<Record<string, AtmospherePreset>> = {
    /*
     No sun of any kind -- the only one of the six -- so there is no sky to
     bring weather in and nothing outside to be hazy. What hangs in a lit
     interior is dust: `FINE_DUST_SMALL` is 750 nm mineral, and unlike every
     haze and droplet in the library it actually absorbs, at an albedo of
     0.92/0.90/0.88. That is the point of choosing it. A room full of something
     with albedo 1.0 can only ever get brighter, and this map is meant to be
     dim.
    */
    oa_dm1: {
        particle: 'FINE_DUST_SMALL',
        extinction: 0.0022,
        why: 'no sun anywhere: interior dust rather than weather',
    },

    /*
     Sun at 43 lux and RGB 0.64/0.13/0.13 -- by a distance the reddest of the
     six, and red sunlight is what you get when the air has taken the blue out
     of it. Reaching for the dust rather than the haze is reading the map's own
     lighting back as its cause.
    */
    oa_dm4: {
        particle: 'FINE_DUST_SMALL',
        extinction: 0.0024,
        why: 'deep red sun (0.64/0.13/0.13): dust is what reddens it',
    },

    /*
     The dimmest sun of the six at 7 lux, and cold with it (0.18/0.49/0.69).
     `MARITIME_HAZE_MEDIUM` is the library's cool damp air: `g` 0.76, and an
     extinction ratio of 2.04 blue to red, the strongest tilt of any haze here,
     so its in-scatter is the bluest available. A map lit like a cold morning
     gets the air of one.
    */
    oa_dm5: {
        particle: 'MARITIME_HAZE_MEDIUM',
        extinction: 0.0021,
        why: 'dim cold sun (7 lux, blue): damp maritime air',
    },

    /*
     Overcast daylight -- 28 lux, near-neutral and slightly blue -- over the
     second-most open of the maps. Nothing here argues against the default
     particle, and the p95 of 24.9 m is what pulls the extinction down.
    */
    oa_dm7: {
        particle: 'CONTINENTAL_HAZE_MEDIUM',
        extinction: 0.0018,
        why: 'overcast daylight over long sightlines',
    },

    /*
     Warm yellow sun at 31 lux over an industrial base. Smoke was the tempting
     answer and is not the honest one: nothing in the map's lighting says the
     air is sooty, and `SMOKE_PARTICLE_*` carries a visible albedo penalty that
     would darken a map already lit at the low end.
    */
    aggressor: {
        particle: 'CONTINENTAL_HAZE_MEDIUM',
        extinction: 0.0020,
        why: 'warm sun over an industrial base',
    },

    /*
     The largest map by a factor of two -- 178 m corner to corner against 71 to
     81 for the others -- under a bright near-white sun. It is the only one of
     the six with the distance for aerial perspective to be a depth cue rather
     than a wash, and it is held at the bottom of the band precisely because it
     has that distance to accumulate over.
    */
    am_thornish: {
        particle: 'CONTINENTAL_HAZE_MEDIUM',
        extinction: 0.0016,
        why: 'the one map with distance in it: 178 m corner to corner',
    },
};

/**
 * The lowest and highest extinction any map is allowed, per metre.
 *
 * Koschmieder gives meteorological visibility as `3.912 / extinction`, so this
 * band is 1.4 km to 3.3 km: a hazy city day at one end and a smoggy one at the
 * other, which is the range the phrase "normal city haze" covers. The six sit
 * inside it with room on both sides, and the point of the constants is that a
 * seventh map cannot leave it by accident.
 *
 * Above the band, `0.0039` is where the meteorologists stop saying haze and
 * start saying mist, and `0.005` -- where this file shipped first -- is 780 m
 * and is fog outright. Below it, at Q3's measured sightlines, there is nothing
 * to see: `am_thornish` at 0.0008 has 4% of optical depth at its own p95 and
 * looks, at a fixed camera, like a map with the feature switched off.
 */
export const EXTINCTION_MIN = 0.0012;
export const EXTINCTION_MAX = 0.0028;

/**
 * How far the box is grown past the map's own bounds, in metres.
 *
 * **The box's size is a decision about the sky and about nothing else.** What a
 * pixel shows is the optical depth along its view ray, which is extinction
 * times the distance the ray travels *inside the box*. A ray that hits a wall
 * stops at the wall and cannot tell how far the box extends past it, so for
 * every pixel of actual level geometry the size is irrelevant. The rays that
 * can tell are the ones that never hit anything, and those exist here:
 * `convert-map` drops Q3's sky surfaces rather than drawing them, because meep
 * has an environment map where Q3 had a painted box, so a view ray through what
 * used to be sky hits no geometry and runs to the far plane, 600 m out. The
 * margin is therefore the sky's haze budget, and {@link skyOpticalDepthOf} is
 * that budget written down.
 *
 * **100 m is where it is because 600 m was tried and looked wrong.** Sizing the
 * margin at the far plane is the tempting move -- it makes the medium unbounded
 * as far as any frame is concerned, so the box stops being a tuning variable at
 * all -- and the picture it gives is a sky that is no longer the map's. Looking
 * up out of `oa_dm7`'s courtyard at 0.0018/m:
 *
 * | margin | box, on a 55 x 41 x 42 m map | sky |
 * |---|---|---|
 * | 600 m | 1255 x 1241 x 1242 | dusty pink; the blue is gone |
 * | 200 m | 455 x 441 x 442 | still washed toward mauve |
 * | 100 m | 255 x 241 x 242 | the map's own blue, hazing warm toward the horizon |
 *
 * The failure is not the renderer's. It is that the environment map *already
 * contains* a sky, which is to say it already contains an atmosphere's worth of
 * scattering, and 600 m of medium in front of it charges for the same air
 * twice. A hundred metres is the largest margin that keeps the double-count
 * small enough to read as haze on the map's own sky rather than as a colour
 * grade over it -- and it is still three to six times the map on every axis,
 * which is the "much larger than the map" this was asked for.
 *
 * Turn it up for a smoggier sky; nothing else in this file has to move.
 */
export const WORLD_MARGIN = 100;

/**
 * How far in from the box's faces the medium tapers out, in metres.
 *
 * meep's default is 0.1 m, tuned for a volume you walk past -- a smoke plume, a
 * patch of ground mist -- where a hard edge is a visible straight line across
 * the screen and a decimetre of softness hides it. This box's faces are 100 m
 * outside anything drawn, so the taper is not hiding a seam; it is the outer
 * atmosphere thinning, and metres are the scale that reads as that rather than
 * as a wall.
 *
 * Strictly less than {@link WORLD_MARGIN}, or the taper reaches back inside the
 * map and the outermost rooms are lit through thinner air than the middle ones.
 * A test says so, for whoever shrinks the margin.
 */
export const FADE_DISTANCE = 4;

/** The part of `EntityComponentDataset` this file uses. */
interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/** An axis-aligned box in meep metres, as the volume's transform wants it. */
export interface WorldBox {
    /** Box centre, which is where the volume's transform stands. */
    readonly centre: readonly [number, number, number];
    /** Full extent per axis. Shade's volume is a *unit* cube, so this is its scale. */
    readonly size: readonly [number, number, number];
}

export interface AtmosphereReport {
    readonly entity: number;
    readonly box: WorldBox;
    readonly preset: AtmospherePreset;
    /** Per metre, read back off the component, so it is what was applied. */
    readonly extinction: number;
    /** Particles per cubic metre the extinction came to for this particle. */
    readonly density: number;
    /** Koschmieder's `3.912 / extinction`, in metres. A sanity figure for the log. */
    readonly visibility: number;
}

/**
 * What the named map's air is, falling back to {@link DEFAULT_ATMOSPHERE}.
 *
 * The fallback is not dead code waiting for a seventh map: `?map=` takes any
 * name the asset pipeline has built, and a map converted locally and never
 * added to the table is the ordinary case rather than the exceptional one.
 *
 * **`Object.hasOwn` rather than `?? DEFAULT_ATMOSPHERE`**, which is not
 * pedantry: a plain object literal inherits `Object.prototype`, so the `??`
 * form answers a map called `constructor` or `toString` with a *function*, and
 * TypeScript types the lookup as an `AtmospherePreset` and says nothing. What
 * comes back then has no `.particle`, so the failure surfaces two calls later
 * as "undefined is not in MIE_PARTICLES_STANDARD_PRECOMPUTED".
 */
export function atmosphereFor(map: string): AtmospherePreset {
    return Object.hasOwn(MAP_ATMOSPHERE, map)
        ? MAP_ATMOSPHERE[map]!
        : DEFAULT_ATMOSPHERE;
}

/**
 * The optical depth a ray carries after it leaves the map through a hole where
 * a sky surface used to be.
 *
 * `extinction * WORLD_MARGIN`, which is the only part of the box's size that
 * shows in a frame -- see {@link WORLD_MARGIN}. Worth being able to read off,
 * because it is the number that decides whether the sky still belongs to the
 * map: at the extinctions in {@link MAP_ATMOSPHERE} it runs 0.16 to 0.24, so
 * 15% to 21% of the skybox is replaced by in-scattered haze, and the map's own
 * sky colour survives underneath.
 *
 * An approximation in one direction: a ray leaving at an angle crosses more
 * than one margin's worth of box, up to the diagonal. It is the right order and
 * the right lever.
 */
export function skyOpticalDepthOf(preset: AtmospherePreset): number {
    return preset.extinction * WORLD_MARGIN;
}

/**
 * Koschmieder's relation: the distance at which a black object against the
 * horizon falls to 2% contrast, which is what a weather report means by
 * visibility. Only ever used to put a human number in the console line.
 */
export function visibilityOf(extinction: number): number {
    return 3.912 / extinction;
}

/**
 * The map's own bounding box, grown by {@link WORLD_MARGIN}, in meep metres.
 *
 * Null when the bundle carries no world submodel, which means an asset written
 * before the converter emitted them rather than a map with no geometry. The
 * caller reports that rather than guessing a size.
 *
 * **The axis swap is Q3's, not this file's.** The bundle's submodel bounds are
 * in Q3 units and Q3 axes (`x` forward, `y` left, `z` up); meep is metres, `y`
 * up, `z` back. So `y` and `z` trade places and one of them flips sign, which
 * for an interval means its ends swap: the meep `z` range runs from `-maxsQ3.y`
 * to `-minsQ3.y`. Getting that backwards yields a negative extent, which is a
 * box the renderer draws inside out rather than an error anything raises. The
 * conversion matches `toMeep` in `Arena.ts`, and the scale is the bundle's own
 * `worldScale` rather than a repeat of the 1/32 constant.
 */
export function worldBoxOf(bundle: SceneBundle): WorldBox | null {
    const world = bundle.submodels?.find((submodel) => submodel.model === 0);
    if (world === undefined) return null;

    const scale = bundle.worldScale;

    const [minX, minY, minZ] = world.minsQ3 as readonly number[] as [number, number, number];
    const [maxX, maxY, maxZ] = world.maxsQ3 as readonly number[] as [number, number, number];

    // Q3 (x, y, z) -> meep (x, z, -y), so the meep z interval is the negated,
    // reversed Q3 y interval.
    const lo: [number, number, number] = [minX * scale, minZ * scale, -maxY * scale];
    const hi: [number, number, number] = [maxX * scale, maxZ * scale, -minY * scale];

    return {
        centre: [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5],
        size: [
            hi[0] - lo[0] + WORLD_MARGIN * 2,
            hi[1] - lo[1] + WORLD_MARGIN * 2,
            hi[2] - lo[2] + WORLD_MARGIN * 2,
        ],
    };
}

/**
 * Build the component for a preset, without an entity or a dataset in sight.
 *
 * Separate from {@link attachWorldAtmosphere} because it is the half worth
 * asserting on: what a named preset comes to in density is arithmetic through
 * a cross-section near 1e-13, and a test can ask that without an ECS.
 *
 * **The spec is converted, not referenced.** `VolumetricsParticleSpec.fromMeep`
 * copies the library entry's arrays; holding onto them would make every volume
 * built from the same entry share one spec, and tuning one would retune the
 * others. meep's own `fromJSON` says the same thing for the same reason.
 */
export function mediumFor(preset: AtmospherePreset): ParticipatingMedia {
    const particle = PARTICLES[preset.particle];

    if (particle === undefined) {
        throw new Error(
            `${preset.particle} is not in MIE_PARTICLES_STANDARD_PRECOMPUTED`
        );
    }

    const medium = new ParticipatingMedia();

    /*
     Before the extinction, and that order is load-bearing rather than
     stylistic. `target_extinction` is a setter that divides by the *current*
     particle's cross-section to get a density, so writing it first and then
     swapping the particle leaves the density that the old particle implied --
     which for fog droplets against continental haze is a factor of 250 wrong,
     silently, in the direction of a solid wall.
    */
    medium.particle_spec = VolumetricsParticleSpec.fromMeep(particle);

    medium.target_extinction = preset.extinction;
    medium.fade_distance = FADE_DISTANCE;

    return medium;
}

/**
 * Put the map inside one box of its own air, and hand back what was placed.
 *
 * Null when {@link worldBoxOf} could not size the box.
 *
 * **The transform is the box.** Shade's `ParticipatingMediaVolume` is a unit
 * cube centred on the origin posed by a transform, and `ParticipatingMediaSystem3`
 * copies the entity's `Transform` onto it verbatim -- so position is the box's
 * centre and scale is its full extent, with no half-extent anywhere in the
 * chain. Rotation is left identity; the bounds this is built from are
 * axis-aligned and there is nothing to align to.
 *
 * **The transform is taken as world-space with no hierarchy applied**, which
 * the system's own docblock is explicit about. This entity has no parent, so
 * that costs nothing here -- it is worth knowing before anyone parents a fog
 * volume to something that moves.
 */
export function attachWorldAtmosphere(
    ecd: EcsDataset,
    bundle: SceneBundle,
    preset: AtmospherePreset = atmosphereFor(bundle.name)
): AtmosphereReport | null {
    const box = worldBoxOf(bundle);
    if (box === null) return null;

    if (!ecd.isComponentTypeRegistered(ParticipatingMedia)) {
        ecd.registerComponentType(ParticipatingMedia);
    }

    const transform = new Transform();
    transform.position.set(box.centre[0], box.centre[1], box.centre[2]);
    transform.scale.set(box.size[0], box.size[1], box.size[2]);

    const medium = mediumFor(preset);

    const entity = new Entity();
    entity.add(transform).add(medium).build(ecd);

    return {
        entity: entity.id,
        box,
        preset,
        extinction: medium.target_extinction,
        density: medium.density,
        visibility: visibilityOf(medium.target_extinction),
    };
}
