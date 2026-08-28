/*
 * extract-balance.mjs -- lift Quake III's balance numbers out of the C.
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
 * The brief keeps balance faithful, so these numbers are *extracted* rather than
 * transcribed: `bg_itemlist` alone is ~60 entries of nine fields each, and a
 * hand-copied table is wrong the first time somebody edits it.
 *
 * Two sources:
 *
 * - `bg_misc.c`'s `bg_itemlist[]` -- every pickup: classname, quantity, type,
 *   tag, and the model/icon paths the asset pipeline needs.
 * - `g_weapon.c`, `g_missile.c`, `bg_pmove.c` and `g_items.c` -- damage, splash,
 *   projectile speed, fire rate and respawn times, each pulled by a named regex
 *   scoped to a named function, so a match cannot silently attach to the wrong
 *   weapon.
 *
 * Output: `src/game/balance.generated.json`, which *is* committed -- it derives
 * from GPLv2 sources, it is small, and the runtime should not depend on `.refs/`
 * being present. `--check` fails if it is stale.
 *
 * Usage:  node tools/extract-balance.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, '.refs', 'oa-gamecode', 'code', 'game');

/**
 * The client game, which is where the *presentation* numbers live.
 *
 * One thing is read from here and it is a list of model paths:
 * `CG_RegisterWeapon` is the only statement in Q3 of what a missile in flight
 * looks like, and a path
 * is exactly the kind of string this tool exists to stop being retyped -- the
 * asset pipeline has to convert the file and the runtime has to name the same
 * one, and a typo in either is a projectile that silently does not draw.
 */
const CGAME = join(ROOT, '.refs', 'oa-gamecode', 'code', 'cgame');
const BG_PUBLIC = join(GAME, 'bg_public.h');
const OUT = join(ROOT, 'src', 'game', 'balance.generated.json');

function read(file) {
    return readFileSync(join(GAME, file), 'latin1');
}

function readCgame(file) {
    return readFileSync(join(CGAME, file), 'latin1');
}

/**
 * Split a brace-balanced C initialiser list into its top-level elements.
 *
 * Hand-written rather than a regex because `gitem_t` contains a nested `{ ... }`
 * for `world_model[]`, and a regex that handles one level of nesting is a regex
 * that will handle two levels wrong later.
 */
function splitInitialisers(body) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;

    for (let i = 0; i < body.length; i++) {
        const c = body[i];

        if (inString) {
            if (c === '\\') i += 1;
            else if (c === '"') inString = false;
            continue;
        }

        if (c === '"') {
            inString = true;
            continue;
        }

        if (c === '{') {
            if (depth === 0) start = i + 1;
            depth += 1;
        } else if (c === '}') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                out.push(body.slice(start, i));
                start = -1;
            }
        }
    }

    return out;
}

/** Split one initialiser on top-level commas, ignoring braces and strings. */
function splitFields(text) {
    const out = [];
    let depth = 0;
    let inString = false;
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const c = text[i];

        if (inString) {
            current += c;
            if (c === '\\') {
                current += text[i + 1];
                i += 1;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }

        if (c === '"') {
            inString = true;
            current += c;
        } else if (c === '{') {
            depth += 1;
            current += c;
        } else if (c === '}') {
            depth -= 1;
            current += c;
        } else if (c === ',' && depth === 0) {
            out.push(current);
            current = '';
        } else {
            current += c;
        }
    }

    if (current.trim() !== '') out.push(current);

    return out;
}

function stripComments(field) {
    return field.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
}

