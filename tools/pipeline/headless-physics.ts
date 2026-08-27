/*
 * headless-physics.ts -- meep's ECS and physics without a browser.
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
 * `tools/measure-divergence.ts` needs to run the physics-backed trace under
 * Node, against the WebAssembly oracle, with no browser and no engine boot.
 *
 * This used to do that by driving `PhysicsSystem.link` and `attach_collider`
 * directly, with a two-method stand-in for the dataset -- which worked, and was
 * worth recording as a finding: a physics engine that can be driven headless is
 * one whose behaviour can be regression-tested in CI, and most cannot.
 *
 * It is now a real `EntityManager` with a real `EntityComponentDataset`, and
 * that is a stronger version of the same finding: the whole ECS runs under Node
 * with nothing stubbed. Three things came with the change and the third is why
 * it was made.
 *
 *  - `ColliderObserverSystem` attaches the shapes, so a body is an entity with
 *    three components rather than two calls in the right order.
 *  - The dataset answers `getComponent` for real, so the stand-in
 *    `KinematicMover` was being handed is gone.
 *  - **Contact events arrive.** `PhysicsSystem.__dispatch_contact_events`
 *    delivers through `dataset.sendEvent` and returns early when there is no
 *    dataset -- so with the old arrangement a contact-driven projectile would
 *    have been silently invisible to every headless test, which is the exact
 *    class of failure D-036 and D-061 already cost this project twice.
 *
 * The trace maths is `src/client/PhysicsWorld.ts`'s, shared rather than copied:
 * the real independence in a divergence measurement is the bit-exact clipmap
 * control, and the duplication that used to stand in for it twice reported
 * healthy numbers for code the browser was not running.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { ColliderObserverSystem } from '@woosh/meep-engine/src/engine/physics/ecs/ColliderObserverSystem.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';

import { ClipMap, MASK_PLAYERSOLID } from '../../src/q3/cm/ClipMap.ts';
import { PhysicsTrace } from '../../src/client/PhysicsTrace.ts';
import { layerForContents } from '../../src/client/layers.ts';
import { buildHulls, type BrushHull } from '../../src/q3/cm/brushHull.ts';
import { pointContents } from '../../src/q3/cm/trace.ts';
import type { TraceResult } from '../../src/q3/cm/trace.ts';

const WORLD_SCALE = 1 / 32;

/**
 * `EntityManager.addSystem`, corrected.
 *
 * The generated declaration types the parameter as `System<any>`, whose `link`
 * takes `(component, entity)`. Every real engine system declares a `link` with
 * one parameter per dependency, so `PhysicsSystem` -- which links
 * `(RigidBody, Transform, entity)` -- is not assignable to the type of the
 * method that registers it. Neither is any other system with more than one
 * dependency. The runtime is fine; this is the same class of declaration bug as
 * GAP-013, and `PhysicsWorld.create` takes the same narrow escape.
 */
type SystemRegistry = { addSystem(system: unknown): Promise<unknown> };

interface Stats {
    readonly bodies: number;
    readonly skipped: number;
    readonly hullMilliseconds: number;
    readonly bodyMilliseconds: number;
}

export class HeadlessPhysics {
    readonly system: PhysicsSystem;

    /** The simulation hub. `step` drives it; tests may read `fixedStepTick`. */
    readonly entityManager: EntityManager;

    /** The real dataset, which is what `KinematicMover` and contact events want. */
    readonly ecd: EntityComponentDataset;

    /**
     * Public because callers that drive movement need the same clipmap this was
     * built from -- `pointContents` is still Q3's, and `createPmoveHost` takes
     * one. Exposing it beats handing every caller two objects that must match.
     */
    readonly cm: ClipMap;

    readonly stats: Stats;

    /**
     * The query half, shared with `PhysicsWorld`.
     *
     * Body construction still differs, because the browser builds from a scene
     * bundle and this builds from the clipmap; the query does not.
     */
    private readonly queries: PhysicsTrace;

    private constructor(
        cm: ClipMap,
        entityManager: EntityManager,
        ecd: EntityComponentDataset,
        system: PhysicsSystem,
        queries: PhysicsTrace,
        stats: Stats
    ) {
        this.cm = cm;
        this.entityManager = entityManager;
        this.ecd = ecd;
        this.system = system;
        this.queries = queries;
        this.stats = stats;
    }

