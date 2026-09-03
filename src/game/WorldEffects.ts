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

/**
 * The mover simulation with its clock already advanced.
 *
 * A host has N players and one level, so it cannot call `update` per player:
 * `advance` would run N times a frame and every door on the map would open N
 * times too fast, which is the arithmetic `MoverSystem` split `advance` from
 * `touch` for. This is the half a per-player pass needs.
 */
export interface MoverTouchWorld {
    readonly movers: readonly Mover[];
    touch(
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
        this.box(player);

        movers.update(deltaSeconds, this.playerMins, this.playerMaxs, alive);
        movers.touchButtons(this.playerMins, this.playerMaxs);

        this.carried(player, movers.movers);

        return this.settle(player);
    }

    /**
     * The per-player half of {@link apply}, for a caller that advances the
     * mover clock itself.
     *
     * **It carries, and until D-205 it deliberately did not.** The reasoning was
     * sound and its premise expired: `carryDisplacement` moves a player standing
     * on a mover that moved, and a dedicated host had no solid movers at all --
     * `HeadlessPhysics` built BSP model 0 and nothing else -- so applying the
     * displacement would have moved a player who had fallen *through* the plat,
     * which is motion the host invents and no client predicts. D-202 gave the
     * host mover bodies and closed GAP-041, which is the day that entry named:
     * a player can now stand on a plat there, and one that is not carried
     * watches it slide out from under them while the client that predicted the
     * carry gets corrected off it.
     *
     * @param alive `G_RunFrame` does not touch triggers for a dead client.
     */
    applyTouch(player: EffectTarget, movers: MoverTouchWorld, alive = true): WorldEffectResult {
        this.box(player);

        movers.touch(this.playerMins, this.playerMaxs, alive);
        movers.touchButtons(this.playerMins, this.playerMaxs);

        this.carried(player, movers.movers);

        return this.settle(player);
    }

    /**
     * The movers, run for the picture alone.
     *
     * **A joined client's copy of a simulation whose authority is somewhere
     * else.** The host runs the same movers and owns everything they do to a
     * player; what a client still has to do is *move the geometry* -- a door
     * that never opens on your screen is a door you walk into -- and ring the
     * bell, because a mover's sound is presentation and there is no `NetMover`
     * producer to carry either (GAP-041).
     *
     * So this is {@link apply} with both of the halves that touch the player
     * taken out. **No carry**, for the reason `applyTouch` gives: the host does
     * not carry either, and a client that did would move a predicted player the
     * host never moved and pay for it in corrections. **No settle**, because the
     * teleport, the push and the damage all arrive as replicated state and an
     * AUTH_STATE; a client that applied its own would apply them twice.
     *
     * The trigger *tests* still run, and that is the point rather than an
     * oversight: `movers.update` is what opens a door whose button somebody
     * pressed and what advances one already opening, and `touchButtons` is what
     * presses the one under this player's feet. Both are how the geometry on
     * screen ends up in the same place the host has it.
     *
     * **Whatever they queued is dropped on the way out**, and that is a
     * correctness requirement rather than tidiness. `settle` is what empties the
     * queue, and a pass that fills it without one leaves a teleport pending for
     * the next caller and grows `hurtPending` without bound -- so an instance
     * shared with anything that does settle would apply a trigger the host
     * already applied, late, on a frame nobody asked for. Dropping here makes
     * the method safe on its own terms instead of on a promise about how its
     * caller wired `MoverEvents`. The caller on this branch drops them a second
     * time by not raising them at all, for a different reason: a teleport and a
     * pad make a *noise*, and that noise arrives from the host as an
     * `EffectEvent`.
     */
    applyPresentation(
        player: EffectTarget,
        movers: MoverWorld,
        deltaSeconds: number,
        alive = true
    ): void {
        this.box(player);

        movers.update(deltaSeconds, this.playerMins, this.playerMaxs, alive);
        movers.touchButtons(this.playerMins, this.playerMaxs);

        this.discard();
    }

    /** Forget everything the triggers asked for. See {@link applyPresentation}. */
    private discard(): void {
        this.teleportTo = null;
        this.pushVelocity = null;
        this.hurtPending = 0;
    }

    /**
     * The player's world-space box.
     *
     * Read from the player rather than assumed, because `PM_CheckDuck` shortens
     * it while crouched and a trigger test against the standing box opens a
     * door you cannot fit through. It is also the field D-075 found was never
     * being written at all, which is why this is a method rather than a
     * constant.
     */
    private box(player: EffectTarget): void {
        const ps = player.ps;
        for (let i = 0; i < 3; i++) {
            this.playerMins[i] = ps.origin[i]! + player.mins[i]!;
            this.playerMaxs[i] = ps.origin[i]! + player.maxs[i]!;
        }
    }

    private carried(player: EffectTarget, movers: readonly Mover[]): void {
        const ps = player.ps;
        if (carryDisplacement(movers, this.playerMins, this.playerMaxs, this.carry)) {
            ps.origin[0] = ps.origin[0]! + this.carry[0];
            ps.origin[1] = ps.origin[1]! + this.carry[1];
            ps.origin[2] = ps.origin[2]! + this.carry[2];
        }
    }

    /** Everything the triggers asked for, applied and cleared. */
    private settle(player: EffectTarget): WorldEffectResult {
        const ps = player.ps;

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
