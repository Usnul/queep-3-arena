/*
 * ItemsView.ts -- draw the pickups the item simulation owns.
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
 * `CG_Item`'s presentation, which is entirely client-side in Q3 too: the server
 * knows where an item is and whether it exists, and the client decides that it
 * bobs and spins. Both rates are ported rather than invented, because they are
 * part of how a Q3 level reads -- a rocket launcher catches the eye at a
 * distance because of the spin, not because of the model.
 *
 * `ShadedGeometryFlags.Visible` handles the picked-up state. Destroying and
 * rebuilding the entity would also work and is what a naive port does; it also
 * throws away the meshlet build every 25 seconds per item, which on a level
 * with 40 pickups is most of a frame's budget spent re-deriving geometry that
 * has not changed.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ShadedGeometryFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometryFlags.js';

import type { ModelLibrary } from './map/loadModels.ts';
import type { ItemInstance, ItemSystem } from '../game/Items.ts';

const WORLD_SCALE = 1 / 32;

/** Q3's `cg.autoAngles`: a full turn every 2048 ms, and every 1024 for health. */
const SPIN_PERIOD_SECONDS = 2.048;
const SPIN_PERIOD_FAST_SECONDS = 1.024;

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

interface DrawnItem {
    readonly item: ItemInstance;
    readonly transforms: Transform[];
    readonly geometries: ShadedGeometry[];
    /** `CG_Item`'s per-entity bob rate, so a row of pickups does not pulse in unison. */
    readonly bobScale: number;
    readonly fastSpin: boolean;
    visible: boolean;
}

export class ItemsView {
    private readonly ecd: EcsDataset;
    private readonly library: ModelLibrary;
    private readonly drawn: DrawnItem[] = [];

    /**
     * Item classnames that drew nothing at all.
     *
     * Kept separate from `partial` on purpose. Several Q3 items are two models
     * -- a solid body and an additive shell -- and OA ships the body without the
     * shell for four of them. Lumping the two cases together reports a shard
     * that renders correctly as "no model", which sends the next person looking
     * for a bug that is not there.
     */
    readonly unmodelled: string[] = [];

    /** Classnames that drew some of their models but not all. */
    readonly partial: string[] = [];

    constructor(ecd: EcsDataset, library: ModelLibrary) {
        this.ecd = ecd;
        this.library = library;
    }

    /**
     * Build one entity per mesh of per item.
     *
     * Q3 items are frequently two models -- a solid body and an additive shell,
     * such as `armor_yel.md3` plus its sphere. Both are drawn, both spin
     * together, and the pair is treated as one item because the simulation only
     * has one.
     */
    build(items: readonly ItemInstance[]): void {
        for (const item of items) {
            const transforms: Transform[] = [];
            const geometries: ShadedGeometry[] = [];

            let missing = 0;

            for (const modelPath of item.def.models) {
                const components = this.library.components(modelPath);
                if (components === null) {
                    missing += 1;
                    continue;
                }

                for (const geometry of components) {
                    /*
                     Written every frame, position and rotation both, which is
                     precisely the case the flag's own docblock says to set it
                     for: one collapsed bounds update instead of two BVH walks.
                    */
                    geometry.setFlag(ShadedGeometryFlags.DeferredBoundsUpdate);

                    const transform = new Transform();
                    transform.scale.set(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

                    new Entity().add(transform).add(geometry).build(this.ecd);

                    transforms.push(transform);
                    geometries.push(geometry);
                }
            }

            if (missing > 0) {
                const list = transforms.length === 0 ? this.unmodelled : this.partial;
                if (!list.includes(item.def.classname)) list.push(item.def.classname);
            }

            if (transforms.length === 0) continue;

            this.drawn.push({
                item,
                transforms,
                geometries,
                // `scale = 0.005 + cent->currentState.number * 0.00001`, in ms.
                bobScale: 0.005 + item.index * 0.00001,
                fastSpin: item.def.type === 'IT_HEALTH',
                visible: true,
            });
        }
    }

    /** @param now simulation seconds; `ItemSystem.now`. */
    update(now: number): void {
        const milliseconds = now * 1000;

        for (const drawn of this.drawn) {
            const item = drawn.item;

            if (item.present !== drawn.visible) {
                drawn.visible = item.present;
                for (const geometry of drawn.geometries) {
                    geometry.writeFlag(ShadedGeometryFlags.Visible, item.present);
                }
            }

            if (!item.present) continue;

            // `cent->lerpOrigin[2] += 4 + cos( ( cg.time + 1000 ) * scale ) * 4`
            const bob = 4 + Math.cos((milliseconds + 1000) * drawn.bobScale) * 4;

            const period = drawn.fastSpin ? SPIN_PERIOD_FAST_SECONDS : SPIN_PERIOD_SECONDS;
            const yaw = ((now % period) / period) * Math.PI * 2;

            const x = item.origin[0] * WORLD_SCALE;
            const y = (item.origin[2] + bob) * WORLD_SCALE;
            const z = -item.origin[1] * WORLD_SCALE;

            for (const transform of drawn.transforms) {
                transform.position.set(x, y, z);
                /*
                 Q3 yaw is a rotation about +Z. Under `(x, y, z) -> (x, z, -y)`
                 that is a rotation about meep's +Y with the same sign, because
                 the axis mapping has determinant +1.
                */
                transform.rotation._fromAxisAngle(0, 1, 0, yaw);
            }
        }
    }

    /** Total drawn pieces, for the load log. */
    get pieceCount(): number {
        return this.drawn.reduce((n, d) => n + d.geometries.length, 0);
    }

    get itemCount(): number {
        return this.drawn.length;
    }
}

export type { ItemSystem };
