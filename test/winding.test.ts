/*
 * winding.test.ts -- every converted triangle faces the way its normal says.
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
 * This exists because the whole port shipped inside-out for several sessions and
 * nothing noticed (GAP-018). Quake III winds its triangles clockwise from the
 * front; glTF and meep wind counter-clockwise. The converters preserved the
 * source winding, so every world surface, every prop and every character was
 * back-facing, and the renderer culled all of them. It does not *look* like a
 * bug: walls are still walls, and the missing floor reads as "dim" rather than
 * "inside out". I had even written an explanation for it in the report.
 *
 * The check is four lines of arithmetic and needs no oracle, because every one
 * of these formats ships vertex normals: the cross product of a triangle's edges
 * must point the same way as the normals stored at its corners. That is a free
 * ground truth for winding, in any format, and it is the first thing worth
 * asserting in a geometry converter.
 *
 * Degenerate triangles are excluded rather than tolerated. A sliver's
 * winding-derived normal is numerically meaningless, and Q3 content has a few
 * hundred of them -- `oa_dm1` alone has 26 with zero area.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseMd3, drawableSurfaces } from '../tools/pipeline/md3.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** Anything below this is a sliver whose normal direction is noise. */
const MIN_AREA = 1e-6;

interface Agreement {
    readonly agree: number;
    readonly disagree: number;
    readonly degenerate: number;
}

/**
 * Compare each triangle's winding against the normals stored at its vertices.
 *
 * Against the **average of the three corner normals**, which is the same
 * measurement `mesh-normals.ts` makes and is here for the same reason: a single
 * corner is a vertex, and a vertex belongs to every face that names it. On a
 * heavily smoothed surface its normal can lie a degree or two the wrong side of
 * tangent to any one of them, and MD3 quantises normals to a 16-bit lat/long
 * pair -- about 1.4 degrees -- so the sign of that dot product is noise exactly
 * where the geometry is smoothest.
 *
 * This used to read corner `a` alone, and `gauntlet_barrel.md3` is what showed
 * the difference: 68 of 68 triangles agree on the averaged normal and on
 * corners `b` and `c` individually, while 10 of them have an `a` whose dot is
 * between -0.002 and -0.078 -- 90.1 to 94.5 degrees off a face it is very
 * nearly edge-on to. The mesh is manifold, all 102 of its edges carry exactly
 * two faces, and the converter copies it through unaltered; the 85% was the
 * ruler, not the model.
 *
 * It costs nothing as a guard. The defect this file exists for -- a converter
 * that does not reverse winding -- scores 0.000 to 0.013 on every shipped map
 * under this criterion, measured by reversing them back (D-141).
 *
 * @param positions flat xyz
 * @param normals flat xyz, same vertex indexing as `positions`
 */
function agreement(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    indices: ArrayLike<number>
): Agreement {
    let agree = 0;
    let disagree = 0;
    let degenerate = 0;

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i]! * 3;
        const b = indices[i + 1]! * 3;
        const c = indices[i + 2]! * 3;

        const ux = positions[b]! - positions[a]!;
        const uy = positions[b + 1]! - positions[a + 1]!;
        const uz = positions[b + 2]! - positions[a + 2]!;
        const wx = positions[c]! - positions[a]!;
        const wy = positions[c + 1]! - positions[a + 1]!;
        const wz = positions[c + 2]! - positions[a + 2]!;

        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;

        const length = Math.hypot(nx, ny, nz);
        if (length < MIN_AREA) {
            degenerate += 1;
            continue;
        }

        const mx = (normals[a]! + normals[b]! + normals[c]!) / 3;
        const my = (normals[a + 1]! + normals[b + 1]! + normals[c + 1]!) / 3;
        const mz = (normals[a + 2]! + normals[b + 2]! + normals[c + 2]!) / 3;

        const dot = (nx * mx + ny * my + nz * mz) / length;

        if (dot > 0) agree += 1;
        else disagree += 1;
    }

    return { agree, disagree, degenerate };
}

function ratio(a: Agreement): number {
    const total = a.agree + a.disagree;
    return total === 0 ? 1 : a.agree / total;
}

