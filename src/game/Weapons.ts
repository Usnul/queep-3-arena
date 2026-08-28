/*
 * Weapons.ts -- firing, projectiles and damage.
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
 * Ported in shape from `g_weapon.c` and `g_missile.c`, with the numbers coming
 * from `balance.generated.json` rather than being retyped. Everything here runs
 * in **Q3 units and Q3 axes**, like the rest of the simulation: it traces
 * against the same `ClipMap` that movement does, so a rocket and a player see
 * the same walls.
 *
 * Presentation is a separate concern -- this module raises events and something
 * else decides what they look like.
 */

import { boxTrace, pointContents, createTrace, type TraceResult } from '../q3/cm/trace.ts';
import { ClipMap, MASK_SOLID, CONTENTS, SURF } from '../q3/cm/ClipMap.ts';
import { vec3, angleVectors, vectorMA, normalize, copy, type Vec3 } from '../q3/math.ts';
import balance from './balance.generated.json' with { type: 'json' };

export type WeaponId = keyof typeof balance.weapons;

/** `MASK_SHOT` from q_shared.h. */
export const MASK_SHOT = CONTENTS.SOLID | CONTENTS.BODY | CONTENTS.CORPSE;

/** `g_combat.c`: the fraction of damage armour takes before health does. */
export const ARMOR_PROTECTION = 0.66;

export interface WeaponStats {
    readonly hitscan?: boolean;
    readonly fireRateMs: number;
    readonly damage: number;
    readonly splashDamage?: number;
    readonly splashRadius?: number;
    readonly speed?: number;
    readonly spread?: number;
    readonly pellets?: number;
    readonly range?: number;
}

export function weaponStats(id: WeaponId): WeaponStats {
    const stats = balance.weapons[id] as WeaponStats | undefined;

    /*
     Unreachable by way of `isWeaponId`, and loud for anything that got here
     without it. The alternative is this signature lying: `undefined` reads as a
     `WeaponStats`, travels as far as `stats.hitscan` in `fire`, and reports a
     shot that went wrong rather than a weapon that has no numbers.
    */
    if (stats === undefined) throw new Error(`no balance entry for weapon "${id}"`);

    return stats;
}

/**
 * Whether `tag` names a weapon this port fires.
 *
 * `bg_itemlist` is the wider list, and deliberately so: OA ships a
 * `weapon_nailgun` and a `weapon_grapplinghook` that `balance.weapons` has no
 * entry for, because there is nothing in the sources for `extract-balance.mjs`
 * to read -- `fire_nail` draws a fresh random speed for every nail, and the hook
 * is not a damage weapon at all. Maps place them regardless (`am_thornish` has
 * two nailguns), so this is the crossing an item tag, a saved setting or any
 * other outside string has to make before it can be a `WeaponId`.
 */
export function isWeaponId(tag: string): tag is WeaponId {
    return Object.hasOwn(balance.weapons, tag);
}

/** Anything a shot can hit and hurt. */
export interface Damageable {
    readonly id: number;
    /** Centre, Q3 coordinates. */
    readonly origin: Vec3;
    readonly mins: Vec3;
    readonly maxs: Vec3;
    health: number;
    /** Set when health reaches zero. */
    dead: boolean;
    /**
     * Armour, if this thing wears any. Absent on scenery.
     *
     * `G_Damage` sends two thirds of every hit to armour before health, which
     * is what makes 100 armour worth roughly 200 effective health and is the
     * reason a Q3 player runs a route rather than camping.
     */
    armor?: number;
}

/** What the presentation layer is told about. */
export interface WeaponEvents {
    /**
     * A shot was fired, at the muzzle `CalcMuzzlePoint` computes.
     *
     * `ownerId` comes with it because *where* the flash belongs depends on who
     * fired: the local player has a weapon model on screen with a `tag_flash` on
     * it, and nobody else does. This layer has no opinion on that -- it reports
     * the shot and the shooter, and the presentation decides. See D-115.
     */
    muzzleFlash(originQ3: ArrayLike<number>, weapon: WeaponId, ownerId: number): void;
    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void;
    /**
     * `normalQ3` is the surface the missile struck, for the scorch mark. Absent
     * where there is no surface -- a rocket that hit a player in mid-air, or a
     * body detonating -- and the presentation falls back to Q3's up.
     */
    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        normalQ3?: ArrayLike<number>
    ): void;
    hit(target: Damageable, damage: number): void;
    /**
     * A projectile was created, as the entity the physics engine is flying.
     *
     * The entity comes with it so the presentation can hang its model, its
     * interpolation and its fly sound on the body rather than building a second
     * entity and copying a position onto it every step. `-1` when there is no
     * missile world -- see `WeaponSystem`'s constructor.
     */
    projectileSpawned(projectile: Projectile, entity: number): void;
    projectileGone(projectile: Projectile): void;
}

