/*
 * VolumetricLight.ts -- the light that arrives at a point from everything else
 * in the room, baked into a sparse volume.
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
 * Shade offers three indirect-lighting techniques and this port has been using
 * the cheapest of them: `ShadeIndirectLightingMode.IBL`, an environment map,
 * which is a single distant sky sampled identically everywhere. It is why
 * `make_default_environment` exists in `main.ts` -- without one, every surface
 * renders unlit -- and it is why a Q3 corridor is lit by the same "sky" as the
 * courtyard outside it. There is no bounce, no colour bleed, and no darkness:
 * an interior room with the door shut receives exactly as much ambient as an
 * open one.
 *
 * Brick4 is the other end of that. It is a sparse voxel hierarchy of irradiance
 * probes -- the "sparse volumetric lightmap" -- baked once against the map's own
 * geometry and lights, and sampled per shading point at runtime. Which is to say
 * the ambient term becomes a function of *where you are standing*.
 *
 * **The whole runtime side is a component.** `VolumetricLightMapSystem3` takes
 * whichever `VolumetricLightMap` linked first and uploads its bytes to the one
 * `Brick4LightMap` the scene keeps, re-uploading when the device restarts. So
 * loading a bake is: fetch, assign, attach to an entity.
 *
 * **Uploading is necessary and not sufficient.** The system's own docblock is
 * explicit that it does not turn Brick4 on -- a scene in IBL mode never reads
 * the buffer no matter what is in it -- so `main.ts` sets
 * `renderer.indirect_lighting_mode` too, and only when a map actually loaded.
 *
 * **The bake is not a Node tool, unlike the acoustic one.** `brick4_bake_basic`
 * is a compute shader: it traces the scene on the GPU, several bounces deep, at
 * tens of thousands of samples a probe. There is no CPU path and no headless
 * one, so the bake runs in the browser against the live renderer and posts its
 * result to the dev server, which is what `?bake=lightmap` and vite's
 * `/__bake/` sink are for. See ASSETS.md.
 */

import { VolumetricLightMap } from '@woosh/meep-engine/src/engine/graphics3/VolumetricLightMap.js';
import { BRICK4_PROBE_ENCODED_SIZE } from '@woosh/meep-engine/src/shade/renderer/global_illumination/brick4/BRICK4_PROBE_ENCODED_SIZE.js';
import { BRICK4_PROBE_RESOLUTION } from '@woosh/meep-engine/src/shade/renderer/global_illumination/brick4/BRICK4_PROBE_RESOLUTION.js';
import { StaticSceneBVH } from '@woosh/meep-engine/src/shade/renderer/scene/bvh/StaticSceneBVH.js';
import { brick4_bake_basic } from '@woosh/meep-engine/src/shade/renderer/global_illumination/brick4/gpu/bake/brick4_bake_basic.js';
import { brick4_generate_tree_from_scene } from '@woosh/meep-engine/src/shade/renderer/global_illumination/brick4/cpu/brick4_generate_tree_from_scene.js';
import { brick4_to_gpu_structure } from '@woosh/meep-engine/src/shade/renderer/global_illumination/brick4/cpu/brick4_to_gpu_structure.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

import { fetchOptionalBinary } from './optionalAsset.ts';

/** What `?bake=lightmap` writes next to `scene.json`. */
export const LIGHTMAP_FILE = 'lightmap.svlm';

/**
 * Cell size for the bake, in scene metres -- a floor under how fine the
 * hierarchy may go, and deliberately not the spacing the probes come out at.
 *
 * `brick4_generate_tree_from_scene` covers the scene with one cube, divides it
 * three ways per axis per level (`BRICK4_BRANCH_FACTOR`), and gives every node
 * a 4x4x4 probe grid. So a node of side S carries probes S/3 apart, and this
 * number decides only *when to stop*: a level is refused once its children's
 * probe spacing would fall below it. The spacing that results is therefore
 * quantised to `E / 3^n` for the root cube's side E, and lands somewhere in
 * `[cellSize, 3 x cellSize)` rather than on the cell size itself. Reading this
 * constant as "the probe spacing" is wrong by up to a factor of three, which is
 * the whole reason {@link brick4ProbeSpacing} exists and the bake reports it.
 *
 * **Half a metre is the value that puts every map inside one character.** A Q3
 * player stands 56 units tall -- `STAND_MAXS[2] - STAND_MINS[2]`, 1.75 m at
 * `WORLD_SCALE` -- and an ambient term wants to change over about half of that
 * if a doorway is to be lit differently from the room behind it. Where the six
 * maps actually land, from each one's built geometry:
 *
 * | map | root cube | depth | probe spacing |
 * |---|---:|---:|---:|
 * | `aggressor` | 62.0 m | 3 | 0.77 m (24 units) |
 * | `oa_dm7` | 69.5 m | 3 | 0.86 m (27 units) |
 * | `oa_dm1` | 77.5 m | 3 | 0.96 m (31 units) |
 * | `oa_dm4` | 79.0 m | 3 | 0.98 m (31 units) |
 * | `oa_dm5` | 81.0 m | 3 | 1.00 m (32 units) |
 * | `am_thornish` | 149.5 m | 3 | **1.85 m (59 units)** |
 *
 * Five of the six are at or inside half a character. `am_thornish` is not, and
 * the cell size is not why -- it asks for depth 4 and 0.62 m and cannot pay for
 * it. See {@link LIGHTMAP_MEMORY_BUDGET}.
 *
 * Lowering this to buy the five a finer grade does not work either: the next
 * level down is 3x finer in each axis, which is roughly 9x the probes -- 0.32 m
 * on `oa_dm1` for about 10 MB, and `oa_dm7` for about 25 MB. Within the budget
 * this is the finest grade there is.
 */
