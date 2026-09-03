/*
 * Bot.ts -- a bot that plays the same game the player does.
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
 * The brief says to replace botlib with behaviour trees, and this is the half
 * that is not the tree: the body. A bot fills a `usercmd_t` and hands it to the
 * same movement code the player uses. That is exactly Q3's arrangement --
 * `BotAIStartFrame` fills a `usercmd_t` and hands it to the same `ClientThink` a
 * human's goes through -- and it is the property worth keeping, because it means
 * a bot accelerates, strafes, steps and falls identically to the player. A bot
 * that moved by lerping toward a waypoint would be a different physical object
 * in the same room.
 *
 * "The same movement code" now means `MeepMove` -- Q3's motor on meep's
 * `KinematicMover` (D-071) -- with the ported `bg_pmove` still built and still
 * the tests measure against. Both write the same `playerState_t`, so everything
 * below this line is indifferent to which ran.
 *
 * That indifference is the point of the arrangement rather than a convenience.
 * For one commit the player ran the new solver and the bots ran the old one, and
 * the property this file's first paragraph claims -- that bots and players are
 * the same physical object -- was quietly false. D-072.
 *
 * What is *not* here is anything botlib does: no AAS, no fuzzy weapon weights,
 * no chat, no character files. The decisions live in a behaviour tree
 * (`client/Bots.ts`), and this class is the interface between that tree and the
 * simulation -- "go here", "look there", "aim there", "shoot" -- plus the state
 * the tree reads to decide.
 *
 * "Aim there" is a fourth verb and not a synonym for the third. A bot's *hand*
 * lives on this side of the line -- how fast it swings, how wrong it is, and
 * how that wrongness moves -- because those are properties of the body a
 * `usercmd_t` comes out of, and every one of them is read from a `BotSkill`
 * rather than written here. Its *attention* -- what it has noticed, how long
 * ago, and whether that is still worth shooting at -- lives on the tree's side.
 * D-162.
 */

import { Pmove as runPmove } from '../q3/pmove/pmove.ts';
import type { Pmove } from '../q3/pmove/types.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';
import { vec3, type Vec3, type Vec3Like } from '../q3/math.ts';
import { createPmoveHost, type PmoveHostOptions } from './PmoveHost.ts';
import { PlayerMovement, type MoverHost } from '../client/MeepMove.ts';
import { newInventory, type Inventory } from './Items.ts';
import type { Damageable } from './Weapons.ts';
import type { WeaponId } from './Weapons.ts';
import { DEFAULT_DIFFICULTY, difficulty, gaussian, type BotSkill } from './Difficulty.ts';

/** `usercmd_t.angles` is 16-bit fixed point over a full turn. */
const ANGLE_TO_SHORT = 65536 / 360;

/**
 * How close the view has to have settled on the aim point before the trigger.
 *
 * This used to be 8 degrees of yaw and 16 of pitch, and it was doing two jobs:
 * it was the only thing making a bot miss, and it was the thing that let a bot
 * fire while still swinging. Once there is a modelled aim error (D-162) the
 * first job is gone, and the second wants a *tight* number -- the error decides
 * where the shot goes, and a loose gate here would add a second, unmodelled and
 * uniformly-distributed error on top of it that no difficulty level could tune.
 *
 * Three degrees is "the swing has arrived". What it also buys, and is worth
 * having on purpose: a bot cannot fire while it is being out-turned, so
 * circle-strafing one at close range -- where the bearing rate exceeds
 * `BotSkill.turnSpeed` -- takes it out of the fight.
 */
const AIM_TOLERANCE = 3;

/** Arrival radius for a path node, in Q3 units. Half the grid spacing. */
const NODE_RADIUS = 40;