/** What a hitscan shot passed through, and how far along the segment. */
export interface HitscanHit {
    /** The Q3 client id struck. */
    readonly clientId: number;
    /** Position along the shot, 0 at the muzzle and 1 at its range. */
    readonly fraction: number;
}

/**
 * The spatial questions damage asks, answered by whatever collision ships.
 *
 * `src/client/DamageQueries.ts` is the implementation, and it is the broadphase.
 * This interface exists so the damage *rules* stay ECS-free and headless -- which
 * is what lets `match.test.ts` drive a whole deathmatch with a counter in place
 * of the presentation layer.
 *
 * Null is a legal answer for the whole of it: the configurations with no meep
 * physics behind them (the clipmap-only benchmark column) fall back to scanning
 * `WeaponSystem.targets`, which is what the port did everywhere before phase 9.
 */
export interface DamageQuery {
    /**
     * `trap_EntitiesInBox`: the Q3 client ids inside a blast, written into `out`.
     * @returns how many were written.
     */
    clientsInRadius(atQ3: ArrayLike<number>, radiusQ3: number, out: number[]): number;
    /** `CanDamage`: an unobstructed path, world geometry only. */
    visible(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>): boolean;
    /** The nearest client a shot passes through, ignoring the one who fired it. */
    hitscan(
        fromQ3: ArrayLike<number>,
        toQ3: ArrayLike<number>,
        ownerId: number
    ): HitscanHit | null;
}

/** Where a missile stopped, and what stopped it. */
export interface MissileImpact {
    readonly projectile: Projectile;
    readonly atQ3: Vec3;
    /**
     * The surface struck, for the scorch mark, or null when the thing struck
     * was a player -- Q3 draws no mark on a direct hit either.
     */
    readonly normalQ3: Vec3 | null;
    /** The Q3 client id struck directly, or -1 for the world. */
    readonly clientId: number;
}

/**
 * Missiles in flight, which is the engine's job rather than this file's.
 *
 * `src/client/Missiles.ts` is the implementation and the only one; this
 * interface exists so the damage rules stay ECS-free and can be driven from a
 * test with a counter, which is what `match.test.ts` relies on.
 */
export interface MissileWorld {
    launch(projectile: Projectile): void;
    retire(projectile: Projectile): void;
    /** Copy live poses back into the `Projectile` records. Once per fixed step. */
    sync(): void;
    /** The entity a projectile is flying as, or -1. */
    entityOf(projectileId: number): number;
    onImpact: ((impact: MissileImpact) => void) | null;
}

export interface Projectile {
    readonly id: number;
    readonly weapon: WeaponId;
    readonly origin: Vec3;
    readonly velocity: Vec3;
    /** Q3 `think` time: projectiles self-destruct after this many seconds. */
    life: number;
    readonly ownerId: number;
}

/**
 * `Q_crandom` -- Q3's own -1..1 generator, used for weapon spread.
 *
 * Reproduced rather than replaced by `Math.random` because spread is a balance
 * number: shotgun pellets are laid out by this exact sequence in Q3 and a
 * different distribution is a different weapon. Seeded per shot, as the C does.
 */
function crandom(seedRef: { value: number }): number {
    // `Q_random`: (rand() & 0xffff) / 0x10000, with Q3's own LCG.
    seedRef.value = (1664525 * seedRef.value + 1013904223) >>> 0;
    return ((seedRef.value >>> 16) & 0xffff) / 0x10000 * 2 - 1;
}

const t_forward = vec3();
const t_right = vec3();
const t_up = vec3();
const t_end = vec3();
const t_dir = vec3();
const t_muzzle = vec3();
const trace = createTrace();

export class WeaponSystem {
    private readonly cm: ClipMap;
    private readonly events: WeaponEvents;
    private readonly projectiles: Projectile[] = [];
    private nextProjectileId = 1;
    private readonly missiles: MissileWorld | null;
    private readonly queries: DamageQuery | null;

    /** Reused by the splash query; `G_RadiusDamage` never has many candidates. */
    private readonly inRadius: number[] = [];

    /** Everything a shot can hurt, including the player. */
    readonly targets: Damageable[] = [];

