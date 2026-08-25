/*
 * items-view.test.ts -- `CG_Item`'s presentation: the spin, the bob, and being gone.
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
 * Written because a pickup that had been collected stayed on screen, and sat
 * there not moving, and the two looked like separate bugs. They were one:
 * `ItemsView` hid a collected item by clearing `ShadedGeometryFlags.Visible`,
 * which is documented as *"If set to false will not render"* and is read by
 * nothing in the engine (BUG-10), so the mesh stayed in the scene -- and because
 * `update` skips the spin for an item that is not `present`, the mesh that
 * should have vanished froze instead.
 *
 * Neither half was visible to `items.test.ts`, which tests the simulation and is
 * right not to know about meshes, and neither was visible to a screenshot,
 * because a stationary pickup on a shelf looks like a pickup on a shelf. So this
 * asserts the thing in between: what the *view* does to the scene graph when the
 * simulation says an item has gone.
 *
 * A bare `EntityComponentDataset` and stub geometry, no engine boot -- the same
 * arrangement `first-person.test.ts` uses, for the same reason.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';

import { ItemsView } from '../src/client/ItemsView.ts';
import { itemByClassname, type ItemInstance } from '../src/game/Items.ts';

/** Corrective type for `traverseEntities`; see the note in `first-person.test.ts`. */
type Traverse = (classes: unknown[], visitor: (geometry: ShadedGeometry) => void) => void;

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

function transformsIn(ecd: EntityComponentDataset): Transform[] {
    const out: Transform[] = [];
    (ecd.traverseEntities as unknown as Traverse & { length: number })(
        [Transform],
        (t) => {
            out.push(t as unknown as Transform);
        }
    );
    return out;
}

/**
 * A model library with no models in it.
 *
 * `ItemsView` asks for `ShadedGeometry` instances and then only ever sets flags
 * and writes transforms, so bare components are the whole of what it needs. That
 * they carry no geometry is the point: this is a test about entity membership,
 * not about triangles.
 */
function stubLibrary(piecesPerModel: number) {
    return {
        components(_name: string): ShadedGeometry[] | null {
            return Array.from({ length: piecesPerModel }, () => new ShadedGeometry());
        },
    };
}

function instance(classname: string, index = 0): ItemInstance {
    const def = itemByClassname(classname);
    if (def === null || def === undefined) throw new Error(`no item ${classname}`);

    return { index, def, origin: [100, 200, 15], suspended: false, present: true, respawnAt: 0 };
}

describe('a collected pickup leaves the scene', () => {
    /*
     The bug, stated as the thing it broke. `ShadedGeometryFlags.Visible` did not
     hide anything, so this asserts against the mechanism that does: Shade's
     notion of visible is membership, and `ShadedGeometrySystem3` adds its `Mesh`
     in `link` and removes it in `unlink`.
    */
    it('takes the mesh off the entity, and puts it back on respawn', () => {
        const ecd = newDataset();
        const item = instance('item_armor_shard');

        const view = new ItemsView(ecd as never, stubLibrary(2) as never, null);
        view.build([item]);

        const whole = meshCount(ecd);
        expect(whole, 'both pieces of the shard are drawn').toBe(4);

        item.present = false;
        view.update(1);
        expect(meshCount(ecd), 'a collected pickup draws nothing').toBe(0);

        item.present = true;
        view.update(2);
        expect(meshCount(ecd), 'and is whole again when it respawns').toBe(whole);
    });

    it('leaves the entity and its transform in place while hidden', () => {
        const ecd = newDataset();
        const item = instance('item_health');

        const view = new ItemsView(ecd as never, stubLibrary(1) as never, null);
        view.build([item]);
        view.update(1);

        const before = transformsIn(ecd).map((t) => `${t.position.x},${t.position.z}`);

        item.present = false;
        view.update(2);

        expect(
            transformsIn(ecd).map((t) => `${t.position.x},${t.position.z}`),
            'the item comes back where it was, not at the origin'
        ).toEqual(before);
    });

    it('does not thrash the scene while nothing changes', () => {
        const ecd = newDataset();
        const item = instance('item_armor_shard');

        const view = new ItemsView(ecd as never, stubLibrary(2) as never, null);
        view.build([item]);

        for (let i = 0; i < 10; i++) view.update(i * 0.1);
        expect(meshCount(ecd)).toBe(4);

        item.present = false;
        for (let i = 0; i < 10; i++) view.update(2 + i * 0.1);
        expect(meshCount(ecd)).toBe(0);
    });
});

describe('a pickup that is there spins and bobs', () => {
    /*
     `cg.autoAngles`: a full turn every 2048 ms. Asserted as a *period* rather
     than as a yaw at some instant, because the period is the thing Q3 fixes and
     a yaw is whatever the clock happens to be.
    */
    it('turns once every 2048 ms', () => {
        const ecd = newDataset();
        const item = instance('item_armor_shard');

        const view = new ItemsView(ecd as never, stubLibrary(1) as never, null);
        view.build([item]);

        const transform = transformsIn(ecd)[0]!;

        view.update(0);
        const start = transform.rotation.y;

        view.update(2.048);
        expect(transform.rotation.y, 'back where it started after one period').toBeCloseTo(start, 5);

        view.update(1.024);
        expect(transform.rotation.y, 'and half a turn away at half of one').not.toBeCloseTo(start, 3);
    });

    it('turns twice as fast for health, as Q3 does', () => {
        const ecd = newDataset();
        const health = instance('item_health');

        const view = new ItemsView(ecd as never, stubLibrary(1) as never, null);
        view.build([health]);

        const transform = transformsIn(ecd)[0]!;

        view.update(0);
        const start = transform.rotation.y;

        view.update(1.024);
        expect(transform.rotation.y).toBeCloseTo(start, 5);
    });

    it('bobs, and two pickups do not bob in unison', () => {
        const ecd = newDataset();
        const a = instance('item_armor_shard', 0);
        const b = instance('item_armor_shard', 1);

        const view = new ItemsView(ecd as never, stubLibrary(1) as never, null);
        view.build([a, b]);

        /*
         One transform per model, and a shard is two models -- the body and the
         shell OA does not ship. So the second *item* starts at index 2, and
         reading 0 and 1 would compare a pickup with itself.
        */
        const perItem = a.def.models.length;
        const all = transformsIn(ecd);
        const ta = all[0]!;
        const tb = all[perItem]!;

        view.update(0);
        const first = ta.position.y;

        view.update(0.5);
        expect(ta.position.y, 'the height moves').not.toBeCloseTo(first, 5);

        /*
         `scale = 0.005 + cent->currentState.number * 0.00001`: the per-entity
         term is what stops a shelf of pickups pulsing together, and it is small
         enough that only a long interval separates them.
        */
        view.update(30);
        expect(ta.position.y, 'and the two are out of phase').not.toBeCloseTo(tb.position.y, 5);
    });
});
