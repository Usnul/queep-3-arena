/*
 * Items.ts -- pickups: spawning, touching, giving, respawning.
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
 * Ported in shape from `g_items.c` and `bg_misc.c`. Every number comes from
 * `src/game/balance.generated.json`, which is extracted from the OA sources at
 * a pinned commit rather than transcribed -- see `tools/extract-balance.mjs`.
 * Nothing here touches meep: this is the simulation, in Q3 units, and
 * `client/ItemsView.ts` is the half that draws it.
 *
 * Faithful, including the parts that look like mistakes:
 *
 * - The touch box is asymmetric. `BG_PlayerTouchesItem` accepts a player
 *   between 50 units *behind* an item's origin on X and 44 units in front of
 *   it, but is symmetric on Y and Z. Nothing in the code explains it and it is
 *   almost certainly a typo that shipped in 1999 and became load-bearing.
 * - Health and armour count *down* one point a second while above max, which is
 *   the mechanism that makes a 100-armour pickup a temporary advantage rather
 *   than a permanent one.
 * - Mega health and 5-health are the only pickups allowed past max health, and
 *   they are identified by their *quantity* rather than by a flag.
 */

import balance from './balance.generated.json' with { type: 'json' };
import { CONTENTS } from '../q3/cm/ClipMap.ts';
import { isWeaponId, type WeaponId } from './Weapons.ts';

/* ---- constants from g_items.c / bg_public.h ---- */

/** `#define ITEM_RADIUS 15` -- the half-extent of an item's own bounding box. */
export const ITEM_RADIUS = 15;

/** `Add_Ammo` clamps here. */
export const MAX_AMMO = 200;

/** `g_weaponrespawn` defaults to 5 in OA's deathmatch. */
export const WEAPON_RESPAWN_SECONDS = 5;

/** `ClientSpawn`: max health is 100 and you start at 125% of it. */
export const MAX_HEALTH = 100;

/** Spawnflag 1 on an item entity means "do not drop me to the floor". */
const SUSPENDED = 1;

export type ItemType =
    | 'IT_ARMOR'
    | 'IT_HEALTH'
    | 'IT_WEAPON'
    | 'IT_AMMO'
    | 'IT_HOLDABLE'
    | 'IT_POWERUP'
    | 'IT_TEAM'
    | 'IT_PERSISTANT_POWERUP';

export interface ItemDef {
    readonly classname: string;
    readonly pickupSound: string;
    readonly models: readonly string[];
    readonly icon: string;
    readonly pickupName: string;
    readonly quantity: number;
    readonly type: string;
    readonly tag: string;
}

const ITEMS: readonly ItemDef[] = balance.items as readonly ItemDef[];

const BY_CLASSNAME = new Map<string, ItemDef>();
for (const item of ITEMS) BY_CLASSNAME.set(item.classname, item);

export function itemByClassname(classname: string): ItemDef | null {
    return BY_CLASSNAME.get(classname) ?? null;
}

/**
 * The weapon pickups, by their `WP_*` tag.
 *
 * Weapons only. `giTag` is not unique across the table -- every ammo box shares
 * its weapon's tag, which is how `Add_Ammo` knows what it feeds -- so a map over
 * the whole list would answer `WP_ROCKET_LAUNCHER` with whichever of the two
 * came last.
 */
const WEAPON_BY_TAG = new Map<string, ItemDef>();
for (const item of ITEMS) {
    if (item.type === 'IT_WEAPON') WEAPON_BY_TAG.set(item.tag, item);
}

/**
 * The weapon pickup for a `WP_*` id, which is also where its model lives.
 *
 * `CG_RegisterWeapon` reaches the same entry the same way -- it walks
 * `bg_itemlist` for the `IT_WEAPON` whose `giTag` matches -- and everything the
 * presentation needs for a weapon hangs off `item->world_model[0]`.
 */
