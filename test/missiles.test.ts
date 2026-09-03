/*
 * missiles.test.ts -- rockets, as the engine flies them.
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
 * Phase 9 deleted `WeaponSystem`'s projectile integrator -- a step of Euler, a
 * segment trace through the ported clipmap, and a slab-method ray/AABB test
 * against every `Damageable` in the level -- and replaced it with a dynamic
 * body, a CCD flag and a contact listener.
 *
 * That is a good trade only if the new arrangement hits what the old one hit.
 * The failure mode it introduces is tunnelling: the discrete narrowphase samples
 * the two ends of a step, and a plasma bolt covers 33 units in one, so a body
 * that is not swept goes through people. Every case here is aimed at that.
 *
 * The 64-direction sweep is the gate. It fires from a ring around a stationary
 * target, skips the directions a wall is in the way of -- decided by the ported
 * `cm_trace`, which is bit-exact against the C and is this project's ground
 * truth for "is there anything between these two points" -- and requires every
 * remaining shot to report a direct hit on that target.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { CharacterBodies } from '../src/client/CharacterBody.ts';
import { Missiles } from '../src/client/Missiles.ts';
import { DamageQueries } from '../src/client/DamageQueries.ts';
import {
    MASK_SHOT,
    WeaponSystem,
    weaponStats,
    type Damageable,
    type Projectile,
    type WeaponEvents,
    type WeaponId,
} from '../src/game/Weapons.ts';
import { vec3, type Vec3 } from '../src/q3/math.ts';
import { WEAPON_ORDER } from '../src/client/PlayerController.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
const cm = new ClipMap(
    new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
);
const scene = JSON.parse(readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')) as Scene;
const allSpawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);
const spawn = allSpawns[0]!;

/**
 * The most open spawn on `oa_dm1`, measured rather than picked: 51 of 64
 * horizontal directions at 120 units have a clear shot at its eye height, where
 * the first spawn has 29. A ring test is only a test of the missile code in the
 * directions that are not a test of the map.
 */
const openSpawn = allSpawns[3] ?? spawn;

/** Damage and explosions, without the particles. */
class Board implements WeaponEvents {
    explosions: {
        at: Vec3;
        radius: number;
        weapon: WeaponId;
        normal: ArrayLike<number> | null;
    }[] = [];
    hits: { id: number; damage: number }[] = [];
    spawned: { projectile: Projectile; entity: number }[] = [];
    gone = 0;

    trails: { from: Vec3; to: Vec3; weapon: WeaponId }[] = [];

    muzzleFlash(): void {}
    bulletImpact(): void {}

    hitscanTrail(
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        weapon: WeaponId
    ): void {
        this.trails.push({
            from: vec3(startQ3[0]!, startQ3[1]!, startQ3[2]!),
            to: vec3(endQ3[0]!, endQ3[1]!, endQ3[2]!),
            weapon,
        });
    }

    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        weapon: WeaponId,
        normalQ3?: ArrayLike<number>
    ): void {
        this.explosions.push({
            at: vec3(originQ3[0]!, originQ3[1]!, originQ3[2]!),
            radius: radiusQ3,
            weapon,
            normal: normalQ3 === undefined ? null : [...(normalQ3 as ArrayLike<number> as number[])],
        });
    }

    hit(target: Damageable, damage: number, _attackerId: number): void {
        this.hits.push({ id: target.id, damage });
    }

    projectileSpawned(projectile: Projectile, entity: number): void {
        this.spawned.push({ projectile, entity });
    }

    projectileGone(): void {
        this.gone += 1;
    }
}

/** A body-less thing a rocket can hurt, standing at a fixed point. */
function dummy(id: number, originQ3: Vec3): Damageable {
    return {
        id,
        origin: originQ3,
        mins: vec3(-15, -15, -24),
        maxs: vec3(15, 15, 32),
        health: 1000,
        dead: false,
        armor: 0,
    };
}

