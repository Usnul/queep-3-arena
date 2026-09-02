/*
 * hitscan-trail.test.ts -- the beam starts on the gun the player is looking at.
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
 * Written for D-164, and the report it came in as was "the lightning gun's
 * tracer does not connect to the barrel -- it leads the weapon in the direction
 * you are moving".
 *
 * It did, and the offset was not one bug. `WeaponSystem` answered "where is the
 * barrel" from the eye at the end of the fixed step, the model's rest pose, and
 * a reachability trace in front of it; the gun on screen is drawn from the pose
 * the *frame* uses -- eye blended across the step (D-081), angles live off the
 * mouse (D-155), bob, view kick and sway all included, and no trace anywhere.
 * Every one of those five is a displacement between the beam and the gun, and
 * measured in the running game at a hard run they came to 3.8 Q3 units of lead
 * in the direction of travel, or 18.6 units *behind* the muzzle on the 43% of
 * shots whose reachability trace refused the barrel and fell back to
 * `CalcMuzzlePoint`.
 *
 * So the fix is not an adjustment to any of the five: it is that the beam's near
 * end is read off the gun, in the frame that draws it, the way the muzzle flash
 * light and its particle burst already are. `first-person.test.ts` owns what a
 * beam *is* -- its width, its colour, its fade, its two ends -- and this file
 * owns where it starts and who decides.
 *
 * A bare `EntityComponentDataset` and a stub bundle, no engine boot, in the
 * shape `muzzle-flash.test.ts` established for the same class.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Trail3D from '@woosh/meep-engine/src/engine/graphics/ecs/trail3d/Trail3D.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';

import { ViewWeapon, type CameraPose, type ViewWeaponState } from '../src/client/ViewWeapon.ts';
import { Arena } from '../src/client/Arena.ts';
import type { WeaponId } from '../src/game/Weapons.ts';

/** Scene units per Q3 unit. */
const S = 1 / 32;

/** A shooter's forward, which every muzzle flash event carries. Q3's +x. */
const FORWARD: readonly [number, number, number] = [1, 0, 0];

/** `roster.ts` hands 0 to the player and `2000 +` to bots. */
const LOCAL = 0;
const A_BOT = 2003;

/* ------------------------------------------------------------------ *
 * The stub bundle
 *
 * Shaped like the real one and rounded so the arithmetic can be read off an
 * assertion: OA's hands tag puts the gun forward, down and to the right of the
 * eye, and `tag_flash` is most of the way down the barrel.
 * ------------------------------------------------------------------ */

const HAND_TAG = [8, -4, 12] as const;

/** `tag_flash` per world model: x forward, y up, z right, model axes. */
const FLASH_TAGS: Readonly<Record<string, readonly number[]>> = {
    'models/weapons2/lightning/lightning.md3': [24, 2, 0],
    'models/weapons2/machinegun/machinegun.md3': [18, 1, 0],
    'models/weapons2/shotgun/shotgun.md3': [20, 2, 0],
};

const NO_BOUNDS = { mins: [0, 0, 0], maxs: [0, 0, 0] };

function stubLibrary() {
    return {
        definition(name: string) {
            if (name.endsWith('_hand.md3')) {
                return { ...NO_BOUNDS, tags: [{ name: 'tag_weapon', origin: HAND_TAG }] };
            }

            const flash = FLASH_TAGS[name];
            if (flash === undefined) return null;

            return { ...NO_BOUNDS, tags: [{ name: 'tag_flash', origin: flash }] };
        },
        components(name: string): ShadedGeometry[] | null {
            if (FLASH_TAGS[name] === undefined) return null;
            return [new ShadedGeometry()];
        },
    };
}

/* ------------------------------------------------------------------ *
 * Reading the scene back
 * ------------------------------------------------------------------ */

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([]);
    return ecd;
}

/** Looking straight down the camera's own +Z, from `eye`. */
function pose(eye: readonly [number, number, number]): CameraPose {
    return { position: { x: eye[0], y: eye[1], z: eye[2] }, rotation: new Quaternion() };
}

function held(weapon: string, visible = true): ViewWeaponState {
    return { weapon, speed: 0, bobCycle: 0, visible, firing: false };
}

type Traverse = (classes: unknown[], visitor: (...found: never[]) => void) => void;

/** Every straight beam in the scene. A stroke is two knots; see `first-person`. */
function beamsIn(ecd: EntityComponentDataset): Trail3D[] {
    const found: Trail3D[] = [];
    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    traverse([Trail3D, Transform], ((trail: Trail3D) => {
        if (trail.tube!.getCount() === 2) found.push(trail);
    }) as never);

    return found;
}

function onlyBeam(ecd: EntityComponentDataset): Trail3D {
    const beams = beamsIn(ecd);
    expect(beams.length, 'expected exactly one beam').toBe(1);
    return beams[0]!;
}

