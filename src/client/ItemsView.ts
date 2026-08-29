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
 * # Hiding a collected item
 *
 * By taking its `ShadedGeometry` off the entity, which is the only thing that
 * works. `ShadedGeometryFlags.Visible` is documented as *"If set to false will
 * not render"* and this file used to believe it; the flag is read by nothing in
 * the engine, so a collected pickup stayed on screen (BUG-10). It also stopped
 * spinning, because a pickup that is not `present` skips the animation below --
 * which is how one dead flag produced two symptoms that looked like two bugs.
 *
 * Visibility in Shade is membership: `ShadedGeometrySystem3` adds a `Mesh` to
 * the scene in `link` and removes it in `unlink`, and there is no per-node
 * visible bit to set. Removing the component runs `unlink`; putting the *same
 * instance* back runs `link` again, and `link` reuses the `Geometry` and the
 * `ShadeMaterial` it is handed. So nothing is re-derived -- the meshlet build
 * belongs to `ModelLibrary` and is shared across every copy of a model -- and
 * the cost of a pickup is one `Mesh`, three signal bindings and a scene insert,
 * twice per respawn.
 *
 * The entity itself stays, so the `Transform` and its position survive the
 * hidden interval and the item reappears where it was rather than at the origin.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { ShadedGeometryFlags } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometryFlags.js';

import { barrelAttachment, placeOnTag, type TagAttachment } from './barrel.ts';
import type { ModelLibrary } from './map/loadModels.ts';
import type { ItemInstance, ItemSystem } from '../game/Items.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';

const WORLD_SCALE = 1 / 32;

/** Q3's `cg.autoAngles`: a full turn every 2048 ms, and every 1024 for health. */
const SPIN_PERIOD_SECONDS = 2.048;
const SPIN_PERIOD_FAST_SECONDS = 1.024;

const scratchPosition = new Vector3();
const scratchRotation = new Quaternion();

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    addComponentToEntity(entity: number, component: unknown): void;
    removeComponentFromEntity(entity: number, type: unknown): void;
}

interface DrawnItem {
    readonly item: ItemInstance;
    readonly transforms: Transform[];
    readonly geometries: ShadedGeometry[];
    /** Parallel to `geometries`; the entity each one is linked to and off. */
    readonly entities: number[];
    /**
     * Parallel to `transforms`: where that piece sits on the item, or null for a
     * piece that *is* the item.
     *
     * Only a weapon's barrel is ever non-null. `CG_Item` hangs it off the
     * weapon's `tag_barrel` exactly as `CG_AddPlayerWeapon` does, so a
     * machinegun lying on the floor has the same front the one in your hands
     * has -- and had the same hole in it before D-141.
     */
    readonly attachments: (TagAttachment | null)[];
    /** `CG_Item`'s per-entity bob rate, so a row of pickups does not pulse in unison. */
    readonly bobScale: number;
    readonly fastSpin: boolean;
    visible: boolean;
    /**
     * The hover loop, for a weapon that is currently lying there.
     *
     * `CG_Item` adds it from inside the draw, so it exists exactly while the
     * item does -- which here means it is stopped on pickup and started again on
     * respawn rather than muted, because a stopped loop is one fewer emitter in
     * the live set and a muted one is not.
     */
    hover: SoundLoop | null;
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

    private readonly audio: AudioBank | null;

    constructor(ecd: EcsDataset, library: ModelLibrary, audio: AudioBank | null = null) {
        this.ecd = ecd;
        this.library = library;
        this.audio = audio;
    }

    /** `CG_Item`'s hover loop, which only a weapon on the ground gets. */
    private hoverFor(item: ItemInstance): SoundLoop | null {
        if (this.audio === null || item.def.type !== 'IT_WEAPON') return null;

        return this.audio.loop('item/hover', item.origin);
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
            const entities: number[] = [];
            const attachments: (TagAttachment | null)[] = [];

            let missing = 0;

            /*
             `CG_Item`'s second half for a weapon on the ground: five of the
             thirteen guns are two models, and the barrel hangs off the body's
             `tag_barrel`. Not counted towards `missing`, because a weapon
             without one is not a weapon missing one -- eight of them are a
             single file and carry no such tag. See `barrel.ts`.
            */
            const barrel =
                item.def.type === 'IT_WEAPON'
                    ? barrelAttachment(this.library, item.def.models[0] ?? '')
                    : null;

            const pieces: [string, TagAttachment | null][] = item.def.models.map((m) => [m, null]);
            if (barrel !== null) pieces.push([barrel.model, barrel]);

            for (const [modelPath, attachment] of pieces) {
                const components = this.library.components(modelPath);
                if (components === null) {
                    if (attachment === null) missing += 1;
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

                    const builder = new Entity().add(transform).add(geometry);
                    builder.build(this.ecd);

                    transforms.push(transform);
                    geometries.push(geometry);
                    entities.push(builder.id);
                    attachments.push(attachment);
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
                entities,
                attachments,
                // `scale = 0.005 + cent->currentState.number * 0.00001`, in ms.
                bobScale: 0.005 + item.index * 0.00001,
                fastSpin: item.def.type === 'IT_HEALTH',
                visible: true,
                hover: this.hoverFor(item),
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

                for (let i = 0; i < drawn.geometries.length; i++) {
                    const geometry = drawn.geometries[i]!;
                    const entity = drawn.entities[i]!;

                    if (item.present) this.ecd.addComponentToEntity(entity, geometry);
                    else this.ecd.removeComponentFromEntity(entity, ShadedGeometry);
                }

                if (item.present) {
                    drawn.hover = this.hoverFor(item);
                } else {
                    drawn.hover?.stop();
                    drawn.hover = null;
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

            /*
             Q3 yaw is a rotation about +Z. Under `(x, y, z) -> (x, z, -y)` that
             is a rotation about meep's +Y with the same sign, because the axis
             mapping has determinant +1.

             Built once per item into the scratch pair rather than once per
             piece, because a barrel is placed *relative to* the item's pose and
             so needs it as a value; every piece that is not attached then copies
             it, which is one `_fromAxisAngle` per item where it used to be one
             per mesh.
            */
            scratchPosition.set(x, y, z);
            scratchRotation._fromAxisAngle(0, 1, 0, yaw);

            for (let i = 0; i < drawn.transforms.length; i++) {
                const transform = drawn.transforms[i]!;
                const attachment = drawn.attachments[i]!;

                if (attachment === null) {
                    transform.position.set(x, y, z);
                    transform.rotation.copy(scratchRotation);
                    continue;
                }

                placeOnTag(
                    scratchPosition,
                    scratchRotation,
                    attachment,
                    transform.position,
                    transform.rotation
                );
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
