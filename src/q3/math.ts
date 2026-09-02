/*
 * math.ts -- the parts of q_math.c that meep's geometry package does not have.
 *
 * Ported from OpenArena's `code/qcommon/q_math.c`.
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
 * This file used to be a full vec3 library computing in float32, so that the
 * port reproduced `q_math.c`'s rounding step for step. D-174 struck that: the
 * arithmetic is float64 now, and everything meep already ships -- dot, cross,
 * scale, length, `VectorMA`, the copies -- is imported from
 * `core/geom/vec3/` at the call sites rather than reimplemented here.
 *
 * What is left is what meep has no opinion about, because it is Quake III's
 * convention rather than geometry:
 *
 * - `AngleVectors`, which is pitch/yaw/roll in degrees, in Q3's x-forward
 *   y-left z-up frame, and yields a basis in that frame.
 * - `SHORT2ANGLE`, the 16-bit angle encoding `usercmd_t` carries. Its inverse and
 *   the two `AngleNormalize` helpers were here and were reachable from nowhere;
 *   a file whose stated contents are "what meep does not have" should not also
 *   hold what nothing calls.
 * - `SnapVector`, which is a *gameplay* rule rather than a rounding choice:
 *   Q3 truncates velocity to whole units every frame and strafe-jump speed
 *   depends on it.
 * - `VectorNormalize`, only because Q3's returns the length it divided by and
 *   meep's `v3_normalize_array` returns nothing; both halves below are the
 *   engine's own functions.
 *
 * `Vec3` stays a `Float32Array`. That is the width `vec3_t` has in the C, the
 * width the network protocol writes, and the width meep's own vertex buffers
 * use; it is storage, not arithmetic, and D-174 was about the arithmetic.
 */

import { v3_allocate } from '@woosh/meep-engine/src/core/geom/vec3/v3_allocate.js';
import { v3_length } from '@woosh/meep-engine/src/core/geom/vec3/v3_length.js';
import { v3_scale_array } from '@woosh/meep-engine/src/core/geom/vec3/v3_scale_array.js';

/** Vectors are `Float32Array` so storage matches `vec3_t`. */
export type Vec3 = Float32Array;

/**
 * What meep's `core/geom/vec3` array forms accept.
 *
 * Narrower than `ArrayLike<number>`, which is what the port's own wrappers used
 * to take: the engine indexes *and assigns*, so a read-only shape is not a
 * legal argument and the declarations say so.
 */
export type Vec3Like = Vec3 | number[];

/** A zeroed `vec3_t`, out of meep's bucketed vector allocator. */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
    const v = v3_allocate();
    v[0] = x;
    v[1] = y;
    v[2] = z;
    return v;
}

export function set(dst: Vec3, x: number, y: number, z: number): Vec3 {
    dst[0] = x;
    dst[1] = y;
    dst[2] = z;
    return dst;
}

/**
 * `VectorNormalize` -- normalises in place and returns the original length.
 *
 * The length is the reason this is not just `v3_normalize_array`: half of Q3's
 * uses are `wishspeed = VectorNormalize( wishdir )`, where the return value is
 * the number the next line accelerates towards.
 */
export function normalize(v: Vec3): number {
    const len = v3_length(v[0]!, v[1]!, v[2]!);

    if (len !== 0) v3_scale_array(v, 0, v, 0, 1 / len);

    return len;
}

/** `VectorNormalize2` -- normalise `v` into `out`, returning `v`'s length. */
export function normalize2(v: Vec3Like, out: Vec3): number {
    const len = v3_length(v[0]!, v[1]!, v[2]!);

    if (len !== 0) {
        v3_scale_array(out, 0, v, 0, 1 / len);
    } else {
        // The C leaves `out` untouched when the length is zero. Callers rely on
        // it having been zeroed beforehand.
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
    }

    return len;
}

/* ------------------------------------------------------------------ *
 * Angles
 * ------------------------------------------------------------------ */

export const PITCH = 0;
export const YAW = 1;
export const ROLL = 2;

/** `M_PI*2 / 360`, written as the C writes it. */
const DEG_TO_RAD = (Math.PI * 2) / 360;

/**
 * `AngleVectors`.
 *
 * id writes `right` as `-1*sr*sp*cy + -1*cr*-sy`, and this port used to keep
 * those `-1`s verbatim because in float32 each one was another rounding step.
 * In float64 they are exact sign flips and nothing else, so they are folded.
 *
 * Note for callers pointing a cone down one of these vectors: a right angle is
 * not representable, so `cos` of ninety degrees is 6.1e-17 rather than zero and
 * the result is a hair off the axis. That is not a bug to fix here -- see
 * D-147 and `coneAxis` in `Effects.ts`, which snaps it.
 */
export function angleVectors(
    angles: ArrayLike<number>,
    forward: Vec3 | null,
    right: Vec3 | null,
    up: Vec3 | null
): void {
    const yaw = angles[YAW]! * DEG_TO_RAD;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);

    const pitch = angles[PITCH]! * DEG_TO_RAD;
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);

    const roll = angles[ROLL]! * DEG_TO_RAD;
    const sr = Math.sin(roll);
    const cr = Math.cos(roll);

    if (forward !== null) {
        forward[0] = cp * cy;
        forward[1] = cp * sy;
        forward[2] = -sp;
    }

    if (right !== null) {
        right[0] = -sr * sp * cy + cr * sy;
        right[1] = -sr * sp * sy - cr * cy;
        right[2] = -sr * cp;
    }

    if (up !== null) {
        up[0] = cr * sp * cy + sr * sy;
        up[1] = cr * sp * sy - sr * cy;
        up[2] = cr * cp;
    }
}

/** `SHORT2ANGLE` from `q_shared.h`: `((x)*(360.0/65536))`. */
export function short2angle(x: number): number {
    return x * (360.0 / 65536);
}

/**
 * `trap_SnapVector` -- round each component to the nearest integer.
 *
 * Q3 snaps velocity every frame and this is **movement-visible**, not a
 * bandwidth optimisation: the rounding is part of how acceleration accumulates,
 * and removing it changes strafe-jump speed. It is also, incidentally, what
 * keeps a float64 `bg_pmove` in step with the C for as long as it does -- a
 * velocity that is a whole number cannot carry a one-ULP disagreement into the
 * next frame. See D-174.
 */
export function snapVector(v: Vec3): void {
    v[0] = Math.trunc(v[0]! + (v[0]! >= 0 ? 0.5 : -0.5));
    v[1] = Math.trunc(v[1]! + (v[1]! >= 0 ? 0.5 : -0.5));
    v[2] = Math.trunc(v[2]! + (v[2]! >= 0 ? 0.5 : -0.5));
}
