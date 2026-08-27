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
    type DamageQuery,
    type MissileWorld,
    type Projectile,
    type WeaponEvents,
    type WeaponId,
} from '../game/Weapons.ts';
import { Effects } from './Effects.ts';
import { NO_SHADOWS, type ShadowPolicy } from './Shadows.ts';
import { interpolatedBody } from './interpolation.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';

const WORLD_SCALE = 1 / 32;

function toMeep(q3: ArrayLike<number>): [number, number, number] {
    return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
}

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    removeEntity(entity: number): void;
    entityExists(entity: number): boolean;
    getComponent(entity: number, type: unknown): unknown;
    addComponentToEntity(entity: number, component: unknown): void;
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
     * The fly sound riding each missile, keyed by projectile id.
     *
     * There is no entity here any more. A missile *is* an entity -- the one
     * `Missiles` built for the physics body -- so the rocket's model and its
     * interpolation are added to that, and nothing on this side copies a
     * position onto a second transform every step.
     */
    private readonly projectileSounds = new Map<number, SoundLoop | null>();

    private readonly targetMaterial = new StandardShadeMaterial();
    private readonly targetHitMaterial = new StandardShadeMaterial();
    private readonly targetGeometry = new BoxGeometry(1, 1, 1);
    private readonly rocketGeometry = new BoxGeometry(1, 1, 1);
    private readonly rocketMaterial = new StandardShadeMaterial();

    private now = 0;

    /** Damage dealt this session, for the HUD. */
    totalDamage = 0;
    kills = 0;
    /** Times the player has been killed. */
    deaths = 0;

    /**
     * Trail puffs are emitted every Nth fixed step, not every one.
     *
     * This used to be frame-rate compensation -- at 240 Hz a per-frame puff was
     * four times the smoke it was at 60 -- and on a fixed step that reason is
     * gone. What is left is plain rate control, and the number is kept because
     * the trail was tuned with it.
     */
    private trailStep = 0;
    private readonly trailEvery = 2;

    /**
     * Set after construction, because the bank is fetched and the arena is not.
     * Null until then, and silent rather than throwing -- a frame of missing
     * audio during load is not worth a failure path.
     */
    audio: AudioBank | null = null;

    /**
     * @param shadows what the effects' own lights ask before they cast. Defaults
     *     to the answer they gave before there was a setting, so a test or a
     *     tool that builds an arena for the collision half of it is unaffected.
     */
    constructor(
        ecd: EcsDataset,
        cm: ClipMap,
        missiles: MissileWorld | null = null,
        shadows: ShadowPolicy = NO_SHADOWS,
        queries: DamageQuery | null = null
    ) {
        this.ecd = ecd;
        this.effects = new Effects(ecd, shadows);
        this.weapons = new WeaponSystem(cm, this, missiles, queries);

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
        this.followMissiles();

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

    muzzleFlash(originQ3: ArrayLike<number>, weapon: WeaponId): void {
        this.effects.muzzleFlash(originQ3);
        this.audio?.play(`weapon/${weapon}`, originQ3);
    }

    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void {
        this.effects.bulletImpact(originQ3, normalQ3);
        this.audio?.play('impact/bullet', originQ3);
    }

    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        normalQ3?: ArrayLike<number>
    ): void {
        this.effects.explosion(originQ3, radiusQ3, normalQ3);
        this.audio?.play('impact/rocket', originQ3);
    }

    hit(target: Damageable, damage: number): void {
        /*
         `targets` is the list of boxes this class owns; anything else in
         `weapons.targets` -- bots, since they became `Damageable` -- belongs to
         someone else and must not be reached into. The first version cast every
         hit to a `Target` and read `entity` off it, which was correct while the
         only damageable things were boxes and threw the moment a bot shot
         another bot.
        */
        const box = this.targets.includes(target as Target) ? (target as Target) : null;

        this.totalDamage += damage;

        // `CG_HitSound`: the local, non-positional confirmation tone. It is not
        // a sound in the world -- it is feedback, and Q3 plays it dry.
        this.audio?.playLocal('feedback/hit');

        if (box !== null) box.lastHit = this.now;

        if (!target.dead) return;

        /*
         The player is target id 0, and dying is not scoring. Counting it was
         the difference between a scoreboard and a body count.
        */
        if (target.id !== 0) this.kills += 1;
        else this.deaths += 1;

        // A death detonates, which makes the kill legible without a death
        // animation. Bots have one; boxes never will.
        this.effects.explosion(target.origin, 90);
        this.audio?.play('impact/flesh', target.origin);

        if (box === null) return;

        box.respawnIn = 3;
        if (this.ecd.entityExists(box.entity)) this.ecd.removeEntity(box.entity);
    }

    projectileSpawned(projectile: Projectile, entity: number): void {
        /*
         The body the engine is already flying, dressed rather than duplicated.
         `PhysicsSystem` reads only `position` and `rotation` off a transform, so
         scaling it to the model's size cannot disturb the collider.
        */
        if (entity >= 0) {
            const transform = this.ecd.getComponent(entity, Transform) as Transform | undefined;
            // Rockets are ~8 units across in Q3.
            transform?.scale.set(8 * WORLD_SCALE, 8 * WORLD_SCALE, 8 * WORLD_SCALE);

            this.ecd.addComponentToEntity(
                entity,
                ShadedGeometry.from(this.rocketGeometry, this.rocketMaterial)
            );
            /*
             Blended by `InterpolationSystem` on the physics timeline, for which
             `PhysicsSystem` is already the producer. A missile crosses a room in
             a handful of fixed steps, so this is the difference between a rocket
             and a dotted line of rockets.
            */
            this.ecd.addComponentToEntity(entity, interpolatedBody());
        }

        /*
         `CG_Missile`: a missile whose weapon has a `missileSound` carries it as
         a looping sound for as long as it is in the air. Not every weapon has
         one -- a grenade arcs silently -- so a null handle here is a weapon Q3
         gives no fly sound to, and not a failure.
        */
        this.projectileSounds.set(
            projectile.id,
            this.audio?.loop(`missile/${projectile.weapon}`, projectile.origin) ?? null
        );
    }

    projectileGone(projectile: Projectile): void {
        const fly = this.projectileSounds.get(projectile.id);
        this.projectileSounds.delete(projectile.id);

        /*
         `S_StopLoopingSound`. The missile's own entity is retired by `Missiles`
         -- it owns the body, and the model and the interpolation went on to that
         same entity, so they leave with it.
        */
        fly?.stop();
    }

    /**
     * The smoke trail and the fly sounds, from wherever the engine has flown
     * each missile to.
     *
     * `WeaponSystem` no longer reports a projectile moving, because nothing on
     * this side moves one: the poses are read back off the bodies once a step by
     * `MissileWorld.sync`, and this walks the result.
     */
    private followMissiles(): void {
        const live = this.weapons.liveProjectiles;
        if (live.length === 0) return;

        this.trailStep += 1;
        const puff = this.trailStep >= this.trailEvery;
        if (puff) this.trailStep = 0;

        for (const projectile of live) {
            // `S_UpdateEntityPosition`: the fly sound rides the rocket.
            this.projectileSounds.get(projectile.id)?.move(projectile.origin);
            if (puff) this.effects.trailPuff(projectile.origin);
        }
    }
}
