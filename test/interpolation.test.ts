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

import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { ColliderObserverSystem } from '@woosh/meep-engine/src/engine/physics/ecs/ColliderObserverSystem.js';

import { PoseRecorderSystem, ViewSystem, interpolatedPose } from '../src/app/systems.ts';
import { Missiles } from '../src/client/Missiles.ts';
import { vec3 } from '../src/q3/math.ts';

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

/**
 * A missile is the hardest thing on either timeline, and the reason is *when* it
 * is born rather than how fast it goes.
 *
 * The rig below is the browser's arrangement reduced to what the question needs:
 * a real `PhysicsSystem` producing the local timeline, a real
 * `PoseRecorderSystem` producing the application one, and a launcher registered
 * where `CombatSystem` is -- after physics in the fixed cycle, which is the
 * whole of the problem.
 */
async function missileRig(): Promise<{
    em: EntityManager;
    /** Fire on the next fixed step, and hand back the missile's transform. */
    launch: () => Transform;
}> {
    const em = new EntityManager();
    const dataset = new EntityComponentDataset();
    em.attachDataset(dataset);

    const registry = em as unknown as { addSystem(system: unknown): Promise<unknown> };

    const interpolation = new InterpolationSystem();
    await registry.addSystem(interpolation);

    const physics = new PhysicsSystem();
    await registry.addSystem(physics);
    await registry.addSystem(new ColliderObserverSystem(physics));

    const missiles = new Missiles(physics as never, dataset as never, null);

    /*
     Where `CombatSystem` is: no declared components, registered before the pose
     recorder, and therefore running after every engine system and before the
     snapshot. A launcher registered anywhere else is not testing the case.
    */
    let pending: (() => void) | null = null;
    class Launcher extends System<never> {
        override fixedUpdate = (): void => {
            const fire = pending;
            pending = null;
            fire?.();
        };
    }
    await registry.addSystem(new Launcher());

    const poses = new PoseRecorderSystem();
    poses.attachTo(interpolation);
    await registry.addSystem(poses);

    await started(em);

    physics.interpolationLog = interpolation.log;

    let next = 1;

    return {
        em,
        launch(): Transform {
            const id = next++;
            let transform: Transform | null = null;

            pending = (): void => {
                missiles.launch({
                    id,
                    ownerId: 0,
                    weapon: 'WP_ROCKET_LAUNCHER',
                    origin: vec3(0, 0, 0),
                    velocity: vec3(900, 0, 0),
                    life: 10,
                } as never);

                const entity = missiles.entityOf(id);
                dataset.addComponentToEntity(entity, interpolatedPose());
                transform = dataset.getComponent(entity, Transform) as Transform;
            };

            em.update(em.fixedUpdateStepSize);

            if (transform === null) throw new Error('the launcher did not run');
            return transform;
        },
    };
}

