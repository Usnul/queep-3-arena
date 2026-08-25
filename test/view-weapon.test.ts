/*
 * view-weapon.test.ts -- what switching weapons does to the scene graph.
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
 * Written because the weapon you switched away from stayed in the world, hanging
 * at the pose it was last drawn at, and snapped back into your hands when you
 * selected it again. `ViewWeapon` put a weapon away by clearing
 * `ShadedGeometryFlags.Visible`, which is documented as *"If set to false will
 * not render"* and is read by nothing in the engine (BUG-10) -- the same dead
 * flag `ItemsView` was built on, found a second time in the file nobody thought
 * to re-check (D-088).
 *
 * `first-person.test.ts` owns the arithmetic -- the hands tag, the barrel
 * direction, the sway -- and it passed throughout, because every number the gun
 * is placed with was right. What was wrong was which entities carried a mesh,
 * which is a different question and gets its own file, alongside
 * `items-view.test.ts` for the same reason.
 *
 * A bare `EntityComponentDataset` and stub geometry, no engine boot.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';

import { ViewWeapon, type CameraPose, type ViewWeaponState } from '../src/client/ViewWeapon.ts';
import { weaponItemByTag } from '../src/game/Items.ts';

/** Corrective type for `traverseEntities`; see the note in `first-person.test.ts`. */
type Traverse = (classes: unknown[], visitor: (component: never) => void) => void;

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([Transform, ShadedGeometry]);
    return ecd;
}

/** Meshes currently attached to an entity, which is what Shade draws. */
function meshCount(ecd: EntityComponentDataset): number {
    let n = 0;
    (ecd.traverseEntities as unknown as Traverse)([ShadedGeometry], () => {
        n += 1;
    });
    return n;
}

/**
 * Pieces per model, chosen so two weapons cannot be mistaken for each other.
 *
 * A count is the only thing this test can read, so a rocket launcher left behind
 * next to a shotgun has to be arithmetically distinguishable from a shotgun on
 * its own -- otherwise the assertion that used to fail would pass.
 */
const PIECES: Readonly<Record<string, number>> = {
    'models/weapons2/shotgun/shotgun.md3': 2,
    'models/weapons2/rocketl/rocketl.md3': 3,
    'models/weapons2/gauntlet/gauntlet.md3': 5,
};

function piecesOf(weapon: string): number {
    return PIECES[weaponItemByTag(weapon)!.models[0]!]!;
}

/**
 * A model library with no models in it.
 *
 * `ViewWeapon` asks for a `tag_weapon` and for `ShadedGeometry` instances, and
 * then only ever writes transforms; bare components are the whole of what it
 * needs. That they carry no triangles is the point -- this is a test about
 * entity membership.
 */
function stubLibrary() {
    return {
        definition(name: string) {
            if (!name.endsWith('_hand.md3')) return null;
            return { tags: [{ name: 'tag_weapon', origin: [8, -4, 12] }] };
        },
        components(name: string): ShadedGeometry[] | null {
            const count = PIECES[name];
            if (count === undefined) return null;
            return Array.from({ length: count }, () => new ShadedGeometry());
        },
    };
}

function pose(eye: [number, number, number]): CameraPose {
    return { position: { x: eye[0], y: eye[1], z: eye[2] }, rotation: new Quaternion() };
}

function held(weapon: string, visible = true): ViewWeaponState {
    return { weapon, speed: 0, bobCycle: 0, visible };
}

/** The scene, as positions: one entry per mesh that is actually in it. */
function meshPositions(ecd: EntityComponentDataset): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];

    const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
        classes: unknown[],
        visitor: (geometry: ShadedGeometry, transform: Transform) => void
    ) => void;

    traverse([ShadedGeometry, Transform], (_geometry, transform) => {
        out.push({ x: transform.position.x, y: transform.position.y, z: transform.position.z });
    });

    return out;
}

