/*
 * MissileView.ts -- what a projectile looks like on its way to you.
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
 * `CG_Missile`, on the body the physics engine is already flying.
 *
 * What this replaces is one `BoxGeometry(1, 1, 1)` scaled to eight units and
 * tinted orange, used for every projectile in the game -- a rocket, a grenade, a
 * plasma bolt and a BFG shot were the same glowing cube. The models exist and
 * always did: `CG_RegisterWeapon` names one per weapon, `extract-balance.mjs`
 * now lifts those paths out of `cg_weapons.c`, and `convert-models.ts` converts
 * them alongside the pickups.
 *
 * # Two entities per missile, and why
 *
 * A missile is one entity -- the `RigidBody` `Missiles` built -- and an ECS
 * entity holds one `ShadedGeometry`. Q3's missile models are not one surface:
 * `rocket.md3` is a body plus a thrust flare plus a rocket flare, and
 * `bfg.md3` is *entirely* two additive surfaces with no solid part at all. So
 * drawing "the model" means drawing two or three meshes at one pose, and the
 * pose belongs to a body the solver owns.
 *
 * `TransformAttachment` is the engine's answer and is used as-is: each mesh is
 * its own entity whose world transform is composed as `parent x local`, and the
 * system subscribes to the parent's transform rather than polling it. That last
 * part is the reason not to write these poses from the game's own tick: a
 * missile carries `Interpolated`, so its transform is rewritten between fixed
 * steps by `InterpolationSystem`, and a child updated once per fixed step would
 * snap along behind a parent that glides. Subscribing inherits the smoothing for
 * nothing.
 *
 * The attachment is *spatial only* -- meep is explicit that it is not a lifetime
 * relation -- so a child whose parent is destroyed keeps its last pose and
 * becomes a root, which is a rocket model left hanging in the air at the point
 * of every explosion. `despawn` is what stops that, and `Arena` calls it from
 * `projectileGone`, which fires however a missile leaves: detonation, or Q3's
 * ten-second timer.
 *
 * # The one weapon with no model
 *
 * The plasma gun. `CG_RegisterWeapon`'s line for it is commented out in the C
 * and `CG_Missile` special-cases it instead -- `reType = RT_SPRITE`, radius 16,
 * `plasmaBallShader` -- so a plasma bolt is a camera-facing sprite and not a
 * mesh. meep has `Sprite` for exactly that, and it goes straight onto the
 * missile's own entity: a sprite needs a `Transform` and nothing else, so this
 * is the *simpler* of the two paths rather than a special case that costs
 * something.
 *
 * # The spin, which was left out once and should not have been
 *
 * `CG_Missile` is two lines of orientation and this is the second:
 * `VectorNormalize2(s1->pos.trDelta, ent.axis[0])` aims the model down its line
 * of flight, and `RotateAroundDirection(ent.axis, cg.time / 4)` rolls it about
 * that line at 250 degrees a second.
 *
 * The first version of this file ported the aim and skipped the roll, on the
 * reasoning that it buys "a barrel roll on a shape that is very nearly a surface
 * of revolution". That is true of the rocket and true of the nail, and it is
 * false of the two missiles it is least true of: `grenade1.md3` is a 14.6 x 10.9
 * x 5.9 slab and `proxmine.md3` is a 23.8-wide drum on a vertical axis. Held at
 * one fixed roll for a whole flight, both read as an object presented flat to
 * you rather than one thrown at you -- and those are exactly the two weapons
 * that came back reported. Q3 spins them because the artwork needs it.
 *
 * The roll is applied to the *local* rotation of each mesh, about the model's
 * own +X, which is by construction the axis the aim already put on the flight
 * direction -- so it can never disturb the aim. It costs one quaternion multiply
 * per drawn surface per fixed step.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ShadedGeometryFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometryFlags.js';
import { TransformAttachment } from '@woosh/meep-engine/src/engine/ecs/transform-attachment/TransformAttachment.js';
import { Sprite } from '@woosh/meep-engine/src/engine/graphics/ecs/sprite/Sprite.js';

import type { ModelLibrary } from './map/loadModels.ts';
import { missileModel } from '../game/Weapons.ts';
import { MODEL_TO_VIEW } from './ViewWeapon.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

const DEG_TO_RAD = Math.PI / 180;

/**
 * `ent.radius = 16` from `CG_Missile`'s plasma branch, as a diameter in metres.
 *
 * Q3's `radius` on an `RT_SPRITE` is the half-extent, so the sprite is 32 units
 * across; `Sprite.size` is the whole of it, which is where the doubling goes.
 */
const PLASMA_SPRITE_SIZE = (16 * 2) * WORLD_SCALE;

/** `sprites/plasma1`, which is `sprites/plasmaa.tga` drawn twice, additively. */
const PLASMA_SPRITE_URL = '/assets/built/fx/plasma_ball.png';

