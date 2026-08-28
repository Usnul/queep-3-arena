/*
 * Effects.ts -- explosions, trails, muzzle flashes and impact marks.
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
 * Q3's `cg_effects.c` and `cg_localents.c` are in the bin, per the brief. Every
 * effect here is meep's own: `ParticleEmitter` for smoke and sparks, `Decal` for
 * impact marks, `Light` for the flash. What survives from Q3 is the *artwork*
 * and the *timing* -- a rocket explosion still lights the room for the same
 * fraction of a second.
 *
 * Everything is created in **meep space**: metres, Y up. Callers hand in Q3
 * coordinates and this module converts, because the alternative is every call
 * site remembering to.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';
import { Decal } from '@woosh/meep-engine/src/engine/graphics/ecs/decal/v2/Decal.js';
import { ParticleEmitter } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleEmitter.js';
import { ParticleParameters } from '@woosh/meep-engine/src/engine/graphics/particles/particular/engine/emitter/ParticleParameters.js';

import { NO_SHADOWS, type ShadowPolicy } from './Shadows.ts';
import { applyMuzzleFlash, MUZZLE_FLASH_SECONDS } from './muzzleFlash.ts';

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

const TAU = Math.PI * 2;

/** Q3 (Z-up, units) -> meep (Y-up, metres). */
function toMeep(q3: ArrayLike<number>): [number, number, number] {
    return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
}

/** Axis swap only, for normals and directions. */
function dirToMeep(q3: ArrayLike<number>): [number, number, number] {
    return [q3[0]!, q3[2]!, -q3[1]!];
}

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    removeEntity(entity: number): void;
    entityExists(entity: number): boolean;
}

/** One scheduled removal. */
interface Expiry {
    entity: number;
    at: number;
}

/** One impact mark on a wall, while it is still on it. */
interface LiveDecal {
    readonly entity: number;
    readonly decal: Decal;
    /** When it landed, on `Effects`' own clock. */
    readonly at: number;
    /** Whether it is on the energy mark's faster curve. */
    readonly energy: boolean;
    /** Last alpha written, so a mark at full strength is not rewritten. */
    alpha: number;
}

/**
 * `BlendingType` from meep. Additive for fire and sparks, normal for smoke.
 * Re-declared rather than imported because the enum lives three directories
 * deeper than anything else this module touches.
 */
const BLEND_NORMAL = 0;
const BLEND_ADDITIVE = 1;

const EMISSION_SPHERE = 0;
const EMISSION_POINT = 3;
const FROM_VOLUME = 1;

/**
 * A parameter track: scale and colour sampled across a particle's life.
 *
 * `positions` are normalised life points and `data` is `itemSize` values at
 * each. This is the shape `ParameterLookupTable.fromJSON` wants.
 *
 * The names come from `ParticleParameters` rather than being written out,
 * because the constants' *keys* are `Scale` and `Color` while their *values* are
 * `'scale'` and `'color'`. Writing the capitalised form throws
 * `Failed to add track with name 'Scale', no parameter exists with that name` --
 * a genuinely good error message, and one you only see at emitter-construction
 * time rather than at compile time.
 */
function track(name: string, itemSize: number, positions: number[], data: number[]) {
    return { name, track: { itemSize, data, positions } };
}

const SCALE = ParticleParameters.Scale;
const COLOR = ParticleParameters.Color;

/** One row of `CG_MissileHitWall`'s mark table. */
interface ImpactMark {
    /** A file under `assets/built/fx/`, and one of the four `cg_main.c` registers. */
    readonly texture: string;
    /** `CG_ImpactMark`'s `radius`, in Q3 units. */
    readonly radiusQ3: number;
    /**
     * Whether this is `cgs.media.energyMarkShader`, which fades on its own curve.
     *
     * `CG_AddMarks` singles the plasma scorch out twice: `alphaFade` is
     * `mark == energyMarkShader`, and it gets an extra ramp -- `450 - 450 *
     * (age / 3000)` -- that takes it off the wall in three seconds instead of
     * ten. Everything else fades its *colour* toward black, which under
     * `blendfunc GL_ZERO GL_ONE_MINUS_SRC_COLOR` is the same thing as fading
     * out: this port converts those marks to black-with-coverage, so both cases
     * are one alpha ramp here and the only difference left is how long it takes.
     */
    readonly energy?: boolean;
}

