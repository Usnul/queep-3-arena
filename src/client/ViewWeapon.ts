/*
 * ViewWeapon.ts -- the gun in your hands.
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
 * `CG_AddViewWeapon` and `CG_CalculateWeaponPosition`, on meep's ordinary mesh
 * path. The weapon is a `ShadedGeometry` entity like any other -- the same
 * models the pickups use, the same lighting, the same frustum -- placed each
 * frame relative to the camera rather than parented to it.
 *
 * # Putting a weapon away
 *
 * By taking the drawn pieces' `ShadedGeometry` off their entities, which is the
 * only thing that works. `ShadedGeometryFlags.Visible` is documented as *"If set
 * to false will not render"* and this file used to believe it; the flag is read
 * by nothing in the engine (BUG-10), so the weapon you switched *away* from
 * stayed in the scene. And because only the held weapon's transform is written
 * each frame, it stayed at the pose it was last drawn at -- a gun hanging in the
 * air where you were standing, which snapped back into your hands the moment you
 * selected it again. One dead flag, and both halves of the complaint.
 *
 * Visibility in Shade is membership: `ShadedGeometrySystem3` adds a `Mesh` to
 * the scene in `link` and removes it in `unlink`, and `Node3D` has no per-node
 * visible bit to set. So `show` adds and removes the component, exactly as
 * `ItemsView` does for a collected pickup (D-086, D-088). The entity and its
 * `Transform` outlive the hidden interval, so a weapon is still built once and
 * kept for the rest of the map.
 *
 * **Where it sits is measured, not chosen.** Q3 draws a hands model at the view
 * origin and hangs the weapon off its `tag_weapon`, so that tag is the offset
 * from the eye, per weapon, authored by the people who made the game. The
 * pipeline converts the hands models for it -- they carry no geometry at all in
 * OpenArena, only the tag and the animation frames -- and `CG_RegisterWeapon`'s
 * own fallback to the shotgun's applies here for the seven that ship none.
 *
 * Three things Q3 does are **not** ported, and all three are the renderer:
 *
 * - `RF_DEPTHHACK`, which squashes the gun's depth range so it can never poke
 *   through a wall. That is a property of the draw, and this draws through the
 *   scene's own G-buffer pass; the gun therefore clips into geometry you stand
 *   against, exactly as any other object would.
 * - `RF_MINLIGHT`, a floor under the gun's lighting so it is never a
 *   silhouette. Nothing here corresponds, so a dark room gets a dark gun.
 * - `RF_FIRST_PERSON`, which keeps it out of mirrors and out of the shadow
 *   pass. Only the second half matters here, and that is one flag.
 *
 * The landing dip is not ported either, for a different reason: it is scaled by
 * `cg.landChange`, which comes from the `EV_FALL_SHORT`/`MEDIUM`/`FAR` split,
 * and nothing in this port carries a landing's severity yet.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ShadedGeometryFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometryFlags.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';

import { bobFracSin, bobOddCycle } from './bob.ts';
import {
    barrelAttachment,
    barrelSpinAngle,
    newBarrelSpin,
    placeOnTag,
    TAG_BARREL,
    type TagAttachment,
} from './barrel.ts';
import type { ModelLibrary } from './map/loadModels.ts';
import { weaponItemByTag } from '../game/Items.ts';
import { NO_SHADOWS, type ShadowPolicy } from './Shadows.ts';
import { applyMuzzleFlash, MUZZLE_FLASH_SECONDS } from './muzzleFlash.ts';

const WORLD_SCALE = 1 / 32;

/** `CG_RegisterWeapon`'s fallback when a weapon ships no hands model. */
const FALLBACK_HANDS = 'models/weapons2/shotgun/shotgun_hand.md3';

/** The tag `CG_AddPlayerWeapon` hangs the weapon off. */
const TAG_WEAPON = 'tag_weapon';

/** And the one it hangs the muzzle flash off, on the weapon's own model. */
const TAG_FLASH = 'tag_flash';

const DEG_TO_RAD = Math.PI / 180;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    addComponentToEntity(entity: number, component: unknown): void;
    removeComponentFromEntity(entity: number, type: unknown): void;
}

/**
 * What `Arena` needs of this class, so it can hand the gun what came out of it.
 *
 * Two effects and one question: *is this weapon the one on screen?* Both answer
 * it the same way and both fall back to the world when the answer is no, which
 * is what makes a single `ownerId === LOCAL_CLIENT` test at the call site
 * enough -- a dead player and a weapon the bundle has no model for decline the
 * beam exactly as they decline the light.
 *
 * Named for the class rather than for the flash since D-164 gave it a second
 * member. It was `MuzzleFlashSink` while a flash was the only thing the gun was
 * offered.
 */
export interface ViewWeaponSink {
    flash(weapon: string): boolean;
    hitscanTrail(weapon: string, endQ3: ArrayLike<number>): boolean;
}

/**
 * And what this class needs of `Effects`, to throw a flash out of the barrel.
 *
 * Narrow on purpose. `Effects` is the whole presentation bus and this file wants
 * one of its methods; naming that method is what keeps the dependency from
 * becoming "the view weapon can do anything the world can do", and is what lets
 * a test pass in a counter.
 */
export interface MuzzleParticleSink {
    muzzleFlashParticles(
        positionMeep: readonly number[],
        directionMeep: readonly number[],
        weapon: string
    ): void;
}

