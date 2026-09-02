/*
 * bots.test.ts -- what difficulty actually does, measured one bot at a time.
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
 * `match.test.ts` runs six bots for a minute and asks whether a deathmatch
 * happened. It is the right test for that question and the wrong one for these:
 * a property that only holds on average, in a run whose shot count varies
 * sevenfold with where a random route went, is a property no assertion can be
 * sharp about.
 *
 * So this file takes the other half. One bot, one target, and the two things
 * that make a bot's perception hard to pin down -- the map's geometry and the
 * other bots -- removed: `BotWorld.visible` is a *variable* here, which is the
 * whole point. Whether the trace clears is `match.test.ts`'s problem. What
 * happens in the seconds after it clears, and in the seconds after it stops,
 * is this file's, and those seconds are exactly what D-162 changed.
 *
 * The three complaints it was opened for, in order: perfect aim, no reaction
 * time, and a bot that keeps firing at where you were until it runs dry. Each
 * has a case below that fails if it comes back.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { buildWaypoints, type WaypointGraph } from '../src/game/Waypoints.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { Bot } from '../src/game/Bot.ts';
import {
    DEFAULT_DIFFICULTY,
    DIFFICULTIES,
    difficulty,
    gaussian,
    type BotSkill,
} from '../src/game/Difficulty.ts';
import { AWARENESS_BEHIND, BotRuntime, type BotWorld } from '../src/client/Bots.ts';
import { ActiveSelectorBehavior } from '../src/client/ActiveSelector.ts';
import { Behavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/Behavior.js';
import { BehaviorStatus } from '@woosh/meep-engine/src/engine/intelligence/behavior/BehaviorStatus.js';
import { weaponStats } from '../src/game/Weapons.ts';
import { vec3, type Vec3 } from '../src/q3/math.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** 125 Hz, which is `sv_fps` on a Q3 server and what pmove is tuned around. */
const TICK = 1 / 125;

/**
 * One map's collision and navigation, loaded once.
 *
 * A real map and not a stand-in, because `Bot` runs `Pmove` against a `ClipMap`
 * and a bot standing on nothing is a bot in free fall for the whole test. The
 * geometry is otherwise not under test here: line of sight is a variable, and
 * routing only has to be possible, not good.
 */
function world(): { cm: ClipMap; graph: WaypointGraph; spawnQ3: number[] } {
    const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
    );

    const scene = JSON.parse(
        readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')
    ) as {
        entities: { classname?: string; _originQ3: number[] }[];
        submodels: { minsQ3: number[]; maxsQ3: number[] }[];
    };

    const graph = buildWaypoints(
        scene.submodels[0] ?? { minsQ3: [-4096, -4096, -4096], maxsQ3: [4096, 4096, 4096] },
        (start, mins, maxs, end, mask) => {
            const out = createTrace();
            boxTrace(out, cm, start, end, mins, maxs, mask);
            return out;
        }
    );

    const spawn = spawnPoints(scene.entities).points[0]!._originQ3;
    const node = graph.nearestInMainBody(spawn);
    const origin = node < 0 ? spawn : graph.nodes[node]!.origin;

    // Node origins are standing positions and the host adds Q3's own 9-unit
    // spawn lift, so take it back off. Yaw 0, so "in front" is +X.
    return { cm, graph, spawnQ3: [origin[0]!, origin[1]!, origin[2]! - 9, 0] };
}

const MAP = world();

/** One fired shot, as the tree handed it to the weapon system. */
interface Shot {
    /** Seconds since the harness started. */
    readonly at: number;
    readonly yaw: number;
    readonly pitch: number;
}

interface Harness {
    readonly bot: Bot;
    readonly runtime: BotRuntime;
    readonly shots: Shot[];
    /** Whether the trace to the target currently clears. Write it. */
    visible: boolean;
    /** Where the target is. Move it. */
    readonly target: Vec3;
    /** Seconds elapsed. */
    now: number;
    step(seconds?: number): void;
    /** Run until `done` or `limit` seconds have passed; returns the time taken. */
    until(done: () => boolean, limit?: number): number;
}

/**
 * One bot, one target, and a switch for whether it can see it.
 *
 * `random` defaults to a constant 0.5, which is not a lazy stub: it is the
 * *median* draw, so the reaction jitter contributes exactly zero and the
 * reaction is `BotSkill.reactionSeconds` on the nose. Cases that want a
 * distribution pass a seeded generator instead.
 */
