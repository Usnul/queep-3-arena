/*
 * math.ts -- the parts of q_math.c that movement depends on.
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
 * Everything here computes in **float32**, matching the C, for the reasons set
 * out in `src/q3/cm/trace.ts` and DECISIONS.md D-019: movement decisions turn on
 * exact comparisons, so extra precision produces a different game rather than a
 * better one.
 *
 * The rounding points are not guesswork -- they are read off the C's
 * declarations. `VectorNormalize` declares `float length` and then assigns
 * `sqrt(length)` to it, so the double-precision square root is rounded back to
 * 32 bits before the division; `AngleVectors` declares `float angle` and
 * multiplies by a *double* constant, so that product rounds too, and then
 * `sin`/`cos` return doubles into `static float` and round again. Get any of
 * these wrong and the port drifts from the oracle in the third decimal place
 * over a few hundred frames.
 */

export const f32 = Math.fround;

/** Vectors are `Float32Array` so storage matches `vec3_t`. */
export type Vec3 = Float32Array;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
    const v = new Float32Array(3);
    v[0] = x;
    v[1] = y;
    v[2] = z;
    return v;
}

/** `DotProduct` -- left-to-right association, rounding at each step. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
    return f32(f32(f32(a[0]! * b[0]!) + f32(a[1]! * b[1]!)) + f32(a[2]! * b[2]!));
}

export function copy(dst: Vec3, src: ArrayLike<number>): Vec3 {
    dst[0] = src[0]!;
    dst[1] = src[1]!;
    dst[2] = src[2]!;
    return dst;
}

export function set(dst: Vec3, x: number, y: number, z: number): Vec3 {
    dst[0] = x;
    dst[1] = y;
    dst[2] = z;
    return dst;
}

export function clear(dst: Vec3): Vec3 {
    dst[0] = 0;
    dst[1] = 0;
    dst[2] = 0;
    return dst;
}

export function add(dst: Vec3, a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
    dst[0] = f32(a[0]! + b[0]!);
    dst[1] = f32(a[1]! + b[1]!);
    dst[2] = f32(a[2]! + b[2]!);
    return dst;
}

export function subtract(dst: Vec3, a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
    dst[0] = f32(a[0]! - b[0]!);
    dst[1] = f32(a[1]! - b[1]!);
    dst[2] = f32(a[2]! - b[2]!);
    return dst;
}

export function scale(dst: Vec3, v: ArrayLike<number>, s: number): Vec3 {
    dst[0] = f32(v[0]! * s);
    dst[1] = f32(v[1]! * s);
    dst[2] = f32(v[2]! * s);
    return dst;
}

/** `VectorMA`: dst = a + scale * b. */
export function vectorMA(
    dst: Vec3,
    a: ArrayLike<number>,
    s: number,
    b: ArrayLike<number>
): Vec3 {
    dst[0] = f32(a[0]! + f32(b[0]! * s));
    dst[1] = f32(a[1]! + f32(b[1]! * s));
    dst[2] = f32(a[2]! + f32(b[2]! * s));
    return dst;
}

export function cross(dst: Vec3, a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
    const x = f32(f32(a[1]! * b[2]!) - f32(a[2]! * b[1]!));
    const y = f32(f32(a[2]! * b[0]!) - f32(a[0]! * b[2]!));
    const z = f32(f32(a[0]! * b[1]!) - f32(a[1]! * b[0]!));
    dst[0] = x;
    dst[1] = y;
    dst[2] = z;
    return dst;
}

/**
 * `VectorLength`.
 *
 * The C is `sqrt(DotProduct(v,v))` where the result is a `vec_t` (float), so the
 * double-precision square root rounds on the way out.
 */
export function length(v: ArrayLike<number>): number {
    return f32(Math.sqrt(dot(v, v)));
}

/**
 * `VectorNormalize` -- normalises in place and returns the original length.
 *
 * Two rounding points, both from the C's declarations: `length` is a `float`, so
 * `sqrt` rounds into it; `ilength = 1/length` is a float reciprocal, and the
 * components are then multiplied by that reciprocal rather than divided. The
 * reciprocal-then-multiply is not an optimisation to preserve for speed -- it
 * gives a different answer from dividing, and the C does it that way.
 */
