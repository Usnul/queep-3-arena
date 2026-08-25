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
import { MeshSystem3 } from '@woosh/meep-engine/src/engine/graphics3/MeshSystem3.js';
import { AnimationSystem3 } from '@woosh/meep-engine/src/engine/graphics3/AnimationSystem3.js';
import { GLTFSceneBundleAssetLoader } from '@woosh/meep-engine/src/engine/asset/loaders/GLTFSceneBundleAssetLoader.js';
import { GameAssetType } from '@woosh/meep-engine/src/engine/asset/GameAssetType.js';
import { load_model_scene_bundle } from '@woosh/meep-engine/src/engine/asset/load_model_scene_bundle.js';
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
import { ItemSystem, newInventory, type DropTrace } from '../game/Items.ts';
import { MoverSystem, type Vec3 } from '../game/Movers.ts';
import { WorldEffects } from '../game/WorldEffects.ts';
import type { Damageable } from '../game/Weapons.ts';
import { vec3 as q3vec3 } from '../q3/math.ts';
import { MoversView } from '../client/MoversView.ts';
import { Character, CHARACTERS } from '../client/Characters.ts';
import { AudioBank, Footsteps, LOOP_BUDGET } from '../client/Audio.ts';
import { MapSound } from '../client/MapSound.ts';
import { Bot } from '../game/Bot.ts';
import { BotRuntime, type BotWorld } from '../client/Bots.ts';
import { buildWaypoints, linkMapPortals } from '../game/Waypoints.ts';
import { spawnPoints } from '../game/Spawns.ts';
import { AudioEmitterSystem } from '@woosh/meep-engine/src/engine/sound/ecs/audio/AudioEmitterSystem.js';
import SoundListener from '@woosh/meep-engine/src/engine/sound/ecs/SoundListener.js';
import { boxTrace, createTrace } from '../q3/cm/trace.ts';
import { PlayerController } from '../client/PlayerController.ts';
import { FlyCamera } from '../client/FlyCamera.ts';
import { CROSSHAIR_DEFAULT, Hud } from '../client/Hud.ts';
import { ViewWeapon } from '../client/ViewWeapon.ts';
import { Arena } from '../client/Arena.ts';
import { PhysicsWorld } from '../client/PhysicsWorld.ts';

/** Map to load; override with `?map=oa_dm5`. */
function requestedMap(): string {
    return new URLSearchParams(window.location.search).get('map') ?? 'oa_dm1';
}

/**
 * `?crosshair=N` picks one of Q3's ten, exactly as `cg_drawCrosshair` does.
 *
 * Defaults to Q3's own default, which is a dot rather than the cross most
 * people picture. All ten convert, so disagreeing with id about that is a
 * query parameter rather than a rebuild.
 */