function harness(options: {
    skill?: BotSkill;
    random?: () => number;
    /** How far in front of the bot the target starts. */
    range?: number;
} = {}): Harness {
    const skill = options.skill ?? difficulty(DEFAULT_DIFFICULTY);
    const range = options.range ?? 500;

    const shots: Shot[] = [];

    const state = {
        visible: true,
        now: 0,
    };

    const target = vec3(
        MAP.spawnQ3[0]! + range,
        MAP.spawnQ3[1]!,
        MAP.spawnQ3[2]! + 9
    );

    const botWorld: BotWorld = {
        graph: MAP.graph,
        items: [],
        visible: () => state.visible,
        playerOrigin: () => target,
        playerAlive: () => true,
        spawns: [MAP.spawnQ3],
        fire: (_bot, _eye, angles) => {
            shots.push({ at: state.now, yaw: angles[1]!, pitch: angles[0]! });
        },
    };

    const runtime = new BotRuntime(botWorld, null);
    runtime.setDifficulty(skill);

    const bot = new Bot({
        id: 2001,
        name: 'test',
        character: 'test',
        cm: MAP.cm,
        spawnQ3: MAP.spawnQ3,
        physics: null,
        movers: () => ({ movers: [] }),
        // Null: the ported `bg_pmove` against the clipmap, which is the
        // configuration that needs no physics world to stand up in.
        moverHost: null,
        random: options.random ?? (() => 0.5),
    });

    runtime.spawn(bot, null);

    const step = (seconds = TICK): void => {
        state.now += seconds;
        runtime.update(seconds, seconds * 1000, []);
    };

    return {
        bot,
        runtime,
        shots,
        get visible(): boolean {
            return state.visible;
        },
        set visible(v: boolean) {
            state.visible = v;
        },
        target,
        get now(): number {
            return state.now;
        },
        set now(v: number) {
            state.now = v;
        },
        step,
        until(done: () => boolean, limit = 20): number {
            const started = state.now;
            while (!done() && state.now - started < limit) step();
            return state.now - started;
        },
    };
}

/** mulberry32, so a distribution can be measured and still be reproducible. */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The bearing from the bot to the target, in degrees, as `lookAt` computes it. */
function bearing(bot: Bot, target: ArrayLike<number>): number {
    return (
        (Math.atan2(target[1]! - bot.origin[1]!, target[0]! - bot.origin[0]!) * 180) / Math.PI
    );
}

/** Signed difference between two yaws, in degrees, wrapped to +/-180. */
function angleDelta(a: number, b: number): number {
    return ((a - b + 540) % 360) - 180;
}

describe('the difficulty table', () => {
    it('has five levels with unique ids, easiest first', () => {
        expect(DIFFICULTIES.length).toBe(5);
        expect(new Set(DIFFICULTIES.map((d) => d.id)).size).toBe(5);
        expect(DIFFICULTIES.map((d) => d.level)).toEqual([1, 2, 3, 4, 5]);
    });

    /*
     Monotonic in every column, which is not decoration. A level that reacts
     faster but aims worse than the one below it is a level a player cannot
     choose between, and a table that is not ordered is one where "harder" stops
     meaning anything.
    */
    it('gets harder in every column and never in only some of them', () => {
        for (let i = 1; i < DIFFICULTIES.length; i++) {
            const easier = DIFFICULTIES[i - 1]!;
            const harder = DIFFICULTIES[i]!;

            expect(harder.reactionSeconds, harder.id).toBeLessThan(easier.reactionSeconds);
            expect(harder.aimErrorDegrees, harder.id).toBeLessThan(easier.aimErrorDegrees);
            expect(harder.aimDriftSeconds, harder.id).toBeLessThan(easier.aimDriftSeconds);
            expect(harder.trackingSeconds, harder.id).toBeLessThan(easier.trackingSeconds);
            expect(harder.turnSpeed, harder.id).toBeGreaterThan(easier.turnSpeed);
            expect(harder.sightRange, harder.id).toBeGreaterThan(easier.sightRange);
            expect(harder.searchSeconds, harder.id).toBeGreaterThan(easier.searchSeconds);
            expect(harder.blindFireSeconds, harder.id).toBeGreaterThanOrEqual(
                easier.blindFireSeconds
            );
        }
    });

    it('leans casual by default, and survives a stored id that no longer exists', () => {
        const chosen = difficulty(DEFAULT_DIFFICULTY);

        // Q3's own `g_spSkill` default: second of five, not third and not first.
        expect(chosen.level).toBe(2);
        expect(difficulty('a-level-that-was-renamed')).toBe(chosen);
    });

    /*
     The truncation is the property worth pinning. An untruncated normal has a
     tail, and the draw in a thousand that comes back at four sigma is a bot
     whose shot goes somewhere absurd -- which reads as a bug rather than as a
     miss.
    */
    it('draws a truncated normal, so no shot is ever absurd', () => {
        const random = seeded(1);
        let sum = 0;
        let sumSquares = 0;

        for (let i = 0; i < 20000; i++) {
            const z = gaussian(random);
            expect(Math.abs(z)).toBeLessThanOrEqual(2.5);
            sum += z;
            sumSquares += z * z;
        }

        expect(Math.abs(sum / 20000), 'mean').toBeLessThan(0.05);

        // Truncating at 2.5 sigma removes about 1.2% of the mass and takes some
        // variance with it, so the sample deviation lands just under 1.
        expect(Math.sqrt(sumSquares / 20000)).toBeGreaterThan(0.9);
        expect(Math.sqrt(sumSquares / 20000)).toBeLessThan(1.0);
    });
});

