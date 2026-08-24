/*
 * md3.ts -- reader for Quake III's MD3 model format.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * Layout follows `code/renderercommon/qfiles.h` (`md3Header_t` and friends).
 *
 * ---
 *
 * MD3 is a *vertex morph* format: every frame carries a full copy of every
 * vertex position, quantised to 1/64 of a unit. There are no bones and no
 * weights, which is why the brief says to replace the animation pipeline rather
 * than port it -- meep animates skinned meshes and has no morph-target path.
 * This reader stops at "here are the frames"; turning frames into a skeleton is
 * `tools/pipeline/rig.ts`'s problem.
 *
 * Two details worth knowing before reading the code:
 *
 * - Surfaces are *chained*, not indexed. Each `md3Surface_t` ends with its own
 *   `ofsEnd` and the next one starts there. There is no surface offset table.
 * - Normals are stored as a packed lat/long pair in a single 16-bit word, which
 *   loses roughly 1.4 degrees of angle. Q3 does the same decode at load time.
 */

const MD3_IDENT = 0x33504449; // 'IDP3', little-endian
const MD3_VERSION = 15;
const MD3_XYZ_SCALE = 1 / 64;

const MAX_QPATH = 64;

const HEADER_BYTES = 108;
const FRAME_BYTES = 56;
const TAG_BYTES = 112;
const SURFACE_HEADER_BYTES = 108;
const SHADER_BYTES = 68;

export interface Md3Frame {
    readonly mins: readonly [number, number, number];
    readonly maxs: readonly [number, number, number];
    readonly localOrigin: readonly [number, number, number];
    readonly radius: number;
    readonly name: string;
}

export interface Md3Tag {
    readonly name: string;
    readonly origin: readonly [number, number, number];
    /** Rotation as three basis vectors: forward, left, up. Q3 axes. */
    readonly axis: readonly [
        readonly [number, number, number],
        readonly [number, number, number],
        readonly [number, number, number],
    ];
}

export interface Md3Surface {
    readonly name: string;
    /**
     * Shader names as authored. Frequently absolute paths from the artist's
     * machine (`E:\projects\oa\baseq3\models\...`), which is why a `.skin` file
     * -- keyed on the *surface* name -- is the authoritative material mapping
     * for player models rather than this.
     */
    readonly shaders: readonly string[];
    readonly numFrames: number;
    readonly numVerts: number;
    readonly indices: Uint32Array;
    /** `numVerts * 2`, in MD3's own convention (V increases downward). */
    readonly st: Float32Array;
    /** One entry per frame, each `numVerts * 3`, in Q3 units and Q3 axes. */
    readonly positions: readonly Float32Array[];
    /** One entry per frame, each `numVerts * 3`, unit length. */
    readonly normals: readonly Float32Array[];
}

export interface Md3Model {
    readonly name: string;
    readonly numFrames: number;
    readonly frames: readonly Md3Frame[];
    /** One entry per frame, in the same order as `frames`. */
    readonly tags: readonly (readonly Md3Tag[])[];
    readonly surfaces: readonly Md3Surface[];
}

function readString(view: DataView, offset: number, length: number): string {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    let end = bytes.indexOf(0);
    if (end < 0) end = length;

    // Latin-1 rather than UTF-8: these are 8-bit C strings and a stray high byte
    // in a path should not throw.
    let out = '';
    for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]!);
    return out;
}

/**
 * Decode Q3's packed normal.
 *
 * `R_MDCsomething` aside, the encoding in `qfiles.h` is a latitude in the high
 * byte and a longitude in the low byte, each covering a full turn over 0..255.
 */
function decodeNormal(packed: number, out: Float32Array, at: number): void {
    const lat = ((packed >> 8) & 0xff) * ((2 * Math.PI) / 255);
    const lng = (packed & 0xff) * ((2 * Math.PI) / 255);

    const sinLng = Math.sin(lng);

    out[at] = Math.cos(lat) * sinLng;
    out[at + 1] = Math.sin(lat) * sinLng;
    out[at + 2] = Math.cos(lng);
}

