/*
 * Difficulty.ts -- how good the opposition is, as numbers rather than as code.
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
 * The port shipped bots with no difficulty at all, and "no difficulty" is not a
 * neutral setting -- it is the hardest one. A bot with no reaction time notices
 * the instant the trace clears, a bot with no aim error puts every round through
 * one point, and both of those are *cheaper* to write than the alternative. Free
 * is not the same as fair.
 *
 * So this is the table the rest of the bot reads, and nothing else in the port
 * is allowed to hard-code any of it. Five levels, named after Q3's own
 * (`g_spSkill` 1..5, "I Can Win" through "Nightmare"), because a player who has
 * seen a Quake menu already knows what those mean and because the port's whole
 * argument is that it is the same game.
 *
 * **Where the numbers come from.** Not from botlib: Q3's character files ship
 * `CHARACTERISTIC_AIM_ACCURACY`, `CHARACTERISTIC_AIM_SKILL` and
 * `CHARACTERISTIC_REACTIONTIME` as five sets of fuzzy weights per bot, and this
 * port deliberately has no character files (D-055). What it has instead is the
 * shape those characteristics describe, fixed against measured human numbers:
 *
 * - **Reaction.** Simple visual reaction time sits near 250 ms, and a *choice*
 *   reaction -- see it, decide it is a target, act -- runs 350 to 500 ms.
 *   Trained players reach 150-200 ms. So the top level is 180 ms because that is
 *   roughly the human floor rather than because it is a round number, and the
 *   bottom is 900 ms because a distracted human is that slow.
 * - **Aim error.** An *angular* error, not a distance one, which is the whole
 *   choice: a fixed offset at the target keeps a bot equally deadly at 2,000
 *   units as at 100, while an angle makes hit probability fall with range the
 *   way a human's does. Q3's machinegun cone is +/-1.4 degrees for comparison,
 *   so 4.5 degrees at the default level is a bot whose hand is three times
 *   looser than its gun.
 * - **Tracking.** A lag, not a lead. The bot aims where the target *was*
 *   `trackingSeconds` ago, which is what a tracking hand does and the exact
 *   opposite of the aim prediction D-055 rules out. It is also the reason
 *   strafing works: shots trail behind you instead of following you.
 *
 * **The default leans casual on purpose.** `bring-it-on` is Q3's own `g_spSkill`
 * default and the second of five, and everything here is tuned so that a player
 * who has not played an arena shooter in twenty years can walk round a corner
 * and survive the surprise.
 */

/** Stable ids. They are the stored value of the menu row, so they do not move. */
export type DifficultyId =
    | 'i-can-win'
    | 'bring-it-on'
    | 'hurt-me-plenty'
    | 'hardcore'
    | 'nightmare';

/**
 * Everything about a bot that difficulty changes.
 *
 * One flat record rather than a class with methods, because every consumer wants
 * a different subset and none of them wants behaviour: `Bot` reads the four that
 * describe a hand, the tree reads the rest, which describe attention.
 */
export interface BotSkill {
    readonly id: DifficultyId;
    /** What the menu shows. Q3's own wording. */
    readonly label: string;
    /** `g_spSkill`, 1..5. Nothing branches on it; it is how a player names these. */
    readonly level: number;

    /* ---- attention ---- */

    /**
     * Seconds of sight before the bot acts on what it is looking at.
     *
     * Drawn afresh per engagement with {@link reactionJitterSeconds} either way,
     * so a rank of bots rounding a corner does not fire as one.
     */
    readonly reactionSeconds: number;
    /** Uniform +/- jitter on each reaction draw. */
    readonly reactionJitterSeconds: number;
    /**
     * How fast awareness drains while the target is out of sight, as a fraction
     * of how fast it built up.
     *
     * Below 1, so glimpses accumulate: stepping in and out of a doorway does not
     * reset a bot's attention, it only slows it down. This is what keeps the
     * reaction delay from being a peek-a-boo exploit.
     */
    readonly forgetRate: number;

    /* ---- the hand ---- */

    /**
     * One sigma of angular aim error, in degrees, applied to yaw and pitch.
     *
     * Gaussian rather than uniform in a disc. A disc puts most of its area at the
     * rim, so a bot drawing from one is a bot that is reliably *off* target; a
     * normal distribution peaks at zero error, which is what a hand does.
     */
    readonly aimErrorDegrees: number;
    /**
     * Seconds between fresh error draws. The error crosses smoothly between
     * them, so it wanders rather than jumping.
     *
     * An independent draw per shot would be worse than this and cheaper: a bot
     * whose error resamples every frame is one whose shots are a fair coin, and
     * a fair coin at ten rounds a second hits about as often as its average and
     * never misses you *consistently*. Correlated error is what makes a burst go
     * wide as a burst, which is the thing a player can see and move against.
     */
    readonly aimDriftSeconds: number;
    /** How fast the view swings onto a new aim point, degrees per second. */
    readonly turnSpeed: number;
    /**
     * How far behind the target's actual position the bot aims, in seconds.
     *
     * See the file header: a lag, deliberately, and the reason a strafing player
     * is hard to hit.
     */
    readonly trackingSeconds: number;