/** A knot's world position, as `[x, y, z]`. */
function knot(trail: Trail3D, index: number): [number, number, number] {
    const out = [0, 0, 0];
    trail.tube!.getKnotPosition(out, index);
    return [out[0]!, out[1]!, out[2]!];
}

/** Where the one muzzle flash light is, which is `tag_flash` in world space. */
function flashPoint(ecd: EntityComponentDataset): [number, number, number] {
    const found: [number, number, number][] = [];
    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse;

    traverse([Light, Transform], ((_light: Light, transform: Transform) => {
        found.push([transform.position.x, transform.position.y, transform.position.z]);
    }) as never);

    expect(found.length, 'exactly one flash light').toBe(1);
    return found[0]!;
}

/* ------------------------------------------------------------------ *
 * The rig
 * ------------------------------------------------------------------ */

interface Rig {
    readonly ecd: EntityComponentDataset;
    readonly view: ViewWeapon;
    readonly arena: Arena;
}

/** An arena with no map behind it; nothing on these paths asks the clipmap. */
function rig(weapon: string): Rig {
    const ecd = newDataset();
    const view = new ViewWeapon(ecd as never, stubLibrary() as never);
    const arena = new Arena(ecd as never, {} as never);

    arena.viewWeapon = view;
    view.trails = arena.effects;

    // One frame, so there is a gun on screen for the shot to be offered to.
    view.update(pose([0, 0, 0]), 0.016, held(weapon));

    return { ecd, view, arena };
}

/**
 * One shot, as the game raises it: a flash and a ray, in that order.
 *
 * `startQ3` is deliberately absurd -- a hundred units down Q3's +x, which is
 * nowhere near the eye this gun is drawn at -- because it is the quantity the
 * fix is about. Anything that reads it will be visible from a metre away.
 */
function fire(arena: Arena, weapon: WeaponId, owner: number, endQ3: number[]): void {
    arena.muzzleFlash([100, 0, 0], FORWARD, weapon, owner);
    arena.hitscanTrail([100, 0, 0], endQ3, weapon, owner);
}

/* ------------------------------------------------------------------ *
 * The complaint
 * ------------------------------------------------------------------ */

