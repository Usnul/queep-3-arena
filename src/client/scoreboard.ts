/*
 * scoreboard.ts -- who is winning, as arithmetic rather than as a table.
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
 * `CalculateRanks`' ordering, separated from anything that draws, for the same
 * reason `statusBar.ts` was: the browser this port is developed in cannot start
 * a renderer, so a ranking that lives inside a DOM view can only be looked at,
 * and a ranking that lives in a function can be checked against Q3.
 *
 * The input is sixteen slots' worth of replicated `NetPlayerInfo` and the local
 * slot index. Everything else about a scoreboard -- the columns, the highlight,
 * the toggle -- is `ScoreboardView`'s. **Note the file name**: this is the
 * arithmetic and `ScoreboardView.ts` is the picture, which are two files rather
 * than `scoreboard.ts` and `Scoreboard.ts`, because this repository is
 * developed on a case-insensitive filesystem and those are one file there.
 */

/** What one row needs from a slot's replicated info. */
export interface ScoreboardSource {
    readonly index: number;
    readonly connected: boolean;
    readonly name: string;
    readonly isBot: boolean;
    readonly kills: number;
    readonly deaths: number;
}

export interface ScoreboardRow {
    /** 1-based place. Slots tied on score share the lower number. */
    readonly rank: number;
    readonly slot: number;
    readonly name: string;
    readonly isBot: boolean;
    readonly kills: number;
    readonly deaths: number;
    /** True for the slot this client is playing; the view highlights it. */
    readonly isLocal: boolean;
}

/**
 * `CalculateRanks`, for a free-for-all, over what the wire actually carries.
 *
 * **The sort key is kills alone**, because that is what `PERS_SCORE` is in Q3's
 * deathmatch: `SortRanks` compares nothing else, and deaths are drawn beside the
 * score rather than counted into it. So a player at 10 frags and 9 deaths is
 * above a player at 9 and 0, which looks wrong to anyone used to a K/D column
 * and is the game's own rule.
 *
 * **Ties keep slot order, and that is this port's choice rather than id's.**
 * `SortRanks` returns 0 for equal scores and `G_SortScores` hands that to
 * `qsort`, which is not a stable sort in C -- so the order of tied players in Q3
 * is whatever the library does, and two clients watching the same match can
 * legitimately disagree about it. Slot order is stable, reproduces, and is the
 * same on every peer, which is the property a networked scoreboard wants and
 * the only one a test can hold.
 *
 * **Shared ranks, not sequential ones.** Three players on four frags are all
 * 1st and the next is 4th, which is `CalculateRanks`' own rule -- it walks the
 * sorted list and only moves the rank when the score changes. It is also why the
 * rank is returned rather than left to the view to infer from a row index.
 *
 * Disconnected slots are dropped rather than greyed: a sixteen-slot host is
 * mostly empty, and `NetPlayerInfo` for a slot nobody has ever been in holds a
 * name of `''` and a score of zero, which would draw eleven blank rows tied
 * for last.
 */
export function scoreboardRows(
    slots: readonly ScoreboardSource[],
    localSlot: number
): ScoreboardRow[] {
    const present = slots.filter((slot) => slot.connected);

    present.sort((a, b) => b.kills - a.kills || a.index - b.index);

    const rows: ScoreboardRow[] = [];
    let rank = 0;
    let previousKills = Number.NaN;

    for (let i = 0; i < present.length; i++) {
        const slot = present[i]!;

        // `CalculateRanks`: the place only moves when the score does.
        if (slot.kills !== previousKills) {
            rank = i + 1;
            previousKills = slot.kills;
        }

        rows.push({
            rank,
            slot: slot.index,
            name: slot.name,
            isBot: slot.isBot,
            kills: slot.kills,
            deaths: slot.deaths,
            isLocal: slot.index === localSlot,
        });
    }

    return rows;
}

/**
 * The name a slot shows when the host has not sent one.
 *
 * `NetPlayerInfo` is published on change and delivery of a single mutation is
 * not reliable (GAP-045), so a slot that has just connected can be drawn for
 * several frames before its name arrives -- and the workaround for that gap is
 * a ten-frame republish, not a guarantee. Drawing nothing makes the row look
 * broken; drawing the slot number makes it look like a player who has not
 * finished being introduced, which is exactly what is happening.
 */
export function displayName(row: ScoreboardRow): string {
    return row.name !== '' ? row.name : `player ${row.slot}`;
}

/**
 * What the fourth column would hold, and why there are three.
 *
 * A Q3 scoreboard has a ping. `NetPlayerInfo.pingMs` is on the wire because the
 * component was sized in step 1 against that scoreboard, and **the host has
 * never had a number to put in it**: meep's `NetworkPeer` exposes no round-trip
 * estimate, so measuring one means a ping/pong over `send_reliable_command`,
 * which D-173 assessed and v1 does not do.
 *
 * So the column is **absent rather than zero**. A board reading "0 ms" for
 * every player on a 150 ms link is worse than one that does not claim to know,
 * and a zero is indistinguishable from a real answer. Exported so that the day
 * a number exists, the thing to delete is findable by grep rather than by
 * reading the view.
 */
export const PING_HAS_NO_SOURCE = true;