export function weaponItemByTag(tag: string): ItemDef | null {
    return WEAPON_BY_TAG.get(tag) ?? null;
}

/**
 * The ammo box for a `WP_*` id, which is the other half of the same split.
 *
 * Its own map for the reason `WEAPON_BY_TAG` has one: `giTag` is shared between
 * a weapon and the box that feeds it, so one map over the whole list answers
 * with whichever came last. The two together are the whole of what the table
 * says about a weapon's ammunition -- what the gun arrives with, and what a box
 * of it is worth -- which is what the HUD scales its ammo bar by (`statusBar.ts`).
 */
const AMMO_BY_TAG = new Map<string, ItemDef>();
for (const item of ITEMS) {
    if (item.type === 'IT_AMMO') AMMO_BY_TAG.set(item.tag, item);
}

export function ammoItemByTag(tag: string): ItemDef | null {
    return AMMO_BY_TAG.get(tag) ?? null;
}

/* ---- player inventory ---- */

export interface Inventory {
    health: number;
    armor: number;
    maxHealth: number;
    /** Keyed by `WP_*`, matching `balance.weapons`. `-1` is Q3's "infinite". */
    readonly ammo: Record<string, number>;
    /** `WP_*` names the player owns. */
    readonly weapons: Set<string>;
    /** `PW_*` name -> simulation time at which it expires. */
    readonly powerups: Map<string, number>;
    holdable: string | null;
}

/** `ClientSpawn`'s starting loadout for a deathmatch. */
export function newInventory(): Inventory {
    return {
        health: Math.floor(MAX_HEALTH * 1.25),
        armor: 0,
        maxHealth: MAX_HEALTH,
        ammo: { WP_GAUNTLET: -1, WP_MACHINEGUN: 100 },
        weapons: new Set(['WP_GAUNTLET', 'WP_MACHINEGUN']),
        powerups: new Map(),
        holdable: null,
    };
}

/* ---- world items ---- */

export interface ItemInstance {
    /** Stable index; also the bob phase seed, as Q3 uses the entity number. */
    readonly index: number;
    readonly def: ItemDef;
    /** Resting position after the drop trace, in Q3 units. */
    readonly origin: readonly [number, number, number];
    readonly suspended: boolean;
    /** False between pickup and respawn. */
    present: boolean;
    /** Simulation time at which it comes back. */
    respawnAt: number;
}

export interface PickupEvent {
    readonly item: ItemInstance;
    /** What actually went in: `50 Armor`, `Rocket Launcher`. */
    readonly label: string;
    /**
     * The weapon the pickup should put in the player's hands, or null.
     *
     * A `WeaponId` rather than the item's `giTag`, because the two lists are not
     * the same one -- see `isWeaponId`. A weapon this port has no numbers for is
     * still picked up and still owned; what it cannot do is become the weapon
     * being held, which is the one thing that needs a fire rate.
     */
    readonly selectWeapon: WeaponId | null;
}

/** The subset of a trace backend `ItemSystem` needs, so it can take either one. */
export type DropTrace = (
    start: ArrayLike<number>,
    mins: ArrayLike<number>,
    maxs: ArrayLike<number>,
    end: ArrayLike<number>,
    contentMask: number
) => { fraction: number; endpos: Float32Array | number[]; startsolid: boolean };

const ITEM_MINS: readonly [number, number, number] = [-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS];
const ITEM_MAXS: readonly [number, number, number] = [ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS];

export interface SpawnableEntity {
    readonly classname?: string;
    readonly _originQ3: number[];
    readonly spawnflags?: unknown;
    readonly wait?: unknown;
    readonly count?: unknown;
}

export class ItemSystem {
    readonly items: ItemInstance[] = [];

    /** Entities whose classname is an item but which the pipeline could not place. */
    readonly rejected: string[] = [];

    private time = 0;

