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
import { vec3, angleVectors, normalize, type Vec3, type Vec3Like } from '../q3/math.ts';
import { v3_copy_array } from '@woosh/meep-engine/src/core/geom/vec3/v3_copy_array.js';
import { v3_displace_in_direction_array } from '@woosh/meep-engine/src/core/geom/vec3/v3_displace_in_direction_array.js';
import balance from './balance.generated.json' with { type: 'json' };

export type WeaponId = keyof typeof balance.weapons;

/** `MASK_SHOT` from q_shared.h. */
export const MASK_SHOT = CONTENTS.SOLID | CONTENTS.BODY | CONTENTS.CORPSE;

/** `g_combat.c`: the fraction of damage armour takes before health does. */
export const ARMOR_PROTECTION = 0.66;

/**
 * `attackerId` for damage nobody fired: the world, a fall, a trigger.
 *
 * 255 rather than -1 because it rides the wire as a `uint8` in `HitEvent`, and
 * a sentinel that survives serialisation is one less thing to get wrong at the
 * two ends. Q3 spells the same idea `ENTITYNUM_WORLD` and scores it the same
 * way: the victim loses a point rather than anybody gaining one.
 */
export const NO_ATTACKER = 255;

export interface WeaponStats {
    readonly hitscan?: boolean;
    readonly fireRateMs: number;
    readonly damage: number;
    readonly splashDamage?: number;
    readonly splashRadius?: number;
    readonly speed?: number;
    /**
     * The `random() * N` added to {@link speed}, per projectile. The nailgun's.
     *
     * `fire_nail` is `scale = 555 + random() * 1800`, drawn fresh for every one
     * of the fifteen nails a shot fires, and it is the only weapon in Q3 whose
     * projectiles do not all travel at the same speed. Absent everywhere else,
     * where the draw collapses to {@link speed} and nothing changes.
     */
    readonly speedRandom?: number;
    readonly spread?: number;
    /**
     * How many things leave the barrel per shot.
     *
     * `DEFAULT_SHOTGUN_COUNT` for the shotgun and `NUM_NAILSHOTS` for the
     * nailgun -- one of each kind, which is why this is not called `pellets`
     * anywhere the projectile path can see it.
     */
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

/**
 * The model a weapon's projectile is drawn as, or null for one that has none.
 *
 * `CG_RegisterWeapon`'s `weaponInfo->missileModel`, extracted from
 * `cg_weapons.c` rather than transcribed -- see `extract-balance.mjs`. Seven of
 * the thirteen weapons have one; the hitscan weapons do not, and neither does
 * the plasma gun, whose line is commented out in the C because `CG_Missile`
 * draws its bolt as a sprite instead.
 *
 * Presentation, in the simulation's file, for the reason `ItemDef.models` is:
 * the thing that knows which weapon fired is here, the table is keyed by weapon,
 * and the alternative is a second weapon table in the client that has to be kept
 * in step with this one. Null is a real answer and both of its meanings -- "not
 * a projectile" and "drawn some other way" -- belong to the caller.
 *
 * Keyed over `weapon_t` rather than over `WeaponId`, so it answers for the
 * nailgun and the grappling hook too; `string` in and null out for anything
 * else.
 */
export function missileModel(weapon: string): string | null {
    const models = balance.missileModels as Record<string, string | null>;
    return models[weapon] ?? null;
}

/**
 * `weapon_t`, in the order Q3 declares it.
 *
 * Which is the order the mouse wheel cycles and the order `weapon 1`..`weapon 13`
 * select, extracted from `bg_public.h` so that neither can drift from the enum.
 * It is not the order of increasing power and it is not the order of
 * `balance.weapons`; it is the one Q3 players know by muscle memory.
 */
export const WEAPON_ORDER: readonly string[] = balance.weaponOrder;

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
     *
     * `directionQ3` is the shooter's forward, unit, and is here because a flash
     * has a direction: Q3 hangs `weaponInfo->flashModel` on `tag_flash`, which
     * is oriented, and the particles that stand in for it are thrown *down the
     * barrel*. It is `AngleVectors`' own forward -- already computed one line
     * above the call, so this costs the event a parameter and nothing else.
     * Only the presentation reads it.
     */
    muzzleFlash(
        originQ3: ArrayLike<number>,
        directionQ3: ArrayLike<number>,
        weapon: WeaponId,
        ownerId: number
    ): void;
    /**
     * A hitscan shot reached a surface.
     *
     * `weapon` comes with it because `CG_MissileHitWall` -- which is the same
     * function in the C for a bullet as for a rocket -- chooses the impact mark
     * and its radius from the weapon and from nothing else. A machinegun leaves
     * an 8-unit pockmark, a shotgun pellet a 4-unit one, and the lightning gun a
     * 12-unit hole. Without the id here the presentation can only guess, and what
     * it guessed was "hitscan means bullet".
     */
    bulletImpact(
        originQ3: ArrayLike<number>,
        normalQ3: ArrayLike<number>,
        weapon: WeaponId
    ): void;
    /**
     * One hitscan ray, from where the gun is to where the shot stopped.
     *
     * **The C's nearest thing is `CG_Bullet`**, which is handed the shot's `end`,
     * recovers its `start` with `CG_CalcMuzzlePoint` and then decides for itself
     * whether to draw anything -- a `CG_Tracer` dash two times in five for the
     * bullet weapons, and nothing at all for the shotgun, whose pellets go
     * through `CG_ShotgunPellet` and never reach it. The railgun and the
     * lightning gun do not come through there at all; they are `CG_RailTrail` off
     * an event and a per-frame `RT_LIGHTNING` beam respectively. `Effects`
     * collapses all of that into one table and this event feeds it; the whole
     * comparison is written out at `HITSCAN_TRAILS`.
     *
     * Raised for **every** ray, which is what separates it from
     * `bulletImpact`: a shot that hit a player leaves no mark, and a shot that
     * hit nothing at all does not reach an impact of any kind, and both of them
     * still came out of a barrel and still went somewhere. A trail drawn off the
     * impact event would be a trail that vanishes exactly when you shoot someone.
     *
     * `startQ3` is the **barrel**, and is not where the ray was traced from.
     * D-116 fixed the ray at `CalcMuzzlePoint` because a hitscan shot has to go
     * exactly where the crosshair is, and a line drawn from that point starts in
     * mid-air fourteen units in front of the eye. So the two differ by the length
     * of the weapon, deliberately, and this is the only place that difference
     * exists.
     *
     * One per pellet, so a shotgun raises eleven. The presentation is what
     * decides that the shotgun draws none of them.
     *
     * `ownerId` comes with it for the same reason `muzzleFlash` carries one, and
     * it is the same distinction: the local player has a weapon model on screen
     * with a `tag_flash` on it, and nobody else does. `startQ3` is this layer's
     * best answer to "where is the gun" -- the rest pose, on the simulation's
     * clock -- and for the one shooter whose gun is *drawn* there is a better
     * one, which only the presentation can see. See D-164.
     */
    hitscanTrail(
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        weapon: WeaponId,
        ownerId: number
    ): void;
    /**
     * `normalQ3` is the surface the missile struck, for the scorch mark.
     *
     * **Absent where there is no surface** -- a rocket that hit a player in
     * mid-air -- and the presentation then draws no mark at all, which is what
     * the C does: `CG_MissileHitPlayer` builds the blood and the spark and calls
     * no `CG_ImpactMark`, because a person is not a wall.
     */
    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        weapon: WeaponId,
        normalQ3?: ArrayLike<number>
    ): void;
    /**
     * `attackerId` is the client whose shot this was, or {@link NO_ATTACKER}.
     *
     * Carried because a kill belongs to somebody. Q3 scores in `player_die`,
     * which is handed the attacker and gives it the frag -- or takes one away
     * when a player killed itself, and takes one from the *victim* when the
     * world did it. None of that can be reconstructed from the target alone,
     * and every call site here already knows the answer: a hitscan has its
     * `ownerId` and a blast has its projectile's.
     */
    hit(target: Damageable, damage: number, attackerId: number): void;
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
    return random(seedRef) * 2 - 1;
}

