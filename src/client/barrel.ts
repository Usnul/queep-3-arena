/*
 * barrel.ts -- the front half of five of the guns, which is a separate model.
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
 * `CG_RegisterWeapon`'s `barrelModel`, and the `CG_PositionRotatedEntityOnTag`
 * call that puts it where it goes.
 *
 * Five of the thirteen weapons are modelled as two files. `machinegun.md3` is
 * the receiver, the grip and the sights; the tube that runs between the sights
 * is `machinegun_barrel.md3`, hung off the receiver's `tag_barrel`. Q3 splits
 * them because it *spins* the barrel while you fire, and the split is invisible
 * from the item table -- `bg_itemlist` names one file, so a pipeline that reads
 * the item table converts one file, and the gun that came out had a hole in the
 * middle of it. See D-141.
 *
 * Two consumers, for the two places a weapon is drawn: `ViewWeapon` for the one
 * in your hands, `ItemsView` for the one lying on the floor. `CG_AddPlayerWeapon`
 * and `CG_Item` each hang the barrel themselves, for the same reason.
 *
 * # What is not ported
 *
 * The spin. `CG_MachinegunSpinAngle` rolls the barrel about its own length
 * while `EF_FIRING` is set and coasts it down over a second afterwards, and
 * nothing here carries "is firing" to the view weapon -- `flash()` is told about
 * a shot, not about a trigger being held. Every barrel is therefore drawn at
 * rest, which is where Q3 draws four of the five most of the time and is the
 * pose all five are authored in. It is a still gun rather than a missing one.
 */

import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

import type { ModelLibrary } from './map/loadModels.ts';

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

/** The tag `CG_AddPlayerWeapon` and `CG_Item` both hang the barrel off. */
const TAG_BARREL = 'tag_barrel';

/** A model hung off another model's tag: what to draw, and where it sits. */
export interface TagAttachment {
    /** Virtual path of the attached model, for `ModelLibrary.components`. */
    readonly model: string;
    /** The tag's origin on the parent, meep model axes, Q3 units. */
    readonly offset: readonly [number, number, number];
    /** The tag's own basis, in the same axes. Identity for three of the five. */
    readonly rotation: Quaternion;
}

/**
 * A weapon's barrel, if it has one and the bundle has it.
 *
 * `CG_RegisterWeapon` builds the path by swapping the world model's extension,
 * exactly as it does for the hands model, and takes whatever comes back --
 * `trap_R_RegisterModel` returning nothing is not an error, it means this gun
 * is one file. Eight of the thirteen are, and they carry no `tag_barrel`
 * either, so both halves of this returning null is the ordinary case rather
 * than a missing asset.
 *
 * @param worldModel the weapon's `world_model[0]`, as `bg_itemlist` names it.
 */
export function barrelAttachment(
    library: ModelLibrary,
    worldModel: string
): TagAttachment | null {
    if (!worldModel.toLowerCase().endsWith('.md3')) return null;

    const model = `${worldModel.slice(0, -'.md3'.length)}_barrel.md3`;
    if (library.definition(model) === null) return null;

    const tag = library.definition(worldModel)?.tags.find((t) => t.name === TAG_BARREL);
    if (tag === undefined) return null;

    const rotation = new Quaternion();
    /*
     A tag written before D-141 has an origin and no basis. Reading a missing
     one as identity rather than as `undefined` keeps a stale `models.json` --
     or a hand-built stub in a test -- drawing the three barrels whose basis
     *is* identity, instead of turning two of them into `NaN`.
    */
    const q = tag.rotation;
    if (Array.isArray(q) && q.length === 4) rotation.set(q[0]!, q[1]!, q[2]!, q[3]!);

    return { model, offset: [tag.origin[0]!, tag.origin[1]!, tag.origin[2]!], rotation };
}

const scratchOffset = new Vector3();

/**
 * `CG_PositionRotatedEntityOnTag`, for a parent whose pose is already world.
 *
 * The C composes two `refEntity_t` axes; here the parent's pose is a `Transform`
 * that the caller has just written, so the same two lines are a rotated offset
 * and a quaternion product. The offset is scaled on the way out because the
 * transform's own `scale` does not reach a sibling entity -- every drawn piece
 * is its own entity, so the parent's scale has to be applied to the tag by hand.
 *
 * `outPosition` and `outRotation` may not alias `parentPosition`/`parentRotation`.
 */
export function placeOnTag(
    parentPosition: Vector3,
    parentRotation: Quaternion,
    attachment: TagAttachment,
    outPosition: Vector3,
    outRotation: Quaternion
): void {
    scratchOffset.set(
        attachment.offset[0]! * WORLD_SCALE,
        attachment.offset[1]! * WORLD_SCALE,
        attachment.offset[2]! * WORLD_SCALE
    );
    scratchOffset.applyQuaternion(parentRotation);

    outPosition.set(
        parentPosition.x + scratchOffset.x,
        parentPosition.y + scratchOffset.y,
        parentPosition.z + scratchOffset.z
    );

    outRotation.multiplyQuaternions(parentRotation, attachment.rotation);
}