describe('a missile, from the step it is born on', () => {
    it('glides from its first movement rather than jumping a step and freezing', async () => {
        const { em, launch } = await missileRig();
        const transform = launch();

        const step = em.fixedUpdateStepSize;
        const perFrame = ((900 / 32) * step) / 4;

        /*
         Four quarter-frames to reach the end of the *second* step, which is the
         first one that integrated the missile. Standing still until then is
         correct and is not what was reported: the body was created after that
         step's physics had already run, so there was nothing to draw but the
         muzzle.
        */
        for (let i = 0; i < 4; i++) em.update(step / 4);

        const xs: number[] = [];
        for (let i = 0; i < 12; i++) {
            em.update(step / 4);
            xs.push(transform.position.x);
        }

        /*
         What this replaces: on the *physics* timeline the missile has no
         snapshot at the tick it was created, because `__interp_record` runs
         before the launcher and walks the awake set. With one of the two ticks
         missing, `log.interpolate` falls back to the newer for every alpha -- so
         the first frame of the third step showed a whole step of travel at once
         and the three after it showed none at all. At 165 Hz that is a rocket
         that leaps out of the barrel and then hangs there for four frames, and a
         plasma stream doing it ten times a second.

         Every frame moves, and none of them moves much more than its share:
         a jump-then-freeze puts four frames of travel into one and zero into
         three, so both halves of the assertion fail on the old arrangement.
        */
        const deltas = xs.slice(1).map((x, i) => x - xs[i]!);

        for (const [i, d] of deltas.entries()) {
            expect(d, `frame ${i + 1} moved`).toBeGreaterThan(perFrame * 0.5);
            expect(d, `frame ${i + 1} did not jump`).toBeLessThan(perFrame * 1.5);
        }
    });

    it('is still restored to truth each step, so the blend cannot feed the integrator', async () => {
        const { em, launch } = await missileRig();
        const transform = launch();

        const step = em.fixedUpdateStepSize;
        const perStep = (900 / 32) * step;

        // Settle onto the steady cadence first: two whole steps.
        for (let i = 0; i < 2; i++) em.update(step);

        /*
         Then whole steps with a burst of sub-step frames inside each one. The
         blend writes the live transform between steps and `__interp_restore` has
         to undo it before the solver reads it -- otherwise the missile
         integrates from a pose up to a step behind and quietly loses speed for
         the rest of its flight. Sampling on the step boundaries takes the blend
         out of the reading: at alpha zero the render sits exactly on a snapshot.
        */
        const onStep: number[] = [];
        for (let i = 0; i < 6; i++) {
            for (let f = 0; f < 7; f++) em.update(step / 8);
            em.update(step / 8);
            onStep.push(transform.position.x);
        }

        const advances = onStep.slice(1).map((x, i) => x - onStep[i]!);
        for (const [i, d] of advances.entries()) {
            expect(d, `step ${i + 1}`).toBeCloseTo(perStep, 9);
        }
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

    it('schedules ViewSystem ahead of CameraSystem3, which is what makes the camera smooth', async () => {
        const em = new EntityManager();
        em.attachDataset(new EntityComponentDataset());

        /*
         Registered *after* the camera system on purpose. Registration order is
         what decides a tie, and this must not be one: `ViewSystem` declares
         `Transform` for write where `CameraSystem3` declares it for read, and
         `updateExecutionOrder` scores a writer at twice a reader. If that ever
         stops being true the camera goes back to being a frame late, which is
         the first half of D-081 and is invisible except as judder.
        */
        await em.addSystem(
            new CameraSystem3({ isGraphicsEngine: true, camera: { camera: {} } } as never) as never
        );
        await em.addSystem(
            new ViewSystem({
                player: { writeCamera: (): void => {} },
                cameraTransform: {},
                lens: { apply: (): void => {} },
                surface: { aspect: 1 },
            } as never)
        );

        await started(em);
        em.update(em.fixedUpdateStepSize);

        const order = executionOrder(em);

        expect(order.indexOf('ViewSystem')).toBeLessThan(order.indexOf('CameraSystem3'));
    });

    it('hands ViewSystem the sub-step alpha, so the camera lands between two steps', async () => {
        const em = new EntityManager();
        em.attachDataset(new EntityComponentDataset());

        const alphas: number[] = [];

        await em.addSystem(
            new ViewSystem({
                player: {
                    writeCamera: (_t: unknown, alpha: number): void => {
                        alphas.push(alpha);
                    },
                },
                cameraTransform: {},
                lens: { apply: (): void => {} },
                surface: { aspect: 1 },
            } as never)
        );

        await started(em);

        const step = em.fixedUpdateStepSize;
        em.update(step);
        em.update(step / 4);
        em.update(step / 4);

        expect(alphas[0]).toBeCloseTo(0, 6);
        expect(alphas[1]).toBeCloseTo(0.25, 6);
        expect(alphas[2]).toBeCloseTo(0.5, 6);
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
