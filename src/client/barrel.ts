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
 * # The spin
 *
 * `CG_MachinegunSpinAngle`, whose state machine is two lines of arithmetic and
 * one latch, ported below. It rolls the barrel about its own length at 0.9
 * degrees per millisecond while the trigger is held, and coasts it down over a
 * second afterwards -- so the chaingun's rotor winds up and runs down, and the
 * gauntlet's blade only turns while you are holding it into someone.
 *
 * The floor pickup does **not** spin: `CG_Item` builds the same barrel with
 * `angles[ROLL] = 0`. That is Q3's, not an omission, and it is why
 * {@link placeOnTag} takes the roll as an argument rather than reading it.
 */

import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

import type { ModelLibrary } from './map/loadModels.ts';

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

/**
 * The tag `CG_AddPlayerWeapon` and `CG_Item` both hang the barrel off.
 *
 * Exported because `ViewWeapon.muzzleOffset` reads it too, as the front of a gun
 * whose author marked no muzzle -- and reads the *tag* rather than calling
 * {@link barrelAttachment}, because that one is null when the barrel *file* is
 * missing and the tag is a fact about this mesh either way.
 */
export const TAG_BARREL = 'tag_barrel';

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

/* ------------------------------------------------------------------ *
 * The spin
 * ------------------------------------------------------------------ */

/**
 * `SPIN_SPEED`: degrees per **millisecond**, so two and a half turns a second.
 *
 * Q3's own unit, kept, because every other number in `CG_MachinegunSpinAngle`
 * is scaled against it and converting one of them is how the pair stops
 * agreeing.
 */
const SPIN_SPEED = 0.9;

/** `COAST_TIME`: how long a released trigger takes to wind the barrel down. */
const COAST_TIME = 1000;

/**
 * `cent->pe`'s three barrel fields, which are a latch rather than an angle.
 *
 * Q3 does not integrate the spin. It records *when* the trigger last changed
 * state and what the angle was at that moment, and derives the current angle
 * from the elapsed time on every frame -- so the barrel's position is a pure
 * function of the clock and cannot drift with the frame rate, and a frame that
 * takes 200 ms turns it exactly as far as twelve frames of 16 ms would.
 *
 * One of these per *player*, not per weapon: `cent->pe` belongs to the entity
 * holding the gun. Switching from a spun-up chaingun to the gauntlet and back
 * finds the barrel where it would have been, which is what the C does.
 */
export interface BarrelSpin {
    /** `barrelTime`: when the trigger last changed, on the caller's clock, ms. */
    time: number;
    /** `barrelAngle`: the angle at that moment, degrees, wrapped by `AngleMod`. */
    angle: number;
    /** `barrelSpinning`: whether the trigger was *held* at `time`. */
    spinning: boolean;
}

/**
 * A barrel at rest, and one that has been at rest long enough to say so.
 *
 * `time` starts a whole `COAST_TIME` in the past, which is not decoration.
 * `centity_t` is memset on map load, so Q3 reaches this function with
 * `barrelTime == 0` and `cg.time` at the server's -- a delta of minutes, which
 * the coast arm clamps, so a Q3 barrel that has never been fired sits at a
 * constant `0 + COAST_TIME * 0.45 = 450` degrees from its first frame onwards.
 * Starting a zero-based clock at `time = 0` instead reproduces the *formula*
 * and not the *behaviour*: the delta is small and climbing, so the barrel winds
 * itself through 450 degrees over the first second of the map with nobody
 * touching the trigger. That is the one part of this that would be visible, and
 * it is not in the C.
 *
 * The constant 450 offset that remains is the C's, and it is invisible on all
 * five barrels for the same reason the spin is cheap to draw: every one of them
 * is a body of revolution about the axis it turns on.
 */
export function newBarrelSpin(): BarrelSpin {
    return { time: -COAST_TIME, angle: 0, spinning: false };
}

/**
 * `AngleMod`, including its quantisation.
 *
 * The C rounds to 1/65536 of a turn on the way through, which is a fifth of a
 * hundredth of a degree and invisible. It is copied anyway because it is one
 * expression, and because a wrap written by hand is a wrap that has to be
 * argued about for negative inputs -- this one never sees any (see the note in
 * {@link barrelSpinAngle}), and the C's is what it is.
 */
