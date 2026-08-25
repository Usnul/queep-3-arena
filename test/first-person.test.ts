/*
 * first-person.test.ts -- the three things only the player's own eyes see.
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
 * A crosshair, a gun and the marks a gun leaves. All three shipped as "done" in
 * phase 4 and none of them were on screen, which is the finding this file
 * exists to make impossible to repeat: two of the three did not exist at all,
 * and the third -- the decals -- was written, wired, retired on a cap, counted
 * in the report, and rejected on the GPU by a sign.
 *
 * That last one is the reason the assertions here are about *orientation and
 * pixels* rather than about entities existing. A decal entity with a `Decal`, a
 * `Transform` and a loaded texture is indistinguishable from a working decal
 * from the CPU side; what separated them was the direction of one axis, and a
 * test that counted entities would have passed throughout.
 *
 * Q3's own numbers are asserted against the C wherever there are numbers --
 * `CG_GetColorForHealth`'s thresholds, `CG_CalculateWeaponPosition`'s inversion
 * on alternate steps, `tag_weapon`'s offset -- because "it looks about right"
 * is what got the previous version through review.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Decal } from '@woosh/meep-engine/src/engine/graphics/ecs/decal/v2/Decal.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

import { Effects } from '../src/client/Effects.ts';
import { ModelLibrary } from '../src/client/map/loadModels.ts';
import type { ModelBundle } from '../src/client/map/SceneBundle.ts';
import {
    bobFracSin,
    bobOddCycle,
    handOffset,
    placeViewWeapon,
    weaponSway,
} from '../src/client/ViewWeapon.ts';
import { Footsteps } from '../src/client/Audio.ts';
import { orientToQ3Angles } from '../src/client/PlayerController.ts';
import {
    crosshairColor,
    crosshairScale,
    crosshairTexture,
    ITEM_BLOB_SECONDS,
    NUM_CROSSHAIRS,
} from '../src/client/crosshair.ts';
import { CROSSHAIR_DEFAULT } from '../src/client/Hud.ts';
import balance from '../src/game/balance.generated.json' with { type: 'json' };

const BUILT = join(process.cwd(), 'assets', 'built');

/** Scene units per Q3 unit, as every other module in the port spells it. */
const WORLD_SCALE = 1 / 32;

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Q3 (Z-up, units) -> meep (Y-up), direction only. */
function dirToMeep(q3: readonly number[]): [number, number, number] {
    return [q3[0]!, q3[2]!, -q3[1]!];
}

/**
 * meep's own decal fade, transcribed from `chunk_decal_surface_frame`.
 *
 * The decal's *outward* direction is `-axis_z` -- a decal projects along its own
 * +Z into the surface -- and the composite skips any decal whose fade reaches
 * zero. Reproduced here rather than gestured at, because the whole class of bug
 * this file guards is "the shader's convention and ours disagree".
 */
function decalFade(transform: Transform, faceNormalMeep: readonly number[]): number {
    const m = transform.matrix;

    // column-major: column 2 is the local +Z axis in world space
    const len = Math.hypot(m[8]!, m[9]!, m[10]!);
    const outward = [-m[8]! / len, -m[9]! / len, -m[10]! / len];

    const dot =
        outward[0]! * faceNormalMeep[0]! +
        outward[1]! * faceNormalMeep[1]! +
        outward[2]! * faceNormalMeep[2]!;

    const t = Math.min(1, Math.max(0, (dot - 0.35) / (0.6 - 0.35)));
    return t * t * (3 - 2 * t);
}

/**
 * Where a world point lands in a decal's own box, which the composite tests
 * against +/-0.5 before doing anything else.
 */
function decalLocal(transform: Transform, worldMeep: readonly number[]): [number, number, number] {
    const m = transform.matrix;

    const dx = worldMeep[0]! - m[12]!;
    const dy = worldMeep[1]! - m[13]!;
    const dz = worldMeep[2]! - m[14]!;

    // The columns are orthogonal and uniformly scaled, so the inverse of the
    // rotation-and-scale part is a projection onto each column over its length
    // squared.
    const out: number[] = [];
    for (let c = 0; c < 3; c++) {
        const x = m[c * 4]!;
        const y = m[c * 4 + 1]!;
        const z = m[c * 4 + 2]!;
        out.push((dx * x + dy * y + dz * z) / (x * x + y * y + z * z));
    }

    return [out[0]!, out[1]!, out[2]!];
}