/** Read a C string literal, or `null` for NULL. Adjacent literals concatenate. */
function cleanString(field) {
    const t = stripComments(field);
    if (t === 'NULL' || t === '' || t === '0') return null;

    const parts = [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    return parts.length === 0 ? null : parts.join('');
}

function extractItems() {
    const src = read('bg_misc.c');

    const start = src.indexOf('bg_itemlist[] =');
    if (start === -1) throw new Error('bg_misc.c: could not find bg_itemlist[]');

    const open = src.indexOf('{', start);
    const end = src.indexOf('\n};', open);
    if (end === -1) throw new Error('bg_misc.c: could not find the end of bg_itemlist[]');

    const items = [];

    // `open + 1`: the slice must start *inside* the array's own brace, or the
    // depth counter treats every entry as nested and finds none.
    for (const entry of splitInitialisers(src.slice(open + 1, end))) {
        const f = splitFields(entry);
        if (f.length < 9) continue;

        const classname = cleanString(f[0]);
        // The leading placeholder and the terminator both have a NULL classname.
        if (classname === null) continue;

        items.push({
            classname,
            pickupSound: cleanString(f[1]),
            models: splitFields(stripComments(f[2]).replace(/^\{|\}$/g, ''))
                .map(cleanString)
                .filter((m) => m !== null),
            icon: cleanString(f[3]),
            pickupName: cleanString(f[4]),
            quantity: Number.parseInt(stripComments(f[5]), 10) || 0,
            type: stripComments(f[6]),
            tag: stripComments(f[7]),
        });
    }

    return items;
}

/**
 * Pull `<something> = <number>` from inside a named C function.
 *
 * Every occurrence of the name is tried, not just the first: a name appears at
 * its prototype and at call sites before it appears at its definition, and
 * anchoring on the first hit silently searches the wrong region -- which is
 * exactly what this did until `Weapon_Gauntlet` failed to find its own damage.
 * Each candidate body runs from its opening brace to the next `}` at column
 * zero; the first body that matches wins.
 */
function fromFunction(src, fnName, pattern, label) {
    let from = 0;
    let seen = 0;

    for (;;) {
        const at = src.indexOf(fnName, from);
        if (at === -1) break;
        from = at + fnName.length;
        seen += 1;

        const open = src.indexOf('{', at);
        if (open === -1) continue;

        // A prototype ends in `;` before reaching any brace.
        const semi = src.indexOf(';', at);
        if (semi !== -1 && semi < open) continue;

        const close = src.indexOf('\n}', open);
        const body = src.slice(open, close === -1 ? src.length : close);

        const m = body.match(pattern);
        if (m !== null) return Number.parseFloat(m[1]);
    }

    throw new Error(
        `${label}: ${pattern} not found in any of the ${seen} occurrence(s) of ${fnName}`
    );
}

function define(src, name, where) {
    const m = src.match(new RegExp(`#define\\s+${name}\\s+([0-9.]+)`));
    if (m === null) throw new Error(`#define ${name} not found in ${where}`);
    return Number.parseFloat(m[1]);
}

function projectile(missile, fnName) {
    return {
        hitscan: false,
        damage: fromFunction(missile, fnName, /bolt->damage = (\d+)/, fnName),
        splashDamage: fromFunction(missile, fnName, /bolt->splashDamage = (\d+)/, fnName),
        splashRadius: fromFunction(missile, fnName, /bolt->splashRadius = (\d+)/, fnName),
        speed: fromFunction(missile, fnName, /VectorScale\( *dir, *(\d+)/, fnName),
    };
}

/**
 * `weapon_t`, in order, from `bg_public.h`.
 *
 * The order is load-bearing and is not the order of anything else in this file:
 * it is what the mouse wheel cycles and what `weapon 1`..`weapon 13` select, so
 * a Q3 player knows it by muscle memory. `WP_NONE` and the two sentinels at the
 * bottom are dropped; everything between them is a weapon, including the three
 * `balance.weapons` has no numbers for.
 */
function extractWeaponOrder() {
    const src = readFileSync(BG_PUBLIC, 'latin1');

    const m = /WP_NONE\s*,([\s\S]*?)WP_NUM_WEAPONS/.exec(src);
    if (m === null) throw new Error('the weapon_t enum was not found in bg_public.h');

    const names = [...m[1].matchAll(/\bWP_[A-Z_]+\b/g)].map((x) => x[0]);

    if (names.length < 9) throw new Error(`only ${names.length} weapons in weapon_t`);

    return names;
}

/**
 * `CG_RegisterWeapon`'s `missileModel`, per weapon, from `cg_weapons.c`.
 *
 * The whole of what Q3 says a projectile looks like in flight is one line inside
 * a `case WP_*:` of that function, and this reads exactly those lines. Scoped to
 * the case rather than searched file-wide for the reason every other regex here
 * is scoped to a named function: there are seven of these lines and a file-wide
 * match would attach whichever came first to whichever weapon asked.
 *
 * Absence is a real answer and is recorded as one. The plasma gun's line is
 * *commented out* in the C -- `CG_Missile` draws it as an `RT_SPRITE` with
 * `plasmaBallShader` instead, which is the only weapon handled that way -- and
 * the gauntlet, machinegun, shotgun, lightning gun and railgun fire nothing that
 * flies. Every one of those comes back `null` rather than being omitted, so the
 * runtime table is total over the weapon list and a weapon that gains a model
 * later shows up as a diff here rather than as a lookup that quietly misses.
 */
function extractMissileModels(weaponNames) {
    const src = readCgame('cg_weapons.c');

    const at = src.indexOf('void CG_RegisterWeapon');
    if (at === -1) throw new Error('CG_RegisterWeapon not found in cg_weapons.c');

    const out = {};

    for (const name of weaponNames) {
        /*
         From this weapon's `case` label to the next one, so a model registered
         under `WP_ROCKET_LAUNCHER` cannot be read as the prox launcher's. The
         `[^\n]*` on the case line is `//#ifdef MISSIONPACK` and friends; the
         terminator is the next `case WP_` or the `default:` at the bottom.
        */
        const block = new RegExp(
            `case\\s+${name}\\s*:[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*(?://[^\\n]*\\n\\s*)?(?:case\\s+WP_|default\\s*:))`
        ).exec(src.slice(at));

        if (block === null) throw new Error(`no case ${name} in CG_RegisterWeapon`);

        /*
         Deliberately not multiline-anchored past a `//`: the plasma gun's line
         is `//\t\tweaponInfo->missileModel = ...`, and reading it would give the
         plasma bolt a model Q3 does not draw.
        */
        const model = /^[ \t]*weaponInfo->missileModel\s*=\s*trap_R_RegisterModel\(\s*"([^"]+)"/m.exec(
            block[1]
        );

        out[name] = model === null ? null : model[1].replace(/\\/g, '/');
    }

    return out;
}

