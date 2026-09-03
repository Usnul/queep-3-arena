/*
 * adapters.ts -- the wire format, and how two snapshots of it blend.
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
 * Two adapters per interpolated component, and the pair is the contract:
 *
 *  - a `BinaryClassSerializationAdapter`, which turns a component into bytes
 *    and back. The session uses it for AUTH_STATE, for INITIAL_SYNC, for the
 *    rewind's prior-state capture and for the interpolation log's records.
 *  - a `BinaryInterpolationAdapter`, which reads *two* encoded snapshots out of
 *    one buffer and writes a blended third **in the same layout**, so the
 *    session can hand the result straight back to the serialization adapter's
 *    `deserialize`. `TransformInterpolationAdapter` is the model.
 *
 * The two must agree on the layout byte for byte or the blend silently
 * reinterprets one field as another; `test/net-protocol.test.ts` asserts it by
 * blending at `t = 0` and `t = 1` and requiring the endpoints back exactly.
 *
 * **Float32 everywhere for positions and velocities**, and the truncation is
 * the point rather than a saving: a value that has been through the wire is
 * `Math.fround` of the value that went in, on both peers, so a host and a
 * client that both read their state back from bytes agree bit for bit. A
 * Float64 field would agree only until the first rounding.
 *
 * **Angles are Float32 degrees, not Q3 shorts.** `ps.viewangles` is a float
 * array in this port (`PM_UpdateViewAngles` truncates through the *command*,
 * which is 16-bit, and writes the float back out), so encoding the angle as a
 * short here would be a second, different truncation on top of Q3's and the
 * client's predicted heading would not match the host's. The command's angles
 * *are* 16-bit, and `UserCmdAction` sends them as such.
 */

import { BinaryClassSerializationAdapter } from '@woosh/meep-engine/src/engine/ecs/storage/binary/BinaryClassSerializationAdapter.js';
import {
    BinaryInterpolationAdapter,
    InterpolationKind,
} from '@woosh/meep-engine/src/engine/interpolation/BinaryInterpolationAdapter.js';
import type { BinaryBuffer } from '@woosh/meep-engine/src/core/binary/BinaryBuffer.js';
import { utf8_encoded_length } from '@woosh/meep-engine/src/core/binary/utf8/utf8_encoded_length.js';

import {
    MAX_NAME_BYTES,
    NET_WEAPON_COUNT,
    NetInventory,
    NetItem,
    NetMatch,
    NetMissile,
    NetMover,
    NetPlayerInfo,
    NetPlayerState,
} from './components.ts';

/* ------------------------------------------------------------------ *
 * Shared field helpers
 * ------------------------------------------------------------------ */

function writeVec3(buffer: BinaryBuffer, v: ArrayLike<number>): void {
    buffer.writeFloat32(v[0]!);
    buffer.writeFloat32(v[1]!);
    buffer.writeFloat32(v[2]!);
}

function readVec3(buffer: BinaryBuffer, v: Float32Array): void {
    v[0] = buffer.readFloat32();
    v[1] = buffer.readFloat32();
    v[2] = buffer.readFloat32();
}

/**
 * Blend two angles in degrees the short way round, and hand back a normalised
 * one.
 *
 * A yaw crossing +/-180 is the case the wrap exists for: 179 to -179 is two
 * degrees of turn, and a plain lerp draws it as 358 degrees of spin the other
 * way, once, on every remote character that walks past south. `AngleSubtract`
 * in `q_math.c` is the same shortest-path difference.
 *
 * **The result is wrapped back into `[-180, 180)`, and that second wrap is not
 * cosmetic.** `BinaryInterpolationAdapter` documents `t = 1` as returning
 * snapshot B, and without it a blend from 179.75 to -170 returns 190 -- the
 * same direction, a different number, and not the endpoint the contract
 * promises. Wrapped, the adapter returns B's own bytes at `t = 1` for any
 * normalised input, which is what makes the endpoint assertions in
 * `test/net-protocol.test.ts` exact equalities rather than approximations.
 *
 * Normalised input is the precondition, and this port meets it: an angle only
 * reaches a component through `PM_UpdateViewAngles`, whose `SHORT2ANGLE` is in
 * `[-180, 180)` by construction.
 *
 * Exactly 180 apart is a tie -- both ways round are the same distance -- and
 * the unwrapped `delta` of +180 breaks it in the positive direction, which is
 * arbitrary and stable, which is all a tie needs to be.
 */
