/*
 * bundle.ts -- the parts of bundle loading that maps and models share.
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
 * Split out of `loadMap.ts` when the model bundle turned out to want exactly
 * the same material and geometry construction. `SceneBundle` and `ModelBundle`
 * deliberately share `BundleMaterial` and `BundleMesh` so this is a genuine
 * reuse rather than two similar-looking code paths.
 */

import { Color } from '@woosh/meep-engine/src/core/color/Color.js';
import { Geometry } from '@woosh/meep-engine/src/shade/renderer/geometry/Geometry.js';
import { Attribute } from '@woosh/meep-engine/src/shade/renderer/geometry/Attribute.js';
import { StandardAttributes } from '@woosh/meep-engine/src/shade/renderer/geometry/StandardAttributes.js';
import { StandardShadeMaterial } from '@woosh/meep-engine/src/shade/renderer/material/StandardShadeMaterial.js';
import { TransparencyMode } from '@woosh/meep-engine/src/shade/renderer/material/TransparencyMode.js';
import { ShadeDrawSide } from '@woosh/meep-engine/src/shade/renderer/material/ShadeDrawSide.js';
import { ShadeTexture } from '@woosh/meep-engine/src/shade/renderer/texture/ShadeTexture.js';
import { ShadeImage } from '@woosh/meep-engine/src/shade/renderer/texture/source/ShadeImage.js';
import { ColorSpace } from '@woosh/meep-engine/src/shade/renderer/texture/ColorSpace.js';
import { TextureFilterType } from '@woosh/meep-engine/src/shade/renderer/texture/TextureFilterType.js';

import type { BundleMaterial } from './SceneBundle.ts';

/** The part of a bundle the material builder needs; both bundle kinds have it. */
export interface MaterialSource {
    readonly materials: readonly BundleMaterial[];
    readonly textures: Readonly<Record<string, string | null>>;
}

/**
 * Load one texture, saying whether its pixels are a colour or a measurement.
 *
 * `data` is the normal and ORM maps. Two things change for them, and both are
 * what meep's own glTF loader does for the same two slots:
 *
 * - **`ColorSpace.None`.** `ShadeImage` defaults to `LinearSRGB`, which lands on
 *   the same `rgba8unorm` format -- but `texture_write_to_gpu` premultiplies
 *   anything that is not `None`. These maps are written with alpha at 255 so the
 *   multiply is by one either way; saying `None` states the intent rather than
 *   relying on that.
 * - **`LinearNormal` mip generation.** Averaging two unit normals gives a
 *   shorter one, so a colour filter down a mip chain flattens a normal map
 *   towards no perturbation at exactly the distances most of the surface is
 *   seen from. The ORM keeps the colour filter: roughness and metalness are
 *   scalars and average honestly.
 */
