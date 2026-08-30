/*
 * helixStroke.ts -- a Trail3D wound around an axis rather than laid along it.
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
 * The engine seeds a `Trail3D` two ways and neither of them bends.
 * `seed_trail_tube` collapses every knot onto the head and lets the entity's
 * travel draw the shape -- a wake, which needs something that moves.
 * `seed_trail_stroke` lays the whole shape down at birth, which is what a beam
 * is, and lays it down as **two** knots sharing **one** frame, for the reason it
 * writes in its own margin: "the stroke is straight, so every ring shares one
 * frame and no transport is needed".
 *
 * A tube of knots is otherwise the right shape for a helix, so this is
 * `seed_trail_stroke` with those two assumptions taken back out: as many knots as
 * the curve needs, and a parallel-transported frame per knot instead of one for
 * all of them. The transport is `tube_frame_transport`, which is the engine's
 * own -- the rotation-minimising frame a moving trail's head uses when it turns a
 * corner -- so a wound tube bends by the same code a dragged one does and there
 * is no second answer to what a bend is.
 *
 * Aged, faded and drawn by everything downstream of the knots, unchanged: the
 * simulator only ever touches age, alpha and the along-tube UV
 * (`TubeXFixedPhysicsSimulator`), so a seeded curve stays the curve it was
 * seeded as.
 *
 * Everything here is meep space -- metres, Y up. The one caller is the railgun's
 * spiral and it converts Q3's numbers on the way in; see D-157.
 */

