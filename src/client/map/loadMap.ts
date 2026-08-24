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
import { Light } from '@woosh/meep-engine/src/engine/graphics/ecs/light/Light.js';
import { LightType } from '@woosh/meep-engine/src/engine/graphics/ecs/light/LightType.js';
import { Color } from '@woosh/meep-engine/src/core/color/Color.js';

import { Geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/Geometry.js';
import { Attribute } from '@woosh/meep-engine/src/shade/renderer/geometry/Attribute.js';
import { StandardAttributes } from '@woosh/meep-engine/src/shade/renderer/geometry/StandardAttributes.js';
import { meshlet_geometry_build_from_geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/meshlet_geometry_build_from_geometry.js';
import { StandardShadeMaterial } from '@woosh/meep-engine/src/shade/renderer/material/StandardShadeMaterial.js';
import { TransparencyMode } from '@woosh/meep-engine/src/shade/renderer/material/TransparencyMode.js';
import { ShadeTexture } from '@woosh/meep-engine/src/shade/renderer/texture/ShadeTexture.js';
import { ShadeImage } from '@woosh/meep-engine/src/shade/renderer/texture/source/ShadeImage.js';

import type { SceneBundle, BundleMaterial } from './SceneBundle.ts';

export interface LoadedMap {
    readonly bundle: SceneBundle;
    readonly meshEntities: readonly number[];
    readonly lightEntities: readonly number[];
    readonly timings: Readonly<Record<string, number>>;
}

/** Anything with the ECS surface `loadMap` needs; meep types this as `any`. */
interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

async function loadTexture(url: string): Promise<ShadeTexture> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });

    return ShadeTexture.from(ShadeImage.fromImageBitmap(bitmap));
}

function transparencyOf(material: BundleMaterial): number {
    switch (material.transparency) {
        case 'mask':
            return TransparencyMode.AlphaTested;
        case 'blend':
            return TransparencyMode.Transparent;
        default:
            return TransparencyMode.Opaque;
    }
}

/**
 * Build the meep materials for a bundle.
 *
 * Textures load concurrently and a failure downgrades that one slot rather than
 * failing the map: a level with one missing texture should render with one flat
 * surface, not not at all.
 */
async function buildMaterials(
    bundle: SceneBundle,
    baseUrl: string
): Promise<StandardShadeMaterial[]> {
    const textureCache = new Map<string, Promise<ShadeTexture | null>>();

    const get = (virtualPath: string | null): Promise<ShadeTexture | null> => {
        if (virtualPath === null) return Promise.resolve(null);

        const file = bundle.textures[virtualPath];
        if (file === undefined || file === null || file === '') return Promise.resolve(null);

        let p = textureCache.get(file);
        if (p === undefined) {
            p = loadTexture(`${baseUrl}/textures/${file}`).catch((e: unknown) => {
                console.warn(`[queep] texture ${file}: ${String(e)}`);
                return null;
            });
            textureCache.set(file, p);
        }
        return p;
    };

    return Promise.all(
        bundle.materials.map(async (m) => {
            const material = new StandardShadeMaterial();
            material.name = m.name;

            const [albedo, emissive] = await Promise.all([get(m.albedo), get(m.emissive)]);

            if (albedo !== null) material.texture_albedo = albedo;
            if (emissive !== null && m.emissiveIntensity > 0) {
                material.texture_emissive = emissive;
                material.emissive_factor = new Color(
                    m.emissiveIntensity,
                    m.emissiveIntensity,
                    m.emissiveIntensity
                );
            }

            material.roughness_factor = m.roughness;
            material.metallic_factor = m.metallic;
            material.transparency_mode = transparencyOf(m);

            return material;
        })
    );
}

/**
 * Slice one mesh out of the shared geometry buffer.
 *
 * The bundle stores every mesh's vertices in one `Float32Array` and every
 * mesh's indices in one `Uint32Array`, so this is a set of `subarray` views plus
 * a de-interleave into the separate attribute arrays meep wants. The copy is
 * unavoidable: `Attribute` holds one array per attribute, and the bundle is
 * interleaved because that is one HTTP request instead of five per mesh.
 */
function buildGeometry(
    vertices: Float32Array,
    indices: Uint32Array,
    stride: number,
    mesh: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number },
    name: string
): Geometry {
    const n = mesh.vertexCount;

    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uv0 = new Float32Array(n * 2);
    const uv1 = new Float32Array(n * 2);

    for (let i = 0; i < n; i++) {
        const o = (mesh.vertexOffset + i) * stride;

        positions[i * 3] = vertices[o]!;
        positions[i * 3 + 1] = vertices[o + 1]!;
        positions[i * 3 + 2] = vertices[o + 2]!;

        normals[i * 3] = vertices[o + 3]!;
        normals[i * 3 + 1] = vertices[o + 4]!;
        normals[i * 3 + 2] = vertices[o + 5]!;

        uv0[i * 2] = vertices[o + 6]!;
        uv0[i * 2 + 1] = vertices[o + 7]!;

        uv1[i * 2] = vertices[o + 8]!;
        uv1[i * 2 + 1] = vertices[o + 9]!;
    }

    const idx = new Uint32Array(mesh.indexCount);
    idx.set(indices.subarray(mesh.indexOffset, mesh.indexOffset + mesh.indexCount));

    const geometry = new Geometry();
    geometry.name = name;
    geometry.index = Attribute.from(idx, 1, 'index');
    geometry.addAttribute(Attribute.from(positions, 3, StandardAttributes.Position));
    geometry.addAttribute(Attribute.from(normals, 3, StandardAttributes.Normal));
    geometry.addAttribute(Attribute.from(uv0, 2, StandardAttributes.TextureCoordinates0));
    geometry.addAttribute(Attribute.from(uv1, 2, StandardAttributes.TextureCoordinates1));

    return geometry;
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

        const builder = new Entity();
        builder.add(new Transform()).add(ShadedGeometry.from(meshlet, material)).build(ecd);

        meshEntities.push(builder.id);
    }

    const tGeometry = performance.now();

    const lightEntities: number[] = [];

    for (const l of bundle.lights) {
        const light = new Light();
        light.type.set(LightType.POINT);
        light.color.setRGB(1, 0.94, 0.85);
        /*
         `PointLight.intensity` is candela and `intensity_lumens` is lumens, with
         `cd = lm / 4pi` for an isotropic source. The ECS `Light` component
         exposes only the candela field, so the conversion is done here rather
         than reaching past the component to Shade's own light object.
        */
        light.intensity.set(l.lumens / (4 * Math.PI));
        light.distance.set(l.radius);
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
