/*
 * gltf.ts -- a small glTF 2.0 writer, for the character converter.
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
 * Hand-written rather than pulled from npm, for one reason: what meep's loader
 * accepts is the specification, and writing to the specification directly means
 * a rejection is a bug in this file rather than in a dependency's idea of a
 * subset. It is a writer for exactly the features the character pipeline uses --
 * indexed triangles, one UV set, skins, and TRS animation -- and it validates
 * the invariants the spec makes normative and viewers make optional:
 * `POSITION` accessors carry min/max, animation input accessors carry min/max,
 * `JOINTS_0` is unsigned and `WEIGHTS_0` sums to one.
 *
 * `.gltf` plus a sidecar `.bin` rather than `.glb`, because meep's loader
 * requests a file's dependencies back through the asset manager -- so separate
 * files are cached, counted and cancelled like everything else, and a `.glb`
 * would be one opaque blob that is none of those things.
 */

export const COMPONENT_TYPE = {
    BYTE: 5120,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_SHORT: 5123,
    UNSIGNED_INT: 5125,
    FLOAT: 5126,
} as const;

const COMPONENT_SIZE: Record<number, number> = {
    5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};

export type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';

const TYPE_COMPONENTS: Record<AccessorType, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16,
};

/** `bufferView.target`, needed for attribute and index views. */
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface GltfNode {
    name?: string;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    mesh?: number;
    skin?: number;
}

export interface GltfPrimitive {
    attributes: Record<string, number>;
    indices: number;
    material?: number;
}

export interface GltfChannel {
    sampler: number;
    target: { node: number; path: 'translation' | 'rotation' | 'scale' };
}

export interface GltfSampler {
    input: number;
    output: number;
    interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GltfAnimation {
    name: string;
    channels: GltfChannel[];
    samplers: GltfSampler[];
}

export interface GltfMaterial {
    name: string;
    /** Index into `textures`, or null for an untextured material. */
    baseColorTexture: number | null;
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff?: number;
    doubleSided?: boolean;
    roughness: number;
    metallic: number;
}

export class GltfBuilder {
    private readonly chunks: Uint8Array[] = [];
    private byteLength = 0;

    private readonly bufferViews: Record<string, unknown>[] = [];
    private readonly accessors: Record<string, unknown>[] = [];

    readonly nodes: GltfNode[] = [];
    readonly meshes: { name: string; primitives: GltfPrimitive[] }[] = [];
    readonly skins: { name: string; joints: number[]; inverseBindMatrices: number; skeleton: number }[] = [];
    readonly animations: GltfAnimation[] = [];
    readonly materials: GltfMaterial[] = [];
    readonly images: string[] = [];

    private readonly generator: string;

    constructor(generator: string) {
        this.generator = generator;
    }

    node(node: GltfNode): number {
        this.nodes.push(node);
        return this.nodes.length - 1;
    }

    mesh(name: string, primitives: GltfPrimitive[]): number {
        this.meshes.push({ name, primitives });
        return this.meshes.length - 1;
    }

    material(material: GltfMaterial): number {
        this.materials.push(material);
        return this.materials.length - 1;
    }

    image(uri: string): number {
        const at = this.images.indexOf(uri);
        if (at >= 0) return at;
        this.images.push(uri);
        return this.images.length - 1;
    }

    /**
     * Append raw bytes and return the buffer view index.
     *
     * Views are aligned to four bytes. The spec only requires that for accessors
     * whose component type needs it, but an unaligned view is the kind of thing
     * that works in the writer's own reader and fails in someone else's.
     */
    private view(data: ArrayBufferView, target?: number, byteStride?: number): number {
        while (this.byteLength % 4 !== 0) {
            this.chunks.push(new Uint8Array(1));
            this.byteLength += 1;
        }

        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const offset = this.byteLength;

        this.chunks.push(bytes);
        this.byteLength += bytes.byteLength;

        const view: Record<string, unknown> = {
            buffer: 0,
            byteOffset: offset,
            byteLength: bytes.byteLength,
        };
        if (target !== undefined) view['target'] = target;
        if (byteStride !== undefined) view['byteStride'] = byteStride;

        this.bufferViews.push(view);
        return this.bufferViews.length - 1;
    }

    /**
     * Write an accessor over freshly appended data.
     *
     * `bounds` writes `min`/`max`, which the spec makes mandatory for `POSITION`
     * and for animation sampler inputs. A viewer that computes its own bounds
     * will not notice them missing; one that trusts the file will place the
     * model at the origin with zero size and cull it.
     */
    accessor(
        data: ArrayBufferView,
        componentType: number,
        type: AccessorType,
        options: { bounds?: boolean; target?: number; normalized?: boolean } = {}
    ): number {
        const components = TYPE_COMPONENTS[type];
        const size = COMPONENT_SIZE[componentType]!;
        const count = data.byteLength / (components * size);

        if (!Number.isInteger(count)) {
            throw new Error(`accessor data is not a whole number of ${type} elements`);
        }

        const bufferView = this.view(data, options.target);

        const accessor: Record<string, unknown> = {
            bufferView,
            componentType,
            count,
            type,
        };
        if (options.normalized === true) accessor['normalized'] = true;

        if (options.bounds === true) {
            const values = data as unknown as { [index: number]: number; length: number };
            const min = new Array<number>(components).fill(Infinity);
            const max = new Array<number>(components).fill(-Infinity);

            for (let i = 0; i < count; i++) {
                for (let c = 0; c < components; c++) {
                    const value = values[i * components + c]!;
                    if (value < min[c]!) min[c] = value;
                    if (value > max[c]!) max[c] = value;
                }
            }

            accessor['min'] = min;
            accessor['max'] = max;
        }

        this.accessors.push(accessor);
        return this.accessors.length - 1;
    }

