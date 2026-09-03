/*
 * Bots.ts -- the behaviour trees, and everything that watches them.
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
 * botlib, replaced. Q3's bot is a state machine over AAS with fuzzy weights, a
 * chat system and per-character personality files; the brief says to use
 * behaviour trees instead, and meep ships one.
 *
 * The tree is deliberately small, and its shape is the argument for the
 * approach. A Q3 deathmatch bot does three things in strict priority -- fight
 * what it can see, go to what it wants, decide what it wants -- and a selector
 * over three branches says exactly that, in the order it is meant to be read.
 * The equivalent in `ai_dmq3.c` is spread across a dozen functions and a
 * `ainode_t` function pointer.
 *
 *     ActiveSelector
 *       Conditional [ something to fight? -> Fight  ]
 *       Conditional [ a route to walk?    -> Travel ]
 *       Action      [ pick a goal and a route      ]
 *
 * **`ActiveSelector` and not `SelectorBehavior`, and the difference is not a
 * detail.** A plain selector commits: it remembers the child it settled on and
 * ticks that one until it fails, so "strict priority" above was a description of
 * the first frame only. Two things followed, and both were reported as bugs
 * before anyone read this file. A bot that had entered `Travel` walked its whole
 * route past a visible enemy, because the fight branch was never reached again;
 * and a bot that had entered `Fight` fought forever, because the guard in front
 * of it lived in a `Sequence` whose cursor had already moved past it and
 * `Fight` never failed -- so it stood there firing at a corner until its ammo
 * ran out. See `ActiveSelector.ts` for the composite, and D-162 for the rest.
 *
 * **Perception is on this side of the line, and it is not the same question as
 * line of sight.** `world.visible` says whether the trace clears; whether the
 * bot has *noticed* is an accumulating quantity with a reaction time on it, and
 * `perceive` below owns it. A bot inside its reaction delay can see the player
 * perfectly well and is still walking to the rocket launcher.
 *
 * What is missing relative to botlib, and is missing on purpose: no chat, no
 * team play, no fuzzy weapon preference, no rocket jumping, no prediction of
 * where a target will be. Recorded in DECISIONS.md rather than implied.
 */

import { ConditionBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/util/ConditionBehavior.js';
import { ConditionalBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/util/ConditionalBehavior.js';
import { ActionBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/primitive/ActionBehavior.js';
import { Behavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/Behavior.js';
import { BehaviorStatus } from '@woosh/meep-engine/src/engine/intelligence/behavior/BehaviorStatus.js';

import { ActiveSelectorBehavior } from './ActiveSelector.ts';
import { Bot } from '../game/Bot.ts';
import { DEFAULT_DIFFICULTY, difficulty, type BotSkill } from '../game/Difficulty.ts';
import { Character, CHARACTERS, type LegsAnimation } from './Characters.ts';
import { WaypointGraph } from '../game/Waypoints.ts';
import { weaponStats, type WeaponId } from '../game/Weapons.ts';
import { vec3, type Vec3, type Vec3Like } from '../q3/math.ts';
import type { ItemInstance } from '../game/Items.ts';
import { canBeGrabbed, touchesItem, type Inventory } from '../game/Items.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';

/** Re-plan at least this often, so a bot notices a door that opened. */
const REPLAN_SECONDS = 8;

/**
 * How much attention a bot may bank beyond the reaction it needed, as a
 * multiple of it.
 *
 * The ceiling is what turns "sight for N seconds" into a short grace period
 * rather than an unbounded one. Without it a bot that had watched you for thirty
 * seconds would carry thirty seconds of credit into the next corner and
 * re-acquire instantly for the rest of the match; with it the credit is worth
 * `0.5 * reactionSeconds / forgetRate` of lost sight and no more.
 */
const AWARENESS_CEILING = 1.5;

/**
 * How much of its detection rate a bot keeps for a target it is not facing.
 *
 * Q3's `BotFindEnemy` asks `BotEntityVisible(..., 360, ...)` -- its bots have no
 * blind spot at all, and neither do these. What they have instead is eccentricity:
 * the rate falls off as the cosine of the angle off the view axis, down to this
 * floor directly behind. Detection *is* slower in the periphery in every study of
 * it, and a soft falloff does that without the failure mode a hard cone has,
 * which is a bot that can be walked up to and shot in the back forever.
 *
 * The reaction times in `Difficulty.ts` are therefore the on-axis figures; a
 * target at 90 degrees costs four times as long to notice.
 */
export const AWARENESS_BEHIND = 0.25;

/** How often the tracked position of a sighted enemy is recorded, in seconds. */
const TRACK_SAMPLE_SECONDS = 0.02;

/**
 * How much of that history is kept, in seconds.
 *
 * Comfortably over the largest `BotSkill.trackingSeconds`, and no more: a
 * sighting older than this is not a lag, it is a memory, and aiming at one would
 * make a bot that re-acquires an enemy shoot at where they were a second ago.
 */
const TRACK_HISTORY_SECONDS = 0.7;

/** How close to the last sighting counts as having searched it, in Q3 units. */
const SEARCH_ARRIVE = 80;

/**
 * The shortest a hunt is allowed to be, in seconds.
 *
 * Without a floor, a player who breaks line of sight *near* the bot -- behind
 * the pillar two metres away, which is the commonest way it happens -- is
 * already at the searched-it radius, so the bot would give up on the frame it
 * lost them and turn round. That reads as a bot with no object permanence.
 */
const MIN_PURSUIT_SECONDS = 0.75;

export interface BotWorld {
    readonly graph: WaypointGraph;
    /** Everything a bot might want to walk to. */
    readonly items: readonly ItemInstance[];
    /**
     * `BotEntityVisible`: is the line from `fromQ3` to `toQ3` unobstructed?
     *
     * A boolean rather than a trace, because that is the entire question -- and
     * asking it as a trace is what made it expensive. This used to be the
     * general `trace(start, mins, maxs, end, mask)`, called with zero mins and
     * maxs to mean "a ray"; every backend behind it then rebuilt that ray into a
     * swept box. `WeaponSystem.visible` is the query, and it is the same one
     * `CanDamage` uses, so a bot's sight and its bullet agree by construction.
     * See D-159.
     */
    visible(fromQ3: ArrayLike<number>, toQ3: ArrayLike<number>): boolean;
    /**
     * Everyone this bot may shoot at, as of this frame.
     *
     * Replaces the single `playerOrigin`/`playerAlive` pair, which could only
     * ever describe one human and so made a networked match with two clients a
     * match in which the bots ignored one of them.
     *
     * **The list is the whole of D-055's guarantee.** Bots never target each
     * other, and that is expressed by this method returning only humans rather
     * than by any test inside the AI -- so there is one place to read to know it
     * is true, and `match.test.ts` holds it. A slot that is disconnected or dead
     * is not in the list either, so a bot stops shooting at a corpse without the
     * AI knowing what death is.
     *
     * Called once per bot per frame and not held: `originQ3` is the live array
     * behind whichever slot it describes.
     */
    targets(): readonly BotTarget[];
    /** Spawn points, for respawning. */
    readonly spawns: readonly number[][];
    fire(bot: Bot, eyeQ3: Vec3Like, anglesQ3: ArrayLike<number>, weapon: WeaponId): void;
}

/** Somebody a bot may shoot at. See {@link BotWorld.targets}. */
export interface BotTarget {
    /** The slot's Q3 origin. Live, so read it rather than keeping it. */
    readonly originQ3: ArrayLike<number>;
    /** Client id, so a caller can say which human a bot engaged. */
    readonly id: number;
}

/**
 * One recorded sighting, for the tracking lag.
 *
 * A plain object rather than a flat array of numbers because there are at most
 * `TRACK_HISTORY_SECONDS / TRACK_SAMPLE_SECONDS` of them per bot -- 35 -- and
 * the readable version is worth more than the allocation.
 */
interface Sighting {
    /** `Blackboard.clock` when it was taken. */
    readonly t: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The blackboard the tree reads and writes. */
interface Blackboard {
    readonly bot: Bot;
    readonly world: BotWorld;
    /** Seconds since the enemy was last *noticed*, which is not the same as seen. */
    sinceSeen: number;
    /** Seconds since the last route was planned. */
    sincePlan: number;
    delta: number;

    /**
     * Seconds of accumulated attention on the enemy.
     *
     * Builds while the enemy is in sight and drains at `BotSkill.forgetRate`
     * while it is not, and the bot has noticed once it passes
     * {@link Blackboard.reactionNeeded}. One number rather than a timer plus a
     * flag, and the reason is the failure a timer has: a reaction timer that
     * restarts whenever line of sight breaks is a timer a player can hold at
     * zero by stepping in and out of a doorway. A meter that drains more slowly
     * than it fills cannot be, and it says something true besides -- glimpses
     * add up.
     */
    awareness: number;
    /**
     * What this engagement's reaction costs, drawn when awareness leaves zero.
     *
     * Per engagement rather than per bot, so that six bots coming round a corner
     * do not fire on the same frame, and so that the same bot is not reliably
     * the fast one.
     */
    reactionNeeded: number;

    /** Monotonic seconds, for stamping {@link history}. */
    clock: number;
    /** Recent sightings, oldest first. The tracking lag reads from behind. */
    readonly history: Sighting[];

    /**
     * The bot's health at the end of the previous frame.
     *
     * Being shot is perception too, and the cheapest kind: a bot that loses
     * health has learned that somebody is looking at it, whatever its own eyes
     * were pointed at. Compared here rather than plumbed through a damage
     * callback because `Damageable` is deliberately plain data and a bot is one
     * of several things `G_Damage` writes to -- the difference between two
     * frames says the same thing and costs nothing to arrange.
     */
    lastHealth: number;
}

/* ------------------------------------------------------------------ *
 * Long-running behaviours.
 *
 * `ActionBehavior` is single-shot and succeeds; these have to report `Running`
 * across frames, which is the whole reason a behaviour tree is a tree rather
 * than a switch.
 * ------------------------------------------------------------------ */

const scratchEye = vec3();
const scratchAngles = vec3();
const scratchAim = vec3();

/**
 * Where the bot points, given how far behind it is tracking.
 *
 * The newest sighting at or before `now - lag`, which is the enemy's position
 * `lag` seconds ago -- not an extrapolation of where it is going, which is the
 * aim prediction D-055 rules out, and not its position now, which is what a
 * machine does. Falls back to the last known position when the history is
 * shorter than the lag, which is every re-acquisition: you cannot trail a target
 * you have only just picked up.
 */
function aimPoint(board: Blackboard, lag: number, out: Vec3): Vec3 {
    const history = board.history;

    if (history.length === 0) {
        out[0] = board.bot.lastSeen[0]!;
        out[1] = board.bot.lastSeen[1]!;
        out[2] = board.bot.lastSeen[2]!;
        return out;
    }

    const want = board.clock - lag;
    let chosen = history[0]!;
    for (const sighting of history) {
        if (sighting.t > want) break;
        chosen = sighting;
    }

    out[0] = chosen.x;
    out[1] = chosen.y;
    out[2] = chosen.z;
    return out;
}

/**
 * Walk the current path, one node at a time.
 *
 * Fails when the path runs out or the bot is wedged, which drops the selector
 * through to the planning branch -- that is how a stuck bot recovers, rather
 * than by a special case.
 */
class TravelBehavior extends Behavior<Blackboard> {
    override tick(_timeDelta: number): number {
        const board = this.context;
        if (board === null) return BehaviorStatus.Failed;

        const { bot, world } = board;
        const nodeOrigin = (index: number): Vec3 | null => {
            const node = world.graph.nodes[index];
            return node === undefined ? null : (node.origin as unknown as Vec3);
        };

        bot.advancePath(nodeOrigin, board.delta);

        const target = bot.currentTarget(nodeOrigin);
        if (target === null) {
            bot.clearPath();
            return BehaviorStatus.Failed;
        }

        /*
         Wedged for a second. Q3 has `BotCheckAttack`-adjacent recovery all over
         `ai_dmq3.c`; here it is one branch, because a stuck bot's only useful
         move is to stop believing in its route.
        */
        if (bot.stuckFor > 1 || bot.noProgressFor > 2) {
            bot.jump();
            bot.clearPath();
            return BehaviorStatus.Failed;
        }

        bot.moveToward(target);

        /*
         Look where you are going, and only that.

         This used to hold the last-seen direction for a few seconds first, as
         the cheapest version of Q3's `lastenemyareanum`. That job has moved: the
         fight branch outranks this one and keeps running for the whole of
         `BotSkill.searchSeconds`, so a bot that has recently lost an enemy is
         hunting it in `FightBehavior.search` and never reaches this line. The
         branch was not dead when it was written; it is dead now, and a
         still-plausible branch that cannot execute is worse than none.
        */
        bot.lookAt(target);

        return BehaviorStatus.Running;
    }
}

/**
 * Fight what the bot has noticed, and hunt it when it goes.
 *
 * Two states, and the split is the point: the bot shoots at an enemy it can
 * *see*, and walks toward one it cannot. What it used to do instead was shoot at
 * `lastSeen` regardless -- and because the guard in front of this branch was
 * never re-evaluated (see the file header), "regardless" meant until the
 * magazine was empty and then until it found more ammunition. That is the
 * "keeps firing at the spot where they lost sight of you" report, and there is
 * no amount of accuracy tuning that fixes it, because the bot was not missing.
 *
 * The one exception is deliberate: `BotSkill.blindFireSeconds` of shooting into
 * the corner somebody has just gone round. A player does that. Its unit is
 * tenths of a second at the difficulty a player is likely to be on, which is the
 * difference between a reflex and a tantrum.
 */
class FightBehavior extends Behavior<Blackboard> {
    override tick(_timeDelta: number): number {
        const board = this.context;
        if (board === null || board === undefined) return BehaviorStatus.Failed;

        return board.bot.enemyVisible ? this.engage(board) : this.search(board);
    }

    /** In sight: keep the preferred range, aim behind it, and shoot. */
    private engage(board: Blackboard): number {
        const bot = board.bot;

        bot.aimAt(aimPoint(board, bot.skill.trackingSeconds, scratchAim));

        const dx = bot.lastSeen[0]! - bot.origin[0]!;
        const dy = bot.lastSeen[1]! - bot.origin[1]!;
        const distance = Math.hypot(dx, dy);

        /*
         Close the distance with a machinegun, keep it with a rocket launcher.
         This is the whole of the port's weapon tactics and it is deliberately
         thin: Q3's `BotChooseWeapon` reads fuzzy weights out of a character
         file, and reproducing that without the files is guesswork dressed as
         fidelity.
        */
        const preferRange = bot.weapon === 'WP_ROCKET_LAUNCHER' ? 600 : 250;

        if (distance > preferRange + 100) bot.moveToward(bot.lastSeen);
        else if (distance < preferRange - 100) {
            // Back off, by walking toward the point opposite the enemy.
            bot.moveToward([
                bot.origin[0]! - dx,
                bot.origin[1]! - dy,
                bot.origin[2]!,
            ]);
        }

        if (bot.aimed) {
            bot.fire(weaponStats(bot.weapon).fireRateMs, scratchEye, scratchAngles);
        }

        return BehaviorStatus.Running;
    }

    /**
     * Out of sight: a short burst if it only just went, then walk over and look.
     *
     * Failing here is how the hunt ends, and it has to be able to end early --
     * the guard's `searchSeconds` alone would have every bot spend the full
     * window walking at a spot it can already see is empty. Arriving is the
     * answer to "they have gone", and being wedged is the answer to "you cannot
     * get there from here"; both hand the bot back to its route.
     */
    private search(board: Blackboard): number {
        const bot = board.bot;

        bot.aimAt(bot.lastSeen);

        if (board.sinceSeen < bot.skill.blindFireSeconds) {
            if (bot.aimed) {
                bot.fire(weaponStats(bot.weapon).fireRateMs, scratchEye, scratchAngles);
            }
            return BehaviorStatus.Running;
        }

        if (bot.stuckFor > 1) return this.giveUp(board);

        const dx = bot.lastSeen[0]! - bot.origin[0]!;
        const dy = bot.lastSeen[1]! - bot.origin[1]!;

        if (Math.hypot(dx, dy) < SEARCH_ARRIVE && board.sinceSeen > MIN_PURSUIT_SECONDS) {
            return this.giveUp(board);
        }

        bot.moveToward(bot.lastSeen);
        return BehaviorStatus.Running;
    }

    /**
     * Stop believing there is anyone there.
     *
     * `sinceSeen` rather than a flag of its own, because it is already what the
     * guard asks about and a second field saying the same thing is a second
     * field to forget to clear. The sighting history goes with it: those samples
     * are for trailing a target that is in front of the bot, and the next
     * engagement must not aim at one of them.
     */
    private giveUp(board: Blackboard): number {
        board.sinceSeen = Infinity;
        board.history.length = 0;
        return BehaviorStatus.Failed;
    }
}

/* ------------------------------------------------------------------ *
 * The runtime.
 * ------------------------------------------------------------------ */

export interface BotStats {
    readonly bots: number;
    readonly nodes: number;
    readonly links: number;
    readonly reachable: number;
}

export class BotRuntime {
    readonly bots: Bot[] = [];

    private readonly world: BotWorld;
    private readonly boards = new Map<number, Blackboard>();
    private readonly trees = new Map<number, ActiveSelectorBehavior<Blackboard>>();
    private readonly characters = new Map<number, Character>();

    /** What the match is set to. See {@link setDifficulty}. */
    private skill: BotSkill = difficulty(DEFAULT_DIFFICULTY);

    private readonly scratch: Vec3 = vec3();
    private readonly playerEye: Vec3 = vec3();

    private readonly audio: AudioBank | null;

    /**
     * The loop each bot's held weapon is making, and which sound it is.
     *
     * `CG_AddPlayerWeapon` re-adds this every frame from scratch, so switching
     * between `firingSound` and `readySound` costs it nothing. A retained
     * emitter has to be told, which is what the name is kept for.
     */
    private readonly weaponLoops = new Map<number, { loop: SoundLoop; name: string }>();

    /**
     * Where a bot's choices come from.
     *
     * `Math.random` in single-player, which is what a match has always run on
     * and is fine there. A networked host injects its own seeded generator
     * instead, and the reason is not that a server-authoritative game needs
     * determinism -- clients are told what happened -- but that a *test* has to
     * be able to run the same match twice. Two of the three draws a bot makes
     * live here (which goal it walks to, and which spawn it comes back at); the
     * third is the weapon seed, which `BotWorld.fire` owns.
     *
     * Found by a flaky assertion rather than by reading: `net-loopback.test.ts`
     * asked whether any bot had fired a rocket in forty seconds, and the answer
     * depended on which corridors the bots had happened to choose.
     */
    random: () => number = Math.random;

    constructor(world: BotWorld, audio: AudioBank | null = null) {
        this.world = world;
        this.audio = audio;
    }

    /** What the match is currently set to. */
    get difficulty(): BotSkill {
        return this.skill;
    }

    /**
     * Set the difficulty of every bot in the match, now and for any spawned
     * later.
     *
     * Applied by assignment rather than by rebuilding anything, which is what
     * lets the menu change it mid-match: every number difficulty owns is read
     * out of `bot.skill` at the moment it is used, so the next frame is simply
     * the next frame. A bot mid-swing turns at the new rate; a bot mid-reaction
     * finishes the reaction it drew, because that draw is already spent.
     */
    setDifficulty(skill: BotSkill): void {
        this.skill = skill;
        for (const bot of this.bots) bot.skill = skill;
    }

    /**
     * Add a bot, its tree and its model.
     *
     * The tree is built per bot rather than shared, because a `Behavior` holds
     * its own running state -- a shared tree would have every bot inheriting
     * whichever branch the last one was in.
     */
    spawn(bot: Bot, character: Character | null): void {
        this.bots.push(bot);
        bot.skill = this.skill;

        const board: Blackboard = {
            bot,
            world: this.world,
            sinceSeen: Infinity,
            sincePlan: Infinity,
            delta: 0,
            awareness: 0,
            reactionNeeded: 0,
            clock: 0,
            history: [],
            lastHealth: bot.health,
        };
        this.boards.set(bot.id, board);

        const travel = new TravelBehavior();
        const fight = new FightBehavior();

        const tree = ActiveSelectorBehavior.from<Blackboard>([
            /*
             `ConditionalBehavior` and not `Sequence[Condition, ...]`, because
             this decorator re-asks its condition on every tick where a sequence
             asks once and then remembers the answer forever. The guard has to be
             live: it is the only thing that ends a fight.

             Noticed *or* lost within the search window. Dropping the branch the
             instant line of sight breaks makes a bot that turns and walks away
             mid-exchange whenever anyone steps behind a pillar, which reads as
             the bot losing interest rather than as it losing sight; what happens
             during the window is `FightBehavior.search`, and it is a hunt rather
             than more shooting.
            */
            ConditionalBehavior.from(
                new ConditionBehavior(
                    () => bot.enemyVisible || board.sinceSeen < bot.skill.searchSeconds
                ),
                fight
            ),
            ConditionalBehavior.from(
                new ConditionBehavior(() => bot.path.length > bot.pathAt),
                travel
            ),
            /*
             Planning is the fallback branch, so it runs on every frame the bot
             has nothing else to do -- which is every frame while it is stuck
             somewhere with no route out. A quarter-second floor keeps that from
             being a per-frame breadth-first search of the whole map.
            */
            new ActionBehavior(() => {
                if (board.sincePlan < 0.25) return;
                this.plan(board);
            }, this),
        ]);

        /*
         Only the root is initialized here. `ActiveSelector` initializes a child
         at the moment it gives it the slot and finalizes it when it takes it
         away, so a leaf initialized out of band is a leaf whose parent believes
         it has not started yet.
        */
        tree.initialize(board);

        this.trees.set(bot.id, tree);
        if (character !== null) this.characters.set(bot.id, character);

        bot.onFire = (eye, angles, weapon) => this.world.fire(bot, eye, angles, weapon);
    }

    /**
     * Choose somewhere to go, and a route to it.
     *
     * The goal is the most useful item the bot can reach, scored by what it
     * lacks: no weapon means a weapon is worth most, low health means health is.
     * Q3 does the same thing with fuzzy weights and a great deal more nuance;
     * this is the part of `BotChooseLTGItem` that survives without the
     * character files.
     */
    private plan(board: Blackboard): void {
        const { bot, world } = board;

        board.sincePlan = 0;

        const from = world.graph.nearestReachable(bot.origin);
        if (from < 0) return;

        /*
         What this bot can actually get to, once, before scoring anything.
         The first version scored every item, picked the best, and asked A* for
         a route -- and on a map whose walk graph is not fully connected that is
         a plan that fails every frame, for the same goal, forever. Measured:
         six bots standing still at 3.7 ms a frame, all of it A* refusing to
         find a route to the same unreachable rocket launcher.
        */
        const reachable = world.graph.reachableFrom(from);

        let bestNode = -1;
        let bestScore = -Infinity;

        for (const item of world.items) {
            if (!item.present) continue;
            if (!canBeGrabbed(item.def, bot.inventory)) continue;

            const node = world.graph.nearest(item.origin);
            if (node < 0 || node === from || reachable[node] === 0) continue;

            const distance = Math.hypot(
                item.origin[0] - bot.origin[0]!,
                item.origin[1] - bot.origin[1]!,
                item.origin[2] - bot.origin[2]!
            );

            const score = this.want(item, bot.inventory) - distance * 0.002;
            if (score > bestScore) {
                bestScore = score;
                bestNode = node;
            }
        }

        /*
         Nothing worth having: wander, to a node it can definitely get to. A bot
         that stands still when its goal list is empty looks broken; one that
         walks somewhere looks like it is patrolling.
        */
        if (bestNode < 0) {
            const candidates: number[] = [];
            for (let i = 0; i < reachable.length; i++) if (reachable[i] === 1) candidates.push(i);
            if (candidates.length === 0) return;
            bestNode = candidates[(this.random() * candidates.length) | 0]!;
        }

        const path = world.graph.path(from, bestNode);
        if (path.length === 0) {
            bot.clearPath();
            return;
        }

        bot.path = path;
        bot.pathAt = 0;
        bot.goalNode = bestNode;
    }

    /** How much a bot wants an item, in arbitrary points. */
    private want(item: ItemInstance, inventory: Inventory): number {
        switch (item.def.type) {
            case 'IT_WEAPON':
                return inventory.weapons.has(item.def.tag) ? 20 : 100;
            case 'IT_HEALTH':
                return Math.max(0, 100 - inventory.health) * 0.8;
            case 'IT_ARMOR':
                return Math.max(0, 150 - inventory.armor) * 0.5;
            case 'IT_AMMO':
                return (inventory.ammo[item.def.tag] ?? 0) < 30 ? 60 : 15;
            case 'IT_POWERUP':
                return 120;
            default:
                return 5;
        }
    }

    /**
     * One frame: perception, then the tree, then the body.
     *
     * The order matters and is Q3's. `BotAIStartFrame` refreshes what the bot
     * can see, runs the AI node, and only then hands a `usercmd_t` to the
     * movement -- so a bot acts on this frame's world rather than last frame's.
     */
    update(deltaSeconds: number, deltaMilliseconds: number, items: readonly ItemInstance[]): void {
        for (const bot of this.bots) {
            const board = this.boards.get(bot.id);
            if (board === undefined) continue;

            board.delta = deltaSeconds;
            board.sincePlan += deltaSeconds;

            if (bot.dead) {
                bot.respawnIn -= deltaSeconds;
                if (bot.respawnIn <= 0) {
                    const spawn =
                        this.world.spawns[(this.random() * this.world.spawns.length) | 0] ??
                        [0, 0, 0];
                    bot.respawn(spawn);

                    /*
                     A respawn is a new bot wearing the same name. Everything it
                     knew about the enemy was about a fight it lost somewhere
                     else on the map, so it comes back owing a full reaction and
                     with nothing to trail.
                    */
                    board.sinceSeen = Infinity;
                    board.awareness = 0;
                    board.history.length = 0;
                    board.lastHealth = bot.health;
                }
                bot.think(deltaSeconds, deltaMilliseconds);
                this.follow(bot);
                continue;
            }

            this.perceive(bot, board, deltaSeconds);
            this.pickUp(bot, items);

            // Re-plan periodically even while travelling, so a bot notices that
            // the item it was heading for has been taken.
            if (board.sincePlan > REPLAN_SECONDS) bot.clearPath();

            this.runTree(bot, board, deltaSeconds);

            bot.think(deltaSeconds, deltaMilliseconds);
            this.follow(bot);
        }
    }

    /**
     * Tick one tree, and restart it when it finishes.
     *
     * A behaviour tree is a *plan*, not a loop: once the root reports
     * `Succeeded` or `Failed` it is done, and every subsequent tick returns the
     * same answer without doing anything. `SequenceBehavior.finalize` even
     * parks its cursor past the last child, so a finished tree ticked again
     * short-circuits to `Succeeded` on the first line.
     *
     * Q3's own AI has the same shape and hides it: `AINode_*` returns and is
     * called afresh next frame. Here the restart is explicit, and its absence
     * was worth an hour: the bots planned routes, held them, and never moved,
     * because the *first* frame's plan branch succeeded and the tree was still
     * reporting that success 900 frames later.
     *
     * Still needed with an `ActiveSelector` root, and for a narrower reason: the
     * root re-walks its children every tick on its own, so nothing is stuck
     * *within* a frame, but it still has to be told that a finished plan is a
     * finished plan rather than a slot somebody is holding.
     */
    private runTree(bot: Bot, board: Blackboard, deltaSeconds: number): void {
        const tree = this.trees.get(bot.id);
        if (tree === undefined) return;

        const status = tree.tick(deltaSeconds);

        if (status !== BehaviorStatus.Running) {
            tree.finalize();
            tree.initialize(board);
        }
    }

    /**
     * What the bot can see, what it has noticed, and the weapon to hold.
     *
     * Two questions, and separating them is the whole of the reaction-time fix.
     * `sighted` is geometry: in range, alive, and the trace clears -- the same
     * question `WeaponSystem.visible` answers for a bullet, which is what keeps
     * a bot's sight and its shot honest (D-159). `bot.enemyVisible` is
     * *attention*, and a bot that can see you and has not noticed you yet is
     * the ordinary case for the first half-second of every encounter.
     *
     * The reaction is spent as an accumulating meter rather than as a countdown;
     * `Blackboard.awareness` says why, and `AWARENESS_BEHIND` says why the rate
     * depends on where you are standing.
     */
    private perceive(bot: Bot, board: Blackboard, deltaSeconds: number): void {
        const skill = bot.skill;

        board.clock += deltaSeconds;
        board.sinceSeen += deltaSeconds;
        bot.enemyVisible = false;

        const hurt = bot.health < board.lastHealth;
        board.lastHealth = bot.health;

        const sighted = this.sighted(bot);

        /*
         A fresh engagement's reaction, drawn once as attention leaves zero --
         whether it left because the bot saw something or because something hit
         it. Once rather than per frame, because a threshold re-rolled every
         frame is a threshold whose *minimum* decides when the bot fires, and
         that minimum is the same for every bot in the match.
        */
        if (board.awareness <= 0 && (sighted || hurt)) {
            board.reactionNeeded = Math.max(
                0,
                skill.reactionSeconds +
                    (bot.random() * 2 - 1) * skill.reactionJitterSeconds
            );
        }

        if (hurt) {
            /*
             Damage skips the queue, and it skips it whether or not the bot can
             see who did it. A bot that is being shot has been told that
             *something* is looking at it, which is the half of the news that
             does not need line of sight; a reaction time that survived it would
             be a bot that can be emptied a magazine into from behind while it
             thinks about it, which is the failure `AWARENESS_BEHIND` would
             otherwise have introduced and a worse one than the one it fixes. It
             does not tell the bot *where* -- that still needs the trace below --
             so a bot caught by a stray rocket comes out of it alert rather than
             informed.
            */
            board.awareness = Math.max(board.awareness, board.reactionNeeded);
        } else if (sighted) {
            board.awareness = Math.min(
                board.awareness + deltaSeconds * this.attention(bot),
                board.reactionNeeded * AWARENESS_CEILING
            );
        } else {
            board.awareness = Math.max(0, board.awareness - deltaSeconds * skill.forgetRate);
        }

        if (!sighted || board.awareness < board.reactionNeeded) return;

        bot.enemyVisible = true;
        board.sinceSeen = 0;
        bot.lastSeen[0] = this.playerEye[0]!;
        bot.lastSeen[1] = this.playerEye[1]!;
        bot.lastSeen[2] = this.playerEye[2]!;

        this.record(board);

        // Hold the best weapon it has ammo for. Order is Q3's `weapon_t`, which
        // is roughly increasing power.
        for (const candidate of ['WP_ROCKET_LAUNCHER', 'WP_RAILGUN', 'WP_PLASMAGUN',
            'WP_SHOTGUN', 'WP_MACHINEGUN'] as const) {
            if (bot.inventory.weapons.has(candidate) && (bot.inventory.ammo[candidate] ?? 0) !== 0) {
                bot.weapon = candidate;
                break;
            }
        }
    }

    /**
     * Can this bot see anybody at all, ignoring whether it has noticed?
     *
     * Leaves the chosen target's position in `this.playerEye` for the caller,
     * which is a side effect and is why it is private and named as a question
     * rather than as a getter: the alternative is tracing twice or allocating a
     * vector per bot per frame.
     *
     * **Nearest visible, not nearest.** The candidates are tried in order of
     * distance and the first one the world can see is taken, so a bot standing
     * between two players engages the one it can actually shoot rather than
     * staring through a wall at somebody four units closer. The trace is the
     * expensive half of this method, so it is the half that runs last and
     * usually once -- one per bot per frame with a single opponent, which is
     * what it cost before this took a list.
     */
    private sighted(bot: Bot): boolean {
        const targets = this.world.targets();
        if (targets.length === 0) return false;

        const range = bot.skill.sightRange;
        const tried = this.triedTargets;
        const count = Math.min(targets.length, tried.length);
        for (let i = 0; i < count; i++) tried[i] = 0;

        /*
         The nearest target, whether or not it is in range or visible, so
         `playerEye` is never stale for the callers that read it after a
         negative answer -- `attention` scales awareness by where the enemy is
         standing and is asked on frames when nothing is sighted. The single
         `playerOrigin()` this replaced was unconditional in exactly this way,
         and leaving it out was a behaviour change hiding inside a refactor.
        */
        this.nearestInto(bot, targets, count, this.playerEye);

        bot.eye(this.scratch);

        for (;;) {
            let best = -1;
            let bestDistance = range;

            for (let i = 0; i < count; i++) {
                if (tried[i] === 1) continue;

                const origin = targets[i]!.originQ3;
                const distance = Math.hypot(
                    origin[0]! - bot.origin[0]!,
                    origin[1]! - bot.origin[1]!,
                    origin[2]! - bot.origin[2]!
                );

                if (distance > bestDistance) continue;
                best = i;
                bestDistance = distance;
            }

            if (best < 0) return false;
            tried[best] = 1;

            const origin = targets[best]!.originQ3;
            this.playerEye[0] = origin[0]!;
            this.playerEye[1] = origin[1]!;
            this.playerEye[2] = origin[2]!;

            if (this.world.visible(this.scratch, this.playerEye)) return true;
        }
    }

    /**
     * Which candidates {@link sighted} has already traced against, this call.
     *
     * A fixed array rather than a `Set` or a sort, because this runs per bot per
     * frame and both of those allocate. Sixteen is `MAX_CLIENTS`; a world that
     * offered more targets than this would simply have the surplus ignored,
     * which is why the loop bounds itself by the shorter of the two.
     */
    private readonly triedTargets = new Uint8Array(16);

    /** The nearest of `targets` by centre distance, written into `out`. */
    private nearestInto(
        bot: Bot,
        targets: readonly BotTarget[],
        count: number,
        out: Vec3
    ): void {
        let bestDistance = Infinity;
        for (let i = 0; i < count; i++) {
            const origin = targets[i]!.originQ3;
            const distance = Math.hypot(
                origin[0]! - bot.origin[0]!,
                origin[1]! - bot.origin[1]!,
                origin[2]! - bot.origin[2]!
            );
            if (distance >= bestDistance) continue;
            bestDistance = distance;
            out[0] = origin[0]!;
            out[1] = origin[1]!;
            out[2] = origin[2]!;
        }
    }

    /**
     * How fast this bot builds awareness, given where the player is standing.
     *
     * A cosine falloff off the view axis between 1 and `AWARENESS_BEHIND`, on
     * yaw only. Pitch is left out because it is nearly always small -- a bot
     * looks along the floor it is walking on -- and because folding it in would
     * make a bot slower to notice somebody it is already pointing its gun at, on
     * a lift.
     */
    private attention(bot: Bot): number {
        const dx = this.playerEye[0]! - bot.origin[0]!;
        const dy = this.playerEye[1]! - bot.origin[1]!;
        const distance = Math.hypot(dx, dy);

        if (distance < 1) return 1;

        const yaw = (bot.viewYaw * Math.PI) / 180;
        const facing = (dx * Math.cos(yaw) + dy * Math.sin(yaw)) / distance;

        return AWARENESS_BEHIND + (1 - AWARENESS_BEHIND) * Math.max(0, facing);
    }

    /**
     * Record where the enemy is, for the tracking lag to read from behind.
     *
     * Rate-limited to `TRACK_SAMPLE_SECONDS` rather than taken every frame, so
     * the buffer is a fixed size in *seconds* whatever the tick rate is -- the
     * lag a skill asks for has to mean the same thing at 60 Hz and at 125.
     */
    private record(board: Blackboard): void {
        const history = board.history;
        const last = history[history.length - 1];

        if (last !== undefined && board.clock - last.t < TRACK_SAMPLE_SECONDS) return;

        history.push({
            t: board.clock,
            x: this.playerEye[0]!,
            y: this.playerEye[1]!,
            z: this.playerEye[2]!,
        });

        // Anything older than the window is a memory rather than a lag.
        while (history.length > 0 && board.clock - history[0]!.t > TRACK_HISTORY_SECONDS) {
            history.shift();
        }
    }

    /** Bots pick items up by walking over them, exactly as the player does. */
    private pickUp(bot: Bot, items: readonly ItemInstance[]): void {
        for (const item of items) {
            if (!item.present) continue;
            if (!touchesItem(bot.origin, item.origin)) continue;
            if (!canBeGrabbed(item.def, bot.inventory)) continue;

            giveTo(bot.inventory, item);
            item.present = false;
            item.respawnAt = Infinity; // the item system owns the real clock
        }
    }

    /** Move the bot's character model to where the bot is. */
    private follow(bot: Bot): void {
        const character = this.characters.get(bot.id);
        if (character === undefined) return;

        character.place(bot.origin, bot.viewYaw);

        const legs: LegsAnimation = bot.dead
            ? 'LEGS_IDLE'
            : Character.legsFor(bot.speed, bot.onGround, 1);

        const firing = bot.fireCooldown > 0;

        character.setLegs(legs);
        character.setTorso(firing ? 'TORSO_ATTACK' : 'TORSO_STAND');

        this.weaponSound(bot, firing);
    }

    /**
     * The sound a bot's weapon makes just by being held.
     *
     * `CG_AddPlayerWeapon` plays `firingSound` while `EF_FIRING` is set and
     * `readySound` otherwise -- and does it only under `if ( !ps )`, the branch
     * for a weapon seen in the third person. So this is deliberately a sound the
     * player never hears from their own gun: the lightning hum belongs to the
     * bot pointing one at you.
     *
     * `fireCooldown > 0` stands in for `EF_FIRING`. It is the same question the
     * torso animation above already answers with it.
     *
     * Most weapons have neither sound and fall out with a null name, which is
     * why this is a lookup rather than a pair of branches: `weapon/change` is
     * the only noise a machinegun makes when it is not being fired.
     */
    private weaponSound(bot: Bot, firing: boolean): void {
        if (this.audio === null) return;

        const wanted = bot.dead
            ? null
            : this.audio.has(`firing/${bot.weapon}`) && firing
                ? `firing/${bot.weapon}`
                : this.audio.has(`ready/${bot.weapon}`)
                    ? `ready/${bot.weapon}`
                    : null;

        const current = this.weaponLoops.get(bot.id);

        if (current !== undefined && current.name === wanted) {
            // `S_UpdateEntityPosition`: the hum walks around with the bot.
            current.loop.move(bot.origin);
            return;
        }

        if (current !== undefined) {
            current.loop.stop();
            this.weaponLoops.delete(bot.id);
        }

        if (wanted === null) return;

        const loop = this.audio.loop(wanted, bot.origin);
        if (loop !== null) this.weaponLoops.set(bot.id, { loop, name: wanted });
    }

    stats(): BotStats {
        return {
            bots: this.bots.length,
            nodes: this.world.graph.nodes.length,
            links: this.world.graph.stats.links,
            reachable: this.world.graph.stats.largestComponent,
        };
    }
}

/**
 * The subset of `Pickup_*` a bot needs.
 *
 * Deliberately *not* `ItemSystem.update`: that one is written for the player,
 * raises pickup events, and owns the respawn clock. A bot walking over a shard
 * should take the shard and nothing else should happen.
 */
function giveTo(inventory: Inventory, item: ItemInstance): void {
    const def = item.def;

    switch (def.type) {
        case 'IT_ARMOR':
            inventory.armor = Math.min(inventory.armor + def.quantity, inventory.maxHealth * 2);
            break;
        case 'IT_HEALTH': {
            const max =
                def.quantity === 5 || def.quantity === 100
                    ? inventory.maxHealth * 2
                    : inventory.maxHealth;
            inventory.health = Math.min(inventory.health + def.quantity, max);
            break;
        }
        case 'IT_WEAPON':
            inventory.weapons.add(def.tag);
            inventory.ammo[def.tag] = Math.min(
                (inventory.ammo[def.tag] ?? 0) + def.quantity,
                200
            );
            break;
        case 'IT_AMMO':
            inventory.ammo[def.tag] = Math.min(
                (inventory.ammo[def.tag] ?? 0) + def.quantity,
                200
            );
            break;
        default:
            break;
    }
}

export { CHARACTERS };
