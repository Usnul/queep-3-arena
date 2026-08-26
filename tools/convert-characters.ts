/*
 * convert-characters.ts -- OpenArena's player models, as skinned glTF.
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
 * Output, under `assets/built/characters/<name>/`:
 *
 *   <name>.gltf     nodes, skins, clips, materials
 *   <name>.bin      geometry and animation tracks
 *   *.png           referenced textures
 *
 * A Q3 player is three models and two attachment points, and the split is
 * load-bearing rather than an artefact: `lower.md3` runs the legs, `upper.md3`
 * runs the torso, and they animate *independently* -- a player runs and fires at
 * once, and the two clips have nothing to do with each other. The head hangs off
 * the torso by `tag_head` and never animates at all; Q3 draws it at frame 0
 * always.
 *
 * That structure survives into the glTF: two skins, and clip names that keep
 * Q3's `LEGS_*` / `TORSO_*` / `BOTH_*` prefixes, so playing one of each is
 * playing two clips over disjoint joint sets rather than blending anything.
 *
 * The vertex-morph-to-skeleton conversion is `pipeline/rig.ts`, and its measured
 * error is printed per model rather than assumed.
 *
 * Usage:  node tools/convert-characters.ts [<name>...]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ShaderIndex } from './pipeline/shader-index.ts';
import {
    parseMd3,
    parseSkin,
    normaliseShaderName,
    drawableSurfaces,
    type Md3Model,
} from './pipeline/md3.ts';
import {
    textureCache,
    writeDerivedTexture,
    writeTexture,
    type TextureCache,
} from './pipeline/texture-out.ts';
import { decomposeSkin, type RigResult } from './pipeline/rig.ts';
import {
    GltfBuilder,
    q3PointToGltf,
    q3QuatToGltf,
    type GltfChannel,
    type GltfSampler,
} from './pipeline/gltf.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');
const PLAYERS = join(EXTRACTED, 'models', 'players');
/** Where `tools/generate-material-maps.ts` leaves the normal and ORM images. */
const MATERIAL_MAPS = join(ROOT, 'assets', 'generated', 'materials');

/**
 * Joints per animated part.
 *
 * Measured on `sarge`, whose legs are 278 vertices over 213 frames: 16 joints
 * gives 0.10 units of mean error, 24 gives 0.043 and 32 gives 0.042. The knee
 * is at 24 and the torso -- more vertices, more independent motion -- keeps
 * improving to 32, so 32 it is for both. One unit is about 3 cm, so this is
 * millimetre-scale on a 1.75 m character.
 */
const JOINTS_PER_PART = 32;

/** Reassign-and-refit passes. Converges in three or four; six is cheap insurance. */
const REFINE_ITERATIONS = 6;

/**
 * `animType_t`, in order. `CG_ParseAnimationFile` reads the config's numeric
 * lines positionally, so the order *is* the format.
 */
const ANIMATION_NAMES: readonly string[] = [
    'BOTH_DEATH1', 'BOTH_DEAD1', 'BOTH_DEATH2', 'BOTH_DEAD2', 'BOTH_DEATH3', 'BOTH_DEAD3',
    'TORSO_GESTURE', 'TORSO_ATTACK', 'TORSO_ATTACK2', 'TORSO_DROP', 'TORSO_RAISE',
    'TORSO_STAND', 'TORSO_STAND2',
    'LEGS_WALKCR', 'LEGS_WALK', 'LEGS_RUN', 'LEGS_BACK', 'LEGS_SWIM',
    'LEGS_JUMP', 'LEGS_LAND', 'LEGS_JUMPB', 'LEGS_LANDB',
    'LEGS_IDLE', 'LEGS_IDLECR', 'LEGS_TURN',
    'TORSO_GETFLAG', 'TORSO_GUARDBASE', 'TORSO_PATROL', 'TORSO_FOLLOWME',
    'TORSO_AFFIRMATIVE', 'TORSO_NEGATIVE',
];

