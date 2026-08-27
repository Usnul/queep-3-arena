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

import '../style/main.scss';

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
import { applyLightVolumes } from '../client/map/lightVolume.ts';
import { Shadows } from '../client/Shadows.ts';
import { loadModels } from '../client/map/loadModels.ts';
import { ItemsView } from '../client/ItemsView.ts';
import { ItemSystem, newInventory, type DropTrace } from '../game/Items.ts';
import { MoverSystem, type Vec3 } from '../game/Movers.ts';
import { WorldEffects } from '../game/WorldEffects.ts';
import type { Damageable } from '../game/Weapons.ts';
import { vec3 as q3vec3 } from '../q3/math.ts';
import { MoversView } from '../client/MoversView.ts';
import { Character, CHARACTERS } from '../client/Characters.ts';
import { AudioBank, LOOP_BUDGET } from '../client/Audio.ts';
import { MapSound } from '../client/MapSound.ts';
import { Bot } from '../game/Bot.ts';
import { BotRuntime, type BotWorld } from '../client/Bots.ts';
import { buildWaypoints, linkMapPortals } from '../game/Waypoints.ts';
import { spawnPoints } from '../game/Spawns.ts';
import { AudioEmitterSystem } from '@woosh/meep-engine/src/engine/sound/ecs/audio/AudioEmitterSystem.js';
import { InterpolationSystem } from '@woosh/meep-engine/src/engine/interpolation/InterpolationSystem.js';
import SoundListener from '@woosh/meep-engine/src/engine/sound/ecs/SoundListener.js';
import type { EngineConfiguration } from '@woosh/meep-engine/src/engine/EngineConfiguration.js';
import type SoundEngine from '@woosh/meep-engine/src/engine/sound/SoundEngine.js';
import { SopraDefaultBus } from '@woosh/meep-engine/src/engine/sound/sopra/SopraEngine.js';
import { configureAcousticSimulation } from '@woosh/meep-engine/src/engine/sound/simulation/configureAcousticSimulation.js';
import { ProbeReverbRenderer } from '@woosh/meep-engine/src/engine/sound/simulation/render/ProbeReverbRenderer.js';
import { attachProbeField, loadProbeField } from '../client/Acoustics.ts';
import type { GraphicsEngine3 } from '@woosh/meep-engine/src/engine/graphics3/GraphicsEngine3.js';
import type { Scene } from '@woosh/meep-engine/src/shade/renderer/scene/Scene.js';
import type { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { VolumetricLightMap } from '@woosh/meep-engine/src/engine/graphics3/VolumetricLightMap.js';
import { VolumetricLightMapSystem3 } from '@woosh/meep-engine/src/engine/graphics3/VolumetricLightMapSystem3.js';
import { ShadeIndirectLightingMode } from '@woosh/meep-engine/src/shade/renderer/ShadeIndirectLightingMode.js';
import {
    attachVolumetricLightMap,
    bakeVolumetricLightMap,
    loadVolumetricLightMap,
    postBake,
} from '../client/VolumetricLight.ts';
import { boxTrace, createTrace } from '../q3/cm/trace.ts';
import { PlayerController } from '../client/PlayerController.ts';
import { FlyCamera } from '../client/FlyCamera.ts';
import { CROSSHAIR_DEFAULT, Hud } from '../client/Hud.ts';
import { NUM_CROSSHAIRS } from '../client/crosshair.ts';
import { ViewWeapon } from '../client/ViewWeapon.ts';
import { Arena } from '../client/Arena.ts';
import { PhysicsWorld } from '../client/PhysicsWorld.ts';
import { Missiles } from '../client/Missiles.ts';
import { DamageQueries } from '../client/DamageQueries.ts';
import { takePointerLock } from '../client/pointerLock.ts';
import { Menu } from '../client/ui/Menu.ts';
import { Settings, type SettingsStorage } from '../client/ui/Settings.ts';
import { graphicsPage } from '../client/ui/graphics.ts';
import { addFrameRateCounter } from '../client/ui/frameRateCounter.ts';
import { buildRoster } from './roster.ts';
import { CharacterBodies } from '../client/CharacterBody.ts';
import {
    BotSystem,
    CharacterBodySystem,
    CombatSystem,
    FlySystem,
    PickupSystem,
    PlayerSystem,
    PoseRecorderSystem,
    PresentationSystem,
    WorldEffectSystem,
    interpolatedPose,
} from './systems.ts';

/**
 * How loud the room is, as a linear gain on the reverb send.
 *
 * Roughly -9 dB. Q3's own sound was dry -- it had no reverberation of any kind
 * -- so there is no original to match and this is set to be heard rather than
 * noticed: enough that a hall reads as a hall and a corridor does not, not
 * enough to put the arena underwater. It multiplies whatever the probe field
 * measured, so it scales the whole map at once.
 */
const REVERB_SEND = 0.35;

/** Map to load; override with `?map=oa_dm5`. */
function requestedMap(): string {
    return new URLSearchParams(window.location.search).get('map') ?? 'oa_dm1';
}

/**
 * `?crosshair=N` picks one of Q3's ten, exactly as `cg_drawCrosshair` does.
 *
 * Defaults to Q3's own default, which is a dot rather than the cross most
 * people picture. All ten convert, so disagreeing with id about that is a
 * query parameter rather than a rebuild -- or, now, the menu.
 *
 * `null` for "not asked for", which is what lets the parameter beat the stored
 * setting without a stored setting having to lose to an absent parameter.
 */
function requestedCrosshair(): number | null {
    const raw = new URLSearchParams(window.location.search).get('crosshair');
    if (raw === null) return null;

    const parsed = Number.parseInt(raw, 10);

    /*
     Out of range is "not asked for" rather than something to clamp, so that the
     parameter and the menu's own setting agree about what a legal answer is.
     Clamping here and rejecting there is what produced the one visible symptom
     worth avoiding: `?crosshair=-3` drew crosshair A for a frame, because the
     HUD clamped it, and then jumped to E, because the setting refused it.
    */
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= NUM_CROSSHAIRS) return null;

    return parsed;
}

