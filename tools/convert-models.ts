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

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ShaderIndex } from './pipeline/shader-index.ts';
import {
    parseMd3,
    normaliseShaderName,
    drawableSurfaces,
    type Md3Model,
    type Md3Surface,
    type Md3Tag,
} from './pipeline/md3.ts';
import {
    derivedTextureKey,
    textureCache as newTextureCache,
    textureCounts,
    textureKey,
    writeDerivedTexture,
    type TextureCache,
    writeTexture,
} from './pipeline/texture-out.ts';
import {
    agreementRatio,
    repairSurface,
    windingAgreement,
} from './pipeline/mesh-normals.ts';
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
/** Where `tools/generate-material-maps.ts` leaves the normal and ORM images. */
const MATERIAL_MAPS = join(ROOT, 'assets', 'generated', 'materials');

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

function normalise(v: readonly [number, number, number]): [number, number, number] {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * A tag's basis, as a quaternion in the axes the meshes were converted into.
 *
 * `md3Tag_t` stores three vectors -- forward, **left**, up -- expressed in the
 * parent model's own frame, and Q3 attaches a child by
 * `p = origin + Σ cᵢ · axis[i]`, which is the matrix whose *columns* are those
 * vectors. A converted mesh lives in meep axes, so what the runtime needs is
 * that rotation conjugated by the axis map: `M A M⁻¹`, whose columns work out
 * as `M·forward`, `M·up` and `-M·left` -- x forward, y up, z **right**, which
 * is exactly the frame `MODEL_TO_VIEW` documents the converted models in.
 *
 * The three rows are normalised first because `R_LerpTag` normalises them, and
 * OA needs it to: `gauntlet.md3` and `vulcan.md3` both ship a `tag_barrel`
 * whose basis is scaled by 1.8444, which the exporter left in and which Q3
 * throws away before it ever multiplies. Carrying it through would make the
 * gauntlet's blade almost twice the size of the gauntlet.
 */
function tagRotation(axis: Md3Tag['axis']): [number, number, number, number] {
    const forward = normalise(axis[0]);
    const left = normalise(axis[1]);
    const up = normalise(axis[2]);

    const [m00, m10, m20] = q3ToMeep(forward[0], forward[1], forward[2]);
    const [m01, m11, m21] = q3ToMeep(up[0], up[1], up[2]);
    const [nx, ny, nz] = q3ToMeep(left[0], left[1], left[2]);
    const [m02, m12, m22] = [-nx, -ny, -nz];

    // Shepperd: pivot on whichever of the four is largest, so the square root
    // is never taken of something near zero.
    const trace = m00 + m11 + m22;

    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    }

    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

interface Accum {
    readonly vertices: number[];
    readonly indices: number[];
    vertexCursor: number;
    indexCursor: number;
    /** What `repairSurface` had to do, for the stats block and the log. */
    readonly repairs: SurfaceRepair[];
}

interface SurfaceRepair {
    readonly model: string;
    readonly surface: string;
    readonly reoriented: number;
    readonly rewritten: number;
    readonly beforeRatio: number;
    readonly afterRatio: number;
}

/**
 * Below this share of triangles agreeing with their own normals, a surface is
 * re-derived from its geometry rather than trusted.
 *
 * Same number as `winding.test.ts`'s threshold, and for the same reason: Q3
 * content genuinely contains near-degenerate triangles that disagree with any
 * winding, so a few percent is authorship noise rather than a defect. Past that
 * it is a defect -- 25% of `nailgun.md3` disagrees, and the well-made models in
 * the same bundle sit at zero (D-140).
 */
const REPAIR_THRESHOLD = 0.95;

interface BalanceItem {
    readonly type: string;
    readonly tag: string;
    readonly models: string[];
}

function balance(): {
    items: BalanceItem[];
    missileModels: Record<string, string | null>;
} {
    return JSON.parse(
        readFileSync(join(ROOT, 'src', 'game', 'balance.generated.json'), 'utf8')
    ) as { items: BalanceItem[]; missileModels: Record<string, string | null> };
}

function balanceItems(): readonly BalanceItem[] {
    return balance().items;
}

/**
 * The models a projectile is drawn as, which are not in the item table.
 *
 * `bg_itemlist` names the gun on the floor and the box of ammunition for it, and
 * has nothing to say about the thing that comes *out* of the gun -- that is
 * `CG_RegisterWeapon`'s `missileModel`, extracted alongside the balance numbers
 * so the pipeline and the runtime cannot name different files. Seven of the
 * thirteen weapons have one; the rest are hitscan, or are the plasma gun, whose
 * bolt Q3 draws as a sprite. See `extract-balance.mjs`.
 */
function missileModelPaths(): string[] {
    const seen = new Set<string>();

    for (const path of Object.values(balance().missileModels)) {
        if (path !== null && path.toLowerCase().endsWith('.md3')) {
            seen.add(path.replace(/\\/g, '/'));
        }
    }

    return [...seen].sort();
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
 * The barrel models, which are the front half of five of the thirteen guns.
 *
 * `CG_RegisterWeapon` builds this path the same way it builds the hands one --
 * the world model's extension swapped for `_barrel.md3` -- and both
 * `CG_AddPlayerWeapon` and `CG_Item` hang the result off the weapon's own
 * `tag_barrel`. It is a *separate model* because Q3 spins it, and a converter
 * that reads `bg_itemlist` and stops sees no reason it should exist: the item
 * table names `machinegun.md3` and has nothing to say about the tube that
 * bolts onto it.
 *
 * So the bundle shipped five guns with their fronts missing -- 16% of the
 * machinegun, 46% of the gauntlet, 70% of the chaingun -- and every tag needed
 * to put them back was already in the file. See D-141.
 *
 * Eight weapons ship none and that is not a defect; their world model carries
 * no `tag_barrel` either. Filtered rather than reported for the same reason the
 * hands fallbacks are.
 */
function barrelModelPaths(): string[] {
    const paths = new Set<string>();

    for (const item of balanceItems()) {
        if (item.type !== 'IT_WEAPON') continue;

        const world = (item.models[0] ?? '').replace(/\\/g, '/');
        if (!world.toLowerCase().endsWith('.md3')) continue;

        const barrel = `${world.slice(0, -'.md3'.length)}_barrel.md3`;
        if (existsSync(join(EXTRACTED, barrel))) paths.add(barrel);
    }

    return [...paths].sort();
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
    emissive: string | null,
    normal: string | null,
    orm: string | null
): BundleMaterial {
    return {
        name,
        albedo,
        albedoBlend: pbr.albedoBlend,
        normal,
        orm,
        emissive,
        emissiveLuminance: pbr.emissiveLuminance ?? 0,
        roughness: pbr.roughness,
        metallic: pbr.metallic,
        transmission: pbr.transmission,
        ior: pbr.ior,
        transparency: pbr.transparency,
        alphaCutoff: pbr.alphaCutoff,
        doubleSided: pbr.doubleSided,
        surfaceLight: pbr.surfaceLight ?? 0,
    };
}

function appendSurface(
    accum: Accum,
    modelPath: string,
    surface: Md3Surface,
    materialIndex: number
): BundleMesh {
    const positions = surface.positions[0]!;

    /*
     A surface is normally taken exactly as authored -- that is the whole point
     of converting rather than remodelling, and 118 of this bundle's 123
     surfaces come through untouched. The exceptions are the handful of Team
     Arena weapons whose MD3s ship normals that do not describe their own
     geometry; `mesh-normals.ts` has the measurements and the argument (D-140).

     Still in MD3 axes and MD3 winding here. The axis map and the reversal below
     both apply to the repaired arrays exactly as they applied to the source.
    */
    let normals = surface.normals[0]!;
    let indices: ArrayLike<number> = surface.indices;

    const scored = windingAgreement(positions, normals, indices, 'clockwise');
    if (agreementRatio(scored) < REPAIR_THRESHOLD) {
        const repair = repairSurface(positions, normals, indices, 'clockwise');

        // Only if it actually helped. A surface can be broken in a way this does
        // not model, and shipping a worse mesh to satisfy a threshold would be
        // exactly the pinning-broken-behaviour mistake.
        if (agreementRatio(repair.after) > agreementRatio(repair.before)) {
            normals = repair.normals;
            indices = repair.indices;

            accum.repairs.push({
                model: modelPath,
                surface: surface.name,
                reoriented: repair.reoriented,
                rewritten: repair.rewritten,
                beforeRatio: agreementRatio(repair.before),
                afterRatio: agreementRatio(repair.after),
            });
        }
    }

    const vertexOffset = accum.vertexCursor;
    const indexOffset = accum.indexCursor;

    for (let i = 0; i < surface.numVerts; i++) {
        const [x, y, z] = q3ToMeep(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
        const [nx, ny, nz] = q3ToMeep(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);

        accum.vertices.push(
            x, y, z,
            nx, ny, nz,
            /*
             MD3 stores V the same way Q3's BSP does -- increasing downward, and
             so does glTF, so it passes through. `torch.md3` is the check that
             does not need a judgement call: a straight vertical prop, and its
             `corr(model z, t)` is exactly -1. See `pushVertex` in
             `convert-map.ts` for the whole argument.
            */
            surface.st[i * 2]!, surface.st[i * 2 + 1]!,
            surface.st[i * 2]!, surface.st[i * 2 + 1]!,
            1, 1
        );
    }

    // Reversed: MD3 winds clockwise from the front, glTF counter-clockwise.
    // Measured at 0 of 204 agreeing on `rocketl.md3`. Same convention as the
    // BSP and as `brushHull.ts`.
    for (let i = 0; i + 2 < indices.length; i += 3) {
        accum.indices.push(indices[i]!, indices[i + 2]!, indices[i + 1]!);
    }

    accum.vertexCursor += surface.numVerts;
    accum.indexCursor += indices.length;

    return {
        material: materialIndex,
        vertexOffset,
        vertexCount: surface.numVerts,
        indexOffset,
        indexCount: indices.length,
    };
}

async function convertModels(): Promise<void> {
    const index = new ShaderIndex(EXTRACTED).load();

    const outDir = join(BUILT, 'models');
    /*
     Emptied rather than added to. A conversion decides the *name* of a file from
     what it did to the image, so a run that restates something differently
     leaves the old name behind: turning on the de-lit albedos renamed 33 of the
     model bundle's textures to `.delit.png` and left 33 orphans beside them,
     which is a third of the bundle in files nothing references.
    */
    const textureDir = join(outDir, 'textures');
    rmSync(textureDir, { recursive: true, force: true });
    mkdirSync(textureDir, { recursive: true });

    const hands = handModelPaths();
    const paths = [
        ...new Set([
            ...itemModelPaths(),
            ...hands.paths,
            ...barrelModelPaths(),
            ...missileModelPaths(),
            ...EXTRA_MODELS,
        ]),
    ].sort();

    const accum: Accum = { vertices: [], indices: [], vertexCursor: 0, indexCursor: 0, repairs: [] };

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
                    albedoKey = textureKey(pbr.albedo, pbr.albedoBlend, pbr.environmentMapped);
                    textures[albedoKey] = await writeTexture(
                        index,
                        EXTRACTED,
                        pbr.albedo,
                        textureDir,
                        textureCache,
                        pbr.albedoBlend,
                        MATERIAL_MAPS,
                        pbr.environmentMapped
                    );
                    if (textures[albedoKey] === null) albedoKey = null;
                }
                if (albedoKey === null) untexturedSurfaces += 1;

                let emissiveKey: string | null = null;
                if (pbr.emissive !== null && pbr.emissiveLuminance > 0) {
                    emissiveKey = textureKey(pbr.emissive, 'opaque', pbr.environmentMapped);
                    textures[emissiveKey] = await writeTexture(
                        index,
                        EXTRACTED,
                        pbr.emissive,
                        textureDir,
                        textureCache,
                        'opaque',
                        null,
                        pbr.environmentMapped
                    );
                    if (textures[emissiveKey] === null) emissiveKey = null;
                }

                /*
                 The generated maps, under their own keys. Nothing is written
                 until the generator has produced something for that texture, so
                 a run against an empty `assets/generated/materials` writes the
                 bundle it always wrote.
                */
                /*
                 Unlike a Q3 reference, a generated map that is not there records
                 nothing. A `null` in the texture table means "this image was
                 looked for on disk and is not there", which is worth saying about
                 an albedo the shader named; saying it about every texture the
                 generator has not reached would double the table to carry no
                 information the material's own `null` does not already carry.
                */
                const derived = async (
                    map: 'normal' | 'orm',
                    from: string | null
                ): Promise<string | null> => {
                    if (from === null) return null;

                    const key = derivedTextureKey(from, map, pbr.environmentMapped);
                    const file = await writeDerivedTexture(
                        MATERIAL_MAPS,
                        from,
                        map,
                        textureDir,
                        textureCache,
                        pbr.environmentMapped
                    );
                    if (file !== null) textures[key] = file;

                    // The key survives a missing file. The material is saying what
                    // it is owed, which is a different question from what has been
                    // generated so far, and `buildMaterials` reads an unresolved
                    // key as no texture anyway.
                    return key;
                };

                const normalKey = await derived('normal', pbr.normal);
                const ormKey = await derived('orm', pbr.orm);

                materialIndex = materials.length;
                materials.push(
                    toBundleMaterial(shaderName, pbr, albedoKey, emissiveKey, normalKey, ormKey)
                );
                materialByShader.set(shaderName, materialIndex);
            }

            meshes.push(appendSurface(accum, virtualPath, surface, materialIndex));
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
                rotation: tagRotation(t.axis),
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
            repairedSurfaces: accum.repairs.length,
            reorientedTriangles: accum.repairs.reduce((n, r) => n + r.reoriented, 0),
            rewrittenNormals: accum.repairs.reduce((n, r) => n + r.rewritten, 0),
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
            : '') +
        (accum.repairs.length > 0
            ? `\n  normals re-derived (source disagrees with its own geometry):\n` +
              accum.repairs
                  .map(
                      (r) =>
                          `    ${r.model} [${r.surface}] ` +
                          `${(r.beforeRatio * 100).toFixed(1)}% -> ` +
                          `${(r.afterRatio * 100).toFixed(1)}% agreeing, ` +
                          `${r.reoriented} triangles turned, ${r.rewritten} normals rewritten`
                  )
                  .join('\n')
            : '')
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await convertModels();
}
