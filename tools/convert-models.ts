/*
 * convert-models.ts -- turn Quake III MD3 models into one meep-ready bundle.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Output, under `assets/built/models/`:
 *
 *   models.json     materials, per-model mesh tables, tags, statistics
 *   models.bin      interleaved vertices and indices for every mesh
 *   textures/*      referenced textures, TGA converted to PNG
 *
 * One bundle for every model rather than one file each. There are 78 item and
 * pickup models between them and they are all tiny; 78 HTTP requests to fetch
 * 1.6 MB is the wrong shape, and meshlet construction is on the critical path
 * (GAP-008) so batching the work also batches that cost into one place.
 *
 * Only frame 0 is read here. These are static props -- Q3 spins and bobs them
 * at draw time rather than animating vertices. Player models, which do animate,
 * go through `convert-characters.ts` instead.
 *
 * Usage:  node tools/convert-models.ts
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ShaderIndex } from './pipeline/shader-index.ts';
import {
    parseMd3,
    normaliseShaderName,
    drawableSurfaces,
    type Md3Model,
    type Md3Surface,
} from './pipeline/md3.ts';
import {
    textureCache as newTextureCache,
    textureCounts,
    textureKey,
    writeTexture,
    type TextureCache,
} from './pipeline/texture-out.ts';
import type { PbrMaterial } from './pipeline/shader-to-pbr.ts';
import type {
    BundleMaterial,
    BundleMesh,
    ModelBundle,
    BundleModel,
} from '../src/client/map/SceneBundle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');

/** Matches `convert-map.ts`, so the runtime's geometry builder is shared. */
const OUT_STRIDE = 12; // position(3) normal(3) uv(2) uv1(2) colour(2, unused)

/*
 * Q3 is Z-up; meep is Y-up. `(x, y, z) -> (x, z, -y)`, determinant +1, so
 * winding is preserved and indices pass through untouched. Identical to the map
 * converter's, and deliberately duplicated rather than shared: if these two ever
 * need to differ, a shared helper would make the divergence invisible.
 */
function q3ToMeep(x: number, y: number, z: number): [number, number, number] {
    return [x, z, -y];
}

interface Accum {
    readonly vertices: number[];
    readonly indices: number[];
    vertexCursor: number;
    indexCursor: number;
}

interface BalanceItem {
    readonly type: string;
    readonly tag: string;
    readonly models: string[];
}

function balanceItems(): readonly BalanceItem[] {
    const balance = JSON.parse(
        readFileSync(join(ROOT, 'src', 'game', 'balance.generated.json'), 'utf8')
    ) as { items: BalanceItem[] };

    return balance.items;
}

/** Every model an item can spawn, from the generated balance table. */
function itemModelPaths(): string[] {
    const seen = new Set<string>();
    for (const item of balanceItems()) {
        for (const m of item.models) {
            if (m.toLowerCase().endsWith('.md3')) seen.add(m.replace(/\\/g, '/'));
        }
    }

    return [...seen].sort();
}

/**
 * The hands models, which carry no geometry and are converted for one number.
 *
 * `CG_RegisterWeapon` builds the path by swapping the weapon's world model's
 * extension for `_hand.md3`, and `CG_AddViewWeapon` draws that at the view
 * origin and hangs the weapon off its `tag_weapon`. So that tag *is* where a Q3
 * first-person weapon sits relative to the eye, per weapon, measured rather than
 * guessed -- which is the only reason these are here. OpenArena's are
 * surface-less: the arms Q3 shipped are gone and what is left is the tag and the
 * animation frames.
 *
 * Six of the thirteen weapons ship none, and that is not a defect: the C falls
 * back to `models/weapons2/shotgun/shotgun_hand.md3` for exactly that case, and
 * so does `ViewWeapon`. They are therefore filtered here rather than reported as
 * missing -- an expected absence in the `missing` list is noise in a list whose
 * whole job is to be read.
 */
function handModelPaths(): { paths: string[]; fallbacks: string[] } {
    const paths = new Set<string>();
    const fallbacks: string[] = [];

    for (const item of balanceItems()) {
        if (item.type !== 'IT_WEAPON') continue;

        const world = (item.models[0] ?? '').replace(/\\/g, '/');
        if (!world.toLowerCase().endsWith('.md3')) continue;

        const hand = `${world.slice(0, -'.md3'.length)}_hand.md3`;

        if (existsSync(join(EXTRACTED, hand))) paths.add(hand);
        else fallbacks.push(item.tag);
    }

    return { paths: [...paths].sort(), fallbacks };
}