export const LIGHTMAP_CELL_SIZE = 0.5;

/**
 * Ceiling on the baked structure, in bytes.
 *
 * `brick4_generate_tree_from_scene` expands the nodes that gain the most and
 * stops when its estimate reaches this. It is not a budget that buys detail in
 * proportion to itself, which is the thing to know before turning it:
 * `purge_partial_depths` throws away *every* node of a depth the budget could
 * not finish, because a patchy level breaks the shader's interpolation. So the
 * money only ever buys a whole level. A ceiling that funds 90% of the next one
 * buys exactly nothing and pays the tree-building time anyway.
 *
 * **Ten megabytes is the stated ceiling for the asset, and it changes no map's
 * output.** Five of the six converge on their own well under it -- `oa_dm1`
 * reports `Unexpanded nodes: 0` at 1.12 MB -- so the budget never comes into
 * their bakes at all:
 *
 * | map | baked | bake |
 * |---|---:|---:|
 * | `oa_dm4` | 0.92 MB | ~2 min |
 * | `oa_dm1` | 1.12 MB (32,074 probes) | 3 min |
 * | `oa_dm5` | 1.13 MB | ~3 min |
 * | `aggressor` | 1.75 MB | ~3 min |
 * | `oa_dm7` | 2.90 MB (83,490 probes) | 5 min |
 *
 * `am_thornish` is the sixth and is the only map the ceiling is ever asked
 * about. It wants a fourth level -- 0.62 m probes, which is the grade this port
 * is after -- and that level is all-or-nothing at **601,000 probes and a
 * 57-minute bake**, which is what it reached at the 32 MB this was first set
 * to. Those probes are 16 MB of payload before a single node, so the ceiling
 * that would buy them is somewhere between about 20 MB and the 32 that produced
 * them -- twice over the limit this asset is held to either way. Eight bought
 * the purge instead: depth 3, 49,924 probes, 1.73 MB. Ten buys the same purge,
 * so `am_thornish` stays at 1.85 m probes, a whole character rather than half
 * of one.
 *
 * That is the trade this constant records: within 10 MB, five maps at 0.77-1.00
 * m and the sixth at 1.85 m. Raising it to 10 from 8 is headroom and an
 * intention, not a change of output; the five are unaffected either way, which
 * is checked rather than assumed -- re-baking `oa_dm7`, the closest to the cap,
 * returned a byte-identical file at 8 MB after 32.
 */
export const LIGHTMAP_MEMORY_BUDGET = 10 * 1024 * 1024;

/** The part of `EntityComponentDataset` this file uses. */
interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/**
 * Load a map's baked volumetric lightmap, or null if it has none.
 *
 * A missing file is not an error, for the same reason a missing probe field is
 * not: the bake is a separate step over an asset tree, and a checkout that has
 * not run it should render on the environment map rather than fail to start.
 * The caller says which of the two happened, and only turns Brick4 on when
 * there is something for it to read.
 *
 * @param baseUrl e.g. `/assets/built/oa_dm1`
 */
export async function loadVolumetricLightMap(baseUrl: string): Promise<VolumetricLightMap | null> {
    /*
     `fetchOptionalBinary` rather than a `response.ok` check, and its docblock
     has this exact file as the worked example: the dev server answers a missing
     asset with 418 bytes of `index.html` at status 200, which read as a
     lightmap turns Brick4 on over an HTML document.

     An empty file resolves to null there too, which is the other case worth
     keeping apart: `volumetric_light_map_payload` turns a zero-length buffer
     into the empty structure, which lights nothing and looks exactly like a map
     that has none. Null sends the caller down the "no lightmap" path, which
     says so.
    */
    const data = await fetchOptionalBinary(`${baseUrl}/${LIGHTMAP_FILE}`);
    if (data === null) return null;

    const map = new VolumetricLightMap();
    map.data = data;

    return map;
}

/**
 * Hang the map on an entity, which is how `VolumetricLightMapSystem3` finds it.
 *
 * One per scene: the system takes the first component to link and makes the
 * rest wait, so this is called once per level load.
 */
export function attachVolumetricLightMap(ecd: EcsDataset, map: VolumetricLightMap): number {
    if (!ecd.isComponentTypeRegistered(VolumetricLightMap)) {
        ecd.registerComponentType(VolumetricLightMap);
    }

    const entity = new Entity();
    entity.add(map).build(ecd);

    return entity.id;
}