function extractWeapons() {
    const weapon = read('g_weapon.c');
    const missile = read('g_missile.c');
    const pmove = read('bg_pmove.c');
    const bgPublic = readFileSync(BG_PUBLIC, 'latin1');

    /** Fire rates live in `PM_Weapon`'s `addTime` switch. */
    const fireRate = (weaponName) => {
        const re = new RegExp(`case\\s+${weaponName}\\s*:[\\s\\S]{0,200}?addTime\\s*=\\s*(\\d+)`);
        const m = pmove.match(re);
        if (m === null) throw new Error(`fire rate for ${weaponName} not found in bg_pmove.c`);
        return Number.parseInt(m[1], 10);
    };

    const quadDamage = (fn, label) =>
        fromFunction(weapon, fn, /damage = (\d+) \* s_quadFactor/, label);

    return {
        WP_GAUNTLET: {
            hitscan: true,
            fireRateMs: fireRate('WP_GAUNTLET'),
            /*
             Not `Weapon_Gauntlet` -- that function is *empty* in OpenArena. The
             damage and the reach both live in `CheckGauntletAttack`, which
             `FireWeapon` calls instead. Scoping each regex to a named function is
             what surfaced this; a file-wide search would have matched some other
             weapon's damage and produced a plausible wrong number.
            */
            damage: quadDamage('CheckGauntletAttack', 'gauntlet'),
            range: fromFunction(
                weapon, 'CheckGauntletAttack', /VectorMA \(muzzle, (\d+), forward, end\)/, 'gauntlet range'
            ),
        },
        WP_MACHINEGUN: {
            hitscan: true,
            fireRateMs: fireRate('WP_MACHINEGUN'),
            damage: define(weapon, 'MACHINEGUN_DAMAGE', 'g_weapon.c'),
            teamDamage: define(weapon, 'MACHINEGUN_TEAM_DAMAGE', 'g_weapon.c'),
            spread: define(weapon, 'MACHINEGUN_SPREAD', 'g_weapon.c'),
        },
        WP_SHOTGUN: {
            hitscan: true,
            fireRateMs: fireRate('WP_SHOTGUN'),
            damage: define(weapon, 'DEFAULT_SHOTGUN_DAMAGE', 'g_weapon.c'),
            pellets: define(bgPublic, 'DEFAULT_SHOTGUN_COUNT', 'bg_public.h'),
            spread: define(bgPublic, 'DEFAULT_SHOTGUN_SPREAD', 'bg_public.h'),
        },
        WP_GRENADE_LAUNCHER: {
            fireRateMs: fireRate('WP_GRENADE_LAUNCHER'),
            ...projectile(missile, 'fire_grenade'),
        },
        WP_ROCKET_LAUNCHER: {
            fireRateMs: fireRate('WP_ROCKET_LAUNCHER'),
            ...projectile(missile, 'fire_rocket'),
        },
        WP_LIGHTNING: {
            hitscan: true,
            fireRateMs: fireRate('WP_LIGHTNING'),
            damage: quadDamage('Weapon_LightningFire', 'lightning'),
            // `Weapon_LightningFire` uses the symbol, not a literal.
            range: define(bgPublic, 'LIGHTNING_RANGE', 'bg_public.h'),
        },
        WP_RAILGUN: {
            hitscan: true,
            fireRateMs: fireRate('WP_RAILGUN'),
            damage: quadDamage('weapon_railgun_fire', 'railgun'),
        },
        WP_PLASMAGUN: {
            fireRateMs: fireRate('WP_PLASMAGUN'),
            ...projectile(missile, 'fire_plasma'),
        },
        WP_BFG: {
            fireRateMs: fireRate('WP_BFG'),
            ...projectile(missile, 'fire_bfg'),
        },
        WP_CHAINGUN: {
            hitscan: true,
            fireRateMs: fireRate('WP_CHAINGUN'),
            damage: define(weapon, 'MACHINEGUN_DAMAGE', 'g_weapon.c'),
            spread: define(weapon, 'CHAINGUN_SPREAD', 'g_weapon.c'),
        },
        WP_PROX_LAUNCHER: {
            fireRateMs: fireRate('WP_PROX_LAUNCHER'),
            ...projectile(missile, 'fire_prox'),
        },
    };
}

