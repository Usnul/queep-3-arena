/*
 * loadMap.ts -- instantiate a converted Q3 map as meep ECS entities.
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
 * One `ShadedGeometry` entity per material group, one `Light` entity per
 * reconstructed emitter. Nothing here is Q3-specific beyond the bundle format --
 * it is the smallest amount of code that turns the pipeline's output into
 * something meep draws.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ShadedGeometryFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometryFlags.js';
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';

import { meshlet_geometry_build_from_geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/meshlet_geometry_build_from_geometry.js';

import type { SceneBundle } from './SceneBundle.ts';
import { buildMaterials, buildGeometry } from './bundle.ts';

export interface LoadedMap {
    readonly bundle: SceneBundle;
    readonly meshEntities: readonly number[];
    /** BSP model index -> the transforms of its drawn meshes. Model 0 is absent. */
    readonly submodelTransforms: ReadonlyMap<number, readonly Transform[]>;
    /**
     * The entities those transforms belong to, in the same order.
     *
     * A mover's geometry is written from the simulation on the fixed step, so
     * anything that wants it blended at render rate needs the entity to hang an
     * `Interpolated` on -- and this loop is the only place that knows which
     * entity a moving transform came from.
     */
    readonly submodelEntities: ReadonlyMap<number, readonly number[]>;
    readonly lightEntities: readonly number[];
    readonly timings: Readonly<Record<string, number>>;
}

/** Anything with the ECS surface `loadMap` needs; meep types this as `any`. */
interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/**
 * Load a converted map into the given ECS dataset.
 *
 * @param baseUrl e.g. `/assets/built/oa_dm1`
 */
