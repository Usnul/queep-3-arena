/*
 * components.ts -- what is replicated, as plain components.
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
 * Seven components, one per kind of thing the host owns, and every one of them
 * is *flat data with a `static typeName`*. That is the whole contract the
 * session asks for: `replicate(Class)` needs a `typeName` to find the class's
 * adapter in the binary registry, and nothing else. In particular the engine
 * never calls `equals`, `hash` or `copy` on a replicated component -- grep says
 * the only `.equals(` under `engine/network` is the reconnect token's.
 *
 * They are here anyway, and not out of symmetry with `NetworkIdentity`:
 *
 *  - `equals` is what the publish pass asks. "Publish on change" for an item, a
 *    score or a resting mover is a comparison against last frame's value, and
 *    the alternative -- publishing everything every frame -- is the bandwidth
 *    the report has to measure.
 *  - `copy` is what the client's reconciliation ring is made of: the owned
 *    slot's state as it stood at the end of each predicted frame, kept so the
 *    AUTH_STATE short-circuit has something to hash against.
 *
 * **These classes never move.** A component's fields are written by the
 * adapter beside this file and read by the game objects; nothing here has a
 * method that does game logic, because a replicated component is state that a
 * rewind can rewrite underneath its owner at any moment.
 *
 * The declaration order in {@link REPLICATED} is the wire order, is the
 * AUTH_STATE payload order, and must be identical on host and client --
 * `registerProtocol` in `protocolSetup.ts` is the only place it is written.
 */

import { WEAPON_ORDER as Q3_WEAPON_ORDER, isWeaponId } from '../game/Weapons.ts';

/**
 * The weapons a slot can hold, in Q3's own `weapon_t` order.
 *
 * `NETWORK_PLAN.md` §4.1 says thirteen, one per `WEAPON_ORDER` entry, and
 * thirteen is the length of `balance.weaponOrder`. Twelve of them are weapons:
 * the list includes `WP_GRAPPLING_HOOK`, which `balance.weapons` has no numbers
 * for, which `isWeaponId` therefore rejects, and which `PlayerController` has
 * always filtered out of the wheel for exactly that reason. A wire slot for a
 * weapon that can never be held or fired is two bytes of ammunition for a gun
 * that does not exist, so the wire takes the same filtered list the game does
 * -- and takes it *derived*, so that a weapon appearing in the balance tables
 * appears on the wire without anyone editing a constant.
 */
export const NET_WEAPONS: readonly string[] = Q3_WEAPON_ORDER.filter(isWeaponId);

/** How many ammunition counters a `NetInventory` carries. Twelve, today. */
export const NET_WEAPON_COUNT = NET_WEAPONS.length;

/** Wire index of a weapon tag, or 0 (`WP_GAUNTLET`) for one off the list. */
export function weaponIndex(tag: string): number {
    const at = NET_WEAPONS.indexOf(tag);
    return at < 0 ? 0 : at;
}

/** The weapon tag at a wire index, clamped to the list. */
export function weaponAt(index: number): string {
    return NET_WEAPONS[index] ?? NET_WEAPONS[0]!;
}

/* ------------------------------------------------------------------ *
 * Player slots
 * ------------------------------------------------------------------ */

/**
 * Everything the shared per-frame step reads or writes, for one slot.
 *
 * Which is *not* the same set as `playerState_t`: it is the fields
 * `PlayerSlot.step` actually touches, plus the four that live in `MoveState`
 * rather than in `ps` (`groundNormal`, `jumpHeld`, and the ducked/viewheight
 * pair). Those four are why this component exists in this shape. A rewind
 * restores replicated components and nothing else, so any state the step
 * carries between frames that is *not* here would survive a rollback
 * unchanged, and the replay would run from a mixture of two different frames
 * -- which is the failure that has no symptom except drift.
 *
 * `viewangles` rides along even though the owner's client computes its own:
 * remote clients need it to point a character model and a muzzle flash
 * somewhere.
 */
export class NetPlayerState {
    static readonly typeName = 'NetPlayerState';

    /** A slot with nobody in it is still an entity; this is what says so. */
    connected = 0;
    alive = 0;

