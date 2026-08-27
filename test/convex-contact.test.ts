/*
 * convex-contact.test.ts -- what a contact against a convex hull does and does not say.
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
 * Two findings about contacts against a `ConvexHullShape3D`, which is what all of
 * this port's level collision and every character's box is made of. Both were
 * found here, both are fixed, and this file is the regression test for each --
 * which is also why it is worth reading before touching either.
 *
 * **Fixed in 3.6.0: a contact reported across clear air.** 3.4.0 and 3.5.0
 * dispatched `PhysicsEvents.ContactBegin` between a sphere and a hull separated
 * by up to 0.01 m, and gave the event a *positive* `depth` equal to the gap --
 * where `ManifoldStore`'s own layout comment says a gap is negative and a
 * positive number is penetration, so neither the event nor its payload
 * distinguished a hit from a near miss. A missile is a sphere, so that was a
 * centimetre of phantom collision around every surface in the game: rockets
 * detonated in mid-air in open corridors.
 *
 * The first three cases are the regression test for that fix, and they assert
 * both halves on purpose -- no contact while the shapes are apart, *and* a
 * contact at the right depth when they really do overlap. The second is not
 * padding: a fix that removed every contact from the convex path would satisfy
 * the first on its own and be far worse than the bug. The third pins the property
 * that identified the cause, that the old behaviour moved with where the sphere
 * sat over the face -- GJK picks its support vertices by direction, so two
 * placements hand EPA different simplices out of the same pair of shapes.
 *
 * **Fixed in 3.8.0: a contact never reported at all.** See the second `describe`.
 * A body that CCD stopped against a hull's *corner* raised nothing, where the
 * same sphere against the same hull's face raised a contact on the same step at
 * the same geometric distance.
 *
 * **Both of this port's workarounds are gone with them**, and each was removed
 * because a case here started failing rather than because anyone remembered to
 * look: the confirming sweep in `Missiles` came out in 3.7.0, and the
 * stopped-missile inference that replaced it came out in 3.8.0. Asserting a
 * bug's presence rather than skipping the case is what makes an engine upgrade
 * break exactly one test and name the code to delete.
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
import { RigidBodyFlags } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBodyFlags.js';
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

describe('a sphere and a slab', () => {
    /** Every shape a level brush or a projectile is built from, by name. */
    const shapes = (): { name: string; make: () => unknown }[] => [
        { name: 'BoxShape3D', make: () => BoxShape3D.from(HALF_X, HALF_Y, HALF_Z) },
        { name: 'ConvexHullShape3D', make: boxAsHull },
    ];

    it('reports nothing while they are apart, whichever shape the slab is', async () => {
        for (const { name, make } of shapes()) {
            for (const gap of [0.05, 0.1, 0.2, 0.3, 0.4, 1, 2]) {
                expect(
                    await contactDepth(make(), gap),
                    `${name} reported a contact across a ${gap} unit gap`
                ).toBeNull();
            }
        }
    });

    it('still reports one when they really do overlap', async () => {
        /*
         The other half, and the reason this file did not simply get deleted when
         the false contacts went away. A fix that removed *every* contact from the
         convex path would pass the case above and would be catastrophic -- so the
         real overlaps are asserted beside the false ones, at the same depths, in
         the same rig.
        */
        for (const { name, make } of shapes()) {
            for (const overlap of [0.05, 0.2, 0.5, 1]) {
                const depth = await contactDepth(make(), -overlap);

                expect(depth, `${name} reported no contact at a ${overlap} unit overlap`)
                    .not.toBeNull();
                expect(depth! / WORLD_SCALE).toBeCloseTo(overlap, 1);
            }
        }
    });

    it('agrees with itself whether the sphere is centred over the face or not', async () => {
        /*
         Position used to matter, and that it no longer does is the clearest
         statement that the simplex-quality problem is gone: GJK picks its support
         vertices by direction, so a sphere over the middle of a large face and one
         6 m to the side hand EPA different simplices out of the same pair. Before
         the fix the first reported nothing and the second reported a contact
         across clear air.
        */
        for (const gap of [0.05, 0.1, 0.2, 0.3]) {
            expect(await contactDepth(boxAsHull(), gap, 0, 0)).toBeNull();
            expect(await contactDepth(boxAsHull(), gap, OVER_X, OVER_Y)).toBeNull();
        }

        for (const overlap of [0.05, 0.2, 0.5]) {
            const centred = await contactDepth(boxAsHull(), -overlap, 0, 0);
            const offset = await contactDepth(boxAsHull(), -overlap, OVER_X, OVER_Y);

            expect(centred, `centred, a ${overlap} unit overlap went unreported`).not.toBeNull();
            expect(offset, `off-centre, a ${overlap} unit overlap went unreported`).not.toBeNull();
        }
    });
});

/* ------------------------------------------------------------------ *
 * The other half: a contact that is never reported
 * ------------------------------------------------------------------ */