/**
 * `MARK_TOTAL_TIME`, in seconds. A mark is gone ten seconds after it lands.
 *
 * This is the number that lets the alpha be Q3's. The marks used to be stamped
 * at a fraction of full strength -- 0.35 for a burn, 0.6 for a bullet -- because
 * nothing ever removed them: they were retired oldest-first at a cap of 2048, so
 * a wall took every mark it was ever given at full darkness and stayed that way.
 * The fraction was standing in for a fade that had not been ported.
 *
 * It stood in badly, and that is what brought this back: a rocket's scorch is
 * `CG_ImpactMark`'s radius 64, which is a **4-metre** box, and 0.35 of a texture
 * whose own peak coverage is 197/255 is a 27% grey smeared over four metres of
 * wall. It was drawn, it was oriented correctly, and it was not visible. Q3
 * stamps `1,1,1,1` and takes the mark away afterwards, and doing both is both
 * more faithful and the thing that makes a rocket hit leave a mark you can see.
 */
const MARK_TOTAL_SECONDS = 10;

/** `MARK_FADE_TIME`: the last second of that life is a linear fade to nothing. */
const MARK_FADE_SECONDS = 1;

/**
 * The energy mark's own ramp: `fade = 450 - 450 * (age / 3000)`, clamped at 255.
 *
 * So a plasma scorch sits at full strength for the 1.13 seconds it takes 450 to
 * come down to 255, then fades to nothing at three seconds. Written as the C's
 * two constants rather than as the 1.13 they imply.
 */
const ENERGY_FADE_SECONDS = 3;
const ENERGY_FADE_START = 450;

/**
 * `CG_MissileHitWall`'s `switch (weapon)`, which is the only place Q3 says what
 * an impact looks like.
 *
 * The four textures are `cg_main.c`'s four mark shaders, and `convert-fx.ts`
 * builds all four: `bullet_mrk`, `burn_med_mrk`, `hole_lg_mrk` and `plasma_mrk`.
 * Radii are the C's own, unscaled -- `mark` takes Q3 units.
 *
 * Keyed by `WP_*` string rather than by `WeaponId`, because a mark is presentation
 * and the presentation is handed weapon ids that come from the item table, which
 * is the wider of the two lists (see `isWeaponId`).
 */
const MISSILE_MARKS: Readonly<Record<string, ImpactMark>> = {
    WP_MACHINEGUN: { texture: 'mark_bullet', radiusQ3: 8 },
    WP_CHAINGUN: { texture: 'mark_bullet', radiusQ3: 8 },
    // Q3's shotgun mark is a quarter the machinegun's, because there are eleven
    // of them per shot and a full-size stamp each would black out the wall.
    WP_SHOTGUN: { texture: 'mark_bullet', radiusQ3: 4 },

    WP_GRENADE_LAUNCHER: { texture: 'mark_burn', radiusQ3: 64 },
    WP_ROCKET_LAUNCHER: { texture: 'mark_burn', radiusQ3: 64 },
    WP_PROX_LAUNCHER: { texture: 'mark_burn', radiusQ3: 64 },
    WP_BFG: { texture: 'mark_burn', radiusQ3: 32 },

    WP_RAILGUN: { texture: 'mark_plasma', radiusQ3: 24, energy: true },
    WP_PLASMAGUN: { texture: 'mark_plasma', radiusQ3: 16, energy: true },

    WP_LIGHTNING: { texture: 'mark_hole', radiusQ3: 12 },
    WP_NAILGUN: { texture: 'mark_hole', radiusQ3: 12 },
};

/**
 * `CG_MissileHitWall`'s `default:`, which falls straight into `WP_NAILGUN`.
 *
 * Not a stand-in written here: the C's `default` label sits immediately above
 * `case WP_NAILGUN` with no `break` between them, so a weapon the switch does not
 * name really does leave a 12-unit hole. That is the gauntlet and the grappling
 * hook, neither of which reaches a wall in this port -- and it is also whatever
 * arrives next, which is the reason to write the fallback down rather than to
 * throw.
 */