function requestedCrosshair(): number {
    const raw = new URLSearchParams(window.location.search).get('crosshair');
    if (raw === null) return CROSSHAIR_DEFAULT;

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : CROSSHAIR_DEFAULT;
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

/**
 * `?move=q3` runs the ported `bg_pmove.c` whole -- slide-move, ground trace and
 * all -- instead of Q3's motor on meep's `KinematicMover`.
 *
 * The meep-native path is the default (D-071): the brief's "movement fidelity is
 * non-negotiable" was reversed in favour of porting Q3 in spirit rather than in
 * body, and reproducing Q3's contact semantics through a general-purpose sweep
 * was what made that expensive. The ported path stays because it is bit-exact
 * against the C and is therefore the reference any claim about the new one is
 * measured against.
 *
 * Forced on when `?trace=clipmap` is set, since that selects the ported
 * collision backend and there is nothing for the kinematic mover to run on.
 */
function usePortedPmove(): boolean {
    const move = new URLSearchParams(window.location.search).get('move');
    return move === 'q3' || useClipmapTrace();
}

/**
 * Run one phase of the frame, and do not let it take the rest of the frame with it.
 *
 * meep's `Signal.dispatch` wraps every handler in `try { ... } catch (e) {
 * console.error("Failed to dispatch handler", _f, e) }`. That is a reasonable
 * thing for a signal to do -- one bad listener should not stop the others -- but
 * this application is *one* listener holding the whole frame, so a throw anywhere
 * in it silently deletes everything below the throw, every frame, for the rest of
 * the session. The player still walks, because `player.update` is the first line;
 * the pickups stop spinning and stop being pickable, because they are the sixth;
 * and the only trace is one `console.error` that says which *function* failed and
 * nothing about which part of it.
 *
 * So the frame is a list of named phases. A phase that throws is reported once by
 * name, with a repeat count so a per-frame failure does not bury the console, and
 * the phases after it still run. Half a frame is worth more than none of one, and
 * a named half is worth more than either.
 */
function frameStages(): (name: string, body: () => void) => void {
    const failures = new Map<string, number>();

    return (name: string, body: () => void): void => {
        try {
            body();
        } catch (e) {
            const count = (failures.get(name) ?? 0) + 1;
            failures.set(name, count);

            if (count === 1) {
                console.error(
                    `[queep] frame phase '${name}' threw; the phases after it still ran`,
                    e
                );
            } else if (count === 100) {
                console.error(
                    `[queep] frame phase '${name}' has now thrown 100 times; no longer reporting it`
                );
            }
        }
    };
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
     Skinned models. Three registrations, and none of them are optional:

     - the glTF loader, because nothing registers it for you. `AssetManager`
       ships with no model loader at all and `load_model_scene_bundle` asserts
       on the type rather than falling back, so the failure is at least loud.
     - `MeshSystem3`, which owns `SGMesh` and puts models into the same Shade
       scene the harness draws (hence `EngineHarness.shadeScene`, not a new one).
     - `AnimationSystem3`, which needs the mesh system by reference: a clip
       nobody registered cannot be driven, and registration happens when the
       instance is built.
    */
    await engine.assetManager.registerLoader(
        GameAssetType.ModelGLTF_JSON,
        new GLTFSceneBundleAssetLoader()
    );
    /*
     ...and the image loader the glTF loader's *own dependencies* need. It asks
     for `x-meep/image-bitmap` and the error when nothing answers arrives from
     inside `tiny-gltf`, once per texture, as an unhandled rejection: sixteen
     identical errors naming a type the application never mentioned. See
     REPORT.md ergonomics.
    */
    await engine.assetManager.registerLoader(
        GameAssetType.ImageBitmap,
        new ImageBitmapAssetLoader()
    );

    const meshes = new MeshSystem3(graphics, scene, (url: string) =>
        load_model_scene_bundle(engine.assetManager, url)
    );
    await em.addSystem(meshes);
    await em.addSystem(new AnimationSystem3(graphics, meshes));

    /*
     Sound. Every sound in the port is an `AudioEmitter` component, so this
     system is the whole audio runtime: it creates the shared sopra engine,
     registers the sound asset loader, forwards the listener pose from the
     `SoundListener` component, promotes the nearest looping emitters up to its
     budget, and ticks the mixer.

     The budget is passed rather than left at its default because it is the
     port's stand-in for `S_AddLoopSounds` -- see `LOOP_BUDGET`.
    */
    const sound = engine.sound;
    let emitters: AudioEmitterSystem | null = null;

    if (sound !== null) {
        emitters = new AudioEmitterSystem(engine.assetManager, sound, { budget: LOOP_BUDGET });
        await em.addSystem(emitters);
    }

    /*
     Shade assumes global illumination: with no environment map every surface
     renders unlit, and "my geometry is black" reads as a material problem rather
     than a missing environment. See REPORT.md ergonomics.
    */
    graphics.set_environment_map(make_default_environment());

    EngineHarness.addFpsCounter(engine);

    /*
     The element that owns input.

     Not the canvas. meep's `PointerDevice` and `KeyboardDevice` are constructed
     on `viewStack.el` and started by the `Engine` constructor, so that element
     -- not `graphics.domElement` -- is where input arrives. Attaching listeners
     to the canvas produces an application that renders perfectly and cannot be
     played, which is exactly what happened here (GAP-017).

     Two properties have to be corrected before any of it works, and both are
     app-level CSS on an element the engine handed us rather than changes to the
     engine:

     - `pointer-events`. The view stack, the game view and the canvas are all
       `pointer-events: none`, so the stack is not a hit-test target and the
       pointer device it owns never receives an event.
     - focus. The stack carries `tabindex="0"` -- it is *meant* to be focused --
       but nothing focuses it, so key events go to `<body>` and the keyboard
       device never sees them either.
    */
    const input = engine.viewStack.el as HTMLElement;
    input.style.pointerEvents = 'auto';
    input.focus();

    // A click anywhere puts focus back, so tabbing away and clicking in resumes.
    input.addEventListener('pointerdown', () => input.focus());

    const mapName = requestedMap();
    const baseUrl = `/assets/built/${mapName}`;

    const [loaded, clipMap, models, audio] = await Promise.all([
        loadMap(ecd, baseUrl),
        loadClipMap(baseUrl, mapName),
        loadModels('/assets/built/models'),
        AudioBank.load('/assets/built/sound', ecd, emitters),
    ]);

    /*
     The map's own sound: `target_speaker` ambience and the `worldspawn` music
     track. Asked for now rather than after the gesture, because a loop is a
     state rather than an event -- the bank holds them until the context is
     running and starts them all at once.
    */
    const mapSound = new MapSound(audio, loaded.bundle.entities);

    /*
     Browsers create an `AudioContext` suspended and will not start it without a
     user gesture, so the bank stays silent until the player clicks to lock the
     pointer. Resuming on any earlier event would be a console warning and no
     sound; resuming here is the first moment the browser will allow.
    */
    firstGesture(input, async () => {
        if (sound === null) return;
        await sound.resumeContext();
        audio.enable();
    });

    console.log(
        `[queep] sound: ${audio.stats['names']} names, ${audio.stats['files']} files, ` +
        `${audio.stats['kilobytes']} KB` +
        `\n  map: ${mapSound.stats.speakers} looping speakers, ` +
        `music ${mapSound.stats.music ?? 'none'}` +
        (mapSound.stats.skipped.length > 0
            ? `\n  skipped: ${mapSound.stats.skipped.join(', ')}`
            : '')
    );

    /*
     Where anyone enters the level. Not a filter for `info_player_deathmatch`:
     `am_thornish` has none, and reading it that way gave that map no bots and a
     respawn at the world origin. See `spawnPoints`.
    */
    const entrances = spawnPoints(loaded.bundle.entities);
    const spawn = entrances.points[0] ?? null;

    console.log(`[queep] spawns: ${entrances.points.length} from ${entrances.kind}`);

    const camera = new Camera();
    camera.active.set(true);
    camera.autoClip = false;
    // Scene is metres (DECISIONS.md D-011). A Q3 arena is ~50 m across.
    camera.clip_near = 0.1;
    camera.clip_far = 600;
    camera.fov.set(90);

    const transform = new Transform();
    const cameraEntity = new Entity();

    /*
     The listener rides the camera, which is the player's head. Q3 does the same
     -- `S_Respatialize` is called with the view origin -- and it is why a rocket
     behind you is behind you rather than behind your feet.
    */
    if (!ecd.isComponentTypeRegistered(SoundListener)) ecd.registerComponentType(SoundListener);
    cameraEntity.add(transform).add(camera).add(new SoundListener()).build(ecd);

    const hud = new Hud({ crosshair: requestedCrosshair() });
    hud.link(engine.viewStack);

    if (flyMode()) {
        transform.position.set(
            spawn?._origin[0] ?? 0,
            (spawn?._origin[1] ?? 0) + 0.8,
            spawn?._origin[2] ?? 0
        );

        const fly = new FlyCamera(transform, input, engine.devices);
        fly.attach();
        engine.ticker.onTick.add((dt: number) => {
            fly.update(dt);
            audio.update();
            hud.update({
                mode: 'fly', speed: 0, onGround: false, map: mapName,
                weapon: '', damage: 0, kills: 0, deaths: 0, backend: 'noclip',
                health: 0, armor: 0, ammo: -1, pickup: '', pickupAgeSeconds: 99,
            });
        });

        expose(engine, { loaded, clipMap, fly, audio, mapSound });
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

        const moverHost =
            usePortedPmove() || physicsWorld === null || physicsWorld.ecd === null
                ? null
                : { system: physicsWorld.system, ecd: physicsWorld.ecd };

        const player = new PlayerController(
            clipMap,
            input,
            engine.devices,
            spawn?._originQ3 ?? [0, 0, 0],
            physicsWorld,
            moverHost
        );

        console.log(
            `[queep] movement: ${moverHost === null ? 'ported bg_pmove' : "Q3's motor on meep KinematicMover"}`
        );
        player.attach();

        const arena = new Arena(ecd, clipMap);
        arena.audio = audio;

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

        const itemsView = new ItemsView(ecd, models, audio);
        itemsView.build(items.items);

        /*
         The gun in the player's own hands. Built here rather than inside
         `PlayerController` because it is presentation and that class is
         simulation, and because it needs the model library, which the controller
         has no other reason to know about.
        */
        const viewWeapon = new ViewWeapon(ecd, models);

        console.log(
            `[queep] items: ${itemsView.itemCount} placed, ${itemsView.pieceCount} pieces, ` +
            `${models.meshletMilliseconds.toFixed(0)} ms meshlets` +
            (items.rejected.length > 0 ? `
  rejected: ${items.rejected.join('; ')}` : '') +
            (itemsView.unmodelled.length > 0
                ? `
  no model: ${itemsView.unmodelled.join(', ')}`
                : '') +
            (itemsView.partial.length > 0
                ? `
  partial (OA ships no shell model): ${itemsView.partial.join(', ')}`
                : '')
        );

        /* ---- movers: doors, plats, buttons, triggers ---- */

        /*
         The four things the world can do to a player between two frames, and
         the frame that applies them. Shared with `player-controller.test.ts`
         rather than reproduced there: the ordering is load-bearing and a test
         of a hand-copied ordering is a test of the copy. See D-075.
        */
        const effects = new WorldEffects();

        const movers = new MoverSystem({
            moverSound: (mover, which) => {
                /*
                 `SP_func_door` and `SP_func_plat` set different sounds, and
                 `SP_func_button` has a start sound and no stop sound at all --
                 a switch clicks once rather than clicking and then thumping.
                */
                const centre: [number, number, number] = [
                    (mover.mins[0] + mover.maxs[0]) * 0.5 + mover.origin[0],
                    (mover.mins[1] + mover.maxs[1]) * 0.5 + mover.origin[1],
                    (mover.mins[2] + mover.maxs[2]) * 0.5 + mover.origin[2],
                ];

                if (mover.classname === 'func_button') {
                    if (which === 'start') audio.play('mover/button', centre);
                    return;
                }

                const kind = mover.classname === 'func_plat' ? 'plat' : 'door';
                audio.play(`mover/${kind}_${which}`, centre);
            },
            teleport: (destination) => {
                audio.play('world/telein', player.ps.origin);
                audio.play('world/teleout', destination.origin);
                effects.teleport(destination.origin, destination.angle);
            },
            hurt: (damage) => {
                effects.hurt(damage);
            },
            push: (velocity) => {
                effects.push(velocity);
                audio.playLocal('world/jumppad');
            },
        });

        movers.spawn(loaded.bundle.entities, loaded.bundle.submodels ?? []);

        // Only the clipmap backend needs this; physics sees kinematic bodies.
        player.movers = { movers: movers.clipEntities };

        const moversView = new MoversView(movers, loaded.submodelTransforms, physicsWorld);
        moversView.update();

        let staticBodies = 0;
        for (const model of movers.statics) {
            staticBodies += physicsWorld?.addStaticModel(model) ?? 0;
        }

        console.log(
            `[queep] movers: ${moversView.moverCount} brush entities, ` +
            `${movers.triggers.length} triggers, ${movers.destinations.length} destinations, ` +
            `${moversView.bodyCount} kinematic bodies, ` +
            `${movers.statics.length} static brush entities (${staticBodies} bodies)` +
            (movers.unhandled.length > 0 ? `
  unhandled: ${movers.unhandled.join(', ')}` : '')
        );

        /* ---- navigation ---- */

        const t0Nav = performance.now();
        const graph = buildWaypoints(loaded.bundle.submodels?.[0] ?? {
            minsQ3: [-4096, -4096, -4096],
            maxsQ3: [4096, 4096, 4096],
        }, dropTrace);
        const portals = linkMapPortals(
            graph,
            loaded.bundle.entities,
            loaded.bundle.submodels ?? []
        );

        console.log(
            `[queep] nav: ${graph.stats.nodes} nodes, ${graph.stats.links} links, ` +
            `${graph.stats.drops} drops, ${portals.teleports} teleports, ` +
            `${portals.jumppads} jump pads, ` +
            `largest component ${(graph.stats.largestComponent * 100).toFixed(0)}% ` +
            `(${(performance.now() - t0Nav).toFixed(0)} ms)`
        );

        /* ---- bots ---- */

        const botSpawns = entrances.points.map((e) => e._originQ3);

        const botWorld: BotWorld = {
            graph,
            items: items.items,
            trace: (start, mins, maxs, end, mask) => {
                const out = createTrace();
                if (physicsWorld !== null) {
                    physicsWorld.trace(out, start, end, mins, maxs, mask);
                } else {
                    boxTrace(out, clipMap, start, end, mins, maxs, mask);
                }
                return out;
            },
            playerOrigin: () => player.ps.origin,
            playerAlive: () => player.inventory.health > 0,
            spawns: botSpawns.map((spawn) => {
                const node = graph.nearestInMainBody(spawn);
                return node < 0
                    ? spawn
                    : [
                          graph.nodes[node]!.origin[0],
                          graph.nodes[node]!.origin[1],
                          graph.nodes[node]!.origin[2] - 9,
                      ];
            }),
            fire: (bot, eye, angles, weapon) => {
                /*
                 The bot's own id as `ownerId`, so `hitscanShot` skips it. The
                 muzzle is 14 units in front of the eye and a bot's own box is
                 15 wide, so a bot firing with `ownerId: 0` shoots itself the
                 instant it pulls the trigger.
                */
                arena.weapons.fire(weapon, eye, angles, bot.id, (Math.random() * 0xffff) | 0);
            },
        };

        /*
         The player, as something bots can shoot.
         
         Bots were firing at it for a hundred rounds apiece and doing nothing,
         because `weapons.targets` held only the boxes and the bots. `origin`
         is a live reference to `ps.origin` rather than a copy, so it tracks
         without anything having to remember to update it; `health` and `armor`
         are accessors over the same inventory the HUD reads, so there is one
         number rather than two that can disagree.
        */
        const playerTarget: Damageable = {
            id: 0,
            origin: player.ps.origin,
            mins: q3vec3(-15, -15, -24),
            maxs: q3vec3(15, 15, 32),
            get health(): number {
                return player.inventory.health;
            },
            set health(value: number) {
                player.inventory.health = value;
            },
            get armor(): number {
                return player.inventory.armor;
            },
            set armor(value: number) {
                player.inventory.armor = value;
            },
            get dead(): boolean {
                return player.inventory.health <= 0;
            },
            set dead(_value: boolean) {
                // Death is derived from health; nothing sets it directly.
            },
        };
        arena.weapons.targets.push(playerTarget);

        const botRuntime = new BotRuntime(botWorld, audio);
        const characters: Character[] = [];

        /*
         One bot per spawn point beyond the player's, up to the roster size. Q3
         fills a server from `bot_minplayers`; there is no server here, so the
         map's own spawn count stands in -- a map built for eight players gets
         seven opponents.
        */
        for (let i = 1; i < botSpawns.length && i <= CHARACTERS.length; i++) {
            const name = CHARACTERS[(i - 1) % CHARACTERS.length]!;

            /*
             Snapped to the navigation graph's main body. A spawn point the
             graph cannot route out of produces a bot that stands still for the
             whole match -- see `nearestInMainBody`.
            */
            const snapped = graph.nearestInMainBody(botSpawns[i]!);
            const spawnQ3 =
                snapped < 0
                    ? botSpawns[i]!
                    : [
                          graph.nodes[snapped]!.origin[0],
                          graph.nodes[snapped]!.origin[1],
                          // Node origins are standing positions and the host
                          // adds Q3's own 9-unit spawn lift, so take it back off.
                          graph.nodes[snapped]!.origin[2] - 9,
                      ];

            const bot = new Bot({
                id: 2000 + i,
                name,
                character: name,
                cm: clipMap,
                spawnQ3,
                physics: physicsWorld,
                movers: () => ({ movers: movers.clipEntities }),
                // The same solver the player runs, which is the whole point of
                // a bot filling a `usercmd_t` rather than steering itself.
                moverHost,
            });

            const character = new Character(ecd, name);
            characters.push(character);

            botRuntime.spawn(bot, character);
            arena.weapons.targets.push(bot);
        }

        console.log(`[queep] bots: ${botRuntime.bots.length}, ${characters.length} characters`);

        let pickupName = '';
        let pickupAge = 99;
        let secondAccumulator = 0;

        const footsteps = new Footsteps();
        let lastWeapon = player.weapon;

        /** Seconds until the player respawns; negative means alive. */
        let respawnIn = -1;

        /*
         The red boxes at spawn points are gone: bots stand there now, they are
         `Damageable` in the same list, and they shoot back. `Arena.addTarget`
         stays because it is still the shortest way to put something shootable
         in a scene, and `?targets=1` puts them back for testing damage without
         the AI in the way.
        */
        if (new URLSearchParams(window.location.search).get('targets') === '1') {
            for (const s of entrances.points.slice(1, 5)) arena.addTarget(s._originQ3);
        }

        player.onDryFire = () => {
            audio.playLocal('weapon/empty');
        };

        player.onFire = (eye, angles) => {
            arena.weapons.fire(player.weapon, eye, angles, 0, (Math.random() * 0xffff) | 0);
        };

        const phase = frameStages();

        // `onTick` is documented as `Signal<number>` but is emitted as `any`, so
        // the callback parameter has no inferred type -- see GAP-001.
        engine.ticker.onTick.add((deltaSeconds: number) => {
            phase('player', () => player.update(deltaSeconds, transform));
            /*
             `graphics.camera.camera.transform`, and **not** `transform`.

             They hold different poses, always. `CameraSystem3` copies the camera
             entity onto Shade's camera during `entityManager.update`, which the
             `Engine` constructor subscribed to this same ticker ahead of
             everything here -- so by the time this line runs, the frame's camera
             is the pose `player.update` wrote *last* tick, and `transform` is the
             pose it wrote a moment ago. A gun placed from the second is a whole
             tick of mouse movement away from the view it is welded to, and swings
             across the screen by however far you just turned (D-081).
            */
            phase('view weapon', () =>
                viewWeapon.update(graphics.camera.camera.transform, deltaSeconds, {
                    weapon: player.weapon,
                    speed: player.speed,
                    // The same counter the footstep sounds read, three lines of
                    // frame apart: Q3 has one gait, not two.
                    bobCycle: player.ps.bobCycle,
                    // No gun for a corpse. Q3 switches to a death camera instead,
                    // which this port has no equivalent of.
                    visible: !player.dead,
                })
            );

            phase('arena', () => arena.update(deltaSeconds));

            // Retire the emitter entities whose one-shot finished last frame.
            phase('audio', () => audio.update());

            phase('items', () => {
                for (const event of items.update(
                    deltaSeconds,
                    player.ps.origin,
                    player.inventory,
                    true
                )) {
                    pickupName = event.label;
                    pickupAge = 0;
                    // `Touch_Item` plays the pickup sound to the picker only, dry.
                    audio.playLocal(`item/${event.item.def.classname}`);
                    if (event.selectWeapon !== null) {
                        player.selectWeapon(event.selectWeapon as typeof player.weapon);
                    }
                }

                itemsView.update(items.now);
                pickupAge += deltaSeconds;
            });

            /* ---- bots ---- */

            phase('bots', () =>
                botRuntime.update(deltaSeconds, deltaSeconds * 1000, items.items)
            );

            /* ---- the player's own mortality ---- */

            phase('mortality', () => {
                if (player.inventory.health <= 0 && respawnIn < 0) {
                    respawnIn = 2;
                    arena.explosion(player.ps.origin, 90);
                    audio.play('impact/flesh', player.ps.origin);
                }

                if (respawnIn >= 0) {
                    respawnIn -= deltaSeconds;
                    if (respawnIn < 0) {
                        /*
                         `ClientSpawn`, minus the spawn-point selection Q3 does with
                         `SelectSpawnPoint` -- which scores every point by distance
                         from the nearest enemy so you do not materialise in front
                         of one. A random point is the honest simplification.
                        */
                        const spawnPoint =
                            botSpawns[(Math.random() * botSpawns.length) | 0] ?? [0, 0, 0];

                        player.ps.origin[0] = spawnPoint[0]!;
                        player.ps.origin[1] = spawnPoint[1]!;
                        player.ps.origin[2] = spawnPoint[2]! + 9;
                        player.ps.velocity[0] = 0;
                        player.ps.velocity[1] = 0;
                        player.ps.velocity[2] = 0;

                        const fresh = newInventory();
                        player.inventory.health = fresh.health;
                        player.inventory.armor = 0;
                        player.inventory.weapons.clear();
                        for (const w of fresh.weapons) player.inventory.weapons.add(w);
                        for (const key of Object.keys(player.inventory.ammo)) {
                            delete player.inventory.ammo[key];
                        }
                        Object.assign(player.inventory.ammo, fresh.ammo);
                        player.selectWeapon('WP_MACHINEGUN');
                    }
                }
            });

            /* ---- player audio ---- */

            phase('player audio', () => {
                const step = footsteps.update(
                    player.ps.bobCycle,
                    player.onGround,
                    player.ducked
                );
                if (step === 'step') audio.play('player/footstep', player.ps.origin);
                else if (step === 'land') audio.play('player/land', player.ps.origin);

                if (player.weapon !== lastWeapon) {
                    lastWeapon = player.weapon;
                    audio.playLocal('weapon/change');
                }
            });

            /* ---- movers, and everything they do to the player ---- */

            phase('movers', () => {
                const world = effects.apply(player, movers, deltaSeconds);
                moversView.update();

                if (world.damage > 0) player.inventory.health -= world.damage;
            });

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
                deaths: arena.deaths,
                backend: usePortedPmove() ? (clipmapOnly ? 'q3/clipmap' : 'q3/physics') : 'meep',
                health: player.inventory.health,
                armor: player.inventory.armor,
                ammo: player.inventory.ammo[player.weapon] ?? 0,
                pickup: pickupName,
                pickupAgeSeconds: pickupAge,
            });
        });

        expose(engine, {
            loaded, clipMap, player, arena, physicsWorld, items, models,
            movers, moversView, characters, audio, mapSound, graph, botRuntime,
            viewWeapon,
        });
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
/** Run `action` once, on the first click -- the gesture that unlocks audio. */
function firstGesture(element: HTMLElement, action: () => void): void {
    const once = (): void => {
        element.removeEventListener('pointerdown', once);
        action();
    };
    element.addEventListener('pointerdown', once);
}

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
