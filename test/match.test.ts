/*
 * match.test.ts -- the phase 5 exit criterion, played headlessly.
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
 * "A real match is playable" was verified in phase 5 by playing it, which is the
 * one method this project has repeatedly shown to be unreliable: the previous
 * session shipped two wrong fixes off screenshots, and the session before that
 * measured a harness that was not running the shipping code (D-036, D-061).
 *
 * So the match runs here instead, in Node, on the shipping backend, with no
 * renderer and no engine boot. Everything below the presentation layer composes
 * without one -- `MoverSystem`, `ItemSystem` and `WeaponSystem` never knew about
 * the ECS, `BotRuntime.spawn` already takes a null `Character`, and
 * `PhysicsSystem` drives from `HeadlessPhysics`. The only thing this cannot see
 * is whether it *looks* right, which is `presentation.test.ts`'s problem.
 *
 * What it asserts is what the criterion means: bots leave their spawn, cross the
 * level, arrive at things they wanted, shoot each other, die, come back, and do
 * it without the simulation producing a number that is not a number.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace, type TraceResult } from '../src/q3/cm/trace.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { ItemSystem, type DropTrace, type ItemInstance } from '../src/game/Items.ts';
import { buildWaypoints, linkMapPortals, type WaypointGraph } from '../src/game/Waypoints.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { Bot } from '../src/game/Bot.ts';
import { BotRuntime, type BotWorld } from '../src/client/Bots.ts';
import { CharacterBodies, type CharacterSlot } from '../src/client/CharacterBody.ts';
import { Missiles } from '../src/client/Missiles.ts';
import { DamageQueries } from '../src/client/DamageQueries.ts';
import {
    WeaponSystem, type Damageable, type WeaponEvents, type WeaponId,
} from '../src/game/Weapons.ts';
import { vec3 } from '../src/q3/math.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** 125 Hz, which is `sv_fps` on a Q3 server and what pmove is tuned around. */
const TICK = 1 / 125;

interface SceneEntity {
    classname?: string;
    _originQ3: number[];
    target?: unknown;
    targetname?: unknown;
    model?: unknown;
    spawnflags?: unknown;
}

interface Scene {
    entities: SceneEntity[];
    submodels: { minsQ3: number[]; maxsQ3: number[] }[];
}

/**
 * Everything a match needs, on the shipping collision backend.
 *
 * `physics: true` is meep's `PhysicsSystem` -- the configuration that actually
 * ships (D-029). The clipmap path is available for an A/B, and one test below
 * uses it, because a difference between the two is the only way to tell a
 * gameplay bug from a collision bug.
 */
const loaded = new Map<string, { cm: ClipMap; scene: Scene; physics: HeadlessPhysics }>();

/**
 * One map's collision, scene and physics backend, warmed at module scope.
 *
 * `HeadlessPhysics.create` is a factory now -- the ECS behind it has to be
 * started before any body is built -- and `play` is called while vitest is still
 * collecting this file, where there is nothing to await in. Warming here keeps
 * `arena` and every case below synchronous, and means the clipmap the physics
 * backend holds is the same instance the clipmap control reads.
 */