export function lerpAngle(a: number, b: number, t: number): number {
    let delta = b - a;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    let out = a + delta * t;
    while (out >= 180) out -= 360;
    while (out < -180) out += 360;
    return out;
}

/* ------------------------------------------------------------------ *
 * NetPlayerState
 * ------------------------------------------------------------------ */

/**
 * Layout (70 bytes):
 * `connected u8, alive u8, origin f32*3, velocity f32*3, viewangles f32*3,
 *  deltaAngles i16*3, pmFlags u16, pmTime i16, groundEntityNum u16,
 *  viewheight i8, bobCycle u8, weapon u8, weaponTime i16, groundNormal f32*3,
 *  jumpHeld u8, ducked u8`.
 */
export class NetPlayerStateAdapter extends BinaryClassSerializationAdapter<NetPlayerState> {
    override klass = NetPlayerState;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetPlayerState): void {
        buffer.writeUint8(value.connected);
        buffer.writeUint8(value.alive);
        writeVec3(buffer, value.origin);
        writeVec3(buffer, value.velocity);
        writeVec3(buffer, value.viewangles);
        buffer.writeInt16(value.deltaAngles[0]!);
        buffer.writeInt16(value.deltaAngles[1]!);
        buffer.writeInt16(value.deltaAngles[2]!);
        buffer.writeUint16(value.pmFlags);
        buffer.writeInt16(value.pmTime);
        buffer.writeUint16(value.groundEntityNum);
        buffer.writeInt8(value.viewheight);
        buffer.writeUint8(value.bobCycle);
        buffer.writeUint8(value.weapon);
        buffer.writeInt16(value.weaponTime);
        writeVec3(buffer, value.groundNormal);
        buffer.writeUint8(value.jumpHeld);
        buffer.writeUint8(value.ducked);
    }

    override deserialize(buffer: BinaryBuffer, value: NetPlayerState): void {
        value.connected = buffer.readUint8();
        value.alive = buffer.readUint8();
        readVec3(buffer, value.origin);
        readVec3(buffer, value.velocity);
        readVec3(buffer, value.viewangles);
        value.deltaAngles[0] = buffer.readInt16();
        value.deltaAngles[1] = buffer.readInt16();
        value.deltaAngles[2] = buffer.readInt16();
        value.pmFlags = buffer.readUint16();
        value.pmTime = buffer.readInt16();
        value.groundEntityNum = buffer.readUint16();
        value.viewheight = buffer.readInt8();
        value.bobCycle = buffer.readUint8();
        value.weapon = buffer.readUint8();
        value.weaponTime = buffer.readInt16();
        readVec3(buffer, value.groundNormal);
        value.jumpHeld = buffer.readUint8();
        value.ducked = buffer.readUint8();
    }
}

/**
 * Origin, velocity and the ground normal lerp; the view angles lerp the short
 * way round; everything discrete comes from the *newer* snapshot.
 *
 * Discrete-from-newer rather than from-older is what makes a death, a weapon
 * change or a landing arrive on the frame it happened rather than a frame
 * late. It costs the opposite error -- the state changes at the start of the
 * blend rather than the end -- and for a boolean at 60 Hz that is the better
 * of the two.
 */
export class NetPlayerStateInterpolation extends BinaryInterpolationAdapter {
    override kind = InterpolationKind.Linear;