describe('the beam starts on the gun that fired it', () => {
    it('puts its near end on `tag_flash`, exactly where the flash light is', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        fire(arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));

        const near = knot(onlyBeam(ecd), 0);
        const flash = flashPoint(ecd);

        /*
         The same point, not a nearby one -- and the same assertion the burst
         gets in `muzzle-flash.test.ts`, for the same reason. All three effects
         this class raises come off one `tag_flash`, carried into the world once
         per frame, so any two of them agreeing to nine places is the check that
         they still share it.

         Six places rather than more because a knot is stored as a `float32` in
         the tube's vertex buffer and the light's transform is not, so the two
         separate at the eighth: half a micron of agreement between a mesh and a
         lamp is agreement.
        */
        expect(near[0]).toBeCloseTo(flash[0], 6);
        expect(near[1]).toBeCloseTo(flash[1], 6);
        expect(near[2]).toBeCloseTo(flash[2], 6);

        // And nowhere near the point the simulation offered, which is what the
        // beam used to be drawn from.
        expect(Math.hypot(near[0] - 100 * S, near[1], near[2])).toBeGreaterThan(2);
    });

    /**
     * The regression, as the one number that was wrong.
     *
     * The shot is raised from the fixed step and the gun is placed from the
     * rendered frame, so between the two the camera moves -- by up to a whole
     * step of travel at the interpolation alone (D-081), which at Q3's run speed
     * is 5.3 units and is the lead the report described. A beam measured in the
     * frame that draws it moves with the gun exactly, and "exactly" is testable:
     * two runs identical but for where the camera ends up must differ by the
     * camera's own displacement and by nothing else.
     */
    it('is measured in the frame that draws it, not the frame that fired', () => {
        const still = rig('WP_LIGHTNING');
        fire(still.arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);
        still.view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));

        const moved = rig('WP_LIGHTNING');
        fire(moved.arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);
        // A step of Q3 run speed, in the camera's own +Z, between the shot and
        // the frame that spends it.
        moved.view.update(pose([0, 0, 5.33 * S]), 0.016, held('WP_LIGHTNING'));

        const a = knot(onlyBeam(still.ecd), 0);
        const b = knot(onlyBeam(moved.ecd), 0);

        // `float32` knots again; see above.
        expect(b[0] - a[0]).toBeCloseTo(0, 6);
        expect(b[1] - a[1]).toBeCloseTo(0, 6);
        expect(b[2] - a[2], 'the near end did not follow the gun').toBeCloseTo(5.33 * S, 6);
    });

    it('leaves the far end where the ray stopped', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        fire(arena, 'WP_LIGHTNING', LOCAL, [640, 128, 64]);
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));

        // Q3 (x, y, z) -> meep (x, z, -y), scaled. The impact is a world point
        // and nothing on screen has an opinion about it.
        const far = knot(onlyBeam(ecd), 1);

        expect(far[0]).toBeCloseTo(640 * S, 6);
        expect(far[1]).toBeCloseTo(64 * S, 6);
        expect(far[2]).toBeCloseTo(-128 * S, 6);
    });

    it('draws it once, and not once more in the world', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        /*
         Both halves go to the gun or neither does. `Arena` offers the beam first
         and only falls through on a refusal, so a shot the gun accepted must
         leave no world beam behind -- otherwise every shot draws two, one of
         them starting in mid-air in front of your face.
        */
        fire(arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);
        expect(beamsIn(ecd).length, 'drawn before a gun had been placed for it').toBe(0);

        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));
        expect(beamsIn(ecd).length).toBe(1);
    });

    it('draws one per ray, because a shotgun raises eleven', () => {
        const { ecd, view, arena } = rig('WP_MACHINEGUN');

        // Two rays inside one rendered frame, which a chaingun at 30 ms between
        // rounds can genuinely do. They are two lines and do not collapse the
        // way the flash does.
        fire(arena, 'WP_MACHINEGUN', LOCAL, [700, 0, 0]);
        arena.hitscanTrail([100, 0, 0], [700, 64, 0], 'WP_MACHINEGUN', LOCAL);

        view.update(pose([0, 0, 0]), 0.016, held('WP_MACHINEGUN'));

        expect(beamsIn(ecd).length).toBe(2);
    });

    it('draws nothing for a weapon whose row is not in the table', () => {
        const { ecd, view, arena } = rig('WP_SHOTGUN');

        // Eleven pellets out of one barrel is a cage rather than a shot, and Q3
        // draws none of them either. The gun still takes the offer; `Effects` is
        // what decides there is no line.
        fire(arena, 'WP_SHOTGUN', LOCAL, [700, 0, 0]);
        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        expect(beamsIn(ecd).length).toBe(0);
    });

    it('drops a beam whose gun left the screen before it could be drawn', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        // Shot and killed inside the same frame boundary. Dropped rather than
        // kept, because the muzzle it would be measured from no longer exists --
        // the rule the burst follows, and for the same reason.
        fire(arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING', false));
        expect(beamsIn(ecd).length).toBe(0);

        // And it does not turn up late, when the gun comes back.
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));
        expect(beamsIn(ecd).length).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * Whose beam it is
 * ------------------------------------------------------------------ */

describe('everyone without a gun on screen keeps the beam the world draws', () => {
    it('draws a bot\'s beam from the point the simulation gave, at once', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        fire(arena, 'WP_LIGHTNING', A_BOT, [700, 0, 0]);

        // Nothing draws a bot's weapon model, so there is no `tag_flash` to
        // measure and nothing to wait for a frame for.
        const near = knot(onlyBeam(ecd), 0);

        expect(near[0]).toBeCloseTo(100 * S, 9);
        expect(near[1]).toBeCloseTo(0, 9);
        expect(near[2]).toBeCloseTo(0, 9);

        // And the gun is holding nothing back that a later frame would draw.
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));
        expect(beamsIn(ecd).length).toBe(1);
    });

    it('does the same for the player between dying and respawning', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        // No gun for a corpse, which is `ViewWeapon`'s second refusal and the
        // same one the flash light gets.
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING', false));

        fire(arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);

        expect(knot(onlyBeam(ecd), 0)[0]).toBeCloseTo(100 * S, 9);
    });

    it('does the same for a session that was never handed a beam sink', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);
        const arena = new Arena(ecd as never, {} as never);

        arena.viewWeapon = view;
        // `trails` is null until `main.ts` sets it. A gun that took the beam
        // anyway would swallow it: `Effects` is what draws one, and this class
        // has no other way to reach it.
        view.update(pose([0, 0, 0]), 0.016, held('WP_LIGHTNING'));

        fire(arena, 'WP_LIGHTNING', LOCAL, [700, 0, 0]);

        expect(knot(onlyBeam(ecd), 0)[0]).toBeCloseTo(100 * S, 6);
    });

    it('does the same for a weapon the bundle has no model for', () => {
        const { ecd, view, arena } = rig('WP_LIGHTNING');

        // The stub has no gauntlet, so `acquire` declines and there is no gun on
        // screen even though the player is alive and holding one.
        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));

        fire(arena, 'WP_MACHINEGUN', LOCAL, [700, 0, 0]);

        expect(knot(onlyBeam(ecd), 0)[0]).toBeCloseTo(100 * S, 9);
    });
});