/**
 * `Q_random` -- the 0..1 half of the same generator, and the one the C names.
 *
 * `crandom` is defined in `q_shared.h` as `(2.0 * (random() - 0.5))`, so this is
 * the primitive and that is the wrapper; it was written the other way round here
 * because spread was the only thing that needed either. `fire_nail` wants the
 * plain one -- `scale = 555 + random() * 1800` -- and drawing it as
 * `(crandom() + 1) / 2` would be the same number by a route that stops looking
 * like the line it came from.
 */
function random(seedRef: { value: number }): number {
    // `(rand() & 0xffff) / 0x10000`, with Q3's own LCG.
    seedRef.value = (1664525 * seedRef.value + 1013904223) >>> 0;
    return (((seedRef.value >>> 16) & 0xffff) / 0x10000);
}

/**
 * `CalcMuzzlePoint`: where a shot leaves, and which way it is pointing.
 *
 * Fourteen units forward of the eye along the shooter's own forward, which is
 * the point every hitscan ray starts from, the point a projectile's reachability
 * trace works back from, and the point the muzzle flash is reported at.
 *
 * **Exported because two peers have to agree about it.** A joined client
 * predicts its own muzzle flash -- Q3 does too, `EV_FIRE_WEAPON` is a
 * predictable event -- and the host raises one for the same shot a round trip
 * later. Two copies of "14 units forward" is two things to get wrong, and the
 * symptom of getting it wrong is a flash that jumps when the authoritative one
 * lands. There is one copy, and this is it.
 *
 * @param out the muzzle, in Q3 units.
 * @param forward the shooter's forward, unit. Written as well as used, because
 *     every caller wants it: it is the direction the flash points and the axis
 *     the shot is traced along.
 */