function newDataset(): EntityComponentDataset {
    // `setComponentTypeMap` wants the *list* of classes despite the name, and
    // `Effects` registers what it needs; an empty one is the correct start.
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([]);
    return ecd;
}

interface DecalRecord {
    readonly decal: Decal;
    readonly transform: Transform;
}

/**
 * Corrective type for `traverseEntities`.
 *
 * The visitor is documented as receiving one component per requested class and
 * emits as `(...args: any[][]) => boolean` -- the generator read `@param
 * {...*} components` as an array of the array type. Narrowed here rather than
 * cast to `any`, per the same rule `Hud.ts` follows for `LabelView`. GAP-001.
 */
type Traverse = (
    classes: unknown[],
    visitor: (decal: Decal, transform: Transform) => void
) => void;

function decalsIn(ecd: EntityComponentDataset): DecalRecord[] {
    const found: DecalRecord[] = [];

    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    traverse([Decal, Transform], (decal, transform) => {
        found.push({ decal, transform });
    });

    return found;
}

/* ------------------------------------------------------------------ *
 * Decals
 * ------------------------------------------------------------------ */

describe('an impact mark is a projector aimed into the surface', () => {
    /*
     Every orientation a Q3 surface can have, plus the two poles the look
     rotation has to special-case. The bug this replaces failed on all of them
     equally -- it was a sign, not an edge case -- but a fix that works on floors
     and not on walls is the more likely next mistake.
    */
    const NORMALS: readonly (readonly [number, number, number])[] = [
        [0, 0, 1],
        [0, 0, -1],
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0.577, 0.577, 0.577],
        [0.6, -0.8, 0],
    ];

    it('faces every surface it is placed on, rather than away from it', () => {
        for (const normal of NORMALS) {
            const ecd = newDataset();
            new Effects(ecd).bulletImpact([100, 200, 300], normal);

            const marks = decalsIn(ecd);
            expect(marks.length, `one mark for normal ${normal.join(',')}`).toBe(1);

            const fade = decalFade(marks[0]!.transform, dirToMeep(normal));

            /*
             Not "greater than zero": the fade is a `smoothstep(0.35, 0.6)` on
             the dot, so a projector 60 degrees off would still score above zero
             and draw a smeared, faint mark. A mark placed on the surface it was
             traced against is square-on by construction and must be 1.
            */
            expect(fade, `fade for normal ${normal.join(',')}`).toBe(1);
        }
    });

    it('encloses the point it was placed at, so there is something to paint', () => {
        for (const normal of NORMALS) {
            const ecd = newDataset();
            new Effects(ecd).bulletImpact([100, 200, 300], normal);

            const local = decalLocal(marksOf(ecd), [
                100 * WORLD_SCALE,
                300 * WORLD_SCALE,
                -200 * WORLD_SCALE,
            ]);

            for (const axis of local) {
                expect(Math.abs(axis)).toBeLessThan(0.5);
            }
        }
    });

    it('is `CG_MissileHitWall`\'s size, and its box is twice the radius across', () => {
        const ecd = newDataset();
        new Effects(ecd).bulletImpact([0, 0, 0], [0, 0, 1]);

        const transform = marksOf(ecd);

        // radius 8 for WP_MACHINEGUN, so 16 units across, so half a metre.
        expect(transform.scale.x).toBeCloseTo(16 * WORLD_SCALE, 6);
        expect(transform.scale.y).toBeCloseTo(16 * WORLD_SCALE, 6);
        expect(transform.scale.z).toBeCloseTo(16 * WORLD_SCALE, 6);
    });

    it('spins each mark about its own axis, as `CG_ImpactMark` does', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd);

        effects.mark([0, 0, 0], [0, 0, 1], 8, 'mark_bullet', 1, 0);
        effects.mark([0, 0, 0], [0, 0, 1], 8, 'mark_bullet', 1, Math.PI / 3);

        const [a, b] = decalsIn(ecd).map((m) => m.transform.matrix);

        // Same projection axis...
        for (const i of [8, 9, 10]) {
            expect(a![i]!).toBeCloseTo(b![i]!, 6);
        }

        // ...different tangent, or the roll did nothing and every machinegun
        // burst stamps the same image at the same angle.
        const tangentDelta = Math.hypot(a![0]! - b![0]!, a![1]! - b![1]!, a![2]! - b![2]!);
        expect(tangentDelta).toBeGreaterThan(0.1);
    });

    it('scorches the wall a rocket hit, not the floor under it', () => {
        const ecd = newDataset();
        const wall: [number, number, number] = [0, 1, 0];

        new Effects(ecd).explosion([0, 0, 0], 120, wall);

        const marks = decalsIn(ecd);
        expect(marks.length).toBe(1);
        expect(marks[0]!.decal.uri).toContain('mark_burn');
        expect(decalFade(marks[0]!.transform, dirToMeep(wall))).toBe(1);
    });

    it('falls back to Q3 up when a detonation struck no surface at all', () => {
        const ecd = newDataset();
        new Effects(ecd).explosion([0, 0, 0], 120);

        expect(decalFade(marksOf(ecd), dirToMeep([0, 0, 1]))).toBe(1);
    });

    it('retires nothing while under the cap, and everything a mark needs is set', () => {
        const ecd = newDataset();
        const effects = new Effects(ecd);

        for (let i = 0; i < 32; i++) effects.bulletImpact([i, 0, 0], [0, 0, 1]);

        const marks = decalsIn(ecd);
        expect(marks.length).toBe(32);

        for (const mark of marks) {
            expect(mark.decal.albedo_uri).not.toBe('');
            // Alpha is what the composite reads as coverage; a zero would be an
            // invisible mark that every other assertion here still passes.
            expect(mark.decal.color.a).toBeGreaterThan(0);
        }
    });
});