    /**
     * Missiles in the air.
     *
     * Read by the presentation for the smoke trail and the fly sound. Their
     * positions are the engine's -- `MissileWorld.sync` copies them back once a
     * step -- so this is a view of physics state rather than of anything this
     * file integrates.
     */
    get liveProjectiles(): readonly Projectile[] {
        return this.projectiles;
    }

    /**
     * @param missiles where projectiles fly. Null leaves projectile weapons
     *   flashing and firing nothing, which is only ever a misconfiguration --
     *   `main.ts` builds a `PhysicsWorld` for missiles even on the clipmap
     *   movement backend, because `?trace=clipmap` selects a *movement* backend
     *   and taking the rockets away with it would make the A/B mean two things.
     */
    constructor(
        cm: ClipMap,
        events: WeaponEvents,
        missiles: MissileWorld | null = null,
        queries: DamageQuery | null = null
    ) {
        this.cm = cm;
        this.events = events;
        this.missiles = missiles;
        this.queries = queries;

        if (missiles !== null) {
            missiles.onImpact = (impact): void => {
                this.onImpact(impact);
            };
        }
    }

    /**
     * Fire `weapon` from `originQ3` along `anglesQ3`.
     *
     * `CalcMuzzlePoint` in the C offsets the muzzle forward and up from the eye;
     * the same offset is applied here so a rocket does not spawn inside the
     * player's own bounding box.
     */
    fire(
        weapon: WeaponId,
        eyeQ3: ArrayLike<number>,
        anglesQ3: ArrayLike<number>,
        ownerId: number,
        seed: number
    ): void {
        const stats = weaponStats(weapon);

        angleVectors(anglesQ3, t_forward, t_right, t_up);

        // `CalcMuzzlePoint`: 14 units forward of the eye.
        copy(t_muzzle, eyeQ3);
        vectorMA(t_muzzle, t_muzzle, 14, t_forward);

        this.events.muzzleFlash(t_muzzle, weapon, ownerId);

        if (stats.hitscan === true) {
            const pellets = stats.pellets ?? 1;
            const spread = stats.spread ?? 0;
            const seedRef = { value: seed >>> 0 };

            for (let i = 0; i < pellets; i++) {
                copy(t_dir, t_forward);

                if (spread > 0) {
                    // `Bullet_Fire`: r and u are scaled by spread/16384 of the
                    // right and up vectors at 8192 units.
                    const r = crandom(seedRef) * spread * 16;
                    const u = crandom(seedRef) * spread * 16;

                    vectorMA(t_end, t_muzzle, 8192 * 16, t_forward);
                    vectorMA(t_end, t_end, r, t_right);
                    vectorMA(t_end, t_end, u, t_up);

                    t_dir[0] = t_end[0]! - t_muzzle[0]!;
                    t_dir[1] = t_end[1]! - t_muzzle[1]!;
                    t_dir[2] = t_end[2]! - t_muzzle[2]!;
                    normalize(t_dir);
                }

                const range = stats.range ?? 8192;
                vectorMA(t_end, t_muzzle, range, t_dir);

                this.hitscanShot(t_muzzle, t_end, stats.damage, ownerId);
            }

            return;
        }

        // Projectile.
        const projectile: Projectile = {
            id: this.nextProjectileId++,
            weapon,
            origin: vec3(t_muzzle[0]!, t_muzzle[1]!, t_muzzle[2]!),
            velocity: vec3(
                t_forward[0]! * (stats.speed ?? 900),
                t_forward[1]! * (stats.speed ?? 900),
                t_forward[2]! * (stats.speed ?? 900)
            ),
            // `G_FreeEntity` at 10 seconds, as `fire_rocket` sets.
            life: 10,
            ownerId,
        };

        this.projectiles.push(projectile);
        this.missiles?.launch(projectile);
        this.events.projectileSpawned(projectile, this.missiles?.entityOf(projectile.id) ?? -1);
    }

