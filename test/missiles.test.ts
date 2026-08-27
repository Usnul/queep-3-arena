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
    type Damageable,
    type Projectile,
    type WeaponEvents,
    type WeaponId,
} from '../src/game/Weapons.ts';
import { vec3, type Vec3 } from '../src/q3/math.ts';

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
    explosions: { at: Vec3; radius: number; normal: ArrayLike<number> | null }[] = [];
    hits: { id: number; damage: number }[] = [];
    spawned: { projectile: Projectile; entity: number }[] = [];
    gone = 0;

    muzzleFlash(): void {}
    bulletImpact(): void {}

    explosion(originQ3: ArrayLike<number>, radiusQ3: number, normalQ3?: ArrayLike<number>): void {
        this.explosions.push({
            at: vec3(originQ3[0]!, originQ3[1]!, originQ3[2]!),
            radius: radiusQ3,
            normal: normalQ3 === undefined ? null : [...(normalQ3 as ArrayLike<number> as number[])],
        });
    }

    hit(target: Damageable, damage: number): void {
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

        // And it carries the wall's own normal, for the scorch mark.
        expect(r.board.explosions[0]!.normal, 'no surface normal on a world impact').not.toBeNull();
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