describe('a bot has to notice you first', () => {
    /*
     The second complaint, and the one with a number attached. Perception used to
     be the trace and nothing else: `enemyVisible` was set on the frame
     `world.visible` returned true.
    */
    it('does not engage on the frame the trace clears', () => {
        const skill = difficulty(DEFAULT_DIFFICULTY);
        const h = harness();

        h.step();
        expect(h.bot.enemyVisible, 'engaged on the first frame of sight').toBe(false);

        const took = h.until(() => h.bot.enemyVisible);

        /*
         The bounds are the model's own, not a measurement. `reactionSeconds` is
         the floor because awareness builds at most one second per second, and
         `reactionSeconds / AWARENESS_BEHIND` is the ceiling because it builds at
         least that fraction of a second per second however the bot is facing --
         and this bot turns while it walks, so its facing is not fixed.
        */
        expect(took, 'time to notice').toBeGreaterThanOrEqual(skill.reactionSeconds);
        expect(took).toBeLessThanOrEqual(skill.reactionSeconds / AWARENESS_BEHIND + TICK);
    });

    it('does not fire before it has noticed', () => {
        const h = harness();

        h.until(() => h.bot.enemyVisible);

        expect(h.shots.length, 'shots fired before noticing').toBe(0);
    });

    /*
     The one measurement in this file that has to hold the bot's *facing* still,
     and does it by keeping the target directly overhead: `attention` falls off
     with the angle off the view axis, and a bot walking a route is pointed
     somewhere new every second. Overhead, the horizontal offset is zero, the
     rate is exactly one second per second, and the reaction is the table's own
     number rather than a bound around it.

     Contrived on purpose. The case above measures a bot in the ordinary
     situation and can only assert a range; this one gives up the situation to
     get the number.
    */
    it("pays the reaction its difficulty asks for, to the tick", () => {
        const noticeIn = (skill: BotSkill): number => {
            const h = harness({ skill });

            while (!h.bot.enemyVisible && h.now < 10) {
                h.target[0] = h.bot.origin[0]!;
                h.target[1] = h.bot.origin[1]!;
                h.target[2] = h.bot.origin[2]! + 200;
                h.step();
            }

            return h.now;
        };

        const times = DIFFICULTIES.map(noticeIn);

        DIFFICULTIES.forEach((skill, i) => {
            expect(times[i], skill.id).toBeGreaterThanOrEqual(skill.reactionSeconds);
            expect(times[i], skill.id).toBeLessThanOrEqual(skill.reactionSeconds + 2 * TICK);
        });

        // Which is the table's order, since the table is what it just paid.
        for (let i = 1; i < times.length; i++) {
            expect(times[i], DIFFICULTIES[i]!.id).toBeLessThan(times[i - 1]!);
        }
    });

    /*
     Being shot is perception too. Without this, `AWARENESS_BEHIND` would have
     introduced the failure it exists to avoid: a bot facing away builds
     awareness at a quarter rate, which at the easiest level is 3.6 seconds of
     standing there while somebody empties a magazine into its back.
    */
    it('notices immediately when something hits it', () => {
        const h = harness();

        h.step();
        expect(h.bot.enemyVisible).toBe(false);

        h.bot.health -= 20;
        h.step();

        expect(h.bot.enemyVisible, 'a bot that has been shot is still thinking about it').toBe(
            true
        );
    });

    /*
     And the half of that which does not need line of sight. A rocket that lands
     behind a bot tells it something is out there; it does not tell it where, so
     the trace still has to clear before there is anything to fight.
    */
    it('comes out of an ambush alert, without having seen the shooter', () => {
        const skill = difficulty(DEFAULT_DIFFICULTY);
        const h = harness();

        h.visible = false;
        h.step();

        h.bot.health -= 20;
        h.step();

        expect(h.bot.enemyVisible, 'engaged something it has no trace to').toBe(false);

        h.until(() => false, 0.2);
        h.visible = true;

        const took = h.until(() => h.bot.enemyVisible, 5);

        /*
         Less than a whole reaction, which a fresh sighting can never manage: the
         meter was already most of the way up when the trace cleared.
        */
        expect(took, 'a bot that had been shot paid the full reaction anyway').toBeLessThan(
            skill.reactionSeconds
        );
    });

    /*
     Awareness drains more slowly than it fills, and the reason is an exploit
     rather than realism: a countdown that restarts whenever line of sight breaks
     is a countdown a player can hold at zero by stepping in and out of a
     doorway. Here the glimpses add up instead.
    */
    it('accumulates glimpses instead of forgetting between them', () => {
        const h = harness();
        const skill = difficulty(DEFAULT_DIFFICULTY);

        /*
         Half a reaction in sight, then a tenth of one out of it, over and over.
         No single look is ever long enough to notice on its own, so a countdown
         that restarted on every break would sit here forever -- which is exactly
         the doorway exploit the meter exists to close.

         The ratio is well clear of the break-even one on purpose. This bot is
         walking a route while it glimpses, so its facing is not fixed and its
         awareness rate is somewhere between `AWARENESS_BEHIND` and 1; the
         property has to hold at the bottom of that range, and at the bottom the
         look has to be worth more than `forgetRate` times the gap.
        */
        const glimpse = skill.reactionSeconds * 0.5;
        const gap = skill.reactionSeconds * 0.1;

        for (let i = 0; i < 40 && !h.bot.enemyVisible; i++) {
            h.visible = true;
            h.until(() => h.bot.enemyVisible, glimpse);
            if (h.bot.enemyVisible) break;
            h.visible = false;
            h.until(() => false, gap);
        }

        expect(h.bot.enemyVisible, 'never noticed a target it kept glimpsing').toBe(true);
    });
});

