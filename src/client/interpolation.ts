/*
 * interpolation.ts -- opting an entity into render-rate blending.
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
 * The simulation runs on a fixed step and the display does not, so anything that
 * moves holds a pose for a few frames and then jumps. `InterpolationSystem`
 * blends the last two recorded steps into the live `Transform` every rendered
 * frame; a component is the whole opt-in, and which of these two an entity gets
 * says who recorded it.
 *
 * `interpolands` defaults to an empty list, which would silently blend nothing,
 * so the pose has to be named either way -- which is the only reason these are
 * functions rather than two lines at each call site.
 */

import {
    Interpolated,
} from '@woosh/meep-engine/src/engine/interpolation/Interpolated.js';
import { POSE_INTERPOLAND } from '@woosh/meep-engine/src/engine/interpolation/pose_interpoland.js';

/**
 * The interpolation source for poses this application writes itself.
 *
 * Not `INTERPOLATION_SOURCE_LOCAL`: that timeline is `PhysicsSystem`'s, and an
 * `InterpolationLog` admits exactly one producer per tick -- `begin_tick` throws
 * while a tick is open. So the app gets its own log and registers it as a second
 * source through `InterpolationSystem.registerSource`, which is the seam the
 * network layer uses for its render-delayed playout. `PoseRecorderSystem` is the
 * producer.
 */
export const APP_INTERPOLATION_SOURCE = 1;



/** Opt an entity's `Transform` into render-rate blending on the app timeline. */
export function interpolatedPose(): Interpolated {
    const component = new Interpolated();
    component.sourceId = APP_INTERPOLATION_SOURCE;
    component.interpolands = [POSE_INTERPOLAND];
    return component;
}

/**
 * The same, on the *physics* timeline -- for a body the engine itself moves.
 *
 * `PhysicsSystem` is the producer for `INTERPOLATION_SOURCE_LOCAL`, so a missile
 * needs no application code at all to render smoothly: the component is the
 * whole opt-in.
 */
export function interpolatedBody(): Interpolated {
    const component = new Interpolated();
    component.interpolands = [POSE_INTERPOLAND];
    return component;
}