function marksOf(ecd: EntityComponentDataset): Transform {
    const marks = decalsIn(ecd);
    expect(marks.length).toBeGreaterThan(0);
    return marks[marks.length - 1]!.transform;
}

describe('the mark textures are the darkening masks Q3 authored', () => {
    /**
     * `scripts/decals.shader` draws these three with
     * `blendfunc gl_zero gl_one_minus_src_color`, which is `dst * (1 - src)`.
     * Restated for a decal that means black at coverage `luminance(src)`, so the
     * converted image must be black wherever it covers anything.
     *
     * Converted the other way -- colour kept, luminance promoted to alpha, which
     * is right for the *additive* sprites and is what this shared with them --
     * a bullet hole is a white dot and a rocket scorch is a white cloud.
     */
    const DARKENING = ['mark_bullet', 'mark_burn', 'mark_hole'];

    for (const name of DARKENING) {
        it(`${name} paints black, and only where it covers`, async () => {
            const path = join(BUILT, 'fx', `${name}.png`);
            expect(existsSync(path), `${path} exists`).toBe(true);

            const { data } = await sharp(path)
                .raw()
                .ensureAlpha()
                .toBuffer({ resolveWithObject: true });

            let covered = 0;
            let brightest = 0;

            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3]! === 0) continue;

                covered += 1;
                brightest = Math.max(brightest, data[i]!, data[i + 1]!, data[i + 2]!);
            }

            expect(covered, 'texels with any coverage').toBeGreaterThan(0);
            expect(brightest, 'brightest covered texel').toBe(0);
        });

        it(`${name} has coverage that varies, rather than an opaque square`, async () => {
            const { data, info } = await sharp(join(BUILT, 'fx', `${name}.png`))
                .raw()
                .ensureAlpha()
                .toBuffer({ resolveWithObject: true });

            let opaque = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3]! === 255) opaque += 1;
            }

            /*
             The TGAs ship a full-opacity alpha channel and the mark is in the
             *colour*. Copied across unchanged, `mark_burn` is a two-metre black
             square centred on every explosion -- which is a decal that renders,
             and is worse than one that does not.
            */
            expect(opaque / (info.width * info.height)).toBeLessThan(0.5);
        });
    }

    it('leaves the plasma mark alone, because Q3 drew that one with a plain blend', async () => {
        const { data } = await sharp(join(BUILT, 'fx', 'mark_plasma.png'))
            .raw()
            .ensureAlpha()
            .toBuffer({ resolveWithObject: true });

        let brightest = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]! === 0) continue;
            brightest = Math.max(brightest, data[i]!, data[i + 1]!, data[i + 2]!);
        }

        expect(brightest, 'plasma keeps its own colour').toBeGreaterThan(0);
    });
});