/** `?fly=1` swaps the player for a noclip camera, for inspecting conversions. */
function flyMode(): boolean {
    return new URLSearchParams(window.location.search).get('fly') === '1';
}

/**
 * `?gi=ibl` renders the map's ambient light from the environment map, as every
 * build before the volumetric bake existed did.
 *
 * Brick4 is the default *when the map has a bake to read*, and this is how the
 * two are compared without moving a file: the same A/B shape as `?trace=` and
 * `?move=`, for a change that alters every pixel. There is nothing to force the
 * other way -- `?gi=brick4` on a map with no lightmap would ask the renderer to
 * read an empty buffer, which is a black room rather than an experiment.
 */
function useEnvironmentLighting(): boolean {
    return new URLSearchParams(window.location.search).get('gi') === 'ibl';
}

/**
 * `?bake=lightmap` bakes this map's volumetric lightmap and writes it back to
 * `assets/built/<map>/`, then leaves the game running on the result.
 *
 * A query parameter rather than a script because the bake is a compute shader
 * that needs the loaded scene, its materials and a live device; see
 * `VolumetricLight.ts`. Minutes per map, and the browser tab is doing it, so it
 * says so at both ends.
 */
function bakeRequested(): boolean {
    return new URLSearchParams(window.location.search).get('bake') === 'lightmap';
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
    /*
     The scene's baked indirect lighting, if the map has any. One buffer for the
     whole scene rather than a thing per entity, so the system is a claim on it:
     it uploads whichever `VolumetricLightMap` linked first and re-uploads after
     a device restart. See `VolumetricLight.ts`.
    */
    await em.addSystem(new VolumetricLightMapSystem3(graphics, scene));
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
     Render-rate blending of a fixed-step simulation, which is the other half of
     phase 9: the game advances 60 times a second and the display does not, so
     without this every moving thing holds a pose for several frames and then
     jumps. `EngineHarness` does not register this -- nothing in it mentions the
     class -- but `PhysicsSystem` is already a complete producer for it, so
     wiring one log is all a physics body needs to render smoothly.

     It cannot help the *camera*. `CameraSystem3` references two components to
     this system's one, scores higher in `updateExecutionOrder`, and therefore
     copies the camera entity onto Shade's camera before this has blended
     anything. Measured rather than assumed -- see `test/fixed-step.test.ts` --
     and the camera stays on the fixed step because of it.
    */
    const interpolation = new InterpolationSystem();
    await em.addSystem(interpolation);

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
    let reverb: ProbeReverbRenderer | null = null;

    if (sound !== null) {
        emitters = new AudioEmitterSystem(engine.assetManager, sound, { budget: LOOP_BUDGET });
        await em.addSystem(emitters);

        // And what the level does to those sounds. See `configureAcoustics`.
        reverb = await configureAcoustics(em, sound, emitters);
    }

    /*
     Shade assumes global illumination: with no environment map every surface
     renders unlit, and "my geometry is black" reads as a material problem rather
     than a missing environment. See REPORT.md ergonomics.
    */
    graphics.set_environment_map(make_default_environment());

    /*
     `addFpsCounter` returns nothing, so the panel it adds cannot be turned off
     by anyone who did not build it themselves. `addFrameRateCounter` calls it
     and takes the child it appended, which is what the menu's toggle writes to.
     GAP-028.
    */
    const frameRateCounter = addFrameRateCounter(engine);

    /*
     Which lights cast, built here because the map's lights are handed to it as
     soon as they exist and the menu is built later than that. It starts at its
     own default and the graphics page pushes the stored value at it on
     `applyAll`, which is the same order every other setting arrives in.
    */
    const shadows = new Shadows(graphics);

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

    const [loaded, clipMap, models, audio, probes, lightMap] = await Promise.all([
        loadMap(ecd, baseUrl),
        loadClipMap(baseUrl, mapName),
        loadModels('/assets/built/models'),
        AudioBank.load('/assets/built/sound', ecd, emitters),
        // Null on a checkout that has not run `node tools/bake-audio.ts`.
        reverb === null ? Promise.resolve(null) : loadProbeField(baseUrl),
        // ...and the same for the volumetric lightmap, which `?bake=lightmap` writes.
        loadVolumetricLightMap(baseUrl),
    ]);

    /*
     The map's reverberation, as measured offline. Two consumers, because the
     one component answers two questions: `AcousticProbeFieldSystem` picks it up
     off the entity and hands it to the simulator, and the renderer is given it
     directly because nothing in the engine wires those two together -- the
     simulator would use the field for corner-leak pathing, which is off, while
     the reverb is the part this port actually baked for.
    */
    if (probes !== null && reverb !== null) {
        attachProbeField(ecd, probes);
        reverb.setProbeField(probes);

        console.log(`[queep] acoustics: ${probes.size} baked probes`);
    } else if (reverb !== null) {
        console.log(
            `[queep] acoustics: occlusion only -- ${mapName} has no baked probe field. ` +
            `Run \`node tools/bake-audio.ts ${mapName}\` for reverberation.`
        );
    }

    /*
     Lights are spheres in Shade and points in the ECS, and the component has no
     field for the difference (GAP-030). `loadMap` has just built the entities
     `LightSystem3` mirrors, so this is the first moment Shade's own lights
     exist to be sized. See `applyLightVolumes`.
    */
    const volumes = applyLightVolumes(scene.lights, loaded.bundle.lights, loaded.bundle.sun);

    console.log(
        `[queep] light volumes: ${volumes.sized} sized, ${volumes.suns} sun` +
        (volumes.unmatched > 0 ? `, ${volumes.unmatched} unmatched` : '') +
        (volumes.unclaimed > 0 ? `, ${volumes.unclaimed} unclaimed` : '')
    );

    /*
     ...and whether they cast, which unlike the size is written on the component
     rather than on Shade's light -- `LightSystem3` follows `castShadow` and
     would overwrite anything written the other way. See `Shadows`.
    */
    shadows.followAll(loaded.lights, 'world');
    if (loaded.sun !== null) shadows.follow(loaded.sun, 'sun');

    console.log(
        `[queep] shadows: ${shadows.mode}, ${shadows.followedCount} lights following`
    );

    /*
     The map's indirect lighting, if it has a bake, and the renderer setting
     that makes the buffer worth uploading.

     Both halves are needed and neither implies the other:
     `VolumetricLightMapSystem3` uploads whatever component is attached whether
     or not anything reads it, and Brick4 mode reads the buffer whether or not
     anything filled it -- which is a black level rather than an unlit one. So
     the mode follows the map, and `?gi=ibl` opts back out for comparison.

     After `applyLightVolumes` rather than beside the load, because the bake
     below traces the scene's *lights* and those are only their final size once
     the volumes are applied. A loaded map does not care about the order; a
     baked one very much does.
    */
    const environmentOnly = useEnvironmentLighting();

    if (lightMap !== null && !environmentOnly) {
        attachVolumetricLightMap(ecd, lightMap);
        graphics.renderer.indirect_lighting_mode = ShadeIndirectLightingMode.Brick4;

        console.log(
            `[queep] indirect lighting: brick4, ` +
            `${(lightMap.data!.byteLength / (1024 * 1024)).toFixed(2)} MB baked volume`
        );
    } else {
        console.log(
            `[queep] indirect lighting: environment map` +
            (lightMap === null
                ? ` -- ${mapName} has no baked volume. Load \`?map=${mapName}&bake=lightmap\` to make one.`
                : ' (?gi=ibl)')
        );
    }

    if (bakeRequested()) {
        /*
         Not awaited. The bake is minutes of compute-shader work and the level is
         already playable; blocking here would leave a black window for the whole
         of it with no way to tell that from a hang. It logs at both ends and
         publishes its own result when it lands, so the room lights up when it is
         done.

         Called from *here* -- after the map's lights are final and before items,
         characters and the view weapon are built -- and that placement is the
         bake's scope rather than a coincidence. `bakeVolumetricLightMap` builds
         its BVH and its tree synchronously, before it awaits anything, so the
         scene it captures is exactly the one standing at this line: world
         geometry and lights, no pickups and no players. Which is what a *static*
         lightmap should hold. Moving this call later would bake the spinning
         rocket launcher into the room's indirect lighting.
        */
        void runLightMapBake(graphics, scene, ecd, mapName, lightMap, !environmentOnly);
    }

    if (volumes.sized === 0 && loaded.bundle.lights.length > 0) {
        console.warn(
            '[queep] no light was given a volume: every one of them is still a point source. ' +
            `${volumes.unmatched} lights in the scene stood at no bundle position and ` +
            `${volumes.unclaimed} bundle lights had no light standing at them, so either ` +
            'LightSystem3 has not linked them yet or the two have stopped agreeing about where ' +
            'they are.'
        );
    }

    if (volumes.stale > 0) {
        console.warn(
            `[queep] ${volumes.stale} of ${loaded.bundle.lights.length} lights carry no ` +
            `sourceRadius, so they were given a default one. Re-run ` +
            `\`node tools/convert-map.ts ${mapName}\` to size them from their own geometry.`
        );
    }

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

    const crosshair = requestedCrosshair();

    const hud = new Hud({ crosshair: crosshair ?? CROSSHAIR_DEFAULT });
    hud.link(engine.viewStack);

    /* ---- the menu ---- */

    /*
     Built here, before the fly/play branch, because both branches want it: the
     noclip camera is the tool the conversions are inspected with and a field of
     view and a render scale are exactly what that inspection wants to change.

     `camera` and not `graphics.camera.camera` this time -- unlike the view
     weapon (D-081), this writes a value that `CameraSystem3` copies forward
     rather than reads a pose it has already copied.
    */
    const settings = new Settings([
        graphicsPage({ graphics, camera, hud, frameRateCounter, shadows }),
    ]);

    settings.applyAll();

    const menu = new Menu({
        settings,
        onOpened: () => {
            // The pointer belongs to the menu now. `PlayerController` and
            // `FlyCamera` both stop on their own when the lock goes, because
            // both already treat losing it as "the player is not playing".
            if (document.pointerLockElement !== null) document.exitPointerLock();
        },
        onClosed: (cause) => {
            /*
             Focus first, and unconditionally. The keyboard device listens on
             the view stack, and closing the menu while a slider had focus
             leaves focus on an element that has just become invisible -- the
             browser moves it to `<body>` and the game stops answering keys.
            */
            input.focus();

            /*
             Then the pointer, but only when the gesture that closed the menu
             was one the browser counts as a user activation. Escape is not one,
             so asking after an Escape is a guaranteed rejection and a console
             error to go with it; the player clicks to resume instead, which is
             what the HUD has always told them to do.
            */
            if (cause === 'pointer') {
                // Refused is normal and not an error -- the HUD's "click to
                // play" is what covers it. See `takePointerLock`.
                void takePointerLock(input);
            }
        },
    });

    menu.link(engine.viewStack);

    /*
     Storage last, and not awaited. It is an IndexedDB round trip, every setting
     it carries is applied live, and the alternative is a game that does not
     start because a browser in private mode would not open a database.

     The query parameter is re-applied afterwards so that it beats the stored
     value: `?crosshair=7` is someone saying what they want now, and a setting
     saved three sessions ago is not.
    */
    /*
     The cast is meep's declaration being wrong in the way that compiles.
     `Engine.d.ts` says `storage: Storage` and imports nothing called `Storage`,
     so TypeScript resolves it to the **DOM**'s `Storage` -- the type of
     `localStorage`. `engine.storage.getItem('x')` therefore typechecks and
     throws at runtime, and the real API (`load`, `store`, `list`, `remove`) is
     invisible. GAP-029.
    */
    const storage = engine.storage as unknown as SettingsStorage;

    void settings
        .attach(storage)
        .then(() => {
            if (crosshair !== null) settings.set('crosshair', crosshair);
        })
        .catch((e: unknown) => {
            // `attach` swallows its own storage failures, so anything arriving
            // here is a bug in the line above rather than a browser refusing to
            // open a database -- and an unhandled rejection at startup is silent.
            console.error('[queep] settings failed to load', e);
        });

    if (flyMode()) {
        transform.position.set(
            spawn?._origin[0] ?? 0,
            (spawn?._origin[1] ?? 0) + 0.8,
            spawn?._origin[2] ?? 0
        );

        const fly = new FlyCamera(transform, input, engine.devices);
        fly.attach();

        await em.addSystem(new FlySystem({ fly, audio, hud, map: mapName }));

        expose(engine, { loaded, clipMap, fly, audio, mapSound, hud, menu, settings, camera });
    } else {
        const clipmapOnly = useClipmapTrace();

        /*
         Built even when `?trace=clipmap` selects the ported collision, because
         that parameter picks a *movement* backend and missiles are the engine's
         now either way. Taking the rockets away with the movement would make one
         A/B mean two things, and the cost of the bodies nobody sweeps against is
         about 18 ms at load.
        */
        const physicsWorld = await PhysicsWorld.create(em, ecd, clipMap);

        {
            /*
             The engine's own producer. With this set, `PhysicsSystem` restores
             every `Interpolated` body's authoritative pose at the top of each
             step and records the post-step pose after it, so nothing an
             application writes is needed to make a body render smoothly -- see
             `PoseRecorderSystem` for the poses physics does not own.
            */
            physicsWorld.system.interpolationLog = interpolation.log;

            console.log(
                `[queep] physics: ${physicsWorld.stats.brushes} brushes -> ` +
                `${physicsWorld.stats.bodies} static bodies ` +
                `(${physicsWorld.stats.hullMilliseconds.toFixed(0)} ms hulls, ` +
                `${physicsWorld.stats.bodyMilliseconds.toFixed(0)} ms bodies)` +
                /*
                 Zero means no acoustic system asked for them, which is the only
                 way to tell "the simulation is off" from "it is on and every
                 sound is unobstructed" from outside. See `addAcousticBody`.
                */
                `\n  ${physicsWorld.stats.occluders} of those occlude sound`
            );
        }

        const moverHost =
            usePortedPmove() || physicsWorld.ecd === null
                ? null
                : { system: physicsWorld.system, ecd: physicsWorld.ecd };

        /*
         Players and bots as bodies the broadphase can see, which is what makes a
         rocket able to hit one and two of them able to stand in each other's way.
         Null on the ported/clipmap backends, which have no meep physics at all.
        */
        const bodies =
            moverHost === null
                ? null
                : new CharacterBodies(moverHost, ecd, physicsWorld.traceIgnores);
        // Client id 0, matching the `Damageable` the roster builds for the player.
        const playerBody = bodies?.create(0) ?? null;

        const player = new PlayerController(
            clipMap,
            input,
            engine.devices,
            spawn?._originQ3 ?? [0, 0, 0],
            physicsWorld,
            playerBody?.host ?? moverHost
        );

        // After the controller, because the body's filter had to name itself
        // before the controller that owns it existed. See `CharacterSlot`.
        playerBody?.track(() => player.ps.origin);

        console.log(
            `[queep] movement: ${moverHost === null ? 'ported bg_pmove' : "Q3's motor on meep KinematicMover"}`
        );
        player.attach();

        /*
         Missiles are bodies. `CharacterBodies` is how a contact against a player
         becomes a Q3 client id, and it is null on the ported movement backend --
         a rocket still flies and still detonates on the world, it just cannot
         report a direct hit, because there is nothing in the broadphase to hit.
        */
        const missiles = new Missiles(physicsWorld.system, ecd, bodies);

        /*
         Splash and hitscan answered by the broadphase rather than by a loop over
         every `Damageable`. Null on the ported movement backend, where there are
         no character bodies to find and `WeaponSystem` falls back to the array
         scan the port used everywhere before phase 9.
        */
        const damageQueries =
            bodies === null ? null : new DamageQueries(physicsWorld.system, bodies);

        const arena = new Arena(ecd, clipMap, missiles, shadows, damageQueries);
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

        /*
         A door's geometry is written from the simulation on the fixed step, and
         physics does not own it -- the collision half is a separate set of
         kinematic bodies. So it goes on the application's own interpolation
         timeline, which is what `PoseRecorderSystem` is for.
        */
        for (const mover of movers.movers) {
            for (const entity of loaded.submodelEntities.get(mover.model) ?? []) {
                ecd.addComponentToEntity(entity, interpolatedPose());
            }
        }

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

        const { botRuntime, characters, botSpawns } = buildRoster({
            ecd, clipMap, physicsWorld, moverHost, graph, items, movers, arena, audio, player,
            entrances, bodies,
        });

        /*
         Once, before the first step. Every body is at the world origin until its
         pose is written, and a player whose first sweep starts inside six bots
         piled at (0, 0, 0) does not move at all.
        */
        bodies?.sync();

        /*
         The red boxes at spawn points are gone: bots stand there now, they are
         `Damageable` in the same list, and they shoot back. `Arena.addTarget`
         stays because it is still the shortest way to put something shootable
         in a scene, and `?targets=1` puts them back for testing damage without
         the AI in the way.
        */
        if (new URLSearchParams(window.location.search).get('targets') === '1') {
            for (const s of entrances.points.slice(1, 5)) {
                const box = arena.addTarget(s._originQ3);

                /*
                 A body too, or the broadphase cannot see it and `?targets=1`
                 becomes four boxes nothing can shoot. They do not move, so the
                 pose is written once.
                */
                const slot = bodies?.create(box.id);
                slot?.track(() => box.origin);
            }

            bodies?.sync();
        }

        player.onDryFire = () => {
            audio.playLocal('weapon/empty');
        };

        player.onFire = (eye, angles) => {
            arena.weapons.fire(player.weapon, eye, angles, 0, (Math.random() * 0xffff) | 0);
        };

        /*
         The frame, as systems -- see `app/systems.ts`.

         Simulation on `fixedUpdate`, in this registration order, because these
         declare no components and therefore tie at zero in the engine's
         execution-order scoring, where a stable sort keeps the order they were
         added in. Presentation on `update`, after every engine system that
         references a component -- which is what puts `CameraSystem3` ahead of
         the pass that reads the camera it just wrote.
        */
        const pickups = new PickupSystem({ items, itemsView, player, audio });

        await em.addSystem(
            new PlayerSystem({
                player,
                cameraTransform: transform,
                arena,
                audio,
                spawns: botSpawns,
            })
        );
        await em.addSystem(new CombatSystem(arena));
        await em.addSystem(pickups);
        await em.addSystem(new BotSystem(botRuntime, items));
        if (bodies !== null) await em.addSystem(new CharacterBodySystem(bodies));
        await em.addSystem(new WorldEffectSystem({ effects, player, movers, moversView }));

        // Last of the simulation systems, because it snapshots what they wrote.
        const poses = new PoseRecorderSystem();
        poses.attachTo(interpolation);
        await em.addSystem(poses);

        await em.addSystem(
            new PresentationSystem({
                viewWeapon,
                renderCamera: () => graphics.camera.camera.transform,
                player,
                audio,
                hud,
                pickups,
                arena,
                describe: () => ({
                    map: mapName,
                    backend: usePortedPmove()
                        ? (clipmapOnly ? 'q3/clipmap' : 'q3/physics')
                        : 'meep',
                }),
            })
        );


        expose(engine, {
            loaded, clipMap, player, arena, physicsWorld, items, models,
            movers, moversView, characters, audio, mapSound, graph, botRuntime,
            viewWeapon, hud, menu, settings, camera,
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

/**
 * Bake this map's volumetric lightmap, write it back to the asset tree, and
 * light the running level from the result.
 *
 * Long, loud, and deliberately not awaited by its caller. Three things happen at
 * the end and all three matter:
 *
 *  - the bytes go to the dev server, which is the point of the exercise;
 *  - the component is attached, so `VolumetricLightMapSystem3` uploads it and
 *    the scene lights up without a reload -- which is also the only way to see
 *    that the bake produced something rather than nothing;
 *  - the renderer is put into Brick4 mode, for the same reason.
 *
 * That third one moves an invariant the graphics page settled at startup, and is
 * the only thing in this application that does. Screen-space reflections are not
 * compatible with Brick4 -- the renderer skips the SSR pass there, and the flag
 * being set costs it the fused indirect path on top -- so the page refuses to
 * write that flag while the mode is Brick4, having asked once, at `applyAll`.
 * This is minutes later and nothing asks again, so the flip clears the flag
 * itself. See `reflectionsReachable` in `ui/graphics.ts`.
 *
 * A failure is reported and nothing else: the level was playable before the
 * bake started and is no worse for it having failed, and throwing out of an
 * un-awaited promise would only reach the console anyway.
 */
async function runLightMapBake(
    graphics: GraphicsEngine3,
    scene: Scene,
    ecd: EntityComponentDataset,
    mapName: string,
    existing: VolumetricLightMap | null,
    live: boolean
): Promise<void> {
    console.log(`[queep] baking ${mapName}'s volumetric lightmap -- this takes minutes...`);

    try {
        const bake = await bakeVolumetricLightMap(graphics, scene);

        const written = await postBake(mapName, bake.bytes);

        if (!live) {
            console.log(
                `[queep] baked ${mapName} -> ${written}\n` +
                `  not shown: ?gi=ibl asked for the environment map, and it still means that. ` +
                `Reload without it to see the bake.`
            );
            return;
        }

        /*
         Assign into the component already on the scene rather than attaching a
         second one. `VolumetricLightMapSystem3` wires whichever linked *first*
         and silently ignores the rest -- a re-bake that added its own would
         write the file and leave the level lit by the map it just replaced,
         which is the one outcome that looks like the bake did nothing.
         Assigning `data` bumps the component's version, which is exactly what
         the system watches.
        */
        if (existing !== null) {
            existing.data = bake.bytes;
        } else {
            const map = new VolumetricLightMap();
            map.data = bake.bytes;

            attachVolumetricLightMap(ecd, map);
        }

        graphics.renderer.indirect_lighting_mode = ShadeIndirectLightingMode.Brick4;

        /*
         And the setting Brick4 has just invalidated -- see this function's
         docblock. The menu's row greys itself out on the next open, which calls
         `syncAll`; this is the half of it the renderer has to be told.
        */
        graphics.renderer.feature_ssr_enabled = false;

        console.log(
            `[queep] baked ${mapName}: ${bake.probes.toLocaleString()} probes, ` +
            `${(bake.bytes.byteLength / (1024 * 1024)).toFixed(2)} MB in ` +
            `${(bake.milliseconds / 1000).toFixed(0)} s -> ${written}`
        );
    } catch (e: unknown) {
        /*
         The stack as a string, not just the error object. A bake failure lands
         several frames deep inside the engine's compute path, and a console
         that collapses the object to `{stack: ..., message: ...}` shows the
         reporting line here rather than the one that threw.
        */
        console.error(
            `[queep] ${mapName}'s lightmap bake failed
` +
            (e instanceof Error ? (e.stack ?? e.message) : String(e))
        );
    }
}

/**
 * Turn on the acoustic simulation: what the level does to a sound between where
 * it is made and where it is heard.
 *
 * Three things arrive with this, and the third is the one the bake exists for.
 *
 * **Occlusion.** `AcousticSimulationSystem` reads every `AcousticBody +
 * Collider + Transform` into a BVH and raycasts it per live voice, so a wall
 * between a rocket and the player muffles it. The bodies are the brush bodies
 * `PhysicsWorld` already builds -- see `Acoustics.ts` -- so this costs one
 * component each rather than a second copy of the level, and a door that closes
 * closes acoustically because the system follows a transform.
 *
 * **Medium.** `AcousticVolumeSystem` is registered too and does nothing until
 * something authors an `AcousticVolume`; the simulator's default air still
 * tilts a distant source's top end off, which is the half of it that matters
 * here.
 *
 * **Reverberation.** `ProbeReverbRenderer` reads the nearest baked probe's
 * per-band RT60 at the listener and crossfades a convolver pair as the player
 * moves between rooms. The probes come from `tools/bake-audio.ts`; without them
 * this is the one part that stays silent, which is why the field is loaded and
 * logged separately rather than folded in here.
 *
 * **Corner-leak pathing is deliberately off.** It is `AcousticSimulator.pathing`,
 * it is off by default, and turning it on needs the probe *visibility graph*,
 * which meep does not serialize -- it is a function of the geometry rather than
 * of the probes, so re-deriving it at load costs what the whole bake costs. The
 * thing it buys, a sound still reaching you round a corner, is bought here by
 * `Q3_SURFACE`'s non-zero transmission instead: a wall muffles rather
 * than silences. Q3 itself modelled no occlusion at all, and hearing an enemy
 * through a wall is a channel this port should not quietly close.
 *
 * @returns the reverb renderer, which is what a loaded probe field is given to.
 */
async function configureAcoustics(
    em: { addSystem(system: unknown): Promise<unknown> },
    sound: SoundEngine,
    emitters: AudioEmitterSystem
): Promise<ProbeReverbRenderer> {
    const reverb = new ProbeReverbRenderer(sound.context, sound.destination);

    /*
     How much of the room is heard. The renderer crossfades its own wet gain
     between silent and *unity* as the listener moves between probes, so without
     a send level in front of it a reverberant hall arrives at full wet and
     drowns the dry signal it is supposed to sit behind. One gain node is the
     whole of the control, and this is the number to turn.
    */
    const send = sound.context.createGain();
    send.gain.value = REVERB_SEND;
    send.connect(reverb.input);

    /*
     What gets a send. `getOutput` taps a *copy* of a bus post-fader, so the dry
     path to the destination is untouched.

     Effects and ambient, not master. Those are the two buses the world's sounds
     go to -- `AudioBank` routes one-shots to the first and looping speakers to
     the second -- and master would also fold in the background track, which is
     a recording rather than something happening in the room. `S_StartLocalSound`
     rides the effects bus as well and is 2D, so pickups take a little of the
     room with them; that is the cost of not giving them a fourth bus, and it is
     small next to a reverberant music track.
    */
    const buses = emitters.sopra.busGraph;
    buses.getOutput(SopraDefaultBus.Effects).connect(send);
    buses.getOutput(SopraDefaultBus.Ambient).connect(send);

    /*
     `configureAcousticSimulation` is the engine's own seam and is used rather
     than the three systems it registers, so that a fourth arriving in a later
     release arrives without this file being edited. It wants an
     `EngineConfiguration`, which this application does not have -- systems are
     registered on the `EntityManager` directly -- so it is handed a collector
     with the one method it calls.
    */
    const collected: unknown[] = [];
    const collector = {
        addManySystems(...systems: unknown[]): void {
            collected.push(...systems);
        },
    } as unknown as EngineConfiguration;

    configureAcousticSimulation(collector, emitters, undefined, reverb);

    /*
     Before any body exists, which is load-bearing for the same reason
     `PhysicsWorld.create` is a factory: both of these observe the dataset, and
     an entity built before its system is registered is never seen. The map's
     brushes are built much later, in the play branch. See GAP-014.
    */
    for (const system of collected) await em.addSystem(system);

    return reverb;
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

    /*
     Built rather than interpolated. The message carries an exception's text, and
     an exception's text can carry anything at all -- a URL out of a failed
     fetch, a shader log, a file name off disk. `textContent` cannot be an
     injection; a template literal into `innerHTML` can.
    */
    const pre = document.createElement('pre');
    pre.className = 'queep-fatal';
    pre.textContent =
        `queep-3-arena failed to start\n\n${String(e instanceof Error ? e.stack : e)}`;

    document.body.replaceChildren(pre);
});
