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

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

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

export class Effects {
    private readonly ecd: EcsDataset;
    private readonly expiries: Expiry[] = [];
    private now = 0;

    /** Live decal count, so the oldest can be retired before the cap is hit. */
    private readonly decals: number[] = [];

    /**
     * Cap on simultaneous decals.
     *
     * meep advertises 1,000,000 GPU decals and this port has no reason to doubt
     * it, but a deathmatch that never retires marks accumulates them without
     * bound. 2048 is roughly ten minutes of continuous machinegun fire.
     */
    private readonly maxDecals = 2048;

    constructor(ecd: EcsDataset) {
        this.ecd = ecd;

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
        light.castShadow.set(false);

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

        // A scorch mark that outlives the explosion.
        this.mark(originQ3, [0, 0, 1], radiusQ3 * 0.5, 'mark_burn', 0.35);
    }

    /* ------------------------------------------------------------------ *
     * Impacts
     * ------------------------------------------------------------------ */

    /** A bullet strike: a small spark burst plus a mark. */
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

        this.mark(originQ3, normalQ3, 6, 'mark_bullet', 0.6);
    }

    /* ------------------------------------------------------------------ *
     * Decals
     * ------------------------------------------------------------------ */

    /**
     * Project a decal onto whatever is at `originQ3`.
     *
     * A decal's `Transform` *is* its projection volume: the box is oriented by
     * the rotation and sized by the scale, and everything inside it receives the
     * texture. So the mark is placed slightly *behind* the surface along its
     * normal and given depth, rather than being laid flat on it -- a
     * zero-thickness box projects onto nothing.
     */
    mark(
        originQ3: ArrayLike<number>,
        normalQ3: ArrayLike<number>,
        sizeQ3: number,
        texture: string,
        alpha: number
    ): void {
        const n = dirToMeep(normalQ3);
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-6) return;

        const nx = n[0] / len;
        const ny = n[1] / len;
        const nz = n[2] / len;

        const size = sizeQ3 * WORLD_SCALE;
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

        const transform = new Transform();
        // Sit the projection box centred on the surface so it catches geometry
        // on both sides of a thin wall face.
        transform.position.set(x + nx * size * 0.25, y + ny * size * 0.25, z + nz * size * 0.25);
        transform.scale.set(size, size, size);
        transform.rotation._lookRotation(nx, ny, nz, Math.abs(ny) > 0.99 ? 1 : 0, Math.abs(ny) > 0.99 ? 0 : 1, 0);

        const entity = new Entity();
        entity.add(transform).add(decal).build(this.ecd);

        this.decals.push(entity.id);

        while (this.decals.length > this.maxDecals) {
            const oldest = this.decals.shift();
            if (oldest !== undefined && this.ecd.entityExists(oldest)) {
                this.ecd.removeEntity(oldest);
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

    /** A brief point light at the muzzle. Cheap, and clustered lighting eats it. */
    muzzleFlash(originQ3: ArrayLike<number>): void {
        const [x, y, z] = toMeep(originQ3);

        const light = new Light();
        light.type.set(LightType.POINT);
        light.color.setRGB(1, 0.9, 0.65);
        light.intensity.set(2500 / (4 * Math.PI));
        light.distance.set(6);
        light.castShadow.set(false);

        const transform = new Transform();
        transform.position.set(x, y, z);

        const entity = new Entity();
        entity.add(transform).add(light).build(this.ecd);
        this.expire(entity.id, 0.05);
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
