/*
 * mesh-normals.ts -- re-derive normals and winding for badly authored source meshes.
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
 * D-060 established the free ground truth every one of these formats hands us:
 * a triangle's edge cross product must point the same way as the normals stored
 * at its corners. It used that to catch a converter reversing nothing. The same
 * arithmetic, pointed at one surface at a time instead of a whole bundle, also
 * catches the other thing it can mean -- that the *source* is wrong.
 *
 * `models/weapons/nailgun/nailgun.md3` is the case that forced this (D-140). Its
 * two surfaces are broken in two different ways, which is why this module
 * repairs two different things:
 *
 * - `nailgun.002` is not consistently orientable. 122 of its edges have their
 *   two triangles walking them the same way round, so there is no assignment of
 *   front and back that satisfies the mesh. That is broken *winding*, and no
 *   amount of recomputing normals fixes it -- the triangles have to be turned.
 * - `nailgun` winds cleanly and still has 33 triangles whose normals face into
 *   the surface, all of them in one flat cap. That is broken *normals*, and
 *   turning triangles would only move the problem.
 *
 * So: orient first, then re-derive. `repairSurface` reports what the surface
 * scored `before` and `after` so the caller can decline a repair that did not
 * help -- `convert-models.ts` does, and that is what keeps a surface this does
 * not model from being made worse to satisfy a threshold. Nothing here is a
 * judgement call about how a gun ought to look.
 *
 * `teleporter.md3`'s `t_center` is the surface that gets declined: a star of
 * zero-thickness fins, where 12 edges carry three or four faces each. A fin has
 * no outward side, so there is nothing here to find.
 *
 * What this does NOT do is invent smoothing. Q3 content carries its smoothing
 * groups as *vertex splits* -- one position appearing under several indices,
 * each with its own normal -- and that authorship is kept: a vertex's normal is
 * seeded from the faces that name it and only then merged with neighbours
 * across the crease angle, which re-joins UV seams without softening a chamfer.
 */

/** Positions this close together are the same point for smoothing purposes. */
const WELD_QUANTUM = 1e-3;

/**
 * Faces meeting at a sharper angle than this stay hard.
 *
 * 60 degrees is the usual default and it is the right shape for Q3 weapon
 * models, which are chamfered boxes and 8- to 12-sided cylinders: a cylinder
 * that coarse turns 30 to 45 degrees a facet and must stay smooth, while the
 * chamfers that read as edges are all past 60.
 */
const CREASE_DEGREES = 60;

/**
 * Which way an edge cross product points relative to the stored normals.
 *
 * MD3 and Q3's BSP are both `clockwise`; glTF and meep are
 * `counter-clockwise`. See D-060.
 */
export type Winding = 'clockwise' | 'counter-clockwise';

export interface Agreement {
    readonly agree: number;
    readonly disagree: number;
    /** Slivers, whose winding-derived normal is numerically meaningless. */
    readonly degenerate: number;
}

export interface Repair {
    /** `numVerts * 3`, same vertex indexing and axes as the input. */
    readonly normals: Float32Array;
    /** Same length and winding convention as the input. */
    readonly indices: Uint32Array;
    /** Triangles whose winding was turned to agree with their neighbours. */
    readonly reoriented: number;
    /** Vertices whose normal moved more than a degree or so. */
    readonly rewritten: number;
    readonly before: Agreement;
    readonly after: Agreement;
}

/** Anything below this is a sliver. Matches `winding.test.ts`. */
const MIN_AREA = 1e-6;

function faceNormal(
    positions: ArrayLike<number>,
    a: number,
    b: number,
    c: number,
    out: [number, number, number]
): number {
    const ax = positions[a * 3]!;
    const ay = positions[a * 3 + 1]!;
    const az = positions[a * 3 + 2]!;

    const ux = positions[b * 3]! - ax;
    const uy = positions[b * 3 + 1]! - ay;
    const uz = positions[b * 3 + 2]! - az;
    const wx = positions[c * 3]! - ax;
    const wy = positions[c * 3 + 1]! - ay;
    const wz = positions[c * 3 + 2]! - az;

    out[0] = uy * wz - uz * wy;
    out[1] = uz * wx - ux * wz;
    out[2] = ux * wy - uy * wx;

    return Math.hypot(out[0], out[1], out[2]);
}

/**
 * Compare every triangle's winding against the normals stored at its corners.
 *
 * The same four lines of arithmetic as `winding.test.ts`, over the average of
 * the three corner normals rather than one of them: a single corner can be a
 * seam vertex shared with an unrelated face, and this is used to *decide*
 * whether to rewrite a surface rather than only to assert.
 */