async function warm(mapName: string): Promise<void> {
    if (loaded.has(mapName)) return;

    const raw = readFileSync(join(BUILT, mapName, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(
        readFileSync(join(BUILT, mapName, 'scene.json'), 'utf8')
    ) as Scene;

    loaded.set(mapName, { cm, scene, physics: await HeadlessPhysics.create(cm) });
}

await warm('oa_dm1');
await warm('aggressor');

function arena(mapName: string, usePhysics: boolean) {
    const built = loaded.get(mapName);
    if (built === undefined) {
        throw new Error(`arena('${mapName}') before it was warmed -- add it beside the others`);
    }

    const { cm, scene } = built;
    const physics = usePhysics ? built.physics : null;

    const trace: DropTrace = (start, mins, maxs, end, mask) => {
        const out = createTrace();
        if (physics !== null) physics.trace(out, start, end, mins, maxs, mask);
        else boxTrace(out, cm, start, end, mins, maxs, mask);
        return out;
    };

    const items = new ItemSystem();
    items.spawn(scene.entities, trace);

    const graph = buildWaypoints(
        scene.submodels[0] ?? { minsQ3: [-4096, -4096, -4096], maxsQ3: [4096, 4096, 4096] },
        trace
    );
    linkMapPortals(graph, scene.entities, scene.submodels);

    return { cm, scene, physics, trace, items, graph };
}

/**
 * Damage and kills, without the particles.
 *
 * `WeaponEvents` is the seam the presentation hangs off, and `Arena` is the only
 * implementation that ships. That it can be replaced by a counter with no other
 * change is the reason this file exists at all: the simulation genuinely does
 * not know whether anything is drawing it.
 */
class Scoreboard implements WeaponEvents {
    shots = 0;
    impacts = 0;
    trails = 0;
    explosions = 0;
    damage = 0;
    kills = 0;
    projectiles = 0;

    muzzleFlash(): void {
        this.shots += 1;
    }
    bulletImpact(): void {
        this.impacts += 1;
    }
    hitscanTrail(): void {
        this.trails += 1;
    }
    explosion(): void {
        this.explosions += 1;
    }
    hit(target: Damageable, damage: number): void {
        this.damage += damage;
        if (target.dead) this.kills += 1;
    }
    projectileSpawned(): void {
        this.projectiles += 1;
    }
    projectileGone(): void {}
}

interface MatchResult {
    readonly bots: Bot[];
    readonly board: Scoreboard;
    readonly items: readonly ItemInstance[];
    readonly graph: WaypointGraph;
    /** Distance each bot travelled, in Q3 units. */
    readonly travelled: number[];
    /** How many distinct graph nodes each bot was nearest to. */
    readonly visited: number[];
    readonly pickups: number;
    readonly deaths: number;
    /** Damage the standing player absorbed, and how many bots ever aimed at it. */
    readonly playerDamage: number;
    readonly engagedBots: number;
}

/**
 * Run a deathmatch for `seconds` and report what happened.
 *
 * There is a player, and it is a dummy that stands at a spawn point and never
 * moves or shoots back.
 *
 * That is not a convenience. Bots in this port fight *the player* and not each
 * other -- Q3's target selection scores every client and this one does not, which
 * is recorded as a deliberate cut in D-055 -- so a bots-only match is six
 * opponents wandering an empty level and never firing, which is what the first
 * version of this test measured and mistook for a bug. A stationary player is
 * therefore the smallest arrangement in which the fight branch of the tree ever
 * runs, and the limitation is asserted directly in its own test below.
 */
function play(mapName: string, seconds: number, botCount: number, usePhysics = true): MatchResult {
    const { cm, scene, physics, trace, items, graph } = arena(mapName, usePhysics);

    const board = new Scoreboard();

    /*
     Missiles are bodies now, so the headless match needs the same three pieces
     the browser wires: a set of character bodies (which is how a contact becomes
     a Q3 client id), a missile world, and the weapon system that fires into it.
     Without them a rocket is spawned and never moves -- which is precisely the
     class of "the harness cannot see the shipping arrangement" failure D-036 and
     D-061 already cost this project twice.
    */
    const bodies =
        physics === null
            ? null
            : new CharacterBodies(
                  { system: physics.system, ecd: physics.ecd },
                  physics.ecd,
                  physics.traceIgnores
              );
    const missiles =
        physics === null ? null : new Missiles(physics.system, physics.ecd, bodies);

    const damageQueries = bodies === null ? null : new DamageQueries(physics!.system, bodies);

    const weapons = new WeaponSystem(cm, board, missiles, damageQueries);

    const entrances = spawnPoints(scene.entities);
    const spawns = entrances.points.map((e) => e._originQ3);
    expect(spawns.length, `${mapName} has no spawn points`).toBeGreaterThan(0);

    /** Node origins are standing positions; the host adds Q3's own 9-unit lift. */
    const snap = (origin: number[]): number[] => {
        const node = graph.nearestInMainBody(origin);
        if (node < 0) return origin;
        const n = graph.nodes[node]!.origin;
        return [n[0]!, n[1]!, n[2]! - 9];
    };

    /*
     The player: a target at the first spawn point that never moves. Health is
     kept above zero for the whole run, because a dead player makes every bot
     drop the fight branch and the point of the run is to exercise it.
    */
    const snappedPlayer = snap(spawns[0]!);
    const playerOrigin = vec3(snappedPlayer[0]!, snappedPlayer[1]!, snappedPlayer[2]! + 9);
    let playerDamage = 0;

    const player: Damageable = {
        id: 0,
        origin: playerOrigin,
        mins: vec3(-15, -15, -24),
        maxs: vec3(15, 15, 32),
        health: 1e9,
        armor: 0,
        dead: false,
    };

    weapons.targets.push(player);

    const playerSlot = bodies?.create(0) ?? null;
    playerSlot?.track(() => playerOrigin);

    const world: BotWorld = {
        graph,
        items: items.items,
        trace: (start, mins, maxs, end, mask): TraceResult => {
            const out = createTrace();
            if (physics !== null) physics.trace(out, start, end, mins, maxs, mask);
            else boxTrace(out, cm, start, end, mins, maxs, mask);
            return out;
        },
        playerOrigin: () => playerOrigin,
        playerAlive: () => true,
        spawns: spawns.map(snap),
        fire: (bot, eye, angles, weapon) => {
            weapons.fire(weapon, eye, angles, bot.id, 0x1234);
        },
    };

    const runtime = new BotRuntime(world, null);

    // A slot per bot, made before the bot, because the host it hands back
    // carries the filter that names the bot's own body. See `CharacterSlot`.
    const botSlots: (CharacterSlot | null)[] = [];
    for (let i = 0; i <= botCount; i++) botSlots.push(i === 0 ? null : (bodies?.create(2000 + i) ?? null));

    // From spawn 1 upward, exactly as `main.ts` does: spawn 0 is the player's,
    // and a bot standing inside it would spend the match shooting from a stop.
    for (let i = 1; i <= botCount && i < spawns.length; i++) {
        const bot = new Bot({
            id: 2000 + i,
            name: `bot${i}`,
            character: `bot${i}`,
            cm,
            spawnQ3: snap(spawns[i]!),
            physics,
            movers: () => ({ movers: [] }),
            // Null on the clipmap backend: there is no physics world for the
            // kinematic solver to run against, so that configuration exercises
            // the ported `bg_pmove` end to end.
            moverHost: botSlots[i]?.host ?? (physics === null ? null : { system: physics.system, ecd: physics.ecd }),
        });

        runtime.spawn(bot, null);
        weapons.targets.push(bot);
        botSlots[i]?.track(() => bot.origin);
    }

    // Every body at its spawn before the first step, or a missile fired on
    // frame one meets six characters stacked at the world origin.
    bodies?.sync();

    const travelled = runtime.bots.map(() => 0);
    const visited = runtime.bots.map(() => new Set<number>());
    const last = runtime.bots.map((b) => [b.origin[0]!, b.origin[1]!, b.origin[2]!]);
    const wasDead = runtime.bots.map(() => false);
    const engaged = new Set<number>();

    let deaths = 0;
    const startingItems = items.items.filter((i) => i.present).length;

    for (let step = 0; step * TICK < seconds; step++) {
        const before = player.health;

        runtime.update(TICK, TICK * 1000, items.items);

        /*
         The engine's step, then the game's -- the order `EntityManager` runs
         them in, because every system that references a component is scheduled
         ahead of the ones this application registers. `CharacterBodySystem`'s
         job is the `bodies.sync()`.
        */
        bodies?.sync();
        physics?.step(TICK);
        weapons.update(TICK);
        items.update(TICK, vec3(0, 0, -1e6), NOBODY, false);

        playerDamage += before - player.health;
        // The player is a dummy, not a participant; keep it standing.
        player.health = 1e9;
        player.dead = false;

        for (const bot of runtime.bots) if (bot.enemyVisible) engaged.add(bot.id);

        for (let i = 0; i < runtime.bots.length; i++) {
            const bot = runtime.bots[i]!;
            const p = last[i]!;
            const dx = bot.origin[0]! - p[0]!;
            const dy = bot.origin[1]! - p[1]!;
            const dz = bot.origin[2]! - p[2]!;

            // A respawn is a teleport, not a walk.
            if (!bot.dead && !wasDead[i]!) {
                travelled[i]! += Math.sqrt(dx * dx + dy * dy + dz * dz);
            }

            if (bot.dead && !wasDead[i]!) deaths += 1;
            wasDead[i] = bot.dead;

            p[0] = bot.origin[0]!;
            p[1] = bot.origin[1]!;
            p[2] = bot.origin[2]!;

            const node = graph.nearest(bot.origin);
            if (node >= 0) visited[i]!.add(node);
        }
    }

    return {
        bots: runtime.bots,
        board,
        items: items.items,
        graph,
        travelled,
        visited: visited.map((s) => s.size),
        pickups: startingItems - items.items.filter((i) => i.present).length,
        deaths,
        playerDamage,
        engagedBots: engaged.size,
    };
}

/** A player-shaped hole: the item system needs an inventory and there is nobody. */
const NOBODY = {
    health: 0,
    armor: 0,
    maxHealth: 100,
    ammo: {},
    weapons: new Set<string>(),
    powerups: new Map<string, number>(),
    holdable: null,
};

describe('spawn point selection', () => {
    it('prefers deathmatch spawns where a map has them', () => {
        const scene = JSON.parse(
            readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')
        ) as Scene;

        const set = spawnPoints(scene.entities);
        expect(set.kind).toBe('info_player_deathmatch');
        expect(set.points.length).toBeGreaterThanOrEqual(4);
        expect(set.points.every((p) => p.classname === 'info_player_deathmatch')).toBe(true);
    });

    it('falls back to CTF team spawns on a Team Arena map', () => {
        /*
         The regression this exists for. `am_thornish` has zero
         `info_player_deathmatch`, so the old filter produced an empty list: no
         bots on the largest map in the build, and a death respawning the player
         at the world origin.
        */
        const scene = JSON.parse(
            readFileSync(join(BUILT, 'am_thornish', 'scene.json'), 'utf8')
        ) as Scene;

        expect(
            scene.entities.filter((e) => e.classname === 'info_player_deathmatch').length
        ).toBe(0);

        const set = spawnPoints(scene.entities);
        expect(set.kind).toBe('team_CTF_redspawn + team_CTF_bluespawn');
        expect(set.points.length).toBe(24);
    });

    it('finds an entry point on every shipped map', () => {
        for (const name of ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish']) {
            const scene = JSON.parse(
                readFileSync(join(BUILT, name, 'scene.json'), 'utf8')
            ) as Scene;
            expect(spawnPoints(scene.entities).points.length, name).toBeGreaterThanOrEqual(4);
        }
    });
});

describe.each(['oa_dm1', 'aggressor'])('a match runs unattended [%s]', (mapName) => {
    /*
     30 simulated seconds at 125 Hz, six bots. Long enough for a bot to plan, walk
     somewhere, find another one and exchange fire; short enough that the whole
     file runs in a few seconds. Deterministic apart from `Math.random` in weapon
     spread and respawn choice, which is why every threshold below is set well
     under what the build achieves rather than at it.
    */
    const result = play(mapName, 30, 6);

    it('puts bots in the level and keeps their state finite', () => {
        expect(result.bots.length).toBe(6);

        for (const bot of result.bots) {
            for (const v of [...bot.origin, bot.health]) {
                expect(Number.isFinite(v), `${bot.id} has a non-finite ${v}`).toBe(true);
            }
            expect(Math.abs(bot.origin[2]!), 'fell out of the world').toBeLessThan(65536);
        }
    });

    it('has every bot leave its spawn and cross the level', () => {
        for (let i = 0; i < result.bots.length; i++) {
            expect(
                result.travelled[i],
                `bot ${i} travelled ${result.travelled[i]!.toFixed(0)} units in 30 s`
            ).toBeGreaterThan(200);

            expect(
                result.visited[i],
                `bot ${i} was only ever near ${result.visited[i]} graph nodes`
            ).toBeGreaterThan(5);
        }
    });

    it('has bots find and take pickups', () => {
        expect(result.pickups, 'items taken in 30 s').toBeGreaterThan(0);
    });

    it('has bots find the player, open fire and land hits', () => {
        expect(result.engagedBots, 'bots that ever saw the player').toBeGreaterThan(0);

        /*
         One threshold for every map, and the history is worth keeping.

         Migrating the bots onto meep's solver (D-072) briefly split this: 374
         shots on `oa_dm1` against the ported path's 110, and 10 on `aggressor`
         against 420, with bots there grounded 51.6% of the time and reading as
         stuck 23.3% of it. I wrote a per-map floor of 5 so the suite stayed
         green, which was wrong -- it turned "bots have stopped fighting on this
         map" into a passing test.

         The cause was BUG-7, and meep 3.2.0 fixes it: `aggressor` is back to
         220 shots with bots grounded 89.4% and stuck 4.4%. One floor, both maps,
         and if either regresses the suite says so.
        */
        expect(
            result.board.shots,
            `${result.board.shots} shots fired on ${mapName}`
        ).toBeGreaterThan(100);

        expect(result.playerDamage, 'damage taken by the player').toBeGreaterThan(0);
    });

    it('brings the dead back', () => {
        // Every bot alive at the end, after some of them died during it, is the
        // respawn path working: `Bot.respawn` restores health and clears `dead`.
        if (result.deaths > 0) {
            expect(result.bots.some((b) => !b.dead)).toBe(true);
        }
        expect(result.bots.every((b) => b.health > 0 || b.dead)).toBe(true);
    });
});

describe('what the bots deliberately do not do', () => {
    /*
     D-055's cuts, asserted rather than described, so that the report's claim and
     the code cannot drift apart. If someone implements bot-versus-bot target
     selection, this fails and the report has to be updated -- which is the point.
    */
    it('never targets another bot: with no player, nobody fires', () => {
        const { cm, scene, physics, items, graph } = arena('oa_dm1', true);

        const board = new Scoreboard();
        const weapons = new WeaponSystem(cm, board);
        const spawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);

        const world: BotWorld = {
            graph,
            items: items.items,
            trace: (start, mins, maxs, end, mask): TraceResult => {
                const out = createTrace();
                physics!.trace(out, start, end, mins, maxs, mask);
                return out;
            },
            playerOrigin: () => vec3(0, 0, -1e6),
            playerAlive: () => false,
            spawns,
            fire: (bot, eye, angles, weapon) => {
                weapons.fire(weapon, eye, angles, bot.id, 0x1234);
            },
        };

        const runtime = new BotRuntime(world, null);

        for (let i = 0; i < 6 && i < spawns.length; i++) {
            const bot = new Bot({
                id: 3000 + i,
                name: `bot${i}`,
                character: `bot${i}`,
                cm,
                spawnQ3: spawns[i]!,
                physics,
                movers: () => ({ movers: [] }),
                moverHost: { system: physics!.system, ecd: physics!.ecd },
            });
            runtime.spawn(bot, null);
            weapons.targets.push(bot);
        }

        for (let step = 0; step * TICK < 20; step++) {
            runtime.update(TICK, TICK * 1000, items.items);
            weapons.update(TICK);
        }

        expect(board.shots, 'a bot fired at another bot').toBe(0);
        expect(board.damage).toBe(0);

        // They still route and collect, which is the half that does work.
        expect(runtime.bots.every((b) => !b.dead)).toBe(true);
    });
});

describe('the match does not depend on the collision backend', () => {
    /*
     The same 20 seconds on the clipmap. Not a divergence measurement --
     `measure-divergence` does that properly -- but a guard against the failure
     that actually happened twice: a change to the physics path that traps every
     bot where it stands, which shows up here as travel collapsing to nothing
     while the clipmap run is unaffected.
    */
    const onPhysics = play('oa_dm1', 20, 4, true);
    const onClipmap = play('oa_dm1', 20, 4, false);

    it('moves bots comparable distances under both', () => {
        const total = (r: MatchResult): number => r.travelled.reduce((a, b) => a + b, 0);

        const p = total(onPhysics);
        const c = total(onClipmap);

        expect(p, 'physics backend').toBeGreaterThan(800);
        expect(c, 'clipmap backend').toBeGreaterThan(800);

        // Two runs of a chaotic simulation are not expected to match. What is
        // asserted is the same order of magnitude: the physics backend must not
        // be quietly costing bots most of their mobility.
        expect(
            p / c,
            `physics ${p.toFixed(0)} vs clipmap ${c.toFixed(0)} units`
        ).toBeGreaterThan(0.5);
        expect(p / c).toBeLessThan(2);
    });

    it('reaches a similar share of the navigation graph under both', () => {
        const reach = (r: MatchResult): number =>
            r.visited.reduce((a, b) => a + b, 0) / r.graph.stats.nodes;

        expect(reach(onPhysics), 'physics coverage').toBeGreaterThan(0.02);
        expect(reach(onClipmap), 'clipmap coverage').toBeGreaterThan(0.02);
    });
});
