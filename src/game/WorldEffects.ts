/*
 * WorldEffects.ts -- what the world does to the player between two frames.
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
 * `G_RunFrame` moves the movers, then thinks for the clients. Between those two
 * a player can be teleported, launched by a jump pad, hurt by a trigger, or
 * carried by the plat they are standing on -- four writes straight into
 * `playerState_t` that no solver produced and every solver has to honour on the
 * next entry.
 *
 * This was an inline block in `main.ts`, and it is out here for one reason:
 * three bugs in this port have been things a replacement stopped maintaining
 * across that boundary (D-072, D-074, D-075), and the block could not be tested
 * because it lived inside `main()` between an engine boot and a render loop. A
 * test that reproduces the ordering by hand is a test of a copy -- which is the
 * same mistake in a different place. Now the app and `player-controller.test.ts`
 * call this.
 *
 * The order below is `G_RunFrame`'s and is load-bearing. Movers push, then the
 * rider is carried, then the discrete events land. The other way round and a
 * plat leaves from under you.
 *
 * Sound stays with the caller. The events fire during `movers.update`, deep
 * inside the mover state machine, and the audio bank is presentation; what is
 * shared here is the state, not the noise it makes.
 */

import { carryDisplacement, type Mover, type Vec3 } from './Movers.ts';

/**
 * What this needs from the player.
 *
 * Structural, and deliberately the smallest set: an origin and a velocity to
 * write, a box to be tested with, and a way to be turned. `PlayerController`
 * satisfies it; so does anything else that ends up driving a player.
 */
export interface EffectTarget {
    readonly ps: {
        readonly origin: { [i: number]: number };
        readonly velocity: { [i: number]: number };
    };
    /** Q3 units relative to `ps.origin`, and posture-dependent (D-075). */
    readonly mins: ArrayLike<number>;
    readonly maxs: ArrayLike<number>;
    /** `TeleportPlayer` chooses your facing as well as your position. */
    setYaw(degrees: number): void;
}

/**
 * The mover simulation, structurally.
 *
 * `MoverSystem` satisfies it. Declared rather than imported so a caller can
 * hand over a fixed set of movers -- a synthetic plat, say -- without spawning
 * a map's worth of brush entities to get at one.
 */
export interface MoverWorld {
    readonly movers: readonly Mover[];
    update(
        deltaSeconds: number,
        playerMinsQ3: ArrayLike<number>,
        playerMaxsQ3: ArrayLike<number>,
        alive: boolean
    ): void;
    touchButtons(playerMinsQ3: ArrayLike<number>, playerMaxsQ3: ArrayLike<number>): void;
}

export interface WorldEffectResult {
    /** Damage from `trigger_hurt` this frame, for the caller's inventory. */
    readonly damage: number;
    /** True if a teleport landed, which the caller may want to flash on. */
    readonly teleported: boolean;
}

export class WorldEffects {
    /** The player's world-space box, rebuilt each frame. Read-only to callers. */
    readonly playerMins: Vec3 = [0, 0, 0];
    readonly playerMaxs: Vec3 = [0, 0, 0];

    private teleportTo: Vec3 | null = null;
    private teleportYaw = 0;
    private hurtPending = 0;
    private pushVelocity: Vec3 | null = null;

    private readonly carry: Vec3 = [0, 0, 0];

    /* ---- recorders, wired into `MoverEvents` by the caller ---- */

    /**
     * Deferred rather than applied where it fires, because it fires from inside
     * `movers.update` -- moving the player mid-iteration would have the mover
     * loop finish against a position that no longer exists.
     */
    teleport(originQ3: readonly number[], yawDegrees: number): void {
        this.teleportTo = [originQ3[0]!, originQ3[1]!, originQ3[2]!];
        this.teleportYaw = yawDegrees;
    }

    hurt(damage: number): void {
        this.hurtPending += damage;
    }

    /**
     * `BG_TouchJumpPad` overwrites velocity outright rather than adding to it,
     * which is why a jump pad launches you the same way however fast you ran
     * onto it. Last pad wins, as it does in Q3.
     */
    push(velocityQ3: readonly number[]): void {
        this.pushVelocity = [velocityQ3[0]!, velocityQ3[1]!, velocityQ3[2]!];
    }

    /* ---- the frame ---- */

    /**
     * Run the movers against this player and apply everything they did to it.
     *
     * @param alive `G_RunFrame` does not touch triggers for a dead client.
     */
    apply(
        player: EffectTarget,
        movers: MoverWorld,
        deltaSeconds: number,
        alive = true
    ): WorldEffectResult {
        const ps = player.ps;

        /*
         The box is read from the player rather than assumed, because
         `PM_CheckDuck` shortens it while crouched and a trigger test against the
         standing box opens a door you cannot fit through. It is also the field
         D-075 found was never being written at all, which is why this is one
         line rather than a constant.
        */
        for (let i = 0; i < 3; i++) {
            this.playerMins[i] = ps.origin[i]! + player.mins[i]!;
            this.playerMaxs[i] = ps.origin[i]! + player.maxs[i]!;
        }

        movers.update(deltaSeconds, this.playerMins, this.playerMaxs, alive);
        movers.touchButtons(this.playerMins, this.playerMaxs);

        if (carryDisplacement(movers.movers, this.playerMins, this.playerMaxs, this.carry)) {
            ps.origin[0] = ps.origin[0]! + this.carry[0];
            ps.origin[1] = ps.origin[1]! + this.carry[1];
            ps.origin[2] = ps.origin[2]! + this.carry[2];
        }

        const teleported = this.teleportTo !== null;
        if (this.teleportTo !== null) {
            ps.origin[0] = this.teleportTo[0];
            ps.origin[1] = this.teleportTo[1];
            // `TeleportPlayer` drops the player 1 unit clear of the mark.
            ps.origin[2] = this.teleportTo[2] + 1;
            ps.velocity[0] = 0;
            ps.velocity[1] = 0;
            ps.velocity[2] = 0;
            player.setYaw(this.teleportYaw);
            this.teleportTo = null;
        }

        if (this.pushVelocity !== null) {
            ps.velocity[0] = this.pushVelocity[0];
            ps.velocity[1] = this.pushVelocity[1];
            ps.velocity[2] = this.pushVelocity[2];
            this.pushVelocity = null;
        }

        const damage = this.hurtPending;
        this.hurtPending = 0;

        return { damage, teleported };
    }
}
