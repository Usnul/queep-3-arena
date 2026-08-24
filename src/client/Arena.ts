/*
 * Arena.ts -- the glue between the simulation and meep's presentation.
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
 * `WeaponSystem` raises events and knows nothing about rendering; `Effects`
 * renders and knows nothing about damage. This is the only place that knows
 * both, and it is deliberately thin.
 *
 * It also owns the deathmatch target: a box with health that reacts to being
 * shot, which is the brief's phase-3 exit condition.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { BoxGeometry } from '@woosh/meep-engine/src/shade/renderer/geometry/BoxGeometry.js';
import { StandardShadeMaterial } from '@woosh/meep-engine/src/shade/renderer/material/StandardShadeMaterial.js';
import { Color } from '@woosh/meep-engine/src/core/color/Color.js';

import { vec3, type Vec3 } from '../q3/math.ts';
import type { ClipMap } from '../q3/cm/ClipMap.ts';
import {
    WeaponSystem,
    type Damageable,
    type Projectile,
    type WeaponEvents,
    type WeaponId,
} from '../game/Weapons.ts';
import { Effects } from './Effects.ts';

const WORLD_SCALE = 1 / 32;

function toMeep(q3: ArrayLike<number>): [number, number, number] {
    return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
}

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    removeEntity(entity: number): void;
    entityExists(entity: number): boolean;
}

/** A shootable box. Q3's `func_train`-with-health, minus the train. */
export interface Target extends Damageable {
    readonly entity: number;
    readonly maxHealth: number;
    /** Seconds until it comes back. */
    respawnIn: number;
    /** Time of the last hit, for the flash. */
    lastHit: number;
}

export class Arena implements WeaponEvents {
    readonly weapons: WeaponSystem;
    readonly effects: Effects;

    private readonly ecd: EcsDataset;
    private readonly targets: Target[] = [];

    /**
     * Rendered rocket entities, keyed by projectile id.
     *
     * The `Transform` is kept alongside the entity id, not looked up each frame:
     * moving a projectile is a per-frame write and going through the dataset for
     * it would be a component query per rocket per frame for no benefit.
     */
    private readonly projectileEntities = new Map<
        number,
        { entity: number; transform: Transform }
    >();

    private readonly targetMaterial = new StandardShadeMaterial();
    private readonly targetHitMaterial = new StandardShadeMaterial();
    private readonly targetGeometry = new BoxGeometry(1, 1, 1);
    private readonly rocketGeometry = new BoxGeometry(1, 1, 1);
    private readonly rocketMaterial = new StandardShadeMaterial();

    private now = 0;

    /** Damage dealt this session, for the HUD. */
    totalDamage = 0;
    kills = 0;

    /** Trail puffs are emitted every Nth projectile step, not every frame. */
    private trailAccumulator = 0;
    private readonly trailEvery = 2;

    constructor(ecd: EcsDataset, cm: ClipMap) {
        this.ecd = ecd;
        this.effects = new Effects(ecd);
        this.weapons = new WeaponSystem(cm, this);

        if (!ecd.isComponentTypeRegistered(ShadedGeometry)) {
            ecd.registerComponentType(ShadedGeometry);
        }

        this.targetMaterial.name = 'target';
        this.targetMaterial.diffuse_color = new Color(0.85, 0.15, 0.12);
        this.targetMaterial.roughness_factor = 0.5;
        this.targetMaterial.metallic_factor = 0.1;

        this.targetHitMaterial.name = 'target:hit';
        this.targetHitMaterial.diffuse_color = new Color(1, 1, 1);
        this.targetHitMaterial.emissive_factor = new Color(3, 2.2, 1.4);
        this.targetHitMaterial.roughness_factor = 0.5;

        this.rocketMaterial.name = 'rocket';
        this.rocketMaterial.diffuse_color = new Color(0.4, 0.4, 0.42);
        this.rocketMaterial.emissive_factor = new Color(2.5, 1.2, 0.3);
        this.rocketMaterial.roughness_factor = 0.4;
    }

    /* ------------------------------------------------------------------ *
     * Targets
     * ------------------------------------------------------------------ */

    /**
     * Place a shootable box at a Q3 position.
     *
     * Sized like a player (`-15,-15,-24` to `15,15,32`) so splash falloff and
     * hitscan behave the way they would against an opponent.
     */
    addTarget(originQ3: ArrayLike<number>, health = 100): Target {
        const mins = vec3(-15, -15, -24);
        const maxs = vec3(15, 15, 32);

        const transform = new Transform();
        this.placeTarget(transform, originQ3, mins, maxs);

        const builder = new Entity();
        builder
            .add(transform)
            .add(ShadedGeometry.from(this.targetGeometry, this.targetMaterial))
            .build(this.ecd);

        const target: Target = {
            id: 1000 + this.targets.length,
            entity: builder.id,
            origin: vec3(originQ3[0]!, originQ3[1]!, originQ3[2]!),
            mins,
            maxs,
            health,
            maxHealth: health,
            dead: false,
            respawnIn: 0,
            lastHit: -1,
        };

        this.targets.push(target);
        this.weapons.targets.push(target);

        return target;
    }