export interface BotOptions extends PmoveHostOptions {
    readonly id: number;
    readonly name: string;
    /** Which converted character model represents it. */
    readonly character: string;
    /**
     * Physics for the meep-native movement path. Null runs the ported
     * `bg_pmove` instead, which is what `pmove.diff.test.ts` and the divergence harness
     * select.
     */
    readonly moverHost?: MoverHost | null;
    /**
     * How good this one is. Defaults to `DEFAULT_DIFFICULTY`.
     *
     * For a bot built outside a runtime, which is what a test does.
     * `BotRuntime.spawn` stamps the *match's* difficulty over this, because a
     * roster where one bot is at a level the menu never chose is a roster nobody
     * can reason about.
     */
    readonly skill?: BotSkill;
    /**
     * Where the aim error and the reaction jitter come from.
     *
     * Injectable so a test can hand over a sequence and read the consequence,
     * which is the only way to assert anything about a distribution. Defaults to
     * `Math.random`, which is what a match runs on.
     */
    readonly random?: () => number;
}

export class Bot implements Damageable {
    readonly id: number;
    readonly name: string;
    readonly character: string;

    readonly pmove: Pmove;

    /** Non-null when this bot moves on meep's solver, which is the default. */
    private readonly movement: PlayerMovement | null;

    readonly inventory: Inventory = newInventory();

    /* ---- Damageable ---- */
    readonly origin: Vec3;
    readonly mins: Vec3 = vec3(-15, -15, -24);
    readonly maxs: Vec3 = vec3(15, 15, 32);
    health = 125;
    dead = false;

    /**
     * Armour, mirrored from the inventory so `G_Damage`'s split applies.
     *
     * Two fields for one quantity is a smell, and the alternative is worse: a
     * getter/setter pair over `inventory.armor` reads as an accident waiting to
     * be optimised away, and `Damageable` is deliberately a plain data
     * interface so a shootable crate does not have to own an inventory. They
     * are reconciled once a frame, in `think`.
     */
    armor = 0;

    /** Seconds until it respawns, once dead. */
    respawnIn = 0;

    /** Weapon it is holding. Set by the tree from what it has picked up. */
    weapon: WeaponId = 'WP_MACHINEGUN';

    /* ---- navigation ---- */

    /** Node indices still to visit. Empty means "no plan". */
    path: number[] = [];
    /** Where in `path` the bot is heading. */
    pathAt = 0;
    /** The node it is ultimately going to, or -1. */
    goalNode = -1;

    /** Seconds spent commanding a move and not moving. */
    stuckFor = 0;

    /**
     * Seconds spent moving without getting closer to the current path node.
     *
     * `stuckFor` catches a bot pressed flat against a wall; this catches the
     * more common failure, which is a bot sliding *along* a wall at a
     * respectable speed and never arriving. The first version only had the
     * former, and the symptom was bots that walked briskly on the spot.
     */
    noProgressFor = 0;

    private bestDistance = Infinity;

    /* ---- combat ---- */

    /**
     * How good this bot is, and the only place any of those numbers live.
     *
     * Mutable, because the menu can change difficulty mid-match and a bot that
     * had to be rebuilt to hear about it would mean respawning the roster.
     */
    skill: BotSkill;

    /**
     * Set by the tree each frame: the enemy is in sight *and* the bot has
     * noticed it.
     *
     * The two halves are deliberately not separable here. "Can trace to it" is
     * perception and belongs to the tree; what the body needs to know is whether
     * there is currently something to shoot at, and a bot inside its reaction
     * delay does not have one. See `BotRuntime.perceive`.
     */
    enemyVisible = false;
    /** Where the enemy was last seen, whether or not it is visible now. */
    readonly lastSeen: Vec3 = vec3();
    /** Seconds until it can fire again. */
    fireCooldown = 0;

    /** Desired facing, which the bot turns toward rather than snapping to. */
    private desiredYaw = 0;
    private desiredPitch = 0;

    /* ---- the hand ---- */

