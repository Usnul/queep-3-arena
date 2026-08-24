/*
 * rig.ts -- turn vertex-morph animation into a skeleton.
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
 * MD3 stores every frame as a full copy of every vertex. meep animates skinned
 * meshes and has no morph-target path -- `load_gltf` explicitly returns -1 for
 * the `weights` channel and skips it -- so the brief's instruction to replace
 * the animation pipeline rather than port it is not a preference, it is the
 * only route. Replacing it means *inferring* a skeleton that was never authored.
 *
 * The method is a reduced form of skinning decomposition (Le & Deng's SSDR,
 * without the weight-solve stage):
 *
 *   1. Cluster vertices by trajectory. Two vertices that follow the same path
 *      through every frame belong to the same bone, which is the definition of
 *      a bone -- so k-means over the concatenated per-frame positions finds
 *      bones without being told what a limb is.
 *   2. Fit a rigid transform per cluster per frame, by Kabsch. This is the step
 *      that turns "these vertices move together" into "here is the rotation and
 *      translation they move by".
 *   3. Reassign each vertex to whichever cluster reconstructs it best, and
 *      repeat. This is what lets a bad initial split recover: a vertex k-means
 *      put in the thigh because it happened to be near one moves to the shin
 *      once the shin's actual transform is known.
 *
 * Every vertex ends with exactly one influence at weight 1. Real skinning
 * blends four, and the visible cost of not doing so is a crease at cluster
 * boundaries -- an elbow that folds rather than bends. The measured
 * reconstruction error says how much that costs, per model, and it is reported
 * rather than assumed: see `RigResult.error` and the summary the converter
 * prints.
 *
 * The alternative worth naming, because it is tempting and wrong: one joint per
 * vertex, with the joint's translation track *being* the vertex's trajectory.
 * That is exact -- bit-exact, even -- and it turns a 278-vertex leg into a
 * 278-joint skeleton whose matrix palette is 17 KB per instance. Exactness is
 * not worth 40x the joints when the error at 24 joints is a fraction of a unit.
 */

export interface RigOptions {
    /** Target cluster count. Q3 limbs decompose well at 20-32. */
    readonly joints: number;
    /** Reassign-and-refit passes after k-means. */
    readonly refineIterations: number;
}

export interface RigError {
    /** Mean per-vertex reconstruction error, in Q3 units. */
    readonly mean: number;
    readonly rms: number;
    readonly max: number;
    /** Fraction of vertex-frames within a quarter of a unit -- under a centimetre. */
    readonly within025: number;
}

export interface RigResult {
    /** Rest centroid of each joint, in Q3 units. Joints are a flat list, no hierarchy. */
    readonly centroids: Float32Array;
    readonly jointCount: number;
    /** One joint index per vertex. */
    readonly vertexJoint: Uint16Array;
    /**
     * Per frame, per joint: rotation as `xyzw` and translation as `xyz`, both
     * relative to the joint's rest centroid.
     */
    readonly rotations: Float32Array[];
    readonly translations: Float32Array[];
    readonly error: RigError;
}

/* ------------------------------------------------------------------ *
 * Rotation fitting.
 *
 * Kabsch by way of Horn's quaternion method rather than an SVD. The
 * cross-covariance of the two point sets goes into a symmetric 4x4 whose
 * dominant eigenvector *is* the rotation quaternion, so the whole thing is one
 * Jacobi sweep and no sign-correction step -- an SVD-based Kabsch has to check
 * `det(R) < 0` and flip a column, and getting that wrong produces a reflection
 * that reconstructs the points perfectly and turns the model inside out.
 * ------------------------------------------------------------------ */