/**
 * Extra models the item table does not name.
 *
 * Gibs are referenced from `g_combat.c` by hand rather than through
 * `bg_itemlist`, and the teleporter effect from `cg_ents.c`. Four models that
 * `bg_itemlist` *does* name are absent from OA's pk3s -- the "sphere" shells
 * Q3 drew around some pickups, plus `porter.md3`. Those are reported as
 * missing rather than filtered out, because a silently-shorter item list is
 * exactly the kind of thing that presents later as "why is there no medkit".
 */
const EXTRA_MODELS: readonly string[] = [
    'models/gibs/abdomen.md3',
    'models/gibs/arm.md3',
    'models/gibs/brain.md3',
    'models/gibs/chest.md3',
    'models/gibs/fist.md3',
    'models/gibs/foot.md3',
    'models/gibs/forearm.md3',
    'models/gibs/intestine.md3',
    'models/gibs/leg.md3',
    'models/gibs/skull.md3',
    'models/misc/telep.md3',
];

function toBundleMaterial(
    name: string,
    pbr: PbrMaterial,
    albedo: string | null,
    emissive: string | null
): BundleMaterial {
    return {
        name,
        albedo,
        albedoBlend: pbr.albedoBlend,
        emissive,
        emissiveIntensity: pbr.emissiveIntensity ?? 0,
        roughness: pbr.roughness,
        metallic: pbr.metallic,
        transparency: pbr.transparency,
        alphaCutoff: pbr.alphaCutoff,
        doubleSided: pbr.doubleSided,
        surfaceLight: pbr.surfaceLight ?? 0,
    };
}