/*
 The threshold is 0.95 rather than 1.0 because Q3 content genuinely contains
 near-degenerate triangles whose stored normals disagree with any winding, and
 because the failure this guards against is not subtle: an unreversed converter
 scores *zero*, not 0.9. `aggressor` measured 0/3272 before the fix and 3262/3262
 after.
*/
const THRESHOLD = 0.95;

/** The same bar applied to one model at a time. See the per-model test. */
const PER_MODEL_THRESHOLD = 0.9;

/*
 Models whose geometry does not admit an orientation at all, named rather than
 absorbed into a looser threshold.

 Empty, and worth keeping for the argument rather than the list.

 `teleporter.md3`'s `t_center` is a four-pointed star built from zero-thickness
 fins: 16 distinct positions, 36 triangles, and 12 edges carrying three or four
 faces each where the spikes meet the middle. A fin has no outward side, so
 there is no assignment of front and back for the flood fill to find and no
 normal for a shared vertex that agrees with every face on it. 8 of its 36
 triangles disagree in the source and would disagree under any repair;
 `mesh-normals.ts` declines the surface for exactly that reason, because the
 alternative is picking a side arbitrarily so a metric reads 100%.

 `teleport_center` is not `cull none`, so Q3 draws it single-sided too and shows
 the same artefact. Content, not a port bug -- the same call D-060 made for
 `skelebot`.

 It was listed here, exempted at 0.8, until `agreement` started averaging the
 three corner normals: the model reads 0.920 under that criterion and clears the
 ordinary per-model bar on its own. An exemption that tolerates *less* than the
 general rule is not an exemption, so it has been retired rather than left to
 cover a model nothing is wrong with (D-141). If the star ever falls below 0.9
 the general assertion catches it, which is what the exemption was for.
*/
const UNORIENTABLE: readonly string[] = [];

const MAPS = ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish'];

describe.each(MAPS)('converted map winding [%s]', (name) => {
    const dir = join(BUILT, name);
    const built = existsSync(join(dir, 'scene.json'));

    it.skipIf(!built)('faces the way its vertex normals say', () => {
        const scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')) as {
            vertexBytes: number;
            indexBytes: number;
            vertexStride: number;
            meshes: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number }[];
        };

        const bin = readFileSync(join(dir, 'geometry.bin'));
        const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

        const vertices = new Float32Array(buffer, 0, scene.vertexBytes / 4);
        const indices = new Uint32Array(buffer, scene.vertexBytes, scene.indexBytes / 4);
        const stride = scene.vertexStride;

        let total: Agreement = { agree: 0, disagree: 0, degenerate: 0 };

        for (const mesh of scene.meshes) {
            // De-interleave this mesh's own block; indices are mesh-relative.
            const positions = new Float32Array(mesh.vertexCount * 3);
            const normals = new Float32Array(mesh.vertexCount * 3);

            for (let i = 0; i < mesh.vertexCount; i++) {
                const o = (mesh.vertexOffset + i) * stride;
                positions[i * 3] = vertices[o]!;
                positions[i * 3 + 1] = vertices[o + 1]!;
                positions[i * 3 + 2] = vertices[o + 2]!;
                normals[i * 3] = vertices[o + 3]!;
                normals[i * 3 + 1] = vertices[o + 4]!;
                normals[i * 3 + 2] = vertices[o + 5]!;
            }

            const slice = indices.subarray(mesh.indexOffset, mesh.indexOffset + mesh.indexCount);
            const a = agreement(positions, normals, slice);

            total = {
                agree: total.agree + a.agree,
                disagree: total.disagree + a.disagree,
                degenerate: total.degenerate + a.degenerate,
            };
        }

        expect(total.agree + total.disagree).toBeGreaterThan(1000);
        expect(
            ratio(total),
            `${total.agree} agree, ${total.disagree} disagree, ${total.degenerate} degenerate`
        ).toBeGreaterThan(THRESHOLD);
    });
});

