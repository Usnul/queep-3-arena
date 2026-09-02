/*
 * random.ts -- the host's one source of chance.
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
 * `Math.random` has to leave the simulation, and the reason is not that a
 * networked game must be deterministic -- this one is server-authoritative, so
 * clients are told what happened rather than deriving it. The reason is that a
 * *test* has to be able to run the same match twice.
 *
 * A rollback replays the newest frame's inputs against a world the host has
 * already stepped, and a divergence between "what the host did" and "what the
 * host would do again" is exactly what the loopback test measures. With
 * `Math.random` in the loop the two runs differ for reasons that have nothing
 * to do with the netcode, and every measurement in `REPORT.md` becomes an
 * anecdote.
 *
 * mulberry32 rather than anything better: it is nine lines, it has no
 * dependencies, its period is 2^32 which is eleven hours of 60 Hz frames, and
 * the quality demanded of it is "a bot picks a different corridor" rather than
 * anything cryptographic. `Q_crandom` is untouched and still owns weapon spread
 * (D-026); this is what seeds it.
 */

/**
 * A seeded PRNG returning `[0, 1)`.
 *
 * @param seed any 32-bit integer; the same seed is the same match.
 */
export function mulberry32(seed: number): () => number {
    let state = seed | 0;

    return function next(): number {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
