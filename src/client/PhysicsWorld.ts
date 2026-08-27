/*
 * PhysicsWorld.ts -- the level's collision, as meep physics bodies.
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
 * Every Q3 brush becomes one static `RigidBody` with a `ConvexHullShape3D`
 * collider. The conversion is lossless (see `brushHull.ts`), so the *volumes*
 * are Q3's exactly; what changes is that queries against them are meep's
 * narrowphase rather than a ported `cm_trace`.
 *
 * This module also provides the `pm->trace` implementation `bg_pmove` calls,
 * built on `shape_cast`. That is the seam: pmove's algorithm is untouched --
 * the acceleration, the plane-clipping, the step logic, all of which is where
 * strafe jumping lives -- and only the question "what does this box hit" is
 * answered differently.
 *
 * Bodies live in **meep space** (metres, Y up) because that is where the
 * physics broadphase and the renderer both are; the trace adaptor converts at
 * its own boundary so pmove keeps its Q3 units. See DECISIONS.md D-029.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { ColliderObserverSystem } from '@woosh/meep-engine/src/engine/physics/ecs/ColliderObserverSystem.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';

import { ClipMap, MASK_PLAYERSOLID } from '../q3/cm/ClipMap.ts';
import { buildHulls, type BrushHull } from '../q3/cm/brushHull.ts';
import type { TraceResult } from '../q3/cm/trace.ts';
import { PhysicsTrace } from './PhysicsTrace.ts';
import { layerForContents } from './layers.ts';

/** Scene units per Q3 unit. */
const WORLD_SCALE = 1 / 32;
const INV_WORLD_SCALE = 32;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/** Identity rotation; every level body is axis-aligned in world space. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Corrective type for assigning a concrete shape to `Collider.shape`.
 *
 * `AbstractShape3D` declares `equals<T extends AbstractShape3D>(other: T)`,
 * while every concrete subclass declares `equals(other: ThatSubclass)`. The
 * narrowed parameter makes the subclass method incompatible with the base
 * signature, so **no concrete shape is assignable to `AbstractShape3D`** and
 * `collider.shape = new BoxShape3D(...)` is a type error -- for every shape in
 * the hierarchy, against the only field that consumes them.
 *
 * The runtime is fine; this is purely the generated declarations. Corrected with
 * a narrow local type rather than `any`, per the brief. See GAP-013.
 */
type ColliderWithShape = { shape: unknown; friction: number; restitution: number };

export interface PhysicsWorldStats {
    readonly brushes: number;
    readonly bodies: number;
    readonly skipped: number;
    readonly hullMilliseconds: number;
    readonly bodyMilliseconds: number;
}

/** Handle for one brush entity's collision, returned by `PhysicsWorld.addMover`. */
export interface MoverBodies {
    readonly model: number;
    readonly count: number;
    /** Offset from the submodel's authored position, in Q3 units and Q3 axes. */
    setOffset(q3x: number, q3y: number, q3z: number): void;
}

export class PhysicsWorld {
    readonly system: PhysicsSystem;

    /** Populated by `build`; zeroed until then. */
    stats: PhysicsWorldStats = {
        brushes: 0,
        bodies: 0,
        skipped: 0,
        hullMilliseconds: 0,
        bodyMilliseconds: 0,
    };



    /**
     * The query half, shared with the headless harness so the measurements and
     * the shipping build cannot drift apart. See `PhysicsTrace`.
     */
    private queries: PhysicsTrace | null = null;

    /** Kept so `addMover` can build submodel bodies after the initial load. */
    private cm: ClipMap | null = null;
    /**
     * Public because `KinematicMover` resolves an overlapping body back to its
     * `Transform` and `Collider` through the dataset, so anything driving the
     * mover needs both halves of the world. See `MoverHost`.
     */
    ecd: EcsDataset | null = null;

    private constructor() {
        this.system = new PhysicsSystem();
    }

    /** `pm->trace`, delegated. */
    /**
     * Entities the level's traces pass through: characters, and missiles in
     * flight. See `PhysicsTrace.ignored`.
     */
    get traceIgnores(): Set<number> {
        if (this.queries === null) throw new Error('PhysicsWorld has no queries yet');
        return this.queries.ignored;
    }

    trace(
        out: TraceResult,
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        minsQ3: ArrayLike<number>,
        maxsQ3: ArrayLike<number>,
        contentMask: number
    ): void {
        this.queries?.trace(out, startQ3, endQ3, minsQ3, maxsQ3, contentMask);
    }