const FIRST_LEGS = ANIMATION_NAMES.indexOf('LEGS_WALKCR');
const FIRST_TORSO_EXTRA = ANIMATION_NAMES.indexOf('TORSO_GETFLAG');
const TORSO_GESTURE = ANIMATION_NAMES.indexOf('TORSO_GESTURE');

export interface AnimationDef {
    readonly name: string;
    readonly firstFrame: number;
    readonly numFrames: number;
    readonly loopFrames: number;
    readonly fps: number;
}

/**
 * `CG_ParseAnimationFile`.
 *
 * The one thing that is not obvious from the file: legs frame numbers are
 * written as offsets into the *whole* animation set, but they index into
 * `lower.md3`, which contains only the shared frames plus the legs frames. Q3
 * subtracts the gap between the first legs animation and the first torso one.
 * Skip that correction and every legs animation plays 63 frames too late,
 * which on `sarge` means running plays the death animation.
 */
export function parseAnimationConfig(source: string): AnimationDef[] {
    const out: AnimationDef[] = [];

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.replace(/\/\/.*$/, '').trim();
        if (line.length === 0) continue;

        const fields = line.split(/\s+/);
        // Text directives -- `sex`, `footsteps`, `headoffset`, `fixedlegs`.
        if (!/^-?\d+$/.test(fields[0] ?? '')) continue;
        if (fields.length < 4) continue;

        const index = out.length;
        if (index >= ANIMATION_NAMES.length) break;

        out.push({
            name: ANIMATION_NAMES[index]!,
            firstFrame: Number(fields[0]),
            numFrames: Number(fields[1]),
            loopFrames: Number(fields[2]),
            // `if ( animations[i].frameLerp < 1 ) frameLerp = 1` -- a zero fps
            // in a shipped config would otherwise be a division by zero.
            fps: Math.max(1, Number(fields[3])),
        });
    }

    const walkcr = out[FIRST_LEGS];
    const gesture = out[TORSO_GESTURE];

    if (walkcr !== undefined && gesture !== undefined) {
        const skip = walkcr.firstFrame - gesture.firstFrame;
        for (let i = FIRST_LEGS; i < Math.min(out.length, FIRST_TORSO_EXTRA); i++) {
            const a = out[i]!;
            out[i] = { ...a, firstFrame: a.firstFrame - skip };
        }
    }

    return out;
}

type Part = 'lower' | 'upper' | 'head';

interface LoadedPart {
    readonly md3: Md3Model;
    /** Surface name -> shader path, from the `.skin` file. */
    readonly skin: Map<string, string>;
}

function loadPart(dir: string, part: Part): LoadedPart | null {
    const modelPath = join(dir, `${part}.md3`);
    if (!existsSync(modelPath)) return null;

    const raw = readFileSync(modelPath);
    const md3 = parseMd3(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), part);

    /*
     `_default.skin` where there is one. Several OA characters ship only named
     variants -- `sorceress` has `head_dark_red.skin` and nothing else -- and Q3
     would let you select those from the menu, so falling back to the first one
     alphabetically gets a usable model rather than an untextured one.
    */
    const candidates = readdirSync(dir).filter(
        (f) => f.toLowerCase().startsWith(`${part}_`) && f.toLowerCase().endsWith('.skin')
    );
    const chosen =
        candidates.find((f) => f.toLowerCase() === `${part}_default.skin`) ??
        candidates.sort()[0];

    const skin =
        chosen === undefined
            ? new Map<string, string>()
            : parseSkin(readFileSync(join(dir, chosen), 'latin1'));

    return { md3, skin };
}

/**
 * MD3 winds clockwise from the front; glTF winds counter-clockwise.
 *
 * Measured across the content: 0 of 204 triangles on `rocketl.md3` agree with
 * their stored vertex normal, 4 of 506 on `sarge`'s legs. The same convention
 * holds for BSP surfaces, patch tessellation and brush windings, so every
 * converter reverses and `brushHull.ts` always did.
 */
