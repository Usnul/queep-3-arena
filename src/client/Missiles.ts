/*
 * Missiles.ts -- rockets, plasma and grenades, as physics bodies.
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
 * `G_RunMissile`, handed to the engine.
 *
 * What this replaces is a loop in `WeaponSystem.update` that integrated each
 * projectile by hand, traced the segment through the ported clipmap, and then
 * ran a slab-method ray/AABB test against every `Damageable` in the level to see
 * whether it had passed through one. Fifty-five lines of integrator plus
 * forty-eight of intersection, all of it a worse version of what a physics
 * engine is.
 *
 * A missile is now an entity: `Transform`, `RigidBody`, `Collider`,
 * `Interpolated`. The engine integrates it, sweeps it, and says what it hit.
 *
 *   Q3                          meep
 *   ──                          ────
 *   `s.pos.trType = TR_LINEAR`  `BodyKind.Dynamic`, `gravityScale = 0`
 *   `G_RunMissile`'s trace      `RigidBodyFlags.CCD`
 *   `G_MissileImpact`           `PhysicsEvents.ContactBegin`
 *   `svFlags` owner skip        a contact filter on the owner's own body
 *   client-side interpolation   `Interpolated`, blended by the engine
 *
 * **Why CCD is not optional here.** A plasma bolt travels 2,000 units a second,
 * which is 33 units in one 16.7 ms step -- wider than the 30-unit player box it
 * is aimed at, and wider than plenty of Q3 walls. Without a swept test the
 * discrete narrowphase samples the two ends of that step and finds nothing in
 * between. It is also why a character's body is solid rather than a sensor: a
 * CCD sweep passes straight through a sensor, so a "correct" sensor body would
 * have been a body plasma flew through.
 *
 * **A contact is a hit, and that is the whole of it.** Between 3.4.0 and 3.5.0 it
 * was not: meep reported a `ContactBegin` between a sphere and a
 * `ConvexHullShape3D` across up to 0.01 m of clear air, so this file grew a
 * confirming sweep -- re-run the segment the missile had just flown and see
 * whether it really reached what the contact named. Fixed in 3.6.0, and the
 * sweep came out again in 3.7.0. `test/convex-contact.test.ts` is what watches
 * the fix.
 *
 * It is worth knowing why that workaround could not simply be left in as
 * insurance, because "harmless extra check" was exactly what it looked like. A
 * missile that *grazes* a body is touching it at depth zero while moving
 * **along** its surface: CCD clamps the blocked axis and the rest of the
 * velocity carries on, so the segment swept between two steps never enters the
 * thing it is already resting against, and the sweep says no. Ten of twenty-three
 * rockets in the 64-direction test were rejected that way and slid down the side
 * of the player they had hit. A guard that answers "did it arrive" cannot
 * recognise a hit that has already arrived.
 *
 * A second workaround lived here just as briefly. Through 3.7.0 a body that CCD
 * stopped against a hull's *corner* raised no contact at all -- face-on it did,
 * at 45 degrees it did not -- so this file inferred the impact instead: a
 * `TR_LINEAR` missile that covered less than its own speed in a step had hit
 * something, and `PhysicsSystem.overlap` a unit wider than the missile said
 * what. 3.8.0 raises the corner contact and that inference is gone too. Both
 * removals were signalled by `test/convex-contact.test.ts` failing, which is
 * what it is for.
 *
 * **Grenades do not arc, and that is the balance table's doing rather than
 * this file's.** Q3's `fire_grenade` sets `TR_GRAVITY` and a bounce; the
 * extracted table (`balance.generated.json`, guarded by
 * `extract-balance --check`) carries speed, damage and splash and no gravity
 * field, so every projectile in this port has flown straight since it shipped.
 * The engine side is now one number each -- `gravityScale` and
 * `Collider.restitution` -- which is worth recording as a facility that is
 * present and unused rather than quietly wiring a balance change.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { RigidBodyFlags } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBodyFlags.js';
import { ColliderFlags } from '@woosh/meep-engine/src/engine/physics/ecs/ColliderFlags.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { PhysicsEvents } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsEvents.js';
import { SphereShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';

import type { CharacterBodies } from './CharacterBody.ts';
import { LAYER_MISSILE, MISSILE_MASK } from './layers.ts';
import type { MissileImpact, MissileWorld, Projectile } from '../game/Weapons.ts';
import { vec3 } from '../q3/math.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

/**
 * A missile's collision radius, in Q3 units.
 *
 * Q3's own missiles are points -- `fire_rocket` leaves `mins`/`maxs` at zero and
 * relies on a segment trace -- and a point has no support function to sweep, so
 * this is the smallest sphere GJK can work with rather than a size chosen for
 * looks. Half a unit, and it started at two: a missile is a *volume* here where
 * Q3's is not, so it clips geometry a point would clear, and every unit of
 * radius is a unit of that. The rocket model is about 8 units across, so
 * nothing about this is visible.
 */
const MISSILE_RADIUS = 0.5;

/** The dataset methods a missile needs. */
interface MissileDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    entityExists(entity: number): boolean;
    removeEntity(entity: number): void;
    addEntityEventListener(entity: number, name: string, listener: unknown): void;
}