describe('converted prop bundle winding', () => {
    const dir = join(BUILT, 'models');
    const built = existsSync(join(dir, 'models.json'));

    it.skipIf(!built)('faces the way its vertex normals say', () => {
        const bundle = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as {
            vertexBytes: number;
            indexBytes: number;
            vertexStride: number;
            models: { name: string; meshes: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number }[] }[];
        };

        const bin = readFileSync(join(dir, 'models.bin'));
        const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

        const vertices = new Float32Array(buffer, 0, bundle.vertexBytes / 4);
        const indices = new Uint32Array(buffer, bundle.vertexBytes, bundle.indexBytes / 4);
        const stride = bundle.vertexStride;

        let total: Agreement = { agree: 0, disagree: 0, degenerate: 0 };

        for (const model of bundle.models) {
            for (const mesh of model.meshes) {
                const positions = new Float32Array(mesh.vertexCount * 3);
                const normals = new Float32Array(mesh.vertexCount * 3);

                for (let i = 0; i < mesh.vertexCount; i++) {
                    const o = (mesh.vertexOffset + i) * stride;
                    positions[i * 3] = vertices[o]!;
                    positions[i * 3 + 1] = vertices[o + 1]!;
                    positions[i * 3 + 2] = vertices[o + 2]!;
                    normals[i * 3] = vertices[o + 3]!;
                    normals[i * 3 + 1] = vertices[o + 4]!;
                    normals[i * 3 + 2] = vertices[o + 5]!;
                }

                const slice = indices.subarray(mesh.indexOffset, mesh.indexOffset + mesh.indexCount);
                const a = agreement(positions, normals, slice);

                total = {
                    agree: total.agree + a.agree,
                    disagree: total.disagree + a.disagree,
                    degenerate: total.degenerate + a.degenerate,
                };
            }
        }

        expect(total.agree + total.disagree).toBeGreaterThan(1000);
        expect(
            ratio(total),
            `${total.agree} agree, ${total.disagree} disagree`
        ).toBeGreaterThan(THRESHOLD);
    });

    /*
     And again per model, because the aggregate above cannot see one bad one.

     `nailgun.md3` scored 0.746 on its own while the bundle scored 0.9755 and
     this file passed: 87 well-made models outvoted it, and a weapon you carry
     in first person shaded inside-out went unnoticed until someone looked at it
     (D-140). An average over a bundle is the wrong denominator for a defect
     that lives in one asset.

     The per-model bar is deliberately lower than the bundle's. A 22-triangle gib
     has no room for the slivers the threshold is there to absorb -- one
     disagreeing triangle is 4.5% of it -- so 0.90 is where a real defect starts
     for the smallest models here, and the repaired surfaces all sit at 0.99+.
    */
    it.skipIf(!built)('faces the way its vertex normals say, per model', () => {
        const bundle = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as {
            vertexBytes: number;
            indexBytes: number;
            vertexStride: number;
            models: {
                name: string;
                meshes: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number }[];
            }[];
        };

        const bin = readFileSync(join(dir, 'models.bin'));
        const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

        const vertices = new Float32Array(buffer, 0, bundle.vertexBytes / 4);
        const indices = new Uint32Array(buffer, bundle.vertexBytes, bundle.indexBytes / 4);
        const stride = bundle.vertexStride;

        const worst: { name: string; ratio: number; agree: number; disagree: number }[] = [];

        for (const model of bundle.models) {
            let total: Agreement = { agree: 0, disagree: 0, degenerate: 0 };

            for (const mesh of model.meshes) {
                const positions = new Float32Array(mesh.vertexCount * 3);
                const normals = new Float32Array(mesh.vertexCount * 3);

                for (let i = 0; i < mesh.vertexCount; i++) {
                    const o = (mesh.vertexOffset + i) * stride;
                    positions[i * 3] = vertices[o]!;
                    positions[i * 3 + 1] = vertices[o + 1]!;
                    positions[i * 3 + 2] = vertices[o + 2]!;
                    normals[i * 3] = vertices[o + 3]!;
                    normals[i * 3 + 1] = vertices[o + 4]!;
                    normals[i * 3 + 2] = vertices[o + 5]!;
                }

                const slice = indices.subarray(mesh.indexOffset, mesh.indexOffset + mesh.indexCount);
                const a = agreement(positions, normals, slice);

                total = {
                    agree: total.agree + a.agree,
                    disagree: total.disagree + a.disagree,
                    degenerate: total.degenerate + a.degenerate,
                };
            }

            if (UNORIENTABLE.includes(model.name)) {
                // Still pinned, just at the level the source actually reaches:
                // an exemption that tolerates any number is not an assertion.
                expect(ratio(total), model.name).toBeGreaterThan(0.8);
                continue;
            }

            if (ratio(total) < PER_MODEL_THRESHOLD) {
                worst.push({
                    name: model.name,
                    ratio: ratio(total),
                    agree: total.agree,
                    disagree: total.disagree,
                });
            }
        }

        expect(bundle.models.length).toBeGreaterThan(50);
        expect(
            worst,
            worst
                .map((w) => `${w.name}: ${w.agree} agree, ${w.disagree} disagree (${w.ratio.toFixed(3)})`)
                .join('\n')
        ).toEqual([]);
    });
});