export function windingAgreement(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    indices: ArrayLike<number>,
    winding: Winding
): Agreement {
    const sign = winding === 'clockwise' ? -1 : 1;
    const n: [number, number, number] = [0, 0, 0];

    let agree = 0;
    let disagree = 0;
    let degenerate = 0;

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i]!;
        const b = indices[i + 1]!;
        const c = indices[i + 2]!;

        const area = faceNormal(positions, a, b, c, n);
        if (area < MIN_AREA) {
            degenerate += 1;
            continue;
        }

        const mx = (normals[a * 3]! + normals[b * 3]! + normals[c * 3]!) / 3;
        const my = (normals[a * 3 + 1]! + normals[b * 3 + 1]! + normals[c * 3 + 1]!) / 3;
        const mz = (normals[a * 3 + 2]! + normals[b * 3 + 2]! + normals[c * 3 + 2]!) / 3;

        if ((sign * (n[0] * mx + n[1] * my + n[2] * mz)) / area > 0) agree += 1;
        else disagree += 1;
    }

    return { agree, disagree, degenerate };
}

export function agreementRatio(a: Agreement): number {
    const total = a.agree + a.disagree;
    return total === 0 ? 1 : a.agree / total;
}

/** Map every vertex onto an index shared by everything at the same position. */
function weld(positions: ArrayLike<number>, count: number): Int32Array {
    const byKey = new Map<string, number>();
    const out = new Int32Array(count);

    for (let i = 0; i < count; i++) {
        const x = Math.round(positions[i * 3]! / WELD_QUANTUM);
        const y = Math.round(positions[i * 3 + 1]! / WELD_QUANTUM);
        const z = Math.round(positions[i * 3 + 2]! / WELD_QUANTUM);

        const key = `${x},${y},${z}`;
        let id = byKey.get(key);
        if (id === undefined) {
            id = byKey.size;
            byKey.set(key, id);
        }
        out[i] = id;
    }

    return out;
}

/**
 * Decide, per triangle, whether it is wound against its neighbours.
 *
 * Flood fill across shared edges: two triangles agree when they walk the edge
 * between them in opposite directions, which is the definition of a consistently
 * oriented surface. Edges shared by three or more triangles carry no orientation
 * information and are not crossed.
 *
 * The fill makes a component *self*-consistent but its absolute sign is
 * arbitrary -- it depends on which triangle the fill happened to start from --
 * so each component then has to be turned the right way round. The evidence for
 * which way that is comes in three strengths, and taking them in the wrong order
 * gets it wrong:
 *
 * 1. **The component is closed.** Then its signed volume settles it, because a
 *    closed shell wound outward encloses positive volume and nothing about the
 *    authoring can argue with that.
 * 2. **The component is open but the fill hit no conflicts.** Then the source
 *    winding is already self-consistent and it is the artist's own answer, so it
 *    stands. This is the one that has to outrank the normals: `machinegun.md3`'s
 *    `Cube.002` is two flat barrel caps, and on the rear one the *winding* is
 *    right and the *normals* are uniformly backwards. Voting with the normals
 *    there turns a correct cap around to face into the gun.
 * 3. **The fill hit conflicts**, so the winding contradicts itself and cannot be
 *    the answer. Only here are the broken normals worth consulting, and only in
 *    bulk: an area-weighted vote, which `nailgun.002` wins 326 triangles to 199
 *    even before anything is repaired.
 */
