/*
 * headless-physics.ts -- meep's physics without the ECS, for measurement.
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
 * Node, against the WebAssembly oracle, with no browser and no engine boot. That
 * turns out to be straightforward: `PhysicsSystem.link` and
 * `attach_collider` allocate bodies directly, and `shape_cast` queries the
 * broadphase without touching the renderer or the entity manager.
 *
 * Worth recording as a finding in its own right (see REPORT.md): a physics
 * engine that can be driven headless is a physics engine whose behaviour can be
 * regression-tested in CI. Most cannot.
 *
 * The trace maths here is the same as `src/client/PhysicsWorld.ts`'s and is
 * deliberately duplicated rather than shared: this file exists to *measure* that
 * one, and a shared implementation would mean a bug in the conversion cancels
 * itself out of the measurement.
 */

import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';

import { ClipMap, MASK_PLAYERSOLID } from '../../src/q3/cm/ClipMap.ts';
import { PhysicsTrace } from '../../src/client/PhysicsTrace.ts';
import { buildHulls, type BrushHull } from '../../src/q3/cm/brushHull.ts';
import { pointContents } from '../../src/q3/cm/trace.ts';
import type { TraceResult } from '../../src/q3/cm/trace.ts';

const WORLD_SCALE = 1 / 32;
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

interface Stats {
    readonly bodies: number;
    readonly skipped: number;
    readonly hullMilliseconds: number;
    readonly bodyMilliseconds: number;
}

export class HeadlessPhysics {
    readonly system: PhysicsSystem;
    readonly stats: Stats;

    private readonly cm: ClipMap;

    /**
     * The query half, shared with `PhysicsWorld`.
     *
     * This harness used to carry its own copy of the trace so that a coordinate
     * bug could not cancel itself out of the measurement. The reasoning was
     * thin -- the real independence is the bit-exact clipmap control -- and the
     * duplication twice reported healthy numbers for code the browser was not
     * running (D-036, D-061). Body construction still differs, because there is
     * no ECS here; the query does not.
     */
    private readonly queries: PhysicsTrace;

    constructor(cm: ClipMap) {
        this.cm = cm;
        this.system = new PhysicsSystem();
        this.queries = new PhysicsTrace(this.system, cm);

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
        let entity = 1;

        for (const hull of set.hulls) {
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
                continue;
            }

            const body = new RigidBody();
            body.kind = BodyKind.Static;

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

            const id = entity++;
            this.system.link(body, transform, id);
            this.system.attach_collider(id, collider as unknown as Collider, transform, id);
            // `link` stamps the packed body id onto the component.
            this.queries.register(id, (body as unknown as { _bodyId: number })._bodyId, hull);

            bodies += 1;
        }

        this.stats = {
            bodies,
            skipped: set.skipped,
            hullMilliseconds: set.milliseconds,
            bodyMilliseconds: performance.now() - t0,
        };
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
