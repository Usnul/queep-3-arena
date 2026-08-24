/*
 * loadModels.ts -- the converted MD3 prop library.
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
 * One fetch for every static prop in the game, then meshlet geometry built
 * lazily on first use. Both halves of that are deliberate:
 *
 * - One fetch, because 76 models totalling 900 KB of geometry is a batching
 *   problem, not a streaming one.
 * - Lazy meshlets, because `meshlet_geometry_build_from_geometry` is
 *   synchronous and on the main thread (GAP-008). A typical arena places about
 *   30 distinct models; building all 113 meshes up front would spend most of
 *   that time on props the level never spawns.
 */

import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { meshlet_geometry_build_from_geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/meshlet_geometry_build_from_geometry.js';
import type { StandardShadeMaterial } from '@woosh/meep-engine/src/shade/renderer/material/StandardShadeMaterial.js';

import type { ModelBundle, BundleModel } from './SceneBundle.ts';
import { buildMaterials, buildGeometry } from './bundle.ts';

/** One drawable piece of a model: geometry plus the material it draws with. */
export interface ModelPart {
    readonly geometry: unknown;
    readonly material: StandardShadeMaterial;
}

export interface PreparedModel {
    readonly def: BundleModel;
    readonly parts: readonly ModelPart[];
}

export class ModelLibrary {
    readonly bundle: ModelBundle;

    private readonly vertices: Float32Array;
    private readonly indices: Uint32Array;
    private readonly materials: readonly StandardShadeMaterial[];
    private readonly byName = new Map<string, BundleModel>();
    private readonly prepared = new Map<string, PreparedModel>();

    /** Milliseconds spent in meshlet construction, for the performance section. */
    meshletMilliseconds = 0;

    constructor(
        bundle: ModelBundle,
        vertices: Float32Array,
        indices: Uint32Array,
        materials: readonly StandardShadeMaterial[]
    ) {
        this.bundle = bundle;
        this.vertices = vertices;
        this.indices = indices;
        this.materials = materials;

        for (const model of bundle.models) this.byName.set(model.name, model);
    }

    has(name: string): boolean {
        return this.byName.has(name);
    }

    definition(name: string): BundleModel | null {
        return this.byName.get(name) ?? null;
    }

    /**
     * Geometry and materials for one model, built on first request and cached.
     *
     * Returns `null` for a model the pipeline could not convert -- four of
     * `bg_itemlist`'s entries name files OA does not ship. A caller that spawns
     * items from map entities has to cope with that rather than throw, because
     * the map is entitled to reference them.
     */
    prepare(name: string): PreparedModel | null {
        const cached = this.prepared.get(name);
        if (cached !== undefined) return cached;

        const def = this.byName.get(name);
        if (def === undefined) return null;

        const t0 = performance.now();

        const parts: ModelPart[] = def.meshes.map((mesh, i) => ({
            geometry: meshlet_geometry_build_from_geometry(
                buildGeometry(
                    this.vertices,
                    this.indices,
                    this.bundle.vertexStride,
                    mesh,
                    `${name}#${i}`
                )
            ),
            material: this.materials[mesh.material]!,
        }));

        this.meshletMilliseconds += performance.now() - t0;

        const result: PreparedModel = { def, parts };
        this.prepared.set(name, result);
        return result;
    }

    /** `ShadedGeometry` components for one model, ready to add to entities. */
    components(name: string): ShadedGeometry[] | null {
        const model = this.prepare(name);
        if (model === null) return null;

        return model.parts.map((p) => ShadedGeometry.from(p.geometry, p.material));
    }
}

export async function loadModels(baseUrl: string): Promise<ModelLibrary> {
    const [bundle, geometryBuffer] = await Promise.all([
        fetch(`${baseUrl}/models.json`).then(async (r) => {
            if (!r.ok) throw new Error(`${baseUrl}/models.json: HTTP ${r.status}`);
            return (await r.json()) as ModelBundle;
        }),
        fetch(`${baseUrl}/models.bin`).then(async (r) => {
            if (!r.ok) throw new Error(`${baseUrl}/models.bin: HTTP ${r.status}`);
            return r.arrayBuffer();
        }),
    ]);

    const vertices = new Float32Array(geometryBuffer, 0, bundle.vertexBytes / 4);
    const indices = new Uint32Array(geometryBuffer, bundle.vertexBytes, bundle.indexBytes / 4);

    const materials = await buildMaterials(bundle, baseUrl);

    return new ModelLibrary(bundle, vertices, indices, materials);
}