    override interpolate(
        out: BinaryBuffer,
        source: BinaryBuffer,
        firstOffset: number,
        secondOffset: number,
        t: number
    ): void {
        source.position = firstOffset;
        source.position += 2; // connected, alive: taken from B
        const ax = source.readFloat32();
        const ay = source.readFloat32();
        const az = source.readFloat32();
        const avx = source.readFloat32();
        const avy = source.readFloat32();
        const avz = source.readFloat32();
        const aa0 = source.readFloat32();
        const aa1 = source.readFloat32();
        const aa2 = source.readFloat32();
        source.position += 6 + 2 + 2 + 2 + 1 + 1 + 1 + 2; // discrete block: from B
        const an0 = source.readFloat32();
        const an1 = source.readFloat32();
        const an2 = source.readFloat32();

        source.position = secondOffset;
        const connected = source.readUint8();
        const alive = source.readUint8();
        const bx = source.readFloat32();
        const by = source.readFloat32();
        const bz = source.readFloat32();
        const bvx = source.readFloat32();
        const bvy = source.readFloat32();
        const bvz = source.readFloat32();
        const ba0 = source.readFloat32();
        const ba1 = source.readFloat32();
        const ba2 = source.readFloat32();
        const d0 = source.readInt16();
        const d1 = source.readInt16();
        const d2 = source.readInt16();
        const pmFlags = source.readUint16();
        const pmTime = source.readInt16();
        const groundEntityNum = source.readUint16();
        const viewheight = source.readInt8();
        const bobCycle = source.readUint8();
        const weapon = source.readUint8();
        const weaponTime = source.readInt16();
        const bn0 = source.readFloat32();
        const bn1 = source.readFloat32();
        const bn2 = source.readFloat32();
        const jumpHeld = source.readUint8();
        const ducked = source.readUint8();

        out.writeUint8(connected);
        out.writeUint8(alive);
        out.writeFloat32(ax + (bx - ax) * t);
        out.writeFloat32(ay + (by - ay) * t);
        out.writeFloat32(az + (bz - az) * t);
        out.writeFloat32(avx + (bvx - avx) * t);
        out.writeFloat32(avy + (bvy - avy) * t);
        out.writeFloat32(avz + (bvz - avz) * t);
        out.writeFloat32(lerpAngle(aa0, ba0, t));
        out.writeFloat32(lerpAngle(aa1, ba1, t));
        out.writeFloat32(lerpAngle(aa2, ba2, t));
        out.writeInt16(d0);
        out.writeInt16(d1);
        out.writeInt16(d2);
        out.writeUint16(pmFlags);
        out.writeInt16(pmTime);
        out.writeUint16(groundEntityNum);
        out.writeInt8(viewheight);
        out.writeUint8(bobCycle);
        out.writeUint8(weapon);
        out.writeInt16(weaponTime);
        out.writeFloat32(an0 + (bn0 - an0) * t);
        out.writeFloat32(an1 + (bn1 - an1) * t);
        out.writeFloat32(an2 + (bn2 - an2) * t);
        out.writeUint8(jumpHeld);
        out.writeUint8(ducked);
    }
}

/* ------------------------------------------------------------------ *
 * NetInventory
 * ------------------------------------------------------------------ */

/** Layout: `health i16, armor i16, maxHealth i16, ammo i16*N, weapons u16, holdable u8`. */
export class NetInventoryAdapter extends BinaryClassSerializationAdapter<NetInventory> {
    override klass = NetInventory;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetInventory): void {
        buffer.writeInt16(value.health);
        buffer.writeInt16(value.armor);
        buffer.writeInt16(value.maxHealth);
        for (let i = 0; i < NET_WEAPON_COUNT; i++) buffer.writeInt16(value.ammo[i]!);
        buffer.writeUint16(value.weapons);
        buffer.writeUint8(value.holdable);
    }

    override deserialize(buffer: BinaryBuffer, value: NetInventory): void {
        value.health = buffer.readInt16();
        value.armor = buffer.readInt16();
        value.maxHealth = buffer.readInt16();
        for (let i = 0; i < NET_WEAPON_COUNT; i++) value.ammo[i] = buffer.readInt16();
        value.weapons = buffer.readUint16();
        value.holdable = buffer.readUint8();
    }
}

/* ------------------------------------------------------------------ *
 * NetPlayerInfo
 * ------------------------------------------------------------------ */

