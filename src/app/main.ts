/*
 * Phase 0 entry point: boot meep and draw a frame.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { EngineHarness } from '@woosh/meep-engine/src/engine/EngineHarness.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

async function main(): Promise<void> {
    const engine = await EngineHarness.bootstrap();

    await EngineHarness.buildBasics({
        engine,
        focus: new Vector3(0, 0, 0),
        distance: 24,
        pitch: 0.6,
        enableTerrain: true,
        enableWater: false,
        showFps: true,
    });

    // Proof the port's own code is running against a live engine, not just that
    // the harness booted.
    console.log('[queep] engine started', {
        graphics: engine.graphics !== null,
        sound: engine.sound !== null,
    });
}

main().catch((e: unknown) => {
    console.error('[queep] failed to start', e);
    document.body.innerHTML =
        `<pre style="color:#f66;font:14px monospace;padding:2rem;white-space:pre-wrap">` +
        `queep-3-arena failed to start\n\n${String(e instanceof Error ? e.stack : e)}</pre>`;
});