/** The part of `Brick4IntermediateNode` {@link brick4ProbeSpacing} walks. */
interface Brick4TreeNode {
    readonly bounds: { readonly x0: number; readonly x1: number };
    readonly depth: number;
    /** Absent on a leaf, and sparse: an unexpanded slot is `undefined`. */
    readonly children?: ArrayLike<Brick4TreeNode | undefined>;
}

/**
 * The finest probe spacing a built tree actually holds, in scene metres.
 *
 * Measured off the hierarchy rather than derived from
 * {@link LIGHTMAP_CELL_SIZE}, because those are not the same number and the
 * gap between them is where the quiet failures are. The cell size is a
 * stopping rule and the spacing it yields is quantised to `E / 3^n`; on top of
 * that, `purge_partial_depths` deletes the whole deepest level after the fact
 * when {@link LIGHTMAP_MEMORY_BUDGET} could not finish it. A bake that came
 * out three times coarser than intended produces a valid file, a lit level and
 * no complaint -- `am_thornish` is exactly that map -- so the bake reports the
 * grade it reached rather than the one it asked for.
 *
 * A node of side S carries a `BRICK4_PROBE_RESOLUTION`-cubed probe grid spanning
 * it corner to corner, so its probes sit S/3 apart; the deepest surviving node
 * is the finest grade anywhere in the map.
 */
export function brick4ProbeSpacing(root: Brick4TreeNode): number {
    let deepest = root;

    const stack: Brick4TreeNode[] = [root];

    while (stack.length > 0) {
        const node = stack.pop()!;

        if (node.depth > deepest.depth) deepest = node;

        const children = node.children;
        if (children === undefined) continue;

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child !== undefined) stack.push(child);
        }
    }

    return (deepest.bounds.x1 - deepest.bounds.x0) / (BRICK4_PROBE_RESOLUTION - 1);
}

export interface LightMapBake {
    readonly bytes: ArrayBuffer;
    readonly probes: number;
    readonly milliseconds: number;
    /** What {@link brick4ProbeSpacing} measured on the tree that was baked. */
    readonly probeSpacing: number;
}

/** The parts of `GraphicsEngine3` and `Renderer` the bake reaches for. */
interface BakeHost {
    readonly renderer: {
        readonly graphics: unknown;
        readonly scenes: { obtain(scene: unknown): unknown };
    };
}

/**
 * Bake the scene's volumetric lightmap on the GPU.
 *
 * The three steps `brick4_bake_for_scene` runs, minus its fourth: that helper
 * ends by handing the result to `downloadAsFile`, which is right for someone
 * poking at a scene in a console and wrong for a step that writes six maps to
 * disk in a row. Everything above it is the engine's, called in the engine's
 * order.
 *
 *  1. a `StaticSceneBVH` over the scene, which the tree builder places probes
 *     against and the tracer intersects;
 *  2. `brick4_generate_tree_from_scene`, which subdivides toward the geometry
 *     until it reaches the memory budget;
 *  3. `brick4_bake_basic`, the compute pass -- and the reason this is not a Node
 *     tool. It traces several bounces at tens of thousands of samples per probe,
 *     and its own quality profile is hardcoded to ULTRA.
 *
 * PRECONDITION: a device exists. `renderer.scenes.obtain` builds the scene
 * context if it has to, but there is nothing to build one on before the engine
 * has started.
 */
export async function bakeVolumetricLightMap(
    graphics: BakeHost,
    scene: unknown,
    cellSize: number = LIGHTMAP_CELL_SIZE
): Promise<LightMapBake> {
    const t0 = performance.now();

    const bvh = new StaticSceneBVH();
    bvh.build(scene);

    const tree = brick4_generate_tree_from_scene({
        scene,
        bvh,
        cell_size: cellSize,
        max_memory_usage_bytes: LIGHTMAP_MEMORY_BUDGET,
    });

    const renderer = graphics.renderer;
    const sceneContext = renderer.scenes.obtain(scene);

    const probeData = await brick4_bake_basic({
        brick4: tree,
        graphics: renderer.graphics,
        bvh,
        scene: sceneContext,
    });

    const bytes = brick4_to_gpu_structure(tree, probeData) as ArrayBuffer;

    return {
        bytes,
        probes: probeData.length / BRICK4_PROBE_ENCODED_SIZE,
        milliseconds: performance.now() - t0,
        probeSpacing: brick4ProbeSpacing(tree as Brick4TreeNode),
    };
}

/**
 * Hand the bytes to the dev server, which writes them next to the map.
 *
 * `POST /__bake/<map>/<file>`, which exists only in the vite config and only in
 * dev. The alternative is `downloadAsFile` and then moving six files out of the
 * downloads folder by hand, which is the sort of step that gets done four times
 * out of six.
 */
export async function postBake(mapName: string, bytes: ArrayBuffer): Promise<string> {
    const response = await fetch(`/__bake/${mapName}/${LIGHTMAP_FILE}`, {
        method: 'POST',
        body: bytes,
    });

    if (!response.ok) {
        throw new Error(`/__bake/${mapName}: HTTP ${response.status}`);
    }

    return response.text();
}