/*
 Characters get a different assertion, because one of them is badly authored.

 `skelebot`'s own MD3 has mixed winding -- 57% clockwise on the legs, 74% on the
 head -- so no absolute threshold is meaningful for it. Q3 renders it with the
 same artefacts; it is content, not a port bug.

 So the invariant tested here is the converter's rather than the content's:
 every triangle must come out reversed relative to the source. That holds for
 consistent models and inconsistent ones alike, and it fails loudly the moment a
 converter stops flipping.
*/
describe('converted character winding', () => {
    const names = ['sarge', 'liz', 'skelebot'];

    it.each(names)('is reversed relative to the source MD3 [%s]', (name) => {
        const dir = join(BUILT, 'characters', name);
        if (!existsSync(join(dir, `${name}.gltf`))) return;

        /* ---- what the source says ---- */

        const players = join(process.cwd(), 'assets', 'extracted', 'models', 'players', name);
        let sourceAgree = 0;
        let sourceDisagree = 0;

        for (const part of ['lower', 'upper', 'head']) {
            const path = join(players, `${part}.md3`);
            if (!existsSync(path)) continue;

            const raw = readFileSync(path);
            const md3 = parseMd3(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
                part
            );

            for (const surface of drawableSurfaces(md3)) {
                const a = agreement(surface.positions[0]!, surface.normals[0]!, surface.indices);
                sourceAgree += a.agree;
                sourceDisagree += a.disagree;
            }
        }

        expect(sourceAgree + sourceDisagree).toBeGreaterThan(100);

        /* ---- what came out ---- */

        const gltf = JSON.parse(readFileSync(join(dir, `${name}.gltf`), 'utf8')) as {
            meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
            accessors: { bufferView: number; componentType: number; count: number; type: string }[];
            bufferViews: { byteOffset: number; byteLength: number }[];
            buffers: { uri: string }[];
        };

        const bin = readFileSync(join(dir, gltf.buffers[0]!.uri));
        const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

        const read = (index: number): Float32Array | Uint32Array => {
            const accessor = gltf.accessors[index]!;
            const view = gltf.bufferViews[accessor.bufferView]!;
            const count = accessor.count * components[accessor.type]!;
            const offset = bin.byteOffset + view.byteOffset;

            return accessor.componentType === 5126
                ? new Float32Array(bin.buffer, offset, count)
                : new Uint32Array(bin.buffer, offset, count);
        };

        let total: Agreement = { agree: 0, disagree: 0, degenerate: 0 };

        for (const mesh of gltf.meshes) {
            for (const primitive of mesh.primitives) {
                const a = agreement(
                    read(primitive.attributes['POSITION']!) as Float32Array,
                    read(primitive.attributes['NORMAL']!) as Float32Array,
                    read(primitive.indices) as Uint32Array
                );

                total = {
                    agree: total.agree + a.agree,
                    disagree: total.disagree + a.disagree,
                    degenerate: total.degenerate + a.degenerate,
                };
            }
        }

        /*
         The converted model's agreement must equal the source's *disagreement*:
         every triangle flipped, and none flipped twice. `sarge` and `liz` land
         near 1.0 because their content is consistent; `skelebot` lands near
         0.63 because its source is 63% clockwise, and that is the correct
         answer for it.

         Banded at five points rather than pinned exactly. On `skelebot` the two
         measurements differ by about 44 triangles of 2,222 -- the counts match
         exactly, so it is a handful changing category near the degenerate-area
         threshold, and I did not chase it further. The band is far tighter than
         the failure it guards: a converter that stopped flipping would score
         `1 - expected`, which is 0.35 here and 0.0 for a consistent model.
        */
        const expected = sourceDisagree / (sourceAgree + sourceDisagree);

        expect(
            ratio(total),
            `${name}: converted ${(100 * ratio(total)).toFixed(1)}% front-facing, ` +
            `source was ${(100 * expected).toFixed(1)}% clockwise`
        ).toBeCloseTo(expected, 1);
    });
});

