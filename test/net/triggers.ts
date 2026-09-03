/*
 * triggers.ts -- standing a networked player inside a trigger volume.
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
 * Two facts about this port's maps that cost three runs each to establish, and
 * that two test files now need. They are here rather than copied because both of
 * them are knowledge about the *geometry*, and a second copy of a fact is a
 * second thing to be wrong.
 *
 * **The player is placed inside the trigger rather than walked into it.** There
 * is one teleporter on `oa_dm1` and eight jump pads on `am_thornish`, and
 * getting a scripted client to stand on a specific one depends on the
 * pathfinding, the spawn point and the map -- which is a fixture whose subject
 * appears when the AI cooperates, and this suite has been caught by that four
 * times (D-187). The trigger volume's own bounds come off the host, the origin
 * is written into it, and what is measured is what the host then does. How a
 * player gets there is the movement code's business and is measured elsewhere.
 *
 * **And the origin is written into the replicated component, not into `ps`.** A
 * host frame is `stepSlot` -- `load` from the components, step, `store` back --
 * then `worldStep`, then `publish`, so a write to `ps` before the frame is
 * discarded by the `load` at the top of it. `record.state` is the authority
 * between frames; `ps` is scratch inside one.
 */

import type { NetRig } from './rig.ts';
import type { Trigger } from '../../src/game/Movers.ts';

/** `PM_CheckDuck`'s standing `mins[2]`: how far below the origin the feet are. */
export const FEET = 24;

/**
 * Places inside a trigger a player could plausibly be standing, in order.
 *
 * **The centre is the obvious choice and it does not work**, which took three
 * runs to establish and is worth writing down. A trigger volume is a brush, and
 * where inside it a player can stand is a fact about the map's geometry, not
 * about the box: at the centre of a jump pad's volume the feet are 24 units
 * lower and often inside the world, and the solver spends the next frame
 * ejecting them -- measured at 59 to 64 units of drop and 30 sideways, every
 * frame, so the trigger pass (which runs *after* the movement) never saw the
 * player inside anything.
 *
 * Two candidates cover every trigger in the set and they are complementary,
 * which is the useful part: **feet just above the volume's floor** fires the
 * four thin pads on `am_thornish` and the teleporter and hurt volume on
 * `oa_dm1`, and **head near the volume's ceiling** fires the four thick pads,
 * whose floor is below the level's. Measured: 612 and 470 respectively, on the
 * first frame, against nothing at all from the other candidate.
 *
 * The order matters only for speed; a caller tries them until one fires.
 */
export function standingSpots(trigger: Trigger): [number, number, number][] {
    const x = (trigger.mins[0] + trigger.maxs[0]) * 0.5;
    const y = (trigger.mins[1] + trigger.maxs[1]) * 0.5;
    return [
        [x, y, trigger.mins[2] + FEET + 1],
        [x, y, trigger.maxs[2] - FEET - 1],
    ];
}

/** The first of {@link standingSpots}, for a caller that only needs one. */
export function standIn(trigger: Trigger): [number, number, number] {
    return standingSpots(trigger)[0]!;
}

/**
 * Hold a slot in one place for a frame, and step.
 *
 * The origin goes into the **replicated component**, for the reason the module
 * note gives. Re-written each frame because the trigger pass runs after the
 * movement, so a player put somewhere they cannot stand is somewhere else by the
 * time the trigger looks.
 */
export function holdAt(
    rig: NetRig,
    slotIndex: number,
    at: readonly number[],
    options: { zeroVelocity?: boolean } = {}
): void {
    const state = rig.host.playerById(slotIndex)!.state;
    state.origin[0] = at[0]!;
    state.origin[1] = at[1]!;
    state.origin[2] = at[2]!;
    if (options.zeroVelocity !== false) {
        state.velocity[0] = 0;
        state.velocity[1] = 0;
        state.velocity[2] = 0;
    }
    rig.step(1);
}