    /** One hitscan ray: trace the world, then look for a closer target. */
    private hitscanShot(
        start: ArrayLike<number>,
        end: ArrayLike<number>,
        damage: number,
        ownerId: number
    ): void {
        /*
         The world through the ported `cm_trace`, which is bit-exact and is the
         only thing that carries Q3's surface flags -- `SURF_NOIMPACT` is what
         decides whether a bullet leaves a mark, and the broadphase has no
         opinion about it. The clients come from the collision the game actually
         runs on; the nearer answer wins.
        */
        boxTrace(trace, this.cm, start, end, ZERO, ZERO, MASK_SHOT);

        let bestFraction = trace.fraction;
        let bestTarget: Damageable | null = null;

        if (this.queries !== null) {
            const struck = this.queries.hitscan(start, end, ownerId);

            if (struck !== null && struck.fraction < bestFraction) {
                bestFraction = struck.fraction;
                bestTarget = this.clientOf(struck.clientId);
            }
        } else {
            // No broadphase behind us: the array is the spatial structure.
            for (const target of this.targets) {
                if (target.id === ownerId || target.dead) continue;

                const f = rayBoxFraction(start, end, target);
                if (f !== null && f < bestFraction) {
                    bestFraction = f;
                    bestTarget = target;
                }
            }
        }

        if (bestTarget !== null) {
            this.damage(bestTarget, damage);
            return;
        }

        if (trace.fraction < 1) {
            // `SURF_NOIMPACT` is Q3's "sky and similar leave no mark".
            if ((trace.surfaceFlags & SURF.NOIMPACT) === 0) {
                this.events.bulletImpact(trace.endpos, trace.planeNormal);
            }
        }
    }

    /**
     * Age the projectiles, and read back where the engine has flown them.
     *
     * What used to be here was an integrator: a step of Euler per projectile, a
     * segment trace through the ported clipmap, and a slab-method ray/AABB test
     * against every `Damageable` in the level. All three are the engine's now --
     * `BodyKind.Dynamic` integrates, `RigidBodyFlags.CCD` sweeps, and
     * `PhysicsEvents.ContactBegin` says what was hit (see `client/Missiles.ts`).
     * What is left is Q3's ten-second `G_FreeEntity` timer, which is a rule
     * rather than a motion.
     */
    update(deltaSeconds: number): void {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i]!;

            p.life -= deltaSeconds;
            if (p.life > 0) continue;

