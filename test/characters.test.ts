/*
 * characters.test.ts -- does the emitted glTF actually reproduce the MD3?
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
 * The character pipeline has four places to be wrong and only one of them shows
 * up as an obvious failure: the rig can be wrong, the axis conversion can be
 * wrong, the animation sampling can be off by the legs-frame correction, and the
 * tag composition can be transposed. Every one of those produces a model that
 * loads, renders, and is subtly broken -- a head facing backwards, a run cycle
 * playing a death, a character mirrored.
 *
 * So this reads the emitted file back, evaluates the skinning by hand exactly as
 * a renderer would, and compares against the MD3 frames it came from. It is the
 * whole pipeline end to end, and the tolerance is the rig's own measured error
 * rather than a number chosen to make it pass.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseMd3 } from '../tools/pipeline/md3.ts';
import { parseAnimationConfig } from '../tools/convert-characters.ts';

const BUILT = join(process.cwd(), 'assets', 'built', 'characters');
const PLAYERS = join(process.cwd(), 'assets', 'extracted', 'models', 'players');

interface Gltf {
    nodes: {
        name?: string;
        children?: number[];
        translation?: number[];
        rotation?: number[];
        mesh?: number;
        skin?: number;
    }[];
    meshes: { name: string; primitives: { attributes: Record<string, number>; indices: number }[] }[];
    skins: { name: string; joints: number[]; inverseBindMatrices: number }[];
    animations: {
        name: string;
        channels: { sampler: number; target: { node: number; path: string } }[];
        samplers: { input: number; output: number }[];
    }[];
    accessors: {
        bufferView: number;
        componentType: number;
        count: number;
        type: string;
        min?: number[];
        max?: number[];
    }[];
    bufferViews: { byteOffset: number; byteLength: number }[];
    buffers: { uri: string; byteLength: number }[];
    images?: { uri: string }[];
}

function loadGltf(name: string): { gltf: Gltf; bin: Buffer } | null {
    const path = join(BUILT, name, `${name}.gltf`);
    if (!existsSync(path)) return null;

    const gltf = JSON.parse(readFileSync(path, 'utf8')) as Gltf;
    const bin = readFileSync(join(BUILT, name, gltf.buffers[0]!.uri));

    return { gltf, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf: Gltf, bin: Buffer, index: number): Float32Array | Uint32Array | Uint16Array {
    const accessor = gltf.accessors[index]!;
    const view = gltf.bufferViews[accessor.bufferView]!;
    const count = accessor.count * COMPONENTS[accessor.type]!;
    const offset = bin.byteOffset + view.byteOffset;

    switch (accessor.componentType) {
        case 5126:
            return new Float32Array(bin.buffer, offset, count);
        case 5125:
            return new Uint32Array(bin.buffer, offset, count);
        case 5123:
            return new Uint16Array(bin.buffer, offset, count);
        default:
            throw new Error(`unhandled componentType ${accessor.componentType}`);
    }
}

function nodeIndexByName(gltf: Gltf, name: string): number {
    const at = gltf.nodes.findIndex((n) => n.name === name);
    if (at < 0) throw new Error(`no node named ${name}`);
    return at;
}

/** Rotate a vector by a quaternion in `xyzw` order. */
function applyQuat(
    q: ArrayLike<number>,
    at: number,
    x: number,
    y: number,
    z: number
): [number, number, number] {
    const qx = q[at]!, qy = q[at + 1]!, qz = q[at + 2]!, qw = q[at + 3]!;

    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    return [
        x + qw * tx + (qy * tz - qz * ty),
        y + qw * ty + (qz * tx - qx * tz),
        z + qw * tz + (qx * ty - qy * tx),
    ];
}

/** The transform a clip writes onto a node at a given keyframe. */
function sampled(
    gltf: Gltf,
    bin: Buffer,
    animation: Gltf['animations'][number],
    node: number,
    keyframe: number
): { translation: number[] | null; rotation: number[] | null } {
    let translation: number[] | null = null;
    let rotation: number[] | null = null;

    for (const channel of animation.channels) {
        if (channel.target.node !== node) continue;

        const sampler = animation.samplers[channel.sampler]!;
        const output = readAccessor(gltf, bin, sampler.output) as Float32Array;

        if (channel.target.path === 'translation') {
            translation = [
                output[keyframe * 3]!,
                output[keyframe * 3 + 1]!,
                output[keyframe * 3 + 2]!,
            ];
        } else if (channel.target.path === 'rotation') {
            rotation = [
                output[keyframe * 4]!,
                output[keyframe * 4 + 1]!,
                output[keyframe * 4 + 2]!,
                output[keyframe * 4 + 3]!,
            ];
        }
    }

    return { translation, rotation };
}

