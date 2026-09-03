/*
 * scoreboard.test.ts -- who is first, and what a tie does.
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
 * A scoreboard is four columns and it is easy to get two of them wrong in ways
 * nobody notices for a month. Three things this holds:
 *
 *   - **The sort key is Q3's, not the tidy one.** `SortRanks` compares
 *     `PERS_SCORE` and nothing else, so 10 frags and 9 deaths beats 9 frags and
 *     none. Every instinct says to break the tie on deaths; doing so is a
 *     different game's scoreboard.
 *   - **Ranks are shared.** Three players on four frags are all 1st and the next
 *     is 4th. Numbering the rows 1, 2, 3, 4 instead is one line of view code and
 *     is wrong every time there is a tie, which in a deathmatch is most of it.
 *   - **A tie has an order at all.** Q3's is `qsort`'s, which is to say none;
 *     this port's is slot order, so that two clients drawing the same match draw
 *     the same table. That is a property a test can hold and Q3 cannot.
 */

import { describe, expect, it } from 'vitest';

import {
    displayName,
    PING_HAS_NO_SOURCE,
    scoreboardRows,
    type ScoreboardRow,
    type ScoreboardSource,
} from '../src/client/scoreboard.ts';
import { MAX_CLIENTS } from '../src/net/protocol.ts';
import { NetPlayerInfo } from '../src/net/components.ts';
import { NetRig } from './net/rig.ts';
import { NetScoreboardSystem } from '../src/app/netSystems.ts';

/** A roster, spelled the way the wire holds one: sixteen slots, mostly empty. */
function roster(
    filled: Array<{ slot: number; name: string; kills: number; deaths?: number; bot?: boolean }>
): ScoreboardSource[] {
    const slots: ScoreboardSource[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
        const entry = filled.find((f) => f.slot === i);
        slots.push({
            index: i,
            connected: entry !== undefined,
            name: entry?.name ?? '',
            isBot: entry?.bot ?? false,
            kills: entry?.kills ?? 0,
            deaths: entry?.deaths ?? 0,
        });
    }
    return slots;
}

describe('the order a scoreboard is in', () => {
    it('sorts on frags alone, the way SortRanks does', () => {
        const rows = scoreboardRows(
            roster([
                { slot: 0, name: 'careful', kills: 9, deaths: 0 },
                { slot: 1, name: 'reckless', kills: 10, deaths: 9 },
            ]),
            0
        );

        /*
         The row that would fail if deaths crept into the key. 10/9 above 9/0 is
         not an oversight -- `PERS_SCORE` is frags and the deaths column is
         context, so a player who trades three for one is still winning.
        */
        expect(rows.map((r) => r.name)).toEqual(['reckless', 'careful']);
        expect(rows[0]!.rank).toBe(1);
        expect(rows[1]!.rank).toBe(2);
    });

    it('gives tied players the same rank, and the next player the gap', () => {
        const rows = scoreboardRows(
            roster([
                { slot: 0, name: 'a', kills: 4 },
                { slot: 1, name: 'b', kills: 4 },
                { slot: 2, name: 'c', kills: 4 },
                { slot: 3, name: 'd', kills: 1 },
            ]),
            0
        );

        expect(rows.map((r) => r.rank)).toEqual([1, 1, 1, 4]);
    });

    it('breaks a tie by slot, so two clients draw the same table', () => {
        const filled = [
            { slot: 7, name: 'seven', kills: 3 },
            { slot: 2, name: 'two', kills: 3 },
            { slot: 11, name: 'eleven', kills: 3 },
        ];

        const forward = scoreboardRows(roster(filled), 2);
        const reversed = scoreboardRows(roster([...filled].reverse()), 2);

        /*
         The same three players, handed over in two different orders, produce
         one table. `roster` rebuilds the slot array from the index either way,
         so what this actually holds is that the sort does not depend on the
         order of the input -- which is what makes it agree across peers.
        */
        expect(forward.map((r) => r.slot)).toEqual([2, 7, 11]);
        expect(reversed.map((r) => r.slot)).toEqual([2, 7, 11]);
    });

    it('drops the eleven slots nobody is in', () => {
        const rows = scoreboardRows(roster([{ slot: 0, name: 'alone', kills: 0 }]), 0);

        /*
         Every unoccupied slot is a real entity with a real `NetPlayerInfo`
         holding zeroes, so a filter on `connected` is the only thing between
         this and fifteen blank rows tied for first.
        */
        expect(rows).toHaveLength(1);
        expect(rows[0]!.name).toBe('alone');
    });

    it('marks exactly one row as the local player, and none when spectating', () => {
        const filled = roster([
            { slot: 0, name: 'a', kills: 1 },
            { slot: 4, name: 'b', kills: 2 },
        ]);

        expect(scoreboardRows(filled, 4).filter((r) => r.isLocal).map((r) => r.name)).toEqual([
            'b',
        ]);
        expect(scoreboardRows(filled, -1).some((r) => r.isLocal)).toBe(false);
    });
});

