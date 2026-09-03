/*
 * ScoreboardView.ts -- the table `scoreboard.ts` decided the order of.
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
 * `CG_DrawScoreboard`, on the DOM, and thin on purpose.
 *
 * Everything that could be got wrong -- who is first, how a tie ranks, what a
 * nameless slot shows -- is in `scoreboard.ts` and is tested there. What is
 * here is the part that only a browser can be wrong about, so it holds no
 * arithmetic and makes no decisions: one row element per slot, reused, written
 * only when the numbers change.
 *
 * **Networked only, and that is not a limitation.** Single-player already draws
 * kills and deaths in the status bar, because there is one other kind of player
 * and it is a bot. A scoreboard answers "where am I in a field of eight", which
 * is a question a match has and a training level does not.
 */

import { EmptyView, type ViewWithElement } from './ui/meep.ts';
import { displayName, type ScoreboardRow } from './scoreboard.ts';

/** One row's elements, so a frame that changes one number writes one node. */
interface Row {
    readonly root: ViewWithElement<HTMLElement>;
    readonly place: ViewWithElement<HTMLElement>;
    readonly name: ViewWithElement<HTMLElement>;
    readonly kills: ViewWithElement<HTMLElement>;
    readonly deaths: ViewWithElement<HTMLElement>;
    /** What this row last drew, so an unchanged row touches no DOM. */
    signature: string;
    /** Whether the row currently carries the local-player modifier. */
    local: boolean;
}

const BLOCK = 'queep-scoreboard';

export class ScoreboardView {
    readonly root: ViewWithElement<HTMLElement>;

    private readonly body: ViewWithElement<HTMLElement>;

    /** One row per slot index, built the first time that slot appears. */
    private readonly rows = new Map<number, Row>();

    /** Which slots the last update drew, so the rest can be hidden. */
    private shown: number[] = [];

    constructor() {
        /*
         `role="table"` and friends written by hand, because these are `div`s.
         A real `<table>` would be the better markup and the UI kit builds
         elements from a tag name and a class list; the roles are what make the
         divs mean the same thing to a screen reader.
        */
        this.body = new EmptyView({
            classList: [`${BLOCK}__body`],
            tag: 'div',
            attr: { role: 'rowgroup' },
        });

        const header = EmptyView.group(
            [
                cell('place', '#'),
                cell('name', 'player'),
                cell('kills', 'frags'),
                cell('deaths', 'deaths'),
            ],
            {
                classList: [`${BLOCK}__row`, `${BLOCK}__row--header`],
                tag: 'div',
                attr: { role: 'row' },
            }
        );

        const headGroup = EmptyView.group([header], {
            classList: [`${BLOCK}__head`],
            tag: 'div',
            attr: { role: 'rowgroup' },
        });

        /*
         `aria-hidden` while it is closed rather than only `display: none`: the
         board is toggled by a key held down, and a table that is announced
         while invisible is a table read out over the top of a firefight.
        */
        this.root = EmptyView.group([headGroup, this.body], {
            classList: [BLOCK],
            tag: 'div',
            attr: { role: 'table', 'aria-label': 'scoreboard', 'aria-hidden': 'true' },
        });
        this.root.visible = false;
    }

    /** Show or hide the board. Q3 binds this to a key you hold. */
    setVisible(visible: boolean): void {
        if (this.root.visible === visible) return;
        this.root.visible = visible;
        this.root.el.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    get visible(): boolean {
        return this.root.visible;
    }

    /**
     * Draw `rows`, which are already in order.
     *
     * Rows are kept per slot and hidden rather than destroyed, so a player who
     * leaves and rejoins gets their element back instead of a new one, and a
     * board that is open while somebody disconnects does not reflow the whole
     * table.
     */
    update(rows: readonly ScoreboardRow[]): void {
        for (const slot of this.shown) {
            const row = this.rows.get(slot);
            if (row !== undefined) row.root.visible = false;
        }

        this.shown = [];

        for (let i = 0; i < rows.length; i++) {
            const data = rows[i]!;
            const row = this.rowFor(data.slot);

            row.root.visible = true;
            this.shown.push(data.slot);

            /*
             The row's place in the DOM has to follow its place in the table,
             and the two are different orderings: the map is keyed by slot so a
             row survives a disconnect, while the table is sorted by score. So
             each visible row is re-appended in rank order, which for a
             sixteen-row table is cheaper than reasoning about which pairs
             swapped.
            */
            this.body.el.appendChild(row.root.el);

            const name = displayName(data);
            const signature = `${data.rank}|${name}|${data.kills}|${data.deaths}|${data.isBot}`;
            if (signature !== row.signature) {
                row.signature = signature;
                row.place.el.textContent = String(data.rank);
                row.name.el.textContent = data.isBot ? `${name} (bot)` : name;
                row.kills.el.textContent = String(data.kills);
                row.deaths.el.textContent = String(data.deaths);
            }

            if (data.isLocal !== row.local) {
                row.local = data.isLocal;
                row.root.el.classList.toggle(`${BLOCK}__row--self`, data.isLocal);
            }
        }
    }

    private rowFor(slot: number): Row {
        const existing = this.rows.get(slot);
        if (existing !== undefined) return existing;

        const place = cell('place', '');
        const name = cell('name', '');
        const kills = cell('kills', '');
        const deaths = cell('deaths', '');

        const root = EmptyView.group([place, name, kills, deaths], {
            classList: [`${BLOCK}__row`],
            tag: 'div',
            attr: { role: 'row' },
        });

        const row: Row = { root, place, name, kills, deaths, signature: '', local: false };
        this.rows.set(slot, row);
        this.body.addChild(root);

        return row;
    }
}

function cell(kind: string, text: string): ViewWithElement<HTMLElement> {
    const view = new EmptyView({
        classList: [`${BLOCK}__cell`, `${BLOCK}__cell--${kind}`],
        tag: 'div',
        attr: { role: 'cell' },
    });
    if (text !== '') view.el.textContent = text;
    return view;
}