/**
 * And the other half of it: the line a hitscan shot leaves behind.
 *
 * Separate from {@link MuzzleParticleSink} rather than a second method on it,
 * for the reason that one is narrow: these are two unrelated capabilities of the
 * same object, and a test that wants to count bursts should not have to stub a
 * beam to do it.
 *
 * The muzzle is in **scene metres** and the far end in **Q3 units**, which looks
 * careless and is not. The near end is a point on a drawn mesh and has never
 * been anything else; the far end is where the ray stopped, which is the
 * simulation's answer in the simulation's units, and converting it here would be
 * converting it twice.
 */
export interface HitscanTrailSink {
    hitscanTrailFromGun(
        weapon: string,
        muzzleMeep: readonly number[],
        endQ3: ArrayLike<number>
    ): void;
}

/**
 * Where the eye is and which way it looks. A `Transform` satisfies this.
 *
 * **It has to be the pose the *frame* is drawn from, not the camera entity's.**
 * The two are not the same object and are never the same value: `Engine`
 * subscribes `entityManager.update` to the ticker in its constructor, so
 * `CameraSystem3` copies the camera entity onto Shade's camera *before* any
 * application tick handler runs, and the pose it copied is therefore the one
 * written at the end of the previous tick. A gun placed from the entity's
 * transform is a whole tick of mouse movement ahead of the camera it is supposed
 * to be welded to -- measured on `oa_dm1` at 4 to 20 degrees of swing per frame,
 * varying with the turn rate, which is exactly what "the weapon jerks" looks
 * like. See D-081.
 */
export interface CameraPose {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly rotation: {
        readonly x: number;
        readonly y: number;
        readonly z: number;
        readonly w: number;
    };
}

export interface ViewWeaponState {
    /** `WP_*`. */
    readonly weapon: string;
    /** Horizontal speed, Q3 units per second -- `cg.xyspeed`. */
    readonly speed: number;
    /** `ps->bobCycle`, which the player state carries on both movement paths. */
    readonly bobCycle: number;
    /** False hides it: no gun for a corpse, and none for the noclip camera. */
    readonly visible: boolean;
    /**
     * `EF_FIRING` -- the trigger is *held*, not a shot was fired.
     *
     * Only the barrel spin reads it, and it is the whole of what that needs:
     * `CG_MachinegunSpinAngle` is a two-state latch on this flag. See
     * `PlayerController.firing` for how the flag is derived, and `barrel.ts` for
     * what is done with it.
     */
    readonly firing: boolean;
}

/*
 The gait, which lives in `bob.ts` because three separate things read it -- the
 footstep events, the sway below, and the view bob in `viewOffset.ts`. Re-exported
 rather than moved out of sight: this file was where they were, and every reader
 of the sway wants them in the same breath.
*/
export { BOB_HALF, bobFracSin, bobOddCycle } from './bob.ts';

/**
 * `CG_CalculateWeaponPosition`'s angle offsets, in degrees.
 *
 * Two contributions, and Q3 applies both unconditionally: the walk bob, whose
 * roll and yaw invert on alternate steps so the gun sways rather than
 * oscillating, and an idle drift on a one-second sine that never stops -- the
 * `+ 40` in its scale is what keeps a standing player's gun alive.
 *
 * Returned as pitch/yaw/roll to match `vec3_t angles`, and kept pure so a test
 * can assert that the sway inverts between steps and the drift does not.
 */
export function weaponSway(
    speed: number,
    bobCycle: number,
    timeSeconds: number
): [number, number, number] {
    const fracSin = bobFracSin(bobCycle);

    let scale = bobOddCycle(bobCycle) ? -speed : speed;

    let roll = scale * fracSin * 0.005;
    let yaw = scale * fracSin * 0.01;
    let pitch = speed * fracSin * 0.005;

    scale = speed + 40;
    const drift = Math.sin(timeSeconds);

    roll += scale * drift * 0.01;
    yaw += scale * drift * 0.01;
    pitch += scale * drift * 0.01;

    return [pitch, yaw, roll];
}

/**
 * The eye-relative offset for a weapon, from its hands model's `tag_weapon`.
 *
 * The bundle stores tags in meep's model axes -- x forward, y up, z right --
 * and the camera's own frame is x **left**, y up, z forward, because
 * `_lookRotation` derives its first axis as `up x forward`. So the components
 * are permuted rather than copied, and the sideways one is negated. Getting
 * that wrong puts the gun in the other hand, which is a mistake that looks
 * plausible.
 *
 * The candidates are tried in `CG_RegisterWeapon`'s own order -- this weapon's
 * hands model, then the shotgun's -- and a candidate whose tag is not *in front
 * of the eye* is skipped rather than used, which is the one rule here the C does
 * not have and the chaingun is why. See the note at the check.
 *
 * Q3 units. Null when neither the weapon's own hands model nor the shotgun's is
 * in the bundle, which means the pipeline has not been run.
 */