    readonly origin = new Float32Array(3);
    readonly velocity = new Float32Array(3);
    readonly viewangles = new Float32Array(3);

    /** `ps.delta_angles`, Q3's 16-bit view offset. The host's only way to turn a client. */
    readonly deltaAngles = new Int16Array(3);

    pmFlags = 0;
    pmTime = 0;
    groundEntityNum = 0;
    viewheight = 0;
    bobCycle = 0;

    /** Index into {@link NET_WEAPONS}. */
    weapon = 0;
    weaponTime = 0;

    /* ---- the half that is not in `ps` ---- */

    readonly groundNormal = new Float32Array(3);
    jumpHeld = 0;
    ducked = 0;

    equals(other: NetPlayerState): boolean {
        return (
            this.connected === other.connected &&
            this.alive === other.alive &&
            vec3Equals(this.origin, other.origin) &&
            vec3Equals(this.velocity, other.velocity) &&
            vec3Equals(this.viewangles, other.viewangles) &&
            vec3Equals(this.deltaAngles, other.deltaAngles) &&
            this.pmFlags === other.pmFlags &&
            this.pmTime === other.pmTime &&
            this.groundEntityNum === other.groundEntityNum &&
            this.viewheight === other.viewheight &&
            this.bobCycle === other.bobCycle &&
            this.weapon === other.weapon &&
            this.weaponTime === other.weaponTime &&
            vec3Equals(this.groundNormal, other.groundNormal) &&
            this.jumpHeld === other.jumpHeld &&
            this.ducked === other.ducked
        );
    }

    hash(): number {
        let h = this.connected * 2 + this.alive;
        h = mixFloats(h, this.origin);
        h = mixFloats(h, this.velocity);
        h = mixFloats(h, this.viewangles);
        h = mixInts(h, this.deltaAngles);
        h = mixInt(h, this.pmFlags);
        h = mixInt(h, this.pmTime);
        h = mixInt(h, this.groundEntityNum);
        h = mixInt(h, this.viewheight);
        h = mixInt(h, this.bobCycle);
        h = mixInt(h, this.weapon);
        h = mixInt(h, this.weaponTime);
        h = mixFloats(h, this.groundNormal);
        h = mixInt(h, this.jumpHeld);
        return mixInt(h, this.ducked);
    }

    copy(other: NetPlayerState): this {
        this.connected = other.connected;
        this.alive = other.alive;
        this.origin.set(other.origin);
        this.velocity.set(other.velocity);
        this.viewangles.set(other.viewangles);
        this.deltaAngles.set(other.deltaAngles);
        this.pmFlags = other.pmFlags;
        this.pmTime = other.pmTime;
        this.groundEntityNum = other.groundEntityNum;
        this.viewheight = other.viewheight;
        this.bobCycle = other.bobCycle;
        this.weapon = other.weapon;
        this.weaponTime = other.weaponTime;
        this.groundNormal.set(other.groundNormal);
        this.jumpHeld = other.jumpHeld;
        this.ducked = other.ducked;
        return this;
    }
}

/**
 * A slot's inventory, flattened.
 *
 * `Inventory` in `src/game/Items.ts` is a `Record` of ammo, a `Set` of weapons
 * and a `Map` of powerups -- three iteration orders that are properties of
 * insertion history rather than of the game, which is exactly what may not go
 * on a wire. Here ammunition is an array indexed by {@link NET_WEAPONS} and
 * ownership is a bitmask over the same list, so two peers that received the
 * same bytes hold the same inventory whatever order they picked things up in.
 *
 * Powerups are absent because the port has none yet (`Inventory.powerups` is
 * written by nothing); when they arrive they are a second bitmask plus an
 * expiry, not a map.
 */
export class NetInventory {
    static readonly typeName = 'NetInventory';

    health = 0;
    armor = 0;
    maxHealth = 0;

    /** One per {@link NET_WEAPONS} entry. `-1` is Q3's "infinite". */
    readonly ammo = new Int16Array(NET_WEAPON_COUNT);

    /** Bit `i` set means the slot owns `NET_WEAPONS[i]`. */
    weapons = 0;

    /** Index into the holdable list, `0` for none. Reserved; nothing sets it yet. */
    holdable = 0;

