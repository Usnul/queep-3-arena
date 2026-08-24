/*
 * Phase 1 entry point: load a converted Q3 map and fly through it.
 *
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 */

import { EngineHarness } from '@woosh/meep-engine/src/engine/EngineHarness.js';
import { ShadedGeometrySystem3 } from '@woosh/meep-engine/src/engine/graphics3/ShadedGeometrySystem3.js';
import { LightSystem3 } from '@woosh/meep-engine/src/engine/graphics3/LightSystem3.js';
import { CameraSystem3 } from '@woosh/meep-engine/src/engine/graphics3/CameraSystem3.js';
import { make_default_environment } from '@woosh/meep-engine/src/engine/graphics3/make_default_environment.js';
import { Camera } from '@woosh/meep-engine/src/engine/graphics/ecs/camera/Camera.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

import { loadMap } from '../client/map/loadMap.ts';
import { FlyCamera } from '../client/FlyCamera.ts';

/** Map to load; override with `?map=oa_dm5`. */
function requestedMap(): string {
    const p = new URLSearchParams(window.location.search);
    return p.get('map') ?? 'oa_dm1';
}

async function main(): Promise<void> {
    const engine = await EngineHarness.bootstrap();

    const em = engine.entityManager;
    const ecd = em.dataset;
    const graphics = engine.graphics;

    if (graphics === null) {
        throw new Error('engine started without graphics');
    }

    // `EngineHarness.shadeScene` is the only way to reach the scene the harness's
    // own systems draw into -- the graphics facade does not hand one back. Any
    // system registered with a *different* Scene renders into nothing, silently.
    const scene = EngineHarness.shadeScene(engine);

    await em.addSystem(new ShadedGeometrySystem3(graphics, scene));
    await em.addSystem(new LightSystem3(graphics, scene));
    await em.addSystem(new CameraSystem3(graphics));

    /*
     Shade assumes global illumination: with no environment map, every surface
     renders unlit and the level is a black void with a few emissive panels in
     it. `make_default_environment` says so in its own docblock, but nothing warns
     at runtime, and "my geometry is black" reads as a material problem rather
     than a missing environment. Cost about 25 minutes -- see REPORT.md ergonomics.

     The default is an outdoor sky, which is the wrong *look* for a Q3 arena but
     the right *function*: it is the ambient term, and Q3's own lighting comes
     from the emissive surfaces and point lights the pipeline reconstructs.
    */
    graphics.set_environment_map(make_default_environment());

    EngineHarness.addFpsCounter(engine);

    const mapName = requestedMap();
    const loaded = await loadMap(ecd, `/assets/built/${mapName}`);

    // Spawn the camera at a real player spawn point so the first frame shows the
    // level rather than the inside of a wall.
    const spawn =
        loaded.bundle.entities.find((e) => e.classname === 'info_player_deathmatch') ??
        loaded.bundle.entities.find((e) => e.classname === 'info_player_start') ??
        null;

    const camera = new Camera();
    camera.active.set(true);
    camera.autoClip = false;
    // Scene is in metres (DECISIONS.md D-011). A Q3 arena is ~50 m across, so
    // 600 m of far plane covers the largest OA map with room to spare.
    camera.clip_near = 0.1;
    camera.clip_far = 600;
    camera.fov.set(90);

    const transform = new Transform();
    if (spawn !== null) {
        // Q3 spawn origins sit at the player's centre; +0.8 m puts the camera at
        // roughly eye height above it.
        transform.position.set(
            spawn._origin[0] ?? 0,
            (spawn._origin[1] ?? 0) + 0.8,
            spawn._origin[2] ?? 0
        );
    } else {
        transform.position.set(0, 6, 0);
    }

    const cameraEntity = new Entity();
    cameraEntity.add(transform).add(camera).build(ecd);

    const fly = new FlyCamera(transform, graphics.domElement as HTMLElement);
    fly.attach();
    // `onTick` is documented as `Signal<number>` but is emitted as `any` in the
    // published types, so the callback parameter has no inferred type. Annotating
    // it locally rather than reaching for `any` -- see GAP-001.
    engine.ticker.onTick.add((deltaSeconds: number) => fly.update(deltaSeconds));

    Object.assign(window as unknown as Record<string, unknown>, {
        queep: { engine, loaded, fly },
    });

    console.log(
        `[queep] ${mapName}: ${loaded.bundle.stats['meshes']} meshes, ` +
        `${loaded.bundle.stats['triangles']} tris, ${loaded.bundle.lights.length} lights`,
        loaded.timings
    );
}

main().catch((e: unknown) => {
    console.error('[queep] failed to start', e);
    document.body.innerHTML =
        `<pre style="color:#f66;font:14px monospace;padding:2rem;white-space:pre-wrap">` +
        `queep-3-arena failed to start\n\n${String(e instanceof Error ? e.stack : e)}</pre>`;
});
