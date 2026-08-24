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
import { DecalSystem3 } from '@woosh/meep-engine/src/engine/graphics3/DecalSystem3.js';
import { ParticleEmitterSystem3 } from '@woosh/meep-engine/src/engine/graphics3/ParticleEmitterSystem3.js';
import { ImageBitmapAssetLoader } from '@woosh/meep-engine/src/engine/asset/loaders/image/ImageBitmapAssetLoader.js';
import { make_default_environment } from '@woosh/meep-engine/src/engine/graphics3/make_default_environment.js';
import { Camera } from '@woosh/meep-engine/src/engine/graphics/ecs/camera/Camera.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

import { BspFile } from '../q3/bsp/BspFile.ts';
import { ClipMap } from '../q3/cm/ClipMap.ts';
import { loadMap } from '../client/map/loadMap.ts';
import { loadModels } from '../client/map/loadModels.ts';
import { ItemsView } from '../client/ItemsView.ts';
import { ItemSystem, type DropTrace } from '../game/Items.ts';
import { boxTrace, createTrace } from '../q3/cm/trace.ts';
import { PlayerController } from '../client/PlayerController.ts';
import { FlyCamera } from '../client/FlyCamera.ts';
import { Hud } from '../client/Hud.ts';
import { Arena } from '../client/Arena.ts';
import { PhysicsWorld } from '../client/PhysicsWorld.ts';

/** Map to load; override with `?map=oa_dm5`. */
function requestedMap(): string {
    return new URLSearchParams(window.location.search).get('map') ?? 'oa_dm1';
}

/** `?fly=1` swaps the player for a noclip camera, for inspecting conversions. */
function flyMode(): boolean {
    return new URLSearchParams(window.location.search).get('fly') === '1';
}

/**
 * `?trace=clipmap` runs movement on the ported `cm_trace` instead of meep's
 * physics.
 *
 * Both backends ship. Physics is the default (D-029); the clipmap is bit-exact
 * against the C and is what the physics backend is measured against, so having
 * it a query parameter away makes an A/B comparison in the running game a
 * refresh rather than a rebuild.
 */
function useClipmapTrace(): boolean {
    return new URLSearchParams(window.location.search).get('trace') === 'clipmap';
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
    await em.addSystem(new DecalSystem3(graphics, engine.assetManager));
    await em.addSystem(new ParticleEmitterSystem3(graphics, engine.assetManager));

    /*
     Shade assumes global illumination: with no environment map every surface
     renders unlit, and "my geometry is black" reads as a material problem rather
     than a missing environment. See REPORT.md ergonomics.
    */
    graphics.set_environment_map(make_default_environment());

    EngineHarness.addFpsCounter(engine);

    const mapName = requestedMap();
    const baseUrl = `/assets/built/${mapName}`;

    const [loaded, clipMap, models] = await Promise.all([
        loadMap(ecd, baseUrl),
        loadClipMap(baseUrl, mapName),
        loadModels('/assets/built/models'),
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
            hud.update({
                mode: 'fly', speed: 0, onGround: false, map: mapName,
                weapon: '', damage: 0, kills: 0, backend: 'noclip',
                health: 0, armor: 0, ammo: -1, pickup: '', pickupAgeSeconds: 99,
            });
        });

        expose(engine, { loaded, clipMap, fly });
    } else {
        const clipmapOnly = useClipmapTrace();

        const physicsWorld = clipmapOnly
            ? null
            : await PhysicsWorld.create(em, ecd, clipMap);

        if (physicsWorld !== null) {
            console.log(
                `[queep] physics: ${physicsWorld.stats.brushes} brushes -> ` +
                `${physicsWorld.stats.bodies} static bodies ` +
                `(${physicsWorld.stats.hullMilliseconds.toFixed(0)} ms hulls, ` +
                `${physicsWorld.stats.bodyMilliseconds.toFixed(0)} ms bodies)`
            );
        }

        const player = new PlayerController(
            clipMap,
            canvas,
            spawn?._originQ3 ?? [0, 0, 0],
            physicsWorld
        );
        player.attach();

        const arena = new Arena(ecd, clipMap);

        /*
         Items drop to the floor through the same backend movement uses, so a
         pickup rests on the surface the player will actually stand on. Using
         the clipmap here regardless would be simpler and subtly wrong: with the
         physics backend the two disagree by up to the surface epsilon, which is
         enough to leave a shard visibly sunk into a ramp.
        */
        const dropTrace: DropTrace = (start, mins, maxs, end, mask) => {
            const out = createTrace();
            if (physicsWorld !== null) {
                physicsWorld.trace(out, start, end, mins, maxs, mask);
            } else {
                boxTrace(out, clipMap, start, end, mins, maxs, mask);
            }
            return out;
        };

        const items = new ItemSystem();
        items.spawn(loaded.bundle.entities, dropTrace);

        const itemsView = new ItemsView(ecd, models);
        itemsView.build(items.items);

        console.log(
            `[queep] items: ${itemsView.itemCount} placed, ${itemsView.pieceCount} pieces, ` +
            `${models.meshletMilliseconds.toFixed(0)} ms meshlets` +
            (items.rejected.length > 0 ? `
  rejected: ${items.rejected.join('; ')}` : '') +
            (itemsView.unmodelled.length > 0
                ? `
  no model: ${itemsView.unmodelled.join(', ')}`
                : '')
        );

        let pickupName = '';
        let pickupAge = 99;
        let secondAccumulator = 0;

        // Targets at the other spawn points: somewhere to shoot, without
        // inventing level geometry the map does not have.
        const spawnPoints = loaded.bundle.entities.filter(
            (e) => e.classname === 'info_player_deathmatch'
        );
        for (const s of spawnPoints.slice(1, 5)) {
            arena.addTarget(s._originQ3);
        }

        player.onFire = (eye, angles) => {
            arena.weapons.fire(player.weapon, eye, angles, 0, (Math.random() * 0xffff) | 0);
        };

        // `onTick` is documented as `Signal<number>` but is emitted as `any`, so
        // the callback parameter has no inferred type -- see GAP-001.
        engine.ticker.onTick.add((deltaSeconds: number) => {
            player.update(deltaSeconds, transform);
            arena.update(deltaSeconds);

            for (const event of items.update(
                deltaSeconds,
                player.ps.origin,
                player.inventory,
                true
            )) {
                pickupName = event.label;
                pickupAge = 0;
                if (event.selectWeapon !== null) {
                    player.selectWeapon(event.selectWeapon as typeof player.weapon);
                }
            }

            itemsView.update(items.now);
            pickupAge += deltaSeconds;

            /*
             `ClientTimerActions` runs on a 1000 ms cadence, not per frame. Health
             above max bleeds off one point a second; doing it per frame would
             drain a 200-health player in three seconds at 60 fps.
            */
            secondAccumulator += deltaSeconds;
            while (secondAccumulator >= 1) {
                secondAccumulator -= 1;
                ItemSystem.tickSecond(player.inventory);
            }

            hud.update({
                mode: player.active ? 'play' : 'click-to-play',
                speed: player.speed,
                onGround: player.onGround,
                map: mapName,
                weapon: player.weapon,
                damage: arena.totalDamage,
                kills: arena.kills,
                backend: clipmapOnly ? 'clipmap' : 'physics',
                health: player.inventory.health,
                armor: player.inventory.armor,
                ammo: player.inventory.ammo[player.weapon] ?? 0,
                pickup: pickupName,
                pickupAgeSeconds: pickupAge,
            });
        });

        expose(engine, { loaded, clipMap, player, arena, physicsWorld, items, models });
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
