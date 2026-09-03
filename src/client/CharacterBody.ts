/*
 * CharacterBody.ts -- players and bots, as things the broadphase can see.
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
 * Until phase 9 the only bodies in this port were the level: `KinematicMover`
 * used the physics system purely as a query service, and a player was a box that
 * existed nowhere except inside pmove. That is why shooting one meant a
 * hand-written ray/AABB test over an array, why splash damage was a loop over
 * the same array, and why two players could stand in the same place.
 *
 * A character is an entity now: `Transform`, `RigidBody`, `Collider`. Three
 * things follow, and the third is the one that needed thinking about.
 *
 * **The body is solid, not a sensor, and the reason is tunnelling.**
 * `RigidBodyFlags.IsSensor` was the obvious choice -- contacts detected, no
 * impulse, which is Q3's "a rocket detonates on you and does not bounce off
 * you". It is wrong here, because CCD sweeps pass straight through sensors
 * (`ccd/linear_sweep.js`: *sensors are not solid surfaces*), and a plasma bolt
 * at 2,000 units per second covers 33 units in one 16.7 ms step against a
 * 30-unit-wide player box. It would go through people.
 *
 * Solid costs nothing, because `layer`/`mask` already say a character pairs
 * with missiles and nothing else: never the world, never another character. The
 * only pair the solver can build is missile-against-character, and the missile
 * is destroyed by the contact event it raises in that same step, so whatever
 * impulse it was given in between is discarded with it. And a player is still
 * never shoved, because pmove decides where a player goes -- the body is driven
 * by `setPose` and the solver cannot move a kinematic one.
 *
 * **Characters still block each other**, which is `CONTENTS_BODY` and is new
 * here. It works *because* meep's queries honour only the filter callback:
 * `KinematicMover`'s sweep does not consult `layer`/`mask` and does not skip
 * sensors, so another character's collider stops a slide even though the solver
 * would never push it. The player's own body has to be excluded, and that is
 * what `moveFilter` is for.
 *
 * **A crouched character keeps its standing box.** Q3 shortens `maxs[2]` from
 * 32 to 16 while ducked, and swapping a live `Collider.shape` per step is not
 * something the collider observer is built for. The cost is that a crouching
 * player is 16 units over-tall to a rocket and to another player; pmove's own
 * movement is unaffected, because `MeepMove` picks its posture shape itself.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { RigidBody } from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider } from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind } from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';

import { footedBox, STAND_MAXS, STAND_MINS, type MoverHost } from './MeepMove.ts';
import { LAYER_CHARACTER, LAYER_MISSILE } from './layers.ts';

/** Scene metres per Q3 unit. */
const WORLD_SCALE = 1 / 32;

/** The dataset methods this needs, named so the headless harness satisfies them. */
export interface BodyDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    /** Both needed by {@link CharacterBodies.destroy}; see there for why. */
    entityExists(entity: number): boolean;
    removeEntity(entity: number): void;
}

/** One character's body: the entity it is, and the host its solver should use. */
export interface CharacterSlot {
    readonly entity: number;
    /** Pass this to `PlayerController` or `Bot` in place of the shared host. */
    readonly host: MoverHost;
    /**
     * Say where this character is, once it exists.
     *
     * Separate from creation because the body has to exist before the controller
     * that owns it does -- the controller takes the host, and the host carries a
     * filter that names the body.
     */
    track(originQ3: () => ArrayLike<number>): void;
}

interface Entry {
    readonly entity: number;
    readonly body: RigidBody;
    /** Q3 client id, so a contact can be turned back into a `Damageable`. */
    readonly clientId: number;
    originQ3: (() => ArrayLike<number>) | null;
}

/** The part of `PhysicsSystem` this drives. Named so a stub can stand in. */
interface PoseWriter {
    setPose(
        body: RigidBody,
        position: { x: number; y: number; z: number },
        rotation: { x: number; y: number; z: number; w: number }
    ): void;
}

/** A Q3 player box never rotates, so every pose written here is the same one. */
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

export class CharacterBodies {
    private readonly base: MoverHost;
    private readonly ecd: BodyDataset;
    private readonly entries: Entry[] = [];