const DEFAULT_MARK: ImpactMark = { texture: 'mark_hole', radiusQ3: 12 };

/**
 * A unit vector perpendicular to `n`, rotated `roll` radians about it.
 *
 * This is the `up` hint a look rotation needs, and rolling it is how a decal
 * gets `CG_ImpactMark`'s random spin: `_lookRotation` derives the other two axes
 * from the forward and the up, so turning the up about the forward turns the
 * whole frame about it.
 *
 * The seed axis switches on `|n.y|` for the usual reason -- an up hint parallel
 * to the forward has no cross product, and meep's own fallback for that case
 * nudges the forward vector instead, which would tilt the projector off the
 * surface it is being aimed at.
 */
function perpendicular(
    nx: number,
    ny: number,
    nz: number,
    roll: number
): [number, number, number] {
    const sx = Math.abs(ny) > 0.99 ? 1 : 0;
    const sy = Math.abs(ny) > 0.99 ? 0 : 1;

    // t = normalize(seed x n), b = n x t: an orthonormal basis of n's plane.
    let tx = sy * nz - 0 * ny;
    let ty = 0 * nx - sx * nz;
    let tz = sx * ny - sy * nx;

    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;

    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    const c = Math.cos(roll);
    const s = Math.sin(roll);

    return [tx * c + bx * s, ty * c + by * s, tz * c + bz * s];
}

export class Effects {
    private readonly ecd: EcsDataset;
    private readonly expiries: Expiry[] = [];
    private now = 0;

    /** Live decal count, so the oldest can be retired before the cap is hit. */
    private readonly decals: LiveDecal[] = [];

    /**
     * Cap on simultaneous decals, and a backstop rather than the mechanism.
     *
     * meep advertises 1,000,000 GPU decals and this port has no reason to doubt
     * it. What retires a mark now is `CG_AddMarks`' own ten-second life; the cap
     * is what stops a pathological second -- fifteen nails and eleven shotgun
     * pellets at a time -- from running the count away before that expires.
     */
    private readonly maxDecals = 2048;

    /**
     * Whether the flashes cast, asked once per light at the moment it is made.
     *
     * Asked rather than followed because none of these lights lives long enough
     * for the answer to change under it -- 90 ms for an explosion, 50 for a
     * muzzle flash. See `Shadows`.
     */
    private readonly shadows: ShadowPolicy;