    /**
     * The aim error, in degrees, and the two draws it is crossing between.
     *
     * Held rather than drawn per shot, because a per-shot draw is an error a
     * player cannot read: it makes every burst average out to the same
     * accuracy and never sends one wide as a burst. See `BotSkill.aimDriftSeconds`.
     */
    private aimErrorYaw = 0;
    private aimErrorPitch = 0;
    private aimFromYaw = 0;
    private aimFromPitch = 0;
    private aimToYaw = 0;
    private aimToPitch = 0;
    /** Position within the current drift interval, 0..1. */
    private aimPhase = 1;

    /**
     * This bot's randomness, and the only source any of its behaviour draws
     * from -- the aim error here, the reaction jitter in `BotRuntime.perceive`.
     *
     * Public so the tree can share it. One stream per bot rather than one per
     * concern, because a test that wants a bot with a known hand has to be able
     * to supply it in one place.
     */
    readonly random: () => number;

    private yaw = 0;
    private pitch = 0;

    /** Movement the tree asked for this frame; cleared after each `think`. */
    private moveForward = 0;
    private moveRight = 0;
    private wantJump = false;

    private timeMs = 0;

    /** Raised when the bot's weapon should fire. */
    onFire: ((eyeQ3: Vec3Like, anglesQ3: ArrayLike<number>, weapon: WeaponId) => void) | null =
        null;

    constructor(options: BotOptions) {
        this.id = options.id;
        this.name = options.name;
        this.character = options.character;
        this.skill = options.skill ?? difficulty(DEFAULT_DIFFICULTY);
        this.random = options.random ?? Math.random;

        this.pmove = createPmoveHost(options);
        this.origin = this.pmove.ps.origin;

        /*
         `origin` stays a live reference into `ps` whichever solver runs, which
         is what lets `Damageable`, the character placement and the tree all read
         one number that cannot go stale.
        */
        this.movement =
            options.moverHost === undefined || options.moverHost === null
                ? null
                : new PlayerMovement(options.moverHost, this.pmove.ps.origin);

        this.yaw = (options.spawnQ3[3] ?? 0) * ANGLE_TO_SHORT;
        this.desiredYaw = this.yaw / ANGLE_TO_SHORT;
    }

    get speed(): number {
        return Math.hypot(this.pmove.ps.velocity[0]!, this.pmove.ps.velocity[1]!);
    }

    get onGround(): boolean {
        return this.pmove.ps.groundEntityNum !== C.ENTITYNUM_NONE;
    }

    /** Eye position, for line-of-sight and for firing. */
    eye(out: Vec3): Vec3 {
        const ps = this.pmove.ps;
        out[0] = ps.origin[0]!;
        out[1] = ps.origin[1]!;
        out[2] = ps.origin[2]! + ps.viewheight;
        return out;
    }

    /* ---- what the tree asks for ---- */

    /**
     * Walk toward a world position.
     *
     * The move is expressed in the bot's *own* frame, as a `usercmd_t` is: the
     * forward and right components of the direction to the target, rotated into
     * view space. Setting only forward and turning to face would also work and
     * is what a naive bot does; it also makes every bot walk in arcs, because a
     * bot always facing where it is going cannot strafe around a corner.
     */
    moveToward(targetQ3: ArrayLike<number>): void {
        const ps = this.pmove.ps;

        const dx = targetQ3[0]! - ps.origin[0]!;
        const dy = targetQ3[1]! - ps.origin[1]!;
        const distance = Math.hypot(dx, dy);

        if (distance < 1) return;

        const yawRadians = (this.yaw / ANGLE_TO_SHORT) * (Math.PI / 180);
        const forwardX = Math.cos(yawRadians);
        const forwardY = Math.sin(yawRadians);

        // Right-hand side in Q3's convention: yaw increases counter-clockwise.
        const rightX = forwardY;
        const rightY = -forwardX;

        const nx = dx / distance;
        const ny = dy / distance;

        this.moveForward = Math.max(-127, Math.min(127, Math.round((nx * forwardX + ny * forwardY) * 127)));
        this.moveRight = Math.max(-127, Math.min(127, Math.round((nx * rightX + ny * rightY) * 127)));
    }