    /**
     * Register the systems, start them, *then* build the bodies.
     *
     * The order is load-bearing and is `PhysicsWorld.create`'s, for the same
     * reason: both systems observe the dataset, so an entity built before they
     * are running is never linked -- no warning, no error, and every query keeps
     * answering, always with a miss. That reads as "the map failed to load"
     * rather than "the bodies are not registered", and it is why this is a
     * factory. `EntityManager.startup` is callback-style and completes on a
     * microtask, which is the whole reason a constructor could not do it.
     */
    static async create(cm: ClipMap): Promise<HeadlessPhysics> {
        const entityManager = new EntityManager();
        const ecd = new EntityComponentDataset();
        entityManager.attachDataset(ecd);

        const system = new PhysicsSystem();
        const registry = entityManager as unknown as SystemRegistry;

        await registry.addSystem(system);
        /*
         Both, in this order. `PhysicsSystem` links `(RigidBody, Transform)`;
         `ColliderObserverSystem` is what turns a `Collider` component into an
         actual shape on that body. Register only the first and every body is
         real, present in the broadphase and completely intangible.
        */
        await registry.addSystem(new ColliderObserverSystem(system));

        await new Promise<void>((resolve, reject) => {
            entityManager.startup(resolve, reject);
        });

        const queries = new PhysicsTrace(system, cm);

        /*
         Model 0 only, matching `PhysicsWorld`. Models 1..n are brush entities --
         doors, buttons, triggers -- which the browser build makes kinematic
         bodies driven by the mover simulation, and which this harness has no
         mover simulation to drive.

         Including them here put every one at its *authored* position and made
         the harness disagree with both the clipmap control and the shipping
         build. It is the same class of drift as D-036 and D-061: a harness that
         is not measuring what runs.
        */
        const world = cm.models[0]!;
        const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

        const t0 = performance.now();
        let bodies = 0;

        for (const hull of set.hulls) {
            if (HeadlessPhysics.addHull(ecd, queries, hull)) bodies += 1;
        }

        return new HeadlessPhysics(cm, entityManager, ecd, system, queries, {
            bodies,
            skipped: set.skipped,
            hullMilliseconds: set.milliseconds,
            bodyMilliseconds: performance.now() - t0,
        });
    }

    /**
     * One brush -> one static body, as an entity.
     *
     * The hull is built around its own centroid and the body is placed there,
     * rather than leaving the vertices in world space with the body at the
     * origin: a convex shape's support function and its AABB are both computed
     * in the body's local frame, so a hull whose vertices sit 2,000 units from
     * its own origin gets a bounding volume 2,000 units across and the
     * broadphase stops discriminating.
     */
    private static addHull(
        ecd: EntityComponentDataset,
        queries: PhysicsTrace,
        hull: BrushHull
    ): boolean {
        const cx = (hull.bounds[0]! + hull.bounds[3]!) * 0.5;
        const cy = (hull.bounds[1]! + hull.bounds[4]!) * 0.5;
        const cz = (hull.bounds[2]! + hull.bounds[5]!) * 0.5;

        const n = hull.vertices.length / 3;
        const local = new Float32Array(hull.vertices.length);

        for (let i = 0; i < n; i++) {
            local[i * 3] = (hull.vertices[i * 3]! - cx) * WORLD_SCALE;
            local[i * 3 + 1] = (hull.vertices[i * 3 + 2]! - cz) * WORLD_SCALE;
            local[i * 3 + 2] = -(hull.vertices[i * 3 + 1]! - cy) * WORLD_SCALE;
        }

        let shape: ConvexHullShape3D;
        try {
            shape = ConvexHullShape3D.from(local, hull.indices);
        } catch {
            return false;
        }

        const body = new RigidBody();
        body.kind = BodyKind.Static;
        // `MASK_SHOT` versus `MASK_PLAYERSOLID`, as a layer -- see `layers.ts`.
        body.layer = layerForContents(hull.contents);

        /*
         `AbstractShape3D.equals` is declared with a narrowed parameter on every
         concrete subclass, so no concrete shape is assignable to the field that
         consumes them. The runtime is fine; this is the generated declarations.
         See GAP-013 and the same corrective type in `PhysicsWorld`.
        */
        const collider = new Collider() as unknown as {
            shape: unknown;
            friction: number;
            restitution: number;
        };
        collider.shape = shape;
        collider.friction = 0;
        collider.restitution = 0;

        const transform = new Transform();
        transform.position.set(cx * WORLD_SCALE, cz * WORLD_SCALE, -cy * WORLD_SCALE);

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            .build(ecd);

        // `link` stamps the packed body id onto the component as it goes in.
        queries.register(builder.id, (body as unknown as { _bodyId: number })._bodyId, hull);

        return true;
    }

    /**
     * Advance the whole simulation by `deltaSeconds` of wall clock.
     *
     * Through `EntityManager`, not `PhysicsSystem.fixedUpdate`: the fixed-step
     * loop, the tick id, the catch-up cap and the contact-event dispatch are all
     * the hub's, and a harness that stepped the system directly would be
     * measuring a different arrangement from the one the browser runs.
     */
    step(deltaSeconds: number): void {
        this.entityManager.update(deltaSeconds);
    }

    /** Entities the level's traces pass through. See `PhysicsTrace.ignored`. */
    get traceIgnores(): Set<number> {
        return this.queries.ignored;
    }

    /** `CONTENTS_*` at a point. Q3 semantics, so the clipmap answers it. */
    pointContents(point: ArrayLike<number>): number {
        return pointContents(this.cm, point[0]!, point[1]!, point[2]!);
    }

    /** `pm->trace`, delegated to the same code the browser build runs. */
    trace(
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        contentMask: number
    ): void {
        this.queries.trace(out, startQ3, endQ3, minsQ3, maxsQ3, contentMask);
    }
}