export function handOffset(
    library: ModelLibrary,
    weapon: string
): [number, number, number] | null {
    const world = weaponItemByTag(weapon)?.models[0];

    const candidates: string[] = [];
    if (world !== undefined && world.toLowerCase().endsWith('.md3')) {
        candidates.push(`${world.slice(0, -'.md3'.length)}_hand.md3`);
    }
    candidates.push(FALLBACK_HANDS);

    for (const path of candidates) {
        const tag = library.definition(path)?.tags.find((t) => t.name === TAG_WEAPON);
        if (tag === undefined) continue;

        /*
         A hands model whose tag puts the gun *behind the eye* is a hands model
         this cannot use, and is refused the same way one that does not load is.

         `CG_RegisterWeapon` falls back to the shotgun's when
         `trap_R_RegisterModel` returns nothing, which covers a file that is
         missing and not a file that is wrong. OpenArena's
         `vulcan_hand.md3` is the second thing: its `tag_weapon` is
         `(-4.68, -0.66, -9.23)` on every one of its eleven frames -- 4.7 units
         **backwards**, 9.2 down and 0.7 to the right, where the other twelve
         weapons are 5.7 to 11.9 units *forward* and 5.8 to 7.1 to the right. The
         vulcan mesh is 19 units long about a centre 1.6 behind its own origin,
         so the whole chaingun ended up behind the near plane and below the
         frustum. It was built, it was linked, `drawnWeapon` reported it, and
         nothing was on screen -- which is exactly how it was reported.
         See D-121.

         The test is `forward > 0` and not a tolerance, because it is not a
         judgement about how far forward a gun should be: a weapon held behind
         your own eye is not a pose, and every plausible authoring mistake that
         produces one lands on the wrong side of zero. Eleven of the twelve are
         nowhere near it.
        */
        if (tag.origin[0]! <= 0) continue;

        return [-tag.origin[2]!, tag.origin[1]!, tag.origin[0]!];
    }

    return null;
}

/**
 * `tag_flash` on a weapon's world model, in the model's own axes.
 *
 * The muzzle, as the people who made the gun placed it: 16.7 units down the
 * machinegun's barrel, 23.1 down the shotgun's, and between 0 and 4 units above
 * the model origin on every weapon that has one. There is no fallback to
 * another model's the way {@link handOffset} falls back to the shotgun's hands,
 * because a flash point is a property of *this* mesh and borrowing one would
 * hang the light in the air beside the gun.
 *
 * Q3 units. Null when the model ships no such tag.
 */
export function flashOffset(
    library: ModelLibrary,
    model: string
): [number, number, number] | null {
    const tag = library.definition(model)?.tags.find((t) => t.name === TAG_FLASH);
    if (tag === undefined) return null;

    return [tag.origin[0]!, tag.origin[1]!, tag.origin[2]!];
}

/**
 * The point on a drawn weapon that its flash comes out of. Model axes, Q3 units.
 *
 * `tag_flash` for the eleven weapons that ship one, and this exists for the two
 * that do not. Q3 answers those by drawing nothing -- `CG_AddPlayerWeapon`
 * returns on `if (!flash.hModel)`, above the dlight -- and D-115 chose to light
 * them anyway, because a shot with no light reads as a shot that did not happen.
 * What it then did with them was hand them back to `Effects`, which lights the
 * *shot's* origin: `CalcMuzzlePoint`, fourteen units straight out from the eye
 * on the view axis. That is the light-in-your-face D-115 is named after, still
 * on for the gauntlet -- which every player spawns holding. See D-158.
 *
 * So the question "where on this gun" is asked of the model rather than
 * answered by a constant, in three steps, each one a fact about *this* mesh:
 *
 *  1. `tag_flash`, the muzzle its author marked.
 *  2. `tag_barrel`, the mount its author marked for the front half of the gun --
 *     which for the gauntlet is where the blade goes, and is the only point on
 *     it anybody authored.
 *  3. the front of its own bounds, on the centre of that face, for a model that
 *     carries no tags at all. OA's prox launcher is the one, and this is an
 *     estimate rather than a reading -- `muzzle-flash.test.ts` runs it on the
 *     six weapons it would be *reached* for if they had marked nothing, and
 *     measures it against the muzzles they did mark. That is the only check
 *     available for a number no modeller wrote down, and the same test pins the
 *     one model it would be wrong about.
 *
 * Null only when `model` is not in the bundle, which for a weapon on screen is
 * already impossible: {@link ViewWeapon} has its meshes by then.
 */
export function muzzleOffset(
    library: ModelLibrary,
    model: string
): [number, number, number] | null {
    const flash = flashOffset(library, model);
    if (flash !== null) return flash;

    const def = library.definition(model);
    if (def === null) return null;

    const barrel = def.tags.find((t) => t.name === TAG_BARREL);
    if (barrel !== undefined) {
        return [barrel.origin[0]!, barrel.origin[1]!, barrel.origin[2]!];
    }

    return [def.maxs[0]!, (def.mins[1]! + def.maxs[1]!) / 2, (def.mins[2]! + def.maxs[2]!) / 2];
}

/**
 * Where a weapon's projectiles leave it, as an offset from the eye.
 *
 * `tag_flash` reached through `tag_weapon`: the gun hangs off the hands model
 * and the muzzle hangs off the gun, so the two add. Returned as **(forward,
 * right, up)** in Q3 units -- the axes `AngleVectors` hands out -- because the
 * consumer is `WeaponSystem`, which knows about Q3's frame and must not be made
 * to know about the camera's or the model's. See D-116.
 *
 * The sway is deliberately not in it. `weaponSway` is a rendering flourish on a
 * render-rate clock, and a projectile whose spawn point is a function of it is a
 * projectile whose flight depends on the frame rate. This is the gun at rest,
 * which is within a few centimetres of the drawn one and is the same every time.
 *
 * Null when the weapon has no hands tag or its model ships no `tag_flash`, which
 * is the caller's cue to use `CalcMuzzlePoint` as the port always has.
 *
 * **`flashOffset` and not {@link muzzleOffset}, deliberately.** The light took
 * the wider answer in D-158 and this did not, because the two are asking
 * different questions: a lamp wants to be *on the gun* and can be estimated
 * onto it, and a projectile's birthplace is gameplay -- it decides what a rocket
 * clears and what it detonates against, and D-116 already trades 10 units of
 * aim for it. A spawn point nobody authored is not a trade worth making blind,
 * so the two weapons with no `tag_flash` keep `CalcMuzzlePoint` for their shots
 * and get a light on the barrel all the same.
 */