export async function loadTexture(url: string, kind: 'color' | 'normal' | 'data' = 'color'): Promise<ShadeTexture> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });

    const texture = ShadeTexture.from(ShadeImage.fromImageBitmap(bitmap));

    if (kind !== 'color') {
        texture.image.color_space = ColorSpace.None;
        if (kind === 'normal') texture.mipmapGenerationFilter = TextureFilterType.LinearNormal;
    }

    return texture;
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
export async function buildMaterials(
    bundle: MaterialSource,
    baseUrl: string
): Promise<StandardShadeMaterial[]> {
    const textureCache = new Map<string, Promise<ShadeTexture | null>>();

    /*
     A material names a texture by *key*, not by path: a path most of the time,
     but a path plus `#<blend>` when the pipeline had to write the same image
     more than one way (D-083). The runtime only ever looks it up, so the
     distinction costs nothing here beyond calling it what it is.
    */
    const get = (
        key: string | null | undefined,
        kind: 'color' | 'normal' | 'data' = 'color'
    ): Promise<ShadeTexture | null> => {
        if (key === null || key === undefined) return Promise.resolve(null);

        const file = bundle.textures[key];
        if (file === undefined || file === null || file === '') return Promise.resolve(null);

        let p = textureCache.get(file);
        if (p === undefined) {
            p = loadTexture(`${baseUrl}/textures/${file}`, kind).catch((e: unknown) => {
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

            const [albedo, emissive, normal, orm] = await Promise.all([
                get(m.albedo),
                get(m.emissive),
                get(m.normal, 'normal'),
                get(m.orm, 'data'),
            ]);

            if (albedo !== null) material.texture_albedo = albedo;

            /*
             meep reads coverage out of the albedo texture's alpha --
             `surface_alpha = t_diffuse.a * albedo_color.a` -- so a blended
             material with no albedo texture samples the white default at alpha
             1 and draws as a solid white box that also poisons the OIT
             accumulation around it. That is what `textures/sfx/beam` looked
             like on `oa_dm1` before the pipeline learned to write additive
             images as coverage.

             The pipeline should not produce one any more and
             `materials.test.ts` asserts over every bundle that it does not, but
             the failure is bad enough, and the right answer obvious enough, to
             state here as well: an effect surface whose image could not be
             resolved adds nothing, so draw nothing.
            */
            if (albedo === null && m.transparency === 'blend') {
                material.diffuse_color = new Color(1, 1, 1, 0);
                console.warn(`[queep] ${m.name}: blended with no albedo texture; drawn as nothing`);
            }

            if (emissive !== null && m.emissiveLuminance > 0) {
                material.texture_emissive = emissive;
                material.emissive_factor = new Color(
                    m.emissiveLuminance,
                    m.emissiveLuminance,
                    m.emissiveLuminance
                );
            }

            if (normal !== null) material.texture_normal = normal;

            /*
             `roughness_factor` and `metallic_factor` are multipliers over the
             sampled ORM, not alternatives to it -- the g-buffer pass reads
             `orm_sample.g * roughness_factor` and `orm_sample.b *
             metallic_factor`, and with no texture bound `orm_sample` is meep's
             white default pixel. So the material's own numbers *are* the values
             while there is no ORM, and both have to go to one the moment there
             is: leaving `metallic` at 0 would multiply every metal in the map
             back to a dielectric, and leaving `roughness` at 0.85 would scale a
             measured 0.3 to 0.26 for no reason anyone could later reconstruct.

             The R channel is written at 1.0, which is what the default pixel
             holds, so `ambient_factors` sees exactly what it saw before. GTAO
             derives occlusion from the g-buffer shading normal, and that normal
             now has the normal map in it.
            */
            if (orm !== null) {
                material.texture_orm = orm;
                material.roughness_factor = 1;
                material.metallic_factor = 1;
            } else {
                material.roughness_factor = m.roughness;
                material.metallic_factor = m.metallic;
            }

            /*
             Glass and clear water, which are a transparent *interface* rather
             than a transparent image.

             `transmission_factor` takes the diffuse base out
             (`diffuse_weight = (1 - metallic) * (1 - transmission)`) and hands
             coverage to view-angle Fresnel instead of the albedo's alpha, so the
             pane is nearly invisible head-on and a bright reflection at a
             glancing one. `ior_factor` is what sets how bright: F0 = ((n - 1) /
             (n + 1))^2, so 0.04 for glass and 0.02 for water, and until this was
             plumbed every surface in the port sat on meep's 1.5 whether it was a
             window or a pool.

             Both are read through `??` rather than assigned unconditionally,
             because a bundle written before the pipeline emitted them carries
             neither, and meep's own defaults -- 0 and 1.5 -- are exactly the
             behaviour those bundles were built for. See `shader-to-pbr.ts`'s
             `TRANSMISSIVE` for why the set is a hand-checked list.
            */
            material.transmission_factor = m.transmission ?? material.transmission_factor;
            material.ior_factor = m.ior ?? material.ior_factor;

            material.transparency_mode = transparencyOf(m);

            /*
             `cull none` in a Q3 shader means both faces draw, and it is what
             flags, banners, beams and flame sprites rely on -- a flag rendered
             single-sided vanishes for half of every rotation. Five materials on
             `oa_dm1`, eight on `oa_dm5`.

             `ShadeDrawSide.Back` is the one to avoid: the glTF loader's own
             `fix_up_material_sides` handles it by flipping the geometry with
             `geometry_flip_normals` rather than by rendering it, and nothing
             does that for a hand-built material. Front and Double are the two
             usable values, which is all this port needs.
            */
            if (m.doubleSided) material.draw_side = ShadeDrawSide.Double;

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
export function buildGeometry(
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