function reverseWinding(indices: Uint32Array): Uint32Array {
    const out = new Uint32Array(indices.length);

    for (let i = 0; i + 2 < indices.length; i += 3) {
        out[i] = indices[i]!;
        out[i + 1] = indices[i + 2]!;
        out[i + 2] = indices[i + 1]!;
    }

    return out;
}

/** Every drawable surface of a part, concatenated, so it gets one shared skeleton. */
function combinedFrames(md3: Md3Model): { frames: Float32Array[]; vertexCount: number } {
    const surfaces = drawableSurfaces(md3);

    const vertexCount = surfaces.reduce((n, s) => n + s.numVerts, 0);
    if (vertexCount === 0) return { frames: [], vertexCount: 0 };

    const frameCount = Math.max(1, ...surfaces.map((s) => s.numFrames));

    const frames: Float32Array[] = [];

    for (let f = 0; f < frameCount; f++) {
        const combined = new Float32Array(vertexCount * 3);
        let at = 0;

        for (const surface of surfaces) {
            const positions = surface.positions[Math.min(f, surface.numFrames - 1)]!;
            combined.set(positions, at);
            at += surface.numVerts * 3;
        }

        frames.push(combined);
    }

    return { frames, vertexCount };
}

interface PartRig {
    readonly rig: RigResult;
    /** Node index of each joint, in the glTF. */
    readonly jointNodes: number[];
    readonly skinIndex: number;
    /** Where each surface's vertices start in the combined array. */
    readonly surfaceOffsets: number[];
}

