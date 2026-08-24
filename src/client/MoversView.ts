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
    /** Last written offset, so a resting mover costs one comparison a frame. */
    readonly written: [number, number, number];
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
                // Deliberately not the mover's start offset: the first `update`
                // must write once, so that a `start_open` door -- whose `pos1`
                // is not zero -- lands in its open position on frame one.
                written: [NaN, NaN, NaN],
            });
        }
    }

    update(): void {
        for (const bound of this.bound) {
            const [x, y, z] = bound.mover.origin;
            const written = bound.written;

            if (x === written[0] && y === written[1] && z === written[2]) continue;

            written[0] = x;
            written[1] = y;
            written[2] = z;

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