function orient(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    indices: ArrayLike<number>,
    welded: Int32Array,
    winding: Winding
): Uint8Array {
    const faces = Math.floor(indices.length / 3);
    const flip = new Uint8Array(faces);
    const seen = new Uint8Array(faces);

    // Edge -> the faces on it, each with the direction that face walks it.
    const edges = new Map<string, { face: number; forward: boolean }[]>();
    for (let f = 0; f < faces; f++) {
        const v = [welded[indices[f * 3]!]!, welded[indices[f * 3 + 1]!]!, welded[indices[f * 3 + 2]!]!];
        for (let e = 0; e < 3; e++) {
            const u = v[e]!;
            const w = v[(e + 1) % 3]!;
            if (u === w) continue;

            const key = u < w ? `${u},${w}` : `${w},${u}`;
            let list = edges.get(key);
            if (list === undefined) edges.set(key, (list = []));
            list.push({ face: f, forward: u < w });
        }
    }

    const sign = winding === 'clockwise' ? -1 : 1;
    const n: [number, number, number] = [0, 0, 0];

    for (let start = 0; start < faces; start++) {
        if (seen[start] === 1) continue;

        const component: number[] = [];
        const queue = [start];
        seen[start] = 1;
        flip[start] = 0;

        let conflicted = false;
        let closed = true;

        while (queue.length > 0) {
            const f = queue.pop()!;
            component.push(f);

            const v = [
                welded[indices[f * 3]!]!,
                welded[indices[f * 3 + 1]!]!,
                welded[indices[f * 3 + 2]!]!,
            ];

            for (let e = 0; e < 3; e++) {
                const u = v[e]!;
                const w = v[(e + 1) % 3]!;
                if (u === w) continue;

                const list = edges.get(u < w ? `${u},${w}` : `${w},${u}`)!;
                // An edge with anything but two faces on it is a border or a
                // branch: no "other side" to propagate to, and not a closed shell.
                if (list.length !== 2) {
                    closed = false;
                    continue;
                }

                const here = list.find((x) => x.face === f)!;
                const other = list.find((x) => x.face !== f);
                if (other === undefined) continue;

                // Opposite directions along the edge means already consistent.
                const consistent = other.forward !== here.forward;
                const want = consistent ? flip[f]! : (flip[f]! ^ 1);

                if (seen[other.face] === 1) {
                    // Already placed from another direction. Disagreeing here is
                    // what "not orientable" means -- 122 of `nailgun.002`'s edges.
                    if (flip[other.face] !== want) conflicted = true;
                    continue;
                }

                seen[other.face] = 1;
                flip[other.face] = want;
                queue.push(other.face);
            }
        }

        if (closed) {
            // Signed volume, over the component's triangles wound outward. Six
            // times it, and about an arbitrary origin -- both are constant
            // factors and only the sign is being read.
            let volume = 0;
            for (const f of component) {
                const a = indices[f * 3]!;
                const b = indices[f * 3 + 1]!;
                const c = indices[f * 3 + 2]!;

                // Outward-facing order, given the source convention and the fill.
                const outward = (winding === 'clockwise') !== (flip[f] === 1);
                const [p, q, r] = outward ? [a, c, b] : [a, b, c];

                const px = positions[p * 3]!;
                const py = positions[p * 3 + 1]!;
                const pz = positions[p * 3 + 2]!;
                const qx = positions[q * 3]!;
                const qy = positions[q * 3 + 1]!;
                const qz = positions[q * 3 + 2]!;
                const rx = positions[r * 3]!;
                const ry = positions[r * 3 + 1]!;
                const rz = positions[r * 3 + 2]!;

                volume +=
                    px * (qy * rz - qz * ry) -
                    py * (qx * rz - qz * rx) +
                    pz * (qx * ry - qy * rx);
            }

            if (volume < 0) for (const f of component) flip[f] ^= 1;
            continue;
        }

        // Open and self-consistent: the source winding is the artist's answer.
        if (!conflicted) continue;

        // Open and self-contradictory. Only now are the normals worth a vote.
        let vote = 0;
        for (const f of component) {
            const a = indices[f * 3]!;
            const b = indices[f * 3 + 1]!;
            const c = indices[f * 3 + 2]!;

            const area = faceNormal(positions, a, b, c, n);
            if (area < MIN_AREA) continue;

            const mx = (normals[a * 3]! + normals[b * 3]! + normals[c * 3]!) / 3;
            const my = (normals[a * 3 + 1]! + normals[b * 3 + 1]! + normals[c * 3 + 1]!) / 3;
            const mz = (normals[a * 3 + 2]! + normals[b * 3 + 2]! + normals[c * 3 + 2]!) / 3;

            const d = sign * (n[0] * mx + n[1] * my + n[2] * mz);
            vote += flip[f] === 1 ? -d : d;
        }

        if (vote < 0) for (const f of component) flip[f] ^= 1;
    }

    return flip;
}

/**
 * Re-derive a surface's winding and normals from its own geometry.
 *
 * `positions` and `normals` are frame data, flat xyz, in the source's own axes;
 * `indices` are in the source's own winding. The result is in both of those same
 * conventions, so this drops in ahead of whatever axis map the converter applies.
 */