export function parseMd3(buffer: ArrayBuffer, name: string): Md3Model {
    const view = new DataView(buffer);

    if (buffer.byteLength < HEADER_BYTES) {
        throw new Error(`${name}: too small to be an MD3 (${buffer.byteLength} bytes)`);
    }

    const ident = view.getInt32(0, true);
    if (ident !== MD3_IDENT) {
        throw new Error(`${name}: not an MD3 (ident 0x${(ident >>> 0).toString(16)})`);
    }

    const version = view.getInt32(4, true);
    if (version !== MD3_VERSION) {
        throw new Error(`${name}: MD3 version ${version}, expected ${MD3_VERSION}`);
    }

    const numFrames = view.getInt32(76, true);
    const numTags = view.getInt32(80, true);
    const numSurfaces = view.getInt32(84, true);
    const ofsFrames = view.getInt32(92, true);
    const ofsTags = view.getInt32(96, true);
    const ofsSurfaces = view.getInt32(100, true);

    /* ---- frames ---- */

    const frames: Md3Frame[] = [];
    for (let i = 0; i < numFrames; i++) {
        const o = ofsFrames + i * FRAME_BYTES;
        frames.push({
            mins: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)],
            maxs: [
                view.getFloat32(o + 12, true),
                view.getFloat32(o + 16, true),
                view.getFloat32(o + 20, true),
            ],
            localOrigin: [
                view.getFloat32(o + 24, true),
                view.getFloat32(o + 28, true),
                view.getFloat32(o + 32, true),
            ],
            radius: view.getFloat32(o + 36, true),
            name: readString(view, o + 40, 16),
        });
    }

    /* ---- tags: numFrames * numTags, frame-major ---- */

    const tags: Md3Tag[][] = [];
    for (let f = 0; f < numFrames; f++) {
        const perFrame: Md3Tag[] = [];
        for (let t = 0; t < numTags; t++) {
            const o = ofsTags + (f * numTags + t) * TAG_BYTES;
            const v = (at: number): [number, number, number] => [
                view.getFloat32(at, true),
                view.getFloat32(at + 4, true),
                view.getFloat32(at + 8, true),
            ];
            perFrame.push({
                name: readString(view, o, MAX_QPATH),
                origin: v(o + 64),
                axis: [v(o + 76), v(o + 88), v(o + 100)],
            });
        }
        tags.push(perFrame);
    }

    /* ---- surfaces, chained through their own ofsEnd ---- */

    const surfaces: Md3Surface[] = [];
    let surfaceOffset = ofsSurfaces;

    for (let s = 0; s < numSurfaces; s++) {
        const base = surfaceOffset;

        const surfaceName = readString(view, base + 4, MAX_QPATH);
        const surfaceFrames = view.getInt32(base + 72, true);
        const numShaders = view.getInt32(base + 76, true);
        const numVerts = view.getInt32(base + 80, true);
        const numTriangles = view.getInt32(base + 84, true);
        const ofsTriangles = view.getInt32(base + 88, true);
        const ofsShaders = view.getInt32(base + 92, true);
        const ofsSt = view.getInt32(base + 96, true);
        const ofsXyzNormals = view.getInt32(base + 100, true);
        const ofsEnd = view.getInt32(base + 104, true);

        if (ofsEnd <= SURFACE_HEADER_BYTES) {
            throw new Error(`${name}: surface ${s} has a non-advancing ofsEnd (${ofsEnd})`);
        }

        const shaders: string[] = [];
        for (let i = 0; i < numShaders; i++) {
            shaders.push(readString(view, base + ofsShaders + i * SHADER_BYTES, MAX_QPATH));
        }

        const indices = new Uint32Array(numTriangles * 3);
        for (let i = 0; i < numTriangles * 3; i++) {
            indices[i] = view.getInt32(base + ofsTriangles + i * 4, true);
        }

        const st = new Float32Array(numVerts * 2);
        for (let i = 0; i < numVerts * 2; i++) {
            st[i] = view.getFloat32(base + ofsSt + i * 4, true);
        }

        const positions: Float32Array[] = [];
        const normals: Float32Array[] = [];

        for (let f = 0; f < surfaceFrames; f++) {
            const p = new Float32Array(numVerts * 3);
            const n = new Float32Array(numVerts * 3);
            let o = base + ofsXyzNormals + f * numVerts * 8;

            for (let i = 0; i < numVerts; i++, o += 8) {
                p[i * 3] = view.getInt16(o, true) * MD3_XYZ_SCALE;
                p[i * 3 + 1] = view.getInt16(o + 2, true) * MD3_XYZ_SCALE;
                p[i * 3 + 2] = view.getInt16(o + 4, true) * MD3_XYZ_SCALE;
                decodeNormal(view.getUint16(o + 6, true), n, i * 3);
            }

            positions.push(p);
            normals.push(n);
        }

        surfaces.push({
            name: surfaceName,
            shaders,
            numFrames: surfaceFrames,
            numVerts,
            indices,
            st,
            positions,
            normals,
        });

        surfaceOffset = base + ofsEnd;
    }

    return { name, numFrames, frames, tags, surfaces };
}