describe('CG_ParseAnimationFile', () => {
    it('shifts legs frames back by the gap Q3 shifts them by', () => {
        const source = readFileSync(join(PLAYERS, 'sarge', 'animation.cfg'), 'latin1');
        const animations = parseAnimationConfig(source);

        const gesture = animations.find((a) => a.name === 'TORSO_GESTURE')!;
        const walkcr = animations.find((a) => a.name === 'LEGS_WALKCR')!;
        const run = animations.find((a) => a.name === 'LEGS_RUN')!;

        // The file says 90 and 153; the skip is 63.
        expect(gesture.firstFrame).toBe(90);
        expect(walkcr.firstFrame).toBe(90);

        // LEGS_RUN is written as 173, so it lands at 110.
        expect(run.firstFrame).toBe(110);
        expect(run.numFrames).toBe(9);
        expect(run.loopFrames).toBe(9);
        expect(run.fps).toBe(15);

        // Torso animations are untouched.
        expect(animations.find((a) => a.name === 'TORSO_ATTACK')!.firstFrame).toBe(130);
        // As are the shared BOTH_ ones, which index both models identically.
        expect(animations.find((a) => a.name === 'BOTH_DEATH1')!.firstFrame).toBe(0);
    });

    it('ignores the text directives a config carries', () => {
        const animations = parseAnimationConfig(
            'sex m\nfootsteps normal\nheadoffset 0 0 0\n0 30 0 25\n29 1 0 25\n'
        );
        expect(animations.map((a) => a.name)).toEqual(['BOTH_DEATH1', 'BOTH_DEAD1']);
    });
});

/*
 The structural check runs over every converted character rather than one,
 because it costs milliseconds and because the failures it catches are
 per-model: a character with one bone in a surface, or a skin whose joint
 indices came from a different part's rig, is exactly the kind of thing that
 only shows up on the fourteenth model.
*/
const ALL = [
    'assassin', 'beret', 'gargoyle', 'kyonshi', 'liz', 'major', 'merman', 'neko',
    'penguin', 'sarge', 'sergei', 'skelebot', 'smarine', 'sorceress', 'tony',
];

describe.each(ALL)('the emitted glTF [%s]', (name) => {
    const loaded = loadGltf(name);

    it.skipIf(loaded === null)('is structurally valid where the spec is normative', () => {
        const { gltf, bin } = loaded!;

        expect(gltf.skins.length).toBe(2);
        expect(gltf.animations.length).toBeGreaterThan(20);

        for (const mesh of gltf.meshes) {
            for (const primitive of mesh.primitives) {
                const position = gltf.accessors[primitive.attributes['POSITION']!]!;
                // Mandatory on POSITION, and a viewer that trusts the file will
                // cull a model whose bounds say it has no size.
                expect(position.min, `${mesh.name} POSITION min`).toBeDefined();
                expect(position.max, `${mesh.name} POSITION max`).toBeDefined();

                const jointsAccessor = primitive.attributes['JOINTS_0'];
                if (jointsAccessor === undefined) continue;

                const joints = readAccessor(gltf, bin, jointsAccessor) as Uint16Array;
                const weights = readAccessor(gltf, bin, primitive.attributes['WEIGHTS_0']!) as Float32Array;

                const skinIndex = gltf.nodes.find((n) => n.mesh === gltf.meshes.indexOf(mesh))!.skin!;
                const jointCount = gltf.skins[skinIndex]!.joints.length;

                for (let i = 0; i < joints.length; i += 4) {
                    expect(joints[i]!).toBeLessThan(jointCount);
                    const sum = weights[i]! + weights[i + 1]! + weights[i + 2]! + weights[i + 3]!;
                    expect(sum).toBeCloseTo(1, 5);
                }

                // Indices must address the primitive's own vertices.
                const indices = readAccessor(gltf, bin, primitive.indices) as Uint32Array;
                const vertexCount = position.count;
                for (const index of indices) expect(index).toBeLessThan(vertexCount);
            }
        }

        // Animation sampler inputs are the other place min/max is mandatory.
        for (const animation of gltf.animations) {
            for (const sampler of animation.samplers) {
                expect(gltf.accessors[sampler.input]!.min, `${animation.name} input min`).toBeDefined();
            }
        }
    });

});