/**
 * Layout: `name UTF-8 (length-prefixed), character u8, isBot u8, kills i16,
 * deaths i16, pingMs u16`.
 *
 * The name is truncated to {@link MAX_NAME_BYTES} *bytes* on the way out,
 * cutting at a code-point boundary rather than mid-sequence -- `writeUTF8String`
 * would happily emit a longer string, and a component that outgrows the
 * session's 1024-byte scratch throws at the send rather than at the join.
 */
export class NetPlayerInfoAdapter extends BinaryClassSerializationAdapter<NetPlayerInfo> {
    override klass = NetPlayerInfo;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetPlayerInfo): void {
        buffer.writeUint8(value.playerId);
        buffer.writeUTF8String(truncateUtf8(value.name, MAX_NAME_BYTES));
        buffer.writeUint8(value.character);
        buffer.writeUint8(value.isBot);
        buffer.writeInt16(value.kills);
        buffer.writeInt16(value.deaths);
        buffer.writeUint16(value.pingMs);
    }

    override deserialize(buffer: BinaryBuffer, value: NetPlayerInfo): void {
        value.playerId = buffer.readUint8();
        value.name = buffer.readUTF8String();
        value.character = buffer.readUint8();
        value.isBot = buffer.readUint8();
        value.kills = buffer.readInt16();
        value.deaths = buffer.readInt16();
        value.pingMs = buffer.readUint16();
    }
}

/**
 * Cut a string to at most `maxBytes` of UTF-8 without splitting a code point.
 *
 * By code point rather than by code unit: a lone surrogate half survives
 * `String.prototype.slice` and encodes as U+FFFD, so a name cut mid-emoji comes
 * back as a different string on every peer than the one the host holds -- and
 * `equals` on `NetPlayerInfo` would then never settle.
 *
 * The measuring is meep's `utf8_encoded_length`, not a `TextEncoder`. The first
 * version of this encoded the whole string to find its length and then encoded
 * every code point again to find *its* length -- two allocations per character
 * to count bytes nobody keeps. The engine's counts them arithmetically. Same
 * family of miss as the hand-written mulberry32 in `src/server/random.ts`
 * (D-172): the utility was there, under a name that says what it does.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
    if (utf8_encoded_length(value) <= maxBytes) return value;

    let out = '';
    let bytes = 0;
    for (const codePoint of value) {
        const size = utf8_encoded_length(codePoint);
        if (bytes + size > maxBytes) break;
        out += codePoint;
        bytes += size;
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * NetMissile
 * ------------------------------------------------------------------ */

/** Layout: `active u8, generation u8, weapon u8, owner u8, origin f32*3, velocity f32*3`. */
export class NetMissileAdapter extends BinaryClassSerializationAdapter<NetMissile> {
    override klass = NetMissile;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetMissile): void {
        buffer.writeUint8(value.active);
        buffer.writeUint8(value.generation);
        buffer.writeUint8(value.weapon);
        buffer.writeUint8(value.owner);
        writeVec3(buffer, value.origin);
        writeVec3(buffer, value.velocity);
    }

    override deserialize(buffer: BinaryBuffer, value: NetMissile): void {
        value.active = buffer.readUint8();
        value.generation = buffer.readUint8();
        value.weapon = buffer.readUint8();
        value.owner = buffer.readUint8();
        readVec3(buffer, value.origin);
        readVec3(buffer, value.velocity);
    }
}

/**
 * Origin and velocity lerp; the four bytes in front come from the newer
 * snapshot.
 *
 * Deliberately *not* smart about `active`: a slot that goes inactive between
 * the two ticks is drawn at the blended position and hidden by the newer
 * `active` byte on the same frame, which is what puts the explosion and the
 * missile's disappearance in the same place.
 */
export class NetMissileInterpolation extends BinaryInterpolationAdapter {
    override kind = InterpolationKind.Linear;

