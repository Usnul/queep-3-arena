/*
 * bake-audio.ts -- measure how each map sounds, once, offline.
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
 * meep's `bakeProbeField` covers a level's air with acoustic probes -- sparse
 * in open halls, dense where the geometry is, never inside a solid -- and casts
 * rays from each one to measure the reverberation there as a per-band RT60. The
 * result is the thing `ProbeReverbRenderer` reads at the listener each frame,
 * so a room that should ring rings and a corridor that should not does not.
 *
 * It runs here rather than at load for the reason every bake does: it is
 * minutes of raycasting against a signed distance field, and none of it depends
 * on the run. Loading it back is a `Float32Array` per probe.
 *
 * What comes out is deliberately less than what goes in. `bakeProbeField` also
 * produces a probe *visibility graph* and per-probe reflector lobes, which are
 * what corner-leak pathing routes a sound around a corner with, and meep's
 * serializer carries neither -- both are functions of the geometry rather than
 * of the probes, so re-deriving them at load costs what the bake costs. This
 * port does not enable pathing (see `configureAcoustics` in `src/app/main.ts`),
 * so the file holds exactly what the runtime reads: probe positions, per-band
 * RT60, and the per-band arrival direction.
 *
 * The geometry is not this tool's: `buildOccluderScene` is the same brush ->
 * hull -> `ConvexHullShape3D` conversion `PhysicsWorld` builds its bodies from.
 * A reverberation measured in a room the runtime does not have is wrong in a
 * way nothing reports, and this project has been bitten by exactly that class
 * of divergence before -- see D-036.
 *
 * Usage:  node tools/bake-audio.ts [<mapname>...]     (default: every built map)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { seededRandom } from '@woosh/meep-engine/src/core/math/random/seededRandom.js';
import { bakeProbeField } from '@woosh/meep-engine/src/engine/sound/simulation/probe/bakeProbeField.js';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import {
    PROBE_FILE,
    PROBE_MAX_RT60,
    PROBE_RAYS,
    PROBE_SEED,
    PROBE_SPACING,
    buildOccluderScene,
    decodeProbeField,
    encodeProbeField,
} from '../src/client/Acoustics.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = join(ROOT, 'assets', 'built');

/** Built directories that are not maps. */
const NOT_A_MAP = new Set(['characters', 'fx', 'models', 'sound']);

interface BakeReport {
    readonly map: string;
    readonly bodies: number;
    readonly probes: number;
    readonly bytes: number;
    readonly milliseconds: number;
    /** The mid band's RT60 across the field, as `[min, mean, max]`. */
    readonly midRt60: readonly [number, number, number];
    /**
     * The longest RT60 over every probe and every band, before clamping.
     *
     * Reported apart from the mid band because it is the one that costs:
     * `reverbImpulseResponse` sizes its buffer from `max(low, mid, high)`, and
     * the low band runs the longest of the three -- `oa_dm1` measures 2.58 s in
     * the mid band and 3.75 s in the low at the same spot. A summary quoting
     * only the mid band understates the impulse response by half.
     */
    readonly longestBand: number;
    /** Probes with at least one band held down to `PROBE_MAX_RT60`. */
    readonly clamped: number;
}