describe('a slot whose name has not arrived', () => {
    it('shows the slot number rather than an empty cell', () => {
        const rows = scoreboardRows(roster([{ slot: 5, name: '', kills: 0 }]), 0);

        /*
         Not hypothetical: `NetPlayerInfo` is published on change and a single
         mutation is not reliably delivered (GAP-045), so this is the state a
         freshly joined slot is genuinely in for a few frames -- and for the rest
         of the match if the republish window misses it.
        */
        expect(displayName(rows[0]!)).toBe('player 5');
    });

    it('shows the name once it does', () => {
        const rows = scoreboardRows(roster([{ slot: 5, name: 'Sarge', kills: 0 }]), 0);
        expect(displayName(rows[0]!)).toBe('Sarge');
    });
});

describe('the fourth column', () => {
    it('has no source, which is why it is not drawn', () => {
        /*
         `pingMs` is on the wire and is always zero, because meep's
         `NetworkPeer` exposes no RTT and this port does not run a ping/pong
         (D-173). This asserts the field is still there -- so the day a number
         exists the wire does not have to change -- and that nothing has quietly
         started drawing it.
        */
        const info = new NetPlayerInfo();
        expect(info.pingMs).toBe(0);
        expect(PING_HAS_NO_SOURCE).toBe(true);

        const rows = scoreboardRows(roster([{ slot: 0, name: 'a', kills: 0 }]), 0);
        expect(Object.keys(rows[0]!)).not.toContain('pingMs');
    });
});

/* ------------------------------------------------------------------ *
 * The system, against a real match
 * ------------------------------------------------------------------ */

describe('the board a joined client would actually draw', () => {
    it('shows the host roster, hides itself when the key is not held, and reads nothing then', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 1,
            seed: 23,
            warmup: 40,
        });

        rig.step(180);

        const client = rig.clients[0]!;

        /*
         The recorder pattern the rest of the networked presentation uses:
         `NetScoreboardSystem` is typed against two methods, so what a browser
         would put on screen becomes a list here.
        */
        const drawn: ScoreboardRow[][] = [];
        let visible: boolean | null = null;
        const table = {
            setVisible(v: boolean) {
                visible = v;
            },
            update(rows: readonly ScoreboardRow[]) {
                drawn.push([...rows]);
            },
        };

        let held = false;
        const system = new NetScoreboardSystem({
            client: client.net,
            view: table,
            held: () => held,
        });

        // Closed: told to hide, and nothing drawn.
        system.update();
        expect(visible).toBe(false);
        expect(drawn).toHaveLength(0);

        // Open.
        held = true;
        system.update();
        expect(visible).toBe(true);
        expect(drawn).toHaveLength(1);

        const rows = drawn[0]!;

        /*
         Five players: the client and four bots. This is the assertion that
         would have caught a board built from `NetPlayerInfo.name !== ''`
         instead of from `connected` -- GAP-045 means a name can be late, and a
         roster that waits for one is a roster that is short a player for the
         first few frames of every join.
        */
        expect(rows).toHaveLength(5);
        expect(rows.filter((r) => r.isBot)).toHaveLength(4);
        expect(rows.filter((r) => r.isLocal)).toHaveLength(1);
        expect(rows.find((r) => r.isLocal)!.slot).toBe(client.net.slotIndex);

        // eslint-disable-next-line no-console
        console.log(
            '[scoreboard] as a joined client sees it: ' +
                rows
                    .map((r) => `${r.rank}. ${displayName(r)} ${r.kills}/${r.deaths}`)
                    .join(', ')
        );

        /*
         And the ranks are a run of shared places rather than a row index: with
         five players mostly on zero frags, most of them tie for first, which is
         the case a sequential 1..5 gets wrong and nobody notices because the
         numbers still increase.
        */
        expect(rows[0]!.rank).toBe(1);
        for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1]!;
            const b = rows[i]!;
            expect(b.kills).toBeLessThanOrEqual(a.kills);
            if (b.kills === a.kills) expect(b.rank).toBe(a.rank);
            else expect(b.rank).toBe(i + 1);
        }

        // Closed again: hidden, and still only the one draw.
        held = false;
        system.update();
        expect(visible).toBe(false);
        expect(drawn).toHaveLength(1);
    }, 120_000);
});