    /**
     * Turn toward a world position, at a finite rate.
     *
     * Exact. This is the navigation call -- "look where you are going" -- and a
     * bot that walks a corridor with a hand tremor on its view is not more
     * human, it is seasick. What a shot goes through is {@link aimAt}.
     */
    lookAt(targetQ3: ArrayLike<number>): void {
        const ps = this.pmove.ps;

        const dx = targetQ3[0]! - ps.origin[0]!;
        const dy = targetQ3[1]! - ps.origin[1]!;
        const dz = targetQ3[2]! - (ps.origin[2]! + ps.viewheight);

        this.desiredYaw = (Math.atan2(dy, dx) * 180) / Math.PI;
        // Q3 pitch is positive *downward*, which is why this is negated.
        this.desiredPitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    }

    /**
     * Turn toward something the bot means to shoot, and miss it by the current
     * aim error.
     *
     * The error lands on the *desired* angles rather than on the fired ray, and
     * that placement is the decision. A bot that aimed true and then perturbed
     * the bullet would be a bot pointed straight at you whose shots mysteriously
     * did not arrive; this one is visibly pointed slightly wrong, its muzzle
     * flash and its tracer agree with where it is looking, and a player can read
     * "that one has lost me" off the model. It also means `aimed` measures the
     * swing against the aim point the bot actually believes in, so the trigger
     * gate and the error stay independent quantities.
     */
    aimAt(targetQ3: ArrayLike<number>): void {
        this.lookAt(targetQ3);
        this.desiredYaw += this.aimErrorYaw;

        /*
         Clamped to the range `turn` can actually reach. `pitch` is held inside
         +/-89 the way Q3 holds a player's, so a desired pitch outside it is one
         the swing can never arrive at -- and `aimed` compares the two, so the
         bot would stand there never firing. Reachable only for a target almost
         directly overhead or underfoot, and cheaper to prevent than to explain.
        */
        this.desiredPitch = Math.max(-89, Math.min(89, this.desiredPitch + this.aimErrorPitch));
    }

    /** The aim error this bot is carrying right now, in degrees. For tests. */
    get aimError(): readonly [number, number] {
        return [this.aimErrorYaw, this.aimErrorPitch];
    }

    jump(): void {
        this.wantJump = true;
    }

    /** True when the bot is pointed close enough at what it is aiming at. */
    get aimed(): boolean {
        const yawNow = this.yaw / ANGLE_TO_SHORT;
        let error = ((this.desiredYaw - yawNow + 540) % 360) - 180;
        error = Math.abs(error);
        return error < AIM_TOLERANCE && Math.abs(this.desiredPitch - this.pitch) < AIM_TOLERANCE;
    }

    /* ---- the simulation half ---- */

    /**
     * Turn, fill a `usercmd_t`, and run `Pmove`.
     *
     * `PmoveSingle` runs on integer milliseconds and `Pmove` splits a long frame
     * into 66 ms steps, so the command time is accumulated in whole
     * milliseconds. That is not pedantry: the bot and the player have to advance
     * on the same clock, or a bot's acceleration curve differs from a player's
     * by the fractional part of a frame.
     */
    think(deltaSeconds: number, deltaMilliseconds: number): void {
        this.turn(deltaSeconds);
        this.driftAim(deltaSeconds);

        if (this.fireCooldown > 0) this.fireCooldown -= deltaSeconds;

        const cmd = this.pmove.cmd;

        this.timeMs += deltaMilliseconds;
        cmd.serverTime = this.timeMs;

        cmd.angles[0] = this.pitchShort();
        cmd.angles[1] = this.yaw & 0xffff;
        cmd.angles[2] = 0;

        cmd.moves[FORWARDMOVE] = this.dead ? 0 : this.moveForward;
        cmd.moves[RIGHTMOVE] = this.dead ? 0 : this.moveRight;
        cmd.moves[UPMOVE] = this.wantJump && !this.dead ? 127 : 0;
        cmd.buttons = 0;
        cmd.weapon = 1;

        this.pmove.ps.stats[C.STAT_HEALTH] = this.health;
        // Armour is picked up into the inventory and spent through `Damageable`.
        if (this.inventory.armor !== this.armor) {
            if (this.armor < this.inventory.armor) this.inventory.armor = this.armor;
            else this.armor = this.inventory.armor;
        }
        this.pmove.ps.pm_type = this.dead ? C.PM_DEAD : C.PM_NORMAL;

        if (this.movement === null) {
            runPmove(this.pmove);
        } else {
            this.movement.step(this.pmove, false, deltaSeconds);
        }

        // Stuck detection: wanting to move and not moving.
        const wanting = this.moveForward !== 0 || this.moveRight !== 0;
        if (wanting && this.speed < 80) this.stuckFor += deltaSeconds;
        else this.stuckFor = 0;

        this.moveForward = 0;
        this.moveRight = 0;
        this.wantJump = false;
    }

