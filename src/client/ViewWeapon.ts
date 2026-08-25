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

import type { ModelLibrary } from './map/loadModels.ts';
import { weaponItemByTag } from '../game/Items.ts';

const WORLD_SCALE = 1 / 32;

/** `CG_RegisterWeapon`'s fallback when a weapon ships no hands model. */
const FALLBACK_HANDS = 'models/weapons2/shotgun/shotgun_hand.md3';

/** The tag `CG_AddPlayerWeapon` hangs the weapon off. */
const TAG_WEAPON = 'tag_weapon';

const DEG_TO_RAD = Math.PI / 180;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
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
    readonly offset: readonly [number, number, number];
}

const scratchPosition = new Vector3();
const scratchRotation = new Quaternion();

export class ViewWeapon {
    private readonly ecd: EcsDataset;
    private readonly library: ModelLibrary;
    private readonly drawn = new Map<string, DrawnWeapon>();

    private timeSeconds = 0;

    private current: DrawnWeapon | null = null;
    private currentName = '';

    /** `WP_*` ids whose model or hands tag the bundle does not have. */
    readonly unmodelled: string[] = [];

    constructor(ecd: EcsDataset, library: ModelLibrary) {
        this.ecd = ecd;
        this.library = library;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(ShadedGeometry)) {
            ecd.registerComponentType(ShadedGeometry);
        }
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

        const wanted = state.visible ? this.acquire(state.weapon) : null;

        if (wanted !== this.current) {
            this.show(this.current, false);
            this.show(wanted, true);

            this.current = wanted;
            this.currentName = wanted === null ? '' : state.weapon;
        }

        if (wanted === null) return;

        const sway = weaponSway(state.speed, state.bobCycle, this.timeSeconds);

        placeViewWeapon(camera, wanted.offset, sway, scratchPosition, scratchRotation);

        for (const transform of wanted.transforms) {
            transform.position.set(scratchPosition.x, scratchPosition.y, scratchPosition.z);
            transform.rotation.copy(scratchRotation);
        }
    }

    /** Which weapon is on screen, or `''`. For the load log and the tests. */
    get drawnWeapon(): string {
        return this.currentName;
    }

    /** Total drawn pieces across every weapon built so far. */
    get pieceCount(): number {
        let n = 0;
        for (const drawn of this.drawn.values()) n += drawn.geometries.length;
        return n;
    }

    private show(drawn: DrawnWeapon | null, visible: boolean): void {
        if (drawn === null) return;

        for (const geometry of drawn.geometries) {
            geometry.writeFlag(ShadedGeometryFlags.Visible, visible);
        }
    }

    /** Build a weapon's entities on the first frame it is held, then keep them. */
    private acquire(weapon: string): DrawnWeapon | null {
        const existing = this.drawn.get(weapon);
        if (existing !== undefined) return existing;

        const world = weaponItemByTag(weapon)?.models[0];
        const offset = world === undefined ? null : handOffset(this.library, weapon);
        const components = world === undefined ? null : this.library.components(world);

        if (offset === null || components === null || components.length === 0) {
            if (!this.unmodelled.includes(weapon)) this.unmodelled.push(weapon);
            return null;
        }

        const transforms: Transform[] = [];
        const geometries: ShadedGeometry[] = [];

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
            geometry.clearFlag(ShadedGeometryFlags.Visible);

            const transform = new Transform();
            transform.scale.set(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

            new Entity().add(transform).add(geometry).build(this.ecd);

            transforms.push(transform);
            geometries.push(geometry);
        }

        const drawn: DrawnWeapon = { transforms, geometries, offset };
        this.drawn.set(weapon, drawn);

        return drawn;
    }
}