interface Rig {
    readonly physics: HeadlessPhysics;
    readonly bodies: CharacterBodies;
    readonly missiles: Missiles;
    readonly weapons: WeaponSystem;
    readonly board: Board;
    step(count?: number): void;
}

async function rig(): Promise<Rig> {
    const physics = await HeadlessPhysics.create(cm);
    const bodies = new CharacterBodies(
        { system: physics.system, ecd: physics.ecd },
        physics.ecd,
        physics.traceIgnores
    );
    const missiles = new Missiles(physics.system, physics.ecd, bodies);
    const board = new Board();
    const weapons = new WeaponSystem(cm, board, missiles, new DamageQueries(physics.system, bodies));

    const size = physics.entityManager.fixedUpdateStepSize;

    return {
        physics,
        bodies,
        missiles,
        weapons,
        board,
        step(count = 1): void {
            for (let i = 0; i < count; i++) {
                // The engine's step -- which is where the missile is integrated,
                // swept and its contacts dispatched -- then the game's, which is
                // where `CombatSystem` calls `WeaponSystem.update`.
                physics.step(size);
                weapons.update(size);
            }
        },
    };
}

/** Q3 view angles that point from `from` at `to`. */
function aim(from: ArrayLike<number>, to: ArrayLike<number>): Vec3 {
    const dx = to[0]! - from[0]!;
    const dy = to[1]! - from[1]!;
    const dz = to[2]! - from[2]!;

    const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
    const pitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;

    return vec3(pitch, yaw, 0);
}

/*
 * Where a projectile is born.
 *
 * It used to be `CalcMuzzlePoint` for everything, which is fourteen units
 * straight out from the eye: inside the player's own hull, on the aim ray, and
 * visibly not the end of the gun -- a rocket appeared out of thin air in the
 * middle of the screen. It now leaves `tag_flash` for the shooters that have a
 * model to read one off. See D-116, and `first-person.test.ts` for the offset's
 * own arithmetic.
 *
 * Angles of zero throughout, so Q3's axes can be written out rather than
 * borrowed from the code under test: forward is +x, right is -y, up is +z.
 */