    /**
     * Register the system, *then* build the bodies.
     *
     * The order is load-bearing. Both systems observe the dataset, so an entity
     * built before they are registered is never seen -- no warning, no error,
     * and every query keeps answering, always with a miss. Movement then
     * behaves exactly like a level with no collision in it, which reads as "the
     * map failed to load" rather than "the bodies are not registered".
     *
     * This is why it is a factory rather than a constructor: the correct order
     * is not expressible if construction also builds the bodies. See GAP-014.
     */
    static async create(
        em: { addSystem(system: unknown): Promise<unknown> },
        ecd: EcsDataset,
        cm: ClipMap
    ): Promise<PhysicsWorld> {
        const world = new PhysicsWorld();

        await em.addSystem(world.system);
        /*
         Both, in this order. `PhysicsSystem` links `(RigidBody, Transform)`;
         `ColliderObserverSystem` is what turns a `Collider` component into an
         actual shape on that body. Register only the first and every body is
         real, present in the broadphase and completely intangible.
        */
        await em.addSystem(new ColliderObserverSystem(world.system));

        world.build(ecd, cm);
        return world;
    }

    /**
     * Static bodies for one submodel: `func_static`, and brush entities this
     * port does not simulate.
     *
     * Q3 makes every brush entity solid whether or not the game code knows what
     * to do with it, so an unimplemented `func_rotating` is still a wall. The
     * alternative -- skipping it -- puts a hole in the level exactly where the
     * map author put a solid object.
     */
    addStaticModel(model: number): number {
        const cm = this.cm;
        const ecd = this.ecd;
        if (cm === null || ecd === null) return 0;

        const submodel = cm.models[model];
        if (submodel === undefined) return 0;

        const set = buildHulls(cm, MASK_PLAYERSOLID, submodel.firstBrush, submodel.numBrushes);

        let built = 0;
        for (const hull of set.hulls) {
            if (this.addStaticHull(ecd, hull) !== null) built += 1;
        }
        return built;
    }

    private build(ecd: EcsDataset, cm: ClipMap): void {
        this.queries = new PhysicsTrace(this.system, cm);

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(RigidBody)) ecd.registerComponentType(RigidBody);
        if (!ecd.isComponentTypeRegistered(Collider)) ecd.registerComponentType(Collider);

        /*
         Model 0 only. Models 1..n are brush entities and their brushes belong
         to movers, which get kinematic bodies from `addMover` instead -- see
         `buildHulls`'s own note on what happens if they are lumped in here.
        */
        const world = cm.models[0]!;
        const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

        const t0 = performance.now();
        let bodies = 0;

        for (const hull of set.hulls) {
            if (this.addStaticHull(ecd, hull)) bodies += 1;
        }

        this.stats = {
            brushes: cm.numBrushes,
            bodies,
            skipped: set.skipped,
            hullMilliseconds: set.milliseconds,
            bodyMilliseconds: performance.now() - t0,
        };