    /**
     * The level's trace ignore set, if the caller wired one.
     *
     * `PhysicsTrace` answers `pm->trace`, a bot's line of sight and an item's
     * drop, and none of those wants to find a character: movement resolves
     * characters through `KinematicMover`'s own sweep and its own filter. Not
     * registering here is not subtle -- it made every bot's line of sight end on
     * its own collider, so no bot ever saw the player.
     */
    private readonly traceIgnores: Set<number> | null;

    /**
     * Entities every character's sweeps must pass straight through.
     *
     * Missiles, once they are bodies (they are not yet). A rocket flying past
     * your face is not a wall, and meep's queries do not consult `layer`/`mask`
     * to work that out -- only this.
     */
    private readonly transparent = new Set<number>();

    constructor(base: MoverHost, ecd: BodyDataset, traceIgnores: Set<number> | null = null) {
        this.base = base;
        this.ecd = ecd;
        this.traceIgnores = traceIgnores;

        if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
        if (!ecd.isComponentTypeRegistered(RigidBody)) ecd.registerComponentType(RigidBody);
        if (!ecd.isComponentTypeRegistered(Collider)) ecd.registerComponentType(Collider);
    }

    get count(): number {
        return this.entries.length;
    }

    /**
     * The Q3 client id behind a body, or -1 if the entity is not a character.
     *
     * This is the whole of what the weapon code needs from the ECS: a contact
     * names two entities, and `WeaponSystem` deals in client ids and knows
     * nothing about either. Keeping the translation here is what lets the
     * damage rules stay ECS-free and headless.
     */
    clientOf(entity: number): number {
        for (const entry of this.entries) if (entry.entity === entity) return entry.clientId;
        return -1;
    }

    /**
     * Mark an entity as something a character walks through, and something the
     * level's traces ignore -- see `transparent` and `traceIgnores`.
     *
     * Missiles. A rocket crossing a corridor is neither a wall to the people in
     * it nor an obstruction in anyone's line of sight.
     */
    passThrough(entity: number): void {
        this.transparent.add(entity);
        this.traceIgnores?.add(entity);
    }

    forget(entity: number): void {
        this.transparent.delete(entity);
        this.traceIgnores?.delete(entity);
    }

    create(clientId: number): CharacterSlot {
        const transform = new Transform();

        const body = new RigidBody();
        /*
         `KinematicVelocity` and not `KinematicPosition`: the latter is reserved
         and not implemented, and its own docblock says to prefer this one until
         it lands. The velocity stays zero -- `sync` writes the pose through
         `setPose` every step, and nothing is ever integrated.
        */
        body.kind = BodyKind.KinematicVelocity;
        body.layer = LAYER_CHARACTER;
        /*
         Missiles only, and this is what makes "solid" free. A character needs no
         contacts against the world -- the mover resolves that with queries --
         and two characters touching should raise nothing, because blocking each
         other is the sweep's job and a manifold would be a second, redundant
         answer that the solver could act on.
        */
        body.mask = LAYER_MISSILE;

        /*
         The same `footedBox` the mover sweeps with, imported rather than
         rebuilt: two constructions of one box is two things that can stop
         agreeing, and the one that would drift is the one nothing draws.
        */
        const collider = new Collider() as unknown as { shape: unknown; friction: number };
        collider.shape = footedBox(STAND_MINS, STAND_MAXS);
        collider.friction = 0;

        const builder = new Entity();
        builder
            .add(transform)
            .add(body)
            .add(collider as unknown as Collider)
            .build(this.ecd as never);

        const entry: Entry = { entity: builder.id, body, clientId, originQ3: null };
        this.entries.push(entry);
        this.traceIgnores?.add(entry.entity);

        return {
            entity: entry.entity,
            host: {
                system: this.base.system,
                ecd: this.base.ecd,
                moveFilter: this.filterFor(entry.entity),
            },
            track: (originQ3): void => {
                entry.originQ3 = originQ3;
            },
        };
    }