function bakeMap(name: string): BakeReport | null {
    const dir = join(BUILT, name);
    const bspPath = join(dir, 'collision.bsp');

    if (!existsSync(bspPath)) {
        console.error(`  ${name}: no collision.bsp -- run \`node tools/convert-map.ts ${name}\` first`);
        return null;
    }

    const raw = readFileSync(bspPath);
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), name)
    );

    const scene = buildOccluderScene(cm);

    if (scene.stats.bodies === 0) {
        /*
         `bakeProbeField` answers an empty index with an empty field rather than
         an error -- the bake region is derived from the occluder hull, and
         there is no hull. Writing that would ship a file that silences the
         reverb without saying why, so say why instead.
        */
        console.error(`  ${name}: no solid brushes -- nothing to bake against`);
        return null;
    }

    const t0 = performance.now();

    /*
     `seededRandom`, corrected. Its generated declaration returns
     `(() => number) | {setCurrentSeed, getCurrentSeed}` -- a union of the
     function and the two properties hung off it -- where the runtime returns
     one value that is both. `bakeProbeField` wants the callable half, so the
     union makes the only sensible call site a type error. Same class of
     declaration bug as GAP-013.
    */
    const random = seededRandom(PROBE_SEED) as () => number;

    const field = bakeProbeField(scene.index, PROBE_SPACING, PROBE_RAYS, random);

    const milliseconds = performance.now() - t0;

    /*
     Hold the measurement down to what the runtime can afford to render and what
     the game can afford to hear. Applied here rather than at load so the file
     holds what is actually played -- a clamp on one side of a serializer and
     not the other is the sort of thing that makes a bake unreproducible -- and
     reported, because a map being reshaped by a ceiling should say so rather
     than quietly come out flatter than it is. See `PROBE_MAX_RT60`.
    */
    let clamped = 0;
    let longestBand = 0;

    for (let i = 0; i < field.size; i++) {
        const low = field.reverbBand(i, 0);
        const mid = field.reverbBand(i, 1);
        const high = field.reverbBand(i, 2);

        longestBand = Math.max(longestBand, low, mid, high);

        if (low <= PROBE_MAX_RT60 && mid <= PROBE_MAX_RT60 && high <= PROBE_MAX_RT60) continue;

        field.setProbeReverbDecay(
            i,
            Math.min(low, PROBE_MAX_RT60),
            Math.min(mid, PROBE_MAX_RT60),
            Math.min(high, PROBE_MAX_RT60)
        );

        clamped += 1;
    }

    const bytes = encodeProbeField(field);
    writeFileSync(join(dir, PROBE_FILE), bytes);

    /*
     Read the file back and check it against the field in memory, rather than
     trusting that a serializer and its deserializer agree. They are meep's, not
     this port's, but the failure they can have is silent in exactly the way
     that matters: a field that loads with the right probe count and the wrong
     numbers produces reverb that is merely *wrong*, and nothing downstream can
     tell that from a room that really is that dead.
    */
    const reloaded = decodeProbeField(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );

    if (reloaded.size !== field.size) {
        throw new Error(
            `${name}: round-trip lost probes -- baked ${field.size}, read back ${reloaded.size}`
        );
    }

    let low = Infinity;
    let high = -Infinity;
    let sum = 0;

    for (let i = 0; i < field.size; i++) {
        for (let band = 0; band < 3; band++) {
            if (reloaded.reverbBand(i, band) !== field.reverbBand(i, band)) {
                throw new Error(
                    `${name}: round-trip changed probe ${i} band ${band} -- ` +
                    `${field.reverbBand(i, band)} became ${reloaded.reverbBand(i, band)}`
                );
            }
        }

        const mid = field.reverbBand(i, 1);
        if (mid < low) low = mid;
        if (mid > high) high = mid;
        sum += mid;
    }

    const mean = field.size === 0 ? 0 : sum / field.size;

    return {
        map: name,
        bodies: scene.stats.bodies,
        probes: field.size,
        bytes: bytes.byteLength,
        milliseconds,
        midRt60: [low === Infinity ? 0 : low, mean, high === -Infinity ? 0 : high],
        longestBand,
        clamped,
    };
}

function builtMaps(): string[] {
    if (!existsSync(BUILT)) return [];

    return readdirSync(BUILT).filter(
        (d) =>
            !NOT_A_MAP.has(d) &&
            statSync(join(BUILT, d)).isDirectory() &&
            existsSync(join(BUILT, d, 'collision.bsp'))
    );
}

async function main(): Promise<void> {
    const requested = process.argv.slice(2);
    const maps = requested.length > 0 ? requested : builtMaps();

    if (maps.length === 0) {
        console.error('no built maps found; usage: node tools/bake-audio.ts [<mapname>...]');
        process.exit(2);
    }

    console.log(
        `baking acoustic probes: spacing ${PROBE_SPACING} m, ${PROBE_RAYS} rays/probe, seed ${PROBE_SEED}`
    );

    let failed = 0;

    for (const name of maps) {
        console.log(`${name}...`);

        const report = bakeMap(name);

        if (report === null) {
            failed += 1;
            continue;
        }

        console.log(
            `  ${report.bodies} occluders -> ${report.probes} probes, ` +
            `${(report.bytes / 1024).toFixed(1)} KB, ${(report.milliseconds / 1000).toFixed(1)} s` +
            `\n  mid-band RT60 ${report.midRt60[0].toFixed(2)}-${report.midRt60[2].toFixed(2)} s ` +
            `(mean ${report.midRt60[1].toFixed(2)} s), ` +
            `longest of any band ${report.longestBand.toFixed(2)} s` +
            (report.clamped > 0
                ? `\n  ${report.clamped} probes held down to ${PROBE_MAX_RT60} s`
                : '')
        );
    }

    if (failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