        this.cm = cm;
        this.ecd = ecd;
    }

    /**
     * Build kinematic bodies for one BSP submodel, and return a handle that
     * moves them.
     *
     * `KinematicVelocity` rather than `Static` or `KinematicPosition`. Static
     * bodies live in a separate broadphase tree that does not expect to move.
     * `KinematicPosition` is the kind that *names* what a mover does, and its
     * own docblock says it is reserved and not implemented -- pose-driven bodies
     * present to the solver as walls that teleport -- with an explicit
     * instruction to prefer `KinematicVelocity` until it lands. This port has no
     * dynamic bodies for a mover to push, so the solver's view of it does not
     * matter; only the query broadphase does, and that tracks the transform.
     *
     * The hulls stay in the submodel's authored positions and the *transform*
     * carries the mover's offset, so the offset the simulation computes is the
     * offset the collision sees, with no second copy of the geometry to keep in
     * step.
     */
    addMover(model: number): MoverBodies | null {
        const cm = this.cm;
        const ecd = this.ecd;
        if (cm === null || ecd === null) return null;

        const submodel = cm.models[model];
        if (submodel === undefined) return null;

        const set = buildHulls(cm, MASK_PLAYERSOLID, submodel.firstBrush, submodel.numBrushes);
        if (set.hulls.length === 0) return null;

        const transforms: Transform[] = [];

        for (const hull of set.hulls) {
            const transform = this.addStaticHull(ecd, hull, BodyKind.KinematicVelocity);
            if (transform !== null) transforms.push(transform);
        }

        if (transforms.length === 0) return null;

        // Where each body sits with the mover at rest, so an offset can be
        // applied without re-deriving the centroid every frame.
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
     * One brush -> one static body.
     *
     * The hull is built around its own centroid and the body is placed there,
     * rather than leaving the vertices in world space with the body at the
     * origin. A convex shape's support function and its AABB are both computed
     * in the body's local frame, so a hull whose vertices sit 2,000 units from
     * its own origin gets a bounding volume 2,000 units across and the
     * broadphase stops discriminating.
     */
    private addStaticHull(
        ecd: EcsDataset,
        hull: BrushHull,
        kind: number = BodyKind.Static
    ): Transform | null {
        const cx = (hull.bounds[0]! + hull.bounds[3]!) * 0.5;
        const cy = (hull.bounds[1]! + hull.bounds[4]!) * 0.5;
        const cz = (hull.bounds[2]! + hull.bounds[5]!) * 0.5;

        const n = hull.vertices.length / 3;
        const local = new Float32Array(hull.vertices.length);

        for (let i = 0; i < n; i++) {
            // Q3 (x, y, z) -> meep (x, z, -y), scaled, relative to the centroid.
            local[i * 3] = (hull.vertices[i * 3]! - cx) * WORLD_SCALE;
            local[i * 3 + 1] = (hull.vertices[i * 3 + 2]! - cz) * WORLD_SCALE;
            local[i * 3 + 2] = -(hull.vertices[i * 3 + 1]! - cy) * WORLD_SCALE;
        }

        /*
         The axis swap has determinant +1, so winding is preserved and the
         indices stay as `brushHull` produced them -- outward CCW, which is what
         `ConvexHullShape3D.from` requires.
        */
        let shape: ConvexHullShape3D;
        try {
            shape = ConvexHullShape3D.from(local, hull.indices);
        } catch {
            // Degenerate hulls exist in shipped maps; one should not abort a load.
            return null;
        }

        const body = new RigidBody();
        body.kind = kind;
        /*
         Which layer a shot is gated against. The bodies are built once with
         `MASK_PLAYERSOLID`, because that is what a player is stopped by; a
         missile is gated by `MASK_SHOT`, which does not include
         `CONTENTS_PLAYERCLIP`. Without this a rocket detonates on the invisible
         fences that keep players off ledges. See `layers.ts`.
        */
        body.layer = layerForContents(hull.contents);

        const collider = new Collider() as unknown as ColliderWithShape;
        collider.shape = shape;
        // Q3 surfaces have no friction model; movement friction is entirely
        // `PM_Friction`. Leaving the physics friction at zero keeps the two from
        // fighting each other.
        collider.friction = 0;
        collider.restitution = 0;

        const transform = new Transform();
        transform.position.set(cx * WORLD_SCALE, cz * WORLD_SCALE, -cy * WORLD_SCALE);

        const builder = new Entity();
        builder.add(transform).add(body).add(collider as unknown as Collider).build(ecd);

        /*
         Remember which brush this body came from, so the contact-plane rule can
         recover its planes.

         The original code declared these maps, read them in the plane selection,
         and never wrote them -- so the lookup always missed and every contact
         normal came from `shape_cast`'s minimum-penetration axis instead, which
         is precisely GAP-012's wrong answer. The headless harness *did* populate
         them, which is why the measurements looked fine while the browser build
         wedged players against invisible planes. Another entry for D-036's
         ledger, and the reason the query half is now shared rather than copied.

         `link` stamps the packed body id onto the component, and the ECS
         observers run during `build`, so it is available immediately.
        */
        this.queries?.register(
            builder.id,
            (body as unknown as { _bodyId: number })._bodyId,
            hull
        );

        return transform;
    }


    /** Convert a Q3 point to meep space, for callers that need it. */
    static toMeep(q3: ArrayLike<number>): [number, number, number] {
        return [q3[0]! * WORLD_SCALE, q3[2]! * WORLD_SCALE, -q3[1]! * WORLD_SCALE];
    }

    static get scale(): number {
        return WORLD_SCALE;
    }

    static get inverseScale(): number {
        return INV_WORLD_SCALE;
    }
}
