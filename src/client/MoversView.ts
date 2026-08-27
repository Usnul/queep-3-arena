/*
 * MoversView.ts -- bind the mover simulation to meep transforms and bodies.
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
 * Three things move together and must not drift apart: the drawn geometry, the
 * collision, and the simulation's own idea of where the mover is. This is the
 * one place that writes the first two from the third, so there is no path by
 * which a door can be visually open and physically shut.
 *
 * The collision half only exists on the physics backend, where a submodel's
 * brushes become kinematic bodies whose transforms are written here. The
 * clipmap backend needs nothing: it reads `MoverSystem.movers` directly through
 * `clipToEntities`, which is `SV_ClipMoveToEntities` reduced to translation.
 */

import type { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';

import type { Mover, MoverSystem } from '../game/Movers.ts';
import type { MoverBodies, PhysicsWorld } from './PhysicsWorld.ts';

const WORLD_SCALE = 1 / 32;

interface Bound {
    readonly mover: Mover;
    readonly transforms: readonly Transform[];
    readonly bodies: MoverBodies | null;
}

export class MoversView {
    private readonly bound: Bound[] = [];

    /** Movers whose submodel had no drawn geometry -- triggers, and nothing else. */
    readonly invisible: number[] = [];

    constructor(
        system: MoverSystem,
        submodelTransforms: ReadonlyMap<number, readonly Transform[]>,
        physics: PhysicsWorld | null
    ) {
        for (const mover of system.movers) {
            const transforms = submodelTransforms.get(mover.model) ?? [];
            if (transforms.length === 0) this.invisible.push(mover.model);

            this.bound.push({
                mover,
                transforms,
                bodies: physics === null ? null : physics.addMover(mover.model),
            });
        }
    }

    /**
     * Write every mover's pose, including the ones that have not moved.
     *
     * This used to skip a mover whose origin matched the last one written, and
     * that has to go now that the drawn transform is also written by
     * `InterpolationSystem` between fixed steps. The blend leaves a pose in the
     * transform that this did not write; skipping the correction because *this*
     * did not change it lets the difference stand, and a resting door slides a
     * little further off every frame. Measured before the early-out came out:
     * four steps of a stopped mover and the drawn position had walked a quarter
     * of a unit away from the simulation's.
     *
     * It costs nothing to drop. `Vector3.set` compares before it assigns and
     * only dispatches `onChanged` when a component actually differs, so the
     * skip was the engine's own check written a second time -- with the added
     * effect of hiding a correction the engine would have made.
     */
    update(): void {
        for (const bound of this.bound) {
            const [x, y, z] = bound.mover.origin;

            // Q3 (x, y, z) -> meep (x, z, -y), scaled to scene metres.
            const mx = x * WORLD_SCALE;
            const my = z * WORLD_SCALE;
            const mz = -y * WORLD_SCALE;

            for (const transform of bound.transforms) transform.position.set(mx, my, mz);

            bound.bodies?.setOffset(x, y, z);
        }
    }

    /** Bodies actually built, for the load log. */
    get bodyCount(): number {
        return this.bound.reduce((n, b) => n + (b.bodies?.count ?? 0), 0);
    }

    get moverCount(): number {
        return this.bound.length;
    }
}
