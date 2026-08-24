/*
 * patch.ts -- tessellate Quake III biquadratic Bezier patches.
 *
 * Ported from ioquake3's `code/renderercommon/tr_surface.c`
 * (`RB_SurfaceGrid` / `Transform_Lerp`) and `code/qcommon/cm_patch.c`.
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
 * An `MST_PATCH` surface stores a `patchWidth` x `patchHeight` grid of control
 * points, which is a mesh of overlapping 3x3 biquadratic Bezier patches sharing
 * their edge control points. Q3 re-tessellated these every frame at an LOD
 * chosen from the viewer's distance; here they are tessellated once, offline, at
 * a fixed subdivision.
 *
 * Fixed subdivision rather than LOD is deliberate. Curved surfaces are a small
 * fraction of a Q3 level's triangles, meep culls and batches them like anything
 * else, and a runtime LOD system would be the port re-implementing renderer
 * machinery the brief rules out.
 */

/** Vertex attributes carried through tessellation, matching `drawVert_t`. */
export interface PatchVertex {
    x: number;
    y: number;
    z: number;
    /** Diffuse texture coordinates. */
    s: number;
    t: number;
    /** Lightmap texture coordinates -- kept so the data is not lost, unused for now. */
    lms: number;
    lmt: number;
    nx: number;
    ny: number;
    nz: number;
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface TessellatedPatch {
    readonly vertices: readonly PatchVertex[];
    readonly indices: readonly number[];
    readonly width: number;
    readonly height: number;
}

/**
 * Subdivision level: each 3x3 Bezier patch becomes `LEVEL` x `LEVEL` quads.
 *
 * Q3's own default (`r_subdivisions 4`) produces comparable density. 8 is one
 * step finer, which costs little offline and removes the visible faceting on the
 * large curved walls that OA maps favour.
 */
const LEVEL = 8;

function lerpVertex(out: PatchVertex, a: PatchVertex, b: PatchVertex, f: number): PatchVertex {
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    out.z = a.z + (b.z - a.z) * f;
    out.s = a.s + (b.s - a.s) * f;
    out.t = a.t + (b.t - a.t) * f;
    out.lms = a.lms + (b.lms - a.lms) * f;
    out.lmt = a.lmt + (b.lmt - a.lmt) * f;
    out.nx = a.nx + (b.nx - a.nx) * f;
    out.ny = a.ny + (b.ny - a.ny) * f;
    out.nz = a.nz + (b.nz - a.nz) * f;
    out.r = a.r + (b.r - a.r) * f;
    out.g = a.g + (b.g - a.g) * f;
    out.b = a.b + (b.b - a.b) * f;
    out.a = a.a + (b.a - a.a) * f;
    return out;
}

function blank(): PatchVertex {
    return { x: 0, y: 0, z: 0, s: 0, t: 0, lms: 0, lmt: 0, nx: 0, ny: 0, nz: 0, r: 1, g: 1, b: 1, a: 1 };
}

/** Quadratic Bezier at `f` over three control points. */
function bezier(out: PatchVertex, p0: PatchVertex, p1: PatchVertex, p2: PatchVertex, f: number): PatchVertex {
    const a = (1 - f) * (1 - f);
    const b = 2 * f * (1 - f);
    const c = f * f;

    out.x = p0.x * a + p1.x * b + p2.x * c;
    out.y = p0.y * a + p1.y * b + p2.y * c;
    out.z = p0.z * a + p1.z * b + p2.z * c;
    out.s = p0.s * a + p1.s * b + p2.s * c;
    out.t = p0.t * a + p1.t * b + p2.t * c;
    out.lms = p0.lms * a + p1.lms * b + p2.lms * c;
    out.lmt = p0.lmt * a + p1.lmt * b + p2.lmt * c;
    out.nx = p0.nx * a + p1.nx * b + p2.nx * c;
    out.ny = p0.ny * a + p1.ny * b + p2.ny * c;
    out.nz = p0.nz * a + p1.nz * b + p2.nz * c;
    out.r = p0.r * a + p1.r * b + p2.r * c;
    out.g = p0.g * a + p1.g * b + p2.g * c;
    out.b = p0.b * a + p1.b * b + p2.b * c;
    out.a = p0.a * a + p1.a * b + p2.a * c;
    return out;
}

/**
 * Tessellate one patch surface.
 *
 * @param control `patchWidth * patchHeight` control points in row-major order.
 */
export function tessellatePatch(
    control: readonly PatchVertex[],
    patchWidth: number,
    patchHeight: number
): TessellatedPatch {
    if (patchWidth < 3 || patchHeight < 3 || patchWidth % 2 === 0 || patchHeight % 2 === 0) {
        throw new Error(
            `patch dimensions must be odd and at least 3, got ${patchWidth}x${patchHeight}`
        );
    }

    // Each 3x3 sub-patch shares its edge with the next, so a (2n+1)-wide control
    // grid yields n sub-patches and n*LEVEL + 1 output columns.
    const subU = (patchWidth - 1) / 2;
    const subV = (patchHeight - 1) / 2;
    const outWidth = subU * LEVEL + 1;
    const outHeight = subV * LEVEL + 1;

    const vertices: PatchVertex[] = new Array(outWidth * outHeight);
    for (let i = 0; i < vertices.length; i++) vertices[i] = blank();

    const at = (col: number, row: number): PatchVertex => control[row * patchWidth + col]!;

    const colA = blank();
    const colB = blank();
    const colC = blank();

    for (let sv = 0; sv < subV; sv++) {
        for (let su = 0; su < subU; su++) {
            const baseU = su * 2;
            const baseV = sv * 2;

            for (let j = 0; j <= LEVEL; j++) {
                const fv = j / LEVEL;

                // Collapse the 3x3 control grid down the V axis first, giving three
                // control points for a curve along U.
                bezier(colA, at(baseU, baseV), at(baseU, baseV + 1), at(baseU, baseV + 2), fv);
                bezier(colB, at(baseU + 1, baseV), at(baseU + 1, baseV + 1), at(baseU + 1, baseV + 2), fv);
                bezier(colC, at(baseU + 2, baseV), at(baseU + 2, baseV + 1), at(baseU + 2, baseV + 2), fv);

                for (let i = 0; i <= LEVEL; i++) {
                    const fu = i / LEVEL;
                    const outCol = su * LEVEL + i;
                    const outRow = sv * LEVEL + j;
                    bezier(vertices[outRow * outWidth + outCol]!, colA, colB, colC, fu);
                }
            }
        }
    }

    // Re-normalise: interpolated normals are not unit length.
    for (const v of vertices) {
        const len = Math.hypot(v.nx, v.ny, v.nz);
        if (len > 1e-6) {
            v.nx /= len;
            v.ny /= len;
            v.nz /= len;
        } else {
            v.nx = 0;
            v.ny = 0;
            v.nz = 1;
        }
    }

    const indices: number[] = [];
    for (let row = 0; row < outHeight - 1; row++) {
        for (let col = 0; col < outWidth - 1; col++) {
            const a = row * outWidth + col;
            const b = a + 1;
            const c = a + outWidth;
            const d = c + 1;

            // Winding matches Q3's grid output so face culling agrees with the
            // planar surfaces in the same map.
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    return { vertices, indices, width: outWidth, height: outHeight };
}

export { LEVEL as PATCH_SUBDIVISION, lerpVertex };