/** Symmetric 4x4 eigen-decomposition by cyclic Jacobi. Returns the dominant eigenvector. */
function dominantEigenvector(m: Float64Array, out: Float64Array): void {
    // Working copy of the matrix and an accumulating basis.
    const a = Float64Array.from(m);
    const v = new Float64Array(16);
    for (let i = 0; i < 4; i++) v[i * 4 + i] = 1;

    for (let sweep = 0; sweep < 24; sweep++) {
        let off = 0;
        for (let p = 0; p < 4; p++) {
            for (let q = p + 1; q < 4; q++) off += a[p * 4 + q]! * a[p * 4 + q]!;
        }
        if (off < 1e-24) break;

        for (let p = 0; p < 4; p++) {
            for (let q = p + 1; q < 4; q++) {
                const apq = a[p * 4 + q]!;
                if (Math.abs(apq) < 1e-30) continue;

                const theta = (a[q * 4 + q]! - a[p * 4 + p]!) / (2 * apq);
                const t =
                    Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;

                for (let k = 0; k < 4; k++) {
                    const akp = a[k * 4 + p]!;
                    const akq = a[k * 4 + q]!;
                    a[k * 4 + p] = c * akp - s * akq;
                    a[k * 4 + q] = s * akp + c * akq;
                }
                for (let k = 0; k < 4; k++) {
                    const apk = a[p * 4 + k]!;
                    const aqk = a[q * 4 + k]!;
                    a[p * 4 + k] = c * apk - s * aqk;
                    a[q * 4 + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 4; k++) {
                    const vkp = v[k * 4 + p]!;
                    const vkq = v[k * 4 + q]!;
                    v[k * 4 + p] = c * vkp - s * vkq;
                    v[k * 4 + q] = s * vkp + c * vkq;
                }
            }
        }
    }

    let best = 0;
    for (let i = 1; i < 4; i++) if (a[i * 4 + i]! > a[best * 4 + best]!) best = i;

    for (let k = 0; k < 4; k++) out[k] = v[k * 4 + best]!;
}

const eigenMatrix = new Float64Array(16);
const eigenVector = new Float64Array(4);

/**
 * Rotation taking `rest` onto `current`, both already centred on their own means.
 *
 * @param out receives `xyzw`, glTF's quaternion order.
 */
export function fitRotation(
    rest: Float64Array,
    current: Float64Array,
    count: number,
    out: Float32Array,
    at: number
): void {
    let sxx = 0, sxy = 0, sxz = 0;
    let syx = 0, syy = 0, syz = 0;
    let szx = 0, szy = 0, szz = 0;

    for (let i = 0; i < count; i++) {
        const px = rest[i * 3]!, py = rest[i * 3 + 1]!, pz = rest[i * 3 + 2]!;
        const qx = current[i * 3]!, qy = current[i * 3 + 1]!, qz = current[i * 3 + 2]!;

        sxx += px * qx; sxy += px * qy; sxz += px * qz;
        syx += py * qx; syy += py * qy; syz += py * qz;
        szx += pz * qx; szy += pz * qy; szz += pz * qz;
    }

    const n = eigenMatrix;
    n[0] = sxx + syy + szz;  n[1] = syz - szy;         n[2] = szx - sxz;         n[3] = sxy - syx;
    n[4] = syz - szy;        n[5] = sxx - syy - szz;   n[6] = sxy + syx;         n[7] = szx + sxz;
    n[8] = szx - sxz;        n[9] = sxy + syx;         n[10] = -sxx + syy - szz; n[11] = syz + szy;
    n[12] = sxy - syx;       n[13] = szx + sxz;        n[14] = syz + szy;        n[15] = -sxx - syy + szz;

    dominantEigenvector(n, eigenVector);

    // Horn's eigenvector is (w, x, y, z); glTF wants (x, y, z, w).
    let w = eigenVector[0]!, x = eigenVector[1]!, y = eigenVector[2]!, z = eigenVector[3]!;

    const length = Math.hypot(w, x, y, z);
    if (length < 1e-12) {
        out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; out[at + 3] = 1;
        return;
    }

    w /= length; x /= length; y /= length; z /= length;
    // Keep the scalar part positive so consecutive keyframes never take the
    // long way round when the runtime slerps between them.
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }

    out[at] = x; out[at + 1] = y; out[at + 2] = z; out[at + 3] = w;
}