function extractRespawns() {
    const items = read('g_items.c');
    return {
        armorSeconds: define(items, 'RESPAWN_ARMOR', 'g_items.c'),
        healthSeconds: define(items, 'RESPAWN_HEALTH', 'g_items.c'),
        ammoSeconds: define(items, 'RESPAWN_AMMO', 'g_items.c'),
        holdableSeconds: define(items, 'RESPAWN_HOLDABLE', 'g_items.c'),
        megaHealthSeconds: define(items, 'RESPAWN_MEGAHEALTH', 'g_items.c'),
        powerupSeconds: define(items, 'RESPAWN_POWERUP', 'g_items.c'),
    };
}

function main() {
    const items = extractItems();
    const weapons = extractWeapons();
    const respawn = extractRespawns();
    const weaponOrder = extractWeaponOrder();
    const missileModels = extractMissileModels(weaponOrder);

    if (items.length < 30) {
        throw new Error(`only ${items.length} items extracted; the bg_itemlist parse is wrong`);
    }

    const json =
        JSON.stringify(
            {
                $generated: 'tools/extract-balance.mjs -- do not edit by hand',
                $source: 'OpenArena gamecode, pinned in tools/fetch-sources.mjs',
                items,
                weapons,
                respawn,
                weaponOrder,
                missileModels,
            },
            null,
            1
        ) + '\n';

    if (process.argv.includes('--check')) {
        if (readFileSync(OUT, 'utf8') !== json) {
            console.error(`${OUT} is stale; run: node tools/extract-balance.mjs`);
            process.exit(1);
        }
        console.error(`ok: ${items.length} items, ${Object.keys(weapons).length} weapons`);
        return;
    }

    writeFileSync(OUT, json);
    console.log(
        `wrote src/game/balance.generated.json: ` +
        `${items.length} items, ${Object.keys(weapons).length} weapons`
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