export function repairSurface(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    indices: ArrayLike<number>,
    winding: Winding
): Repair {
    const count = Math.floor(positions.length / 3);
    const faces = Math.floor(indices.length / 3);

    const before = windingAgreement(positions, normals, indices, winding);
    const welded = weld(positions, count);
    const flip = orient(positions, normals, indices, welded, winding);

    /* ---- turn the minority triangles ---- */

    const outIndices = new Uint32Array(indices.length);
    let reoriented = 0;
    for (let f = 0; f < faces; f++) {
        const a = indices[f * 3]!;
        const b = indices[f * 3 + 1]!;
        const c = indices[f * 3 + 2]!;

        if (flip[f] === 1) {
            outIndices[f * 3] = a;
            outIndices[f * 3 + 1] = c;
            outIndices[f * 3 + 2] = b;
            reoriented += 1;
        } else {
            outIndices[f * 3] = a;
            outIndices[f * 3 + 1] = b;
            outIndices[f * 3 + 2] = c;
        }
    }

    /* ---- outward face normals, area-weighted by staying un-normalised ---- */

    const sign = winding === 'clockwise' ? -1 : 1;
    const outward = new Float64Array(faces * 3);
    const unit = new Float64Array(faces * 3);
    const n: [number, number, number] = [0, 0, 0];

    for (let f = 0; f < faces; f++) {
        const area = faceNormal(
            positions,
            outIndices[f * 3]!,
            outIndices[f * 3 + 1]!,
            outIndices[f * 3 + 2]!,
            n
        );

        outward[f * 3] = sign * n[0];
        outward[f * 3 + 1] = sign * n[1];
        outward[f * 3 + 2] = sign * n[2];

        if (area >= MIN_AREA) {
            unit[f * 3] = (sign * n[0]) / area;
            unit[f * 3 + 1] = (sign * n[1]) / area;
            unit[f * 3 + 2] = (sign * n[2]) / area;
        }
    }

    /* ---- smoothing groups: the artist's splits first, creases second ---- */

    // Faces naming each vertex index, and faces touching each welded position.
    const byVertex: number[][] = Array.from({ length: count }, () => []);
    const byPosition: number[][] = [];
    for (let f = 0; f < faces; f++) {
        for (let e = 0; e < 3; e++) {
            const v = outIndices[f * 3 + e]!;
            byVertex[v]!.push(f);

            const p = welded[v]!;
            while (byPosition.length <= p) byPosition.push([]);
            if (!byPosition[p]!.includes(f)) byPosition[p]!.push(f);
        }
    }

    const crease = Math.cos((CREASE_DEGREES * Math.PI) / 180);
    const out = new Float32Array(count * 3);
    let rewritten = 0;

    for (let v = 0; v < count; v++) {
        // Seed from the faces that name this exact vertex -- that set *is* the
        // smoothing group the artist authored.
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const f of byVertex[v]!) {
            sx += outward[f * 3]!;
            sy += outward[f * 3 + 1]!;
            sz += outward[f * 3 + 2]!;
        }

        let length = Math.hypot(sx, sy, sz);
        if (length > 0) {
            // Merge in the faces that share the position but not the index --
            // a UV seam -- when they are not across a crease from the seed.
            const seedX = sx / length;
            const seedY = sy / length;
            const seedZ = sz / length;

            for (const f of byPosition[welded[v]!] ?? []) {
                if (byVertex[v]!.includes(f)) continue;

                const d = unit[f * 3]! * seedX + unit[f * 3 + 1]! * seedY + unit[f * 3 + 2]! * seedZ;
                if (d < crease) continue;

                sx += outward[f * 3]!;
                sy += outward[f * 3 + 1]!;
                sz += outward[f * 3 + 2]!;
            }
            length = Math.hypot(sx, sy, sz);
        }

        if (length > 0) {
            out[v * 3] = sx / length;
            out[v * 3 + 1] = sy / length;
            out[v * 3 + 2] = sz / length;
        } else {
            // Every face here cancelled out, which means this vertex only ever
            // appears on slivers. Keep what the source said.
            out[v * 3] = normals[v * 3]!;
            out[v * 3 + 1] = normals[v * 3 + 1]!;
            out[v * 3 + 2] = normals[v * 3 + 2]!;
        }

        const moved =
            out[v * 3]! * normals[v * 3]! +
            out[v * 3 + 1]! * normals[v * 3 + 1]! +
            out[v * 3 + 2]! * normals[v * 3 + 2]!;
        if (moved < 0.999) rewritten += 1;
    }

    return {
        normals: out,
        indices: outIndices,
        reoriented,
        rewritten,
        before,
        after: windingAgreement(positions, out, outIndices, winding),
    };
}