import Trail3D from '@woosh/meep-engine/src/engine/graphics/ecs/trail3d/Trail3D.js';
import { Trail3DFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/trail3d/Trail3DFlags.js';
import {
    TUBE_ATTRIBUTE_ADDRESS_AGE,
    TUBE_ATTRIBUTE_ADDRESS_UV_V,
} from '@woosh/meep-engine/src/engine/graphics/trail/tube/tube_attributes_spec.js';
import { tube_frame_transport } from '@woosh/meep-engine/src/engine/graphics/trail/tube/tube_frame.js';
import { v3_orthonormal_matrix_from_normal } from '@woosh/meep-engine/src/core/geom/vec3/v3_orthonormal_matrix_from_normal.js';

/** `[Nx, Ny, Nz, Bx, By, Bz, Tx, Ty, Tz]`, reused across knots. */
const frame = new Float64Array(9);

/**
 * A helix drawn as a fading tube, in meep space.
 *
 * **`radiansPerMetre` is the shape and `knotSpacing` is the tessellation**, and
 * they are separate parameters on purpose even though the C this exists for
 * states them as one thing -- `CG_RailTrail` advances five units and turns ten
 * degrees in the same loop iteration. Folded together they cannot be told apart,
 * and the first person to want a smoother curve gets a differently-wound one.
 */
export interface HelixStroke {
    /** Where the axis starts. The curve begins on the circle around this point. */
    readonly from: { readonly x: number; readonly y: number; readonly z: number };
    /** Where the axis ends. */
    readonly to: { readonly x: number; readonly y: number; readonly z: number };
    /** Distance from the axis to the centre-line of the tube, in metres. */
    readonly radius: number;
    /**
     * How fast the winding turns, in radians per metre **along the axis**.
     *
     * Positive is the right-hand rule about `to - from`, which is Q3's positive
     * rotation about the same direction: `RotatePointAroundVector` conjugates a
     * planar rotation by a basis whose `vup` is `vr x vf`, and the two sign flips
     * cancel to leave `w -> cos(t) w + sin(t) (axis x w)`. `Effects.toMeep`'s
     * axis swap has determinant +1, so the corkscrew turns the way Q3's does.
     *
     * The *phase* is not portable and is not a parameter: Q3 starts at
     * `axis[18]`, half a turn round a perpendicular `PerpendicularVector` picked,
     * and the perpendicular {@link v3_orthonormal_matrix_from_normal} picks is a
     * different one. Where a helix starts on its own circle is not observable;
     * which way it winds is.
     */
    readonly radiansPerMetre: number;
    /** Metres of axis between knots. Chord error is `radius * (1 - cos(turn / 2))`. */
    readonly knotSpacing: number;
    /** Packed `0xRRGGBB`. */
    readonly color: number;
    /** Tube diameter, in metres. */
    readonly thickness: number;
    /** Seconds the last-dying knot takes to fade out completely. */
    readonly duration: number;
    /** Fraction of `duration` the `from` end is born already having lived, in [0, 1]. */
    readonly ageFrom: number;
    /** The same for the `to` end. */
    readonly ageTo: number;
    readonly texture: string;
}

/**
 * Build the trail. The caller owns the entity, the `Transform` and the expiry.
 *
 * Knot count is `round(length / knotSpacing) + 1`, at least two, and what bounds
 * it is whatever bounds the axis. The railgun's is the 8192-unit trace in
 * `Weapons`, which at the C's five-unit spacing is 1639 knots and about fifteen
 * thousand ring vertices -- the worst case a Q3 map can produce, and a shot fired
 * down the longest sight line in the game. There is no cap here because the
 * caller's own range already is one.
 *
 * Throws on a zero-length axis, the way `seed_trail_stroke` asserts on one: a
 * helix with no axis has no frame to wind around and no tangent to transport.
 */
export function makeHelixStroke(spec: HelixStroke): Trail3D {
    const dx = spec.to.x - spec.from.x;
    const dy = spec.to.y - spec.from.y;
    const dz = spec.to.z - spec.from.z;

    const length = Math.hypot(dx, dy, dz);

    if (!(length > 0)) throw new Error('a helix needs an axis with two distinct ends');

    const trail = new Trail3D();

    trail.maxAge = spec.duration;
    trail.width = spec.thickness;
    trail.textureURL = spec.texture;

    trail.color.set(
        ((spec.color >> 16) & 0xff) / 255,
        ((spec.color >> 8) & 0xff) / 255,
        (spec.color & 0xff) / 255,
        1
    );

    // The shape was decided here; there is nothing to drag the head onto.
    trail.clearFlag(Trail3DFlags.Spawning);

    const knots = Math.max(2, Math.round(length / spec.knotSpacing) + 1);

    trail.build(knots);

    const tube = trail.tube!;

    trail.time = 0;
    trail.trailingIndex = 0;
    trail.timeSinceLastUpdate = 0;
    trail.distanceSinceLastUpdate = 0;

    const inv = 1 / length;

    const ax = dx * inv;
    const ay = dy * inv;
    const az = dz * inv;

    /*
     Two perpendiculars for the winding to sweep through. Which two does not
     matter -- see `radiansPerMetre` on the phase -- only that they are
     orthonormal and right-handed about the axis, which is what this writes: `o1`,
     then `axis x o1`, then the axis itself.
    */
    v3_orthonormal_matrix_from_normal(frame, 0, ax, ay, az);

    const ux = frame[0]!;
    const uy = frame[1]!;
    const uz = frame[2]!;

    const vx = frame[3]!;
    const vy = frame[4]!;
    const vz = frame[5]!;

    const color = trail.color;
    const maxAge = trail.maxAge;

    /*
     The turn rate is per metre of *axis*, so the tangent is the axis plus what
     the winding adds sideways -- the derivative of `radius * (cos(ks) u +
     sin(ks) v)`, whose length is a constant `radius * k`. A tighter helix
     therefore has a tangent further off the axis, and normalising is what keeps
     each ring perpendicular to the curve rather than to the shot.
    */
    const turn = spec.radiansPerMetre;
    const swing = spec.radius * turn;
    const tangentScale = 1 / Math.hypot(1, swing);

    // Carried forward knot to knot so the ring does not twist as the tube winds.
    let previousNormalX = 0;
    let previousNormalY = 0;
    let previousNormalZ = 0;

    for (let i = 0; i < knots; i++) {
        const f = i / (knots - 1);

        const s = length * f;
        const angle = turn * s;

        const c = Math.cos(angle);
        const n = Math.sin(angle);

        tube.setKnotPosition(
            i,
            spec.from.x + ax * s + spec.radius * (c * ux + n * vx),
            spec.from.y + ay * s + spec.radius * (c * uy + n * vy),
            spec.from.z + az * s + spec.radius * (c * uz + n * vz)
        );

        const tx = (ax + swing * (-n * ux + c * vx)) * tangentScale;
        const ty = (ay + swing * (-n * uy + c * vy)) * tangentScale;
        const tz = (az + swing * (-n * uz + c * vz)) * tangentScale;

        if (i === 0) {
            // Nothing to transport from yet; any orthonormal start will do.
            v3_orthonormal_matrix_from_normal(frame, 0, tx, ty, tz);
        } else {
            tube_frame_transport(
                frame,
                0,
                tx,
                ty,
                tz,
                previousNormalX,
                previousNormalY,
                previousNormalZ
            );
        }

        previousNormalX = frame[0]!;
        previousNormalY = frame[1]!;
        previousNormalZ = frame[2]!;

        tube.setKnotFrame(
            i,
            frame[0]!,
            frame[1]!,
            frame[2]!,
            frame[3]!,
            frame[4]!,
            frame[5]!
        );

        const age = (spec.ageFrom + (spec.ageTo - spec.ageFrom) * f) * maxAge;

        tube.setKnotColor(i, color.x * 255, color.y * 255, color.z * 255);
        tube.setKnotThickness(i, trail.width);
        tube.setKnotAttribute_Scalar(i, TUBE_ATTRIBUTE_ADDRESS_UV_V, f);
        tube.setKnotAttribute_Scalar(i, TUBE_ATTRIBUTE_ADDRESS_AGE, age);
        tube.setKnotAlpha(i, (1 - age / maxAge) * color.w);
    }

    trail.setFlag(Trail3DFlags.Built);

    return trail;
}