/** The part of `PhysicsSystem` this drives. */
interface MissilePhysics {
    setContactFilter(
        fn: (entityA: number, entityB: number, colliderA: unknown, colliderB: unknown) => boolean
    ): void;
}

interface Flight {
    readonly projectile: Projectile;
    readonly entity: number;
    readonly transform: Transform;
    /** Set the moment a contact is reported, so a pair cannot detonate twice. */
    spent: boolean;
}

/** No pair is refused unless a missile is one half of it. */
const ACCEPT = true;


export class Missiles implements MissileWorld {
    private readonly physics: MissilePhysics;

    private readonly ecd: MissileDataset;

    private readonly bodies: CharacterBodies | null;
    private readonly flights = new Map<number, Flight>();

    /**
     * Raised once per missile, with the impact `WeaponSystem` needs to do damage.
     *
     * The weapon code deals in Q3 client ids and knows nothing about entities,
     * so the translation happens here -- see `CharacterBodies.clientOf`.
     */
    onImpact: ((impact: MissileImpact) => void) | null = null;

    /** Missile entity -> the Q3 client that fired it, for the owner filter. */
    private readonly owners = new Map<number, number>();

    constructor(
        physics: MissilePhysics,
        ecd: MissileDataset,
        bodies: CharacterBodies | null
    ) {
        this.physics = physics;
        this.ecd = ecd;
        this.bodies = bodies;

        /*
         `CalcMuzzlePoint` puts the muzzle 14 units in front of the eye and a Q3
         player box is 30 wide, so every missile is created *inside* the person
         who fired it. Q3 handles that with `ent->r.ownerNum` and a `svFlags`
         skip; meep's equivalent is the contact filter, which the narrowphase and
         the CCD sweep both consult.

         Installed here because nothing else in this port sets one -- if that
         changes, this has to become a chain rather than an assignment.
        */
        physics.setContactFilter((entityA, entityB): boolean => {
            return this.allows(entityA, entityB) && this.allows(entityB, entityA);
        });

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(RigidBody)) ecd.registerComponentType(RigidBody);
        if (!ecd.isComponentTypeRegistered(Collider)) ecd.registerComponentType(Collider);
    }

    get inFlight(): number {
        return this.flights.size;
    }

    /** The entity a projectile is flying as, or -1. For the view and for tests. */
    entityOf(projectileId: number): number {
        return this.flights.get(projectileId)?.entity ?? -1;
    }

    launch(projectile: Projectile): void {
        const transform = new Transform();
        transform.position.set(
            projectile.origin[0]! * WORLD_SCALE,
            projectile.origin[2]! * WORLD_SCALE,
            -projectile.origin[1]! * WORLD_SCALE
        );

        const body = new RigidBody();
        body.kind = BodyKind.Dynamic;
        body.mass = 1;
        /*
         Q3 missiles are `TR_LINEAR`: constant velocity, no gravity, no drag.
         The balance table carries no gravity field for any weapon (see the
         header), so this is every projectile in the port.
        */
        body.gravityScale = 0;
        body.linearDamping = 0;
        body.layer = LAYER_MISSILE;
        /*
         `MASK_SHOT`, expressed once as a layer mask instead of per trace. The
         omission that matters is `LAYER_PLAYERCLIP`: Q3 shoots straight through
         a player-clip brush and the level's bodies are built to stop players,
         so without the distinction a rocket detonates on an invisible fence.
        */
        body.mask = MISSILE_MASK;
        // Not optional at these speeds -- see the header.
        body.flags = RigidBodyFlags.CCD;
        body.linearVelocity.set(
            projectile.velocity[0]! * WORLD_SCALE,
            projectile.velocity[2]! * WORLD_SCALE,
            -projectile.velocity[1]! * WORLD_SCALE
        );

        const collider = new Collider() as unknown as {
            shape: unknown;
            friction: number;
            restitution: number;
            flags: number;
        };
        collider.shape = SphereShape3D.from(MISSILE_RADIUS * WORLD_SCALE);
        collider.friction = 0;
        // Q3's grenade bounces and this port's does not; see the header.
        collider.restitution = 0;
        /*
         Contacts, but no impulse -- which is both Q3's missile and the only way
         to be sure a *phantom* contact cannot move one.

         A Q3 missile is `TR_LINEAR`: it flies in a straight line at a constant
         speed until something stops it, and nothing ever pushes it off course.
         Here that is not just fidelity: the false contacts described in the
         header are reported with a positive depth, so the solver dutifully
         pushes the missile apart from a wall it never touched. The detonation is
         caught by the confirming sweep; the shove was not, and it deflected
         rockets far enough over a 120-unit flight to miss a player.

         The body stays `Dynamic` because CCD is Dynamic-only
         (`ccd/linear_sweep.js` skips every other kind), and without the sweep a
         plasma bolt goes through people. The sensor flag is on the *collider*
         rather than the body for exactly that reason: `RigidBodyFlags.IsSensor`
         would make the body itself a non-blocker, while this leaves the sweep
         and the events intact and only takes the solver out.
        */
        collider.flags = ColliderFlags.IsSensor;

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            .build(this.ecd as never);

        const flight: Flight = {
            projectile,
            entity: builder.id,
            transform,
            spent: false,
        };
        this.flights.set(projectile.id, flight);
        this.owners.set(builder.id, projectile.ownerId);

        /*
         The missile has to be transparent to the characters' own sweeps.
         meep's queries consult the filter callback and nothing else -- not
         `layer`, not `mask` -- so without this a rocket crossing a corridor is
         a wall to everyone in it.
        */
        this.bodies?.passThrough(builder.id);

        this.ecd.addEntityEventListener(
            builder.id,
            PhysicsEvents.ContactBegin,
            (payload: {
                entityA: number;
                entityB: number;
                point: ArrayLike<number>;
                normal: ArrayLike<number>;
            }): void => {
                this.impact(flight, payload);
            }
        );
    }

    /**
     * `G_FreeEntity`: take a missile out of the world.
     *
     * Idempotent, because a missile can leave two ways -- it detonated, or its
     * ten seconds ran out -- and the first raises an event that the second is
     * still walking towards.
     */
    retire(projectile: Projectile): void {
        const flight = this.flights.get(projectile.id);
        if (flight === undefined) return;

        this.flights.delete(projectile.id);
        this.owners.delete(flight.entity);
        this.bodies?.forget(flight.entity);

        if (this.ecd.entityExists(flight.entity)) this.ecd.removeEntity(flight.entity);
    }

    /**
     * Copy every live missile's pose back into its `Projectile`.
     *
     * The simulation still owns the projectile record -- `WeaponSystem` ages it
     * and the view draws a trail from it -- so the one thing that has moved from
     * this side to the engine's is *where it is*. Once per fixed step, after the
     * step that integrated it.
     */
    sync(): void {
        for (const flight of this.flights.values()) {
            const p = flight.transform.position;

            flight.projectile.origin[0] = p.x / WORLD_SCALE;
            flight.projectile.origin[1] = -p.z / WORLD_SCALE;
            flight.projectile.origin[2] = p.y / WORLD_SCALE;
        }
    }

    /**
     * May `missile` touch `other`? False only when `other` is the client that
     * fired it.
     */
    private allows(missile: number, other: number): boolean {
        const owner = this.owners.get(missile);
        if (owner === undefined) return ACCEPT;

        const client = this.bodies?.clientOf(other) ?? -1;
        return client !== owner;
    }

    /** `G_MissileImpact`, from a contact rather than from a trace. */
    private impact(
        flight: Flight,
        payload: {
            entityA: number;
            entityB: number;
            point: ArrayLike<number>;
            normal: ArrayLike<number>;
        }
    ): void {
        /*
         One detonation per missile. A step can report several contacts for one
         body -- a rocket into a corner touches two walls -- and Q3 detonates
         once.
        */
        if (flight.spent) return;
        flight.spent = true;

        const other = payload.entityA === flight.entity ? payload.entityB : payload.entityA;
        const clientId = this.bodies?.clientOf(other) ?? -1;

        /*
         Where the missile got to, which is `G_MissileImpact`'s `trace.endpos`:
         the CCD sweep has already clamped the body to its blocker, so its own
         pose is the impact. Not the manifold's contact point -- meep's contacts
         are speculative, and a pair reported at zero depth carries the closest
         points on the two bodies rather than a touch, whose midpoint can sit
         several units past the surface. Measured at 9 units inside a wall.
        */
        const at = flight.transform.position;

        /*
         The missile's own stopped position, not the contact point.

         `G_MissileImpact` detonates at `trace.endpos` -- where the missile got
         to -- and the CCD sweep has already put the body exactly there, clamped
         to the first blocker along the step. The manifold's point is something
         else: meep's contacts are speculative, so a pair reported with zero
         depth carries the *closest points on the two bodies* rather than a
         touch, and their midpoint can sit several units past the surface. Using
         it put a rocket's explosion 9 units inside the wall it hit, measured
         against the ported `cm_trace`'s answer for the same shot.

         Everything is still copied out of the payload before this returns: the
         engine documents it as valid only for the dispatch, and reuses one
         scratch object for every contact in the step.
        */
        this.report(flight, clientId, payload.normal);
    }

    /** Hand `WeaponSystem` the impact, in the Q3 terms it deals in. */
    private report(
        flight: Flight,
        clientId: number,
        normal: ArrayLike<number> | null
    ): void {
        const at = flight.transform.position;

        const impact: MissileImpact = {
            projectile: flight.projectile,
            atQ3: vec3(at.x / WORLD_SCALE, -at.z / WORLD_SCALE, at.y / WORLD_SCALE),
            /*
             A surface normal is what a scorch mark is oriented by, and a player
             is not a surface -- Q3 draws no mark on a direct hit either. Nor is
             there one for a missile that simply stopped, which is why `blocked`
             passes none.
            */
            normalQ3:
                normal === null || clientId >= 0
                    ? null
                    : vec3(normal[0]!, -normal[2]!, normal[1]!),
            clientId,
        };

        this.onImpact?.(impact);
    }
}
