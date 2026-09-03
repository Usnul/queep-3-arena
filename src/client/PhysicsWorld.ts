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
 * Curved surfaces are not in the brush lump and come from `patchHull.ts`, which
 * decomposes each patch into convex facets and hands them over as the same kind
 * of body. That conversion is *not* lossless -- a curve becomes a fixed number
 * of flat facets, as it does in `cm_patch.c` -- and it is why the body count on
 * a patch-heavy map is several times the brush count.
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

import { ClipMap, MASK_PLAYERSOLID } from '../q3/cm/ClipMap.ts';
import { buildHulls, type BrushHull } from '../q3/cm/brushHull.ts';
import { buildPatchHulls } from '../q3/cm/patchHull.ts';
import type { TraceResult } from '../q3/cm/trace.ts';
import { addAcousticBody } from './Acoustics.ts';
import { hullShape } from './hullShape.ts';
import { PhysicsTrace } from './PhysicsTrace.ts';
import { SurfaceMetadata } from './SurfaceMetadata.ts';
import { layerForContents } from './layers.ts';

/** Scene units per Q3 unit. */
const WORLD_SCALE = 1 / 32;
const INV_WORLD_SCALE = 32;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    addComponentToEntity(entity: number, component: unknown): void;
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
    /** `MST_PATCH` surfaces the map has, whether or not they became facets. */
    readonly patches: number;
    /** Convex facets the patches decomposed into; see `patchHull.ts`. */
    readonly facets: number;
    /**
     * Patch cells that produced no facet, and so are holes in the collision.
     *
     * Zero on every map in the set. It is reported rather than asserted because
     * the decomposition is geometric and a map this port has never seen is
     * allowed to be strange -- but a non-zero number here means a player can
     * walk through part of a curved surface, and that is worth seeing in the
     * load stats rather than discovering in a match.
     */
    readonly patchHoles: number;
    readonly bodies: number;
    /**
     * How many of those bodies also block sound.
     *
     * Zero when nothing registered meep's acoustic systems, which is the only
     * externally visible difference between "the simulation is off" and "the
     * simulation is on and hearing nothing" -- see `addAcousticBody`.
     */
    readonly occluders: number;
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
        patches: 0,
        facets: 0,
        patchHoles: 0,
        bodies: 0,
        occluders: 0,
        skipped: 0,
        hullMilliseconds: 0,
        bodyMilliseconds: 0,
    };



    /**
     * The query half, shared with the headless harness so the measurements and
     * the shipping build cannot drift apart. See `PhysicsTrace`.
     */
    private queries: PhysicsTrace | null = null;

    /** Running count behind `stats.occluders`; `addStaticHull` is the only writer. */
    private occluders = 0;

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
        const patches = buildPatchHulls(
            cm,
            MASK_PLAYERSOLID,
            submodel.firstSurface,
            submodel.numSurfaces
        );

        let built = 0;
        for (const hull of set.hulls) {
            if (this.addStaticHull(ecd, hull) !== null) built += 1;
        }
        for (const hull of patches.hulls) {
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

        /*
         And the curved surfaces, which are not in the brush lump at all. A Q3
         patch is solid in Q3 and was not solid here: on `am_thornish` that was
         fourteen round columns a player walked straight through. See
         `patchHull.ts` for why they arrive as many convex facets rather than
         one shape each.
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
            if (this.addStaticHull(ecd, hull)) bodies += 1;
        }
        for (const hull of patches.hulls) {
            if (this.addStaticHull(ecd, hull)) bodies += 1;
        }

        this.stats = {
            brushes: cm.numBrushes,
            patches: cm.numPatches,
            facets: patches.hulls.length,
            patchHoles: patches.dropped,
            bodies,
            occluders: this.occluders,
            skipped: set.skipped,
            hullMilliseconds: set.milliseconds + patches.milliseconds,
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
        /*
         A mover's curved trim moves with it. The facets are built in the
         submodel's authored position and carried by the same transform as its
         brushes, so a curved door closes as one piece.
        */
        const patches = buildPatchHulls(
            cm,
            MASK_PLAYERSOLID,
            submodel.firstSurface,
            submodel.numSurfaces
        );
        if (set.hulls.length === 0 && patches.hulls.length === 0) return null;

        const transforms: Transform[] = [];

        for (const hull of set.hulls) {
            const transform = this.addStaticHull(ecd, hull, BodyKind.KinematicVelocity);
            if (transform !== null) transforms.push(transform);
        }
        for (const hull of patches.hulls) {
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
     * The hull is built around its own centroid and the body is placed there
     * rather than left in world space with the body at the origin, for the
     * reason `hullShape` gives. That conversion is a shared module because the
     * divergence harness and the acoustic bake need the identical solids -- a
     * reverberation measured against geometry the runtime does not occlude with
     * is wrong in a way nothing reports.
     */
    private addStaticHull(
        ecd: EcsDataset,
        hull: BrushHull,
        kind: number = BodyKind.Static
    ): Transform | null {
        const placed = hullShape(hull);

        // Degenerate hulls exist in shipped maps; one should not abort a load.
        if (placed === null) return null;

        const shape = placed.shape;

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
        transform.position.set(placed.x, placed.y, placed.z);

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            /*
             What this piece of geometry is made of, on the body rather than in
             the clipmap. See `SurfaceMetadata`: it is what lets a `shape_cast`
             hit answer `SURF_NOIMPACT` without anything downstream knowing a
             BSP was involved.
            */
            .add(SurfaceMetadata.from(hull))
            .build(ecd);

        /*
         And the same body is what sound is occluded by, if it is the kind of
         brush that blocks any. `AcousticSimulationSystem` links the triple
         `AcousticBody + Collider + Transform`, so this is not a second copy of
         the level -- it is one more component on the body that already exists,
         and it costs nothing at all when the acoustic systems are not
         registered. A mover gets one too: the system follows a transform, so a
         door that closes closes acoustically. See `Acoustics.ts`.
        */
        if (addAcousticBody(ecd, builder.id, hull.contents)) this.occluders += 1;

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
