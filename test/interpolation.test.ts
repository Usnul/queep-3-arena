/*
 * interpolation.test.ts -- the bridge between a 60 Hz game and a faster display.
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
 * Phase 9 put the simulation on a fixed step, which means a door and a bot now
 * hold one pose for as many frames as the display fits into 16.7 ms and then
 * jump to the next. meep's answer is `InterpolationSystem`: producers record an
 * authoritative pose per step into an `InterpolationLog`, and the system blends
 * the last two at the sub-step alpha into the live `Transform` every rendered
 * frame.
 *
 * `PhysicsSystem` is already a producer. Nothing else is, and an
 * `InterpolationLog` takes exactly one producer per tick -- `begin_tick` throws
 * while a tick is open -- so the poses this application writes itself go on a
 * second timeline, registered through `InterpolationSystem.registerSource`.
 * `PoseRecorderSystem` is that producer, and this is what says it works.
 *
 * The ordering cases are here because two of phase 9's decisions rest on them
 * and neither is a documented guarantee of the engine: which systems the
 * scheduler puts first is computed from declared component access, and a
 * mistake in that reasoning is silent -- a snapshot taken before the step that
 * writes it, or a camera read before it is blended, both just look like
 * jitter.
 */

import { describe, expect, it } from 'vitest';

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { CameraSystem3 } from '@woosh/meep-engine/src/engine/graphics3/CameraSystem3.js';
import { InterpolationSystem } from '@woosh/meep-engine/src/engine/interpolation/InterpolationSystem.js';

import { PoseRecorderSystem, interpolatedPose } from '../src/app/systems.ts';

/**
 * The order `EntityManager` decided on, by system class name.
 *
 * `systemsExecutionOrder` is declared private, and it is the only place the
 * scheduling decision is observable -- reaching for it is the point of these
 * cases.
 */
function executionOrder(em: EntityManager): string[] {
    const order = (em as unknown as { systemsExecutionOrder: object[] }).systemsExecutionOrder;
    return order.map((system) => system.constructor.name);
}

/** `EntityManager.startup` is callback-style; every caller here wants a promise. */
async function started(em: EntityManager): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        em.startup(resolve, reject);
    });
}

/**
 * A door, reduced to what makes one hard to render: an authoritative position
 * that only exists in the simulation, and a `Transform` written from it once per
 * fixed step.
 *
 * Writing *from* the simulation rather than adding to the transform is the point
 * -- it is what `MoversView` does, and it is why the blended value the
 * interpolation system leaves in the transform between steps does not
 * accumulate into the next one.
 */
class DoorSystem extends System<never> {
    /** Q3-side truth. Advances one unit per step. */
    step = 0;

    constructor(private readonly transform: Transform) {
        super();
    }

    override fixedUpdate = (): void => {
        this.step += 1;
        this.transform.position.set(this.step, 0, 0);
    };
}

async function rig(): Promise<{
    em: EntityManager;
    door: DoorSystem;
    transform: Transform;
    /** A second entity with a transform and no `Interpolated`, as a control. */
    untouched: Transform;
}> {
    const em = new EntityManager();
    const dataset = new EntityComponentDataset();
    em.attachDataset(dataset);

    const interpolation = new InterpolationSystem();
    await em.addSystem(interpolation);

    const transform = new Transform();
    const door = new DoorSystem(transform);
    await em.addSystem(door);

    const poses = new PoseRecorderSystem();
    poses.attachTo(interpolation);
    await em.addSystem(poses);

    await started(em);

    new Entity().add(transform).add(interpolatedPose()).build(dataset);

    const untouched = new Transform();
    untouched.position.set(500, 0, 0);
    new Entity().add(untouched).build(dataset);

    return { em, door, transform, untouched };
}