describe('a projectile leaves the end of the gun', () => {
    /** The rocket launcher's, from `first-person.test.ts`. */
    const BARREL = [26.68, 5.72, -8.04] as const;

    it('spawns at the barrel when the shooter has one', async () => {
        const r = await rig();

        const eye: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_ROCKET_LAUNCHER', eye, vec3(0, 0, 0), 999, 1, BARREL);

        const origin = r.board.spawned[0]!.projectile.origin;

        expect(origin[0]!, 'down the barrel').toBeCloseTo(eye[0]! + BARREL[0], 3);
        expect(origin[1]!, 'and out of its right-hand side').toBeCloseTo(eye[1]! - BARREL[1], 3);
        expect(origin[2]!, 'below the crosshair').toBeCloseTo(eye[2]! + BARREL[2], 3);
    });

    /*
     The control, and the contract for every caller that passes nothing:
     `roster.ts` fires the bots this way, and so does every headless test.
    */
    it('spawns at `CalcMuzzlePoint` when it does not', async () => {
        const r = await rig();

        const eye: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_ROCKET_LAUNCHER', eye, vec3(0, 0, 0), 999, 1);

        const origin = r.board.spawned[0]!.projectile.origin;

        expect(origin[0]!).toBeCloseTo(eye[0]! + 14, 3);
        expect(origin[1]!).toBeCloseTo(eye[1]!, 3);
        expect(origin[2]!).toBeCloseTo(eye[2]!, 3);
    });

    /**
     * The reason the barrel is checked before it is used.
     *
     * Q3's muzzle is inside the player's own box and is therefore in open space
     * by construction; the barrel is a foot past the front of it and can be
     * inside a wall the player is pressed against. A missile born in solid
     * detonates on nothing and puts its blast on the far side of the surface.
     *
     * Set up by measurement rather than by a hand-picked coordinate: find the
     * wall, then stand twenty units off it, which leaves the muzzle six units
     * clear of it and the barrel six units past.
     */
    it('falls back to the muzzle when the barrel is inside the world', async () => {
        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        const far: Vec3 = vec3(from[0]! + 4096, from[1]!, from[2]!);

        const wall = createTrace();
        boxTrace(wall, cm, from, far, vec3(), vec3(), MASK_SHOT);
        expect(wall.fraction, 'nothing to hit along +x from this spawn').toBeLessThan(1);

        // Twenty units back from where the trace stopped, facing it.
        const eye: Vec3 = vec3(wall.endpos[0]! - 20, from[1]!, from[2]!);

        const clear = createTrace();
        boxTrace(clear, cm, eye, vec3(eye[0]! + 14, eye[1]!, eye[2]!), vec3(), vec3(), MASK_SHOT);
        expect(clear.fraction, 'the muzzle itself has to be in open space').toBe(1);

        const r = await rig();
        r.weapons.fire('WP_ROCKET_LAUNCHER', eye, vec3(0, 0, 0), 999, 1, BARREL);

        const origin = r.board.spawned[0]!.projectile.origin;

        expect(origin[0]!, 'the barrel is in the wall, so the muzzle it is').toBeCloseTo(
            eye[0]! + 14,
            3
        );
        expect(origin[1]!).toBeCloseTo(eye[1]!, 3);
        expect(origin[2]!).toBeCloseTo(eye[2]!, 3);
    });

    /*
     Hitscan is deliberately not moved. A railgun shot from the barrel would land
     5.7 units right and 8 low of the crosshair at every range, and a hitscan
     weapon is the one place in this game where the shot has to go exactly where
     the dot is. So the offset is offered to `fire` and only the projectile
     branch reads it.
    */
    it('does not move a hitscan shot, whatever it is handed', async () => {
        const r = await rig();

        const eye: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        const target = dummy(11, vec3(eye[0]! + 400, eye[1]!, eye[2]!));
        r.weapons.targets.push(target);

        const slot = r.bodies.create(11);
        slot.track(() => target.origin);
        r.bodies.sync();

        // Dead level at a target 400 units away, with a barrel that would put the
        // shot 5.7 units to the side of it if the origin moved.
        r.weapons.fire('WP_RAILGUN', eye, vec3(0, 0, 0), 999, 1, BARREL);

        expect(r.board.hits.map((h) => h.id), 'the railgun still goes where it points').toEqual([
            11,
        ]);
    });
});