/**
 * What `Arena` needs of this class, so it can dress a missile it is told about.
 *
 * The same shape and the same reason as `MuzzleFlashSink`: the arena is built
 * before the model library exists, so this arrives afterwards and is null until
 * it does.
 */
export interface MissileSink {
    spawn(
        projectileId: number,
        entity: number,
        weapon: string,
        velocityQ3: ArrayLike<number>
    ): void;
    despawn(projectileId: number): void;
    update(deltaSeconds: number): void;
}

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    addComponentToEntity(entity: number, component: unknown): void;
    entityExists(entity: number): boolean;
    removeEntity(entity: number): void;
}

const scratchRoll = new Quaternion();

/**
 * `RotateAroundDirection(ent.axis, cg.time / 4)`, in degrees per second.
 *
 * `cg.time` is milliseconds, so a quarter of it per millisecond is 250 degrees a
 * second -- a brisk tumble, and the number is Q3's rather than a rate chosen to
 * look right.
 */
const SPIN_DEGREES_PER_SECOND = 250;

/** What is drawing one missile, and the base rotation the spin is applied to. */
interface Drawn {
    /** One per surface of the model. */
    readonly entities: number[];
    /** Parallel to `entities`; the attachment whose local rotation is written. */
    readonly attachments: TransformAttachment[];
    /**
     * The aim, without the roll.
     *
     * Kept rather than recovered from the current rotation, because recovering
     * it means dividing out the roll and a quaternion that has been multiplied
     * once a frame for ten seconds is not the one it started as.
     */
    readonly aim: Quaternion;
}

/**
 * The rotation that points a converted model's own forward along `dirMeep`.
 *
 * A model out of this pipeline points +X down its length -- the same fact
 * `ViewWeapon` turns a gun by, which is why {@link MODEL_TO_VIEW} is imported
 * rather than written again here. `_lookRotation` builds a frame whose +Z is
 * the direction, so the model turn is composed on the right to carry +X onto
 * that +Z. Q3 does the same thing in one line, because a `refEntity`'s axes are
 * a matrix it can write the direction straight into:
 * `VectorNormalize2(s1->pos.trDelta, ent.axis[0])`.
 *
 * The up hint is only ever a hint -- it decides the roll of a shape that is
 * near enough rotationally symmetric -- but it cannot be parallel to the
 * direction, which is what the switch is: a rocket fired straight up is not a
 * rare shot.
 */
export function orientAlong(
    dirMeep: readonly [number, number, number],
    out: Quaternion
): void {
    const [dx, dy, dz] = dirMeep;

    // World up, unless the shot is along it, in which case anything else does.
    const vertical = Math.abs(dy) > 0.99;

    out._lookRotation(dx, dy, dz, 0, vertical ? 0 : 1, vertical ? 1 : 0);
    out.multiply(MODEL_TO_VIEW);
}

/** Q3 (Z-up) -> meep (Y-up). Direction only, so no scale. */
function dirToMeep(q3: ArrayLike<number>): [number, number, number] {
    const x = q3[0]!;
    const y = q3[1]!;
    const z = q3[2]!;

    const length = Math.hypot(x, y, z);
    if (length < 1e-6) return [0, 0, 1];

    return [x / length, z / length, -y / length];
}

export class MissileView implements MissileSink {
    private readonly ecd: EcsDataset;
    private readonly library: ModelLibrary;

    /** Projectile id -> what is drawing it. Absent for the plasma gun's sprite. */
    private readonly drawn = new Map<number, Drawn>();

    /**
     * `cg.time`, in seconds, and the only state the spin needs.
     *
     * Q3 rolls every missile by `cg.time / 4` degrees -- a function of the
     * *clock* rather than of the missile's own age, so every missile in the air
     * shares a phase and none of them has to remember one.
     */
    private timeSeconds = 0;

    /**
     * `WP_*` ids that flew with nothing drawn for them.
     *
     * A weapon whose model the bundle does not have, which is a pipeline
     * problem, and not the same thing as the plasma gun -- that one is a sprite
     * on purpose and is not listed. Reported once each, for the load log.
     */
    readonly unmodelled: string[] = [];