describe('the application interpolation timeline', () => {
    it('blends a fixed-step pose across the frames between two steps', async () => {
        const { em, door, transform } = await rig();

        const step = em.fixedUpdateStepSize;

        // Two whole steps first, so the log has the two ticks a blend needs.
        em.update(step);
        em.update(step);
        expect(door.step).toBe(2);

        // Now a frame that lands a quarter of the way into the third step. The
        // simulation has not advanced, so the *authoritative* pose is still 2.
        em.update(step / 4);
        expect(door.step).toBe(2);
        expect(em.getFixedStepAlpha()).toBeCloseTo(0.25, 6);

        /*
         And the transform is between the last two steps, not on either. This is
         the whole claim: what gets drawn is 1.25 while what the game believes is
         2, and the difference is the quarter of a step the display is ahead of
         the simulation.
        */
        expect(transform.position.x).toBeCloseTo(1.25, 4);

        em.update(step / 4);
        expect(transform.position.x).toBeCloseTo(1.5, 4);

        em.update(step / 4);
        expect(transform.position.x).toBeCloseTo(1.75, 4);

        // The frame that completes the step lands exactly on the new pose.
        em.update(step / 4);
        expect(door.step).toBe(3);
        expect(transform.position.x).toBeCloseTo(2, 4);
    });

    it('leaves a transform with no Interpolated component alone', async () => {
        const { em, untouched } = await rig();

        const step = em.fixedUpdateStepSize;
        for (let i = 0; i < 8; i++) em.update(step / 3);

        expect(untouched.position.x).toBe(500);
    });

    it('does not drift while the simulation holds still', async () => {
        const { em, door, transform } = await rig();

        const step = em.fixedUpdateStepSize;
        for (let i = 0; i < 4; i++) em.update(step);

        // A door that has arrived: still written every step, at the same pose.
        const restingAt = door.step;
        door.fixedUpdate = (): void => {
            transform.position.set(restingAt, 0, 0);
        };

        for (let i = 0; i < 12; i++) em.update(step / 3);

        /*
         Two identical snapshots blend to that pose at any alpha, so a mover at
         rest sits still. It only works because the producer keeps writing --
         see the case below for what happens when it does not.
        */
        expect(transform.position.x).toBeCloseTo(restingAt, 6);
    });

    it('drifts if a producer stops rewriting its pose, which is why MoversView always does', async () => {
        const { em, door, transform } = await rig();

        const step = em.fixedUpdateStepSize;
        for (let i = 0; i < 4; i++) em.update(step);

        const arrivedAt = door.step;

        // Stop writing entirely, which is what an early-out on "the simulation
        // did not move" amounts to.
        door.fixedUpdate = (): void => {};

        for (let i = 0; i < 12; i++) em.update(step / 3);

        /*
         The recorder snapshots whatever is in the transform, and between steps
         that is the *blended* value rather than the authoritative one -- so the
         blend feeds itself and the pose walks backwards. This is the failure
         `PhysicsSystem.__interp_restore` exists to prevent for its own bodies,
         and the reason `MoversView.update` no longer skips a mover whose origin
         has not changed. Asserted as a real number rather than "not equal", so
         that a future restore pass makes this case fail loudly rather than
         silently passing for a new reason.
        */
        expect(transform.position.x).toBeLessThan(arrivedAt - 0.2);
    });
});

describe('the execution order phase 9 relies on', () => {
    it('schedules the pose recorder after the simulation that writes the poses', async () => {
        const em = new EntityManager();
        em.attachDataset(new EntityComponentDataset());

        const interpolation = new InterpolationSystem();
        await em.addSystem(interpolation);
        await em.addSystem(new DoorSystem(new Transform()));

        const poses = new PoseRecorderSystem();
        poses.attachTo(interpolation);
        await em.addSystem(poses);

        await started(em);
        em.update(em.fixedUpdateStepSize);

        const order = executionOrder(em);

        /*
         `PoseRecorderSystem` declares no dependencies precisely so that it lands
         here. Declaring `[Interpolated]` -- the obvious way to find the entities
         -- would score it above the component-less simulation systems and
         schedule it to snapshot poses one step before they are written.
        */
        expect(order.indexOf('PoseRecorderSystem')).toBeGreaterThan(order.indexOf('DoorSystem'));
    });

    it('schedules CameraSystem3 ahead of InterpolationSystem, which is why the camera is not blended', async () => {
        const em = new EntityManager();
        em.attachDataset(new EntityComponentDataset());

        await em.addSystem(new InterpolationSystem());
        await em.addSystem(
            new CameraSystem3({ isGraphicsEngine: true, camera: { camera: {} } } as never) as never
        );

        await started(em);
        em.update(em.fixedUpdateStepSize);

        const order = executionOrder(em);

        /*
         Registered the other way round on purpose: the answer is the scheduler's,
         not the registration order's. `CameraSystem3` references `Camera` and
         `Transform` where `InterpolationSystem` references only `Interpolated`,
         and the score is a sum over referenced components -- so the camera is
         copied onto Shade's camera before anything has been blended into it.
         An `Interpolated` camera entity would therefore be a frame late rather
         than smooth, which is why `PlayerSystem` writes the camera pose on the
         fixed step and leaves it there.
        */
        expect(order.indexOf('CameraSystem3')).toBeLessThan(order.indexOf('InterpolationSystem'));
    });
});