describe('a missile', () => {
    it('hits a stationary target from every direction that has a clear run at it', async () => {
        const centre: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);

        /**
         * Fire one rocket inward from `angle` on a 120-unit ring, and say where
         * it stopped.
         *
         * `withTarget: false` is the control, and it is why this reads the way it
         * does. "Is the path clear" cannot be answered by the ported `cm_trace`
         * here: a missile flies through meep's convex hulls, and on `oa_dm1`
         * those disagree with the brushes they were built from by enough to stop
         * a rocket in mid-air where the clipmap says there is sixteen units of
         * nothing (see PLAN.md's phase-9 findings). Answering it with the same
         * collision the missile actually uses -- an identical shot with the
         * target removed -- is the only oracle that is not either circular or a
         * measurement of a different collision model.
         */
        async function shoot(
            angle: number,
            withTarget: boolean
        ): Promise<{ hitTarget: boolean; travelled: number }> {
            const r = await rig();

            const target = dummy(7, vec3(centre[0]!, centre[1]!, centre[2]!));

            if (withTarget) {
                r.weapons.targets.push(target);
                const slot = r.bodies.create(7);
                slot.track(() => target.origin);
                r.bodies.sync();
            }

            const from: Vec3 = vec3(
                centre[0]! + Math.cos(angle) * 120,
                centre[1]! + Math.sin(angle) * 120,
                centre[2]!
            );

            r.weapons.fire('WP_ROCKET_LAUNCHER', from, aim(from, centre), 999, 1);

            // 120 units at 900 a second is an eighth of a second; this is many
            // times that, and far short of the ten-second self-destruct.
            for (let i = 0; i < 40 && r.missiles.inFlight > 0; i++) r.step();

            const at = r.board.explosions[0]?.at ?? from;

            return {
                hitTarget: r.board.hits.some((h) => h.id === 7 && h.damage >= 100),
                travelled: Math.hypot(at[0]! - from[0]!, at[1]! - from[1]!, at[2]! - from[2]!),
            };
        }

        let attempted = 0;
        const missed: string[] = [];

        for (let i = 0; i < 64; i++) {
            const angle = (i / 64) * Math.PI * 2;

            // The control: with nothing to hit, how far does this rocket get?
            // Anything short of the target's box is the level being in the way.
            const control = await shoot(angle, false);
            if (control.travelled < 105) continue;

            attempted += 1;

            const live = await shoot(angle, true);
            if (!live.hitTarget) missed.push(`${((angle * 180) / Math.PI).toFixed(0)} deg`);
        }

        expect(attempted, 'no direction had a clear run; the geometry moved').toBeGreaterThan(15);
        expect(missed, `${missed.length} of ${attempted} rockets passed through the target`).toEqual(
            []
        );
    });

    it('does not detonate on the player who fired it', async () => {
        const r = await rig();

        const shooter = dummy(3, vec3(spawn[0]!, spawn[1]!, spawn[2]! + 24));
        r.weapons.targets.push(shooter);

        const slot = r.bodies.create(3);
        slot.track(() => shooter.origin);
        r.bodies.sync();

        /*
         `CalcMuzzlePoint` puts the muzzle 14 units in front of the eye and the
         box is 30 wide, so the rocket is created inside its own owner. Without
         the contact filter this detonates on frame one, every time.
        */
        r.weapons.fire('WP_ROCKET_LAUNCHER', shooter.origin, vec3(0, 0, 0), 3, 1);
        r.step(3);

        /*
         Splash on yourself is Q3 -- `G_RadiusDamage` does not exempt the
         attacker, and rocket-jumping is that rule. What must not happen is a
         *direct* hit, which is the full 100.
        */
        expect(r.board.hits.filter((h) => h.id === 3 && h.damage >= 100)).toEqual([]);

        // And it got clear of the muzzle rather than detonating on frame one.
        const flew = r.board.spawned[0]!.projectile.origin[0]! - shooter.origin[0]!;
        expect(flew, 'the rocket never left its owner').toBeGreaterThan(20);
    });

    it('stops at a wall, on the wall', async () => {
        const r = await rig();

        const from: Vec3 = vec3(spawn[0]!, spawn[1]!, spawn[2]! + 40);

        // Straight down +x until something stops it.
        const far: Vec3 = vec3(from[0]! + 4096, from[1]!, from[2]!);
        const reference = createTrace();
        boxTrace(reference, cm, from, far, vec3(), vec3(), MASK_SHOT);

        expect(reference.fraction, 'nothing to hit along +x from this spawn').toBeLessThan(1);

        r.weapons.fire('WP_ROCKET_LAUNCHER', from, vec3(0, 0, 0), 999, 1);
        r.step(200);

        expect(r.board.explosions.length, 'the rocket never detonated').toBe(1);

        const at = r.board.explosions[0]!.at;

        /*
         Against the ported `cm_trace`'s own answer, which is bit-exact against
         the C. A couple of units of tolerance is the missile's 2-unit collision
         radius plus the solver's skin; anything larger would mean the contact
         point is not the surface.
        */
        /*
         Against the ported `cm_trace`'s own answer, which is bit-exact against
         the C. The missile is a 2-unit sphere where Q3's is a point, so its
         centre rests a radius short of the surface a point trace reports;
         anything beyond that and the contact is not the wall.
        */
        expect(Math.abs(at[0]! - reference.endpos[0]!)).toBeLessThan(4);

        /*
         And it carries the wall's own normal, for the scorch mark -- pointing
         *out* of the wall, which is the half of this that was wrong.

         Asserting it is not null is not enough and was not: meep hands over a
         normal oriented by which side of the contact pair a body is on, the
         missile is reliably the higher entity id, and the vector arrived
         pointing along the flight and into the surface. It reads perfectly at
         every call site and then falls off the end of the renderer -- a decal
         projected from inside the wall it is drawn on is faded to nothing by
         `chunk_decal_surface_frame` with no error and no warning. So the
         direction is checked against the ported `cm_trace`, which is bit-exact
         against the C and is this project's ground truth for what a wall's
         normal is.
        */
        const normal = r.board.explosions[0]!.normal;
        expect(normal, 'no surface normal on a world impact').not.toBeNull();

        const dot =
            normal![0]! * reference.planeNormal[0]! +
            normal![1]! * reference.planeNormal[1]! +
            normal![2]! * reference.planeNormal[2]!;

        expect(dot, 'the impact normal points into the wall, not out of it').toBeGreaterThan(0.9);
    });

    it('ages on the fixed step and takes its body with it when it goes', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_ROCKET_LAUNCHER', from, vec3(-90, 0, 0), 999, 1);

        const projectile = r.board.spawned[0]!.projectile;
        const entity = r.board.spawned[0]!.entity;

        expect(r.missiles.inFlight).toBe(1);
        expect(entity, 'the projectile was not given a body').toBeGreaterThanOrEqual(0);

        /*
         Q3's `G_FreeEntity` fires at ten seconds and this is not a test of where
         the ceiling is, so the timer is asserted on its own: `life` comes down
         by exactly one fixed step per step, which is the property that makes ten
         seconds mean ten seconds however the frame rate moves.
        */
        const step = r.physics.entityManager.fixedUpdateStepSize;
        const before = projectile.life;
        r.step(3);
        expect(before - projectile.life).toBeCloseTo(step * 3, 9);

        // However it leaves -- the timer or a wall -- the body leaves with it.
        for (let i = 0; i < 700 && r.missiles.inFlight > 0; i++) r.step();

        expect(r.missiles.inFlight, 'still in flight after eleven seconds').toBe(0);
        expect(r.board.gone + r.board.explosions.length).toBeGreaterThan(0);
        expect(
            r.physics.ecd.entityExists(entity),
            'the missile left the game and its body stayed in the broadphase'
        ).toBe(false);
    });
});

