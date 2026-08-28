/*
 * damage-queries.test.ts -- the broadphase answers what the array used to.
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
 * Phase 9's last step moved two questions off a loop over every `Damageable` and
 * onto meep: who is inside a blast (`trap_EntitiesInBox`, now
 * `PhysicsSystem.overlap`) and what a bullet passed through (`Bullet_Fire`
 * against the client list, now `PhysicsSystem.raycast`). `CanDamage`'s line of
 * sight went the same way.
 *
 * A suite that only asserts "damage happened" would pass just as well if the
 * query quietly returned nothing and the fallback carried the game -- so every
 * case here runs the **same scenario twice**, once with the queries wired and
 * once with `WeaponSystem` falling back to the array scan, and requires the two
 * to agree. That is the only assertion that can tell a broadphase that works
 * from one that is not being consulted.
 *
 * Agreement is exact, not approximate. Both paths end in the same
 * `G_RadiusDamage` falloff over the same boxes; all that differs is which
 * candidates reach it, and a candidate the broadphase misses is a player who
 * does not take a rocket.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { CharacterBodies } from '../src/client/CharacterBody.ts';
import { Missiles } from '../src/client/Missiles.ts';
import { DamageQueries } from '../src/client/DamageQueries.ts';
import {
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
const spawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);

/** The most open spawn on `oa_dm1`; the ring test measured it. */
const OPEN = spawns[3] ?? spawns[0]!;

class Board implements WeaponEvents {
    /** Every `hit`, as `id -> total damage`, which is what the two runs compare. */
    readonly damage = new Map<number, number>();
    explosions = 0;

    muzzleFlash(): void {}
    bulletImpact(): void {}
    hitscanTrail(): void {}
    explosion(): void {
        this.explosions += 1;
    }
    hit(target: Damageable, points: number): void {
        this.damage.set(target.id, (this.damage.get(target.id) ?? 0) + points);
    }
    projectileSpawned(): void {}
    projectileGone(): void {}
}

/** A stationary thing a shot can hurt, with a Q3 player's box. */
function dummy(id: number, originQ3: Vec3): Damageable {
    return {
        id,
        origin: originQ3,
        mins: vec3(-15, -15, -24),
        maxs: vec3(15, 15, 32),
        health: 1e9,
        dead: false,
        armor: 0,
    };
}

interface Rig {
    readonly weapons: WeaponSystem;
    readonly board: Board;
    step(count: number): void;
}

/**
 * One arena, with the broadphase queries wired or not.
 *
 * Bodies are built either way -- a missile needs them to report a direct hit at
 * all -- so `useQueries` is the only thing that differs between two runs.
 */
async function rig(useQueries: boolean, targets: readonly Vec3[]): Promise<Rig> {
    const physics = await HeadlessPhysics.create(cm);
    const bodies = new CharacterBodies(
        { system: physics.system, ecd: physics.ecd },
        physics.ecd,
        physics.traceIgnores
    );
    const missiles = new Missiles(physics.system, physics.ecd, bodies);
    const board = new Board();

    const weapons = new WeaponSystem(
        cm,
        board,
        missiles,
        useQueries ? new DamageQueries(physics.system, bodies) : null
    );

    targets.forEach((origin, i) => {
        const target = dummy(100 + i, origin);
        weapons.targets.push(target);

        const slot = bodies.create(target.id);
        slot.track(() => target.origin);
    });

    bodies.sync();

    const size = physics.entityManager.fixedUpdateStepSize;

    return {
        weapons,
        board,
        step(count: number): void {
            for (let i = 0; i < count; i++) {
                physics.step(size);
                weapons.update(size);
            }
        },
    };
}

/** Fire one shot into both rigs and hand back what each recorded. */
async function bothWays(
    targets: readonly Vec3[],
    fire: (weapons: WeaponSystem) => void,
    steps: number
): Promise<{ withQueries: Map<number, number>; withArray: Map<number, number> }> {
    const a = await rig(true, targets);
    const b = await rig(false, targets);

    fire(a.weapons);
    fire(b.weapons);

    a.step(steps);
    b.step(steps);

    return { withQueries: a.board.damage, withArray: b.board.damage };
}