/** Apply a quaternion to a vector, in place-ish. */
function rotate(q: Float32Array, at: number, x: number, y: number, z: number, out: Float64Array): void {
    const qx = q[at]!, qy = q[at + 1]!, qz = q[at + 2]!, qw = q[at + 3]!;

    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/* ------------------------------------------------------------------ *
 * Clustering.
 * ------------------------------------------------------------------ */

/**
 * k-means over vertex trajectories.
 *
 * The feature is the vertex's position in *every* frame, concatenated. Using
 * absolute positions rather than displacements is deliberate: it makes the rest
 * position part of the distance, so a cluster is both "moves together" and
 * "is in the same place", which is what a bone is. Displacement-only features
 * happily merge the left and right feet, because they follow mirrored paths
 * that are identical in magnitude for half the cycle.
 *
 * Seeded deterministically -- farthest-point initialisation rather than random
 * -- so the pipeline is reproducible. A converter that emits different
 * skeletons on different runs makes every diff useless.
 */
function initialClusters(
    frames: readonly Float32Array[],
    vertexCount: number,
    k: number
): Uint16Array {
    const assignment = new Uint16Array(vertexCount);
    const seeds: number[] = [0];

    const distance = (a: number, b: number): number => {
        let sum = 0;
        for (const frame of frames) {
            const dx = frame[a * 3]! - frame[b * 3]!;
            const dy = frame[a * 3 + 1]! - frame[b * 3 + 1]!;
            const dz = frame[a * 3 + 2]! - frame[b * 3 + 2]!;
            sum += dx * dx + dy * dy + dz * dz;
        }
        return sum;
    };

    // Farthest-point seeding: each new seed is the vertex furthest from every
    // seed so far, which spreads the initial clusters over the whole model
    // instead of clumping them wherever the first few vertices happened to be.
    const best = new Float64Array(vertexCount).fill(Infinity);

    while (seeds.length < k) {
        const last = seeds[seeds.length - 1]!;
        let winner = 0;
        let winnerDistance = -1;

        for (let v = 0; v < vertexCount; v++) {
            const d = distance(v, last);
            if (d < best[v]!) best[v] = d;
            if (best[v]! > winnerDistance) {
                winnerDistance = best[v]!;
                winner = v;
            }
        }

        if (winnerDistance <= 0) break; // fewer distinct trajectories than clusters
        seeds.push(winner);
    }

    for (let v = 0; v < vertexCount; v++) {
        let bestSeed = 0;
        let bestDistance = Infinity;
        for (let s = 0; s < seeds.length; s++) {
            const d = distance(v, seeds[s]!);
            if (d < bestDistance) {
                bestDistance = d;
                bestSeed = s;
            }
        }
        assignment[v] = bestSeed;
    }

    return assignment;
}

/**
 * Fit one rigid transform per cluster per frame, and measure the result.
 *
 * The rest pose is frame 0. That is not arbitrary: MD3's frame 0 for a Q3
 * player model is the first frame of `BOTH_DEATH1`, which is a standing pose,
 * so it is a reasonable bind pose. A mid-animation bind pose would work too --
 * the maths does not care -- but the model would look wrong in any viewer that
 * shows it unposed.
 */
function fitClusters(
    frames: readonly Float32Array[],
    assignment: Uint16Array,
    vertexCount: number,
    jointCount: number
): {
    centroids: Float32Array;
    rotations: Float32Array[];
    translations: Float32Array[];
} {
    const rest = frames[0]!;

    const members: number[][] = Array.from({ length: jointCount }, () => []);
    for (let v = 0; v < vertexCount; v++) members[assignment[v]!]!.push(v);

    const centroids = new Float32Array(jointCount * 3);
    for (let j = 0; j < jointCount; j++) {
        const list = members[j]!;
        if (list.length === 0) continue;

        let cx = 0, cy = 0, cz = 0;
        for (const v of list) {
            cx += rest[v * 3]!;
            cy += rest[v * 3 + 1]!;
            cz += rest[v * 3 + 2]!;
        }
        centroids[j * 3] = cx / list.length;
        centroids[j * 3 + 1] = cy / list.length;
        centroids[j * 3 + 2] = cz / list.length;
    }

    const rotations: Float32Array[] = [];
    const translations: Float32Array[] = [];

    // Scratch big enough for the largest cluster.
    let widest = 0;
    for (const list of members) widest = Math.max(widest, list.length);
    const restLocal = new Float64Array(widest * 3);
    const nowLocal = new Float64Array(widest * 3);

    for (const frame of frames) {
        const rotation = new Float32Array(jointCount * 4);
        const translation = new Float32Array(jointCount * 3);

        for (let j = 0; j < jointCount; j++) {
            const list = members[j]!;

            if (list.length === 0) {
                rotation[j * 4 + 3] = 1;
                continue;
            }

            let dx = 0, dy = 0, dz = 0;
            for (const v of list) {
                dx += frame[v * 3]!;
                dy += frame[v * 3 + 1]!;
                dz += frame[v * 3 + 2]!;
            }
            dx /= list.length; dy /= list.length; dz /= list.length;

            const cx = centroids[j * 3]!, cy = centroids[j * 3 + 1]!, cz = centroids[j * 3 + 2]!;

            for (let i = 0; i < list.length; i++) {
                const v = list[i]!;
                restLocal[i * 3] = rest[v * 3]! - cx;
                restLocal[i * 3 + 1] = rest[v * 3 + 1]! - cy;
                restLocal[i * 3 + 2] = rest[v * 3 + 2]! - cz;
                nowLocal[i * 3] = frame[v * 3]! - dx;
                nowLocal[i * 3 + 1] = frame[v * 3 + 1]! - dy;
                nowLocal[i * 3 + 2] = frame[v * 3 + 2]! - dz;
            }

            if (list.length >= 3) {
                fitRotation(restLocal, nowLocal, list.length, rotation, j * 4);
            } else {
                // Under three points a rotation is not determined; translation
                // alone reconstructs them exactly, so do not invent one.
                rotation[j * 4 + 3] = 1;
            }

            translation[j * 3] = dx - cx;
            translation[j * 3 + 1] = dy - cy;
            translation[j * 3 + 2] = dz - cz;
        }

        rotations.push(rotation);
        translations.push(translation);
    }

    return { centroids, rotations, translations };
}

const rotated = new Float64Array(3);

/** Where the rig puts vertex `v` in frame `f`, given joint `j`. */
function reconstruct(
    rest: Float32Array,
    centroids: Float32Array,
    rotation: Float32Array,
    translation: Float32Array,
    v: number,
    j: number,
    out: Float64Array
): void {
    const cx = centroids[j * 3]!, cy = centroids[j * 3 + 1]!, cz = centroids[j * 3 + 2]!;

    rotate(rotation, j * 4, rest[v * 3]! - cx, rest[v * 3 + 1]! - cy, rest[v * 3 + 2]! - cz, out);

    out[0] += cx + translation[j * 3]!;
    out[1] += cy + translation[j * 3 + 1]!;
    out[2] += cz + translation[j * 3 + 2]!;
}

/**
 * Decompose a vertex-morph animation into a single-influence skin.
 *
 * @param frames one entry per frame, each `vertexCount * 3` positions.
 */
export function decomposeSkin(
    frames: readonly Float32Array[],
    vertexCount: number,
    options: RigOptions
): RigResult {
    const jointCount = Math.max(1, Math.min(options.joints, vertexCount));
    const rest = frames[0]!;

    // A single-frame part is rigid. One joint, no rotation, no search.
    if (frames.length <= 1 || jointCount === 1) {
        let cx = 0, cy = 0, cz = 0;
        for (let v = 0; v < vertexCount; v++) {
            cx += rest[v * 3]!;
            cy += rest[v * 3 + 1]!;
            cz += rest[v * 3 + 2]!;
        }

        const centroids = new Float32Array([cx / vertexCount, cy / vertexCount, cz / vertexCount]);
        const fitted = fitClusters(frames, new Uint16Array(vertexCount), vertexCount, 1);

        return {
            centroids,
            jointCount: 1,
            vertexJoint: new Uint16Array(vertexCount),
            rotations: fitted.rotations,
            translations: fitted.translations,
            error: measure(frames, new Uint16Array(vertexCount), vertexCount, fitted),
        };
    }

    let assignment = initialClusters(frames, vertexCount, jointCount);
    let fitted = fitClusters(frames, assignment, vertexCount, jointCount);

    for (let pass = 0; pass < options.refineIterations; pass++) {
        const next = new Uint16Array(vertexCount);
        let changed = 0;

        for (let v = 0; v < vertexCount; v++) {
            let bestJoint = assignment[v]!;
            let bestError = Infinity;

            for (let j = 0; j < jointCount; j++) {
                let sum = 0;
                for (let f = 0; f < frames.length; f++) {
                    reconstruct(
                        rest, fitted.centroids, fitted.rotations[f]!, fitted.translations[f]!,
                        v, j, rotated
                    );
                    const frame = frames[f]!;
                    const dx = rotated[0]! - frame[v * 3]!;
                    const dy = rotated[1]! - frame[v * 3 + 1]!;
                    const dz = rotated[2]! - frame[v * 3 + 2]!;
                    sum += dx * dx + dy * dy + dz * dz;

                    // Nothing this joint can do will beat the incumbent.
                    if (sum >= bestError) break;
                }

                if (sum < bestError) {
                    bestError = sum;
                    bestJoint = j;
                }
            }

            next[v] = bestJoint;
            if (bestJoint !== assignment[v]) changed += 1;
        }

        assignment = next;
        fitted = fitClusters(frames, assignment, vertexCount, jointCount);

        if (changed === 0) break;
    }

    return {
        centroids: fitted.centroids,
        jointCount,
        vertexJoint: assignment,
        rotations: fitted.rotations,
        translations: fitted.translations,
        error: measure(frames, assignment, vertexCount, fitted),
    };
}

function measure(
    frames: readonly Float32Array[],
    assignment: Uint16Array,
    vertexCount: number,
    fitted: { centroids: Float32Array; rotations: Float32Array[]; translations: Float32Array[] }
): RigError {
    const rest = frames[0]!;

    let sum = 0;
    let square = 0;
    let max = 0;
    let close = 0;
    let n = 0;

    for (let f = 0; f < frames.length; f++) {
        const frame = frames[f]!;
        for (let v = 0; v < vertexCount; v++) {
            reconstruct(
                rest, fitted.centroids, fitted.rotations[f]!, fitted.translations[f]!,
                v, assignment[v]!, rotated
            );

            const dx = rotated[0]! - frame[v * 3]!;
            const dy = rotated[1]! - frame[v * 3 + 1]!;
            const dz = rotated[2]! - frame[v * 3 + 2]!;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

            sum += d;
            square += d * d;
            if (d > max) max = d;
            if (d <= 0.25) close += 1;
            n += 1;
        }
    }

    return {
        mean: n === 0 ? 0 : sum / n,
        rms: n === 0 ? 0 : Math.sqrt(square / n),
        max,
        within025: n === 0 ? 1 : close / n,
    };
}