describe('a bot does not have perfect aim', () => {
    /*
     The first complaint. A bot used to turn until the yaw error was inside eight
     degrees and then fire down its own view axis, which after a frame or two of
     turning is the exact bearing to the target.
    */
    it('fires off the true bearing, and off it differently from shot to shot', () => {
        const h = harness({ random: seeded(7) });

        h.until(() => h.shots.length >= 60, 60);
        expect(h.shots.length, 'shots to measure').toBeGreaterThanOrEqual(60);

        const errors = h.shots.map((shot) => angleDelta(shot.yaw, bearing(h.bot, h.target)));

        expect(Math.max(...errors.map(Math.abs)), 'every shot on the true bearing').toBeGreaterThan(
            1
        );

        // And within the truncation, plus the tolerance the trigger gate allows
        // the swing to still be off by.
        const skill = difficulty(DEFAULT_DIFFICULTY);
        expect(Math.max(...errors.map(Math.abs))).toBeLessThan(2.5 * skill.aimErrorDegrees + 4);
    });

    /*
     Correlated, not resampled per shot. A bot whose error is a fresh draw every
     time hits at its average rate and never misses you *consistently*, which is
     the thing a player reads as "it has lost me" and moves against.
    */
    it('wanders its aim rather than re-rolling it', () => {
        const h = harness({ random: seeded(11) });

        h.until(() => h.shots.length >= 40, 60);

        const errors = h.shots.map((shot) => angleDelta(shot.yaw, bearing(h.bot, h.target)));

        let steps = 0;
        for (let i = 1; i < errors.length; i++) steps += Math.abs(errors[i]! - errors[i - 1]!);

        const spread = Math.max(...errors) - Math.min(...errors);

        /*
         Independent draws would step about the full spread between consecutive
         shots. A wander steps a fraction of it. The shots are a tenth of a
         second apart and the drift interval is 0.8 s, so the bound is generous
         and the property is still unmistakable.
        */
        expect(steps / (errors.length - 1), 'mean step between consecutive shots').toBeLessThan(
            spread / 3
        );
    });

    /*
     Angular and not positional, which is the choice the whole model turns on: a
     fixed offset at the target would keep a bot as deadly at 1,500 units as at
     150, and range would stop being a thing a player can use.
    */
    it('misses by an angle, so the miss grows with the range', () => {
        const near = harness({ random: seeded(3), range: 150 });
        const far = harness({ random: seeded(3), range: 1500 });

        for (const h of [near, far]) h.until(() => h.shots.length >= 40, 60);

        const spread = (h: Harness): number => {
            const errors = h.shots.map((s) => angleDelta(s.yaw, bearing(h.bot, h.target)));
            return Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
        };

        const nearAngle = spread(near);
        const farAngle = spread(far);

        // The same angle at both ranges, within the noise of forty shots.
        expect(farAngle).toBeGreaterThan(nearAngle * 0.4);
        expect(farAngle).toBeLessThan(nearAngle * 2.5);

        /*
         Which is the same thing as saying the lateral miss scales with the
         range. A player box is 30 units across, so at 150 units this bot is
         mostly on target and at 1,500 it mostly is not -- and that is what
         "angular" buys.
        */
        const lateral = (angle: number, range: number): number =>
            Math.tan((angle * Math.PI) / 180) * range;

        expect(lateral(nearAngle, 150), 'miss at 150 units').toBeLessThan(15);
        expect(lateral(farAngle, 1500), 'miss at 1500 units').toBeGreaterThan(15);
    });

    /*
     Tracking, which is the third of the three and the one with a sign to it. The
     bot aims where the target *was* `trackingSeconds` ago -- a lag, and the
     exact opposite of the aim prediction D-055 rules out. Measured against a bot
     that is identical except for carrying no lag, because the absolute number
     depends on how fast the bearing happens to be sweeping and the *difference*
     does not.
    */
    it('trails a moving target instead of leading it', () => {
        const base = difficulty('hurt-me-plenty');

        // No aim error in either, so the only thing left in the signal is the
        // lag. The two bots are otherwise the same bot.
        const lagging: BotSkill = { ...base, aimErrorDegrees: 0 };
        const instant: BotSkill = { ...base, aimErrorDegrees: 0, trackingSeconds: 0 };

        const meanError = (skill: BotSkill): number => {
            const h = harness({ skill, range: 700 });
            h.until(() => h.shots.length > 0, 20);

            const seen = h.shots.length;
            const errors: number[] = [];

            for (let i = 0; i < 400; i++) {
                // Straight across the bot's view at a run, which is what a
                // player strafing past a corner does.
                h.target[1] = h.target[1]! + 300 * TICK;
                h.step();

                const bearingNow = bearing(h.bot, h.target);
                for (let j = seen + errors.length; j < h.shots.length; j++) {
                    errors.push(angleDelta(h.shots[j]!.yaw, bearingNow));
                }
            }

            expect(errors.length, 'shots at a moving target').toBeGreaterThan(10);
            return errors.reduce((a, e) => a + e, 0) / errors.length;
        };

        const withLag = meanError(lagging);
        const withoutLag = meanError(instant);

        /*
         The target moves toward increasing yaw, so trailing it is a *negative*
         error. The bot with no lag sits near zero -- only the trigger's own
         tolerance is left -- and the one with a lag sits behind it.
        */
        expect(withLag, 'aimed ahead of a target it is supposed to trail').toBeLessThan(0);
        expect(withLag).toBeLessThan(withoutLag - 1);
    });

    it('aims true when the difficulty says it has no error to carry', () => {
        const perfect: BotSkill = { ...difficulty('nightmare'), aimErrorDegrees: 0 };
        const h = harness({ skill: perfect, random: seeded(5) });

        h.until(() => h.shots.length >= 20, 60);
        expect(h.shots.length).toBeGreaterThanOrEqual(20);

        for (const shot of h.shots) {
            // Only the trigger gate's own tolerance is left, and the swing has
            // long since settled inside it.
            expect(Math.abs(angleDelta(shot.yaw, bearing(h.bot, h.target)))).toBeLessThan(3);
        }
    });
});