/* ------------------------------------------------------------------ *
 * Collision hulls
 * ------------------------------------------------------------------ */

/*
 * The other winding in this port, and the one with an engine behaviour attached.
 *
 * `brushHull` turns a Q3 brush's plane set into a polyhedron, and every one of
 * those becomes a `ConvexHullShape3D` the physics world queries. Measured on
 * meep 3.2.0, a hull whose faces are not consistently wound is accepted by the
 * constructor without complaint, answers `overlap` and `support` correctly --
 * and `raycast` against it **silently returns nothing** (BUG-8).
 *
 * `KinematicMover` decides whether the ground under a character is walkable
 * with a raycast. So a winding error here would not read as a winding error: it
 * would read as a player who cannot stand on some floors, which is exactly what
 * BUG-7 read as and cost a session to find.
 *
 * D-073 asserted in prose that `brushHull` emits correctly-wound hulls and used
 * that to conclude the whole-level measurements were sound. This is that claim,
 * checked. No vertex normals here to compare against -- a brush has planes, not
 * normals -- so the ground truth is convexity itself: every face of a convex
 * solid must have the whole solid behind it.
 */
describe.each(['oa_dm1', 'aggressor'])('collision hull winding [%s]', (name) => {
    it('winds every brush hull outward, which is what raycast needs', async () => {
        const { BspFile } = await import('../src/q3/bsp/BspFile.ts');
        const { ClipMap, MASK_PLAYERSOLID } = await import('../src/q3/cm/ClipMap.ts');
        const { buildHulls } = await import('../src/q3/cm/brushHull.ts');

        const raw = readFileSync(join(BUILT, name, 'collision.bsp'));
        const cm = new ClipMap(
            new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), name)
        );

        const world = cm.models[0]!;
        const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

        let faces = 0;
        let inverted = 0;
        let firstBad = '';

        for (const hull of set.hulls) {
            const v = hull.vertices;
            const n = v.length / 3;

            // The centroid of a convex hull's vertices is inside it.
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < n; i++) {
                cx += v[i * 3]!; cy += v[i * 3 + 1]!; cz += v[i * 3 + 2]!;
            }
            cx /= n; cy /= n; cz /= n;

            for (let t = 0; t < hull.indices.length; t += 3) {
                const a = hull.indices[t]! * 3;
                const b = hull.indices[t + 1]! * 3;
                const c = hull.indices[t + 2]! * 3;

                const e1 = [v[b]! - v[a]!, v[b + 1]! - v[a + 1]!, v[b + 2]! - v[a + 2]!];
                const e2 = [v[c]! - v[a]!, v[c + 1]! - v[a + 1]!, v[c + 2]! - v[a + 2]!];

                const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
                const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
                const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;

                const area = Math.hypot(nx, ny, nz);
                if (area < MIN_AREA) continue;

                // Signed distance from the face plane to the interior point. A
                // face wound outward puts the centroid strictly behind it.
                const behind =
                    (cx - v[a]!) * nx + (cy - v[a + 1]!) * ny + (cz - v[a + 2]!) * nz;

                faces += 1;
                if (behind >= 0) {
                    inverted += 1;
                    if (firstBad === '') firstBad = `brush ${hull.brush}, face at index ${t}`;
                }
            }
        }

        expect(faces, 'no non-degenerate faces to check').toBeGreaterThan(1000);
        expect(
            inverted,
            `${inverted} of ${faces} hull faces wound inward` +
            (firstBad === '' ? '' : ` (first: ${firstBad})`)
        ).toBe(0);
    });
});
