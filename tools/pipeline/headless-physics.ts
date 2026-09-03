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
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';

import { ClipMap, MASK_PLAYERSOLID } from '../../src/q3/cm/ClipMap.ts';
import { hullShape } from '../../src/client/hullShape.ts';
import { PhysicsTrace } from '../../src/client/PhysicsTrace.ts';
import { layerForContents } from '../../src/client/layers.ts';
import { buildHulls, type BrushHull } from '../../src/q3/cm/brushHull.ts';
import { buildPatchHulls } from '../../src/q3/cm/patchHull.ts';
import { pointContents } from '../../src/q3/cm/trace.ts';
import type { TraceResult } from '../../src/q3/cm/trace.ts';

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
    /** Convex facets the world's patches decomposed into; see `patchHull.ts`. */
    readonly facets: number;
    /** Patch cells that produced no facet, and so are holes in the collision. */
    readonly patchHoles: number;
    readonly hullMilliseconds: number;
    readonly bodyMilliseconds: number;
    /**
     * What `PhysicsSystem.optimize` cost after the bodies were linked.
     *
     * Separate from `bodyMilliseconds` because it is not part of building them:
     * it is a one-off re-shape of the broadphase that the browser build also
     * pays, and load-time accounting that hides it would understate both.
     */
    readonly optimizeMilliseconds: number;
}

/**
 * Handle for one brush entity's collision on a headless host.
 *
 * The same three members `PhysicsWorld.MoverBodies` has and for the same
 * reason: the thing driving a door should not care which of the two worlds it
 * is moving one in.
 */
export interface HeadlessMoverBodies {
    readonly model: number;
    readonly count: number;
    /** Offset from the submodel's authored position, in Q3 units and Q3 axes. */
    setOffset(q3x: number, q3y: number, q3z: number): void;
}

