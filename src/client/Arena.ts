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
import type { MuzzleFlashSink } from './ViewWeapon.ts';
import type { MissileSink } from './MissileView.ts';
import { NO_SHADOWS, type ShadowPolicy } from './Shadows.ts';
import { impactSound } from './impactSound.ts';
import { interpolatedPose } from './interpolation.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';

const WORLD_SCALE = 1 / 32;

/**
 * The Q3 client id the person at the keyboard fires with.
 *
 * `roster.ts` hands out 0 to the player, `1000 +` to `addTarget`'s boxes and
 * `2000 +` to bots, and the zero is load-bearing beyond this file -- a bot
 * firing with it shoots itself, because `hitscanShot` skips the owner.
 */
const LOCAL_CLIENT = 0;

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
     * The gun in the player's own hands, once there is one.
     *
     * Set after construction like `audio` and for the same reason: the view
     * weapon needs the model library, which is fetched, and the arena is built
     * before it. Null leaves every flash in the world, which is what this class
     * did before there was a first-person weapon at all.
     */
    viewWeapon: MuzzleFlashSink | null = null;

    /**
     * What a projectile in flight is drawn as, once there are models to draw it
     * with.
     *
     * Set after construction like `audio` and `viewWeapon`, and for the same
     * reason: it needs the model library, which is fetched, and the arena is
     * built before it. Null flies every missile invisibly, which is the honest
     * failure -- what it replaced was one orange box standing in for a rocket, a
     * grenade, a plasma bolt, a nail and a BFG shot alike.
     */
    missileView: MissileSink | null = null;

    /**
     * `EV_DAMAGE` for the local client: how many points of health the player
     * just lost to something that meant it.
     *
     * Set after construction like the three above, because the thing that wants
     * it is the view and the arena is built before there is one. Null in every
     * headless caller, where nothing is looking.
     */
    onLocalDamage: ((damage: number) => void) | null = null;

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
        /*
         `CG_Missile`'s `RotateAroundDirection`: every missile in the air rolls
         about its own line of flight. After `weapons.update`, so a missile that
         left the world this step is not rolled on its way out.
        */
        this.missileView?.update(deltaSeconds);
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

    /**
     * The flash goes on the gun when there is a gun, and in the world otherwise.
     *
     * `ViewWeapon` draws exactly one weapon -- the local player's -- and it is
     * the only thing in the scene with a barrel to hang a light on, so it gets
     * first refusal on the local player's own shots and everything else falls
     * through to a light at the shot's origin. Refusal is a real answer
     * and not a formality: a dead player and a weapon the bundle has no model
     * for both decline, and each of them still has to light something.
     *
     * A weapon whose model ships no `tag_flash` used to be a third refusal, and
     * is not one any more: a gun that is drawn has a front, and `muzzleOffset`
     * finds it. That mattered because the gauntlet is one of the two weapons
     * every player spawns holding, so the commonest muzzle flash in the game was
     * the one D-115 is named for -- 44 cm dead ahead of the eye. See D-158.
     *
     * The *sound* does not move with the light. It is the shot's own event, it
     * is placed by the simulation, and the listener is at the eye a half-metre
     * behind the barrel -- moving it would be a change to what the player hears
     * in exchange for nothing they can hear.
     */
    muzzleFlash(
        originQ3: ArrayLike<number>,
        directionQ3: ArrayLike<number>,
        weapon: WeaponId,
        ownerId: number
    ): void {
        const onTheGun = ownerId === LOCAL_CLIENT && this.viewWeapon?.flash(weapon) === true;

        /*
         The particles follow the light, both times. A shot the gun took draws
         them from `ViewWeapon` on the next frame, at `tag_flash` in world space
         and pointing down the barrel; every other shot draws them here, at
         `CalcMuzzlePoint` and along the shooter's own forward. One effect, two
         muzzles, and the same reason as the light.
        */
        if (!onTheGun) this.effects.muzzleFlash(originQ3, directionQ3, weapon);

        this.audio?.play(`weapon/${weapon}`, originQ3);
    }

    /*
     `CG_MissileHitWall`, split in two down the seam the C already has: the
     explosion, then `CG_ImpactMark` off a per-weapon `mark`/`radius` pair. This
     is where they are put back together, because it is the only layer that knows
     both the weapon and the surface.
    */

    bulletImpact(
        originQ3: ArrayLike<number>,
        normalQ3: ArrayLike<number>,
        weapon: WeaponId
    ): void {
        this.effects.bulletImpact(originQ3, normalQ3);
        this.effects.impactMark(weapon, originQ3, normalQ3);

        const sfx = impactSound(weapon);
        if (sfx !== null) this.audio?.play(sfx, originQ3);
    }

    /**
     * The line from the barrel to whatever the shot stopped on.
     *
     * Straight through to `Effects`, which owns the per-weapon table and draws
     * nothing for the two weapons that have no row. No sound: Q3 plays a
     * `tracerSound` at the dash's midpoint, and this port draws a trail for every
     * shot where Q3 drew a dash for four in ten -- one sound per machinegun round
     * from a point in mid-air is not what that was.
     */
    hitscanTrail(
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        weapon: WeaponId
    ): void {
        this.effects.hitscanTrail(weapon, startQ3, endQ3);
    }

    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        weapon: WeaponId,
        normalQ3?: ArrayLike<number>
    ): void {
        /*
         The weapon reaches the flash as well as the mark. It used to reach only
         the mark, so every detonation in the game lit the wall the same warm
         orange -- including a plasma bolt, whose muzzle, bolt and bolt-light are
         all blue. See `Effects.explosion` and D-163.
        */
        this.effects.explosion(originQ3, radiusQ3, weapon);

        /*
         No surface, no mark. A missile that stopped on a player carries no
         normal (see `Missiles.report`), and `CG_MissileHitPlayer` draws blood
         and a spark and no `CG_ImpactMark` -- Q3 marks walls and never marks
         people. This used to fall back to straight up and stamp a scorch on
         whatever floor happened to be under the body.
        */
        if (normalQ3 !== undefined) this.effects.impactMark(weapon, originQ3, normalQ3);

        /*
         `CG_MissileHitWall`'s `sfx`, and not a rocket's for all five projectile
         weapons alike -- which is what this was, and is why a plasma bolt
         detonated with a rocket's blast. See `impactSound.ts`.

         `CG_MissileHitPlayer` reaches the same switch for the weapons that
         explode on a body as well as on a wall, so a direct hit sounds like an
         impact, which is why this is outside the `normalQ3` guard the mark is
         inside.
        */
        const sfx = impactSound(weapon);
        if (sfx !== null) this.audio?.play(sfx, originQ3);
    }

    /**
     * A death detonates, which makes the kill legible without a death animation.
     * Bots have one; boxes never will.
     *
     * Its own method rather than a call to {@link explosion} with a made-up
     * weapon, because it is not a `CG_MissileHitWall`: nothing struck a surface,
     * so there is no mark and no weapon to choose one by. Overloading the two
     * meanings is also what put an `impact/rocket` on the *player's* death and on
     * nobody else's -- the two call sites went through different doors to reach
     * the same explosion. They now go through this one.
     */
    deathExplosion(originQ3: ArrayLike<number>): void {
        this.effects.explosion(originQ3, 90);
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

        /*
         `EV_DAMAGE` for the person at the keyboard, which is the signal
         `CG_DamageFeedback` runs on. Raised here rather than derived from the
         health falling, because health falls for reasons that are not damage --
         `ClientTimerActions` bleeds a point a second off a freshly spawned
         player's 125 -- and a view kick per bleed is twenty-five seconds of
         jerking after every spawn. See `PlayerController.damaged`.

         `WeaponSystem.damage` has already taken the points off by the time this
         runs, which is what Q3 reads too: the kick scales with the health you
         are *left* with.
        */
        if (target.id === LOCAL_CLIENT) this.onLocalDamage?.(damage);

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

        this.deathExplosion(target.origin);
        this.audio?.play('impact/flesh', target.origin);

        if (box === null) return;

        box.respawnIn = 3;
        if (this.ecd.entityExists(box.entity)) this.ecd.removeEntity(box.entity);
    }

    projectileSpawned(projectile: Projectile, entity: number): void {
        if (entity >= 0) {
            /*
             Blended by `InterpolationSystem`, on the *application* timeline
             rather than the physics one, and the difference is one fixed step of
             the missile's life.

             `PhysicsSystem` is a complete producer for its own timeline and this
             used `interpolatedBody()` to say so. What it cannot record is the
             tick a missile is *born* on: the physics step runs first in the fixed
             cycle and `CombatSystem` -- which fires the weapon -- runs after it,
             so the body does not exist yet when the record pass walks the awake
             set. The log then has one snapshot rather than two, `log.interpolate`
             falls back to the newer of the pair for every alpha, and the missile
             jumps a whole step's travel and then holds still for a whole step
             before it starts to glide. Measured at 165 Hz: a rocket sat frozen
             for four frames at the muzzle, and a plasma stream did it 33 units
             apart, ten times a second.

             `PoseRecorderSystem` is the port's own producer and is registered
             *last* among the simulation systems, so it snapshots the missile on
             the step it was created. Physics still restores the authoritative
             pose at the top of each step -- `__interp_restore` does not filter by
             `sourceId` -- so the solver still integrates from truth rather than
             from a blend.

             Added before the model, so the model's own `TransformAttachment`
             composes against a transform the interpolation is already writing.
            */
            this.ecd.addComponentToEntity(entity, interpolatedPose());

            /*
             `CG_Missile`. Null before the model library has finished loading and
             in every headless caller, and a missile then flies invisibly rather
             than as the orange box this used to draw for all five projectile
             weapons alike -- see `MissileView`.
            */
            this.missileView?.spawn(
                projectile.id,
                entity,
                projectile.weapon,
                projectile.velocity
            );
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

        // `S_StopLoopingSound`.
        fly?.stop();

        /*
         And the model, which does **not** leave with the body.

         `Missiles` owns the missile's entity and retires it, and the
         interpolation and the plasma gun's sprite go with it because they are
         components on it. A mesh model is not: it is one entity per surface,
         held in place by a `TransformAttachment`, and meep is explicit that an
         attachment is a spatial relation and not a lifetime one -- when the
         parent goes the component is dropped and the child stands still. Without
         this line every rocket fired leaves a rocket hanging in the air at the
         point it exploded.
        */
        this.missileView?.despawn(projectile.id);
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