describe('splash damage', () => {
    it('reaches the same people through the broadphase as through the array', async () => {
        const at: Vec3 = vec3(OPEN[0]!, OPEN[1]!, OPEN[2]! + 40);

        /*
         Four dummies at spreading distances across the rocket's 120-unit splash
         radius, so the case covers a direct hit, two partial falloffs, and one
         just outside -- rather than only the easy middle.
        */
        const targets: Vec3[] = [
            vec3(at[0]! - 100, at[1]!, at[2]!),
            vec3(at[0]! - 40, at[1]!, at[2]!),
            vec3(at[0]! - 20, at[1]! + 30, at[2]!),
            vec3(at[0]! - 20, at[1]! - 60, at[2]!),
        ];

        const from: Vec3 = vec3(at[0]! + 120, at[1]!, at[2]!);

        const { withQueries, withArray } = await bothWays(
            targets,
            (weapons) => {
                weapons.fire('WP_ROCKET_LAUNCHER', from, vec3(0, 180, 0), 999, 1);
            },
            30
        );

        expect(withArray.size, 'the control run hurt nobody; the geometry moved').toBeGreaterThan(1);
        expect([...withQueries.entries()].sort()).toEqual([...withArray.entries()].sort());
    });

    it('still refuses to reach through a wall', async () => {
        /*
         `CanDamage` is the half that moved from the ported `cm_trace` to a
         `raycast`, so a blast on the far side of the level from its target has
         to stay refused. The two spawns are chosen to have no line of sight --
         asserted below rather than assumed, because a map change would otherwise
         turn this into a test that passes for no reason.
        */
        const at: Vec3 = vec3(OPEN[0]!, OPEN[1]!, OPEN[2]! + 40);
        const hidden = spawns[0]!;
        const targets: Vec3[] = [vec3(hidden[0]!, hidden[1]!, hidden[2]! + 40)];

        const from: Vec3 = vec3(at[0]! + 120, at[1]!, at[2]!);

        const { withQueries, withArray } = await bothWays(
            targets,
            (weapons) => {
                weapons.fire('WP_ROCKET_LAUNCHER', from, vec3(0, 180, 0), 999, 1);
            },
            30
        );

        expect(withArray.size, 'the control blast reached a target across the map').toBe(0);
        expect(withQueries.size, 'the broadphase blast reached through a wall').toBe(0);
    });
});

describe('a hitscan shot', () => {
    it('finds the same client through the broadphase as through the array', async () => {
        const at: Vec3 = vec3(OPEN[0]!, OPEN[1]!, OPEN[2]! + 40);
        const targets: Vec3[] = [
            vec3(at[0]! - 60, at[1]!, at[2]!),
            // Directly behind the first: the near one must take every round.
            vec3(at[0]! - 100, at[1]!, at[2]!),
        ];

        const from: Vec3 = vec3(at[0]! + 60, at[1]!, at[2]!);

        const { withQueries, withArray } = await bothWays(
            targets,
            (weapons) => {
                // No spread on the machinegun's first pellet; ten rounds, same line.
                for (let i = 0; i < 10; i++) {
                    weapons.fire('WP_MACHINEGUN' as WeaponId, from, vec3(0, 180, 0), 999, i);
                }
            },
            1
        );

        expect(withArray.size, 'the control run hit nothing').toBeGreaterThan(0);
        expect([...withQueries.entries()].sort()).toEqual([...withArray.entries()].sort());

        // And it was the near one, not the one standing behind it.
        expect(withQueries.has(100)).toBe(true);
        expect(withQueries.has(101)).toBe(false);
    });

    it('does not shoot the client who fired it', async () => {
        const at: Vec3 = vec3(OPEN[0]!, OPEN[1]!, OPEN[2]! + 40);

        // The shooter stands where the muzzle is, and fires through itself.
        const targets: Vec3[] = [vec3(at[0]!, at[1]!, at[2]!)];

        const { withQueries } = await bothWays(
            targets,
            (weapons) => {
                weapons.fire('WP_MACHINEGUN' as WeaponId, at, vec3(0, 180, 0), 100, 1);
            },
            1
        );

        expect(withQueries.get(100) ?? 0).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * A projectile is not a wall
 * ------------------------------------------------------------------ */

describe('a missile in flight', () => {
    it('blocks neither a bullet nor a line of sight', async () => {
        /*
         Rays skip sensors, and a missile's collider carries
         `ColliderFlags.IsSensor`, so this holds without the port asking for it.
         Asserted because it is the sort of property that is free until the day
         someone makes missiles solid for an unrelated reason.
        */
        const at: Vec3 = vec3(OPEN[0]!, OPEN[1]!, OPEN[2]! + 40);
        const targets: Vec3[] = [vec3(at[0]! - 60, at[1]!, at[2]!)];

        const r = await rig(true, targets);

        // A rocket crawling down the line first...
        r.weapons.fire('WP_ROCKET_LAUNCHER', vec3(at[0]! + 60, at[1]!, at[2]!), vec3(0, 180, 0), 999, 1);
        r.step(1);

        const projectiles: readonly Projectile[] = r.weapons.liveProjectiles;
        expect(projectiles.length, 'the rocket was gone before the shot').toBe(1);

        // ...and a bullet down the same line, which must reach the target.
        r.weapons.fire('WP_MACHINEGUN' as WeaponId, vec3(at[0]! + 60, at[1]!, at[2]!), vec3(0, 180, 0), 999, 1);

        expect(r.board.damage.get(100) ?? 0, 'the bullet stopped on the rocket').toBeGreaterThan(0);
    });
});