    /**
     * Fire, if the weapon is ready.
     *
     * Rate-limited by the weapon's own `fireRateMs` from the balance table, so a
     * bot with a railgun fires at a railgun's rate and one with a machinegun at
     * a machinegun's. Ammo is consumed, which means a bot can run dry and has to
     * go and find some -- which is what makes an item route worth having.
     */
    fire(fireRateMs: number, eyeScratch: Vec3, anglesScratch: Vec3): boolean {
        if (this.dead || this.fireCooldown > 0 || this.onFire === null) return false;

        const ammo = this.inventory.ammo[this.weapon] ?? 0;
        if (ammo === 0) return false;
        if (ammo > 0) this.inventory.ammo[this.weapon] = ammo - 1;

        this.eye(eyeScratch);

        anglesScratch[0] = this.pitch;
        anglesScratch[1] = this.yaw / ANGLE_TO_SHORT;
        anglesScratch[2] = 0;

        this.onFire(eyeScratch, anglesScratch, this.weapon);
        this.fireCooldown = fireRateMs / 1000;
        return true;
    }

    /** Where the bot is heading right now, or `null` when it has no plan. */
    currentTarget(nodeOrigin: (index: number) => Vec3 | null): Vec3 | null {
        if (this.pathAt >= this.path.length) return null;
        return nodeOrigin(this.path[this.pathAt]!);
    }

    /** Advance along the path when close enough to the current node. */
    advancePath(nodeOrigin: (index: number) => Vec3 | null, deltaSeconds = 0): void {
        while (this.pathAt < this.path.length) {
            const target = nodeOrigin(this.path[this.pathAt]!);
            if (target === null) {
                this.pathAt += 1;
                this.bestDistance = Infinity;
                continue;
            }

            const dx = target[0]! - this.origin[0]!;
            const dy = target[1]! - this.origin[1]!;
            /*
             Horizontal distance only. A node one storey below is "reached" the
             moment the bot is over it, because the drop is the way there --
             requiring 3D proximity leaves a bot walking into the ledge forever.
            */
            const distance = Math.hypot(dx, dy);

            if (distance > NODE_RADIUS) {
                // Closing on it resets the patience; anything else spends it.
                if (distance < this.bestDistance - 1) {
                    this.bestDistance = distance;
                    this.noProgressFor = 0;
                } else {
                    this.noProgressFor += deltaSeconds;
                }
                return;
            }

            this.pathAt += 1;
            this.bestDistance = Infinity;
            this.noProgressFor = 0;
        }
    }

    clearPath(): void {
        this.path = [];
        this.pathAt = 0;
        this.goalNode = -1;
        this.bestDistance = Infinity;
        this.noProgressFor = 0;
    }

