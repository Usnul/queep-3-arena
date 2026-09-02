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
 * `plasmaBallShader` -- so in Q3 a plasma bolt is a camera-facing sprite and not
 * a mesh.
 *
 * **This port draws a small emissive sphere with a point light inside it**, and
 * that is a departure recorded as one in D-130. A sprite is a core and its own
 * painted falloff, drawn by a renderer that had neither bloom nor local lights;
 * this one has both, so the core is geometry, the falloff is the bloom chain's,
 * and the bolt lights the corridor it flies down -- which is the thing Q3's
 * sprite could never do and the reason the plasma gun looks like a torch here
 * and looked like a decal there.
 *
 * Both components go straight onto the missile's own entity, which already has
 * the `Transform` each of them needs. So a plasma bolt still costs *no extra
 * entity* -- it is two components on a body that exists either way, where a
 * rocket is three entities and three attachments -- and it still leaves with
 * that body, which is why `despawn` has nothing to do for it.
 *
 * The route this replaced went through meep's `Sprite` and `SpriteSystemPE`, and
 * that system is no longer registered by `main.ts`. It was the port's only
 * sprite consumer and it is unusable as it stands: see REPORT.md BUG-17, where
 * the second bolt of every pair crashes on a particle pool the engine disposed
 * but left flagged as built. The sphere is not a workaround for it -- it is a
 * better picture, and it would have been the right answer with the bug fixed --
 * but the bug is why the change was made when it was.
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
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';
import { Color } from '@woosh/meep-engine/src/core/color/Color.js';
import { StandardShadeMaterial } from '@woosh/meep-engine/src/shade/renderer/material/StandardShadeMaterial.js';
import { meshlet_geometry_build_from_geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/meshlet_geometry_build_from_geometry.js';
import { make_octahedron_geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/primitives/make_octahedron_geometry.js';

import type { ModelLibrary } from './map/loadModels.ts';
import { coreWidthQ3 } from './effectWidth.ts';
import { NO_SHADOWS, type ShadowPolicy } from './Shadows.ts';
import { missileModel } from '../game/Weapons.ts';
import { MODEL_TO_VIEW } from './ViewWeapon.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

const DEG_TO_RAD = Math.PI / 180;

/**
 * The ball's radius in metres: half of the sprite's *painted* core.
 *
 * `ent.radius = 16` on an `RT_SPRITE` is a half-extent, so Q3's plasma bolt is
 * 32 units across -- but a sprite is a bright core and its painted falloff in
 * one image, and this sphere is only the core. The falloff is the bloom chain's,
 * and that chain is thresholdless: `downsample_karis` weights every pixel by its
 * own luminance rather than testing it against a cutoff, so a bright small ball
 * spreads in proportion to how bright it is without being asked to.
 *
 * **The first version of this halved Q3's 16 and called that the core, and it
 * was not one.** `sprites/plasmaa.tga` is a small white centre with a corona of
 * thin rays over a wide halo, and its equivalent width -- the disc carrying the
 * same light at the same peak brightness -- is 11.17 units across, not 16. A
 * radius of 8 drew the halo as solid, faceted geometry, which is why the bolt
 * read as a low-poly ball the size of a wall brick with a glow round it instead
 * of a bolt. `coreWidthQ3` is where the measurement is explained; D-156 is the
 * decision, and it moves three beam widths for the same reason.
 */
const PLASMA_RADIUS = (coreWidthQ3('WP_PLASMAGUN') / 2) * WORLD_SCALE;

/**
 * How round the ball is: 8 * 4^2 = 128 triangles, with smooth normals.
 *
 * `make_octahedron_geometry` is the sphere this package has -- there is no
 * `SphereGeometry` -- and it projects a subdivided octahedron, which is a more
 * even vertex distribution than a UV sphere and has no pole. Detail 3 is four
 * times the triangles for a shape that is mostly bloom by the time anyone sees
 * it.
 *
 * **This was a claim that the facets do not show, and at the old radius they
 * did**: a bolt against a wall drew a visible octagon, because a ball 16 units
 * across is a wide enough silhouette for 128 triangles to break up. It is not a
 * claim now, it is a consequence of {@link PLASMA_RADIUS} -- the same ball at
 * the sprite's measured core is a third of a metre across and reads as round
 * with the bloom over it. If that radius is ever raised again, this is the
 * second thing that has to move.
 */
const PLASMA_DETAIL = 2;

/**
 * `MAKERGB( weaponInfo->flashDlightColor, 0.6f, 0.6f, 1.0f )`, from
 * `CG_RegisterWeapon`'s `case WP_PLASMAGUN`. Linear RGB, brightest channel 1.
 *
 * The only colour Q3 states for this weapon, and the same one `muzzleFlash.ts`
 * gives the gun's own flash -- so the muzzle, the bolt and the light it throws
 * agree because all three read one line of C rather than guessing at blue three
 * times.
 */
const PLASMA_COLOR: readonly [number, number, number] = [0.6, 0.6, 1];

/**
 * The ball's emissive luminance on its brightest channel.
 *
 * Same quantity and same scale as a map material's `emissiveLuminance`, which
 * is what makes the number checkable rather than tuned: on `am_thornish` those
 * run from 16 for a launchpad stripe to **295.7** for `base_light/light5_15k`,
 * the brightest fitting in the level. 300 puts a plasma bolt level with that --
 * the brightest thing in the room, and not by an order of magnitude, which is
 * the whole of what "sensible" means here. Exposure is automatic, so a bolt
 * authored ten times brighter would not look ten times brighter; it would darken
 * the room around it.
 *
 * Applied *through* {@link PLASMA_COLOR}, so blue carries the 300 and the other
 * two carry 180. That is the bundle's own convention for a coloured emitter and
 * it is why the ball reads blue rather than white with a blue halo.
 */
const PLASMA_LUMINANCE = 300;

/**
 * The bolt's own light, in lumens, and **the port's number rather than Q3's**.
 *
 * Q3 gives this weapon no `missileDlight` at all -- only the rocket (200) and
 * the BFG light their own flight -- so there is nothing to transcribe and the
 * question is what a travelling light should cost. `muzzleFlash.ts` set the
 * scale it was chosen against: 12,000 lm for an explosion, 1,540 for this gun's
 * muzzle pop, and 560 for the gauntlet, the dimmest of the three flashes that
 * light *continuously* rather than pulsing.
 *
 * A bolt is continuous, so it belongs with the gauntlet, and it went below it:
 * `fireRateMs` is 100 and `speed` is 2000, so sustained fire puts ten or more of
 * these in the air down a long sightline where only ever one gauntlet glow
 * exists. Ten lights at 400 lm is already brighter than the muzzle flash that
 * launched them.
 *
 * **D-160 and D-161 took that whole flash table to a quarter and this number was
 * left where it is**, so two of the three figures above are now 385 and 140 --
 * and 400 is above both of them. The argument this number was chosen by is
 * therefore spent: a bolt is no longer under the pop that fired it but four
 * percent over, and the ten a sustained burst puts in the air are ten times it.
 *
 * Left alone deliberately all the same. Both reports were about muzzle flashes,
 * a bolt in flight is not one, and dimming a light nobody complained about to
 * rescue a comparison is the wrong way round -- the comparison is what broke.
 * D-161 records it, `missile-view.test.ts` no longer asserts it, and the number
 * to revisit when the flashes are next touched is this one.
 */
const PLASMA_LIGHT_LUMENS = 400;

/**
 * How far that light reaches, in Q3 units.
 *
 * 150 is not chosen either: it is the reach `muzzleFlash.ts` gives the gauntlet,
 * the lightning gun and the grapple, on the strength of `CG_AddPlayerWeapon`
 * lighting those three continuously while the other eight are pulsed at 300. A
 * bolt in flight is the continuous case, so it takes the continuous number.
 */
const PLASMA_LIGHT_REACH_Q3 = 150;

/**
 * What `Arena` needs of this class, so it can dress a missile it is told about.
 *
 * The same shape and the same reason as `ViewWeaponSink`: the arena is built
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

    private readonly shadows: ShadowPolicy;

    /**
     * Projectile id -> what is drawing it.
     *
     * Absent for the plasma gun: its ball and its light are components of the
     * body itself, so there is nothing to remember and nothing to take away.
     */
    private readonly drawn = new Map<number, Drawn>();

    /**
     * The plasma ball's mesh and surface, built once and shared by every bolt.
     *
     * One geometry and one material for the whole match, the same arrangement
     * `Arena` makes for its target boxes: `ShadedGeometry.from` stores both by
     * reference, nothing here ever writes them per bolt, and the renderer's
     * material context keys on the instance -- so ten bolts in the air are ten
     * draws of one material rather than ten materials.
     */
    private readonly plasmaGeometry = meshlet_geometry_build_from_geometry(
        make_octahedron_geometry(PLASMA_RADIUS, PLASMA_DETAIL)
    );

    private readonly plasmaMaterial = new StandardShadeMaterial();

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
     * problem, and not the same thing as the plasma gun -- that one is drawn
     * without a model on purpose and is not listed. Reported once each, for the
     * load log.
     */
    readonly unmodelled: string[] = [];

    /**
     * @param shadows what the plasma bolt's light asks before it casts. Defaults
     *     to the answer every effect light gave before there was a setting,
     *     which is the shape a test and a headless run both want.
     */
    constructor(ecd: EcsDataset, library: ModelLibrary, shadows: ShadowPolicy = NO_SHADOWS) {
        this.ecd = ecd;
        this.library = library;
        this.shadows = shadows;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(ShadedGeometry)) {
            ecd.registerComponentType(ShadedGeometry);
        }
        if (!ecd.isComponentTypeRegistered(TransformAttachment)) {
            ecd.registerComponentType(TransformAttachment);
        }
        if (!ecd.isComponentTypeRegistered(Light)) ecd.registerComponentType(Light);

        /*
         Emissive only. `diffuse_color` is black because a plasma bolt has no
         diffuse response worth having -- it is a light source, not a lit
         marble, and a ball that picked up the corridor's own colour would read
         as a painted sphere the moment it flew past something red. What is left
         of the surface is the dielectric Fresnel rim at `ior_factor`'s default,
         which is the highlight that keeps it looking spherical at all.

         With no `texture_emissive` bound the resident material context
         substitutes `WHITE_PIXEL_TEXTURE`, so `emissive_factor` is the whole of
         the emission rather than a multiplier over nothing.
        */
        this.plasmaMaterial.name = 'plasma:bolt';
        this.plasmaMaterial.diffuse_color = new Color(0, 0, 0);
        this.plasmaMaterial.emissive_factor = new Color(
            PLASMA_COLOR[0] * PLASMA_LUMINANCE,
            PLASMA_COLOR[1] * PLASMA_LUMINANCE,
            PLASMA_COLOR[2] * PLASMA_LUMINANCE
        );
        this.plasmaMaterial.roughness_factor = 1;
        this.plasmaMaterial.metallic_factor = 0;
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
             for it, drawing the bolt itself instead of a model. Anything else
             with no model is a weapon whose projectile the C does not draw
             either, and it should not silently get a plasma ball.
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
     * `CG_Missile`'s plasma branch, drawn the way this renderer can draw it: a
     * small emissive sphere with a point light in the middle of it.
     *
     * Both go straight onto the missile's own entity, which already carries the
     * `Transform` that `ShadedGeometrySystem3` and `LightSystem3` each want --
     * so a plasma bolt costs two components on a body that exists anyway, where
     * a rocket costs three entities and three attachments. Neither needs taking
     * away: they leave with the body, which is why `despawn` has nothing to do
     * for this weapon.
     *
     * The sphere needs no orientation and no roll. `orientAlong` and
     * {@link update} exist because a rocket is a shape with a nose; this one is
     * the one missile in the game for which a rotation cannot be observed.
     */
    private plasmaBall(entity: number): void {
        const ball = ShadedGeometry.from(this.plasmaGeometry, this.plasmaMaterial);

        /*
         Written every fixed step by `integrate_position`, which is the case the
         flag exists for -- the same reason every missile mesh above carries it.
        */
        ball.setFlag(ShadedGeometryFlags.DeferredBoundsUpdate);
        // `RF_NOSHADOW`, which `CG_Missile` sets on every missile it draws.
        ball.clearFlag(ShadedGeometryFlags.CastShadow);

        this.ecd.addComponentToEntity(entity, ball);

        const light = new Light();
        light.type.set(LightType.POINT);
        light.color.setRGB(PLASMA_COLOR[0], PLASMA_COLOR[1], PLASMA_COLOR[2]);
        // Lumens to candela, as everywhere else in this port: a point light's
        // intensity is luminous intensity and the constant is authored as flux.
        light.intensity.set(PLASMA_LIGHT_LUMENS / (4 * Math.PI));
        light.distance.set(PLASMA_LIGHT_REACH_Q3 * WORLD_SCALE);
        /*
         Asked rather than answered here, because `Shadows.ts` exists so that
         four files cannot each decide this in a comment. Worth knowing what the
         answer costs under `all`, which is the mode that says yes: a muzzle
         flash is one static light for 50 ms, and this is ten moving omni casters
         for a second each, every one of them re-rendering six faces per frame
         because it moved. That is the mode's bill and not this effect's -- the
         same reading `muzzleFlash.ts` takes -- and the default mode is `sun`, so
         out of the box a bolt lights the corridor without shadowing it.
        */
        light.castShadow.set(this.shadows.casts('effect'));

        this.ecd.addComponentToEntity(entity, light);
    }
}