function angleMod(degrees: number): number {
    return (360 / 65536) * (Math.trunc(degrees * (65536 / 360)) & 65535);
}

/**
 * `CG_MachinegunSpinAngle`: how far round the barrel is, in degrees.
 *
 * **Mutates `spin`**, and must therefore be called exactly once per frame per
 * player -- which is what the C does, from inside `CG_AddPlayerWeapon`. Calling
 * it twice in a frame is not harmless: each call is what advances the latch.
 *
 * The two arms are a constant rate while the trigger is held and a decelerating
 * one after it is let go. The second is worth reading closely, because it is
 * not the obvious thing: `speed` is the *average* over the whole interval since
 * release, not the instantaneous rate, so the angle comes out quadratic in
 * `delta` and the barrel eases to a stop rather than snapping to one. Its
 * derivative is `0.95 - delta/1000` degrees per ms, which crosses zero at 950 ms
 * and is very slightly negative for the last fiftieth of a second. That backwards
 * creep of a quarter of a degree is the C's, and it is left in.
 *
 * `angle` is deliberately **not** wrapped on the way out -- only the latched
 * value is. Holding the trigger for a minute returns 54,000 degrees, and that is
 * fine for something that becomes a rotation; wrapping it here would put a seam
 * in the middle of a continuous spin. It is also why the input to `angleMod` is
 * never negative: both arms only ever add to a non-negative `spin.angle`, the
 * coast arm's minimum over its clamped interval being at `delta = 0`.
 */
export function barrelSpinAngle(spin: BarrelSpin, nowMs: number, firing: boolean): number {
    let delta = nowMs - spin.time;
    let angle: number;

    if (spin.spinning) {
        angle = spin.angle + delta * SPIN_SPEED;
    } else {
        if (delta > COAST_TIME) delta = COAST_TIME;

        const speed = 0.5 * (SPIN_SPEED + (COAST_TIME - delta) / COAST_TIME);
        angle = spin.angle + delta * speed;
    }

    // `if ( cent->pe.barrelSpinning == !(cent->currentState.eFlags & EF_FIRING) )`
    // -- both sides are 0 or 1, so this is "the trigger changed".
    if (spin.spinning !== firing) {
        spin.time = nowMs;
        spin.angle = angleMod(angle);
        spin.spinning = firing;
    }

    return angle;
}

const scratchOffset = new Vector3();
const scratchRoll = new Quaternion();

/**
 * `CG_PositionRotatedEntityOnTag`, for a parent whose pose is already world.
 *
 * The C composes two `refEntity_t` axes; here the parent's pose is a `Transform`
 * that the caller has just written, so the same two lines are a rotated offset
 * and a quaternion product. The offset is scaled on the way out because the
 * transform's own `scale` does not reach a sibling entity -- every drawn piece
 * is its own entity, so the parent's scale has to be applied to the tag by hand.
 *
 * `rollRadians` is `angles[ROLL]` from the C's `AnglesToAxis` call, which is a
 * turn about the attached model's **own forward axis** -- +x in meep model
 * axes, the barrel's length. It multiplies on the *right*, because
 * `CG_PositionRotatedEntityOnTag` composes `entity->axis * lerped.axis *
 * parent->axis` and the entity's own axis is the one already carrying the roll:
 * the barrel turns in its own frame, then the tag places that frame on the gun,
 * then the gun goes where the gun goes. Composing it on the left instead would
 * swing the barrel round the gun rather than spinning it.
 *
 * `outPosition` and `outRotation` may not alias `parentPosition`/`parentRotation`.
 */
export function placeOnTag(
    parentPosition: Vector3,
    parentRotation: Quaternion,
    attachment: TagAttachment,
    outPosition: Vector3,
    outRotation: Quaternion,
    rollRadians = 0
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

    if (rollRadians !== 0) {
        scratchRoll._fromAxisAngle(1, 0, 0, rollRadians);
        outRotation.multiply(scratchRoll);
    }
}