/**
 * The surfaces of a model that actually have geometry.
 *
 * OA ships MD3s with empty surfaces and, in one case, with none at all:
 * `tony`'s `l_belt` and `u_vest` are 0 vertices and 0 triangles, and
 * `neko/upper.md3` has 278 frames and no surfaces whatsoever. Q3's renderer
 * skips them without comment; a converter that does not emits zero-count glTF
 * accessors and rigs a skeleton over no vertices, which produces `NaN`
 * centroids that `JSON.stringify` writes as `null` and a loader rejects with
 * "expected x to be a number".
 */
export function drawableSurfaces(md3: Md3Model): Md3Surface[] {
    return md3.surfaces.filter((s) => s.numVerts > 0 && s.indices.length > 0);
}

/**
 * Parse a `.skin` file: `surfaceName,texturePath` per line.
 *
 * Q3 also allows `tag_*,` lines with an empty right-hand side, and OA files
 * carry the odd blank line and stray comma. Anything that does not split into
 * two non-empty halves is skipped rather than treated as an error, which is
 * what `R_LoadSkin` does.
 */
export function parseSkin(source: string): Map<string, string> {
    const out = new Map<string, string>();

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('//')) continue;

        const comma = line.indexOf(',');
        if (comma < 0) continue;

        const surface = line.slice(0, comma).trim();
        const shader = line.slice(comma + 1).trim().replace(/\\/g, '/');

        if (surface.length === 0 || shader.length === 0) continue;
        if (surface.startsWith('tag_')) continue;

        out.set(surface, shader);
    }

    return out;
}

/**
 * Normalise a shader name found inside an MD3.
 *
 * Artists shipped absolute paths -- `E:\projects\oa\baseq3\models\players\...`
 * appears in stock OA content. Q3's own loader is equally forgiving in practice
 * because `.skin` files override it; when there is no skin file, trimming
 * everything up to a known content root is the only way to get a usable name.
 */
export function normaliseShaderName(raw: string): string {
    const slashed = raw.replace(/\\/g, '/').trim();

    for (const root of ['/baseq3/', '/baseoa/', '/models/', '/textures/', '/sprites/']) {
        const at = slashed.toLowerCase().lastIndexOf(root);
        if (at > 0) {
            // Keep `models/...` and `textures/...`; drop only the machine prefix.
            return slashed.slice(root === '/baseq3/' || root === '/baseoa/' ? at + root.length : at + 1);
        }
    }

    return slashed.replace(/^\.?\//, '');
}