    /* ---- engagement ---- */

    /** How far off a bot will start a fight, in Q3 units. */
    readonly sightRange: number;
    /**
     * Seconds a bot will keep shooting at where the target was, after losing it.
     *
     * Not zero above the easiest level, because a shot into the corner somebody
     * has just gone round is a real thing a player does. Small, because thirty
     * rounds into a wall is not.
     */
    readonly blindFireSeconds: number;
    /** Seconds a bot will hunt a lost target before going back to its route. */
    readonly searchSeconds: number;
}

/**
 * The five levels.
 *
 * Easiest first, which is the order the menu shows them in and the order Q3
 * lists them in. Every column is monotonic down the table on purpose -- a level
 * that is better at one thing and worse at another is a level nobody can choose
 * between.
 */
export const DIFFICULTIES: readonly BotSkill[] = [
    {
        id: 'i-can-win',
        label: 'I Can Win',
        level: 1,
        reactionSeconds: 0.9,
        reactionJitterSeconds: 0.3,
        forgetRate: 0.7,
        aimErrorDegrees: 7,
        aimDriftSeconds: 1,
        turnSpeed: 210,
        trackingSeconds: 0.35,
        sightRange: 1400,
        blindFireSeconds: 0,
        searchSeconds: 1.5,
    },
    {
        id: 'bring-it-on',
        label: 'Bring It On',
        level: 2,
        reactionSeconds: 0.65,
        reactionJitterSeconds: 0.2,
        forgetRate: 0.6,
        aimErrorDegrees: 4.5,
        aimDriftSeconds: 0.8,
        turnSpeed: 280,
        trackingSeconds: 0.28,
        sightRange: 1800,
        blindFireSeconds: 0.2,
        searchSeconds: 2.5,
    },
    {
        id: 'hurt-me-plenty',
        label: 'Hurt Me Plenty',
        level: 3,
        reactionSeconds: 0.45,
        reactionJitterSeconds: 0.15,
        forgetRate: 0.5,
        aimErrorDegrees: 2.8,
        aimDriftSeconds: 0.6,
        turnSpeed: 360,
        trackingSeconds: 0.2,
        sightRange: 2200,
        blindFireSeconds: 0.4,
        searchSeconds: 3.5,
    },
    {
        id: 'hardcore',
        label: 'Hardcore',
        level: 4,
        reactionSeconds: 0.3,
        reactionJitterSeconds: 0.1,
        forgetRate: 0.4,
        aimErrorDegrees: 1.5,
        aimDriftSeconds: 0.45,
        turnSpeed: 470,
        trackingSeconds: 0.13,
        sightRange: 2600,
        blindFireSeconds: 0.6,
        searchSeconds: 4.5,
    },
    {
        id: 'nightmare',
        label: 'Nightmare!',
        level: 5,
        reactionSeconds: 0.18,
        reactionJitterSeconds: 0.05,
        forgetRate: 0.3,
        aimErrorDegrees: 0.6,
        aimDriftSeconds: 0.3,
        turnSpeed: 620,
        trackingSeconds: 0.07,
        sightRange: 3000,
        blindFireSeconds: 0.8,
        searchSeconds: 5.5,
    },
];

/**
 * What a match runs at when nobody has said otherwise.
 *
 * Q3's own `g_spSkill` default, and the reason the port has a difficulty at all
 * is in the file header: "no difficulty" was the hardest setting.
 */
export const DEFAULT_DIFFICULTY: DifficultyId = 'bring-it-on';

/**
 * Look a level up by id.
 *
 * Falls back to the default rather than throwing, because the callers are a
 * saved setting and a query string -- both outside strings that a rename or a
 * typo can make meaningless, and neither worth failing a match over.
 */
export function difficulty(id: string): BotSkill {
    return (
        DIFFICULTIES.find((d) => d.id === id) ??
        DIFFICULTIES.find((d) => d.id === DEFAULT_DIFFICULTY)!
    );
}

/**
 * A standard normal deviate, truncated to `limit` sigma.
 *
 * Box-Muller with rejection. The truncation is the point: an untruncated normal
 * has a tail, and the one draw in a thousand that comes back at four sigma is a
 * bot whose shot goes somewhere absurd -- which reads as a bug rather than as a
 * miss. At 2.5 sigma the rejection rate is about 1.2%, so the loop almost never
 * runs twice and the bound on it is a formality.
 */
export function gaussian(random: () => number, limit = 2.5): number {
    for (let attempt = 0; attempt < 8; attempt++) {
        // 1 - random() so the log's argument is never zero.
        const u = 1 - random();
        const v = random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        if (Math.abs(z) <= limit) return z;
    }
    return 0;
}