            this.projectiles.splice(i, 1);
            this.missiles?.retire(p);
            this.events.projectileGone(p);
        }

        // After the retirements, so a missile that has just left the world does
        // not have a pose copied out of an entity that no longer exists.
        this.missiles?.sync();
    }

    /**
     * `G_MissileImpact`, arriving as a contact instead of as a trace result.
     *
     * The impact names a Q3 client id rather than an entity, which is what lets
     * this file keep knowing nothing about the ECS: the translation from a
     * contact's two entities to a client happens in `Missiles`, against the
     * table `CharacterBodies` already keeps.
     */
    private onImpact(impact: MissileImpact): void {
        const at = impact.projectile.id;

        const index = this.projectiles.findIndex((p) => p.id === at);
        if (index < 0) return;

        const projectile = this.projectiles[index]!;
        this.projectiles.splice(index, 1);
        this.missiles?.retire(projectile);

        let directHit: Damageable | null = null;
        if (impact.clientId >= 0) {
            for (const target of this.targets) {
                if (target.id === impact.clientId && !target.dead) {
                    directHit = target;
                    break;
                }
            }
        }

        this.detonate(
            projectile,
            impact.atQ3,
            directHit,
            impact.normalQ3 ?? undefined
        );
    }

    private detonate(
        projectile: Projectile,
        atQ3: Vec3,
        directHit: Damageable | null,
        surfaceQ3?: ArrayLike<number>
    ): void {
        const stats = weaponStats(projectile.weapon);

        this.events.projectileGone(projectile);
        this.events.explosion(atQ3, stats.splashRadius ?? 100, surfaceQ3);

        if (directHit !== null) {
            this.damage(directHit, stats.damage);
        }

        const splash = stats.splashDamage ?? 0;
        const radius = stats.splashRadius ?? 0;
        if (splash <= 0 || radius <= 0) return;

        /*
         `G_RadiusDamage`: damage falls off linearly with distance from the
         *closest point on the target's bounding box*, not from its centre.
         Using the centre would make large targets take less splash than they
         should, which is a balance change.
        */
        for (const target of this.splashCandidates(atQ3, radius)) {
            if (target.dead) continue;
            if (target === directHit) continue;

            const dx = Math.max(
                0,
                Math.abs(atQ3[0]! - target.origin[0]!) -
                    (target.maxs[0]! - target.mins[0]!) * 0.5
            );
            const dy = Math.max(
                0,
                Math.abs(atQ3[1]! - target.origin[1]!) -
                    (target.maxs[1]! - target.mins[1]!) * 0.5
            );
            const dz = Math.max(
                0,
                Math.abs(atQ3[2]! - target.origin[2]!) -
                    (target.maxs[2]! - target.mins[2]!) * 0.5
            );

            const dist = Math.hypot(dx, dy, dz);
            if (dist >= radius) continue;

            const points = splash * (1.0 - dist / radius);
            if (points <= 0) continue;

            // Q3 requires line of sight for splash; `CanDamage` traces to the
            // target and to the corners of its box.
            if (!this.canDamage(atQ3, target)) continue;

            this.damage(target, points);
        }
    }

    /**
     * Everything the blast could reach -- `trap_EntitiesInBox`, and Q3 asks the
     * server's entity grid rather than walking every client for a reason.
     *
     * The broadphase answers it when there is one. Without it the array *is* the
     * spatial structure, which is what this port did everywhere before phase 9
     * and is still the honest answer for a configuration with no meep physics
     * behind it.
     *
     * The falloff still needs each candidate's box, so this narrows the set and
     * nothing more: `overlap` says who is close, `G_RadiusDamage` still says how
     * much.
     */
    private splashCandidates(atQ3: ArrayLike<number>, radiusQ3: number): readonly Damageable[] {
        if (this.queries === null) return this.targets;

        const count = this.queries.clientsInRadius(atQ3, radiusQ3, this.inRadius);

        const found: Damageable[] = [];
        for (let i = 0; i < count; i++) {
            const target = this.clientOf(this.inRadius[i]!);
            if (target !== null) found.push(target);
        }

        return found;
    }

    /** The `Damageable` wearing a Q3 client id, or null. */
    private clientOf(clientId: number): Damageable | null {
        for (const target of this.targets) {
            if (target.id === clientId) return target;
        }
        return null;
    }

    /** `CanDamage`: is there an unobstructed path from the blast to the target? */
    private canDamage(fromQ3: ArrayLike<number>, target: Damageable): boolean {
        if (this.queries !== null) return this.queries.visible(fromQ3, target.origin);

        boxTrace(trace, this.cm, fromQ3, target.origin, ZERO, ZERO, MASK_SOLID);
        return trace.fraction === 1.0;
    }

    private damage(target: Damageable, points: number): void {
        let applied = Math.round(points);
        if (applied <= 0) return;

        /*
         `G_Damage`'s armour split:

             save = ceil( damage * ARMOR_PROTECTION );   // 0.66
             if ( save >= armor ) save = armor;
             armor -= save;
             damage -= save;

         The ceiling matters at low damage -- a 5-point hit takes 4 from armour
         and 1 from health, not 3 and 2 -- and it is why armour drains fast
         under a machinegun and slowly under nothing.
        */
        if (target.armor !== undefined && target.armor > 0) {
            const saved = Math.min(target.armor, Math.ceil(applied * ARMOR_PROTECTION));
            target.armor -= saved;
            applied -= saved;

            // A hit fully absorbed by armour still counts as a hit.
            if (applied <= 0) {
                this.events.hit(target, 0);
                return;
            }
        }

        target.health -= applied;

        /*
         `dead` is set *before* the event, not after. A listener's whole reason
         to look at `dead` is to decide whether this hit was the killing one, and
         raising the event first means it never is -- the kill counter stays at
         zero and the corpse is never removed, while the damage numbers all look
         correct. Q3 does the same thing in `G_Damage`, which calls `player_die`
         from inside the damage function rather than after it.
        */
        if (target.health <= 0 && !target.dead) {
            target.dead = true;
        }

        this.events.hit(target, applied);
    }
}

const ZERO = vec3();

/**
 * Slab-method ray/AABB intersection, returning the entry fraction along
 * `start -> end`, or `null`.
 *
 * Not `CM_BoxTrace` against a temp model: the targets here are gameplay
 * entities, not brushes, and Q3 clipped against them through the server's entity
 * link grid rather than through the clipmap. The `trap_EntitiesInBox` row of the
 * coverage matrix is where that maps onto meep's BVH; this is the narrow-phase
 * test that follows it.
 */
function rayBoxFraction(
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    target: Damageable
): number | null {
    let tMin = 0;
    let tMax = 1;

    for (let i = 0; i < 3; i++) {
        const lo = target.origin[i]! + target.mins[i]!;
        const hi = target.origin[i]! + target.maxs[i]!;

        const d = end[i]! - start[i]!;

        if (Math.abs(d) < 1e-8) {
            if (start[i]! < lo || start[i]! > hi) return null;
            continue;
        }

        let t1 = (lo - start[i]!) / d;
        let t2 = (hi - start[i]!) / d;

        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
        }

        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;

        if (tMin > tMax) return null;
    }

    return tMin;
}

export { pointContents };