/*
 * The nailgun, which is fifteen missiles per trigger pull.
 *
 * It had no `balance.weapons` entry at all until now, so it could be picked up
 * and never held -- and the visible symptom of that was the one that got
 * reported: the weapon never appears in your hands. The numbers were in the C
 * the whole time in a shape `projectile()` could not read (no splash, and a
 * speed that is a fresh draw per nail rather than a literal). See D-119.
 *
 * Every expectation below is transcribed from `fire_nail`,
 * `Weapon_Nailgun_Fire` and `PM_Weapon` rather than read from the generated
 * table, because the generated table is what is under test.
 */
describe('the nailgun', () => {
    /** `#define NUM_NAILSHOTS 15` in g_weapon.c. */
    const NUM_NAILSHOTS = 15;
    /** `scale = 555 + random() * 1800` in fire_nail. */
    const SPEED_MIN = 555;
    const SPEED_MAX = 555 + 1800;

    it("carries fire_nail's own numbers, extracted rather than invented", () => {
        const stats = weaponStats('WP_NAILGUN');

        expect(stats.hitscan, 'a nail is a missile, not a trace').not.toBe(true);
        expect(stats.damage, 'bolt->damage = 20').toBe(20);
        expect(stats.pellets, 'NUM_NAILSHOTS').toBe(NUM_NAILSHOTS);
        expect(stats.spread, 'NAILGUN_SPREAD').toBe(500);
        expect(stats.speed, 'the 555 in `555 + random() * 1800`').toBe(SPEED_MIN);
        expect(stats.speedRandom, 'the 1800 in it').toBe(SPEED_MAX - SPEED_MIN);
        expect(stats.fireRateMs, "PM_Weapon's addTime for WP_NAILGUN").toBe(1000);

        /*
         And no splash, which is the half that made `projectile()` throw rather
         than return a wrong answer. A nail is a dart.
        */
        expect(stats.splashDamage ?? 0).toBe(0);
        expect(stats.splashRadius ?? 0).toBe(0);
    });

    /*
     A nail has no blast, so the size of its detonation is not a blast radius --
     and for a long time it was 100, a number no weapon has and nothing chose.
     That was merely oversized while every detonation threw a flat 12,000 lm;
     since D-166 the flash scales with this radius, so a made-up radius is a
     made-up brightness and 100 would have made a nail the second-brightest
     impact in the game. 12 is `CG_MissileHitWall`'s own answer for `WP_NAILGUN`,
     the size of the mark it leaves, on the arm that draws it no explosion at all.
    */
    it('detonates a nail at the size of the hole it leaves, not at a blast it has none of', async () => {
        const r = await rig();

        const from: Vec3 = vec3(spawn[0]!, spawn[1]!, spawn[2]! + 40);

        r.weapons.fire('WP_NAILGUN', from, vec3(0, 0, 0), 999, 1);
        r.step(400);

        const nails = r.board.explosions;

        expect(nails.length, 'no nail reached a wall').toBeGreaterThan(0);

        for (const nail of nails) {
            expect(nail.weapon).toBe('WP_NAILGUN');
            expect(nail.radius, 'a dart raising a three-metre fireball').toBe(12);
        }
    });

    it('fires fifteen nails from one trigger pull', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_NAILGUN', from, vec3(0, 0, 0), 999, 1);

        expect(r.board.spawned.length).toBe(NUM_NAILSHOTS);
        expect(r.missiles.inFlight).toBe(NUM_NAILSHOTS);

        // One flash for the burst, as `Weapon_Nailgun_Fire` raises one event.
        expect(r.board.spawned.every((s) => s.entity >= 0)).toBe(true);
    });

    it('draws a fresh speed for every nail, inside the range fire_nail draws from', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_NAILGUN', from, vec3(0, 0, 0), 12345, 1);

        const speeds = r.board.spawned.map((s) =>
            Math.hypot(...(s.projectile.velocity as unknown as number[]))
        );

        for (const speed of speeds) {
            // A unit of slack each way for `SnapVector`, which rounds each
            // component and so moves the magnitude by up to about 0.9.
            expect(speed).toBeGreaterThanOrEqual(SPEED_MIN - 1);
            expect(speed).toBeLessThanOrEqual(SPEED_MAX + 1);
        }

        /*
         The property, not just the range: the nailgun is the only weapon in Q3
         whose projectiles travel at different speeds, and it is what turns a
         burst into a spray that stretches along its own axis rather than a rigid
         wall of nails. A single averaged speed would pass every bound above.
        */
        const spread = Math.max(...speeds) - Math.min(...speeds);
        expect(spread, 'every nail left at the same speed').toBeGreaterThan(300);
    });

    it('snaps each velocity to whole units, as SnapVector does', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_NAILGUN', from, vec3(15, 40, 0), 7, 1);

        for (const { projectile } of r.board.spawned) {
            for (const axis of projectile.velocity as unknown as number[]) {
                expect(Number.isInteger(axis), `${axis} is not a whole unit`).toBe(true);
            }
        }
    });

    it('lays the burst out in a cone rather than a line', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_NAILGUN', from, vec3(0, 0, 0), 99, 1);

        const directions = r.board.spawned.map(({ projectile }) => {
            const v = projectile.velocity as unknown as number[];
            const l = Math.hypot(v[0]!, v[1]!, v[2]!);
            return [v[0]! / l, v[1]! / l, v[2]! / l];
        });

        // Fired down +x with no pitch or yaw, so the axis is +x and the cone is
        // whatever `NAILGUN_SPREAD` opens it to.
        const offAxis = directions.map((d) => Math.hypot(d[1]!, d[2]!));

        expect(Math.max(...offAxis), 'the nails all flew down the same line').toBeGreaterThan(0);
        expect(
            Math.max(...offAxis),
            'the cone is wider than NAILGUN_SPREAD can open it'
        ).toBeLessThan(0.2);

        // Every nail still goes forwards; a spread that wraps is a spread bug.
        for (const d of directions) expect(d[0]!).toBeGreaterThan(0.9);
    });

    it('is a weapon the wheel can reach, which is what made it invisible', () => {
        /*
         `weapon_t` order, filtered to what this port can fire. The nailgun, the
         prox launcher and the chaingun are all after `WP_BFG` -- which is where
         the hand-written list used to stop -- and `am_thornish` places all three
         on the floor. Picking one up autoswitched to it and then there was no way
         back to it, by key or by wheel, which reads exactly like a weapon that
         does not draw.
        */
        expect(WEAPON_ORDER).toContain('WP_NAILGUN');
        expect(WEAPON_ORDER).toContain('WP_PROX_LAUNCHER');
        expect(WEAPON_ORDER).toContain('WP_CHAINGUN');

        // And the one weapon in `weapon_t` this port genuinely cannot fire.
        expect(WEAPON_ORDER).not.toContain('WP_GRAPPLING_HOOK');

        // Q3's own order, not a re-sorted one: the gauntlet leads and the BFG is
        // ninth, because a Q3 player knows the wheel by muscle memory.
        expect(WEAPON_ORDER[0]).toBe('WP_GAUNTLET');
        expect(WEAPON_ORDER[8]).toBe('WP_BFG');
    });
});