describe('a bot stops shooting when it has lost you', () => {
    /*
     The third complaint, and the one that was not a tuning problem: the guard in
     front of the fight branch sat in a `Sequence` whose cursor had already moved
     past it, in front of a behaviour that never failed. A bot that had entered
     the fight branch stayed in it, firing at the last sighting, for as long as
     it had ammunition.
    */
    it('fires for blindFireSeconds after losing sight, and then not at all', () => {
        const skill = difficulty(DEFAULT_DIFFICULTY);
        const h = harness();

        h.until(() => h.shots.length > 0, 20);
        expect(h.shots.length, 'never opened fire').toBeGreaterThan(0);

        h.visible = false;
        const lost = h.now;

        // Well past `searchSeconds`, which is when the fight branch gives up
        // even if nothing else has stopped it.
        h.until(() => false, skill.searchSeconds + 5);

        const after = h.shots.filter((s) => s.at > lost);
        const last = after.length === 0 ? lost : after[after.length - 1]!.at;

        expect(last - lost, 'seconds of firing after losing sight').toBeLessThanOrEqual(
            skill.blindFireSeconds + 2 * TICK
        );

        /*
         And the count, because the duration alone would pass for a bot that
         fired once a second. At the machinegun's 100 ms this is two rounds into
         the corner and no more; before D-162 the same window produced upwards of
         eighty, and then went looking for more ammunition.
        */
        const rounds = Math.ceil(skill.blindFireSeconds / (weaponStats('WP_MACHINEGUN').fireRateMs / 1000));
        expect(after.length, 'rounds fired blind').toBeLessThanOrEqual(rounds + 1);
    });

    it('never fires blind at all on the easiest difficulty', () => {
        const h = harness({ skill: difficulty('i-can-win') });

        h.until(() => h.shots.length > 0, 30);
        expect(h.shots.length).toBeGreaterThan(0);

        h.visible = false;
        const lost = h.now;
        h.until(() => false, 8);

        expect(h.shots.filter((s) => s.at > lost).length).toBe(0);
    });

    /*
     Giving up is the other half, and it has to be observable: a bot that stopped
     shooting but stood staring at a corner for the rest of the match would pass
     the case above and still be broken. Going back to routing is what "gave up"
     means, and a planned path is what routing looks like.
    */
    it('gives up and goes back to its route', () => {
        const skill = difficulty(DEFAULT_DIFFICULTY);
        const h = harness();

        h.until(() => h.bot.enemyVisible, 20);
        h.bot.clearPath();

        // While the fight is on, the fight branch outranks planning -- so the
        // bot has no route, and that is the priority order being real.
        h.until(() => false, 1);
        expect(h.bot.path.length, 'planned a route mid-fight').toBe(0);

        h.visible = false;
        h.until(() => h.bot.path.length > 0, skill.searchSeconds + 3);

        expect(h.bot.path.length, 'still hunting long after it lost the target').toBeGreaterThan(0);
        expect(h.bot.enemyVisible).toBe(false);
    });

    /*
     The preemption this depends on, stated on its own. Under meep's plain
     `SelectorBehavior` a bot that had started walking a route never reached the
     fight branch again until the route ran out, which on a long path is several
     seconds of walking past somebody in plain sight.
    */
    it('drops what it was doing the moment it notices, without finishing its route', () => {
        const skill = difficulty(DEFAULT_DIFFICULTY);
        const h = harness();

        h.visible = false;
        h.until(() => h.bot.path.length > 0, 5);

        const route = h.bot.path.length;
        expect(route, 'never planned a route to interrupt').toBeGreaterThan(1);

        h.visible = true;
        const took = h.until(() => h.bot.enemyVisible, 10);

        expect(took, 'time to notice while travelling').toBeLessThanOrEqual(
            skill.reactionSeconds / AWARENESS_BEHIND + TICK
        );
        expect(h.bot.pathAt, 'walked the whole route before reacting').toBeLessThan(route);
    });
});