    equals(other: NetInventory): boolean {
        if (
            this.health !== other.health ||
            this.armor !== other.armor ||
            this.maxHealth !== other.maxHealth ||
            this.weapons !== other.weapons ||
            this.holdable !== other.holdable
        ) {
            return false;
        }
        for (let i = 0; i < NET_WEAPON_COUNT; i++) {
            if (this.ammo[i] !== other.ammo[i]) return false;
        }
        return true;
    }

    hash(): number {
        let h = mixInt(mixInt(mixInt(this.health, this.armor), this.maxHealth), this.weapons);
        h = mixInt(h, this.holdable);
        return mixInts(h, this.ammo);
    }

    copy(other: NetInventory): this {
        this.health = other.health;
        this.armor = other.armor;
        this.maxHealth = other.maxHealth;
        this.ammo.set(other.ammo);
        this.weapons = other.weapons;
        this.holdable = other.holdable;
        return this;
    }
}

/**
 * Who is in a slot, and how they are doing.
 *
 * Published on change rather than per frame: a name and a character never
 * change inside a match, and a score changes a handful of times a minute. The
 * ping is the exception and is why "on change" is not "almost never" -- it is
 * refreshed about once a second, which is also what `NetMatch` costs.
 */
export class NetPlayerInfo {
    static readonly typeName = 'NetPlayerInfo';

    /** UTF-8, truncated to {@link MAX_NAME_BYTES} by the adapter. */
    name = '';
    /** Index into the character list the client loaded; not a model name. */
    character = 0;
    isBot = 0;
    kills = 0;
    deaths = 0;
    pingMs = 0;

    equals(other: NetPlayerInfo): boolean {
        return (
            this.name === other.name &&
            this.character === other.character &&
            this.isBot === other.isBot &&
            this.kills === other.kills &&
            this.deaths === other.deaths &&
            this.pingMs === other.pingMs
        );
    }

    hash(): number {
        let h = 0;
        for (let i = 0; i < this.name.length; i++) h = mixInt(h, this.name.charCodeAt(i));
        h = mixInt(h, this.character);
        h = mixInt(h, this.isBot);
        h = mixInt(h, this.kills);
        h = mixInt(h, this.deaths);
        return mixInt(h, this.pingMs);
    }

    copy(other: NetPlayerInfo): this {
        this.name = other.name;
        this.character = other.character;
        this.isBot = other.isBot;
        this.kills = other.kills;
        this.deaths = other.deaths;
        this.pingMs = other.pingMs;
        return this;
    }
}

/** Longest name the wire carries. A byte count, not a character count. */
export const MAX_NAME_BYTES = 32;

/* ------------------------------------------------------------------ *
 * Missiles, items, movers, the match
 * ------------------------------------------------------------------ */

/**
 * One entry of the missile pool.
 *
 * `generation` is what makes a pool safe to draw. A slot that deactivates and
 * reactivates in the same second is, to a client blending between two ticks, a
 * rocket that teleported across the room -- so the client hides the slot for a
 * frame when the counter moves, and the counter is on the wire rather than
 * inferred from `active` because two flights can be separated by fewer frames
 * than the render delay.
 */
export class NetMissile {
    static readonly typeName = 'NetMissile';

    active = 0;
    generation = 0;
    /** Index into {@link NET_WEAPONS}. */
    weapon = 0;
    /** The slot that fired it, for the owner-skip and for the kill credit. */
    owner = 0;

    readonly origin = new Float32Array(3);
    readonly velocity = new Float32Array(3);

    equals(other: NetMissile): boolean {
        return (
            this.active === other.active &&
            this.generation === other.generation &&
            this.weapon === other.weapon &&
            this.owner === other.owner &&
            vec3Equals(this.origin, other.origin) &&
            vec3Equals(this.velocity, other.velocity)
        );
    }

    hash(): number {
        let h = mixInt(mixInt(mixInt(this.active, this.generation), this.weapon), this.owner);
        h = mixFloats(h, this.origin);
        return mixFloats(h, this.velocity);
    }

    copy(other: NetMissile): this {
        this.active = other.active;
        this.generation = other.generation;
        this.weapon = other.weapon;
        this.owner = other.owner;
        this.origin.set(other.origin);
        this.velocity.set(other.velocity);
        return this;
    }
}