export function calcMuzzlePoint(
    eyeQ3: Vec3Like,
    anglesQ3: ArrayLike<number>,
    out: Vec3,
    forward: Vec3
): void {
    angleVectors(anglesQ3, forward, m_right, m_up);

    v3_copy_array(out, 0, eyeQ3, 0);
    v3_displace_in_direction_array(out, 0, out, 0, forward, 0, 14);
}

/** Scratch for {@link calcMuzzlePoint}'s two unwanted axes. */
const m_right = vec3();
const m_up = vec3();

const t_forward = vec3();
const t_right = vec3();
const t_up = vec3();
const t_end = vec3();
const t_dir = vec3();
const t_muzzle = vec3();
/** Where a hitscan shot stopped, written by  and read by . */
const t_hit = vec3();
const t_barrel = vec3();
const trace = createTrace();

/**
 * How big a detonation is when the weapon has no blast at all.
 *
 * `CG_MissileHitWall`'s `case WP_NAILGUN: radius = 12`, which is the size of the
 * mark it leaves; the same arm leaves `mod` at zero, so Q3 draws no explosion
 * for a nail and this is the only size statement it makes about one. See
 * `detonate`, and D-166 for why the number this replaced mattered.
 */
const NO_SPLASH_RADIUS_Q3 = 12;

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
     *   `main.ts` builds a `PhysicsWorld` for missiles even on `?move=q3`,
     *   because that parameter selects a *movement* backend and taking the
     *   rockets away with it would make the A/B mean two things.
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
     * player's own bounding box. It remains the origin of every hitscan shot and
     * the point the muzzle flash event reports.
     *
     * @param barrelQ3 where the shooter's *model* puts its muzzle, as (forward,
     *     right, up) from the eye in Q3 units -- `client/ViewWeapon.barrelOffset`
     *     computes it from `tag_flash`. **Projectiles only**, and null for a
     *     shooter with no weapon model, which is every bot and every headless
     *     caller. See D-116 for why hitscan is excluded and what the trade is.
     */
    fire(
        weapon: WeaponId,
        eyeQ3: Vec3Like,
        anglesQ3: ArrayLike<number>,
        ownerId: number,
        seed: number,
        barrelQ3: readonly [number, number, number] | null = null
    ): void {
        const stats = weaponStats(weapon);

        calcMuzzlePoint(eyeQ3, anglesQ3, t_muzzle, t_forward);
        angleVectors(anglesQ3, t_forward, t_right, t_up);

        this.events.muzzleFlash(t_muzzle, t_forward, weapon, ownerId);

        /*
         How many things leave the barrel, and how wide the cone is.

         Both used to be read only on the hitscan side, because the only weapon
         that fired more than one of anything was the shotgun. `Weapon_Nailgun_Fire`
         is a `for` loop of `NUM_NAILSHOTS` calls to `fire_nail`, each one a
         *projectile* with its own draw from `NAILGUN_SPREAD` -- so the count and
         the cone are properties of a shot rather than of a hitscan, and they are
         read once here for both paths.
        */
        const shots = stats.pellets ?? 1;
        const spread = stats.spread ?? 0;
        const seedRef = { value: seed >>> 0 };

        /*
         The end of the gun, once per trigger pull rather than once per pellet,
         because it is the same point for all eleven of them and for all fifteen
         nails. Two things read it and they read it differently:

         - a **projectile** is *born* here, which is D-116, and needs the
           reachability trace that method does so it is not born inside a wall;
         - a **hitscan trail** is *drawn* from here while its ray is still traced
           from `t_muzzle`, because D-116 also fixed that ray on the aim so the
           shot goes where the dot is.

         So it is computed for both paths now, where it used to be the projectile
         branch's alone. A trail that started at the traced origin would start
         fourteen units in front of the eye, in mid-air -- exactly the complaint
         D-116 was written to fix, and worse for a line than for a point.

         **The trail's reading of it is the fallback rather than the answer**,
         and D-164 is why. This is the gun at rest, on the simulation's clock,
         with a reachability trace in front of it; the gun the player is looking
         at is none of those three, and the presentation draws the beam off the
         drawn gun whenever there is one. What is left here is every shooter
         whose gun is not on screen -- which is every bot, every headless caller,
         and the player between dying and respawning.
        */
        const origin = this.projectileOrigin(eyeQ3, barrelQ3);

        for (let i = 0; i < shots; i++) {
            v3_copy_array(t_dir, 0, t_forward, 0);

            if (spread > 0) {
                // `Bullet_Fire` and `fire_nail` alike: r and u are scaled by
                // spread/16384 of the right and up vectors at 8192 units.
                const r = crandom(seedRef) * spread * 16;
                const u = crandom(seedRef) * spread * 16;

                v3_displace_in_direction_array(t_end, 0, t_muzzle, 0, t_forward, 0, 8192 * 16);
                v3_displace_in_direction_array(t_end, 0, t_end, 0, t_right, 0, r);
                v3_displace_in_direction_array(t_end, 0, t_end, 0, t_up, 0, u);

                t_dir[0] = t_end[0]! - t_muzzle[0]!;
                t_dir[1] = t_end[1]! - t_muzzle[1]!;
                t_dir[2] = t_end[2]! - t_muzzle[2]!;
                normalize(t_dir);
            }

            if (stats.hitscan === true) {
                const range = stats.range ?? 8192;
                v3_displace_in_direction_array(t_end, 0, t_muzzle, 0, t_dir, 0, range);

                this.hitscanShot(weapon, t_muzzle, t_end, stats.damage, ownerId);

                /*
                 After the shot rather than before it, because `t_hit` is where
                 the ray stopped and only `hitscanShot` knows that -- the world,
                 a player, or nothing at all and the full range. Raised for every
                 ray including the ones that hit somebody, which is the whole
                 reason this is not folded into `bulletImpact`.
                */
                this.events.hitscanTrail(origin, t_hit, weapon, ownerId);
                continue;
            }

            /*
             `fire_nail`'s `scale = 555 + random() * 1800`, drawn per nail, which
             is why the speed is read inside the loop and not outside it. It is
             the one weapon in the game whose projectiles do not all travel at
             the same speed, and it is what makes a burst of nails a moving
             *spray* rather than a rigid wall -- the fast ones arrive first and
             the cone stretches out along its own axis. A single averaged speed
             would look like a shotgun that had been slowed down.

             `speedRandom` is zero for everything else, so the draw collapses to
             the constant and no other weapon changes.
            */
            const base = stats.speed ?? 900;
            const scale =
                stats.speedRandom === undefined || stats.speedRandom === 0
                    ? base
                    : base + random(seedRef) * stats.speedRandom;

            const projectile: Projectile = {
                id: this.nextProjectileId++,
                weapon,
                origin: vec3(origin![0]!, origin![1]!, origin![2]!),
                /*
                 `SnapVector`, which `fire_nail` applies and the other missiles
                 do not need because their speeds are already integers along an
                 already-snapped direction. Q3 rounds a `trDelta` to whole units
                 so that it survives the network's own quantisation; here it is
                 kept because the alternative is a nail that travels at a speed
                 the C would never have produced, which is a difference nothing
                 downstream can put back.
                */
                velocity: vec3(
                    Math.round(t_dir[0]! * scale),
                    Math.round(t_dir[1]! * scale),
                    Math.round(t_dir[2]! * scale)
                ),
                // `G_FreeEntity` at 10 seconds, as `fire_rocket` sets -- and as
                // `fire_nail` sets, with the same `level.time + 10000`.
                life: 10,
                ownerId,
            };

            this.projectiles.push(projectile);
            this.missiles?.launch(projectile);
            this.events.projectileSpawned(
                projectile,
                this.missiles?.entityOf(projectile.id) ?? -1
            );
        }
    }

    /**
     * Where a projectile is born: the model's muzzle, or Q3's if it cannot be.
     *
     * **The barrel is outside the player's own hull and `CalcMuzzlePoint` is
     * not.** That is the whole reason this is a method and not three lines at
     * the call site. Fourteen units forward is less than the 15 a Q3 player's
     * box is wide, so Q3's muzzle is in space the player is standing in and is
     * therefore open by definition; a rocket launcher's `tag_flash` is 26.7
     * units out and 8 down, which is a foot past the front face of the box and
     * can be inside a wall you are pressed against. A missile born inside solid
     * is a missile that detonates on nothing, through the wall, in your face.
     *
     * So the barrel has to be *reachable*: trace from the safe point to it, and
     * if the world is in the way, use the safe point. Binary rather than a
     * lerp-and-epsilon, because the correction only happens when you are jammed
     * against geometry and the difference it gives up is 13 units of a shot that
     * is about to hit that wall anyway.
     */
    private projectileOrigin(
        eyeQ3: Vec3Like,
        barrelQ3: readonly [number, number, number] | null
    ): Vec3 {
        const fallback = (): Vec3 => vec3(t_muzzle[0]!, t_muzzle[1]!, t_muzzle[2]!);

        if (barrelQ3 === null) return fallback();

        v3_copy_array(t_barrel, 0, eyeQ3, 0);
        v3_displace_in_direction_array(t_barrel, 0, t_barrel, 0, t_forward, 0, barrelQ3[0]!);
        v3_displace_in_direction_array(t_barrel, 0, t_barrel, 0, t_right, 0, barrelQ3[1]!);
        v3_displace_in_direction_array(t_barrel, 0, t_barrel, 0, t_up, 0, barrelQ3[2]!);

        boxTrace(trace, this.cm, t_muzzle, t_barrel, ZERO, ZERO, MASK_SHOT);

        if (trace.startsolid || trace.fraction < 1) return fallback();

        return vec3(t_barrel[0]!, t_barrel[1]!, t_barrel[2]!);
    }

    /** One hitscan ray: trace the world, then look for a closer target. */
    /**
     * Where one hitscan ray stops, and what stopped it.
     *
     * Three sources, and `bestFraction` is the nearest of them by construction:
     * a client the broadphase found, a surface the ported `cm_trace` found, or
     * nothing at all, in which case the shot reached the end of its range and
     * the line runs the whole way.
     *
     * The clipmap is asked as well as the broadphase and not instead of it,
     * because it is the one of the two that reports Q3's surface flags.
     *
     * **That is a smaller reason than it used to claim, and the claim was
     * challenged and did not hold** (D-203). It said a broadphase "has no
     * opinion" about `SURF_NOIMPACT`, which is not the problem:
     * `layerForContents` already puts a brush's contents on its body and
     * `PhysicsTrace.register` already keeps the `BrushHull` beside each body id,
     * so a `shape_cast` hit resolves to its brush today. The real obstacle is
     * that `SURF_NOIMPACT` is per brush **side** -- `cm.sideSurfaceFlags[leadside]`
     * -- and `BrushHull.surfaceFlags` is deliberately zero for a brush hull,
     * because one value per hull is the wrong answer for five of a box's six
     * faces. A cast returns a body and a normal, so what is missing is the step
     * that matches that normal to the hull's own `planes` and picks the side --
     * which `traceBrushList` already does for movement. One lookup away rather
     * than blocked.
     *
     * **Public because a joined client predicts its own tracer with it.** The
     * *damage* is the host's and stays the host's; what a client needs is the
     * far end of a line it is drawing this frame, and computing that is exactly
     * this method minus everything after it. Sharing it is what keeps the drawn
     * line and the authoritative shot the same shape -- see D-203, and
     * `hitscanShot` below for the rest of what a real shot then does.
     *
     * @param out where the shot stopped, in Q3 units.
     * @returns what it stopped on, or null for a surface or the open air.
     */
    traceShot(
        start: ArrayLike<number>,
        end: ArrayLike<number>,
        ownerId: number,
        out: Vec3
    ): Damageable | null {
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

        out[0] = start[0]! + (end[0]! - start[0]!) * bestFraction;
        out[1] = start[1]! + (end[1]! - start[1]!) * bestFraction;
        out[2] = start[2]! + (end[2]! - start[2]!) * bestFraction;

        return bestTarget;
    }

    private hitscanShot(
        weapon: WeaponId,
        start: ArrayLike<number>,
        end: ArrayLike<number>,
        damage: number,
        ownerId: number
    ): void {
        const bestTarget = this.traceShot(start, end, ownerId, t_hit);

        if (bestTarget !== null) {
            this.damage(bestTarget, damage, ownerId);
            return;
        }

        if (trace.fraction < 1) {
            // `SURF_NOIMPACT` is Q3's "sky and similar leave no mark".
            if ((trace.surfaceFlags & SURF.NOIMPACT) === 0) {
                this.events.bulletImpact(trace.endpos, trace.planeNormal, weapon);
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
        /*
         The blast's own radius, and for a weapon with no blast the size of the
         hole it leaves.

         The fallback used to be 100, which is a number no weapon has and nothing
         chose. `WP_NAILGUN` is the only projectile in the game with no
         `splashRadius` -- a nail is a dart that damages what it hits -- so every
         nail striking a wall raised a 100-unit detonation: a three-metre
         fireball, its smoke, and a light reaching the same distance. That was
         merely oversized while the flash was a flat 12,000 lm whatever
         detonated. Since D-166 the flash scales with this radius, so a made-up
         radius is a made-up brightness, and the fiction had to go before the
         rule could be honest: 100 would have made a nail the second-brightest
         impact in the game.

         12 is `CG_MissileHitWall`'s own answer for this weapon -- `case
         WP_NAILGUN` sets `radius = 12` and leaves `mod` at zero, so Q3 sizes a
         nail's mark at 12 units and draws it no explosion whatsoever. This port
         detonates nails because every missile goes down one path; taking the C's
         radius makes that path draw something the size of what Q3 drew.

         Damage is not read from here and never was: the splash arithmetic below
         falls back to 0, so a weapon with no blast does no blast damage. This is
         the presentation's number alone.
        */
        this.events.explosion(
            atQ3,
            stats.splashRadius ?? NO_SPLASH_RADIUS_Q3,
            projectile.weapon,
            surfaceQ3
        );

        if (directHit !== null) {
            this.damage(directHit, stats.damage, projectile.ownerId);
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
            if (!this.visible(atQ3, target.origin)) continue;

            this.damage(target, points, projectile.ownerId);
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

    /**
     * Is there an unobstructed path from one point to another?
     *
     * `CanDamage` asks it of a blast and a target; `BotEntityVisible` asks it of
     * an eye and an enemy. Same question, so it is one method -- and it is a
     * *line*, which is the whole point of it living here. On the physics backend
     * that is `raycast`, which needs no shape at all; on the clipmap one it is
     * `CM_BoxTrace` with zero mins and maxs, which sets `tw.isPoint` and walks
     * the BSP with no box offset on any plane.
     *
     * A bot's line of sight used to go through the generic `pm->trace` seam
     * instead, with zero mins and maxs passed as arguments. Nothing downstream of
     * that seam reads a zero-size box as a ray: `PhysicsTrace` turned it into a
     * `BoxShape3D`, swept it with `shape_cast` -- GJK bisection against every
     * broadphase candidate -- and then ran `overlap_shape` and the ported
     * per-brush trace on top, to recover a contact plane for an answer that only
     * ever read `fraction`. Once per bot per frame. See D-159.
     *
     * `MASK_SOLID` where `BotEntityVisible` passes `MASK_SHOT`, and here the two
     * cannot disagree: the bits `MASK_SHOT` adds are `CONTENTS_BODY` and
     * `CONTENTS_CORPSE`, which no *brush* carries -- Q3 sets them on entities,
     * through `gentity_t.r.contents` -- and this is world geometry only.
     */
    visible(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>): boolean {
        if (this.queries !== null) return this.queries.visible(fromQ3, toQ3);

        boxTrace(sightTrace, this.cm, fromQ3, toQ3, ZERO, ZERO, MASK_SOLID);
        return sightTrace.fraction === 1.0;
    }

    private damage(target: Damageable, points: number, attackerId: number): void {
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
                this.events.hit(target, 0, attackerId);
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

        this.events.hit(target, applied, attackerId);
    }
}

const ZERO = vec3();

/*
 `visible` gets its own, rather than sharing the `trace` above.

 The others are private and each reads its result before returning, so one
 scratch between them is safe by inspection. `visible` is public -- a bot asks it
 once a frame from outside any shot -- and a shared scratch would make a future
 caller inside `hitscanShot`, between the world trace and the `surfaceFlags` read
 that decides whether the bullet leaves a mark, silently overwrite it.
*/
const sightTrace = createTrace();

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