    respawn(spawnQ3: readonly number[]): void {
        const ps = this.pmove.ps;

        ps.origin[0] = spawnQ3[0] ?? 0;
        ps.origin[1] = spawnQ3[1] ?? 0;
        ps.origin[2] = (spawnQ3[2] ?? 0) + 9;
        ps.velocity[0] = 0;
        ps.velocity[1] = 0;
        ps.velocity[2] = 0;
        ps.groundEntityNum = C.ENTITYNUM_NONE;
        ps.pm_type = C.PM_NORMAL;

        this.health = 125;
        this.armor = 0;
        this.inventory.armor = 0;
        this.dead = false;
        this.respawnIn = 0;
        this.weapon = 'WP_MACHINEGUN';
        this.inventory.ammo['WP_MACHINEGUN'] = 100;
        this.inventory.weapons.clear();
        this.inventory.weapons.add('WP_GAUNTLET');
        this.inventory.weapons.add('WP_MACHINEGUN');

        this.clearPath();
        this.enemyVisible = false;
        this.stuckFor = 0;
    }

    private pitchShort(): number {
        return Math.round(this.pitch * ANGLE_TO_SHORT) & 0xffff;
    }

    /**
     * Wander the aim error toward a fresh draw.
     *
     * Two independent normal draws -- yaw and pitch -- resampled every
     * `aimDriftSeconds` and smoothstepped between, which gives an error with a
     * continuous first derivative: the bot's aim slides across you rather than
     * teleporting from one offset to the next. Smoothstep and not a straight
     * lerp because a lerp has a corner at every sample, and a corner in an aim
     * curve is visible as a twitch.
     *
     * Driven off the wall clock rather than off firing, so an error the bot
     * carries is the same error whether it is shooting or not. A bot whose hand
     * only shakes while the trigger is down would be tuning the *weapon*.
     */
    private driftAim(deltaSeconds: number): void {
        const drift = this.skill.aimDriftSeconds;

        if (drift <= 0 || this.skill.aimErrorDegrees <= 0) {
            this.aimErrorYaw = 0;
            this.aimErrorPitch = 0;
            return;
        }

        this.aimPhase += deltaSeconds / drift;

        while (this.aimPhase >= 1) {
            this.aimPhase -= 1;
            this.aimFromYaw = this.aimToYaw;
            this.aimFromPitch = this.aimToPitch;
            this.aimToYaw = gaussian(this.random) * this.skill.aimErrorDegrees;
            this.aimToPitch = gaussian(this.random) * this.skill.aimErrorDegrees;
        }

        const t = this.aimPhase * this.aimPhase * (3 - 2 * this.aimPhase);
        this.aimErrorYaw = this.aimFromYaw + (this.aimToYaw - this.aimFromYaw) * t;
        this.aimErrorPitch = this.aimFromPitch + (this.aimToPitch - this.aimFromPitch) * t;
    }

    /**
     * Rotate toward the desired angles at the skill's turn rate.
     *
     * A finite turn rate is what makes a bot beatable. Snapping the yaw makes a
     * bot that is aimed at you on the frame it decides to be, which is not
     * difficulty -- it is a different game. The rate is per skill (D-162)
     * because it was 540 degrees a second for everybody, which is faster than a
     * player can flick and therefore not a rate at all.
     */
    private turn(deltaSeconds: number): void {
        const step = this.skill.turnSpeed * deltaSeconds;

        const yawNow = this.yaw / ANGLE_TO_SHORT;
        let yawError = ((this.desiredYaw - yawNow + 540) % 360) - 180;
        if (yawError > step) yawError = step;
        else if (yawError < -step) yawError = -step;

        this.yaw = Math.round((yawNow + yawError) * ANGLE_TO_SHORT) & 0xffff;

        let pitchError = this.desiredPitch - this.pitch;
        if (pitchError > step) pitchError = step;
        else if (pitchError < -step) pitchError = -step;

        this.pitch = Math.max(-89, Math.min(89, this.pitch + pitchError));
    }

    /** View yaw in degrees, for placing the character model. */
    get viewYaw(): number {
        return this.yaw / ANGLE_TO_SHORT;
    }
}
