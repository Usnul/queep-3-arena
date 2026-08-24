/*
 * Entry point: load a converted Q3 map and play it with real Q3 movement.
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

import { BspFile } from '../q3/bsp/BspFile.ts';
import { ClipMap } from '../q3/cm/ClipMap.ts';
import { loadMap } from '../client/map/loadMap.ts';
import { PlayerController } from '../client/PlayerController.ts';
import { FlyCamera } from '../client/FlyCamera.ts';
import { Hud } from '../client/Hud.ts';

/** Map to load; override with `?map=oa_dm5`. */
function requestedMap(): string {
    return new URLSearchParams(window.location.search).get('map') ?? 'oa_dm1';
}

/** `?fly=1` swaps the player for a noclip camera, for inspecting conversions. */
function flyMode(): boolean {
    return new URLSearchParams(window.location.search).get('fly') === '1';
}

async function main(): Promise<void> {
    const engine = await EngineHarness.bootstrap();

    const em = engine.entityManager;
    const ecd = em.dataset;
    const graphics = engine.graphics;

    if (graphics === null) throw new Error('engine started without graphics');

    // `EngineHarness.shadeScene` is the only way to reach the scene the harness's
    // own systems draw into -- the graphics facade does not hand one back, and a
    // system registered with a different Scene renders into nothing, silently.
    const scene = EngineHarness.shadeScene(engine);

    await em.addSystem(new ShadedGeometrySystem3(graphics, scene));
    await em.addSystem(new LightSystem3(graphics, scene));
    await em.addSystem(new CameraSystem3(graphics));

    /*
     Shade assumes global illumination: with no environment map every surface
     renders unlit, and "my geometry is black" reads as a material problem rather
     than a missing environment. See REPORT.md ergonomics.
    */
    graphics.set_environment_map(make_default_environment());

    EngineHarness.addFpsCounter(engine);

    const mapName = requestedMap();
    const baseUrl = `/assets/built/${mapName}`;

    const [loaded, clipMap] = await Promise.all([
        loadMap(ecd, baseUrl),
        loadClipMap(baseUrl, mapName),
    ]);

    const spawn =
        loaded.bundle.entities.find((e) => e.classname === 'info_player_deathmatch') ??
        loaded.bundle.entities.find((e) => e.classname === 'info_player_start') ??
        null;

    const camera = new Camera();
    camera.active.set(true);
    camera.autoClip = false;
    // Scene is metres (DECISIONS.md D-011). A Q3 arena is ~50 m across.
    camera.clip_near = 0.1;
    camera.clip_far = 600;
    camera.fov.set(90);

    const transform = new Transform();
    const cameraEntity = new Entity();
    cameraEntity.add(transform).add(camera).build(ecd);

    const canvas = graphics.domElement as HTMLElement;
    const hud = new Hud();
    hud.link(engine.viewStack);

    if (flyMode()) {
        transform.position.set(
            spawn?._origin[0] ?? 0,
            (spawn?._origin[1] ?? 0) + 0.8,
            spawn?._origin[2] ?? 0
        );

        const fly = new FlyCamera(transform, canvas);
        fly.attach();
        engine.ticker.onTick.add((dt: number) => {
            fly.update(dt);
            hud.update({ mode: 'fly', speed: 0, onGround: false, map: mapName });
        });

        expose(engine, { loaded, clipMap, fly });
    } else {
        const player = new PlayerController(
            clipMap,
            canvas,
            spawn?._originQ3 ?? [0, 0, 0]
        );
        player.attach();

        // `onTick` is documented as `Signal<number>` but is emitted as `any`, so
        // the callback parameter has no inferred type -- see GAP-001.
        engine.ticker.onTick.add((deltaSeconds: number) => {
            player.update(deltaSeconds, transform);
            hud.update({
                mode: player.active ? 'play' : 'click-to-play',
                speed: player.speed,
                onGround: player.onGround,
                map: mapName,
            });
        });

        expose(engine, { loaded, clipMap, player });
    }

    console.log(
        `[queep] ${mapName}: ${loaded.bundle.stats['triangles']} tris, ` +
        `${loaded.bundle.lights.length} lights, ${clipMap.numBrushes} brushes` +
        (clipMap.numPatches > 0
            ? ` (WARNING: ${clipMap.numPatches} patches -- curved surfaces are not solid, see D-017)`
            : ''),
        loaded.timings
    );
}

/**
 * The collision model comes from the BSP itself rather than a converted format,
 * so the runtime and the pmove oracle read the same bytes. A second
 * representation would be a second thing that can disagree with `cm_trace.c`.
 */
async function loadClipMap(baseUrl: string, name: string): Promise<ClipMap> {
    const response = await fetch(`${baseUrl}/collision.bsp`);
    if (!response.ok) {
        throw new Error(`${baseUrl}/collision.bsp: HTTP ${response.status}`);
    }
    return new ClipMap(new BspFile(await response.arrayBuffer(), name));
}

function expose(engine: unknown, extra: Record<string, unknown>): void {
    Object.assign(window as unknown as Record<string, unknown>, {
        queep: { engine, ...extra },
    });
}

main().catch((e: unknown) => {
    console.error('[queep] failed to start', e);
    document.body.innerHTML =
        `<pre style="color:#f66;font:14px monospace;padding:2rem;white-space:pre-wrap">` +
        `queep-3-arena failed to start\n\n${String(e instanceof Error ? e.stack : e)}</pre>`;
});