async function convertCharacter(
    name: string,
    index: ShaderIndex
): Promise<Record<string, unknown> | null> {
    const dir = join(PLAYERS, name);

    const lower = loadPart(dir, 'lower');
    const upper = loadPart(dir, 'upper');
    const head = loadPart(dir, 'head');

    if (lower === null || upper === null) {
        console.warn(`  ${name}: skipped, missing ${lower === null ? 'lower' : 'upper'}.md3`);
        return null;
    }

    const animations = parseAnimationConfig(readFileSync(join(dir, 'animation.cfg'), 'latin1'));

    const outDir = join(BUILT, 'characters', name);
    mkdirSync(outDir, { recursive: true });

    const gltf = new GltfBuilder('queep-3-arena tools/convert-characters.ts');
    const textures: TextureCache = textureCache();

    /* ---- materials ---- */

    const materialByShader = new Map<string, number>();
    let untextured = 0;

    const materialFor = async (part: LoadedPart, surfaceName: string, fallback: string) => {
        const shaderName = normaliseShaderName(part.skin.get(surfaceName) ?? fallback);

        const cached = materialByShader.get(shaderName);
        if (cached !== undefined) return cached;

        const pbr = index.material(shaderName);

        let texture: number | null = null;
        if (pbr.albedo !== null) {
            const file = await writeTexture(
                index,
                EXTRACTED,
                pbr.albedo,
                outDir,
                textures,
                pbr.albedoBlend,
                MATERIAL_MAPS
            );
            if (file !== null) texture = gltf.image(file);
        }
        if (texture === null) untextured += 1;

        /*
         The generated maps go in as glTF's own `normalTexture` and
         `metallicRoughnessTexture` rather than as anything bespoke, because
         meep's glTF loader already binds those two to `texture_normal` and
         `texture_orm`. Both are absent until the generator has produced them.

         When an ORM is bound the two factors have to become 1: the g-buffer pass
         multiplies the sampled channels by them, so `metallic: 0` would cancel
         every metal the classification named.
        */
        const derived = (map: 'normal' | 'orm', from: string | null): number | null => {
            if (from === null) return null;
            const file = writeDerivedTexture(MATERIAL_MAPS, from, map, outDir, textures);
            return file === null ? null : gltf.image(file);
        };

        const normalTexture = derived('normal', pbr.normal);
        const metallicRoughnessTexture = derived('orm', pbr.orm);

        const material = gltf.material({
            name: shaderName,
            baseColorTexture: texture,
            normalTexture,
            metallicRoughnessTexture,
            alphaMode:
                pbr.transparency === 'mask' ? 'MASK' : pbr.transparency === 'blend' ? 'BLEND' : 'OPAQUE',
            alphaCutoff: pbr.alphaCutoff,
            doubleSided: pbr.doubleSided,
            roughness: metallicRoughnessTexture === null ? pbr.roughness : 1,
            metallic: metallicRoughnessTexture === null ? pbr.metallic : 1,
        });

        materialByShader.set(shaderName, material);
        return material;
    };

    /* ---- tags ---- */

    const tagIndex = (md3: Md3Model, frame: number, tagName: string): number => {
        const tags = md3.tags[Math.min(frame, md3.tags.length - 1)] ?? [];
        return tags.findIndex((t) => t.name === tagName);
    };

    /**
     * Rotation of a tag's axis triple, as a quaternion in Q3 space.
     *
     * MD3 stores a tag as three vectors -- forward, left, up. Those are the
     * *columns* of the local-to-parent rotation, not the rows, and the place
     * that settles it is `CG_PositionRotatedEntityOnTag`, which composes the
     * origin as `parent + sum(origin[i] * parentAxis[i])`. Reading them as rows
     * instead transposes every tag, which inverts each rotation: heads end up
     * facing backwards on any character whose torso is turned, and correct on
     * any character standing square, so it survives a casual look.
     */
    const tagRotation = (
        md3: Md3Model,
        frame: number,
        tag: number,
        out: Float32Array,
        at: number
    ): void => {
        const t = md3.tags[Math.min(frame, md3.tags.length - 1)]![tag]!;
        const [fx, fy, fz] = t.axis[0];
        const [lx, ly, lz] = t.axis[1];
        const [ux, uy, uz] = t.axis[2];

        // m00 = fx, m01 = lx, m02 = ux
        // m10 = fy, m11 = ly, m12 = uy
        // m20 = fz, m21 = lz, m22 = uz
        const trace = fx + ly + uz;
        let x: number, y: number, z: number, w: number;

        if (trace > 0) {
            const s = Math.sqrt(trace + 1) * 2;
            w = 0.25 * s;
            x = (lz - uy) / s;
            y = (ux - fz) / s;
            z = (fy - lx) / s;
        } else if (fx > ly && fx > uz) {
            const s = Math.sqrt(1 + fx - ly - uz) * 2;
            w = (lz - uy) / s;
            x = 0.25 * s;
            y = (lx + fy) / s;
            z = (ux + fz) / s;
        } else if (ly > uz) {
            const s = Math.sqrt(1 + ly - fx - uz) * 2;
            w = (ux - fz) / s;
            x = (lx + fy) / s;
            y = 0.25 * s;
            z = (uy + lz) / s;
        } else {
            const s = Math.sqrt(1 + uz - fx - ly) * 2;
            w = (fy - lx) / s;
            x = (ux + fz) / s;
            y = (uy + lz) / s;
            z = 0.25 * s;
        }

        const length = Math.hypot(x, y, z, w) || 1;
        out[at] = x / length;
        out[at + 1] = y / length;
        out[at + 2] = z / length;
        out[at + 3] = w / length;
    };

    /** Frame-0 transform of a named tag, as a glTF node's rest pose. */
    function restOfTag(md3: Md3Model, tagName: string): {
        translation?: number[];
        rotation?: number[];
    } {
        const at = tagIndex(md3, 0, tagName);
        if (at < 0) return { rotation: [0, 0, 0, 1] };

        const scratch = new Float32Array(4);
        tagRotation(md3, 0, at, scratch, 0);

        const origin = md3.tags[0]![at]!.origin;
        const [tx, ty, tz] = q3PointToGltf(origin[0], origin[1], origin[2]);
        const [qx, qy, qz, qw] = q3QuatToGltf(scratch, 0);

        return { translation: [tx, ty, tz], rotation: [qx, qy, qz, qw] };
    }

    /* ---- nodes ---- */

    const rootChildren: number[] = [];
    const root = gltf.node({ name, children: rootChildren });

    /**
     * Build one animated part: its skeleton, its skin, and its meshes.
     *
     * `parent` is the node the joints hang off, which is the root for the legs
     * and `tag_torso` for the torso. glTF joints may live anywhere in the
     * hierarchy, and putting the torso's under the tag is what makes the tag
     * compose with the torso's own rig instead of having to be baked into it.
     */
    const buildPart = async (
        part: LoadedPart,
        label: string,
        parentChildren: number[]
    ): Promise<PartRig | null> => {
        const { frames, vertexCount } = combinedFrames(part.md3);

        /*
         A part with no drawable geometry is not an error. `neko/upper.md3` has
         278 frames and no surfaces at all -- it is a placeholder whose only
         purpose is to carry `tag_head`, and the tag animation is read from the
         model whether or not anything hangs off it. Returning null here and
         letting the tag sampling continue is what keeps that character's head
         in the right place on a body that does not exist.
        */
        if (vertexCount === 0) return null;

        const rig = decomposeSkin(frames, vertexCount, {
            joints: JOINTS_PER_PART,
            refineIterations: REFINE_ITERATIONS,
        });

        // Joint nodes, at their rest centroids with identity rotation.
        const jointNodes: number[] = [];
        for (let j = 0; j < rig.jointCount; j++) {
            const [x, y, z] = q3PointToGltf(
                rig.centroids[j * 3]!,
                rig.centroids[j * 3 + 1]!,
                rig.centroids[j * 3 + 2]!
            );
            const node = gltf.node({
                name: `${label}_joint_${j}`,
                translation: [x, y, z],
                rotation: [0, 0, 0, 1],
            });
            jointNodes.push(node);
            parentChildren.push(node);
        }

        /*
         Inverse bind matrix is a pure translation by minus the rest centroid.
         The joint node sits *at* the centroid, so the pair cancels at rest and
         the model in its bind pose is exactly MD3 frame 0 -- which is what a
         viewer shows when nothing is playing, and a good way to see at a glance
         that the rig is not inside out.
        */
        const ibm = new Float32Array(rig.jointCount * 16);
        for (let j = 0; j < rig.jointCount; j++) {
            const [x, y, z] = q3PointToGltf(
                rig.centroids[j * 3]!,
                rig.centroids[j * 3 + 1]!,
                rig.centroids[j * 3 + 2]!
            );
            const o = j * 16;
            ibm[o] = 1; ibm[o + 5] = 1; ibm[o + 10] = 1; ibm[o + 15] = 1;
            ibm[o + 12] = -x; ibm[o + 13] = -y; ibm[o + 14] = -z;
        }

        const skinIndex = gltf.skin(
            `${label}_skin`,
            jointNodes,
            gltf.matrices(ibm),
            jointNodes[0] ?? root
        );

        /* ---- meshes, one primitive per MD3 surface ---- */

        const primitives = [];
        const surfaceOffsets: number[] = [];
        let cursor = 0;

        for (const surface of drawableSurfaces(part.md3)) {
            surfaceOffsets.push(cursor);

            const n = surface.numVerts;
            const positions = new Float32Array(n * 3);
            const normals = new Float32Array(n * 3);
            const uv = new Float32Array(n * 2);
            const joints = new Uint16Array(n * 4);
            const weights = new Float32Array(n * 4);

            const restPositions = surface.positions[0]!;
            const restNormals = surface.normals[0]!;

            for (let i = 0; i < n; i++) {
                const [x, y, z] = q3PointToGltf(
                    restPositions[i * 3]!,
                    restPositions[i * 3 + 1]!,
                    restPositions[i * 3 + 2]!
                );
                positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

                const [nx, ny, nz] = q3PointToGltf(
                    restNormals[i * 3]!,
                    restNormals[i * 3 + 1]!,
                    restNormals[i * 3 + 2]!
                );
                normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;

                uv[i * 2] = surface.st[i * 2]!;
                // MD3's V increases downward and so does glTF's; see
                // `pushVertex` in `convert-map.ts` for why that is not a flip.
                uv[i * 2 + 1] = surface.st[i * 2 + 1]!;

                joints[i * 4] = rig.vertexJoint[cursor + i]!;
                weights[i * 4] = 1;
            }

            primitives.push({
                attributes: {
                    POSITION: gltf.positions(positions),
                    NORMAL: gltf.vec3(normals),
                    TEXCOORD_0: gltf.vec2(uv),
                    JOINTS_0: gltf.joints(joints),
                    WEIGHTS_0: gltf.vec4(weights),
                },
                indices: gltf.indices(reverseWinding(surface.indices)),
                material: await materialFor(part, surface.name, surface.shaders[0] ?? surface.name),
            });

            cursor += n;
        }

        const meshIndex = gltf.mesh(`${label}_mesh`, primitives);

        /*
         The skinned mesh node sits at the root with an identity transform. The
         spec says a skinned mesh node's own transform must be ignored, and
         implementations disagree about how thoroughly; putting it at the root
         means there is nothing to disagree about.
        */
        rootChildren.push(gltf.node({ name: `${label}_mesh_node`, mesh: meshIndex, skin: skinIndex }));

        return { rig, jointNodes, skinIndex, surfaceOffsets };
    };

    const legs = await buildPart(lower, 'legs', rootChildren);

    /*
     `tag_torso` on `lower.md3` places the torso, and moves with the legs.

     Its rest transform is the tag's *frame 0*, not identity. A node whose rest
     pose is identity and whose animation writes identity has channels that do
     nothing, and a downstream optimiser that prunes no-op channels can empty a
     clip entirely -- which is how a character with no torso geometry produced
     seven zero-channel clips and an assertion from inside the mesh system.
     Authoring the real rest pose also makes the unposed model correct, which is
     what any glTF viewer shows.
    */
    const torsoChildren: number[] = [];
    const tagTorso = gltf.node({
        name: 'tag_torso',
        children: torsoChildren,
        ...restOfTag(lower.md3, 'tag_torso'),
    });
    rootChildren.push(tagTorso);

    const torso = await buildPart(upper, 'torso', torsoChildren);

    // `tag_head` on `upper.md3`. Q3 draws the head at frame 0 always, so it is a
    // plain child rather than a skin.
    const headChildren: number[] = [];
    const tagHead = gltf.node({
        name: 'tag_head',
        children: headChildren,
        ...restOfTag(upper.md3, 'tag_head'),
    });
    torsoChildren.push(tagHead);

    if (head !== null && drawableSurfaces(head.md3).length > 0) {
        const primitives = [];
        for (const surface of drawableSurfaces(head.md3)) {
            const n = surface.numVerts;
            const positions = new Float32Array(n * 3);
            const normals = new Float32Array(n * 3);
            const uv = new Float32Array(n * 2);

            const restPositions = surface.positions[0]!;
            const restNormals = surface.normals[0]!;

            for (let i = 0; i < n; i++) {
                const [x, y, z] = q3PointToGltf(
                    restPositions[i * 3]!, restPositions[i * 3 + 1]!, restPositions[i * 3 + 2]!
                );
                positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

                const [nx, ny, nz] = q3PointToGltf(
                    restNormals[i * 3]!, restNormals[i * 3 + 1]!, restNormals[i * 3 + 2]!
                );
                normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;

                uv[i * 2] = surface.st[i * 2]!;
                uv[i * 2 + 1] = surface.st[i * 2 + 1]!;
            }

            primitives.push({
                attributes: {
                    POSITION: gltf.positions(positions),
                    NORMAL: gltf.vec3(normals),
                    TEXCOORD_0: gltf.vec2(uv),
                },
                indices: gltf.indices(reverseWinding(surface.indices)),
                material: await materialFor(head, surface.name, surface.shaders[0] ?? surface.name),
            });
        }

        headChildren.push(gltf.node({ name: 'head_mesh_node', mesh: gltf.mesh('head_mesh', primitives) }));
    }

    /* ---- animation clips ---- */

    const torsoTagOnLegs = tagIndex(lower.md3, 0, 'tag_torso');
    const headTagOnTorso = tagIndex(upper.md3, 0, 'tag_head');

    const scratchQuat = new Float32Array(4);

    for (const animation of animations) {
        const isLegs = animation.name.startsWith('LEGS_');
        const isTorso = animation.name.startsWith('TORSO_');
        const isBoth = animation.name.startsWith('BOTH_');

        /*
         A torso clip with no torso is not worth emitting. `neko`'s `upper.md3`
         is 278 frames of nothing but `tag_head`, so its TORSO_* clips would
         carry two channels that place a head -- which is a real thing to do,
         but not one worth a clip, and it is exactly the shape that prunes to
         zero and trips an assertion.
        */
        if (isTorso && torso === null) continue;

        const count = Math.max(1, animation.numFrames);

        const times = new Float32Array(count);
        for (let i = 0; i < count; i++) times[i] = i / animation.fps;
        const input = gltf.times(times);

        const channels: GltfChannel[] = [];
        const samplers: GltfSampler[] = [];

        const track = (
            node: number,
            path: 'translation' | 'rotation',
            data: Float32Array
        ): void => {
            const output = path === 'rotation' ? gltf.trackQuat(data) : gltf.trackVec3(data);
            channels.push({ sampler: samplers.length, target: { node, path } });
            samplers.push({ input, output, interpolation: 'LINEAR' });
        };

        /** Sample one rigged part's joints over the animation's frame range. */
        const samplePart = (part: PartRig): void => {
            const frameCount = part.rig.rotations.length;

            for (let j = 0; j < part.rig.jointCount; j++) {
                const rotation = new Float32Array(count * 4);
                const translation = new Float32Array(count * 3);

                for (let i = 0; i < count; i++) {
                    const f = Math.min(frameCount - 1, Math.max(0, animation.firstFrame + i));

                    const [qx, qy, qz, qw] = q3QuatToGltf(part.rig.rotations[f]!, j * 4);
                    rotation[i * 4] = qx;
                    rotation[i * 4 + 1] = qy;
                    rotation[i * 4 + 2] = qz;
                    rotation[i * 4 + 3] = qw;

                    /*
                     The node's translation is the rest centroid plus this
                     frame's offset -- the centroid is baked into the node's
                     rest pose, and an animation channel replaces a node's
                     transform outright rather than adding to it.
                    */
                    const t = part.rig.translations[f]!;
                    const [tx, ty, tz] = q3PointToGltf(
                        part.rig.centroids[j * 3]! + t[j * 3]!,
                        part.rig.centroids[j * 3 + 1]! + t[j * 3 + 1]!,
                        part.rig.centroids[j * 3 + 2]! + t[j * 3 + 2]!
                    );
                    translation[i * 3] = tx;
                    translation[i * 3 + 1] = ty;
                    translation[i * 3 + 2] = tz;
                }

                track(part.jointNodes[j]!, 'rotation', rotation);
                track(part.jointNodes[j]!, 'translation', translation);
            }

        };

        /** Sample an attachment point over the same range. */
        const sampleTag = (node: number, md3: Md3Model, tag: number): void => {
            if (tag < 0) return;

            const rotation = new Float32Array(count * 4);
            const translation = new Float32Array(count * 3);
            const frameCount = md3.tags.length;

            for (let i = 0; i < count; i++) {
                const f = Math.min(frameCount - 1, Math.max(0, animation.firstFrame + i));

                tagRotation(md3, f, tag, scratchQuat, 0);
                const [qx, qy, qz, qw] = q3QuatToGltf(scratchQuat, 0);
                rotation[i * 4] = qx;
                rotation[i * 4 + 1] = qy;
                rotation[i * 4 + 2] = qz;
                rotation[i * 4 + 3] = qw;

                const origin = md3.tags[f]![tag]!.origin;
                const [tx, ty, tz] = q3PointToGltf(origin[0], origin[1], origin[2]);
                translation[i * 3] = tx;
                translation[i * 3 + 1] = ty;
                translation[i * 3 + 2] = tz;
            }

            track(node, 'rotation', rotation);
            track(node, 'translation', translation);
        };

        if (isLegs || isBoth) {
            if (legs !== null) samplePart(legs);
            sampleTag(tagTorso, lower.md3, torsoTagOnLegs);
        }
        if (isTorso || isBoth) {
            if (torso !== null) samplePart(torso);
            sampleTag(tagHead, upper.md3, headTagOnTorso);
        }

        if (channels.length === 0) continue;

        gltf.animation({ name: animation.name, channels, samplers });
    }

    /* ---- write ---- */

    writeFileSync(join(outDir, `${name}.bin`), gltf.buffer());
    writeFileSync(
        join(outDir, `${name}.gltf`),
        JSON.stringify(gltf.document(`${name}.bin`), null, 1)
    );

    if (legs === null) {
        console.warn(`  ${name}: skipped, lower.md3 has no drawable surfaces`);
        return null;
    }

    const report = {
        name,
        joints: legs.rig.jointCount + (torso?.rig.jointCount ?? 0),
        clips: gltf.animations.length,
        legsError: legs.rig.error,
        torsoError: torso?.rig.error ?? null,
        hasHead: head !== null,
        hasTorso: torso !== null,
        untextured,
        bytes: gltf.buffer().byteLength,
    };

    const torsoText =
        torso === null
            ? 'no torso geometry'
            : `torso err ${torso.rig.error.mean.toFixed(3)}/${torso.rig.error.max.toFixed(2)}`;

    console.log(
        `  ${name.padEnd(12)} ${report.clips} clips, ${report.joints} joints, ` +
        `legs err ${legs.rig.error.mean.toFixed(3)}/${legs.rig.error.max.toFixed(2)} ` +
        `${torsoText} ` +
        `(${(report.bytes / 1024).toFixed(0)} KB)` +
        (head === null ? ' [no head]' : '') +
        (untextured > 0 ? ` [${untextured} untextured]` : '')
    );

    return report;
}

async function main(): Promise<void> {
    const requested = process.argv.slice(2);

    const names =
        requested.length > 0
            ? requested
            : readdirSync(PLAYERS).filter((d) => existsSync(join(PLAYERS, d, 'animation.cfg')));

    console.log('loading shader scripts...');
    const index = new ShaderIndex(EXTRACTED).load();

    console.log(`converting ${names.length} characters...`);

    const reports: Record<string, unknown>[] = [];
    for (const name of names.sort()) {
        const report = await convertCharacter(name, index);
        if (report !== null) reports.push(report);
    }

    mkdirSync(join(BUILT, 'characters'), { recursive: true });
    writeFileSync(
        join(BUILT, 'characters', 'characters.json'),
        JSON.stringify(
            {
                generator: 'queep-3-arena tools/convert-characters.ts',
                coordinateSystem: 'Y-up, right-handed; Q3 units (unscaled, see D-011)',
                jointsPerPart: JOINTS_PER_PART,
                characters: reports,
            },
            null,
            1
        )
    );

    console.log(`characters: ${reports.length} converted, ${names.length - reports.length} skipped`);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    await main();
}