    /**
     * `FinishSpawningItem`: give every item entity its box and drop it to the
     * floor, unless it is suspended.
     *
     * Q3 removes an item that falls out of the world entirely. That case is
     * kept -- a map with a misplaced item should be missing that item here too,
     * rather than showing one floating in the void, because the difference is a
     * thing a level designer would notice.
     */
    spawn(entities: readonly SpawnableEntity[], trace: DropTrace): void {
        for (const entity of entities) {
            const classname = entity.classname;
            if (classname === undefined) continue;

            const def = BY_CLASSNAME.get(classname);
            if (def === undefined) continue;

            const flags = Number(entity.spawnflags ?? 0) | 0;
            const suspended = (flags & SUSPENDED) !== 0;

            const start = entity._originQ3;
            let origin: [number, number, number] = [start[0]!, start[1]!, start[2]!];

            if (!suspended) {
                const result = trace(
                    start,
                    ITEM_MINS,
                    ITEM_MAXS,
                    [start[0]!, start[1]!, start[2]! - 4096],
                    CONTENTS.SOLID
                );

                if (result.startsolid) {
                    this.rejected.push(`${classname} at ${start.join(' ')}: in a solid`);
                    continue;
                }
                if (result.fraction === 1) {
                    this.rejected.push(`${classname} at ${start.join(' ')}: fell out of the world`);
                    continue;
                }

                origin = [result.endpos[0]!, result.endpos[1]!, result.endpos[2]!];
            }

            this.items.push({
                index: this.items.length,
                def,
                origin,
                suspended,
                present: true,
                respawnAt: 0,
            });
        }
    }

    /**
     * Advance time, respawn what is due, and hand back everything the player
     * touched this frame.
     *
     * Returns an array rather than raising events because a player can walk
     * through two items in one frame and the caller wants both, in order.
     */
    update(
        deltaSeconds: number,
        playerOriginQ3: ArrayLike<number>,
        inventory: Inventory,
        alive: boolean
    ): PickupEvent[] {
        this.time += deltaSeconds;

        const events: PickupEvent[] = [];

        for (const item of this.items) {
            if (!item.present) {
                if (this.time >= item.respawnAt) item.present = true;
                continue;
            }

            if (!alive) continue;
            if (!touchesItem(playerOriginQ3, item.origin)) continue;
            if (!canBeGrabbed(item.def, inventory)) continue;

            const event = give(item, inventory);

            item.present = false;
            item.respawnAt = this.time + respawnSeconds(item.def);

            events.push(event);
        }

        return events;
    }

    /**
     * `ClientTimerActions`: bleed off health and armour above max, one point a
     * second each.
     *
     * Called on a one-second cadence by the caller rather than every frame,
     * because Q3's is a 1000 ms timer and doing it per-frame would drain a
     * 200-health player in three seconds at 60 fps.
     */
    static tickSecond(inventory: Inventory): void {
        if (inventory.health > inventory.maxHealth) inventory.health -= 1;
        if (inventory.armor > inventory.maxHealth) inventory.armor -= 1;
    }

    /** Simulation clock, in seconds. Powerup expiry is measured against this. */
    get now(): number {
        return this.time;
    }
}

/**
 * `BG_PlayerTouchesItem`, verbatim including the asymmetric X test.
 *
 * The player's origin is at its centre and an item's is 15 units above the
 * floor, so the Z test is what makes a pickup reachable by walking rather than
 * only by standing on it.
 */
export function touchesItem(player: ArrayLike<number>, item: ArrayLike<number>): boolean {
    const dx = player[0]! - item[0]!;
    const dy = player[1]! - item[1]!;
    const dz = player[2]! - item[2]!;

    return !(dx > 44 || dx < -50 || dy > 36 || dy < -36 || dz > 36 || dz < -36);
}