    constructor(ecd: EcsDataset, library: ModelLibrary) {
        this.ecd = ecd;
        this.library = library;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(ShadedGeometry)) {
            ecd.registerComponentType(ShadedGeometry);
        }
        if (!ecd.isComponentTypeRegistered(TransformAttachment)) {
            ecd.registerComponentType(TransformAttachment);
        }
        if (!ecd.isComponentTypeRegistered(Sprite)) ecd.registerComponentType(Sprite);
    }

    /** Live missiles with a model on them. For the tests. */
    get drawnCount(): number {
        return this.drawn.size;
    }

    /**
     * Dress the body `Missiles` is flying, as `CG_Missile` dresses a `centity_t`.
     *
     * `velocityQ3` is the missile's own, and it is what the model is turned by --
     * a `TR_LINEAR` missile never changes direction, so reading it once at the
     * launch is reading it for the whole flight.
     */
    spawn(
        projectileId: number,
        entity: number,
        weapon: string,
        velocityQ3: ArrayLike<number>
    ): void {
        if (entity < 0 || !this.ecd.entityExists(entity)) return;

        const path = missileModel(weapon);

        if (path === null) {
            /*
             The plasma gun, and only the plasma gun: `CG_Missile` returns early
             for it with a sprite. Anything else with no model is a weapon whose
             projectile the C does not draw either, and it should not silently
             get a plasma ball.
            */
            if (weapon === 'WP_PLASMAGUN') this.plasmaBall(entity);
            return;
        }

        const components = this.library.components(path);

        if (components === null || components.length === 0) {
            if (!this.unmodelled.includes(weapon)) this.unmodelled.push(weapon);
            return;
        }

        const aim = new Quaternion();
        orientAlong(dirToMeep(velocityQ3), aim);

        const entities: number[] = [];
        const attachments: TransformAttachment[] = [];

        for (const geometry of components) {
            /*
             The pose is written on every parent move -- which is every frame,
             because the parent is interpolated -- so this is the case the flag
             exists for, exactly as in `ItemsView` and `ViewWeapon`.
            */
            geometry.setFlag(ShadedGeometryFlags.DeferredBoundsUpdate);
            // `RF_NOSHADOW`, which `CG_Missile` sets on every missile it draws.
            geometry.clearFlag(ShadedGeometryFlags.CastShadow);

            const attachment = new TransformAttachment();
            attachment.parent = entity;
            attachment.immediate = true;

            /*
             The model's own orientation and scale, held *locally* rather than
             written onto the body. The body's transform belongs to the solver --
             `integrate_position` writes both halves of it every step -- and a
             presentation rotation living there is a rotation that survives only
             because nothing currently spins a missile. Composed as `parent x
             local`, this is right whether or not that stays true.
            */
            attachment.transform.rotation.copy(aim);
            attachment.transform.scale.set(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

            const builder = new Entity();
            builder.add(new Transform()).add(geometry).add(attachment).build(this.ecd as never);

            entities.push(builder.id);
            attachments.push(attachment);
        }

        this.drawn.set(projectileId, { entities, attachments, aim });
    }

    /**
     * Roll every drawn missile about its own line of flight. Once per step.
     *
     * `RotateAroundDirection(ent.axis, cg.time / 4)`, which `CG_Missile` applies
     * to every missile it draws that is not `TR_STATIONARY` -- and everything
     * this port fires is `TR_LINEAR`.
     *
     * Written to the *local* rotation, about the model's own +X. That axis is
     * the one {@link orientAlong} already put on the flight direction, so
     * composing the roll on the right of the aim spins the model without ever
     * moving where it points; and writing it locally leaves the body's own
     * transform to the solver. `TransformAttachmentSystem` subscribes to the
     * attachment's transform as well as the parent's, so this is picked up
     * without anything having to be told.
     */
    update(deltaSeconds: number): void {
        this.timeSeconds += deltaSeconds;

        if (this.drawn.size === 0) return;

        const radians = ((this.timeSeconds * SPIN_DEGREES_PER_SECOND) % 360) * DEG_TO_RAD;
        scratchRoll._fromAxisAngle(1, 0, 0, radians);

        for (const drawn of this.drawn.values()) {
            for (const attachment of drawn.attachments) {
                attachment.transform.rotation.multiplyQuaternions(drawn.aim, scratchRoll);
            }
        }
    }

    /**
     * Take the model back out of the world.
     *
     * Not optional and not a tidy-up: `TransformAttachment` is a spatial
     * relation and not a lifetime one, so meep drops the component when the
     * parent goes and leaves the child standing at its last pose. Without this
     * every rocket fired leaves a rocket hanging in the air where it exploded.
     */
    despawn(projectileId: number): void {
        const drawn = this.drawn.get(projectileId);
        if (drawn === undefined) return;

        this.drawn.delete(projectileId);

        for (const entity of drawn.entities) {
            if (this.ecd.entityExists(entity)) this.ecd.removeEntity(entity);
        }
    }

    /**
     * `CG_Missile`'s plasma branch: a camera-facing sprite, and no model at all.
     *
     * Straight onto the missile's own entity, which already has the `Transform`
     * a sprite needs, so a plasma bolt costs one component where a rocket costs
     * three entities. It leaves with the body, which is why `despawn` has
     * nothing to do for it.
     */
    private plasmaBall(entity: number): void {
        const sprite = new Sprite();
        sprite.url = PLASMA_SPRITE_URL;
        sprite.size = PLASMA_SPRITE_SIZE;
        // `sprites/plasma1` is two additive passes of a blue-white ball; the
        // colour is the texture's and this is the tint, so it stays white.
        sprite.color.setRGB(1, 1, 1);

        this.ecd.addComponentToEntity(entity, sprite);
    }
}
