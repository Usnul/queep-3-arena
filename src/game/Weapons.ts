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
const ARMOR_PROTECTION = 0.66;

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
    return balance.weapons[id] as WeaponStats;
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
    muzzleFlash(originQ3: ArrayLike<number>, weapon: WeaponId): void;
    bulletImpact(originQ3: ArrayLike<number>, normalQ3: ArrayLike<number>): void;
    explosion(originQ3: ArrayLike<number>, radiusQ3: number): void;
    hit(target: Damageable, damage: number): void;
    /** A projectile was created; the presentation layer attaches a trail. */
    projectileSpawned(projectile: Projectile): void;
    projectileMoved(projectile: Projectile): void;
    projectileGone(projectile: Projectile): void;
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

    /** Everything a shot can hurt, including the player. */
    readonly targets: Damageable[] = [];

    constructor(cm: ClipMap, events: WeaponEvents) {
        this.cm = cm;
        this.events = events;
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

        this.events.muzzleFlash(t_muzzle, weapon);

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
        this.events.projectileSpawned(projectile);
    }

    /** One hitscan ray: trace the world, then look for a closer target. */
    private hitscanShot(
        start: ArrayLike<number>,
        end: ArrayLike<number>,
        damage: number,
        ownerId: number
    ): void {
        boxTrace(trace, this.cm, start, end, ZERO, ZERO, MASK_SHOT);

        let bestFraction = trace.fraction;
        let bestTarget: Damageable | null = null;

        for (const target of this.targets) {
            if (target.id === ownerId || target.dead) continue;

            const f = rayBoxFraction(start, end, target);
            if (f !== null && f < bestFraction) {
                bestFraction = f;
                bestTarget = target;
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

    /** Advance projectiles. `deltaSeconds` is real time. */
    update(deltaSeconds: number): void {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i]!;

            p.life -= deltaSeconds;
            if (p.life <= 0) {
                this.projectiles.splice(i, 1);
                this.events.projectileGone(p);
                continue;
            }

            vectorMA(t_end, p.origin, deltaSeconds, p.velocity);

            boxTrace(trace, this.cm, p.origin, t_end, ZERO, ZERO, MASK_SHOT);

            // Check targets along the same segment.
            let hitTarget: Damageable | null = null;
            let hitFraction = trace.fraction;

            for (const target of this.targets) {
                if (target.id === p.ownerId || target.dead) continue;
                const f = rayBoxFraction(p.origin, t_end, target);
                if (f !== null && f < hitFraction) {
                    hitFraction = f;
                    hitTarget = target;
                }
            }

            if (hitTarget !== null || trace.fraction < 1) {
                const impact = vec3(
                    p.origin[0]! + (t_end[0]! - p.origin[0]!) * hitFraction,
                    p.origin[1]! + (t_end[1]! - p.origin[1]!) * hitFraction,
                    p.origin[2]! + (t_end[2]! - p.origin[2]!) * hitFraction
                );

                this.detonate(p, impact, hitTarget);
                this.projectiles.splice(i, 1);
                continue;
            }

            copy(p.origin, t_end);
            this.events.projectileMoved(p);
        }
    }

    private detonate(
        projectile: Projectile,
        atQ3: Vec3,
        directHit: Damageable | null
    ): void {
        const stats = weaponStats(projectile.weapon);

        this.events.projectileGone(projectile);
        this.events.explosion(atQ3, stats.splashRadius ?? 100);

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
        for (const target of this.targets) {
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

    /** `CanDamage`: is there an unobstructed path from the blast to the target? */
    private canDamage(fromQ3: ArrayLike<number>, target: Damageable): boolean {
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

    get liveProjectiles(): readonly Projectile[] {
        return this.projectiles;
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
