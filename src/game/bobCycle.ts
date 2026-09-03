/*
 * bobCycle.ts -- `PM_Footsteps`' counter, for the solver that does not run it.
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
 * `ps.bobCycle` is where a footstep comes from: `PM_Footsteps` advances it by
 * `bobmove * msec` and plays a sound when it crosses 64 or 192, so a running
 * player steps every 320 ms whatever their speed (D-081, D-082).
 *
 * `PM_Footsteps` is inside the ported `bg_pmove`, and the default movement
 * backend is meep's `KinematicMover` -- which runs the same motor and none of
 * the game logic wrapped around it. So on the default backend the counter has
 * to be advanced by whoever owns the player, and this is that.
 *
 * **It lived on `PlayerSlot` and had to come out**, because a bot is not a
 * `PlayerSlot`. `Bot` is its own `usercmd_t` producer and consumer (D-050) and
 * drives its own `pmove_t`, so nothing ever advanced a bot's cycle: `storeBot`
 * has always published `bobCycle` and it has always published **zero**, which
 * made the field dead on the wire for every slot a human was not in, and made
 * bots silent in single-player too. Nobody noticed because until the networked
 * presentation asked for remote footsteps, the only cycle anything read was the
 * local player's.
 */

import * as C from '../q3/pmove/constants.ts';
import { FORWARDMOVE, RIGHTMOVE } from '../q3/pmove/types.ts';

/** `PM_Footsteps`' three rates. Ducked bobs fastest and is silent. */
export const BOBMOVE_RUN = 0.4;
export const BOBMOVE_WALK = 0.3;
export const BOBMOVE_DUCKED = 0.5;

/** The half of `playerState_t` this reads and writes. */
interface BobState {
    bobCycle: number;
    readonly groundEntityNum: number;
    readonly pm_flags: number;
    readonly velocity: { readonly [i: number]: number };
}

/** The half of `usercmd_t` it needs: which way, and how hard. */
interface BobCommand {
    readonly moves: ArrayLike<number>;
    readonly buttons: number;
}

/**
 * `BUTTON_WALKING`, with `PmoveSingle`'s own veto applied.
 *
 * Q3 clears the bit itself when either move axis exceeds 64 -- "a bit that says
 * walk while the stick says run is a run" -- and it clears it inside
 * `PmoveSingle`, which is the ported solver. The default backend is meep's
 * `KinematicMover` and does not run that line, so a client sending
 * `BUTTON_WALKING` with full movement would be walking on one backend and
 * running on the other.
 *
 * Applying the rule here rather than trusting the bit gives both backends Q3's
 * answer, and gives the two peers the same answer as each other, which is what
 * the prediction short-circuit needs.
 */
export function isWalking(cmd: BobCommand): boolean {
    if ((cmd.buttons & C.BUTTON_WALKING) === 0) return false;
    return Math.abs(cmd.moves[FORWARDMOVE]!) <= 64 && Math.abs(cmd.moves[RIGHTMOVE]!) <= 64;
}

/**
 * Advance `ps.bobCycle` by one frame of `msec` milliseconds.
 *
 * Counted in whole milliseconds so both solvers agree on a quantity a test can
 * compare. It costs a little rate at high frame rates, and it costs Q3 the
 * same.
 *
 * Only the leg animations are missing -- `PM_ContinueLegsAnim` belongs to a
 * character neither a slot nor a bot has, and the networked presentation picks
 * the animation from replicated velocity instead (`legsOf`).
 */
export function advanceBobCycle(ps: BobState, cmd: BobCommand, msec: number): void {
    // Airborne leaves the position in the cycle intact but does not advance.
    if (ps.groundEntityNum === C.ENTITYNUM_NONE) return;

    if (cmd.moves[FORWARDMOVE] === 0 && cmd.moves[RIGHTMOVE] === 0) {
        // Come to rest at the start of a stride, so the next one is level.
        const speed = Math.hypot(ps.velocity[0]!, ps.velocity[1]!);
        if (speed < 5) ps.bobCycle = 0;
        return;
    }

    /*
     `PM_Footsteps`' order: ducked first, and a ducked walk bobs as a ducked run
     does, because Q3 never asks the second question.
    */
    const bobmove =
        (ps.pm_flags & C.PMF_DUCKED) !== 0
            ? BOBMOVE_DUCKED
            : isWalking(cmd)
              ? BOBMOVE_WALK
              : BOBMOVE_RUN;

    ps.bobCycle = Math.trunc(ps.bobCycle + bobmove * msec) & 255;
}