describe('the weapon you switch away from leaves the world', () => {
    /*
     The bug, stated as the thing it broke. Q3's own `cg.weaponSelect` swap is
     one model out and one model in; what shipped was one model in and one model
     abandoned wherever the player happened to be standing.
    */
    it('draws the weapon in hand and nothing else', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(meshCount(ecd), 'the shotgun, whole').toBe(piecesOf('WP_SHOTGUN'));

        view.update(pose([1, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(
            meshCount(ecd),
            'the launcher only -- the shotgun is not still lying where it was'
        ).toBe(piecesOf('WP_ROCKET_LAUNCHER'));

        view.update(pose([2, 0, 0]), 0.016, held('WP_GAUNTLET'));
        expect(meshCount(ecd)).toBe(piecesOf('WP_GAUNTLET'));

        expect(view.drawnWeapon).toBe('WP_GAUNTLET');
    });

    it('keeps the entities, so a weapon is built once however often you cycle', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        const order = ['WP_SHOTGUN', 'WP_ROCKET_LAUNCHER', 'WP_SHOTGUN', 'WP_GAUNTLET'];
        for (const weapon of order) view.update(pose([0, 0, 0]), 0.016, held(weapon));

        // Three distinct weapons ever held, built once each and kept.
        const built =
            piecesOf('WP_SHOTGUN') + piecesOf('WP_ROCKET_LAUNCHER') + piecesOf('WP_GAUNTLET');
        expect(view.pieceCount, 'every weapon held so far is still built').toBe(built);

        // ...but only the one in hand is in the scene.
        expect(meshCount(ecd)).toBe(piecesOf('WP_GAUNTLET'));
    });

    /*
     The second half of the report: "when I switch back to that weapon it gets
     teleported into my hand". It was the same defect -- the abandoned model was
     on screen at a stale pose, so re-selecting it read as a teleport rather than
     as a weapon being drawn. Pinned as an ordering property, because that is
     what makes it impossible for the mesh to be seen anywhere but in the hand:
     `update` places a weapon *before* it hands it to the scene.
    */
    it('is already in the hand on the frame it re-enters the scene', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        const addedAt: { x: number; y: number; z: number }[] = [];
        const add = ecd.addComponentToEntity.bind(ecd);

        (ecd as unknown as Record<string, unknown>).addComponentToEntity = (
            entity: number,
            component: unknown
        ): void => {
            /*
             Meshes only. `Entity.build` routes through this method too, so the
             `Transform` that carries the pose arrives by the same door -- and it
             arrives first, with nothing to read it off yet.
            */
            if (component instanceof ShadedGeometry) {
                const transform = ecd.getComponent(entity, Transform) as Transform;
                addedAt.push({
                    x: transform.position.x,
                    y: transform.position.y,
                    z: transform.position.z,
                });
            }

            add(entity, component);
        };

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        view.update(pose([10, 20, 30]), 0.016, held('WP_ROCKET_LAUNCHER'));

        addedAt.length = 0;

        // Back to the shotgun, from somewhere a long way from where it was left.
        view.update(pose([-40, 5, 60]), 0.016, held('WP_SHOTGUN'));

        expect(addedAt.length, 'every piece of the shotgun re-enters').toBe(
            piecesOf('WP_SHOTGUN')
        );

        const inHand = meshPositions(ecd);
        for (const [i, at] of addedAt.entries()) {
            expect(at.x, `piece ${i} enters at this frame's pose, not the last one`).toBeCloseTo(
                inHand[0]!.x,
                6
            );
            expect(at.y).toBeCloseTo(inHand[0]!.y, 6);
            expect(at.z).toBeCloseTo(inHand[0]!.z, 6);
        }

        // And it is where the eye is now, not where the eye was when it was put away.
        expect(inHand[0]!.x).toBeLessThan(-30);
    });

    it('does not touch the scene while the same weapon stays in hand', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        let churn = 0;
        const add = ecd.addComponentToEntity.bind(ecd);
        const remove = ecd.removeComponentFromEntity.bind(ecd);

        const patched = ecd as unknown as Record<string, unknown>;
        patched.addComponentToEntity = (entity: number, component: unknown): void => {
            if (component instanceof ShadedGeometry) churn += 1;
            add(entity, component);
        };
        patched.removeComponentFromEntity = (entity: number, klass: unknown): void => {
            if (klass === ShadedGeometry) churn += 1;
            remove(entity, klass);
        };

        for (let i = 0; i < 30; i++) view.update(pose([i, 0, 0]), 0.016, held('WP_SHOTGUN'));

        expect(churn, 'a held weapon is added once and left alone').toBe(0);
        expect(meshCount(ecd)).toBe(piecesOf('WP_SHOTGUN'));
    });
});

describe('a player with no gun to show has none in the scene', () => {
    /*
     `visible: false` is the corpse and the noclip camera. It went through the
     same dead flag, so a dead player's gun hung in the air at the spot they died
     until they respawned and it flew back to them.
    */
    it('takes the gun off screen when the player is dead, and gives it back', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(meshCount(ecd)).toBe(piecesOf('WP_ROCKET_LAUNCHER'));

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER', false));
        expect(meshCount(ecd), 'no gun for a corpse').toBe(0);
        expect(view.drawnWeapon).toBe('');

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(meshCount(ecd), 'and it is back on respawn').toBe(
            piecesOf('WP_ROCKET_LAUNCHER')
        );
    });

    it('stays out of the scene for as long as it is hidden', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        for (let i = 0; i < 20; i++) {
            view.update(pose([i, 0, 0]), 0.016, held('WP_SHOTGUN', false));
        }

        expect(meshCount(ecd)).toBe(0);
    });

    /*
     A weapon the bundle has no model for draws nothing and must not leave the
     previous one behind either -- the null branch is the one that used to run
     `show(current, false)` against the dead flag and then return.
    */
    it('draws nothing for a weapon with no model, and keeps nothing from before', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        view.update(pose([0, 0, 0]), 0.016, held('WP_RAILGUN'));

        expect(meshCount(ecd)).toBe(0);
        expect(view.drawnWeapon).toBe('');
        expect(view.unmodelled).toEqual(['WP_RAILGUN']);
    });
});
