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

/** What `Arena` needs of this class, so it can hand a flash to the gun. */
export interface MuzzleFlashSink {
    flash(weapon: string): boolean;
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
}

/** One arch of the sine per 128 cycle units; `bobCycle` wraps at 256. */
export const BOB_HALF = 128;

/**
 * `cg.bobfracsin`: `fabs(sin((bobCycle & 127) / 127.0 * M_PI))`.
 *
 * One arch per half-cycle, zero at each end of it. What that arch is a function
 * of is the correction in D-081 and is worth stating where the reader is:
 * `ps->bobCycle` is a **clock**, advanced by `bobmove * msec` in `PM_Footsteps`,
 * so a stride takes 320 ms at a run whatever the player's speed. Sprinting does
 * not bob you faster, it moves you further per bob. Reconstructing this from
 * distance travelled -- which is what the first version of the view weapon did
 * -- runs at better than twice the rate at Q3's own run speed, and what reads as
 * a bob at 3 Hz reads as a shiver at 7.
 *
 * The `127` rather than `128` is the C's and is kept: it means the arch peaks a
 * hair past halfway and never quite returns to zero at the top of the byte.
 */
export function bobFracSin(bobCycle: number): number {
    return Math.abs(Math.sin(((bobCycle & 127) / 127) * Math.PI));
}

/** `cg.bobcycle & 1`: flips every arch, so left and right lean apart. */
export function bobOddCycle(bobCycle: number): boolean {
    return (bobCycle & BOB_HALF) !== 0;
}

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
 */
const MODEL_TO_VIEW = new Quaternion()._fromAxisAngle(0, 1, 0, -Math.PI / 2);

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
    readonly offset: readonly [number, number, number];
    /**
     * `tag_flash` in the model's own axes, Q3 units, or null for a weapon that
     * ships none -- the gauntlet, and OA's prox launcher.
     *
     * Not permuted the way {@link handOffset} permutes `tag_weapon`, and for a
     * reason: the hands tag is an offset *from the eye* and has to be expressed
     * in the camera's frame, while this one is a point *on the model* and is
     * carried into the world by the model's own rotation, which already contains
     * `MODEL_TO_VIEW`. Permuting it as well would apply that turn twice.
     */
    readonly flash: readonly [number, number, number] | null;
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

export class ViewWeapon implements MuzzleFlashSink {
    private readonly ecd: EcsDataset;
    private readonly library: ModelLibrary;
    private readonly shadows: ShadowPolicy;
    private readonly drawn = new Map<string, DrawnWeapon>();

    private timeSeconds = 0;

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

            for (const transform of wanted.transforms) {
                transform.position.set(scratchPosition.x, scratchPosition.y, scratchPosition.z);
                transform.rotation.copy(scratchRotation);
            }
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
        if (wanted !== null && wanted.flash !== null && this.flashSeconds > 0) {
            // `scratchPosition`/`scratchRotation` are this frame's: they are
            // written exactly when `wanted` is non-null, which is this branch.
            this.lightFlash(wanted.flash);
        } else {
            this.douseFlash();
        }

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
     * is dead, holding a weapon the bundle has no model for, or holding one that
     * ships no `tag_flash` has nothing to hang a light on, and would otherwise
     * fire with no flash at all.
     *
     * @returns whether the gun took it.
     */
    flash(weapon: string): boolean {
        if (this.current === null || this.currentName !== weapon) return false;
        if (this.current.flash === null) return false;

        this.flashSeconds = MUZZLE_FLASH_SECONDS;

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
     * Put the flash on the model's `tag_flash`, in world space.
     *
     * Which is `CG_PositionRotatedEntityOnTag` with the rotation already done:
     * the gun's own transform maps model space onto the world, so the tag rides
     * it like any other point on the mesh -- scaled, turned by the view and the
     * sway, and offset to the eye.
     */
    private lightFlash(offsetQ3: readonly [number, number, number]): void {
        scratchFlash.set(
            offsetQ3[0]! * WORLD_SCALE,
            offsetQ3[1]! * WORLD_SCALE,
            offsetQ3[2]! * WORLD_SCALE
        );
        scratchFlash.applyQuaternion(scratchRotation);

        this.flashTransform.position.set(
            scratchPosition.x + scratchFlash.x,
            scratchPosition.y + scratchFlash.y,
            scratchPosition.z + scratchFlash.z
        );

        if (this.lit) return;

        if (this.flashEntity < 0) {
            const builder = new Entity().add(this.flashTransform);
            builder.build(this.ecd);
            this.flashEntity = builder.id;
        }

        this.ecd.addComponentToEntity(this.flashEntity, this.flashLight);
        this.lit = true;
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
         `tag_flash`, and unlike the other two it is allowed to be missing. Every
         weapon OA ships carries one except the gauntlet -- which has no muzzle
         to flash -- and the prox launcher, whose model has no tags at all. Both
         fall back to a light at the shot's own origin, which is roughly where Q3
         puts the gauntlet's anyway.
        */
        const flash = world === undefined ? null : flashOffset(this.library, world);

        if (offset === null || components === null || components.length === 0) {
            if (!this.unmodelled.includes(weapon)) this.unmodelled.push(weapon);
            return null;
        }

        const transforms: Transform[] = [];
        const geometries: ShadedGeometry[] = [];
        const entities: number[] = [];

        for (const geometry of components) {
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
        }

        const drawn: DrawnWeapon = {
            transforms,
            geometries,
            entities,
            offset,
            flash,
            visible: false,
        };
        this.drawn.set(weapon, drawn);

        return drawn;
    }
}
