/*
 * random.ts -- the host's one source of chance, which is the engine's.
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
 * server-authoritative game needs determinism -- clients are told what happened
 * rather than deriving it. The reason is that a *test* has to be able to run the
 * same match twice: with `Math.random` in the loop every measurement in D-170,
 * D-171 and D-172 is an anecdote, and an assertion about a bot firing a rocket
 * is a coin toss.
 *
 * **This file first contained a hand-written mulberry32, and that was the
 * mistake this repository exists to find.** meep ships
 * `core/math/random/seededRandom.js`, which is `seededRandom_Mulberry32`, which
 * is the same algorithm to the line -- the same `0x6D2B79F5` increment, the same
 * three `Math.imul` rounds, the same `>>> 14` and the same divisor. Nineteen
 * lines re-derived from memory instead of `ls`ing a directory whose name is
 * `random`. The port's whole priority order is "exercise meep well first"
 * (D-110) and the first thing a hand-rolled PRNG does is exercise nothing.
 *
 * The engine's version is also **better than what it replaced**, and in a way
 * that matters here rather than in general: `setCurrentSeed` / `getCurrentSeed`
 * make the generator's position readable and restorable, which is exactly what a
 * rollback wants. The host does not need it yet -- the world step runs once per
 * frame behind the newest-frame gate (GAP-039), so no draw is ever replayed --
 * but the day a draw has to happen inside a replayed frame, the state to save
 * and restore is one number and the engine already exposes it.
 *
 * So what is left here is an adapter and its reason, which is the `.d.ts`:
 * `seededRandom`'s JSDoc `@returns` uses `|` where it means `&`, so the
 * generated type is a union of "a function" and "an object with two methods",
 * and TypeScript refuses to call it -- `TS2349: not all constituents of type
 * ... are callable`. One cast, once, with the finding attached. See REPORT.md
 * section 4.
 */

import { seededRandom } from '@woosh/meep-engine/src/core/math/random/seededRandom.js';

/**
 * A seeded generator returning `[0, 1)`, whose position can be read and written.
 *
 * The shape the engine's function actually returns, as opposed to the shape its
 * declaration describes.
 */
export interface SeededRandom {
    (): number;
    setCurrentSeed(value: number): void;
    getCurrentSeed(): number;
}

/**
 * meep's `seededRandom`, callable.
 *
 * @param seed any 32-bit integer; the same seed is the same match.
 */
export function makeRandom(seed: number): SeededRandom {
    return seededRandom(seed) as unknown as SeededRandom;
}