export async function loadMap(ecd: EcsDataset, baseUrl: string): Promise<LoadedMap> {
    const t0 = performance.now();

    const [bundle, geometryBuffer] = await Promise.all([
        fetch(`${baseUrl}/scene.json`).then((r) => {
            if (!r.ok) throw new Error(`${baseUrl}/scene.json: HTTP ${r.status}`);
            return r.json() as Promise<SceneBundle>;
        }),
        fetch(`${baseUrl}/geometry.bin`).then((r) => {
            if (!r.ok) throw new Error(`${baseUrl}/geometry.bin: HTTP ${r.status}`);
            return r.arrayBuffer();
        }),
    ]);

    const tFetched = performance.now();

    const vertices = new Float32Array(geometryBuffer, 0, bundle.vertexBytes / 4);
    const indices = new Uint32Array(geometryBuffer, bundle.vertexBytes, bundle.indexBytes / 4);

    if (!ecd.isComponentTypeRegistered(ShadedGeometry)) ecd.registerComponentType(ShadedGeometry);
    if (!ecd.isComponentTypeRegistered(Transform)) ecd.registerComponentType(Transform);
    if (!ecd.isComponentTypeRegistered(Light)) ecd.registerComponentType(Light);

    const materials = await buildMaterials(bundle, baseUrl);
    const tMaterials = performance.now();

    const meshEntities: number[] = [];

    /*
     Which meshes belong to a *moving* BSP model, so they can be given their own
     transform. Older bundles have no `submodels` table, in which case every
     mesh is world geometry -- which is what the loader assumed before movers
     existed, so the fallback is the previous behaviour rather than a failure.
    */
    const movingMesh = new Map<number, number>();
    for (const submodel of bundle.submodels ?? []) {
        if (submodel.model === 0) continue;
        for (const mesh of submodel.meshes) movingMesh.set(mesh, submodel.model);
    }

    const submodelTransforms = new Map<number, Transform[]>();
    const submodelEntities = new Map<number, number[]>();

    for (let i = 0; i < bundle.meshes.length; i++) {
        const mesh = bundle.meshes[i]!;
        const material = materials[mesh.material];
        if (material === undefined) continue;

        const geometry = buildGeometry(
            vertices,
            indices,
            bundle.vertexStride,
            mesh,
            `${bundle.name}:${material.name}`
        );

        const meshlet = meshlet_geometry_build_from_geometry(geometry);
        const shaded = ShadedGeometry.from(meshlet, material);

        const transform = new Transform();
        const model = movingMesh.get(i);

        if (model !== undefined) {
            /*
             A door's transform is written on every frame it is moving, position
             only. GAP-008's docblock on this flag is explicit about the trade:
             set it when a transform is written more than once between reads,
             leave it off when it is written exactly once. A mover is the first
             case while it is in motion and the second while it is at rest, and
             an idle flush is one length test, so the flag wins on balance.
            */
            shaded.setFlag(ShadedGeometryFlags.DeferredBoundsUpdate);

            const list = submodelTransforms.get(model) ?? [];
            list.push(transform);
            submodelTransforms.set(model, list);
        }

        const builder = new Entity();
        builder.add(transform).add(shaded).build(ecd);

        if (model !== undefined) {
            const owners = submodelEntities.get(model) ?? [];
            owners.push(builder.id);
            submodelEntities.set(model, owners);
        }

        meshEntities.push(builder.id);
    }

    const tGeometry = performance.now();

    const lightEntities: number[] = [];

    for (const l of bundle.lights) {
        const light = new Light();
        light.type.set(LightType.POINT);
        /*
         Tungsten unless the light carries its own. The default is what a
         `q3map_surfacelight` gets: the directive is a scalar and the shader has
         no colour to give. A lightgrid light does carry one -- q3map2 baked the
         colour arriving at each cell -- so a red room stays red.
        */
        const c = l.color;
        if (c === undefined) light.color.setRGB(1, 0.94, 0.85);
        else light.color.setRGB(c[0]!, c[1]!, c[2]!);
        /*
         `PointLight.intensity` is candela and `intensity_lumens` is lumens, with
         `cd = lm / 4pi` for an isotropic source. The ECS `Light` component
         exposes only the candela field, so the conversion is done here rather
         than reaching past the component to Shade's own light object.
        */
        light.intensity.set(l.lumens / (4 * Math.PI));
        light.distance.set(l.radius);
        /*
         `l.sourceRadius` -- how big the emitter is, as against how far it
         reaches -- cannot be set here: the component has no field for it and
         Shade's own light is private to `LightSystem3` (GAP-030). It is applied
         to the renderer's lights afterwards, by `applyLightVolumes`.
        */
        // Shadow-casting point lights are the expensive kind and a Q3 arena has
        // dozens. Static shadowing came from the lightmaps that q3map2 baked;
        // these lights exist to reproduce the *look*, and the sun casts the
        // shadows that read.
        light.castShadow.set(false);

        const transform = new Transform();
        transform.position.set(l.x, l.y, l.z);

        const builder = new Entity();
        builder.add(transform).add(light).build(ecd);

        lightEntities.push(builder.id);
    }

    if (bundle.sun !== null) {
        const sun = new Light();
        sun.type.set(LightType.DIRECTION);
        sun.color.setRGB(
            bundle.sun.color[0] ?? 1,
            bundle.sun.color[1] ?? 1,
            bundle.sun.color[2] ?? 1
        );
        sun.intensity.set(bundle.sun.intensity);
        sun.castShadow.set(true);

        const transform = new Transform();
        // A directional light is oriented by its transform; position is only used
        // to keep it inside the world bounds for shadow fitting.
        transform.position.set(0, 2048, 0);

        const builder = new Entity();
        builder.add(transform).add(sun).build(ecd);
        lightEntities.push(builder.id);
    }

    const tLights = performance.now();

    return {
        bundle,
        meshEntities,
        submodelTransforms,
        submodelEntities,
        lightEntities,
        timings: {
            fetch: tFetched - t0,
            materials: tMaterials - tFetched,
            geometry: tGeometry - tMaterials,
            lights: tLights - tGeometry,
            total: tLights - t0,
        },
    };
}