/* ------------------------------------------------------------------ *
 * Crosshair
 * ------------------------------------------------------------------ */

describe('the crosshair is Q3\'s, artwork and rules alike', () => {
    it('converts all ten of `gfx/2d/crosshair[a-j]`', () => {
        for (let i = 0; i < NUM_CROSSHAIRS; i++) {
            const url = crosshairTexture(i);
            const path = join(process.cwd(), url.replace(/^\//, ''));

            expect(existsSync(path), `${url} is offered and absent`).toBe(true);
        }
    });

    it('defaults to the one `cg_drawCrosshair 4` selects', () => {
        // `crosshairShader[i] = RegisterShader(va("gfx/2d/crosshair%c", 'a' + i))`,
        // so 4 is 'e' -- a dot, which is not what most people picture and is
        // what id shipped.
        expect(CROSSHAIR_DEFAULT).toBe(4);
        expect(crosshairTexture(CROSSHAIR_DEFAULT)).toContain('crosshaire');
    });

    it('wraps out-of-range selections the way `ca % NUM_CROSSHAIRS` does', () => {
        expect(crosshairTexture(NUM_CROSSHAIRS)).toBe(crosshairTexture(0));
        expect(crosshairTexture(-3)).toBe(crosshairTexture(0));
    });

    it('reproduces `CG_GetColorForHealth` at its own thresholds', () => {
        // Dead is black; the C returns a cleared vector before anything else.
        expect(crosshairColor(0, 0)).toEqual([0, 0, 0]);

        // Full health, no armour: white.
        expect(crosshairColor(100, 0)).toEqual([1, 1, 1]);

        // Below 66 the blue is gone, below 30 the green goes too: red.
        expect(crosshairColor(65, 0)).toEqual([1, 1, 0]);
        expect(crosshairColor(29, 0)).toEqual([1, 0, 0]);

        // The ramps, at their midpoints.
        expect(crosshairColor(45, 0)[1]).toBeCloseTo(0.5, 6);
        expect(crosshairColor(82.5, 0)[2]).toBeCloseTo(0.5, 6);
    });

    it('counts armour only as far as it can absorb', () => {
        /*
         `max = health * ARMOR_PROTECTION / (1 - ARMOR_PROTECTION)`, so 50 health
         is worth at most 97 armour and the 200th point of armour changes
         nothing. Reading it as "armour adds to the pool" would make a crosshair
         on 1 health and 200 armour white.
        */
        expect(crosshairColor(1, 200)).toEqual(crosshairColor(1, 100));
        expect(crosshairColor(1, 200)[1]).toBe(0);

        // ...and under the cap it does count: 50 + 50 clears both ramps.
        expect(crosshairColor(50, 50)).toEqual([1, 1, 1]);
    });

    it('swells for `ITEM_BLOB_TIME` after a pickup and then stops', () => {
        expect(crosshairScale(0)).toBe(1);
        expect(crosshairScale(ITEM_BLOB_SECONDS / 2)).toBeCloseTo(1.5, 6);
        expect(crosshairScale(ITEM_BLOB_SECONDS)).toBe(1);
        expect(crosshairScale(99)).toBe(1);
    });
});

/* ------------------------------------------------------------------ *
 * View weapon
 * ------------------------------------------------------------------ */

function modelLibrary(): ModelLibrary {
    const bundle = JSON.parse(
        readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
    ) as ModelBundle;

    // Geometry is not touched: every assertion below is about `definition`,
    // which reads the manifest.
    return new ModelLibrary(bundle, new Float32Array(0), new Uint32Array(0), []);
}

const WEAPON_TAGS = (balance.items as { type: string; tag: string; models: string[] }[])
    .filter((item) => item.type === 'IT_WEAPON')
    .map((item) => item.tag);

describe('every weapon can be drawn in the player\'s hands', () => {
    it('has a converted world model and a `tag_weapon` to hang it from', () => {
        const library = modelLibrary();

        expect(WEAPON_TAGS.length, 'weapons in the balance table').toBe(13);

        for (const tag of WEAPON_TAGS) {
            const offset = handOffset(library, tag);
            expect(offset, `${tag} resolves no hands tag`).not.toBeNull();

            const world = (balance.items as { tag: string; type: string; models: string[] }[])
                .find((i) => i.type === 'IT_WEAPON' && i.tag === tag)!
                .models[0]!;

            expect(library.definition(world), `${tag} has no model ${world}`).not.toBeNull();
        }
    });

    it('puts the gun forward, down and to the right, as the hands model says', () => {
        const library = modelLibrary();
        const [left, up, forward] = handOffset(library, 'WP_MACHINEGUN')!;

        /*
         `machinegun_hand.md3`'s frame-0 `tag_weapon` is (6.16, -5.83, -7.80) in
         Q3's own view axes -- forward, left, up. So: in front of the eye, to the
         right of it, and below it. A sign error on the middle component is the
         one that survives review, because a gun in the left hand looks
         deliberate.
        */
        expect(forward).toBeCloseTo(6.16, 2);
        expect(left).toBeCloseTo(-5.83, 2);
        expect(up).toBeCloseTo(-7.8, 2);
    });

    it('falls back to the shotgun\'s hands, exactly where `CG_RegisterWeapon` does', () => {
        const library = modelLibrary();

        // The railgun ships no `railgun_hand.md3`; the C answers that with the
        // shotgun's, and the shotgun's is the machinegun's to the digit.
        expect(handOffset(library, 'WP_RAILGUN')).toEqual(handOffset(library, 'WP_SHOTGUN'));
    });
});

describe('the view weapon is placed in the player\'s own frame', () => {
    /** A camera pose for a Q3 view direction, built the way the game builds it. */
    function pose(pitch: number, yaw: number, eye: [number, number, number]) {
        const rotation = new Quaternion();
        orientToQ3Angles([pitch, yaw, 0], rotation);

        return { position: { x: eye[0], y: eye[1], z: eye[2] }, rotation };
    }

    /** Q3 `AngleVectors`, for the direction the assertions are taken against. */
    function q3Forward(pitch: number, yaw: number): [number, number, number] {
        const p = (pitch * Math.PI) / 180;
        const y = (yaw * Math.PI) / 180;

        return [Math.cos(y) * Math.cos(p), Math.sin(y) * Math.cos(p), -Math.sin(p)];
    }

    const NO_SWAY: [number, number, number] = [0, 0, 0];

    it('points the barrel exactly along the view', () => {
        for (const [pitch, yaw] of [[0, 0], [0, 90], [0, -145], [30, 40], [-70, 210]]) {
            const position = new Vector3();
            const rotation = new Quaternion();

            placeViewWeapon(pose(pitch!, yaw!, [0, 0, 0]), [0, 0, 0], NO_SWAY, position, rotation);

            /*
             A converted model's +X is its barrel. Rotated into the world it must
             be the view direction, mapped through the same axis swap -- the
             quarter turn that lines the model's axes up with the camera's is a
             constant with two plausible signs and only one that aims forward.
            */
            const barrel = new Vector3(1, 0, 0);
            barrel.applyQuaternion(rotation);

            const expected = dirToMeep(q3Forward(pitch!, yaw!));

            expect(barrel.x).toBeCloseTo(expected[0], 6);
            expect(barrel.y).toBeCloseTo(expected[1], 6);
            expect(barrel.z).toBeCloseTo(expected[2], 6);
        }
    });

    it('keeps the model upright and its own right hand on the right', () => {
        const position = new Vector3();
        const rotation = new Quaternion();

        placeViewWeapon(pose(0, 0, [0, 0, 0]), [0, 0, 0], NO_SWAY, position, rotation);

        // Facing Q3 +X: up is meep +Y, and Q3's right (0, -1, 0) is meep +Z.
        const up = new Vector3(0, 1, 0);
        up.applyQuaternion(rotation);
        expect(up.x).toBeCloseTo(0, 6);
        expect(up.y).toBeCloseTo(1, 6);
        expect(up.z).toBeCloseTo(0, 6);

        const right = new Vector3(0, 0, 1);
        right.applyQuaternion(rotation);
        expect(right.x).toBeCloseTo(0, 6);
        expect(right.y).toBeCloseTo(0, 6);
        expect(right.z).toBeCloseTo(1, 6);
    });

    it('offsets it from the eye by the hands tag, in the eye\'s own frame', () => {
        const library = modelLibrary();
        const offset = handOffset(library, 'WP_MACHINEGUN')!;

        const eye: [number, number, number] = [3, 2, -1];

        for (const [pitch, yaw] of [[0, 0], [0, 90], [25, -30]]) {
            const position = new Vector3();
            const rotation = new Quaternion();

            placeViewWeapon(pose(pitch!, yaw!, eye), offset, NO_SWAY, position, rotation);

            const delta = [position.x - eye[0], position.y - eye[1], position.z - eye[2]];

            /*
             Resolved back onto Q3's own view axes: the displacement must be
             `tag_weapon` again, in metres, whatever direction the player is
             facing. This is the assertion that would catch a gun that swings
             around the player as they turn, which is what happens if the offset
             is applied in world space.
            */
            const forward = dirToMeep(q3Forward(pitch!, yaw!));
            const rightQ3: [number, number, number] = [
                Math.sin((yaw! * Math.PI) / 180),
                -Math.cos((yaw! * Math.PI) / 180),
                0,
            ];
            const right = dirToMeep(rightQ3);

            const along = delta[0]! * forward[0] + delta[1]! * forward[1] + delta[2]! * forward[2];
            const across = delta[0]! * right[0] + delta[1]! * right[1] + delta[2]! * right[2];

            expect(along, 'in front of the eye').toBeCloseTo(offset[2] * WORLD_SCALE, 6);
            expect(across, 'to the right of it').toBeCloseTo(-offset[0] * WORLD_SCALE, 6);
            expect(position.y - eye[1], 'below it, whatever the pitch').toBeLessThan(0);
        }
    });
});

describe("the gun and the footfall read one counter", () => {
    /*
     `ps->bobCycle` is a clock: `PM_Footsteps` advances it by `bobmove * msec`,
     0.4 running, so 128 units -- one arch, one stride -- take 320 ms whatever
     the player's speed. Both of the numbers below are that, read two ways.
    */
    const RUN_MS_PER_STRIDE = 128 / 0.4;

    it('arches once per 128 units, ending where it began', () => {
        expect(bobFracSin(0)).toBeCloseTo(0, 6);
        expect(bobFracSin(64)).toBeCloseTo(1, 3);
        expect(bobFracSin(128)).toBeCloseTo(0, 6);
        expect(bobFracSin(192)).toBeCloseTo(1, 3);
    });

    it('flips the sway parity on the arch boundary, where the arch is zero', () => {
        expect(bobOddCycle(127)).toBe(false);
        expect(bobOddCycle(128)).toBe(true);
        expect(bobOddCycle(255)).toBe(true);
        expect(bobOddCycle(0)).toBe(false);

        /*
         The two are load-bearing together: Q3 negates the sway's scale on odd
         cycles, so the flip has to land where `fracSin` is zero or the gun steps
         sideways by twice the amplitude twice a stride. A jerk, in other words.
        */
        expect(bobFracSin(128)).toBeCloseTo(0, 6);
    });

    it('inverts the sway between strides, as `cg.bobcycle & 1` does', () => {
        // Sampled at the same instant, so only the bob term differs.
        const even = weaponSway(320, 64, 0.25);
        const odd = weaponSway(320, 192, 0.25);

        expect(even[1]).toBeGreaterThan(odd[1]);
        expect(even[2]).toBeGreaterThan(odd[2]);
        // Pitch is scaled by the unsigned speed and does not invert.
        expect(even[0]).toBeCloseTo(odd[0], 9);
    });

    it('never goes completely still, because the idle drift has no speed gate', () => {
        // Standing: `scale = xyspeed + 40`, and the 40 is the whole point of it.
        const drift = weaponSway(0, 0, Math.PI / 2);

        expect(Math.abs(drift[0])).toBeCloseTo(0.4, 6);
        expect(Math.abs(drift[1])).toBeCloseTo(0.4, 6);
        expect(Math.abs(drift[2])).toBeCloseTo(0.4, 6);
    });

    it('moves the gun no faster than its own slope allows, over a full stride', () => {
        /*
         The bound is derived, not picked. The bob term peaks at `speed * 0.01`
         degrees and crosses its arch in 320 ms, so its steepest slope is
         `3.2 * pi / 0.32 = 31.4 deg/s`; the drift adds `(speed + 40) * 0.01`.
         Over one 8 ms frame that is 0.28 degrees.

         A parity flip landing anywhere but the zero would inject a step of twice
         the amplitude, 6.4 degrees, which is twenty times this bound.
        */
        let cycle = 0;
        let previous = weaponSway(320, cycle, 0);
        let worst = 0;

        for (let t = 8; t <= 1000; t += 8) {
            cycle = Math.trunc(cycle + 0.4 * 8) & 255;
            const next = weaponSway(320, cycle, t / 1000);

            for (let i = 0; i < 3; i++) {
                worst = Math.max(worst, Math.abs(next[i]! - previous[i]!));
            }
            previous = next;
        }

        expect(worst).toBeLessThan(0.4);
    });

    it('fires a footstep at each arch peak, twice per 256 of cycle', () => {
        const footsteps = new Footsteps();
        const events: string[] = [];

        // One second of running, in Q3's own integer milliseconds at 60 fps.
        let cycle = 0;
        for (let frame = 0; frame < 60; frame++) {
            cycle = Math.trunc(cycle + 0.4 * 17) & 255;
            const step = footsteps.update(cycle, true, false);
            if (step !== null) events.push(step);
        }

        /*
         1000 ms over a 320 ms stride is 3.1 strides, and the crossing test fires
         once per stride. The distance-based version this replaces fired 6 to 7
         times over the same second at Q3's run speed -- which is what "the
         footsteps are too frequent" was.
        */
        expect(events.filter((e) => e === 'step').length).toBe(3);
    });

    it('plays no footstep while ducked, though the cycle still runs faster', () => {
        const footsteps = new Footsteps();

        let cycle = 0;
        let steps = 0;
        for (let frame = 0; frame < 60; frame++) {
            // `bobmove = 0.5` ducked, so the crossings come *sooner*...
            cycle = Math.trunc(cycle + 0.5 * 17) & 255;
            if (footsteps.update(cycle, true, true) === 'step') steps += 1;
        }

        // ...and none of them is audible. A crouched player is sneaking.
        expect(steps).toBe(0);
    });

    it('reports a landing once, and not as a footstep', () => {
        const footsteps = new Footsteps();

        expect(footsteps.update(0, true, false)).toBe(null);
        expect(footsteps.update(0, false, false)).toBe(null);
        expect(footsteps.update(0, false, false)).toBe(null);
        expect(footsteps.update(0, true, false)).toBe('land');
        expect(footsteps.update(0, true, false)).toBe(null);
    });

    it('agrees with the cadence the stride length implies', () => {
        // 320 ms a stride at Q3's 320 unit/s run speed is 102 units of ground
        // per step, against the 48 the distance reconstruction assumed.
        expect(RUN_MS_PER_STRIDE).toBe(320);
        expect((320 * RUN_MS_PER_STRIDE) / 1000).toBeCloseTo(102.4, 6);
    });
});
