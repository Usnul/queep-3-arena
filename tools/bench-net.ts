/*
 * bench-net.ts -- what a host frame costs, by how many people are in the match.
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
 * `NETWORK_PLAN.md` §7's third bullet, and the same shape as `bench-match.ts`:
 * no renderer, no browser, one number per configuration, printed rather than
 * asserted. The budget it is measured against is 2 ms mean for a full match.
 *
 * **It times `Host.step` alone**, not the rig's whole loop. The rig runs every
 * client's simulation in the same process, and those are the clients' own cost
 * on their own machines -- charging them to the host would make a dedicated
 * server look eight times more expensive than it is. The wrapper below is put
 * on the instance rather than measured from outside for exactly that reason.
 *
 * Run it with `npm run bench-net`.
 */

import { pathToFileURL } from 'node:url';

import { NetRig } from '../test/net/rig.ts';
import { FORWARDMOVE, RIGHTMOVE, type UserCmd } from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';
import type { RigClient } from '../test/net/rig.ts';

/** Frames measured per configuration, after a settling period. */
const FRAMES = 60 * 20;
const WARMUP = 120;

/** Everybody moving and shooting, which is what a host actually has to carry. */
function busy(cmd: UserCmd, frame: number, self: RigClient): void {
    const seed = self.net.slotIndex * 37;
    cmd.angles[1] = Math.round(((frame * 2 + seed) * 65536) / 360) & 65535;
    cmd.moves[FORWARDMOVE] = 96;
    cmd.moves[RIGHTMOVE] = Math.sin((frame + seed) / 70) * 80;
    if (frame % 8 < 4) cmd.buttons |= C.BUTTON_ATTACK;
}

interface Row {
    clients: number;
    bots: number;
    mean: number;
    p50: number;
    p99: number;
    worst: number;
}

async function run(map: string, clients: number, bots: number): Promise<Row> {
    const rig = await NetRig.create({ map, bots, clients, seed: 909, warmup: 40 });
    for (const client of rig.clients) client.script = busy;

    const host = rig.host as unknown as { step(): void };
    const original = host.step.bind(host);

    const samples: number[] = [];
    let measuring = false;

    host.step = (): void => {
        if (!measuring) {
            original();
            return;
        }
        const t0 = performance.now();
        original();
        samples.push(performance.now() - t0);
    };

    rig.step(WARMUP);
    measuring = true;
    rig.step(FRAMES);

    samples.sort((a, b) => a - b);

    return {
        clients,
        bots,
        mean: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
        p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
        p99: samples[Math.floor(samples.length * 0.99)] ?? 0,
        worst: samples[samples.length - 1] ?? 0,
    };
}

async function main(): Promise<void> {
    const map = process.argv[2] ?? 'oa_dm1';

    console.log(
        `host frame cost on ${map}, ${FRAMES / 60} s per row at 60 Hz, ` +
            'no renderer and no clients charged to it.\n'
    );
    console.log('  clients  bots     mean      p50      p99    worst');

    /*
     Up to six humans, because `oa_dm1` has seven spawn points and the host
     gives one to every bot as well. The trend across the rows is the answer
     the plan is after -- whether a slot costs a constant or something worse --
     and it is readable from four points.
    */
    const rows: Row[] = [];
    for (const [clients, bots] of [
        [0, 4],
        [2, 4],
        [4, 4],
        [6, 4],
    ] as const) {
        const row = await run(map, clients, bots);
        rows.push(row);
        console.log(
            `  ${String(row.clients).padStart(7)}  ${String(row.bots).padStart(4)}  ` +
                `${row.mean.toFixed(3).padStart(7)}  ${row.p50.toFixed(3).padStart(7)}  ` +
                `${row.p99.toFixed(3).padStart(7)}  ${row.worst.toFixed(3).padStart(7)}   ms`
        );
    }

    const full = rows[rows.length - 1]!;
    console.log('');
    console.log(
        `budget is 2.000 ms mean for a full match; measured ${full.mean.toFixed(3)} ms ` +
            `with ${full.clients} clients and ${full.bots} bots -- ` +
            (full.mean <= 2 ? 'met' : 'NOT MET')
    );

    const empty = rows[0]!;
    const perClient = (full.mean - empty.mean) / Math.max(1, full.clients);
    console.log(
        `each connected client adds about ${(perClient * 1000).toFixed(0)} us to a host frame`
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) await main();