describe('difficulty can be changed with the match running', () => {
    it('reaches every bot already standing in the level', () => {
        const h = harness();
        const nightmare = difficulty('nightmare');

        expect(h.bot.skill.id).toBe(DEFAULT_DIFFICULTY);

        h.runtime.setDifficulty(nightmare);

        expect(h.bot.skill).toBe(nightmare);
        expect(h.runtime.difficulty).toBe(nightmare);
    });
});

/* ------------------------------------------------------------------ *
 * The composite underneath all of it.
 * ------------------------------------------------------------------ */

/** A behaviour that reports whatever it is told to, and counts its own life. */
class Scripted extends Behavior<null> {
    initialized = 0;
    finalized = 0;
    ticks = 0;

    constructor(public status: number) {
        super();
    }

    override initialize(context?: null): void {
        this.initialized += 1;
        super.initialize(context);
    }

    override finalize(): void {
        this.finalized += 1;
        super.finalize();
    }

    override tick(): number {
        this.ticks += 1;
        return this.status;
    }
}

describe('ActiveSelector', () => {
    it('re-asks from the top every tick, unlike a plain selector', () => {
        const first = new Scripted(BehaviorStatus.Failed);
        const second = new Scripted(BehaviorStatus.Running);

        const tree = ActiveSelectorBehavior.from<null>([first, second]);
        tree.initialize(null);

        tree.tick(TICK);
        expect(second.ticks).toBe(1);

        // The higher-priority child changes its mind. A `SelectorBehavior` would
        // never look at it again; this one does, on the very next tick.
        first.status = BehaviorStatus.Running;

        expect(tree.tick(TICK)).toBe(BehaviorStatus.Running);
        expect(first.ticks).toBe(2);
        expect(second.ticks).toBe(1);
    });

    it('aborts the child it takes the slot from, exactly once', () => {
        const first = new Scripted(BehaviorStatus.Failed);
        const second = new Scripted(BehaviorStatus.Running);

        const tree = ActiveSelectorBehavior.from<null>([first, second]);
        tree.initialize(null);

        tree.tick(TICK);
        expect(second.initialized).toBe(1);
        expect(second.finalized).toBe(0);

        first.status = BehaviorStatus.Running;
        tree.tick(TICK);

        expect(second.finalized, 'the aborted child was not finalized').toBe(1);
        expect(second.initialized, 'the aborted child was restarted').toBe(1);
    });

    /*
     The bookkeeping bug this class is easiest to write: a running child that
     fails on its own turn is finalized there, and finalizing it again when a
     later child claims the slot would be one `finalize` too many.
    */
    it('never finalizes a child twice when the running one fails and a later one runs', () => {
        const first = new Scripted(BehaviorStatus.Running);
        const second = new Scripted(BehaviorStatus.Failed);

        const tree = ActiveSelectorBehavior.from<null>([first, second]);
        tree.initialize(null);

        tree.tick(TICK);
        expect(first.initialized).toBe(1);

        // Now the running child fails and the one after it takes over.
        first.status = BehaviorStatus.Failed;
        second.status = BehaviorStatus.Running;
        tree.tick(TICK);

        expect(first.finalized).toBe(1);
        expect(second.initialized).toBe(1);
        expect(second.finalized).toBe(0);
    });

    it('keeps a running child running without restarting it', () => {
        const only = new Scripted(BehaviorStatus.Running);
        const tree = ActiveSelectorBehavior.from<null>([only]);
        tree.initialize(null);

        for (let i = 0; i < 5; i++) tree.tick(TICK);

        expect(only.initialized, 'restarted a child that never stopped').toBe(1);
        expect(only.ticks).toBe(5);
        expect(only.finalized).toBe(0);
    });

    it('fails when every child does, having cleaned all of them up', () => {
        const first = new Scripted(BehaviorStatus.Failed);
        const second = new Scripted(BehaviorStatus.Failed);

        const tree = ActiveSelectorBehavior.from<null>([first, second]);
        tree.initialize(null);

        expect(tree.tick(TICK)).toBe(BehaviorStatus.Failed);
        expect(first.initialized).toBe(first.finalized);
        expect(second.initialized).toBe(second.finalized);
    });

    it('finalizes the child it is holding when the tree is finalized', () => {
        const only = new Scripted(BehaviorStatus.Running);
        const tree = ActiveSelectorBehavior.from<null>([only]);

        tree.initialize(null);
        tree.tick(TICK);
        tree.finalize();

        expect(only.finalized).toBe(1);

        // And not again on a second finalize, which `runTree` is entitled to do.
        tree.finalize();
        expect(only.finalized).toBe(1);
    });
});