export function barrelOffset(
    library: ModelLibrary,
    weapon: string
): [number, number, number] | null {
    const hand = handOffset(library, weapon);

    const world = weaponItemByTag(weapon)?.models[0];
    const flash = world === undefined ? null : flashOffset(library, world);

    if (hand === null || flash === null) return null;

    /*
     Three frames meet here and only the arithmetic says so. `hand` is the
     camera's -- x **left**, y up, z forward -- and `flash` is the model's -- x
     forward, y up, z right. Adding them componentwise would be wrong twice over;
     what makes the sum legal is that the model's rotation is the camera's turned
     by `MODEL_TO_VIEW`, so both land in the same frame once permuted, and the
     result is stated in the third.
    */
    return [hand[2] + flash[0], -hand[0] + flash[2], hand[1] + flash[1]];
}

/**
 * A model-space rotation taking the weapon's own axes onto the camera's.
 *
 * A converted model points +X down the barrel, +Y up and +Z to its right; the
 * camera's local frame is +Z forward, +Y up, +X left. Both are right-handed, so
 * lining up forward and up lines up the third for free -- and the rotation that
 * does it is a quarter turn about the shared up axis. Which way that turn goes
 * is the whole content of the constant: the other one points the barrel at the
 * player.
 *
 * Exported because it is a fact about the *pipeline* rather than about the view
 * weapon -- every MD3 this port converts points +X down its own length, missiles
 * included -- and `MissileView` turns a rocket to face its flight with the same
 * quarter turn on the right of the same kind of look rotation. Two copies of a
 * sign convention is two chances for one of them to be corrected alone.
 */
export const MODEL_TO_VIEW = new Quaternion()._fromAxisAngle(0, 1, 0, -Math.PI / 2);

const scratchSway = new Quaternion();
const scratchAxis = new Quaternion();

/**
 * Where the gun goes, given the eye, the hands tag and this frame's sway.
 *
 * Split out and pure because it is the part that is wrong in a way you cannot
 * see: a gun in the wrong hand, or a barrel pointing at the player, both draw
 * perfectly and look like a modelling problem. `first-person.test.ts` fires a
 * view direction through it and checks that the barrel comes out along the view
 * and the gun comes out down and to the right of the eye.
 *
 * `offsetQ3` is in the camera's own frame -- see {@link handOffset} -- and
 * `sway` is `CG_CalculateWeaponPosition`'s pitch/yaw/roll in degrees. The
 * outputs are world position in metres and a world rotation for the model.
 */
export function placeViewWeapon(
    camera: CameraPose,
    offsetQ3: readonly [number, number, number],
    sway: readonly [number, number, number],
    outPosition: Vector3,
    outRotation: Quaternion
): void {
    const rotation = camera.rotation as Quaternion;

    /*
     The sway, in the camera's own axes. Q3 adds these to the view angles and
     rebuilds the axis from the sum; composing them as a local rotation instead
     leaves the camera's own orientation untouched, and is exact for the yaw and
     the roll because they turn about axes the view already has.

     Pitch is negated because Q3's is positive *downwards*, while a right-handed
     turn about the camera's +X -- which is its left -- lifts the nose.
    */
    scratchSway._fromAxisAngle(0, 1, 0, sway[1]! * DEG_TO_RAD);
    scratchAxis._fromAxisAngle(1, 0, 0, -sway[0]! * DEG_TO_RAD);
    scratchSway.multiply(scratchAxis);
    scratchAxis._fromAxisAngle(0, 0, 1, sway[2]! * DEG_TO_RAD);
    scratchSway.multiply(scratchAxis);

    outRotation.multiplyQuaternions(rotation, scratchSway);
    outRotation.multiply(MODEL_TO_VIEW);

    outPosition.set(
        offsetQ3[0]! * WORLD_SCALE,
        offsetQ3[1]! * WORLD_SCALE,
        offsetQ3[2]! * WORLD_SCALE
    );
    outPosition.applyQuaternion(rotation);

    outPosition.set(
        camera.position.x + outPosition.x,
        camera.position.y + outPosition.y,
        camera.position.z + outPosition.z
    );
}

/** One weapon's drawable pieces, built once and kept. */
interface DrawnWeapon {
    readonly transforms: Transform[];
    readonly geometries: ShadedGeometry[];
    /** Parallel to `geometries`; the entity each one is linked to and off. */
    readonly entities: number[];
    /**
     * Parallel to `transforms`: where that piece sits on the gun, or null for a
     * piece that *is* the gun.
     *
     * Only the barrel is ever non-null, and only for the five weapons that ship
     * one. It is a per-piece field rather than a second list because everything
     * else about a barrel -- built once, shown and hidden with the weapon,
     * counted in `pieceCount` -- is what the body already does, and the one
     * thing that differs is the pose it is written each frame. See `barrel.ts`.
     */
    readonly attachments: (TagAttachment | null)[];
    readonly offset: readonly [number, number, number];
    /**
     * The muzzle in the model's own axes, Q3 units. See {@link muzzleOffset}.
     *
     * Never null, which is the whole of D-158: a weapon that is *drawn* has a
     * front, so there is always somewhere on it to hang the light, and only a
     * weapon with no model at all falls back to the shot's own origin.
     *
     * Not permuted the way {@link handOffset} permutes `tag_weapon`, and for a
     * reason: the hands tag is an offset *from the eye* and has to be expressed
     * in the camera's frame, while this one is a point *on the model* and is
     * carried into the world by the model's own rotation, which already contains
     * `MODEL_TO_VIEW`. Permuting it as well would apply that turn twice.
     */
    readonly muzzle: readonly [number, number, number];
    /**
     * Whether the geometries are attached, which is what "on screen" means.
     *
     * Redundant with `current` by construction -- exactly the held weapon is
     * attached -- and kept anyway so `show` is total. A method that adds or
     * removes an ECS component is one the dataset will assert or warn about if
     * it is asked twice, and pushing that condition onto its one caller is how
     * the second caller gets it wrong.
     */
    visible: boolean;
}