    private placeTarget(
        transform: { position: { set(x: number, y: number, z: number): void }; scale: { set(x: number, y: number, z: number): void } },
        originQ3: ArrayLike<number>,
        mins: Vec3,
        maxs: Vec3
    ): void {
        // The box mesh is a unit cube centred on the origin, so it is scaled to
        // the Q3 bounding box and offset to that box's centre.
        const centreQ3 = [
            originQ3[0]!,
            originQ3[1]!,
            originQ3[2]! + (mins[2]! + maxs[2]!) * 0.5,
        ];

        const [x, y, z] = toMeep(centreQ3);
        transform.position.set(x, y, z);
        transform.scale.set(
            (maxs[0]! - mins[0]!) * WORLD_SCALE,
            (maxs[2]! - mins[2]!) * WORLD_SCALE,
            (maxs[1]! - mins[1]!) * WORLD_SCALE
        );
    }

    /* ------------------------------------------------------------------ *
     * Frame
     * ------------------------------------------------------------------ */

    update(deltaSeconds: number): void {
        this.now += deltaSeconds;

        this.weapons.update(deltaSeconds);
        this.effects.update(deltaSeconds);

        for (const target of this.targets) {
            if (!target.dead) continue;

            target.respawnIn -= deltaSeconds;
            if (target.respawnIn > 0) continue;

            target.dead = false;
            target.health = target.maxHealth;

            const builder = new Entity();
            const transform = new Transform();
            this.placeTarget(transform, target.origin, target.mins, target.maxs);
            builder
                .add(transform)
                .add(ShadedGeometry.from(this.targetGeometry, this.targetMaterial))
                .build(this.ecd);

            (target as { entity: number }).entity = builder.id;
        }
    }

    get liveTargets(): readonly Target[] {
        return this.targets;
    }

    /* ------------------------------------------------------------------ *
     * WeaponEvents
     * ------------------------------------------------------------------ */

    muzzleFlash(originQ3: ArrayLike<number>, _weapon: WeaponId): void {
        this.effects.muzzleFlash(originQ3);
    }

    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void {
        this.effects.bulletImpact(originQ3, normalQ3);
    }

    explosion(originQ3: ArrayLike<number>, radiusQ3: number): void {
        this.effects.explosion(originQ3, radiusQ3);
    }

    hit(target: Damageable, damage: number): void {
        this.totalDamage += damage;

        const t = target as Target;
        t.lastHit = this.now;

        if (target.dead) {
            this.kills += 1;
            t.respawnIn = 3;

            // A dead target detonates, which makes the kill legible without any
            // death animation.
            this.effects.explosion(target.origin, 90);

            if (this.ecd.entityExists(t.entity)) {
                this.ecd.removeEntity(t.entity);
            }
        }
    }

    projectileSpawned(projectile: Projectile): void {
        const transform = new Transform();
        const [x, y, z] = toMeep(projectile.origin);
        transform.position.set(x, y, z);
        // Rockets are ~8 units across in Q3.
        transform.scale.set(8 * WORLD_SCALE, 8 * WORLD_SCALE, 8 * WORLD_SCALE);

        const builder = new Entity();
        builder
            .add(transform)
            .add(ShadedGeometry.from(this.rocketGeometry, this.rocketMaterial))
            .build(this.ecd);

        this.projectileEntities.set(projectile.id, { entity: builder.id, transform });
    }

    projectileMoved(projectile: Projectile): void {
        const record = this.projectileEntities.get(projectile.id);

        if (record !== undefined) {
            const [x, y, z] = toMeep(projectile.origin);
            record.transform.position.set(x, y, z);
        }

        // Smoke trail, thinned to a fixed rate rather than one puff per frame:
        // at 240 Hz a per-frame puff is four times the smoke it is at 60 Hz, and
        // the trail would look different on different hardware.
        this.trailAccumulator += 1;
        if (this.trailAccumulator >= this.trailEvery) {
            this.trailAccumulator = 0;
            this.effects.trailPuff(projectile.origin);
        }
    }

    projectileGone(projectile: Projectile): void {
        const record = this.projectileEntities.get(projectile.id);
        this.projectileEntities.delete(projectile.id);

        if (record !== undefined && this.ecd.entityExists(record.entity)) {
            this.ecd.removeEntity(record.entity);
        }
    }
}