/**
 * A body CCD stops against a hull reports it, whichever part of the hull it is.
 *
 * Through 3.7.0 only the face did. Drive a sphere at a `ConvexHullShape3D`'s
 * face and the continuous-collision pass clamped it at the surface and
 * `ContactBegin` fired; drive the same sphere at the same hull's corner and it
 * was clamped in exactly the same way, on exactly the same step, at exactly the
 * geometric corner distance -- and no event was ever dispatched, for as long as
 * you cared to keep stepping. A game that reacts to impacts never learned about
 * one while the body sat there blocked: ten of twenty-eight rockets in the
 * 64-direction test ground against a player's shoulder for their full ten
 * seconds, doing nothing.
 *
 * `Missiles` inferred the impact instead -- a `TR_LINEAR` missile that covered
 * less than its own speed in a step has hit something -- and this pair of cases
 * asserted the absence, so that the day the engine started raising it the test
 * would fail and the inference could go. **3.8.0, and it did.** Both halves now
 * assert the contact rather than its absence, and `Missiles` is that much
 * smaller.
 */
describe('a missile driven into a convex hull', () => {
    /** Q3's player box, 30 x 30 x 56 units, as a hull at the origin. */
    function playerBoxHull(): unknown {
        const hx = 15 * WORLD_SCALE;
        const hy = 28 * WORLD_SCALE;
        const hz = 15 * WORLD_SCALE;

        const vertices = new Float32Array([
            -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz,
            -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
        ]);
        const indices = new Uint32Array([
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
            2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        ]);

        return ConvexHullShape3D.from(vertices, indices);
    }

    /**
     * Fire a CCD sphere at the hull from 120 units out along `(dx, dz)`, and
     * report where it came to rest and whether anything was raised about it.
     */
    async function fireAt(dx: number, dz: number): Promise<{
        reported: boolean;
        restedAt: number;
        stoppedAtStep: number;
    }> {
        const { em, ecd } = await bareWorld();

        place(ecd, BodyKind.Static, playerBoxHull(), 0, 0, 0);

        const transform = new Transform();
        transform.position.set(-dx * 120 * WORLD_SCALE, 0, -dz * 120 * WORLD_SCALE);

        const rigidBody = new RigidBody();
        rigidBody.kind = BodyKind.Dynamic;
        rigidBody.mass = 1;
        rigidBody.gravityScale = 0;
        rigidBody.flags = RigidBodyFlags.CCD;
        rigidBody.linearVelocity.set(dx * 900 * WORLD_SCALE, 0, dz * 900 * WORLD_SCALE);

        const collider = new Collider() as unknown as { shape: unknown };
        collider.shape = SphereShape3D.from(RADIUS);

        const builder = new Entity();
        builder.add(transform).add(rigidBody).add(collider as unknown as Collider).build(ecd);

        let reported = false;
        ecd.addEntityEventListener(builder.id, PhysicsEvents.ContactBegin, ((): void => {
            reported = true;
        }) as never);

        let stoppedAtStep = -1;
        let lastX = transform.position.x;
        let lastZ = transform.position.z;

        for (let step = 0; step < 30; step++) {
            em.update(em.fixedUpdateStepSize);

            const moved = Math.hypot(
                transform.position.x - lastX,
                transform.position.z - lastZ
            ) / WORLD_SCALE;

            lastX = transform.position.x;
            lastZ = transform.position.z;

            if (stoppedAtStep < 0 && moved < 1) stoppedAtStep = step;
        }

        return {
            reported,
            restedAt: Math.hypot(transform.position.x, transform.position.z) / WORLD_SCALE,
            stoppedAtStep,
        };
    }

    it('is stopped by the face, and the contact is reported', async () => {
        const head = await fireAt(-1, 0);

        // Box half-width 15 plus the sphere's own 0.5.
        expect(head.restedAt).toBeCloseTo(15.5, 1);
        expect(head.stoppedAtStep).toBeGreaterThanOrEqual(0);
        expect(head.reported, 'a face impact raised no ContactBegin').toBe(true);
    });

    it('is stopped by the corner in exactly the same way, and that is reported too', async () => {
        const corner = await fireAt(-Math.SQRT1_2, -Math.SQRT1_2);

        // The box's own diagonal half-extent, 15 * sqrt(2), plus the sphere.
        expect(corner.restedAt).toBeCloseTo(21.71, 1);
        expect(corner.stoppedAtStep, 'the corner did not stop it at all').toBeGreaterThanOrEqual(0);

        /*
         The half that used to be false. A body clamped by CCD is *touching* and
         touching is not overlapping, so this is a contact at zero depth against
         a feature with no face to clip against -- which is exactly the case that
         went unreported, and exactly the case a missile hits when it catches
         someone on the shoulder rather than square on.
        */
        expect(corner.reported, 'a corner impact raised no ContactBegin').toBe(true);
    });

    it('stops at the same step whichever part it hits, which is what CCD is for', async () => {
        /*
         The property that made the old bug legible: the sweep was never at
         fault. Both approaches were clamped on the same step at their own
         geometric distances even while only one of them said so, so the defect
         was in the reporting rather than in the collision -- and that is what
         made "infer it from the missile having stopped" a sound workaround
         rather than a guess.
        */
        const head = await fireAt(-1, 0);
        const corner = await fireAt(-Math.SQRT1_2, -Math.SQRT1_2);

        expect(corner.stoppedAtStep).toBe(head.stoppedAtStep);
    });
});