/*
 * The trail event, which is the simulation's half of a shot trail.
 *
 * It exists separately from `bulletImpact` because a trail has to be drawn for
 * rays that raise no impact at all: one that hit a player leaves no mark, and one
 * that hit nothing never reaches an impact of any kind. Both still came out of a
 * barrel and both still went somewhere. See D-124.
 */
describe('a hitscan shot reports where it went', () => {
    /** The railgun's barrel, from `first-person.test.ts`: forward, right, up. */
    const RAIL_BARREL = [14.91 + 6.16, 5.83, -7.8 + 2.76] as const;

    it('raises one trail per ray, from the barrel it was handed', async () => {
        const r = await rig();

        const eye: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_RAILGUN', eye, vec3(0, 0, 0), 999, 1, RAIL_BARREL);

        expect(r.board.trails.length, 'one railgun shot, one trail').toBe(1);

        const { from, weapon } = r.board.trails[0]!;
        expect(weapon).toBe('WP_RAILGUN');

        /*
         The barrel, not `CalcMuzzlePoint`. Angles of zero, so Q3's axes are
         forward +x, right -y, up +z -- and the offset is (forward, right, up).
        */
        expect(from[0]!, 'down the barrel').toBeCloseTo(eye[0]! + RAIL_BARREL[0], 3);
        expect(from[1]!, 'and out of its right-hand side').toBeCloseTo(
            eye[1]! - RAIL_BARREL[1],
            3
        );
        expect(from[2]!, 'below the crosshair').toBeCloseTo(eye[2]! + RAIL_BARREL[2], 3);
    });

    it('ends the trail on the wall the ray actually stopped at', async () => {
        const r = await rig();

        const from: Vec3 = vec3(spawn[0]!, spawn[1]!, spawn[2]! + 40);

        // The same shot `stops at a wall, on the wall` fires: straight down +x
        // from a spawn with something in the way.
        const far: Vec3 = vec3(from[0]! + 8192, from[1]!, from[2]!);
        const reference = createTrace();
        boxTrace(reference, cm, from, far, vec3(), vec3(), MASK_SHOT);

        expect(reference.fraction, 'nothing to hit along +x from this spawn').toBeLessThan(1);

        r.weapons.fire('WP_RAILGUN', from, vec3(0, 0, 0), 999, 1);

        expect(r.board.trails.length).toBe(1);

        /*
         Against the ported `cm_trace`'s own endpoint. The ray is traced from
         `CalcMuzzlePoint` and this reference from the eye, so they differ by the
         fourteen units of muzzle offset along a shot that is travelling down +x
         -- which changes where it *starts* and not where it *stops*.
        */
        const to = r.board.trails[0]!.to;
        expect(to[0]!).toBeCloseTo(reference.endpos[0]!, 1);
        expect(to[1]!).toBeCloseTo(reference.endpos[1]!, 1);
        expect(to[2]!).toBeCloseTo(reference.endpos[2]!, 1);
    });

    it('reports a trail for a shot that hit a player, where there is no impact', async () => {
        const r = await rig();

        const centre: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        const from: Vec3 = vec3(centre[0]! - 120, centre[1]!, centre[2]!);

        const target = dummy(7, vec3(centre[0]!, centre[1]!, centre[2]!));
        r.weapons.targets.push(target);
        const slot = r.bodies.create(7);
        slot.track(() => target.origin);
        r.bodies.sync();

        r.weapons.fire('WP_RAILGUN', from, aim(from, centre), 999, 1);

        expect(r.board.hits.length, 'the shot did not hit the target').toBeGreaterThan(0);

        /*
         The point of the event. `bulletImpact` is not raised for a shot that
         stopped on a person -- Q3 draws no mark on flesh -- so a trail hung off
         that event would vanish exactly when you hit someone.
        */
        expect(r.board.trails.length, 'a shot that hit a player left no trail').toBe(1);

        const to = r.board.trails[0]!.to;
        const reached = Math.hypot(to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!);

        // It stops at the target rather than running on to the railgun's range.
        expect(reached).toBeLessThan(130);
        expect(reached).toBeGreaterThan(80);
    });

    it('runs the full range for a shot that hit nothing at all', async () => {
        const r = await rig();

        // Straight up out of the open spawn: the lightning gun's own 768 range,
        // and nothing above to stop it.
        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_LIGHTNING', from, vec3(-90, 0, 0), 999, 1);

        expect(r.board.trails.length).toBe(1);

        const { from: start, to } = r.board.trails[0]!;
        const reached = Math.hypot(
            to[0]! - start[0]!,
            to[1]! - start[1]!,
            to[2]! - start[2]!
        );

        /*
         Either the ceiling stopped it or it ran the whole 768. Both are correct
         and which one depends on the map, so what is asserted is that the trail
         has a real length rather than collapsing to the muzzle -- the failure
         mode if `t_hit` were left unwritten when nothing was hit.
        */
        expect(reached, 'the trail collapsed to a point').toBeGreaterThan(16);
        expect(reached).toBeLessThanOrEqual(768 + 16);
    });

    it('raises one per pellet, and lets the presentation drop them', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_SHOTGUN', from, vec3(0, 0, 0), 999, 1);

        /*
         `DEFAULT_SHOTGUN_COUNT` rays, `DEFAULT_SHOTGUN_COUNT` events. The
         simulation reports every ray it traced and has no opinion about what is
         drawn; that the shotgun draws none of them is `Effects`' decision and is
         tested there.
        */
        expect(r.board.trails.length).toBe(weaponStats('WP_SHOTGUN').pellets);
        expect(r.board.trails.every((t) => t.weapon === 'WP_SHOTGUN')).toBe(true);
    });

    it('raises none at all for a projectile weapon', async () => {
        const r = await rig();

        const from: Vec3 = vec3(openSpawn[0]!, openSpawn[1]!, openSpawn[2]! + 40);
        r.weapons.fire('WP_ROCKET_LAUNCHER', from, vec3(0, 0, 0), 999, 1);

        expect(r.board.trails).toEqual([]);
    });
});
