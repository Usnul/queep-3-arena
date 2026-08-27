/*
 * convex-contact.test.ts -- meep reports a contact between shapes that are not touching.
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
 * The engine finding `Missiles`' confirming sweep exists for, reduced to two
 * shapes and a gap.
 *
 * A rocket fired down a clear corridor on `oa_dm1` detonated in mid-air, 18
 * units in front of the muzzle. The cause has nothing to do with the map: meep
 * dispatches `PhysicsEvents.ContactBegin` between a sphere and a
 * `ConvexHullShape3D` that are demonstrably *not* touching, and hands it a
 * **positive** `depth` equal to the gap -- where `ManifoldStore`'s own layout
 * comment says `depth (positive = penetration, negative = speculative gap)`. So
 * neither the event nor its payload distinguishes a hit from a near miss.
 *
 * **The same box built as a `BoxShape3D` reports nothing**, and that is what
 * points at the cause. `sphere_box_contact` is a closed form and can answer
 * "separated"; a convex hull has no such pair routine and falls through to
 * GJK + EPA, and EPA run on a simplex that does not enclose the origin returns a
 * plausible axis and the separation as a depth. The engine already knows this
 * about EPA -- `convex_convex_manifold`'s header records that it "returns a
 * non-minimal, non-scaling axis for polytopes (a 0.05 m overlap reports ~0.8 m
 * depth)" and routes hull-vs-hull around it with SAT. The sphere-vs-hull pair
 * has no such route.
 *
 * It is the shape *class* and not the data: the box below is built from eight
 * exact vertices, not from a BSP brush. And it moves with where the sphere sits
 * over the face -- centred, nothing is reported; 198 units to one side, a
 * contact -- which is what a simplex-quality problem looks like and is not what
 * a wrong collider looks like.
 *
 * It matters to this port because every brush in every level is a
 * `ConvexHullShape3D` and a missile is a sphere, so the false band is a
 * centimetre of clear air around every surface in the game.
 *
 * The numbers are asserted rather than described because a fix could take two
 * shapes: no contact at all (the box's behaviour), or the same contact with a
 * negative depth. Either would be enough for `Missiles`, and either should make
 * this file fail and be read.
 */

