/*
 * DamageQueries.ts -- who is in the blast, and what the bullet went through.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * `trap_EntitiesInBox` and `CanDamage`, answered by the broadphase instead of by
 * a loop over an array.
 *
 * D-067's trap matrix recorded `trap_EntitiesInBox` as a `workaround` -- "the
 * port keeps its own arrays and tests AABBs directly ... at 31 items and 6 brush
 * entities a broadphase costs more than it saves ... worth recording as a
 * facility correctly *not* used". That was true when nothing damageable existed
 * in the broadphase. Characters have had bodies since phase 9's step 5, so the
 * trade has reversed and the row moves to `mapped`.
 *
 * Three queries, and each is one engine call:
 *
 *   Q3                              meep
 *   ──                              ────
 *   `trap_EntitiesInBox` + splash   `overlap` with a `SphereShape3D`
 *   `CanDamage`'s `MASK_SOLID`      `raycast`, characters filtered out
 *   `Bullet_Fire` against clients   `raycast`, characters only
 *
 * **`raycast` and not `shapeCast`**, which is worth a note because
 * `PhysicsSystem.raycast`'s own docblock argues against it: it says the result is
 * "the distance to the leaf's inflated AABB", exact only for AABB colliders. That
 * docblock is stale. `queries/raycast.js` refines every hit against the true
 * shape -- "the convex primitives, the convex hull, the concave mesh / heightmap,
 * and the wrappers" -- and measurement agrees: 224 rays fired from every spawn on
 * `oa_dm1` against real brushes disagree with the ported, bit-exact `cm_trace` by
 * at most **0.64 units**, and never miss a wall it finds. A ray is cheaper than a
 * sweep and needs no shape, so a line of sight is a ray.
 *
 * **Sensors are skipped by rays**, which the port gets for free in exactly the
 * place it wants: a missile in flight carries `ColliderFlags.IsSensor`, so a
 * rocket crossing a corridor never blocks anyone's line of sight or stops a
 * bullet.
 */

import { SphereShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';
import { Ray3 } from '@woosh/meep-engine/src/core/geom/3d/ray/Ray3.js';
import { PhysicsSurfacePoint } from '@woosh/meep-engine/src/engine/physics/queries/PhysicsSurfacePoint.js';

import type { CharacterBodies } from './CharacterBody.ts';
import type { DamageQuery, HitscanHit } from '../game/Weapons.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

/** The part of `PhysicsSystem` this reads. */
interface QueryablePhysics {
    raycast(
        ray: unknown,
        result: unknown,
        filter?: (entity: number, collider: unknown) => boolean
    ): boolean;
    overlap(
        shape: unknown,
        position: { x: number; y: number; z: number },
        rotation: { x: number; y: number; z: number; w: number },
        output: Uint32Array,
        offset: number,
        filter?: (entity: number, collider: unknown) => boolean
    ): number;
    entityOf(packedBodyId: number): number;
}

const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

/** `G_RadiusDamage` never has many candidates; the count is capped, not grown. */
const MAX_IN_RADIUS = 32;

export class DamageQueries implements DamageQuery {
    private readonly physics: QueryablePhysics;
    private readonly bodies: CharacterBodies;

    /** Reused: both engine queries are output-parameter APIs. */
    private readonly hit = new PhysicsSurfacePoint();
    private readonly found = new Uint32Array(MAX_IN_RADIUS);

    /** Reused per call; `SphereShape3D.radius` is writable. */
    private readonly blast = SphereShape3D.from(1) as unknown as { radius: number };

    constructor(physics: QueryablePhysics, bodies: CharacterBodies) {
        this.physics = physics;
        this.bodies = bodies;
    }

    /**
     * `trap_EntitiesInBox`: every client whose body is inside the blast.
     *
     * A sphere rather than Q3's box, because the falloff `G_RadiusDamage`
     * applies is radial anyway -- a box would hand the caller corners it is
     * about to reject.
     */
    clientsInRadius(atQ3: ArrayLike<number>, radiusQ3: number, out: number[]): number {
        this.blast.radius = radiusQ3 * WORLD_SCALE;

        const count = this.physics.overlap(
            this.blast,
            {
                x: atQ3[0]! * WORLD_SCALE,
                y: atQ3[2]! * WORLD_SCALE,
                z: -atQ3[1]! * WORLD_SCALE,
            },
            NO_ROTATION,
            this.found,
            0,
            this.isCharacter
        );

        let written = 0;
        for (let i = 0; i < count; i++) {
            const client = this.bodies.clientOf(this.physics.entityOf(this.found[i]!));
            if (client >= 0) out[written++] = client;
        }

        return written;
    }

    /**
     * `CanDamage`: is there an unobstructed path from the blast to a point?
     *
     * Q3 traces this with `MASK_SOLID`, which does not include `CONTENTS_BODY` --
     * a player standing between an explosion and you does not shield you -- so
     * characters are filtered out rather than merely not sought.
     */
    visible(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>): boolean {
        const length = this.aim(fromQ3, toQ3);
        if (length <= 0) return true;

        return !this.physics.raycast(RAY, this.hit, this.notCharacter);
    }

    /**
     * `Bullet_Fire` against the client list: the nearest character a shot passes
     * through, and how far along the segment it was.
     *
     * The world is not consulted here. `WeaponSystem` traces that against the
     * ported `cm_trace`, which is bit-exact and carries Q3's own surface flags --
     * `SURF_NOIMPACT` decides whether a bullet leaves a mark -- and it takes the
     * nearer of the two answers.
     */
    hitscan(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>, ownerId: number): HitscanHit | null {
        const length = this.aim(fromQ3, toQ3);
        if (length <= 0) return null;

        const notOwner = (entity: number): boolean => {
            const client = this.bodies.clientOf(entity);
            return client >= 0 && client !== ownerId;
        };

        if (!this.physics.raycast(RAY, this.hit, notOwner)) return null;

        const distance = (this.hit as unknown as { t: number }).t;
        const entity = (this.hit as unknown as { entity: number }).entity;

        const clientId = this.bodies.clientOf(entity);
        if (clientId < 0) return null;

        return { clientId, fraction: distance / length };
    }

    /** Point `RAY` from one Q3 position to another; returns the length in metres. */
    private aim(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>): number {
        const x = (toQ3[0]! - fromQ3[0]!) * WORLD_SCALE;
        const y = (toQ3[2]! - fromQ3[2]!) * WORLD_SCALE;
        const z = -(toQ3[1]! - fromQ3[1]!) * WORLD_SCALE;

        const length = Math.hypot(x, y, z);
        if (length <= 0) return 0;

        RAY[0] = fromQ3[0]! * WORLD_SCALE;
        RAY[1] = fromQ3[2]! * WORLD_SCALE;
        RAY[2] = -fromQ3[1]! * WORLD_SCALE;
        RAY[3] = x / length;
        RAY[4] = y / length;
        RAY[5] = z / length;
        RAY.tMax = length;

        return length;
    }

    private readonly isCharacter = (entity: number): boolean =>
        this.bodies.clientOf(entity) >= 0;

    private readonly notCharacter = (entity: number): boolean =>
        this.bodies.clientOf(entity) < 0;
}

/** One ray, reused. Every query here is synchronous and none of them nest. */
const RAY = Ray3.from(0, 0, 0, 1, 0, 0, 1) as unknown as Float32Array & { tMax: number };
