/*
 * headless-ecs.test.ts -- the whole ECS, under Node, with nothing stubbed.
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
 * `HeadlessPhysics` used to drive `PhysicsSystem.link` and `attach_collider`
 * directly, with a two-method stand-in where the dataset should be. That was
 * enough for queries -- which is all the harness asked of it -- and it silently
 * was not enough for anything else, because `PhysicsSystem` delivers contact
 * events through `dataset.sendEvent` and returns early when there is no dataset
 * to deliver through.
 *
 * So a projectile that detonates on `ContactBegin` would have been invisible to
 * every headless test: no error, no warning, just a rocket that never hits
 * anything, in the harness this project uses to check that rockets hit things.
 * That is the shape of D-036 and D-061 for the third time, and the reason
 * `HeadlessPhysics` is now a real `EntityManager` with a real
 * `EntityComponentDataset`.
 *
 * This is what says so. If it fails, step 6's projectiles are being measured by
 * a harness that cannot see them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsEvents } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsEvents.js';
import { SphereShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';

const BUILT = join(process.cwd(), 'assets', 'built');
const WORLD_SCALE = 1 / 32;

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
const cm = new ClipMap(
    new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
);
const scene = JSON.parse(readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')) as Scene;
const spawnQ3 = spawnPoints(scene.entities).points[0]!._originQ3;

/** Q3 (x, y, z) -> meep (x, z, -y), scaled to scene metres. */
function toMeep(q3: readonly number[]): [number, number, number] {
    return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
}

describe('meep physics, headless', () => {
    it('delivers a contact as an entity event, which is what a projectile will hang off', async () => {
        const physics = await HeadlessPhysics.create(cm);

        const [x, y, z] = toMeep(spawnQ3);

        const body = new RigidBody();
        body.kind = BodyKind.Dynamic;
        body.mass = 1;
        // Straight down at Q3's rocket speed, so this does not wait on gravity.
        body.linearVelocity.set(0, -900 * WORLD_SCALE, 0);

        const collider = new Collider() as unknown as { shape: unknown };
        collider.shape = SphereShape3D.from(2 * WORLD_SCALE);

        const transform = new Transform();
        transform.position.set(x, y, z);

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            .build(physics.ecd);

        const contacts: { normalY: number; other: number }[] = [];

        physics.ecd.addEntityEventListener(
            builder.id,
            PhysicsEvents.ContactBegin,
            ((payload: {
                entityA: number;
                entityB: number;
                normal: ArrayLike<number>;
            }): void => {
                // The payload is valid only for the dispatch, so this copies.
                contacts.push({
                    normalY: payload.normal[1]!,
                    other: payload.entityA === builder.id ? payload.entityB : payload.entityA,
                });
            }) as never
        );

        for (let i = 0; i < 120 && contacts.length === 0; i++) {
            physics.step(physics.entityManager.fixedUpdateStepSize);
        }

        expect(contacts.length, 'a falling body never reported touching the floor').toBeGreaterThan(
            0
        );

        // It hit a real body, not itself.
        expect(contacts[0]!.other).not.toBe(builder.id);

        /*
         And the payload carries usable geometry, which is the half a projectile
         needs: `normal` points from entityB toward entityA, so a body landing on
         a floor gets a normal with a real vertical component whichever way the
         pair was canonicalised.
        */
        expect(Math.abs(contacts[0]!.normalY)).toBeGreaterThan(0.5);
    });

    it('runs the fixed step through the entity manager, not the system', async () => {
        const physics = await HeadlessPhysics.create(cm);

        const step = physics.entityManager.fixedUpdateStepSize;

        expect(physics.entityManager.fixedStepTick).toBe(0);

        // Three and a half steps of wall clock in one call.
        physics.step(step * 3.5);

        /*
         Three whole steps run and the half is carried -- the hub's own catch-up
         loop and its own tick id. A harness that called
         `PhysicsSystem.fixedUpdate` itself would advance the simulation once by
         a variable delta and leave `fixedStepTick` at zero, which is a different
         arrangement from the one the browser runs.
        */
        expect(physics.entityManager.fixedStepTick).toBe(3);
        expect(physics.entityManager.getFixedStepAlpha()).toBeCloseTo(0.5, 6);
    });

    it('answers getComponent from the dataset, which is what KinematicMover reads', async () => {
        const physics = await HeadlessPhysics.create(cm);

        expect(physics.stats.bodies).toBeGreaterThan(100);

        // Entity ids are the dataset's now; body 1 is the first hull built.
        const transform = physics.ecd.getComponent(1, Transform);
        expect(transform, 'the first world body has no Transform in the dataset').toBeDefined();

        const collider = physics.ecd.getComponent(1, Collider);
        expect(collider, 'the first world body has no Collider in the dataset').toBeDefined();
    });
});
