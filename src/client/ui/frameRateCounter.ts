/*
 * frameRateCounter.ts -- the `stats.js` panel, with a handle to turn it off by.
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
 * Four lines in a file of their own, so that `graphics.ts` stays a description
 * of settings rather than a module that boots half the engine on import.
 * `EngineHarness` reaches the graphics stack, the asset system and the terrain
 * builder; the settings page has to be constructible in a test, and this is the
 * one thing on it that could not be.
 */

import { EngineHarness } from '@woosh/meep-engine/src/engine/EngineHarness.js';

import type { View } from './meep.ts';

/**
 * Add the `stats.js` panel and hand back the view it went into.
 *
 * `EngineHarness.addFpsCounter` builds an `EmptyView` around `stats.domElement`,
 * adds it to the view stack and returns `undefined`, so there is no handle to
 * turn it off with. Taking the child it just appended is the smallest thing that
 * gets one, and it is checked rather than assumed: if the helper ever adds two
 * views, or none, this returns `null` and the setting greys out instead of
 * throwing. GAP-028.
 */
export function addFrameRateCounter(engine: {
    viewStack: { children: readonly View[] };
}): View | null {
    const before = engine.viewStack.children.length;

    EngineHarness.addFpsCounter(engine as never);

    const added = engine.viewStack.children.length - before;
    if (added !== 1) {
        console.warn(`[queep] addFpsCounter added ${added} views; frame-rate counter not bound`);
        return null;
    }

    return engine.viewStack.children[before] ?? null;
}