    /**
     * Take one character's body away, for a player who has left.
     *
     * There was no such method while the pool was fixed: sixteen bodies existed
     * from the first frame and an unoccupied one was *parked* a million units
     * below the map rather than destroyed, because destroying it would have
     * meant re-creating it for the next occupant and the pool's whole point was
     * that nothing was created. Bodies now come and go with their players
     * (D-194), so this is the other half of {@link create}.
     *
     * The `traceIgnores` entry goes with it, which matters more than it looks:
     * a stale ignore is a filter that keeps skipping an entity id the physics
     * world has since handed to something else.
     */
    destroy(entity: number): void {
        const at = this.entries.findIndex((e) => e.entity === entity);
        if (at < 0) return;

        this.entries.splice(at, 1);
        this.traceIgnores?.delete(entity);
        if (this.ecd.entityExists(entity)) this.ecd.removeEntity(entity);
    }

    /**
     * Write every character's pose from the simulation. Once per fixed step,
     * after the movement that produced it.
     *
     * Through `setPose` rather than by writing the transform, and the difference
     * is a whole step of staleness. A kinematic body's broadphase leaf is
     * refitted during `PhysicsSystem.fixedUpdate`, which the scheduler runs
     * *before* every system in this application -- so a transform written here
     * would not reach the BVH until the next step, and every sweep this step
     * would resolve against where the characters were last time. `setPose`
     * re-homes the leaves as it goes, so a player and the bot they are walking
     * into agree about where they both are.
     *
     * It is safe for these bodies specifically. `setPose` also flags `snap` on
     * an `Interpolated` component, which the engine documents as interacting
     * badly with a wired `InterpolationSystem` -- and a character's collision
     * body carries no `Interpolated`, because the thing that gets drawn is the
     * separate entity `Character` owns.
     */
    sync(): void {
        const physics = this.base.system as PoseWriter;

        for (const entry of this.entries) {
            const origin = entry.originQ3?.();
            if (origin === undefined) continue;

            /*
             Q3 (x, y, z) -> meep (x, z, -y), with the box lifted so the shape's
             own origin is the sole -- `footedBox`'s contract, and the same
             correction `MeepMove.toMeep` applies. `ps.origin` sits 24 units
             above the feet.
            */
            SCRATCH_POSE.x = origin[0]! * WORLD_SCALE;
            SCRATCH_POSE.y = (origin[2]! + STAND_MINS[2]!) * WORLD_SCALE;
            SCRATCH_POSE.z = -origin[1]! * WORLD_SCALE;

            physics.setPose(entry.body, SCRATCH_POSE, NO_ROTATION);
        }
    }

    /**
     * What `owner`'s sweeps may hit: everything except itself and anything
     * marked to pass through.
     *
     * Other characters are deliberately absent from the exclusions. Q3 has
     * `CONTENTS_BODY` and this port never did, because there was nothing in the
     * broadphase to block with; there is now.
     */
    private filterFor(owner: number): (entity: number, collider: unknown) => boolean {
        const transparent = this.transparent;
        return (entity: number): boolean => entity !== owner && !transparent.has(entity);
    }
}

/** Reused: `setPose` reads it and does not keep it. */
const SCRATCH_POSE = { x: 0, y: 0, z: 0 };

/** The standing box, in Q3 units, for callers that need it without the shape. */
export const CHARACTER_MINS = STAND_MINS;
export const CHARACTER_MAXS = STAND_MAXS;

/**
 * How tall a player stands, in scene metres: 56 Q3 units, so 1.75 m.
 *
 * Here rather than at either call site because it is the *ruler* the two baked
 * volumes are sized against -- the acoustic probe field's spacing and the
 * volumetric lightmap's -- and a length written out twice is a length that can
 * come to disagree with the box it describes. Both want a grade of about half
 * of it: a step, a doorway and a crouch are all roughly that, and a volume
 * sampled coarser than a player is tall cannot tell the inside of a tunnel from
 * the hall it opens onto. See `PROBE_SPACING` and `LIGHTMAP_CELL_SIZE`.
 */
export const CHARACTER_HEIGHT = (STAND_MAXS[2]! - STAND_MINS[2]!) * WORLD_SCALE;
