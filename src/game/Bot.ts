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
 * selected by `?move=q3`. Both write the same `playerState_t`, so everything
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
 * simulation -- "go here", "look there", "shoot" -- plus the state the tree
 * reads to decide.
 */

import { Pmove as runPmove } from '../q3/pmove/pmove.ts';
import type { Pmove } from '../q3/pmove/types.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';
import { vec3, type Vec3 } from '../q3/math.ts';
import { createPmoveHost, type PmoveHostOptions } from './PmoveHost.ts';
import {
    PlayerMovement,
    type MoverHost,
    type MoveCommand,
} from '../client/MeepMove.ts';
import { newInventory, type Inventory } from './Items.ts';
import type { Damageable } from './Weapons.ts';
import type { WeaponId } from './Weapons.ts';

/** `usercmd_t.angles` is 16-bit fixed point over a full turn. */
const ANGLE_TO_SHORT = 65536 / 360;

/** How fast a bot turns, in degrees per second. Q3's `ai_main` uses similar rates. */
const TURN_SPEED = 540;

/** Fire when the aim is within this many degrees of the target. */
const AIM_TOLERANCE = 8;

/** Arrival radius for a path node, in Q3 units. Half the grid spacing. */
const NODE_RADIUS = 40;

export interface BotOptions extends PmoveHostOptions {
    readonly id: number;
    readonly name: string;
    /** Which converted character model represents it. */
    readonly character: string;
    /**
     * Physics for the meep-native movement path. Null runs the ported
     * `bg_pmove` instead, which is what `?move=q3` and the divergence harness
     * select.
     */
    readonly moverHost?: MoverHost | null;
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

    /** Set by the tree each frame from a line-of-sight trace. */
    enemyVisible = false;
    /** Where the enemy was last seen, whether or not it is visible now. */
    readonly lastSeen: Vec3 = vec3();
    /** Seconds until it can fire again. */
    fireCooldown = 0;

    /** Desired facing, which the bot turns toward rather than snapping to. */
    private desiredYaw = 0;
    private desiredPitch = 0;

    private yaw = 0;
    private pitch = 0;

    /** Movement the tree asked for this frame; cleared after each `think`. */
    private moveForward = 0;
    private moveRight = 0;
    private wantJump = false;

    private timeMs = 0;

    /** Raised when the bot's weapon should fire. */
    onFire: ((eyeQ3: ArrayLike<number>, anglesQ3: ArrayLike<number>, weapon: WeaponId) => void) | null =
        null;

    constructor(options: BotOptions) {
        this.id = options.id;
        this.name = options.name;
        this.character = options.character;

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

    /** Turn toward a world position, at a finite rate. */
    lookAt(targetQ3: ArrayLike<number>): void {
        const ps = this.pmove.ps;

        const dx = targetQ3[0]! - ps.origin[0]!;
        const dy = targetQ3[1]! - ps.origin[1]!;
        const dz = targetQ3[2]! - (ps.origin[2]! + ps.viewheight);

        this.desiredYaw = (Math.atan2(dy, dx) * 180) / Math.PI;
        // Q3 pitch is positive *downward*, which is why this is negated.
        this.desiredPitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    }

    jump(): void {
        this.wantJump = true;
    }

    /** True when the bot is pointed close enough at what it is looking at. */
    get aimed(): boolean {
        const yawNow = this.yaw / ANGLE_TO_SHORT;
        let error = ((this.desiredYaw - yawNow + 540) % 360) - 180;
        error = Math.abs(error);
        return error < AIM_TOLERANCE && Math.abs(this.desiredPitch - this.pitch) < AIM_TOLERANCE * 2;
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
            this.movement.step(this.pmove.ps, this.meepCommand(), deltaSeconds);
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
     * The command this frame, in the shape the meep-native path takes.
     *
     * Reads the `usercmd_t` that was just filled rather than the intent fields
     * directly, so both solvers are driven from one source. `PM_DEAD` has no
     * counterpart in `MeepMove`: a dead bot simply commands nothing and keeps
     * falling, which is what Q3's dead move amounts to once the view-angle
     * handling it also does is not wanted here.
     */
    private meepCommand(): MoveCommand {
        const moves = this.pmove.cmd.moves;

        return {
            forward: moves[FORWARDMOVE]!,
            right: moves[RIGHTMOVE]!,
            up: moves[UPMOVE]!,
            pitch: this.pitch,
            yaw: this.yaw / ANGLE_TO_SHORT,
            // Bots do not crouch: nothing in the tree asks for it, and a
            // crouching bot that cannot stand back up is a stuck bot.
            crouch: false,
        };
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
     * Rotate toward the desired angles at `TURN_SPEED`.
     *
     * A finite turn rate is what makes a bot beatable. Snapping the yaw makes a
     * bot that is aimed at you on the frame it decides to be, which is not
     * difficulty -- it is a different game.
     */
    private turn(deltaSeconds: number): void {
        const step = TURN_SPEED * deltaSeconds;

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
