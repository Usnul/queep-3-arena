/*
 * effectWidth.ts -- how wide to draw the effects Q3 drew as flat pictures.
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
 * Five of Q3's weapon effects are a quad with a picture on it -- the plasma
 * bolt's sprite, the lightning, rail and tracer beams, and the spiral of ring
 * sprites wound around the rail -- and this port draws all five as solid
 * geometry. `MissileView` gives the bolt an emissive sphere with a light inside
 * it because this renderer has bloom and local lights where Q3 had a painted
 * falloff (D-130); `Effects.hitscanTrail` gives the beams a `Trail3D` tube
 * because one fading stroke is the one mechanism that covers three unrelated
 * things in the C, and `Effects.railHelix` winds a fourth tube out of the same
 * component (D-157).
 *
 * **The size each of them was drawn at came from the wrong number**, and this
 * module is the fix. See D-156.
 *
 * # The number the C gives is the size of the image
 *
 * `ent.radius = 16` on the plasma sprite, `spanWidth 8` in
 * `RB_SurfaceLightningBolt`, `r_railCoreWidth` 6, `cg_tracerWidth` 1,
 * `re->radius = 1.1` on a rail ring. Every one of those is a half-extent of the
 * **quad**, and a quad is the canvas: what is painted on it is a narrow bright
 * filament inside a wide dark margin, and the margin is the shader's own
 * falloff. `sprites/plasmaa.tga` lights a third of its radius and spends the
 * rest on rays and halo; the lightning frames light an eighth of their height
 * and the rail core an eighth of its own.
 *
 * The rings are the row where reading the C mattered most, because the number in
 * circulation for them -- `r_railWidth` 16 -- is not even the quad. It belongs
 * to `RT_RAIL_RINGS`, which `CG_RailTrail` has not emitted since Q3 1.30.
 *
 * Solid geometry has no margin. Transcribed onto a sphere or a tube, the quad's
 * extent draws the entire falloff at core brightness -- which is a plasma bolt
 * the size of a wall brick and a lightning beam wider than the rail slug.
 *
 * # So the width comes from the artwork instead
 *
 * `extract-effect-widths.ts` reads each shader out of the game's own scripts,
 * decodes every texture its stages name, and measures the **equivalent width**
 * of the cross-section: the width of the top-hat carrying the same total light
 * at the same peak brightness. That is threshold-free, which matters because
 * "where does a glow end" has no answer and every percentile is a different
 * opinion; and it is invariant to how many additive passes a shader stacks,
 * because a second copy of an image scales the integral and the peak together.
 *
 * **"At the same peak brightness" is the half of that definition the port
 * already satisfies**, which is what makes the other half mean something. A
 * plasma bolt's emissive luminance is a fixed 300 and a trail's colour is a
 * fixed constant; neither moves with this. So holding brightness and fixing the
 * width at the equivalent width is what makes the *total* light these things
 * emit equal to the total light Q3's shader emitted -- where the quad extent was
 * putting out twice as much for the plasma bolt and nearly eight times as much
 * for the lightning beam.
 *
 * What is left outside the core is the falloff, and the falloff is now the bloom
 * chain's: `downsample_karis` weights every pixel by its own luminance rather
 * than testing it against a cutoff, so a bright narrow thing spreads in
 * proportion to how bright it is without being asked to. Trails are drawn at
 * `FramePhase.AfterTransparency`, which is before the post chain, so this is
 * true of them and not only of the bolt. Core in geometry, halo in post --
 * which is what `MissileView` already said it was doing and what its 8-unit
 * radius was not actually doing.
 *
 * # Read from a generated file rather than written here
 *
 * The same arrangement as `balance.generated.json` and for the same reason: a
 * measurement retyped into a source file is a measurement that is wrong the
 * first time anybody adjusts the artwork. `npm run check` re-measures and fails
 * if this file's numbers have drifted from the textures they came from.
 */

import widths from './effectWidths.generated.json' with { type: 'json' };

interface EffectWidth {
    readonly weapon: string;
    readonly shader: string;
    readonly quadQ3: number;
    /** Equivalent width of the painted cross-section. A diameter, in Q3 units. */
    readonly coreQ3: number;
    readonly halfMaximumQ3: number;
    readonly coreFraction: number;
}

/**
 * Which effects have been measured, as a union rather than as `string`.
 *
 * Taken off the generated file's own literal type, so adding a row to
 * `EFFECTS` in `extract-effect-widths.ts` and regenerating is the whole of
 * adding one here. The point of the union is that {@link coreWidthQ3}'s throw
 * then has nothing left to catch: a mistyped key is a compile error, not a
 * weapon that draws nothing until somebody fires it.
 */
export type MeasuredEffect = keyof typeof widths.effects;

const EFFECTS = widths.effects as Readonly<Record<MeasuredEffect, EffectWidth>>;

/**
 * The diameter to draw a weapon's effect at, in Q3 units.
 *
 * Keyed by `WP_*`, like every other presentation table.
 *
 * The chaingun has no row of its own -- `CG_Bullet` draws it and the machinegun
 * through one call to `CG_Tracer` -- so callers pass `WP_MACHINEGUN` for both,
 * which is what the C does too.
 *
 * The throw is unreachable from typed code and is here for the untyped edge:
 * a JSON regenerated with a row removed while a caller still names it. Falling
 * back to the quad extent would be worse than failing, because the quad extent
 * is exactly the bug -- a silent 16 where 2.16 was meant reads as a decision
 * somebody made.
 */
export function coreWidthQ3(weapon: MeasuredEffect): number {
    const width = EFFECTS[weapon] as EffectWidth | undefined;

    if (width === undefined) {
        throw new Error(
            `no measured effect width for "${weapon}"; ` +
            `add it to EFFECTS in tools/extract-effect-widths.ts`
        );
    }

    return width.coreQ3;
}

/** Everything measured, for the tests and for a diagnostic that wants to print it. */
export const EFFECT_WIDTHS = EFFECTS;