describe('sarge, end to end', () => {
    const loaded = loadGltf('sarge');

    it.skipIf(loaded === null)('reproduces the MD3 legs frames it was built from', () => {
        const { gltf, bin } = loaded!;

        const raw = readFileSync(join(PLAYERS, 'sarge', 'lower.md3'));
        const md3 = parseMd3(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'lower');
        const surface = md3.surfaces[0]!;

        const meshNode = gltf.nodes.find((n) => n.name === 'legs_mesh_node')!;
        const skin = gltf.skins[meshNode.skin!]!;
        const mesh = gltf.meshes[meshNode.mesh!]!;
        const primitive = mesh.primitives[0]!;

        const bind = readAccessor(gltf, bin, primitive.attributes['POSITION']!) as Float32Array;
        const jointOf = readAccessor(gltf, bin, primitive.attributes['JOINTS_0']!) as Uint16Array;
        const ibm = readAccessor(gltf, bin, skin.inverseBindMatrices) as Float32Array;

        const run = gltf.animations.find((a) => a.name === 'LEGS_RUN')!;
        const config = parseAnimationConfig(
            readFileSync(join(PLAYERS, 'sarge', 'animation.cfg'), 'latin1')
        );
        const runDef = config.find((a) => a.name === 'LEGS_RUN')!;

        let worst = 0;
        let total = 0;
        let samples = 0;

        for (let keyframe = 0; keyframe < runDef.numFrames; keyframe++) {
            const md3Frame = surface.positions[runDef.firstFrame + keyframe]!;

            for (let v = 0; v < surface.numVerts; v++) {
                const joint = jointOf[v * 4]!;
                const node = skin.joints[joint]!;

                const { translation, rotation } = sampled(gltf, bin, run, node, keyframe);
                expect(translation, `joint ${joint} has no translation track`).not.toBeNull();
                expect(rotation, `joint ${joint} has no rotation track`).not.toBeNull();

                /*
                 `jointMatrix * (IBM * bindPosition)`. The inverse bind matrix
                 here is a pure translation, and the joint matrix is the node's
                 own TRS -- the legs joints are children of an identity root, so
                 there is no parent chain to walk.
                */
                const o = joint * 16;
                const lx = bind[v * 3]! + ibm[o + 12]!;
                const ly = bind[v * 3 + 1]! + ibm[o + 13]!;
                const lz = bind[v * 3 + 2]! + ibm[o + 14]!;

                const [rx, ry, rz] = applyQuat(rotation!, 0, lx, ly, lz);

                const x = rx + translation![0]!;
                const y = ry + translation![1]!;
                const z = rz + translation![2]!;

                // MD3 is Z-up: (x, y, z) -> (x, z, -y).
                const ex = md3Frame[v * 3]!;
                const ey = md3Frame[v * 3 + 2]!;
                const ez = -md3Frame[v * 3 + 1]!;

                const error = Math.hypot(x - ex, y - ey, z - ez);
                if (error > worst) worst = error;
                total += error;
                samples += 1;
            }
        }

        const mean = total / samples;

        /*
         The bound is the rig's own measured error, not a number picked to pass.
         `sarge`'s legs decompose to a mean of 0.042 units over every frame; a
         run cycle is ordinary motion for it, so anything much above that means
         the *sampling* is wrong rather than the rig -- an off-by-one in the
         frame range, or the legs correction missing.
        */
        expect(mean, `mean ${mean.toFixed(4)}, worst ${worst.toFixed(3)}`).toBeLessThan(0.1);
        expect(worst).toBeLessThan(3);
    });

    it.skipIf(loaded === null)('places tag_torso where the MD3 tag says', () => {
        const { gltf, bin } = loaded!;

        const raw = readFileSync(join(PLAYERS, 'sarge', 'lower.md3'));
        const md3 = parseMd3(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'lower');

        const tagNode = nodeIndexByName(gltf, 'tag_torso');
        const run = gltf.animations.find((a) => a.name === 'LEGS_RUN')!;
        const runDef = parseAnimationConfig(
            readFileSync(join(PLAYERS, 'sarge', 'animation.cfg'), 'latin1')
        ).find((a) => a.name === 'LEGS_RUN')!;

        const tagIndex = md3.tags[0]!.findIndex((t) => t.name === 'tag_torso');
        expect(tagIndex).toBeGreaterThanOrEqual(0);

        for (let keyframe = 0; keyframe < runDef.numFrames; keyframe++) {
            const { translation, rotation } = sampled(gltf, bin, run, tagNode, keyframe);
            const tag = md3.tags[runDef.firstFrame + keyframe]![tagIndex]!;

            expect(translation![0]).toBeCloseTo(tag.origin[0], 4);
            expect(translation![1]).toBeCloseTo(tag.origin[2], 4);
            expect(translation![2]).toBeCloseTo(-tag.origin[1], 4);

            /*
             The rotation is checked by what it *does*, not by its components:
             applying it to the local forward axis must give the tag's own
             forward vector, converted. A transposed matrix-to-quaternion
             conversion passes any component-wise check that is loose enough to
             pass at all, and fails this one immediately.
            */
            const [fx, fy, fz] = applyQuat(rotation!, 0, 1, 0, 0);
            expect(fx).toBeCloseTo(tag.axis[0][0], 3);
            expect(fy).toBeCloseTo(tag.axis[0][2], 3);
            expect(fz).toBeCloseTo(-tag.axis[0][1], 3);

            const [ux, uy, uz] = applyQuat(rotation!, 0, 0, 1, 0);
            // Local +Y is Q3's +Z, which is the tag's `up`.
            expect(ux).toBeCloseTo(tag.axis[2][0], 3);
            expect(uy).toBeCloseTo(tag.axis[2][2], 3);
            expect(uz).toBeCloseTo(-tag.axis[2][1], 3);
        }
    });
});
