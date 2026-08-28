/*
 * items.test.ts -- the pickup rules, including the ones that look like typos.
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
 * There is no C oracle for this the way there is for movement -- `g_items.c`
 * runs inside the game VM and dragging that into Emscripten would mean dragging
 * in the entity system, the server and the trap layer. So these tests are
 * written against the *source*, quoting the rule each one pins, and the
 * numbers all come from the generated balance table rather than from here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    ItemSystem,
    canBeGrabbed,
    itemByClassname,
    newInventory,
    respawnSeconds,
    touchesItem,
    MAX_AMMO,
    ITEM_RADIUS,
    type ItemDef,
} from '../src/game/Items.ts';
import { isWeaponId, weaponStats } from '../src/game/Weapons.ts';
import balance from '../src/game/balance.generated.json' with { type: 'json' };
import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { boxTrace, createTrace } from '../src/q3/cm/trace.ts';

function def(classname: string): ItemDef {
    const found = itemByClassname(classname);
    if (found === null) throw new Error(`no such item: ${classname}`);
    return found;
}

describe('BG_PlayerTouchesItem', () => {
    it('is asymmetric on X and symmetric on Y and Z', () => {
        const item = [0, 0, 0];

        // `ps->origin[0] - origin[0] > 44 || ... < -50`
        expect(touchesItem([44, 0, 0], item)).toBe(true);
        expect(touchesItem([45, 0, 0], item)).toBe(false);
        expect(touchesItem([-50, 0, 0], item)).toBe(true);
        expect(touchesItem([-51, 0, 0], item)).toBe(false);

        for (const axis of [1, 2]) {
            const near = [0, 0, 0];
            const far = [0, 0, 0];
            near[axis] = 36;
            far[axis] = 37;
            expect(touchesItem(near, item)).toBe(true);
            expect(touchesItem(far, item)).toBe(false);

            near[axis] = -36;
            far[axis] = -37;
            expect(touchesItem(near, item)).toBe(true);
            expect(touchesItem(far, item)).toBe(false);
        }
    });

    it('reaches an item resting on the same floor the player stands on', () => {
        // Player origin is 24 above its feet; a dropped item's is ITEM_RADIUS.
        const floor = 100;
        expect(touchesItem([0, 0, floor + 24], [0, 0, floor + ITEM_RADIUS])).toBe(true);
    });
});

describe('BG_CanItemBeGrabbed', () => {
    it('lets 5-health and mega health past max, and nothing else', () => {
        const inv = newInventory();
        inv.health = inv.maxHealth;

        expect(canBeGrabbed(def('item_health_small'), inv)).toBe(true);
        expect(canBeGrabbed(def('item_health_mega'), inv)).toBe(true);
        expect(canBeGrabbed(def('item_health'), inv)).toBe(false);
        expect(canBeGrabbed(def('item_health_large'), inv)).toBe(false);

        inv.health = inv.maxHealth * 2;
        expect(canBeGrabbed(def('item_health_small'), inv)).toBe(false);
        expect(canBeGrabbed(def('item_health_mega'), inv)).toBe(false);
    });

    it('caps armour at twice max health and ammo at 200', () => {
        const inv = newInventory();

        inv.armor = inv.maxHealth * 2 - 1;
        expect(canBeGrabbed(def('item_armor_shard'), inv)).toBe(true);
        inv.armor = inv.maxHealth * 2;
        expect(canBeGrabbed(def('item_armor_shard'), inv)).toBe(false);

        inv.ammo['WP_ROCKET_LAUNCHER'] = MAX_AMMO - 1;
        expect(canBeGrabbed(def('ammo_rockets'), inv)).toBe(true);
        inv.ammo['WP_ROCKET_LAUNCHER'] = MAX_AMMO;
        expect(canBeGrabbed(def('ammo_rockets'), inv)).toBe(false);
    });

    it('always takes a weapon, even one already held with full ammo', () => {
        const inv = newInventory();
        inv.weapons.add('WP_ROCKET_LAUNCHER');
        inv.ammo['WP_ROCKET_LAUNCHER'] = MAX_AMMO;

        expect(canBeGrabbed(def('weapon_rocketlauncher'), inv)).toBe(true);
    });
});

describe('respawn times', () => {
    it('match RESPAWN_* and g_weaponrespawn', () => {
        expect(respawnSeconds(def('item_armor_combat'))).toBe(25);
        expect(respawnSeconds(def('item_health'))).toBe(35);
        expect(respawnSeconds(def('item_health_mega'))).toBe(35);
        expect(respawnSeconds(def('ammo_rockets'))).toBe(40);
        expect(respawnSeconds(def('holdable_teleporter'))).toBe(60);
        expect(respawnSeconds(def('item_quad'))).toBe(120);
        expect(respawnSeconds(def('weapon_railgun'))).toBe(5);
    });
});

describe('pickup', () => {
    const trace = () => ({ fraction: 0.5, endpos: [0, 0, 0], startsolid: false });

    function oneItem(classname: string): ItemSystem {
        const system = new ItemSystem();
        system.spawn([{ classname, _originQ3: [0, 0, 0], spawnflags: 1 }], trace);
        expect(system.items).toHaveLength(1);
        return system;
    }

    it('gives, hides and respawns on the item type\'s own clock', () => {
        const system = oneItem('item_armor_combat');
        const inv = newInventory();

        const events = system.update(1 / 60, [0, 0, 0], inv, true);
        expect(events).toHaveLength(1);
        expect(events[0]!.label).toBe('Armor');
        expect(inv.armor).toBe(50);
        expect(system.items[0]!.present).toBe(false);

        // Not back after 24 seconds; back after 25.
        system.update(24, [1000, 0, 0], inv, true);
        expect(system.items[0]!.present).toBe(false);
        system.update(1.1, [1000, 0, 0], inv, true);
        expect(system.items[0]!.present).toBe(true);
    });

    it('clamps armour, health and ammo the way the Pickup_* functions do', () => {
        const inv = newInventory();

        inv.armor = 190;
        oneItem('item_armor_combat').update(0.1, [0, 0, 0], inv, true);
        expect(inv.armor).toBe(200);

        inv.health = 195;
        oneItem('item_health_mega').update(0.1, [0, 0, 0], inv, true);
        expect(inv.health).toBe(200);

        inv.ammo['WP_ROCKET_LAUNCHER'] = 199;
        oneItem('ammo_rockets').update(0.1, [0, 0, 0], inv, true);
        expect(inv.ammo['WP_ROCKET_LAUNCHER']).toBe(MAX_AMMO);
    });

    it('autoswitches to a picked-up weapon, but never to the machinegun', () => {
        const inv = newInventory();

        const rocket = oneItem('weapon_rocketlauncher').update(0.1, [0, 0, 0], inv, true);
        expect(rocket[0]!.selectWeapon).toBe('WP_ROCKET_LAUNCHER');
        expect(inv.weapons.has('WP_ROCKET_LAUNCHER')).toBe(true);

        const machinegun = oneItem('weapon_machinegun').update(0.1, [0, 0, 0], inv, true);
        expect(machinegun[0]!.selectWeapon).toBe(null);
    });

    it('never autoswitches to a weapon outside the balance table', () => {
        const inv = newInventory();

        /*
         The grappling hook, which is now the *only* `IT_WEAPON` tag with no
         `balance.weapons` entry. It is not a damage weapon -- no fire rate worth
         the name, no damage, no splash -- so there is nothing in `g_weapon.c`
         for `extract-balance.mjs` to read and nothing for `WeaponSystem.fire` to
         do with it; it is a movement device wearing a weapon's slot.

         This case used to be the nailgun, which had no entry for a different
         reason and does now: its numbers were in the C all along in a shape
         `projectile()` could not read, and D-119 is that extraction. What
         survives is the rule, and it needs a live instance to be a test.
        */
        const hook = oneItem('weapon_grapplinghook').update(0.1, [0, 0, 0], inv, true);

        expect(hook[0]!.selectWeapon).toBe(null);

        // Picked up all the same: `Pickup_Weapon` gives it, and the ammo with it.
        expect(inv.weapons.has('WP_GRAPPLING_HOOK')).toBe(true);
    });

    it('autoswitches to the nailgun, now that there is a nailgun to switch to', () => {
        const inv = newInventory();

        /*
         `am_thornish` places two of them, and walking over one used to leave you
         holding whatever you had -- the pickup was refused a switch because
         `balance.weapons` had no nailgun. The visible symptom was that the
         weapon never appeared in your hands, which is what it was reported as.
        */
        const nailgun = oneItem('weapon_nailgun').update(0.1, [0, 0, 0], inv, true);

        expect(nailgun[0]!.label).toBe('Nailgun');
        expect(nailgun[0]!.selectWeapon).toBe('WP_NAILGUN');

        expect(inv.weapons.has('WP_NAILGUN')).toBe(true);
        expect(inv.ammo['WP_NAILGUN']).toBe(10);
    });

    it('offers no pickup the weapon table cannot answer for', () => {
        /*
         The rule rather than the two instances of it: any `IT_WEAPON` this port
         can be switched to must have stats, so a future weapon arriving in the
         item table fails here rather than in the middle of a match.
        */
        const weapons = (balance.items as readonly ItemDef[]).filter(
            (item) => item.type === 'IT_WEAPON'
        );
        expect(weapons.length).toBeGreaterThan(11);

        for (const item of weapons) {
            const inv = newInventory();
            const [event] = oneItem(item.classname).update(0.1, [0, 0, 0], inv, true);

            const selected = event?.selectWeapon ?? null;
            if (selected === null) continue;

            expect(isWeaponId(selected), `${item.classname} is selectable`).toBe(true);
            expect(weaponStats(selected).fireRateMs).toBeGreaterThan(0);
        }
    });

    it('does not pick up while dead', () => {
        const system = oneItem('item_health');
        const inv = newInventory();
        inv.health = 0;

        expect(system.update(0.1, [0, 0, 0], inv, false)).toHaveLength(0);
        expect(system.items[0]!.present).toBe(true);
    });

    it('bleeds health and armour down to max, one point a second', () => {
        const inv = newInventory();
        inv.health = 200;
        inv.armor = 150;

        for (let i = 0; i < 200; i++) ItemSystem.tickSecond(inv);

        expect(inv.health).toBe(inv.maxHealth);
        expect(inv.armor).toBe(inv.maxHealth);
    });
});