function appendSurface(
    accum: Accum,
    surface: Md3Surface,
    materialIndex: number
): BundleMesh {
    const positions = surface.positions[0]!;
    const normals = surface.normals[0]!;

    const vertexOffset = accum.vertexCursor;
    const indexOffset = accum.indexCursor;

    for (let i = 0; i < surface.numVerts; i++) {
        const [x, y, z] = q3ToMeep(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
        const [nx, ny, nz] = q3ToMeep(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);

        accum.vertices.push(
            x, y, z,
            nx, ny, nz,
            // MD3 stores V the same way Q3's BSP does: increasing downward.
            surface.st[i * 2]!, 1 - surface.st[i * 2 + 1]!,
            surface.st[i * 2]!, 1 - surface.st[i * 2 + 1]!,
            1, 1
        );
    }

    // Reversed: MD3 winds clockwise from the front, glTF counter-clockwise.
    // Measured at 0 of 204 agreeing on `rocketl.md3`. Same convention as the
    // BSP and as `brushHull.ts`.
    for (let i = 0; i + 2 < surface.indices.length; i += 3) {
        accum.indices.push(surface.indices[i]!, surface.indices[i + 2]!, surface.indices[i + 1]!);
    }

    accum.vertexCursor += surface.numVerts;
    accum.indexCursor += surface.indices.length;

    return {
        material: materialIndex,
        vertexOffset,
        vertexCount: surface.numVerts,
        indexOffset,
        indexCount: surface.indices.length,
    };
}

async function convertModels(): Promise<void> {
    const index = new ShaderIndex(EXTRACTED).load();

    const outDir = join(BUILT, 'models');
    const textureDir = join(outDir, 'textures');
    mkdirSync(textureDir, { recursive: true });

    const hands = handModelPaths();
    const paths = [...new Set([...itemModelPaths(), ...hands.paths, ...EXTRA_MODELS])].sort();

    const accum: Accum = { vertices: [], indices: [], vertexCursor: 0, indexCursor: 0 };

    const materials: BundleMaterial[] = [];
    const materialByShader = new Map<string, number>();
    const textures: Record<string, string | null> = {};
    const textureCache: TextureCache = newTextureCache();

    const models: BundleModel[] = [];
    const missingModels: string[] = [];
    let untexturedSurfaces = 0;

    for (const virtualPath of paths) {
        const diskPath = join(EXTRACTED, virtualPath);
        if (!existsSync(diskPath)) {
            missingModels.push(virtualPath);
            continue;
        }

        const raw = readFileSync(diskPath);
        let md3: Md3Model;
        try {
            md3 = parseMd3(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                virtualPath
            );
        } catch (e) {
            console.warn(`  ${virtualPath}: ${(e as Error).message}`);
            missingModels.push(virtualPath);
            continue;
        }

        const meshes: BundleMesh[] = [];
        const surfaces = drawableSurfaces(md3);

        for (let s = 0; s < surfaces.length; s++) {
            const surface = surfaces[s]!;
            const shaderName = normaliseShaderName(surface.shaders[0] ?? surface.name);

            let materialIndex = materialByShader.get(shaderName);
            if (materialIndex === undefined) {
                const pbr = index.material(shaderName);

                /*
                 Same arrangement as the map bundle: a material names its
                 textures by `textureKey`, because one image restated for two
                 different Q3 blends is two files. An item's additive shell --
                 the quad aura, the invisibility shimmer, the BFG's tube -- is
                 exactly the case where the albedo and the emissive are the same
                 image written two ways.
                */
                let albedoKey: string | null = null;
                if (pbr.albedo !== null) {
                    albedoKey = textureKey(pbr.albedo, pbr.albedoBlend);
                    textures[albedoKey] = await writeTexture(
                        index,
                        EXTRACTED,
                        pbr.albedo,
                        textureDir,
                        textureCache,
                        pbr.albedoBlend
                    );
                    if (textures[albedoKey] === null) albedoKey = null;
                }
                if (albedoKey === null) untexturedSurfaces += 1;

                let emissiveKey: string | null = null;
                if (pbr.emissive !== null && pbr.emissiveIntensity > 0) {
                    emissiveKey = pbr.emissive;
                    textures[emissiveKey] = await writeTexture(
                        index,
                        EXTRACTED,
                        pbr.emissive,
                        textureDir,
                        textureCache,
                        'opaque'
                    );
                    if (textures[emissiveKey] === null) emissiveKey = null;
                }

                materialIndex = materials.length;
                materials.push(toBundleMaterial(shaderName, pbr, albedoKey, emissiveKey));
                materialByShader.set(shaderName, materialIndex);
            }

            meshes.push(appendSurface(accum, surface, materialIndex));
        }

        const frame = md3.frames[0];

        models.push({
            name: virtualPath,
            meshes,
            /*
             Frame bounds in *meep* axes, so `min`/`max` still bracket the model
             after the axis swap: -y maps to z, which flips the pair.
            */
            mins: frame === undefined ? [0, 0, 0] : [frame.mins[0], frame.mins[2], -frame.maxs[1]],
            maxs: frame === undefined ? [0, 0, 0] : [frame.maxs[0], frame.maxs[2], -frame.mins[1]],
            radius: frame?.radius ?? 0,
            tags: (md3.tags[0] ?? []).map((t) => ({
                name: t.name,
                origin: [t.origin[0], t.origin[2], -t.origin[1]],
            })),
        });
    }

    /* ---- write ---- */

    const vertexData = new Float32Array(accum.vertices);
    const indexData = new Uint32Array(accum.indices);

    const blob = new Uint8Array(vertexData.byteLength + indexData.byteLength);
    blob.set(new Uint8Array(vertexData.buffer), 0);
    blob.set(new Uint8Array(indexData.buffer), vertexData.byteLength);
    writeFileSync(join(outDir, 'models.bin'), blob);

    const bundle: ModelBundle = {
        name: 'models',
        generator: 'queep-3-arena tools/convert-models.ts',
        coordinateSystem: 'Y-up, right-handed; Q3 units (unscaled, see D-011)',
        vertexStride: OUT_STRIDE,
        vertexLayout: ['position:3', 'normal:3', 'uv0:2', 'uv1:2', 'color_rg:2'],
        vertexBytes: vertexData.byteLength,
        indexBytes: indexData.byteLength,
        materials,
        textures,
        models,
        stats: {
            models: models.length,
            missing: missingModels.length,
            meshes: models.reduce((n, m) => n + m.meshes.length, 0),
            vertices: accum.vertexCursor,
            triangles: accum.indexCursor / 3,
            materials: materials.length,
            texturesWritten: textureCounts(textureCache).written,
            untexturedSurfaces,
        },
    };

    writeFileSync(join(outDir, 'models.json'), JSON.stringify(bundle, null, 1));

    console.log(
        `models: ${bundle.stats['models']} models, ${bundle.stats['meshes']} meshes, ` +
        `${bundle.stats['triangles']} tris, ${bundle.stats['materials']} materials, ` +
        `${bundle.stats['texturesWritten']} textures` +
        (missingModels.length > 0 ? `\n  missing: ${missingModels.join(', ')}` : '') +
        (hands.fallbacks.length > 0
            ? `\n  no hands model, using the shotgun's tag_weapon (as the C does): ` +
              hands.fallbacks.join(', ')
            : '')
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await convertModels();
}