/** `BG_CanItemBeGrabbed`. */
export function canBeGrabbed(def: ItemDef, inv: Inventory): boolean {
    switch (def.type) {
        case 'IT_WEAPON':
            return true;

        case 'IT_AMMO':
            return (inv.ammo[def.tag] ?? 0) < MAX_AMMO;

        case 'IT_ARMOR':
            return inv.armor < inv.maxHealth * 2;

        case 'IT_HEALTH':
            // Identified by quantity, not by a flag. 5 is the shard-equivalent
            // and 100 is mega health; both are allowed past max.
            if (def.quantity === 5 || def.quantity === 100) {
                return inv.health < inv.maxHealth * 2;
            }
            return inv.health < inv.maxHealth;

        case 'IT_POWERUP':
        case 'IT_HOLDABLE':
        case 'IT_PERSISTANT_POWERUP':
            return true;

        default:
            // IT_TEAM is flags and domination points -- no deathmatch meaning.
            return false;
    }
}

/** `RespawnItem`'s delay, by type. */
export function respawnSeconds(def: ItemDef): number {
    const r = balance.respawn;

    switch (def.type) {
        case 'IT_WEAPON':
            return WEAPON_RESPAWN_SECONDS;
        case 'IT_AMMO':
            return r.ammoSeconds;
        case 'IT_ARMOR':
            return r.armorSeconds;
        case 'IT_HEALTH':
            return def.quantity === 100 ? r.megaHealthSeconds : r.healthSeconds;
        case 'IT_HOLDABLE':
            return r.holdableSeconds;
        case 'IT_POWERUP':
        case 'IT_PERSISTANT_POWERUP':
            return r.powerupSeconds;
        default:
            return r.healthSeconds;
    }
}

/** The `Pickup_*` family, collapsed into one switch. */
function give(item: ItemInstance, inv: Inventory): PickupEvent {
    const def = item.def;
    let selectWeapon: WeaponId | null = null;

    switch (def.type) {
        case 'IT_ARMOR': {
            inv.armor = Math.min(inv.armor + def.quantity, inv.maxHealth * 2);
            break;
        }

        case 'IT_HEALTH': {
            const max =
                def.quantity === 5 || def.quantity === 100 ? inv.maxHealth * 2 : inv.maxHealth;
            inv.health = Math.min(inv.health + def.quantity, max);
            break;
        }

        case 'IT_WEAPON': {
            inv.weapons.add(def.tag);
            addAmmo(inv, def.tag, def.quantity);
            /*
             `CG_ItemPickup`: autoswitch is on by default and deliberately
             excludes the machinegun, so picking up ammo for the weapon you
             already start with does not yank you off a railgun.

             And never to a weapon outside `balance.weapons`, which is not a Q3
             rule but a consequence of this port implementing eleven of OA's
             thirteen weapon pickups: a nailgun in the hands has no fire rate to
             count down and no damage to deal, and every read of its stats is a
             read of `undefined`. Q3 has no such weapon and so has nothing to say
             about this case.
            */
            if (def.tag !== 'WP_MACHINEGUN' && isWeaponId(def.tag)) selectWeapon = def.tag;
            break;
        }

        case 'IT_AMMO': {
            addAmmo(inv, def.tag, def.quantity);
            break;
        }

        case 'IT_HOLDABLE': {
            inv.holdable = def.tag;
            break;
        }

        case 'IT_POWERUP':
        case 'IT_PERSISTANT_POWERUP': {
            // `Pickup_Powerup`: quantity is a duration in seconds, and picking
            // one up while it is running extends rather than restarts it.
            const existing = inv.powerups.get(def.tag) ?? 0;
            inv.powerups.set(def.tag, Math.max(existing, 0) + def.quantity);
            break;
        }

        default:
            break;
    }

    return { item, label: def.pickupName, selectWeapon };
}

function addAmmo(inv: Inventory, weapon: string, count: number): void {
    if (count <= 0) return;

    const current = inv.ammo[weapon] ?? 0;
    if (current < 0) return; // infinite stays infinite

    inv.ammo[weapon] = Math.min(current + count, MAX_AMMO);
}