const scratchPosition = new Vector3();
const scratchRotation = new Quaternion();
const scratchFlash = new Vector3();
const scratchForward = new Vector3();

/**
 * `tag_flash` in world space, written once a frame by {@link ViewWeapon.update}.
 *
 * One point, three consumers -- the light, the burst and the beam -- because
 * they are all the same muzzle and reading them off one another is how they
 * were kept together before D-164 added the third.
 */
const scratchMuzzle = new Vector3();

export class ViewWeapon implements ViewWeaponSink {
    private readonly ecd: EcsDataset;
    private readonly library: ModelLibrary;
    private readonly shadows: ShadowPolicy;
    private readonly drawn = new Map<string, DrawnWeapon>();

    private timeSeconds = 0;

    /**
     * `cent->pe`'s barrel latch, and there is one of it.
     *
     * Per *player* rather than per weapon, because that is where the C keeps it:
     * spin up the chaingun, switch to the gauntlet and switch back, and the
     * barrel is where it would have been. See `barrel.ts`.
     */
    private readonly spin = newBarrelSpin();

    private current: DrawnWeapon | null = null;
    private currentName = '';

    /**
     * The flash light, and there is one of it.
     *
     * One entity for the whole class rather than one per weapon, because you
     * fire one gun at a time; the transform is rewritten from whichever
     * `tag_flash` is in your hands. Built on the first shot, so a session that
     * never fires never pays for it, and lit by *membership* -- the `Light`
     * component goes on and comes off the entity -- for the same reason `show`
     * moves the `ShadedGeometry` rather than setting a flag on it.
     */
    private flashEntity = -1;
    private readonly flashLight = new Light();
    private readonly flashTransform = new Transform();
    private flashSeconds = 0;
    private lit = false;

    /**
     * Where the flash's particles go, or null for a session that draws none.
     *
     * A property rather than a constructor argument for the same reason
     * `Arena.viewWeapon` is one: `Effects` belongs to the arena, the arena is
     * built before the model library has finished becoming meshes, and this
     * class is built after. `main.ts` ties the two ends together.
     */
    particles: MuzzleParticleSink | null = null;

    /**
     * A shot whose burst has not been emitted yet.
     *
     * The burst is raised from `update` and not from {@link flash}, because
     * `flash` is called by the *simulation* and the only muzzle position
     * available at that moment is the one the last frame drew. One frame is 16
     * ms of a 50 ms effect and half a metre at running speed, and the whole
     * reason this rides the gun is that half a metre is visible.
     *
     * A flag rather than a count: two shots between two rendered frames raise
     * one burst. Q3 collapses them the same way -- `muzzleFlashTime` is a
     * timestamp, not a queue -- and a chaingun at 30 ms between rounds is the
     * only weapon that can do it.
     */
    private pendingBurst = false;

    /**
     * Where the beams go, or null for a session that draws none. See
     * {@link particles}, which arrives the same way and for the same reason.
     */
    trails: HitscanTrailSink | null = null;

    /**
     * Rays fired since the last frame, waiting for a muzzle to be drawn from.
     *
     * The same deferral {@link pendingBurst} is, and the *measured* case for it:
     * a beam seeded at the simulation's idea of the barrel starts 3.8 Q3 units
     * ahead of the drawn one at a run, in the direction of travel, and 18.6
     * behind it whenever `projectileOrigin`'s reachability trace has refused the
     * barrel. Both go to zero when the point is read off the gun in the frame
     * that draws it. See D-164.
     *
     * A list rather than {@link pendingBurst}'s flag, because rays do not
     * collapse the way a flash does: a shotgun raises eleven per pull and each
     * one is its own line. The weapon rides along with the endpoint so a shot
     * fired in the sixteen milliseconds before a weapon switch still draws its
     * own beam rather than the new gun's -- the muzzle it comes off is then the
     * wrong gun's by a few units, which is the lesser of the two wrongs and the
     * rarer.
     */
    private readonly pendingTrails: { weapon: string; endQ3: [number, number, number] }[] = [];

    /** `WP_*` ids whose model or hands tag the bundle does not have. */
    readonly unmodelled: string[] = [];

