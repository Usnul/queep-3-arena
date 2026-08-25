/*
 * physics-wedge.test.ts -- no invisible obstacles.
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
 * The reported symptom was a spot where the player could not move left or right
 * and could only creep forwards and back along an invisible line. That is what
 * `PM_SlideMove` does when it is handed two contradictory contact planes: it
 * clips velocity against the first, achieves nothing, retries, accumulates the
 * second, and projects the result onto the line where they meet. Three planes
 * and it stops entirely.
 *
 * The divergence harness never saw it, because it measures *displacement* along
 * scripted input and a wedge is a place you have to already be standing. So this
 * asks the question directly and geometrically: at every standing position on
 * the map, can the player leave?
 *
 * The clipmap is the control. A spot the clipmap says is open in every direction
 * and the physics says is closed in every direction is a wedge, and there must
 * be none. Genuinely enclosed spots -- the inside of a pillar the floor sampler
 * found, an alcove one box wide -- are counted separately and not judged, since
 * the clipmap agrees they are enclosed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { buildWaypoints, type TraceLike } from '../src/game/Waypoints.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';

/** Q3's standing player box. */
const MINS = [-15, -15, -24];
const MAXS = [15, 15, 32];

/** One stride, which is far enough to be blocked by anything real. */
const PROBE = 32;

const DIRECTIONS: [number, number][] = [];
for (let i = 0; i < 8; i++) {
    DIRECTIONS.push([Math.cos((i * Math.PI) / 4) * PROBE, Math.sin((i * Math.PI) / 4) * PROBE]);
}

interface Scan {
    readonly sampled: number;
    readonly wedges: number;
    readonly enclosed: number;
    readonly worst: string[];
}

function scan(mapName: string): Scan {
    const built = join(process.cwd(), 'assets', 'built', mapName);
    const raw = readFileSync(join(built, 'collision.bsp'));
    const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
        submodels: { minsQ3: number[]; maxsQ3: number[] }[];
    };

    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );

    const trace: TraceLike = (start, mins, maxs, end, mask) => {
        const out = createTrace();
        boxTrace(out, cm, start, end, mins, maxs, mask);
        return out;
    };

    /*
     The floor sampler already knows how to find every place a player can stand,
     so it doubles as the sample set. It traces the same collision the player
     moves through, which is the point.
    */
    const graph = buildWaypoints(scene.submodels[0]!, trace);
    const physics = new HeadlessPhysics(cm);

    const clip = createTrace();
    const phys = createTrace();

    let wedges = 0;
    let enclosed = 0;
    const worst: string[] = [];

    for (const node of graph.nodes) {
        const o = node.origin;

        let blockedClip = 0;
        let blockedPhysics = 0;

        for (const [dx, dy] of DIRECTIONS) {
            const end = [o[0] + dx, o[1] + dy, o[2]];

            boxTrace(clip, cm, o, end, MINS, MAXS, MASK_PLAYERSOLID);
            physics.trace(phys, o, end, MINS, MAXS, MASK_PLAYERSOLID);

            if (clip.fraction < 0.99) blockedClip += 1;
            if (phys.fraction < 0.99) blockedPhysics += 1;
        }

        if (blockedClip >= 6) {
            enclosed += 1;
            continue;
        }

        if (blockedClip <= 2 && blockedPhysics >= 6) {
            wedges += 1;
            if (worst.length < 5) {
                worst.push(
                    `${o.map((v) => v.toFixed(0)).join(',')}: ` +
                    `clipmap blocks ${blockedClip}/8, physics blocks ${blockedPhysics}/8`
                );
            }
        }
    }

    return { sampled: graph.nodes.length, wedges, enclosed, worst };
}

describe.each(['oa_dm1', 'aggressor'])('physics wedges [%s]', (name) => {
    const built = existsSync(join(process.cwd(), 'assets', 'built', name, 'collision.bsp'));

    it.skipIf(!built)('leaves no spot the player cannot walk out of', () => {
        const result = scan(name);

        expect(result.sampled).toBeGreaterThan(200);

        expect(
            result.wedges,
            `${result.wedges} of ${result.sampled} standing positions are wedged ` +
            `(${result.enclosed} genuinely enclosed, which is fine)` +
            (result.worst.length > 0 ? `\n  ${result.worst.join('\n  ')}` : '')
        ).toBe(0);
    });
});