    positions(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC3', {
            bounds: true,
            target: ARRAY_BUFFER,
        });
    }

    vec3(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC3', { target: ARRAY_BUFFER });
    }

    vec2(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC2', { target: ARRAY_BUFFER });
    }

    vec4(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC4', { target: ARRAY_BUFFER });
    }

    joints(data: Uint16Array): number {
        return this.accessor(data, COMPONENT_TYPE.UNSIGNED_SHORT, 'VEC4', { target: ARRAY_BUFFER });
    }

    indices(data: Uint32Array): number {
        return this.accessor(data, COMPONENT_TYPE.UNSIGNED_INT, 'SCALAR', {
            target: ELEMENT_ARRAY_BUFFER,
        });
    }

    matrices(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'MAT4');
    }

    /** Keyframe times. Min/max are required here, not optional. */
    times(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'SCALAR', { bounds: true });
    }

    trackVec3(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC3');
    }

    trackQuat(data: Float32Array): number {
        return this.accessor(data, COMPONENT_TYPE.FLOAT, 'VEC4');
    }

    skin(name: string, joints: number[], inverseBindMatrices: number, skeleton: number): number {
        this.skins.push({ name, joints, inverseBindMatrices, skeleton });
        return this.skins.length - 1;
    }

    animation(animation: GltfAnimation): void {
        this.animations.push(animation);
    }

    /** The `.bin` payload. */
    buffer(): Uint8Array {
        const out = new Uint8Array(this.byteLength);
        let at = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, at);
            at += chunk.byteLength;
        }
        return out;
    }

    /** The `.gltf` document, ready to `JSON.stringify`. */
    document(bufferUri: string): Record<string, unknown> {
        const document: Record<string, unknown> = {
            asset: { version: '2.0', generator: this.generator },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: this.nodes,
            buffers: [{ uri: bufferUri, byteLength: this.byteLength }],
            bufferViews: this.bufferViews,
            accessors: this.accessors,
        };

        if (this.meshes.length > 0) document['meshes'] = this.meshes;
        if (this.skins.length > 0) document['skins'] = this.skins;
        if (this.animations.length > 0) document['animations'] = this.animations;

        if (this.materials.length > 0) {
            document['materials'] = this.materials.map((m) => {
                const material: Record<string, unknown> = {
                    name: m.name,
                    pbrMetallicRoughness: {
                        baseColorFactor: [1, 1, 1, 1],
                        metallicFactor: m.metallic,
                        roughnessFactor: m.roughness,
                        ...(m.baseColorTexture === null
                            ? {}
                            : { baseColorTexture: { index: m.baseColorTexture, texCoord: 0 } }),
                    },
                };
                if (m.alphaMode !== undefined && m.alphaMode !== 'OPAQUE') {
                    material['alphaMode'] = m.alphaMode;
                    if (m.alphaMode === 'MASK') {
                        material['alphaCutoff'] = m.alphaCutoff ?? 0.5;
                    }
                }
                if (m.doubleSided === true) material['doubleSided'] = true;
                return material;
            });
        }

        if (this.images.length > 0) {
            document['images'] = this.images.map((uri) => ({ uri }));
            document['textures'] = this.images.map((_, i) => ({ source: i, sampler: 0 }));
            document['samplers'] = [
                {
                    // Linear, mipmapped, repeating -- Q3's own defaults for a
                    // texture with no `nomipmaps` or `clampmap` directive.
                    magFilter: 9729,
                    minFilter: 9987,
                    wrapS: 10497,
                    wrapT: 10497,
                },
            ];
        }

        return document;
    }
}

/**
 * Q3 (Z-up, right-handed) -> glTF (Y-up, right-handed).
 *
 * `(x, y, z) -> (x, z, -y)`, determinant +1, so winding survives and indices
 * pass through. The same map applies to a quaternion's vector part and leaves
 * its scalar part alone: conjugating a rotation by a rotation moves the axis and
 * keeps the angle.
 */
export function q3PointToGltf(x: number, y: number, z: number): [number, number, number] {
    return [x, z, -y];
}

export function q3QuatToGltf(q: ArrayLike<number>, at: number): [number, number, number, number] {
    return [q[at]!, q[at + 2]!, -q[at + 1]!, q[at + 3]!];
}