/**
 * One map item: is it there.
 *
 * Three bytes, because everything else about an item -- where it is, what it
 * is, how it bobs -- is in the map both peers loaded. The client's own
 * `ItemSystem` still owns the presentation; all it is missing is the fact of a
 * pickup, and that is a single bit belonging to the host.
 */
export class NetItem {
    static readonly typeName = 'NetItem';

    index = 0;
    present = 0;

    equals(other: NetItem): boolean {
        return this.index === other.index && this.present === other.present;
    }

    hash(): number {
        return mixInt(this.index, this.present);
    }

    copy(other: NetItem): this {
        this.index = other.index;
        this.present = other.present;
        return this;
    }
}

/**
 * One door, plat, button or trigger.
 *
 * `state` is `g_mover.c`'s four-state machine and the origin is where the
 * geometry is. Both, rather than the state alone: the port's movers run on an
 * integer-millisecond clock the client is not authoritative for, and a client
 * that re-derived the position from the state would have to agree about the
 * clock to the millisecond to stand on the platform the host thinks it is
 * standing on.
 */
export class NetMover {
    static readonly typeName = 'NetMover';

    index = 0;
    state = 0;
    readonly origin = new Float32Array(3);

    equals(other: NetMover): boolean {
        return (
            this.index === other.index &&
            this.state === other.state &&
            vec3Equals(this.origin, other.origin)
        );
    }

    hash(): number {
        return mixFloats(mixInt(this.index, this.state), this.origin);
    }

    copy(other: NetMover): this {
        this.index = other.index;
        this.state = other.state;
        this.origin.set(other.origin);
        return this;
    }
}

/** The match itself: what frame it is, how long it has run, and whether it is over. */
export class NetMatch {
    static readonly typeName = 'NetMatch';

    simFrame = 0;
    timeMs = 0;
    fragLimit = 0;
    /** 0 warmup, 1 playing, 2 intermission. */
    phase = 0;

    equals(other: NetMatch): boolean {
        return (
            this.simFrame === other.simFrame &&
            this.timeMs === other.timeMs &&
            this.fragLimit === other.fragLimit &&
            this.phase === other.phase
        );
    }

    hash(): number {
        return mixInt(mixInt(mixInt(this.simFrame, this.timeMs), this.fragLimit), this.phase);
    }

    copy(other: NetMatch): this {
        this.simFrame = other.simFrame;
        this.timeMs = other.timeMs;
        this.fragLimit = other.fragLimit;
        this.phase = other.phase;
        return this;
    }
}

/**
 * Wire order. `registerProtocol` replicates in exactly this sequence and every
 * peer must produce the same list, because a component's type id is its index
 * here plus one -- `NetworkIdentity` takes zero and is never named.
 */
export const REPLICATED = [
    NetPlayerState,
    NetInventory,
    NetPlayerInfo,
    NetMissile,
    NetItem,
    NetMover,
    NetMatch,
] as const;

/* ------------------------------------------------------------------ *
 * Local helpers. Not exported: nothing outside this file should be
 * hashing a component, and `equals` is the supported question.
 * ------------------------------------------------------------------ */

function vec3Equals(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** FNV-ish integer mix. Only ever compared against itself, never stored. */
function mixInt(h: number, v: number): number {
    return (Math.imul(h ^ v, 0x01000193) | 0) >>> 0;
}

function mixInts(h: number, a: ArrayLike<number>): number {
    let out = h;
    for (let i = 0; i < a.length; i++) out = mixInt(out, a[i]!);
    return out;
}

const FLOAT_BITS = new Float32Array(1);
const FLOAT_AS_INT = new Int32Array(FLOAT_BITS.buffer);

/** Hashes the float's *bits*, so `-0` and `0` are distinguished as the wire distinguishes them. */
function mixFloats(h: number, a: ArrayLike<number>): number {
    let out = h;
    for (let i = 0; i < a.length; i++) {
        FLOAT_BITS[0] = a[i]!;
        out = mixInt(out, FLOAT_AS_INT[0]!);
    }
    return out;
}
