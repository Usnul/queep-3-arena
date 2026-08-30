/*
 * lens.ts -- `cg_fov` is horizontal; meep's camera takes a vertical angle.
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
 * `CG_CalcFov`, which is four lines of the C and was the whole of a bug.
 *
 * The port set `Camera.fov` to `cg_fov` directly. meep documents that field as
 * the **vertical** angle -- `PerspectiveCamera`'s `#fov` is "Vertical FOV angle
 * (Y)" and `projection_infinite_reverse_z` divides its cotangent by the aspect
 * ratio -- and Q3's `cg_fov` is the **horizontal** one:
 *
 *     x = cg.refdef.width / tan( fov_x / 360 * M_PI );
 *     fov_y = atan2( cg.refdef.height, x );
 *
 * So "90" meant 90 degrees across at 4:3 in Q3 and 90 degrees *down* here. On a
 * 16:9 window that is 121.7 degrees across where Q3 draws 90, and everything in
 * the frame is drawn at 60% of the size it should be. It reads as the world
 * having receded, and it reads *first* on the view weapon, because the gun is
 * the one object whose distance from the eye you know: a rocket launcher held
 * 12 units from your face is a foot of screen at Q3's lens and a thumbnail in
 * the corner at this one. That is how it was reported, and the gun was not the
 * thing that was wrong.
 *
 * The conversion needs the aspect ratio of the surface being drawn to, which
 * only the renderer knows and only at render time -- `GraphicsEngine3.render`
 * sets `camera.aspect = renderer.aspect_ratio` on the way past. So this is
 * applied once a frame from the current value rather than computed at startup:
 * a window that is resized changes `fov_y` and nothing else has to be told.
 */

/**
 * `cg_fov`'s own default: 90 degrees, horizontally, and the value every Q3
 * config that does not mention the cvar is playing at.
 */
export const FOV_DEFAULT = 90;

/**
 * The camera's far plane, in scene metres.
 *
 * Named rather than inline because it is not only the camera's number any more:
 * it is the bound `Atmosphere.ts` sizes its haze box *against* -- deliberately
 * well under it, so the medium ends before the view does -- and a test asserts
 * that relationship rather than leaving it to two numbers agreeing by habit.
 *
 * Nothing in a Q3 arena is 600 m from anything else -- the largest of the six
 * is 178 m corner to corner -- so this is not a draw-distance decision. It is
 * the *only* bound on a view ray that leaves through a hole where a sky surface
 * used to be, since `convert-map` drops those rather than drawing Q3's box, and
 * that ray is what this number is really about.
 */
export const CAMERA_CLIP_FAR = 600;

/** The camera's near plane, in scene metres. */
export const CAMERA_CLIP_NEAR = 0.1;

/**
 * `CG_CalcFov`'s vertical angle, in degrees.
 *
 * `aspect` is width / height, which is what meep's `Renderer.aspect_ratio`
 * hands out. At 4:3 with `cg_fov 90` this is 73.74 degrees, which is Q3's own
 * number; at 16:9 it is 58.72, and the horizontal 90 is preserved -- Q3 is a
 * *vert-* lens, so a wider window shows more of the world sideways only if the
 * player raises `cg_fov`, and shows less of it vertically otherwise. That is
 * the behaviour being reproduced, not one this port chose.
 */
export function verticalFovDegrees(horizontalDegrees: number, aspect: number): number {
    const halfX = (horizontalDegrees * Math.PI) / 360;

    return (2 * Math.atan(Math.tan(halfX) / aspect) * 180) / Math.PI;
}

/** The part of meep's `Camera` this writes. */
export interface LensTarget {
    readonly fov: { set(x: number): unknown; getValue(): number };
}

/** Where the aspect ratio comes from: the renderer's own camera. */
export interface LensSurface {
    readonly aspect: number;
}

/**
 * `cg_fov`, held in Q3's units and applied in meep's.
 *
 * Stands in for the `Camera` component wherever the *setting* is written --
 * `gameplayPage` takes one of these -- so the menu keeps offering the cvar the
 * player knows and nothing else has to learn that meep measures the other axis.
 */
export class CameraLens {
    private horizontal = FOV_DEFAULT;

    /** Last vertical angle written, so an unchanged frame costs one compare. */
    private applied = Number.NaN;

    constructor(private readonly camera: LensTarget) {}

    /** `cg_fov`, horizontal degrees. The shape `gameplayPage`'s slider writes. */
    readonly fov = {
        set: (degrees: number): void => {
            this.horizontal = degrees;
        },
        getValue: (): number => this.horizontal,
    };

    /**
     * Push `cg_fov` onto the camera for a surface of this shape.
     *
     * Called once a rendered frame. An aspect of zero or worse is a viewport
     * that has not been laid out yet -- a hidden tab, the frame before the
     * canvas is sized -- and is left alone rather than turned into a NaN
     * projection matrix that never recovers.
     */
    apply(surface: LensSurface): void {
        const aspect = surface.aspect;
        if (!(aspect > 0)) return;

        const vertical = verticalFovDegrees(this.horizontal, aspect);
        if (vertical === this.applied) return;

        this.applied = vertical;
        this.camera.fov.set(vertical);
    }
}