    override interpolate(
        out: BinaryBuffer,
        source: BinaryBuffer,
        firstOffset: number,
        secondOffset: number,
        t: number
    ): void {
        source.position = firstOffset + 4;
        const ax = source.readFloat32();
        const ay = source.readFloat32();
        const az = source.readFloat32();
        const avx = source.readFloat32();
        const avy = source.readFloat32();
        const avz = source.readFloat32();

        source.position = secondOffset;
        const active = source.readUint8();
        const generation = source.readUint8();
        const weapon = source.readUint8();
        const owner = source.readUint8();
        const bx = source.readFloat32();
        const by = source.readFloat32();
        const bz = source.readFloat32();
        const bvx = source.readFloat32();
        const bvy = source.readFloat32();
        const bvz = source.readFloat32();

        out.writeUint8(active);
        out.writeUint8(generation);
        out.writeUint8(weapon);
        out.writeUint8(owner);
        out.writeFloat32(ax + (bx - ax) * t);
        out.writeFloat32(ay + (by - ay) * t);
        out.writeFloat32(az + (bz - az) * t);
        out.writeFloat32(avx + (bvx - avx) * t);
        out.writeFloat32(avy + (bvy - avy) * t);
        out.writeFloat32(avz + (bvz - avz) * t);
    }
}

/* ------------------------------------------------------------------ *
 * NetItem
 * ------------------------------------------------------------------ */

/** Layout: `index u16, present u8`. */
export class NetItemAdapter extends BinaryClassSerializationAdapter<NetItem> {
    override klass = NetItem;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetItem): void {
        buffer.writeUint16(value.index);
        buffer.writeUint8(value.present);
    }

    override deserialize(buffer: BinaryBuffer, value: NetItem): void {
        value.index = buffer.readUint16();
        value.present = buffer.readUint8();
    }
}

/* ------------------------------------------------------------------ *
 * NetMover
 * ------------------------------------------------------------------ */

/** Layout: `index u16, state u8, origin f32*3`. */
export class NetMoverAdapter extends BinaryClassSerializationAdapter<NetMover> {
    override klass = NetMover;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetMover): void {
        buffer.writeUint16(value.index);
        buffer.writeUint8(value.state);
        writeVec3(buffer, value.origin);
    }

    override deserialize(buffer: BinaryBuffer, value: NetMover): void {
        value.index = buffer.readUint16();
        value.state = buffer.readUint8();
        readVec3(buffer, value.origin);
    }
}

/** Origin lerps; index and state come from the newer snapshot. */
export class NetMoverInterpolation extends BinaryInterpolationAdapter {
    override kind = InterpolationKind.Linear;

    override interpolate(
        out: BinaryBuffer,
        source: BinaryBuffer,
        firstOffset: number,
        secondOffset: number,
        t: number
    ): void {
        source.position = firstOffset + 3;
        const ax = source.readFloat32();
        const ay = source.readFloat32();
        const az = source.readFloat32();

        source.position = secondOffset;
        const index = source.readUint16();
        const state = source.readUint8();
        const bx = source.readFloat32();
        const by = source.readFloat32();
        const bz = source.readFloat32();

        out.writeUint16(index);
        out.writeUint8(state);
        out.writeFloat32(ax + (bx - ax) * t);
        out.writeFloat32(ay + (by - ay) * t);
        out.writeFloat32(az + (bz - az) * t);
    }
}

/* ------------------------------------------------------------------ *
 * NetMatch
 * ------------------------------------------------------------------ */

/** Layout: `simFrame u32, timeMs u32, fragLimit u8, phase u8`. */
export class NetMatchAdapter extends BinaryClassSerializationAdapter<NetMatch> {
    override klass = NetMatch;
    override version = 1;

    override serialize(buffer: BinaryBuffer, value: NetMatch): void {
        buffer.writeUint32(value.simFrame);
        buffer.writeUint32(value.timeMs);
        buffer.writeUint8(value.fragLimit);
        buffer.writeUint8(value.phase);
    }

    override deserialize(buffer: BinaryBuffer, value: NetMatch): void {
        value.simFrame = buffer.readUint32();
        value.timeMs = buffer.readUint32();
        value.fragLimit = buffer.readUint8();
        value.phase = buffer.readUint8();
    }
}