    constructor(ecd: EcsDataset, shadows: ShadowPolicy = NO_SHADOWS) {
        this.ecd = ecd;
        this.shadows = shadows;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(Light)) ecd.registerComponentType(Light);
        if (!ecd.isComponentTypeRegistered(Decal)) ecd.registerComponentType(Decal);
        if (!ecd.isComponentTypeRegistered(ParticleEmitter)) {
            ecd.registerComponentType(ParticleEmitter);
        }
    }

    /** Advance timers and retire finished effects. Call once per frame. */
    update(deltaSeconds: number): void {
        this.now += deltaSeconds;

        for (let i = this.expiries.length - 1; i >= 0; i--) {
            const e = this.expiries[i]!;
            if (e.at > this.now) continue;

            this.expiries.splice(i, 1);
            if (this.ecd.entityExists(e.entity)) {
                this.ecd.removeEntity(e.entity);
            }
        }

        this.fadeMarks();
    }

    /**
     * `CG_AddMarks`: age every mark, fade the ones that are on their way out,
     * and free the ones whose ten seconds are up.
     *
     * The list is in landing order, so the expired marks are a prefix of it and
     * removing them is a shift rather than a scan. The fade only writes an alpha
     * that has actually changed -- a mark spends most of its life at full
     * strength, and `Decal.color` is an observed vector whose setter dispatches
     * a change signal to the decal system.
     */
    private fadeMarks(): void {
        let kept = 0;

        for (const live of this.decals) {
            const age = this.now - live.at;

            /*
             Two ramps, both `CG_AddMarks`', and the smaller wins. The energy one
             starts above 1 and is therefore no fade at all until it comes down
             through it, which is the `if (fade < 255)` in the C.
            */
            let alpha = 1;

            if (live.energy) {
                alpha = Math.min(
                    alpha,
                    (ENERGY_FADE_START - ENERGY_FADE_START * (age / ENERGY_FADE_SECONDS)) / 255
                );
            }

            const remaining = MARK_TOTAL_SECONDS - age;
            if (remaining < MARK_FADE_SECONDS) {
                alpha = Math.min(alpha, remaining / MARK_FADE_SECONDS);
            }

            /*
             Freed the moment it reaches zero, rather than at `MARK_TOTAL_TIME`
             for everything. The C frees on the timer alone and lets an energy
             mark sit at zero alpha for the seven seconds between its own curve
             and the common one -- which costs nothing there, because a mark poly
             that draws nothing is a poly it skips. Here it is a decal box the
             composite still walks, and "invisible" and "gone" are the same
             picture, so this takes the cheaper of two identical answers.

             Not a prefix: an energy mark landing after an ordinary one expires
             before it, so the survivors are compacted rather than shifted.
            */
            if (alpha <= 0) {
                if (this.ecd.entityExists(live.entity)) this.ecd.removeEntity(live.entity);
                continue;
            }

            // A hundredth of an alpha step is below what an 8-bit channel can
            // hold, so this is "changed" rather than "not exactly equal".
            if (Math.abs(alpha - live.alpha) >= 0.01) {
                live.alpha = alpha;
                live.decal.color.set(1, 1, 1, alpha);
            }

            this.decals[kept++] = live;
        }

        this.decals.length = kept;
    }

    private expire(entity: number, afterSeconds: number): void {
        this.expiries.push({ entity, at: this.now + afterSeconds });
    }

    /* ------------------------------------------------------------------ *
     * Explosions
     * ------------------------------------------------------------------ */

    /**
     * A rocket or grenade detonation.
     *
     * Three parts, in Q3's own proportions: a bright short flash, an expanding
     * fireball, and smoke that outlives both. `radiusQ3` is the weapon's
     * `splashRadius`, so the visual matches the damage.
     *
     * The scorch mark is **not** here, and used to be. It is
     * {@link impactMark}'s, called alongside this one by whoever knows the
     * weapon -- which is the shape `CG_MissileHitWall` has: build the explosion,
     * then call `CG_ImpactMark` with a mark chosen per weapon. Keeping it here
     * meant every detonation left a burn, and meant this function needed a
     * surface normal it otherwise had no use for and defaulted to straight up.
     */
    explosion(originQ3: ArrayLike<number>, radiusQ3: number): void {
        const [x, y, z] = toMeep(originQ3);
        const radius = radiusQ3 * WORLD_SCALE;

        /*
         The flash. A point light rather than an emissive sprite, because that is
         the whole reason clustered lighting is interesting here: a firefight
         produces dozens of these a second and none of them should cost anything.
        */
        const light = new Light();
        light.type.set(LightType.POINT);
        light.color.setRGB(1, 0.72, 0.38);
        /*
         12,000 lumens -- about eight household bulbs. The first attempt used
         60,000 on the reasoning that an explosion is bright, and it was: it
         saturated every surface in the corridor to white and hid the particle
         effect it was supposed to be lighting. Photometric units make
         "physically plausible" and "reads well" different questions, and this is
         the second one.
        */
        light.intensity.set(12000 / (4 * Math.PI));
        light.distance.set(radius * 5);
        /*
         The one effect light worth the atlas slot: it is bright, it is large,
         and a rocket going off behind a pillar throwing the pillar across the
         room is the whole reason to want shadows on local lights at all.
        */
        light.castShadow.set(this.shadows.casts('effect'));

        const lightTransform = new Transform();
        lightTransform.position.set(x, y, z);

        const lightEntity = new Entity();
        lightEntity.add(lightTransform).add(light).build(this.ecd);
        this.expire(lightEntity.id, 0.09);

        // Fireball: additive, fast, shrinking.
        this.emitter(
            [x, y, z],
            {
                blendingMode: BLEND_ADDITIVE,
                receiveLight: false,
                depthSort: false,
                layers: [
                    {
                        imageURL: '/assets/built/fx/flare.png',
                        particleLife: { min: 0.18, max: 0.35 },
                        particleSize: { min: radius * 0.9, max: radius * 1.6 },
                        particleRotation: { min: 0, max: Math.PI * 2 },
                        particleRotationSpeed: { min: -2, max: 2 },
                        emissionShape: EMISSION_SPHERE,
                        emissionFrom: FROM_VOLUME,
                        emissionRate: 0,
                        emissionImmediate: 14,
                        scale: { x: radius * 0.3, y: radius * 0.3, z: radius * 0.3 },
                        particleSpeed: { min: radius * 1.5, max: radius * 4 },
                        parameterTracks: [
                            track(SCALE, 1, [0, 0.25, 1], [0.35, 1.0, 0.15]),
                            track(
                                COLOR,
                                4,
                                [0, 0.3, 1],
                                [1, 0.95, 0.7, 1, 1, 0.5, 0.15, 0.9, 0.4, 0.1, 0.05, 0]
                            ),
                        ],
                    },
                ],
            },
            1.2
        );

        // Smoke: normal blending, slow, lit by the scene.
        this.emitter(
            [x, y, z],
            {
                blendingMode: BLEND_NORMAL,
                receiveLight: true,
                depthSort: true,
                layers: [
                    {
                        imageURL: '/assets/built/fx/smoke.png',
                        particleLife: { min: 0.9, max: 1.8 },
                        particleSize: { min: radius * 0.8, max: radius * 1.8 },
                        particleRotation: { min: 0, max: Math.PI * 2 },
                        particleRotationSpeed: { min: -0.6, max: 0.6 },
                        emissionShape: EMISSION_SPHERE,
                        emissionFrom: FROM_VOLUME,
                        emissionRate: 0,
                        emissionImmediate: 18,
                        scale: { x: radius * 0.4, y: radius * 0.4, z: radius * 0.4 },
                        particleSpeed: { min: radius * 0.4, max: radius * 1.6 },
                        parameterTracks: [
                            track(SCALE, 1, [0, 1], [0.6, 1.9]),
                            track(
                                COLOR,
                                4,
                                [0, 0.15, 1],
                                [0.5, 0.45, 0.42, 0.0, 0.32, 0.30, 0.28, 0.55, 0.2, 0.2, 0.2, 0]
                            ),
                        ],
                    },
                ],
            },
            2.5
        );

    }

    /* ------------------------------------------------------------------ *
     * Impacts
     * ------------------------------------------------------------------ */

    /**
     * `CG_MissileHitWall`'s impact mark, whichever weapon arrived.
     *
     * The explosion is not the mark and never was: Q3 builds the fireball, plays
     * the sound and then calls `CG_ImpactMark` as a separate act at the bottom of
     * the same function, off a `mark`/`radius` pair the switch above it chose per
     * weapon. This is that pair, and its call site is `Arena` for the same reason
     * the C's is `CG_MissileHitWall` -- the mark is a property of *what hit the
     * wall*, and neither `explosion` nor `bulletImpact` is told that.
     *
     * Everything before this drew one of two marks: a burn for anything that
     * exploded, a bullet hole for anything hitscan. Q3 draws four, and the two
     * this port has never once put on a wall -- the plasma scorch and the large
     * hole -- were being converted by `convert-fx.ts` and shipped in the bundle
     * the whole time. A railgun slug leaving a machinegun's pockmark is not
     * *missing*, which is what makes it the kind of wrong that survives.
     */
    impactMark(weapon: string, originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void {
        const mark = MISSILE_MARKS[weapon] ?? DEFAULT_MARK;

        this.mark(
            originQ3,
            normalQ3,
            mark.radiusQ3,
            mark.texture,
            // `CG_MissileHitWall` passes `1,1,1,1` and lets `CG_AddMarks` take it
            // away again; both halves of that are ported now.
            1,
            Math.random() * TAU,
            mark.energy === true
        );
    }

    /** A bullet strike: a small spark burst. The mark is `impactMark`'s. */
    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void {
        const [x, y, z] = toMeep(originQ3);

        this.emitter(
            [x, y, z],
            {
                blendingMode: BLEND_ADDITIVE,
                receiveLight: false,
                depthSort: false,
                layers: [
                    {
                        imageURL: '/assets/built/fx/tracer.png',
                        particleLife: { min: 0.08, max: 0.22 },
                        particleSize: { min: 0.02, max: 0.06 },
                        particleRotation: { min: 0, max: Math.PI * 2 },
                        particleRotationSpeed: { min: 0, max: 0 },
                        emissionShape: EMISSION_POINT,
                        emissionFrom: FROM_VOLUME,
                        emissionRate: 0,
                        emissionImmediate: 6,
                        particleSpeed: { min: 1.5, max: 5 },
                        particleVelocityDirection: {
                            direction: {
                                x: dirToMeep(normalQ3)[0],
                                y: dirToMeep(normalQ3)[1],
                                z: dirToMeep(normalQ3)[2],
                            },
                            angle: 1.1,
                        },
                        parameterTracks: [
                            track(SCALE, 1, [0, 1], [1, 0.2]),
                            track(COLOR, 4, [0, 1], [1, 0.85, 0.5, 1, 1, 0.4, 0.1, 0]),
                        ],
                    },
                ],
            },
            0.5
        );
    }

    /* ------------------------------------------------------------------ *
     * Decals
     * ------------------------------------------------------------------ */

    /**
     * Project a decal onto whatever is at `originQ3`.
     *
     * A decal's `Transform` *is* its projection volume: the box is the unit cube
     * the rotation orients and the scale sizes, and every opaque surface inside
     * it receives the texture. So the mark is a box straddling the surface
     * rather than a quad laid on it -- a zero-thickness box projects onto
     * nothing.
     *
     * **The box points its +Z *into* the surface, not along the normal**, and
     * that is the whole of what was wrong with this function for two phases.
     * meep's composite takes the decal's outward direction as `-axis_z` and
     * fades on `smoothstep(0.35, 0.6, dot(face_normal, outward))`, so a
     * projector built by looking *along* the surface normal scores a dot of
     * exactly -1 on the surface it was aimed at, fades to zero, and is skipped.
     * Not one decal in this port had ever been drawn. There is no error and no
     * warning for it, because a fade reaching zero is also how a decal grazing a
     * wall at a shallow angle is skipped -- see `chunk_decal_surface_frame`,
     * whose docblock says all of this and is the only place that does.
     *
     * `radiusQ3` is `CG_ImpactMark`'s radius, so the numbers at the call sites
     * are Q3's own; the box is twice that across.
     */
    mark(
        originQ3: ArrayLike<number>,
        normalQ3: ArrayLike<number>,
        radiusQ3: number,
        texture: string,
        alpha: number,
        rollRadians: number,
        /** On `energyMarkShader`'s faster curve. See {@link ImpactMark.energy}. */
        energy = false
    ): void {
        const n = dirToMeep(normalQ3);
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-6) return;

        const nx = n[0] / len;
        const ny = n[1] / len;
        const nz = n[2] / len;

        const size = radiusQ3 * 2 * WORLD_SCALE;
        const [x, y, z] = toMeep(originQ3);

        const decal = new Decal();
        decal.uri = `/assets/built/fx/${texture}.png`;
        // `set(r, g, b, a)` rather than `setRGB` + a separate alpha call: the
        // alpha setter is `setA`, not `setAlpha`, and the four-argument form
        // avoids having to remember which.
        decal.color.set(1, 1, 1, alpha);
        decal.roughness = 0.9;
        decal.metalness = 0;
        decal.priority = 0;

        /*
         The roll `CG_ImpactMark` passes as `random()*360`. Q3 spins every mark
         about its own axis so that a wall taking a magazine of machinegun fire
         does not end up tiled with the same stamp, and the whole cost of it here
         is choosing which perpendicular to hand the look rotation as `up`.
        */
        const [ux, uy, uz] = perpendicular(nx, ny, nz, rollRadians);

        const transform = new Transform();
        // Centred on the surface, so the box has equal depth on both sides of it
        // and catches geometry either way -- a thin wall face, or a floor whose
        // trace endpoint sits a hair inside it.
        transform.position.set(x, y, z);
        transform.scale.set(size, size, size);
        transform.rotation._lookRotation(-nx, -ny, -nz, ux, uy, uz);

        const entity = new Entity();
        entity.add(transform).add(decal).build(this.ecd);

        this.decals.push({ entity: entity.id, decal, at: this.now, energy, alpha });

        while (this.decals.length > this.maxDecals) {
            const oldest = this.decals.shift();
            if (oldest !== undefined && this.ecd.entityExists(oldest.entity)) {
                this.ecd.removeEntity(oldest.entity);
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * Trails
     * ------------------------------------------------------------------ */

    /**
     * One puff of rocket exhaust.
     *
     * Q3 drew a `RT_RAIL_CORE`-style ribbon plus discrete smoke sprites from
     * `cg_localents.c`. meep has a `Trail3D` component that would do the ribbon,
     * but a rocket's trail is smoke rather than a ribbon, so this is particles --
     * one short-lived emitter per puff, dropped along the flight path.
     */
    trailPuff(originQ3: ArrayLike<number>): void {
        const [x, y, z] = toMeep(originQ3);

        this.emitter(
            [x, y, z],
            {
                blendingMode: BLEND_NORMAL,
                receiveLight: true,
                depthSort: true,
                layers: [
                    {
                        imageURL: '/assets/built/fx/smoke.png',
                        particleLife: { min: 0.5, max: 1.1 },
                        particleSize: { min: 0.25, max: 0.5 },
                        particleRotation: { min: 0, max: Math.PI * 2 },
                        particleRotationSpeed: { min: -0.8, max: 0.8 },
                        emissionShape: EMISSION_POINT,
                        emissionFrom: FROM_VOLUME,
                        emissionRate: 0,
                        emissionImmediate: 1,
                        particleSpeed: { min: 0.1, max: 0.4 },
                        parameterTracks: [
                            track(SCALE, 1, [0, 1], [0.4, 1.6]),
                            track(
                                COLOR,
                                4,
                                [0, 0.1, 1],
                                [0.7, 0.66, 0.6, 0, 0.5, 0.48, 0.46, 0.5, 0.3, 0.3, 0.3, 0]
                            ),
                        ],
                    },
                ],
            },
            1.4
        );
    }

    /* ------------------------------------------------------------------ *
     * Muzzle flash
     * ------------------------------------------------------------------ */

    /**
     * A brief point light at the muzzle. Cheap, and clustered lighting eats it.
     *
     * Cheap stops being the whole story under `Shadows`' `all`: a machinegun is
     * ten of these a second, and each one that casts binds an atlas rect and its
     * face views for the fifty milliseconds it exists. It is still the honest
     * reading of "every light casts", and it is the mode's cost rather than this
     * effect's -- the two cheaper modes are one row of the menu away.
     *
     * **This is the flash for a shooter with no gun on screen**, which is every
     * bot: nothing draws a weapon model for them, so there is no `tag_flash` to
     * hang a light on and the shot's own origin is the best point available.
     * The player's own flash rides the barrel instead -- see `ViewWeapon.flash`
     * and D-115 -- and `Arena` picks between the two.
     */
    muzzleFlash(originQ3: ArrayLike<number>, weapon: string): void {
        const [x, y, z] = toMeep(originQ3);

        const light = new Light();
        applyMuzzleFlash(light, weapon, this.shadows.casts('effect'));

        const transform = new Transform();
        transform.position.set(x, y, z);

        const entity = new Entity();
        entity.add(transform).add(light).build(this.ecd);
        this.expire(entity.id, MUZZLE_FLASH_SECONDS);
    }

    /* ------------------------------------------------------------------ *
     * Internals
     * ------------------------------------------------------------------ */

    /** Build a one-shot emitter entity and schedule its removal. */
    private emitter(
        positionMeep: readonly number[],
        json: Record<string, unknown>,
        lifetimeSeconds: number
    ): number {
        const emitter = new ParticleEmitter();
        emitter.fromJSON(json);

        const transform = new Transform();
        transform.position.set(positionMeep[0]!, positionMeep[1]!, positionMeep[2]!);

        const entity = new Entity();
        entity.add(transform).add(emitter).build(this.ecd);

        this.expire(entity.id, lifetimeSeconds);

        return entity.id;
    }
}