/** Scene metres per Q3 unit; must match `PhysicsWorld`'s. */
const WORLD_SCALE = 1 / 32;

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
     * So is the body half now: both build their colliders through `hullShape`.
     * What still differs is which brushes each is handed, and that is a property
     * of the caller rather than of the conversion.
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
         Model 0 only **by default**, matching `PhysicsWorld` before anything
         calls `addMover`. Models 1..n are brush entities -- doors, plats,
         buttons, triggers -- and building them here at their *authored*
         positions made the harness disagree with both the clipmap control and
         the shipping build, which is the same class of drift as D-036 and
         D-061: a harness that is not measuring what runs.

         That is still true of the divergence harness and is no longer true of
         every caller. The reason this said "which this harness has no mover
         simulation to drive" was retired by D-191, which gave the host one, and
         a caller that runs the movers can now ask for their bodies through
         {@link addMover} and drive them. See GAP-041 and D-202.
        */
        const world = cm.models[0]!;
        const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);
        /*
         And the patch facets, because `PhysicsWorld` builds them. Leaving them
         out here is the D-036 failure exactly: the harness would report a
         divergence measured against a world with fourteen fewer columns in it
         than the one the browser runs.
        */
        const patches = buildPatchHulls(
            cm,
            MASK_PLAYERSOLID,
            world.firstSurface,
            world.numSurfaces
        );

        const t0 = performance.now();
        let bodies = 0;

        for (const hull of set.hulls) {
            if (HeadlessPhysics.addHull(ecd, queries, hull) !== null) bodies += 1;
        }
        for (const hull of patches.hulls) {
            if (HeadlessPhysics.addHull(ecd, queries, hull) !== null) bodies += 1;
        }

        const bodyMilliseconds = performance.now() - t0;

        /*
         And the broadphase reshaped, because the browser build does it once the
         level's statics are linked and this harness exists to measure what the
         browser runs. It is not a free call: a re-shaped tree hands a shape
         cast its candidates in a different order, and one to two sweeps in
         every thousand converge on a fraction 1e-5 away -- which is exactly why
         it belongs here. Leaving it out would not remove that movement, it
         would hide it, by reporting a divergence figure for a tree nobody
         plays on: the D-036 and D-061 failure in its cheapest form. See D-131.
        */
        const t0Bvh = performance.now();
        system.optimize();
        const optimizeMilliseconds = performance.now() - t0Bvh;

        return new HeadlessPhysics(cm, entityManager, ecd, system, queries, {
            bodies,
            skipped: set.skipped,
            facets: patches.hulls.length,
            patchHoles: patches.dropped,
            hullMilliseconds: set.milliseconds + patches.milliseconds,
            bodyMilliseconds,
            optimizeMilliseconds,
        });
    }

    /**
     * One brush or patch facet -> one static body, as an entity.
     *
     * The hull is built around its own centroid and the body is placed there,
     * rather than left in world space with the body at the origin, for the
     * reason `hullShape` gives. That conversion is shared rather than copied,
     * on the same reasoning as the trace maths below it: a harness that builds
     * its bodies slightly differently from the browser is a harness that
     * reports healthy numbers for code the browser is not running.
     */
    private static addHull(
        ecd: EntityComponentDataset,
        queries: PhysicsTrace,
        hull: BrushHull,
        kind: number = BodyKind.Static
    ): Transform | null {
        const placed = hullShape(hull);
        if (placed === null) return null;

        const shape = placed.shape;

        const body = new RigidBody();
        body.kind = kind;
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
        transform.position.set(placed.x, placed.y, placed.z);

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            .build(ecd);

        // `link` stamps the packed body id onto the component as it goes in.
        queries.register(builder.id, (body as unknown as { _bodyId: number })._bodyId, hull);

        return transform;
    }

    /**
     * One brush entity, as kinematic bodies a player can stand on.
     *
     * **This is GAP-041's other half and the comment above used to be the whole
     * reason it was open.** Models 1..n were left out because they are "brush
     * entities whose positions are owned by a mover simulation the harness has
     * never had" -- true when it was written, and false since D-191 gave the
     * host a `MoverSystem`. A host that runs the movers and does not build their
     * bodies is worse than one that does neither: the door opens on every
     * client's screen and stops nobody on the authority, and a plat extends,
     * invites a player on and drops them through itself. On `oa_dm1` that is a
     * pit of lava, which is how this was reported.
     *
     * **Opt-in, and the opt-out is the point.** The divergence harness measures
     * `bg_pmove` against the clipmap control, and both of those know nothing
     * about movers -- so building brush entities at their *authored* positions
     * there is exactly the D-036 failure the comment above describes, a harness
     * that is not measuring what runs. The host asks for them; nothing else
     * does.
     *
     * The shape is `PhysicsWorld.addMover`'s, deliberately: the same hulls
     * through the same `hullShape`, the same rest positions captured once, and
     * the same Q3-to-meep offset applied per frame. Two ways of making a door
     * solid would be two doors.
     */
    addMover(model: number): HeadlessMoverBodies | null {
        const submodel = this.cm.models[model];
        if (submodel === undefined) return null;

        const set = buildHulls(
            this.cm,
            MASK_PLAYERSOLID,
            submodel.firstBrush,
            submodel.numBrushes
        );
        /*
         And the curved trim, which moves with it: the facets are built in the
         submodel's authored position and carried by the same transforms as its
         brushes, so a curved door closes as one piece.
        */
        const patches = buildPatchHulls(
            this.cm,
            MASK_PLAYERSOLID,
            submodel.firstSurface,
            submodel.numSurfaces
        );

        const transforms: Transform[] = [];

        for (const hull of set.hulls) {
            const t = HeadlessPhysics.addHull(
                this.ecd,
                this.queries,
                hull,
                BodyKind.KinematicVelocity
            );
            if (t !== null) transforms.push(t);
        }
        for (const hull of patches.hulls) {
            const t = HeadlessPhysics.addHull(
                this.ecd,
                this.queries,
                hull,
                BodyKind.KinematicVelocity
            );
            if (t !== null) transforms.push(t);
        }

        if (transforms.length === 0) return null;

        // Where each body sits with the mover at rest, so an offset costs no
        // re-derivation of the centroid.
        const rest = transforms.map((t) => [t.position.x, t.position.y, t.position.z] as const);

        return {
            model,
            count: transforms.length,
            setOffset(q3x: number, q3y: number, q3z: number): void {
                const mx = q3x * WORLD_SCALE;
                const my = q3z * WORLD_SCALE;
                const mz = -q3y * WORLD_SCALE;

                for (let i = 0; i < transforms.length; i++) {
                    const at = rest[i]!;
                    transforms[i]!.position.set(at[0] + mx, at[1] + my, at[2] + mz);
                }
            },
        };
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