/*
 The one integration test: every item on a real map lands on a real surface.
 Cheap, and it is the failure the rest of the suite cannot see -- a sign error
 in the drop trace leaves every pickup buried in the floor while every unit test
 still passes.
*/
describe('FinishSpawningItem on a converted map', () => {
    for (const mapName of ['oa_dm1', 'aggressor']) {
        it(`places every item on a surface [${mapName}]`, () => {
            const built = join(process.cwd(), 'assets', 'built', mapName);
            const raw = readFileSync(join(built, 'collision.bsp'));
            const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
                entities: { classname?: string; _originQ3: number[] }[];
            };

            const cm = new ClipMap(
                new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
            );

            const system = new ItemSystem();
            system.spawn(scene.entities, (start, mins, maxs, end, mask) => {
                const out = createTrace();
                boxTrace(out, cm, start, end, mins, maxs, mask);
                return out;
            });

            expect(system.items.length).toBeGreaterThan(20);
            expect(system.rejected).toEqual([]);

            /*
             `oa_dm1` hangs its mega health in the air on spawnflag 1, which is
             exactly the case the drop trace must *not* apply. Asserting the
             suspended item survives keeps this test honest: without it, a
             `spawn` that dropped everything unconditionally would still pass --
             on `oa_dm1` only, because `aggressor` has no suspended items and
             the same assertion there would be testing the map, not the code.
            */
            if (mapName === 'oa_dm1') {
                const suspended = system.items.filter((i) => i.suspended);
                expect(suspended.map((i) => i.def.classname)).toEqual(['item_health_mega']);
                expect(suspended[0]!.origin).toEqual([232, 1600, -112]);
            }

            for (const item of system.items) {
                if (item.suspended) continue;

                // Resting on something means a downward trace of one unit is blocked.
                const out = createTrace();
                boxTrace(
                    out,
                    cm,
                    item.origin,
                    [item.origin[0], item.origin[1], item.origin[2] - 1],
                    [-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS],
                    [ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS],
                    1 /* CONTENTS_SOLID */
                );
                expect(out.fraction, `${item.def.classname} at ${item.origin.join(' ')}`).toBeLessThan(1);
            }
        });
    }
});
