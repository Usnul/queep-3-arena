/*
 * status-bar.test.ts -- the HUD's arithmetic, without a HUD.
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
 * `statusBar.ts` exists so that "where is this bar full" and "when does this
 * number go red" can be checked against Q3 rather than eyeballed in a running
 * game, and this is the checking. Three things it is actually for:
 *
 *   - **A scale that makes a full gun look empty.** The whole reason the ammo
 *     bar is scaled per weapon is that `MAX_AMMO` is 200 for everything and a
 *     rocket launcher holding every rocket on the map would draw at 5%. A
 *     regression here is silent -- the bar still moves, it just stops meaning
 *     anything.
 *   - **A threshold that is not Q3's.** `ammoIsLow` is `CG_CheckAmmo`'s own
 *     prices, and the temptation with a number like that is to round it to
 *     something tidy.
 *   - **An icon path that resolves.** The runtime builds it by slicing the
 *     balance table's field; `convert-fx.ts` builds the file name the same way
 *     from the same field. If either side stops agreeing, the HUD draws nothing
 *     and says nothing about it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
    ammoFull,
    ammoIsInfinite,
    ammoIsLow,
    LOW_HEALTH,
    POOL_MAX,
    weaponIcon,
    weaponLabel,
} from '../src/client/statusBar.ts';
import { MAX_AMMO, MAX_HEALTH } from '../src/game/Items.ts';
import balance from '../src/game/balance.generated.json' with { type: 'json' };

/** Every `WP_*` the balance table knows, which is what the HUD can be handed. */
const WEAPONS = Object.keys(balance.weapons);

describe('where the bars are full', () => {
    it('runs health and armour off one ceiling, which is the one the game clamps to', () => {
        // `bg_misc.c`: armour stops at `maxHealth * 2`, and so does mega health.
        expect(POOL_MAX).toBe(MAX_HEALTH * 2);
    });

    it('scales the ammo bar by what Q3 hands you, weapon by weapon', () => {
        /*
         Every one of these is a row of `bg_itemlist` or a line of `ClientSpawn`,
         and the interesting one is the machinegun: its own pickup carries 40 and
         a box of bullets 50, but you spawn holding 100, so a bar full at 50
         would sit pinned for the whole first fight of every match.
        */
        expect(ammoFull('WP_ROCKET_LAUNCHER')).toBe(10);
        expect(ammoFull('WP_GRENADE_LAUNCHER')).toBe(10);
        expect(ammoFull('WP_RAILGUN')).toBe(10);
        expect(ammoFull('WP_SHOTGUN')).toBe(10);
        expect(ammoFull('WP_MACHINEGUN')).toBe(100);
        expect(ammoFull('WP_PLASMAGUN')).toBe(50);
        expect(ammoFull('WP_LIGHTNING')).toBe(100);
        expect(ammoFull('WP_BFG')).toBe(20);
        expect(ammoFull('WP_CHAINGUN')).toBe(100);
        expect(ammoFull('WP_NAILGUN')).toBe(20);
        expect(ammoFull('WP_PROX_LAUNCHER')).toBe(10);
    });

    it('falls back only for a weapon that has no ammunition at all', () => {
        // The gauntlet: no load of its own, no box that feeds it, and `-1` at
        // spawn. Its bar is never drawn, so what the fallback answers matters
        // less than that it answers a number a bar can be built from.
        expect(ammoFull('WP_GAUNTLET')).toBe(MAX_AMMO);
        expect(ammoFull('WP_NOT_A_WEAPON')).toBe(MAX_AMMO);
    });

    it('gives every weapon in the table a scale a bar can use', () => {
        for (const weapon of WEAPONS) {
            const full = ammoFull(weapon);

            expect(Number.isInteger(full), `${weapon} full load is not whole`).toBe(true);
            expect(full, `${weapon} full load`).toBeGreaterThan(0);
            expect(full, `${weapon} full load`).toBeLessThanOrEqual(MAX_AMMO);
        }
    });
});

describe('when a readout goes red', () => {
    it('flashes health at 25 and below, as the four-way branch does', () => {
        // `CG_DrawStatusBar`: white above 100, orange above 25, flashing from 25
        // down. 25 itself is in the flashing arm -- the branch above it is
        // `value > 25`.
        expect(LOW_HEALTH).toBe(25);
    });

    it("prices a round at CG_CheckAmmo's own rates", () => {
        /*
         The C sums `rounds * 1000` for the heavy weapons and `rounds * 200` for
         everything else, and warns below 5000. Five rockets and twenty-five
         bullets are the same amount of fight, and both are the first count that
         is *not* low.
        */
        expect(ammoIsLow('WP_ROCKET_LAUNCHER', 5)).toBe(false);
        expect(ammoIsLow('WP_ROCKET_LAUNCHER', 4)).toBe(true);

        expect(ammoIsLow('WP_MACHINEGUN', 25)).toBe(false);
        expect(ammoIsLow('WP_MACHINEGUN', 24)).toBe(true);

        // Shotgun and prox are priced with the rockets; the plasma gun is not.
        expect(ammoIsLow('WP_SHOTGUN', 5)).toBe(false);
        expect(ammoIsLow('WP_PROX_LAUNCHER', 5)).toBe(false);
        expect(ammoIsLow('WP_PLASMAGUN', 5)).toBe(true);
    });

    it('never calls an infinite supply low, and always calls an empty one low', () => {
        expect(ammoIsInfinite(-1)).toBe(true);
        expect(ammoIsInfinite(0)).toBe(false);

        expect(ammoIsLow('WP_GAUNTLET', -1)).toBe(false);

        for (const weapon of WEAPONS) {
            expect(ammoIsLow(weapon, 0), `${weapon} at zero`).toBe(true);
        }
    });
});

describe('the weapon icon', () => {
    it('resolves every weapon the balance table can hand the HUD', () => {
        const built = join(process.cwd(), 'assets', 'built');

        for (const weapon of WEAPONS) {
            const icon = weaponIcon(weapon);

            expect(icon, `${weapon} has no icon`).not.toBeNull();
            expect(icon).toMatch(/^\/assets\/built\/fx\/iconw_[a-z]+\.png$/);

            const path = join(built, icon!.replace('/assets/built/', ''));

            expect(existsSync(path), `${icon} is drawn by the HUD and absent`).toBe(true);
        }
    });

    it('answers nothing for an id with no weapon entry, rather than a broken URL', () => {
        expect(weaponIcon('WP_NOT_A_WEAPON')).toBeNull();
    });

    it('names a weapon in something other than screaming snake case', () => {
        expect(weaponLabel('WP_ROCKET_LAUNCHER')).toBe('rocket launcher');
        expect(weaponLabel('WP_BFG')).toBe('bfg');
    });
});
