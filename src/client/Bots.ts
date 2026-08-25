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
 *     Selector
 *       Sequence [ Condition(enemy visible)  -> Fight  ]
 *       Sequence [ Condition(has a route)    -> Travel ]
 *       Action   [ pick a goal and a route            ]
 *
 * What is missing relative to botlib, and is missing on purpose: no chat, no
 * team play, no fuzzy weapon preference, no rocket jumping, no prediction of
 * where a target will be. Recorded in DECISIONS.md rather than implied.
 */

import { SelectorBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/SelectorBehavior.js';
import { SequenceBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/composite/SequenceBehavior.js';
import { ConditionBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/util/ConditionBehavior.js';
import { ActionBehavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/primitive/ActionBehavior.js';
import { Behavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/Behavior.js';
import { BehaviorStatus } from '@woosh/meep-engine/src/engine/intelligence/behavior/BehaviorStatus.js';

import { Bot } from '../game/Bot.ts';
import { Character, CHARACTERS, type LegsAnimation } from './Characters.ts';
import { WaypointGraph } from '../game/Waypoints.ts';
import { weaponStats, type WeaponId, MASK_SHOT } from '../game/Weapons.ts';
import { vec3, type Vec3 } from '../q3/math.ts';
import type { ItemInstance } from '../game/Items.ts';
import { canBeGrabbed, touchesItem, type Inventory } from '../game/Items.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';

/** How far a bot will engage, in Q3 units. Beyond this it goes back to routing. */
const ENGAGE_RANGE = 2200;

/** How long a bot keeps chasing after losing sight, in seconds. */
const MEMORY_SECONDS = 3;

/** Re-plan at least this often, so a bot notices a door that opened. */
const REPLAN_SECONDS = 8;

export interface BotWorld {
    readonly graph: WaypointGraph;
    /** Everything a bot might want to walk to. */
    readonly items: readonly ItemInstance[];
    /** Line of sight, in Q3 units. */
    trace(
        start: ArrayLike<number>,
        mins: ArrayLike<number>,
        maxs: ArrayLike<number>,
        end: ArrayLike<number>,
        contentMask: number
    ): { fraction: number };
    /** Where the player is, and whether it is alive. */
    playerOrigin(): Vec3;
    playerAlive(): boolean;
    /** Spawn points, for respawning. */
    readonly spawns: readonly number[][];
    fire(bot: Bot, eyeQ3: ArrayLike<number>, anglesQ3: ArrayLike<number>, weapon: WeaponId): void;
}

/** The blackboard the tree reads and writes. */
interface Blackboard {
    readonly bot: Bot;
    readonly world: BotWorld;
    /** Seconds since the enemy was last seen. */
    sinceSeen: number;
    /** Seconds since the last route was planned. */
    sincePlan: number;
    delta: number;
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
         Look where you are going, unless the enemy was just here. A bot that
         turns its back the instant it loses sight is a bot that never fights;
         `MEMORY_SECONDS` of holding the last-seen direction is the cheapest
         version of Q3's own `lastenemyareanum` behaviour.
        */
        if (board.sinceSeen < MEMORY_SECONDS) bot.lookAt(bot.lastSeen);
        else bot.lookAt(target);

        return BehaviorStatus.Running;
    }
}

/**
 * Face the enemy and shoot it.
 *
 * Runs while the enemy is visible; the enclosing sequence's condition drops it
 * as soon as it is not.
 */
class FightBehavior extends Behavior<Blackboard> {
    override tick(_timeDelta: number): number {
        const board = this.context;
        if (board === null) return BehaviorStatus.Failed;

        const { bot, world } = board;

        bot.lookAt(bot.lastSeen);

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

        void world;
        return BehaviorStatus.Running;
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
    private readonly trees = new Map<number, SelectorBehavior>();
    private readonly characters = new Map<number, Character>();

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

    constructor(world: BotWorld, audio: AudioBank | null = null) {
        this.world = world;
        this.audio = audio;
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

        const board: Blackboard = {
            bot,
            world: this.world,
            sinceSeen: Infinity,
            sincePlan: Infinity,
            delta: 0,
        };
        this.boards.set(bot.id, board);

        const travel = new TravelBehavior();
        const fight = new FightBehavior();

        const tree = SelectorBehavior.from([
            SequenceBehavior.from([
                new ConditionBehavior(
                    /*
                     Visible *or* seen within memory. Dropping the fight branch
                     the instant line of sight breaks makes a bot that turns and
                     walks away mid-exchange whenever anyone steps behind a
                     pillar, which reads as the bot losing interest rather than
                     as it losing sight.
                    */
                    () => bot.enemyVisible || board.sinceSeen < MEMORY_SECONDS
                ),
                fight,
            ]),
            SequenceBehavior.from([
                new ConditionBehavior(() => bot.path.length > bot.pathAt),
                travel,
            ]),
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
         Composites initialize their own children as they reach them, so only
         the root is initialized here. Initializing the leaves by hand as well
         looks harmless and is not: `SequenceBehavior.initialize` resets its
         cursor, so a leaf initialized out of band is a leaf whose parent thinks
         it is somewhere else.
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
            bestNode = candidates[(Math.random() * candidates.length) | 0]!;
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
                        this.world.spawns[(Math.random() * this.world.spawns.length) | 0] ??
                        [0, 0, 0];
                    bot.respawn(spawn);
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

    /** Line of sight to the player, and the weapon to hold. */
    private perceive(bot: Bot, board: Blackboard, deltaSeconds: number): void {
        board.sinceSeen += deltaSeconds;
        bot.enemyVisible = false;

        if (!this.world.playerAlive()) return;

        const player = this.world.playerOrigin();

        this.playerEye[0] = player[0]!;
        this.playerEye[1] = player[1]!;
        this.playerEye[2] = player[2]!;

        const dx = this.playerEye[0]! - bot.origin[0]!;
        const dy = this.playerEye[1]! - bot.origin[1]!;
        const dz = this.playerEye[2]! - bot.origin[2]!;

        if (Math.hypot(dx, dy, dz) > ENGAGE_RANGE) return;

        bot.eye(this.scratch);

        const line = this.world.trace(
            this.scratch,
            [0, 0, 0],
            [0, 0, 0],
            this.playerEye,
            MASK_SHOT
        );

        if (line.fraction < 0.99) return;

        bot.enemyVisible = true;
        board.sinceSeen = 0;
        bot.lastSeen[0] = this.playerEye[0]!;
        bot.lastSeen[1] = this.playerEye[1]!;
        bot.lastSeen[2] = this.playerEye[2]!;

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