import { describe, expect, it } from 'vitest';

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { ColliderObserverSystem } from '@woosh/meep-engine/src/engine/physics/ecs/ColliderObserverSystem.js';
import { PhysicsEvents } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsEvents.js';
import { BoxShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/BoxShape3D.js';
import { SphereShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';


/** Scene metres per Q3 unit, so the gaps below read in the units the port uses. */
const WORLD_SCALE = 1 / 32;

/** The half-extents of `oa_dm1`'s brush 163 -- the slab this was found against. */
const HALF_X = 568 * WORLD_SCALE;
const HALF_Y = 256 * WORLD_SCALE;
const HALF_Z = 16 * WORLD_SCALE;

/** A missile's collision sphere, as `Missiles` builds it. */
const RADIUS = 0.5 * WORLD_SCALE;

/**
 * Where over the face the sphere sits, in Q3 units.
 *
 * It matters, which is itself part of the finding: directly above the slab's
 * centre nothing is reported, and this is where the rocket actually was. GJK
 * picks its support vertices by direction, so a sphere over the middle of a
 * large face and one over a corner of it hand EPA different simplices.
 */
const OVER_X = -198;
const OVER_Y = 64;

async function bareWorld(): Promise<{ em: EntityManager; ecd: EntityComponentDataset }> {
    const em = new EntityManager();
    const ecd = new EntityComponentDataset();
    em.attachDataset(ecd);

    const system = new PhysicsSystem();
    /*
     `addSystem` is declared to take `System<any>`, whose `link` takes two
     arguments, so no real engine system is assignable to it. GAP-013's shape.
    */
    const registry = em as unknown as { addSystem(system: unknown): Promise<unknown> };
    await registry.addSystem(system);
    await registry.addSystem(new ColliderObserverSystem(system));

    await new Promise<void>((resolve, reject) => {
        em.startup(resolve, reject);
    });

    // Nothing here should fall; the gap under test is the only variable.
    system.setGravity({ x: 0, y: 0, z: 0 } as never);

    return { em, ecd };
}

function place(
    ecd: EntityComponentDataset,
    kind: number,
    shape: unknown,
    x: number,
    y: number,
    z: number
): number {
    const transform = new Transform();
    transform.position.set(x, y, z);

    const rigidBody = new RigidBody();
    rigidBody.kind = kind;
    rigidBody.mass = 1;
    rigidBody.gravityScale = 0;

    const collider = new Collider() as unknown as { shape: unknown };
    collider.shape = shape;

    const builder = new Entity();
    builder.add(transform).add(rigidBody).add(collider as unknown as Collider).build(ecd);

    return builder.id;
}

/** The same box, as eight exact vertices and twelve outward-CCW triangles. */
function boxAsHull(): unknown {
    const vertices = new Float32Array([
        -HALF_X, -HALF_Y, -HALF_Z,
        HALF_X, -HALF_Y, -HALF_Z,
        HALF_X, HALF_Y, -HALF_Z,
        -HALF_X, HALF_Y, -HALF_Z,
        -HALF_X, -HALF_Y, HALF_Z,
        HALF_X, -HALF_Y, HALF_Z,
        HALF_X, HALF_Y, HALF_Z,
        -HALF_X, HALF_Y, HALF_Z,
    ]);

    const indices = new Uint32Array([
        0, 2, 1, 0, 3, 2,
        4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,
        1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
    ]);

    return ConvexHullShape3D.from(vertices, indices);
}

/**
 * Put a stationary sphere `gapQ3` units clear of the slab's +z face, run one
 * step, and return the depth of any contact reported -- or null for none.
 */
async function contactDepth(
    shape: unknown,
    gapQ3: number,
    overX = OVER_X,
    overY = OVER_Y
): Promise<number | null> {
    const { em, ecd } = await bareWorld();

    place(ecd, BodyKind.Static, shape, 0, 0, 0);

    const sphere = place(
        ecd,
        BodyKind.Dynamic,
        SphereShape3D.from(RADIUS),
        overX * WORLD_SCALE,
        overY * WORLD_SCALE,
        HALF_Z + RADIUS + gapQ3 * WORLD_SCALE
    );

    let depth: number | null = null;
    ecd.addEntityEventListener(
        sphere,
        PhysicsEvents.ContactBegin,
        ((payload: { depth: number }): void => {
            depth = payload.depth;
        }) as never
    );

    em.update(em.fixedUpdateStepSize);

    return depth;
}

describe('a sphere near a slab it never touches', () => {
    it('reports nothing against a BoxShape3D, at every gap', async () => {
        const box = (): unknown => BoxShape3D.from(HALF_X, HALF_Y, HALF_Z);

        for (const gap of [0.05, 0.1, 0.2, 0.3, 0.4, 1, 2]) {
            expect(
                await contactDepth(box(), gap),
                `BoxShape3D reported a contact across a ${gap} unit gap`
            ).toBeNull();
        }
    });

    it('reports one against the identical ConvexHullShape3D, inside 0.01 m', async () => {
        for (const gap of [0.05, 0.1, 0.2, 0.3]) {
            const depth = await contactDepth(boxAsHull(), gap);

            expect(depth, `no contact across a ${gap} unit gap; the threshold moved`).not.toBeNull();

            /*
             And the depth is the gap. A contact reported for a pair 0.3 units
             apart, carrying +0.3 units of "penetration", is indistinguishable
             from a real 0.3-unit overlap -- which is why `Missiles` cannot
             filter these on the payload and confirms with a sweep instead.
            */
            expect(depth! / WORLD_SCALE).toBeCloseTo(gap, 1);
        }
    });

    it('stops past 0.01 m, which is where the threshold sits', async () => {
        for (const gap of [0.4, 0.5, 1, 2]) {
            expect(
                await contactDepth(boxAsHull(), gap),
                `ConvexHullShape3D reported a contact across a ${gap} unit gap`
            ).toBeNull();
        }
    });

    it('depends on where over the face the sphere sits, which is the tell', async () => {
        /*
         Directly above the slab's centre, nothing is reported at any gap; the
         same sphere 198 units to one side reports one. GJK chooses its support
         vertices by direction, so those two placements hand EPA different
         simplices out of the same pair of shapes -- and a bug that moves with
         the simplex rather than with the geometry is a bug in the fallback, not
         in the collider.
        */
        for (const gap of [0.05, 0.1, 0.2, 0.3]) {
            expect(
                await contactDepth(boxAsHull(), gap, 0, 0),
                `centred over the face, a ${gap} unit gap now reports a contact`
            ).toBeNull();
        }
    });
});