export function normalize(v: Vec3): number {
    const len = f32(Math.sqrt(dot(v, v)));

    if (len !== 0) {
        const ilength = f32(1 / len);
        v[0] = f32(v[0]! * ilength);
        v[1] = f32(v[1]! * ilength);
        v[2] = f32(v[2]! * ilength);
    }

    return len;
}

/** `VectorNormalize2` -- normalise `v` into `out`, returning `v`'s length. */
export function normalize2(v: ArrayLike<number>, out: Vec3): number {
    const len = f32(Math.sqrt(dot(v, v)));

    if (len !== 0) {
        const ilength = f32(1 / len);
        out[0] = f32(v[0]! * ilength);
        out[1] = f32(v[1]! * ilength);
        out[2] = f32(v[2]! * ilength);
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

/** `M_PI*2 / 360` as C evaluates it -- a *double* constant. */
const DEG_TO_RAD = (Math.PI * 2) / 360;

/**
 * `AngleVectors`.
 *
 * Rounding follows the C's declarations exactly: `angle` is a `float` and is
 * assigned the result of a float-times-double multiply, so it rounds; `sr`..`cy`
 * are `static float` and are assigned double `sin`/`cos` results, so they round
 * too. The products below are then float-by-float.
 *
 * The odd-looking `-1*sr*sp*cy + -1*cr*-sy` in `right` is id's own expression,
 * kept verbatim: the multiplications by -1 are not redundant in float, they are
 * additional rounding steps.
 */
export function angleVectors(
    angles: ArrayLike<number>,
    forward: Vec3 | null,
    right: Vec3 | null,
    up: Vec3 | null
): void {
    let angle = f32(angles[YAW]! * DEG_TO_RAD);
    const sy = f32(Math.sin(angle));
    const cy = f32(Math.cos(angle));

    angle = f32(angles[PITCH]! * DEG_TO_RAD);
    const sp = f32(Math.sin(angle));
    const cp = f32(Math.cos(angle));

    angle = f32(angles[ROLL]! * DEG_TO_RAD);
    const sr = f32(Math.sin(angle));
    const cr = f32(Math.cos(angle));

    if (forward !== null) {
        forward[0] = f32(cp * cy);
        forward[1] = f32(cp * sy);
        forward[2] = f32(-sp);
    }

    if (right !== null) {
        right[0] = f32(f32(f32(f32(-1 * sr) * sp) * cy) + f32(f32(-1 * cr) * -sy));
        right[1] = f32(f32(f32(f32(-1 * sr) * sp) * sy) + f32(f32(-1 * cr) * cy));
        right[2] = f32(f32(-1 * sr) * cp);
    }

    if (up !== null) {
        up[0] = f32(f32(f32(cr * sp) * cy) + f32(-sr * -sy));
        up[1] = f32(f32(f32(cr * sp) * sy) + f32(-sr * cy));
        up[2] = f32(cr * cp);
    }
}

/**
 * `SHORT2ANGLE` from `q_shared.h`: `((x)*(360.0/65536))`.
 *
 * The constant is a double, so the product is computed in double and only
 * rounds when it lands in the `float` viewangles.
 */
export function short2angle(x: number): number {
    return f32(x * (360.0 / 65536));
}

/** `ANGLE2SHORT`: `((int)((x)*(65536/360.0)) & 65535)`. */
export function angle2short(x: number): number {
    return Math.trunc(x * (65536 / 360.0)) & 65535;
}

/** `AngleNormalize360`. */
export function angleNormalize360(angle: number): number {
    return f32((360.0 / 65536) * (Math.trunc(angle * (65536 / 360.0)) & 65535));
}

/** `AngleNormalize180` -- range (-180, 180]. */
export function angleNormalize180(angle: number): number {
    const a = angleNormalize360(angle);
    return a > 180.0 ? f32(a - 360.0) : a;
}

/**
 * `trap_SnapVector` -- round each component to the nearest integer.
 *
 * Q3 snaps velocity every frame and this is **movement-visible**, not a
 * bandwidth optimisation: the rounding is part of how acceleration accumulates,
 * and removing it changes strafe-jump speed.
 */
export function snapVector(v: Vec3): void {
    v[0] = Math.trunc(v[0]! + (v[0]! >= 0 ? 0.5 : -0.5));
    v[1] = Math.trunc(v[1]! + (v[1]! >= 0 ? 0.5 : -0.5));
    v[2] = Math.trunc(v[2]! + (v[2]! >= 0 ? 0.5 : -0.5));
}