    /**
     * @param shadows what the muzzle flash asks before it casts, exactly as the
     *     world's own flashes ask in `Effects`. Defaults to the answer given
     *     before there was a setting, so a test that only wants the mesh half of
     *     this class is unaffected.
     */
    constructor(ecd: EcsDataset, library: ModelLibrary, shadows: ShadowPolicy = NO_SHADOWS) {
        this.ecd = ecd;
        this.library = library;
        this.shadows = shadows;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(ShadedGeometry)) {
            ecd.registerComponentType(ShadedGeometry);
        }
        if (!ecd.isComponentTypeRegistered(Light)) ecd.registerComponentType(Light);
    }

    /**
     * Place the gun for this frame.
     *
     * `camera` is the renderer's own camera pose -- see {@link CameraPose},
     * which is the whole of what makes this correct. Where in the tick this is
     * called does not matter, and that is the point: the pose is only written by
     * `CameraSystem3`, inside `entityManager.update`, so it is already settled
     * by the time any application handler runs.
     */
    update(camera: CameraPose, deltaSeconds: number, state: ViewWeaponState): void {
        this.timeSeconds += deltaSeconds;
        if (this.flashSeconds > 0) this.flashSeconds -= deltaSeconds;

        const wanted = state.visible ? this.acquire(state.weapon) : null;

        /*
         Placed before it is shown, rather than after. A weapon that has been put
         away still carries the pose it was last drawn at, and one that has never
         been drawn carries none at all, so showing first hands
         `ShadedGeometrySystem3.link` -- which copies the transform onto its
         `Mesh` as its final act -- either a stale pose or the world origin, and
         then corrects it on the next transform signal. Nothing renders in
         between, so this is one redundant placement saved rather than a frame
         with the gun in the wrong place; the reason to write it this way is that
         the other order is only correct by accident of when the tick runs.
        */
        if (wanted !== null) {
            const sway = weaponSway(state.speed, state.bobCycle, this.timeSeconds);

            placeViewWeapon(camera, wanted.offset, sway, scratchPosition, scratchRotation);

            /*
             Once per frame, whether this weapon has a barrel or not.

             The latch belongs to the player, so it has to keep running while
             you are holding one of the eight guns that is a single model --
             otherwise switching to the chaingun mid-burst would find its rotor
             at rest, and Q3's would not be. Advancing it costs two
             multiplications on a weapon that will not read the result.
            */
            const barrelRoll =
                barrelSpinAngle(this.spin, this.timeSeconds * 1000, state.firing) * DEG_TO_RAD;

            for (let i = 0; i < wanted.transforms.length; i++) {
                const transform = wanted.transforms[i]!;
                const attachment = wanted.attachments[i]!;

                if (attachment === null) {
                    transform.position.set(
                        scratchPosition.x,
                        scratchPosition.y,
                        scratchPosition.z
                    );
                    transform.rotation.copy(scratchRotation);
                    continue;
                }

                /*
                 The barrel, on the gun the gun is on. Written from the same
                 `scratchPosition`/`scratchRotation` the body was, so it inherits
                 the sway and the hands offset for free and cannot lag them by a
                 frame -- which is the failure mode of parenting it to something
                 that is itself written later in the tick.
                */
                placeOnTag(
                    scratchPosition,
                    scratchRotation,
                    attachment,
                    transform.position,
                    transform.rotation,
                    barrelRoll
                );
            }

            /*
             And the muzzle itself, once, for everything that comes out of it.

             `scratchPosition`/`scratchRotation` are this frame's exactly when
             `wanted` is non-null, which is this branch -- so this is the only
             place the tag can be carried into the world, and the three consumers
             below read the answer rather than each recomputing it.
            */
            this.worldMuzzle(wanted.muzzle, scratchMuzzle);
        }

        /*
         The flash, on the barrel it came out of, for every frame of its life.

         Placed rather than fired-and-forgotten because a light left at the point
         the trigger was pulled is a light the player runs away from: fifty
         milliseconds at Q3's run speed is half a metre, and a machinegun leaves
         ten of those a second strung out behind a strafing player. Q3 has the
         same answer for the same reason -- `CG_AddPlayerWeapon` re-adds the
         dlight at `tag_flash` on every frame the flash is up.
        */
        if (wanted !== null && this.flashSeconds > 0) {
            this.lightFlash();

            // And the particles, once per shot, at the muzzle the light just
            // moved to -- see `pendingBurst` for why they are not raised from
            // `flash` itself.
            if (this.pendingBurst) {
                this.pendingBurst = false;
                this.burstFlash(state.weapon);
            }
        } else {
            this.douseFlash();

            // A shot whose gun left the screen before it could be drawn. Dropped
            // rather than kept, because the muzzle it would be measured from no
            // longer exists.
            this.pendingBurst = false;
        }

        /*
         The beams, from the same muzzle, on their own condition.

         Not folded into the branch above, because a beam is not the flash: it
         only wants a gun to have been drawn, where the light additionally wants
         to still be lit. The two lifetimes are set independently -- the flash is
         `MUZZLE_FLASH_SECONDS` and the beam is a per-weapon row in `Effects` --
         and a beam that quietly stopped being drawn when somebody shortened the
         flash would be the kind of coupling nothing reports.
        */
        if (wanted !== null) this.drawTrails();
        else this.pendingTrails.length = 0;

        if (wanted !== this.current) {
            this.show(this.current, false);
            this.show(wanted, true);

            this.current = wanted;
            this.currentName = wanted === null ? '' : state.weapon;
        }
    }

    /**
     * Light `weapon`'s muzzle, if that weapon is the one on screen.
     *
     * Called from the shot rather than from the frame, so it is the only part of
     * this class the simulation reaches: `Arena` offers every muzzle flash to
     * the gun first and falls back to a light in the world when the answer is
     * no. Answering honestly is what makes that fallback correct -- a player who
     * is dead, or holding a weapon the bundle has no model for, has no gun on
     * screen to hang a light on and would otherwise fire with no flash at all.
     *
     * **Those are now the only two refusals, and there used to be a third**: a
     * weapon whose model ships no `tag_flash` declined and was lit on the view
     * axis instead. A drawn gun has a front whether or not anybody marked it,
     * and {@link muzzleOffset} finds one -- see D-158.
     *
     * @returns whether the gun took it.
     */
    flash(weapon: string): boolean {
        if (this.current === null || this.currentName !== weapon) return false;

        this.flashSeconds = MUZZLE_FLASH_SECONDS;
        this.pendingBurst = true;

        /*
         Re-pointed per shot rather than per weapon, because the weapon in hand
         is not the only thing that can change under a kept component: the
         shadow setting is a row in the menu, and this light is created once and
         then lives for the rest of the map. `Effects` asks the same question at
         the same moment for the same reason.
        */
        applyMuzzleFlash(this.flashLight, weapon, this.shadows.casts('effect'));

        return true;
    }

    /**
     * Take a hitscan ray's beam onto the gun, if that weapon is the one on screen.
     *
     * The same offer {@link flash} is, refused on the same two conditions and
     * for the same reason -- and the reason is stronger here, because a beam has
     * a *visible origin* where a light only has a centre. `Arena` draws the line
     * in the world when the answer is no.
     *
     * **And on a third, which the flash has no equivalent of**: a session that
     * has not been handed a {@link trails} sink. The light is this class's own
     * and a missing particle sink costs a shot its burst and nothing else, but a
     * beam is drawn entirely by `Effects`, so accepting one with nowhere to send
     * it would take the local player's beams away altogether rather than moving
     * them. Refusing is what puts them back in the world.
     *
     * **What this is worth is the difference between two answers to one
     * question.** `WeaponSystem` computes "where is the gun" from the eye at the
     * end of the fixed step, the rest pose of the model, and a trace that
     * refuses the barrel when anything is in front of it. This class computes it
     * from the pose the *frame* is drawn with -- eye blended across the step
     * (D-081), angles live off the mouse (D-155), bob and view kick included,
     * sway included, no trace -- and it is that gun the player is looking at.
     * Measured at a run, the first is 3.8 Q3 units ahead of the second in the
     * direction of travel, which is the report D-164 came in as, and 18.6 units
     * behind it on the 43% of shots whose reachability trace failed.
     *
     * Only the endpoint is kept: the near end is not knowable yet. See
     * {@link pendingTrails}.
     *
     * @returns whether the gun took it.
     */
    hitscanTrail(weapon: string, endQ3: ArrayLike<number>): boolean {
        if (this.trails === null) return false;
        if (this.current === null || this.currentName !== weapon) return false;

        this.pendingTrails.push({ weapon, endQ3: [endQ3[0]!, endQ3[1]!, endQ3[2]!] });

        return true;
    }

    /** Which weapon is on screen, or `''`. For the load log and the tests. */
    get drawnWeapon(): string {
        return this.currentName;
    }

    /** Whether the muzzle flash is in the scene. For the tests. */
    get flashLit(): boolean {
        return this.lit;
    }

    /**
     * Pieces built across every weapon held so far, in the scene or not.
     *
     * A count of what has been paid for rather than of what is on screen: one
     * weapon is drawn at a time, and the rest are entities waiting to be handed
     * their geometry back.
     */
    get pieceCount(): number {
        let n = 0;
        for (const drawn of this.drawn.values()) n += drawn.geometries.length;
        return n;
    }

    /**
     * Put a weapon in the scene, or take it out of it.
     *
     * By the component's membership of its entity, because that is the only
     * thing Shade reads -- see the note at the top of the file. Guarded on
     * `drawn.visible` because the dataset is not indifferent to being told
     * twice: `addComponentToEntity` asserts when the entity already has one, and
     * `removeComponentFromEntity` warns when it does not.
     */
    private show(drawn: DrawnWeapon | null, visible: boolean): void {
        if (drawn === null || drawn.visible === visible) return;

        drawn.visible = visible;

        for (let i = 0; i < drawn.geometries.length; i++) {
            const entity = drawn.entities[i]!;

            if (visible) this.ecd.addComponentToEntity(entity, drawn.geometries[i]!);
            else this.ecd.removeComponentFromEntity(entity, ShadedGeometry);
        }
    }

    /**
     * Carry a point on the drawn model into world space.
     *
     * Which is `CG_PositionRotatedEntityOnTag` with the rotation already done:
     * the gun's own transform maps model space onto the world, so the tag rides
     * it like any other point on the mesh -- scaled, turned by the view and the
     * sway, and offset to the eye.
     *
     * `scratchPosition`/`scratchRotation` are the caller's problem: they hold
     * this frame's gun only inside the branch of `update` that wrote them.
     */
    private worldMuzzle(offsetQ3: readonly [number, number, number], out: Vector3): void {
        scratchFlash.set(
            offsetQ3[0]! * WORLD_SCALE,
            offsetQ3[1]! * WORLD_SCALE,
            offsetQ3[2]! * WORLD_SCALE
        );
        scratchFlash.applyQuaternion(scratchRotation);

        out.set(
            scratchPosition.x + scratchFlash.x,
            scratchPosition.y + scratchFlash.y,
            scratchPosition.z + scratchFlash.z
        );
    }

    /**
     * Put the flash on the muzzle {@link worldMuzzle} found for this frame.
     */
    private lightFlash(): void {
        this.flashTransform.position.set(scratchMuzzle.x, scratchMuzzle.y, scratchMuzzle.z);

        if (this.lit) return;

        if (this.flashEntity < 0) {
            const builder = new Entity().add(this.flashTransform);
            builder.build(this.ecd);
            this.flashEntity = builder.id;
        }

        this.ecd.addComponentToEntity(this.flashEntity, this.flashLight);
        this.lit = true;
    }

    /**
     * Throw this shot's particles out of the barrel, in world space.
     *
     * Reads the muzzle from `flashTransform`, which {@link lightFlash} has just
     * written this frame, and the direction from `scratchRotation`, which is the
     * gun's own pose -- a converted model points +x down its length, which is
     * the whole of what `MODEL_TO_VIEW` is about.
     *
     * `weapon` is the one being *drawn this frame*, not `currentName`, which is
     * still last frame's until `update` finishes. They differ only when the
     * player switches weapons inside the sixteen milliseconds between the shot
     * and the frame that spends it -- and in that case the muzzle this is about
     * to measure belongs to the new gun, so the colour should too. Q3 lands the
     * same way: `CG_AddPlayerWeapon` draws whatever is in hand against
     * `cent->muzzleFlashTime`, which does not remember what fired.
     */
    private burstFlash(weapon: string): void {
        if (this.particles === null) return;

        scratchForward.set(1, 0, 0).applyQuaternion(scratchRotation);

        this.particles.muzzleFlashParticles(
            [
                this.flashTransform.position.x,
                this.flashTransform.position.y,
                this.flashTransform.position.z,
            ],
            [scratchForward.x, scratchForward.y, scratchForward.z],
            weapon
        );
    }

    /**
     * Draw every ray fired since the last frame, from this frame's muzzle.
     *
     * The list is emptied whether or not anything drew them, which is the same
     * rule {@link pendingBurst} follows: a beam is a thing that happened at a
     * moment, and one held over to the next frame would be drawn from a muzzle
     * that has moved on.
     */
    private drawTrails(): void {
        // Non-null for anything that reached the list: {@link hitscanTrail}
        // refuses a shot it has nowhere to send. Read once all the same, because
        // the field is public and the shot arrived a frame ago.
        const sink = this.trails;

        for (const pending of this.pendingTrails) {
            sink?.hitscanTrailFromGun(
                pending.weapon,
                [scratchMuzzle.x, scratchMuzzle.y, scratchMuzzle.z],
                pending.endQ3
            );
        }

        this.pendingTrails.length = 0;
    }

    /** Take it back out of the scene. Idempotent, and called far more often. */
    private douseFlash(): void {
        if (!this.lit) return;

        this.ecd.removeComponentFromEntity(this.flashEntity, Light);
        this.lit = false;
    }

    /** Build a weapon's entities on the first frame it is held, then keep them. */
    private acquire(weapon: string): DrawnWeapon | null {
        const existing = this.drawn.get(weapon);
        if (existing !== undefined) return existing;

        const world = weaponItemByTag(weapon)?.models[0];
        const offset = world === undefined ? null : handOffset(this.library, weapon);
        const components = world === undefined ? null : this.library.components(world);
        /*
         Where the flash goes on this gun. Not allowed to be missing any more:
         every weapon OA ships carries a `tag_flash` except the gauntlet, which
         has a `tag_barrel` where its blade goes, and the prox launcher, whose
         model carries no tags at all and is measured instead. Only a weapon with
         no *model* declines now, and it declines for want of a gun rather than
         for want of a tag -- see `muzzleOffset` and D-158.

         The light for all thirteen is still a *divergence*, and this used to say
         it was roughly what Q3 does. It is not: `CG_AddPlayerWeapon` returns on
         `if (!flash.hModel)` before it reaches the dlight, so Q3 gives these two
         no muzzle light at all. The port lights them because a shot with no
         light reads as a shot that did not happen (D-115), and the flash's
         visible half is gated on the C's own test instead -- see
         `hasFlashModel`.
        */
        const muzzle = world === undefined ? null : muzzleOffset(this.library, world);

        // `world === undefined` is already covered by `components === null`, and
        // is spelled out so the barrel lookup below has a path to pass it. So is
        // `muzzle === null`, which needs a model to be missing to happen at all.
        if (
            world === undefined ||
            offset === null ||
            components === null ||
            components.length === 0 ||
            muzzle === null
        ) {
            if (!this.unmodelled.includes(weapon)) this.unmodelled.push(weapon);
            return null;
        }

        const transforms: Transform[] = [];
        const geometries: ShadedGeometry[] = [];
        const entities: number[] = [];
        const attachments: (TagAttachment | null)[] = [];

        /*
         The barrel, which for five of the thirteen weapons is the front of the
         gun and lives in its own file -- `CG_RegisterWeapon` registers it
         separately and `CG_AddPlayerWeapon` hangs it off `tag_barrel`. Null for
         the other eight, which are one model and carry no such tag.
        */
        const barrel = barrelAttachment(this.library, world);
        const barrelComponents = barrel === null ? null : this.library.components(barrel.model);

        const pieces: [ShadedGeometry, TagAttachment | null][] = components.map((g) => [g, null]);
        if (barrel !== null && barrelComponents !== null) {
            for (const g of barrelComponents) pieces.push([g, barrel]);
        }

        for (const [geometry, attachment] of pieces) {
            // Position and rotation are both written every frame; this is the
            // case the flag exists for, exactly as in `ItemsView`.
            geometry.setFlag(ShadedGeometryFlags.DeferredBoundsUpdate);
            /*
             `RF_FIRST_PERSON`, the half of it that matters: the gun is not in
             the shadow pass. A view model half a metre from the eye otherwise
             throws its own shadow across the scene every time a light is behind
             the player.
            */
            geometry.clearFlag(ShadedGeometryFlags.CastShadow);

            const transform = new Transform();
            transform.scale.set(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

            /*
             Built without its geometry, and handed it by `show` a few lines
             later, once `update` has placed the transform. A weapon is acquired
             on the frame it is first selected, so building it drawn would put the
             model at the world origin for the rest of that call.
            */
            const builder = new Entity().add(transform);
            builder.build(this.ecd);

            transforms.push(transform);
            geometries.push(geometry);
            entities.push(builder.id);
            attachments.push(attachment);
        }

        const drawn: DrawnWeapon = {
            transforms,
            geometries,
            entities,
            attachments,
            offset,
            muzzle,
            visible: false,
        };
        this.drawn.set(weapon, drawn);

        return drawn;
    }
}
