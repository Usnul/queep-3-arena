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

import { t64_announce_change } from '@woosh/meep-engine/src/engine/ecs/transform/t64_announce_change.js';

import type { PlacedMesh } from './map/loadMap.ts';

import type { Mover, MoverSystem } from '../game/Movers.ts';
import type { MoverBodies, PhysicsWorld } from './PhysicsWorld.ts';

const WORLD_SCALE = 1 / 32;

/** The part of a meep dataset this needs: somewhere to announce a mover's move. */
interface EcsDataset {
    sendEvent(entity: number, name: string, payload: unknown): void;
}

interface Bound {
    readonly mover: Mover;
    readonly meshes: readonly PlacedMesh[];
    readonly bodies: MoverBodies | null;
}

export class MoversView {
    private readonly bound: Bound[] = [];

    /** Movers whose submodel had no drawn geometry -- triggers, and nothing else. */
    readonly invisible: number[] = [];

    private readonly ecd: EcsDataset;

    constructor(
        ecd: EcsDataset,
        system: MoverSystem,
        submodelMeshes: ReadonlyMap<number, readonly PlacedMesh[]>,
        physics: PhysicsWorld | null
    ) {
        this.ecd = ecd;

        for (const mover of system.movers) {
            const meshes = submodelMeshes.get(mover.model) ?? [];
            if (meshes.length === 0) this.invisible.push(mover.model);

            this.bound.push({
                mover,
                meshes,
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
     * It costs nothing to drop, and since meep 3.16.0 there would be nothing
     * left to drop it in favour of. A `Transform64` has no `onChanged` for the
     * skip to have been shadowing: the write is unconditional, and so is the
     * announcement that the renderer and the interpolator both key off. The
     * engine's own redundant-write check went with the signals.
     */
    update(): void {
        for (const bound of this.bound) {
            const [x, y, z] = bound.mover.origin;

            // Q3 (x, y, z) -> meep (x, z, -y), scaled to scene metres.
            const mx = x * WORLD_SCALE;
            const my = z * WORLD_SCALE;
            const mz = -y * WORLD_SCALE;

            for (const mesh of bound.meshes) {
                mesh.transform.setTranslation(mx, my, mz);

                // Translation only, so the matrix needs no help. `ShadedGeometrySystem`
                // does: a door that moves without announcing is drawn where it was.
                t64_announce_change(this.ecd, mesh.entity, mesh.transform);
            }

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
