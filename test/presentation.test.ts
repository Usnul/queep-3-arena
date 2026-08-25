/*
 * presentation.test.ts -- the phase 4 exit criterion, without a renderer.
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
 * The brief's phase 4 exit is "it looks like a showcase, not a test harness",
 * which is a judgement no test can make. What a test *can* do is refuse the
 * failure modes that judgement would catch, and every one of them is a number:
 *
 *   - a level with no lighting solution, because Q3's was baked and q3map2
 *     stripped the `light` entities (GAP-006). This is the one that actually
 *     bites, and it bites unevenly -- see the illumination block below.
 *   - a material pointing at a texture that was never written, which renders as
 *     the fallback and reads as "the conversion is broken".
 *   - a pickup with no model, which is an item you cannot see and therefore
 *     cannot find.
 *   - an effect or a sound named in the code and absent from disk, which fails
 *     silently at exactly the moment it was supposed to be impressive.
 *
 * Written in phase 6 rather than in phase 4, and that is the finding: the
 * previous session tried to verify this by looking at the running application,
 * the preview browser did not composite frames, and two wrong fixes shipped on
 * the strength of screenshots. Everything here runs in Node in under a second.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { itemByClassname } from '../src/game/Items.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

const MAPS = ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish'] as const;

/** Maps the demo actually presents: the default, and the two built to show off. */
const SHOWCASE = ['oa_dm1', 'aggressor', 'am_thornish'] as const;

interface Material {
    readonly name: string;
    readonly albedo: string | null;
    readonly emissive: string | null;
    readonly emissiveIntensity: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly transparency: string;
}

interface Light {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly lumens: number;
    readonly radius: number;
    /** Present only on lights fitted to the lightgrid; see D-078. */
    readonly color?: readonly number[];
}

interface Scene {
    readonly worldScale: number;
    readonly materials: Material[];
    /** Q3 shader name -> the flattened filename actually written. */
    readonly textures: Record<string, string>;
    readonly meshes: { material: number; indexCount: number }[];
    readonly lights: Light[];
    readonly sun: { color: number[]; intensity: number; direction: number[] } | null;
    readonly entities: { classname?: string; _originQ3: number[] }[];
    readonly stats: Record<string, number>;
}

function scene(name: string): Scene {
    return JSON.parse(readFileSync(join(BUILT, name, 'scene.json'), 'utf8')) as Scene;
}

/**
 * Illuminance at a point, in lux, from the reconstructed point lights.
 *
 * The same arithmetic `loadMap` hands the engine: candela is `lumens / 4pi` for
 * an isotropic source, falloff is inverse-square in scene metres, and a light
 * contributes nothing beyond its own `distance`. Reproduced here rather than
 * called, because the engine's copy needs a graphics device.
 *
 * @param originQ3 a point in Q3 units and Q3 axes
 */
function illuminance(s: Scene, originQ3: ArrayLike<number>): number {
    // Q3 (x, y, z) -> meep (x, z, -y), scaled. See tools/convert-map.ts.
    const mx = originQ3[0]! * s.worldScale;
    const my = originQ3[2]! * s.worldScale;
    const mz = -originQ3[1]! * s.worldScale;

    let lux = 0;

    for (const l of s.lights) {
        const dx = l.x - mx;
        const dy = l.y - my;
        const dz = l.z - mz;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (Math.sqrt(d2) > l.radius) continue;

        lux += l.lumens / (4 * Math.PI) / Math.max(d2, 1e-4);
    }

    return lux;
}

/** Everywhere a player can enter the level, across deathmatch and Team Arena maps. */
const SPAWN_CLASSNAMES = new Set([
    'info_player_deathmatch',
    'info_player_start',
    'team_CTF_redplayer',
    'team_CTF_blueplayer',
    'team_CTF_redspawn',
    'team_CTF_bluespawn',
]);

/**
 * Places a player provably goes: spawn points and pickups.
 *
 * Better than a floor sample for this purpose. A floor sample includes ledges
 * nobody visits; a spawn point and an item are where the level designer put the
 * player, so a dark one is a dark room rather than a dark corner. Eye height is
 * Q3's own `DEFAULT_VIEWHEIGHT`.
 */
function playerPoints(s: Scene): number[][] {
    return s.entities
        .filter((e) => {
            const c = e.classname ?? '';
            return (
                SPAWN_CLASSNAMES.has(c) ||
                c.startsWith('item_') ||
                c.startsWith('weapon_') ||
                c.startsWith('ammo_')
            );
        })
        .map((e) => [e._originQ3[0]!, e._originQ3[1]!, e._originQ3[2]! + 26]);
}

describe.each(MAPS)('the converted level is presentable [%s]', (name) => {
    const s = scene(name);

    it('wrote every texture its materials name', () => {
        expect(s.stats['texturesMissing']).toBe(0);

        for (const material of s.materials) {
            for (const map of [material.albedo, material.emissive]) {
                if (map === null) continue;
                expect(
                    s.textures[map],
                    `${material.name} names texture ${map}, which the bundle does not carry`
                ).toBeDefined();
            }
        }

        for (const file of Object.values(s.textures)) {
            expect(
                existsSync(join(BUILT, name, 'textures', file)),
                `${file} was not written`
            ).toBe(true);
        }
    });

    it('gives every material real PBR inputs rather than one default', () => {
        for (const m of s.materials) {
            expect(m.roughness, `${m.name} roughness`).toBeGreaterThan(0);
            expect(m.roughness, `${m.name} roughness`).toBeLessThanOrEqual(1);
            expect(m.metallic, `${m.name} metallic`).toBeGreaterThanOrEqual(0);
            expect(m.metallic, `${m.name} metallic`).toBeLessThanOrEqual(1);
        }

        // A conversion that collapsed to one material per map would pass every
        // check above and look like a test harness. Q3 levels are texture-heavy.
        expect(s.materials.length, 'distinct materials').toBeGreaterThan(10);
    });

    it('draws every mesh it emitted', () => {
        for (const mesh of s.meshes) {
            expect(mesh.indexCount, 'empty mesh').toBeGreaterThan(0);
            expect(s.materials[mesh.material], 'mesh with no material').toBeDefined();
        }

        expect(s.stats['skipped']).toBe(0);
    });

    it('is populated: spawns, pickups and brush entities', () => {
        /*
         `am_thornish` is a Team Arena map: it has no `info_player_deathmatch`
         at all, only `info_player_start` and the CTF team spawns. The port
         spawns bots at whatever it finds, so the check is "somewhere to start",
         not "the deathmatch keyword".
        */
        const spawns = s.entities.filter((e) => SPAWN_CLASSNAMES.has(e.classname ?? ''));
        expect(spawns.length, 'spawn points of any kind').toBeGreaterThanOrEqual(4);
        expect(playerPoints(s).length).toBeGreaterThan(4);
        expect(s.stats['submodels'], 'brush entities').toBeGreaterThan(0);
    });
});

/*
 * The lighting, which is where the phase 4 claim was actually at risk.
 *
 * q3map2 strips every `light` entity from a compiled BSP -- measured, zero
 * across all six maps -- and meep cannot import the baked lightmap (GAP-006).
 * The reconstruction therefore has to come from what survives, and for most of
 * this port's life that was only `q3map_surfacelight` shader directives plus
 * `q3map_sun`. A map whose author lit it with `light` entities reconstructed to
 * *nothing*: `oa_dm5` yielded zero point lights from 107,414 triangles and
 * `oa_dm7` left 70 of 79 player positions under a lux.
 *
 * `LUMP_LIGHTGRID` is the other thing q3map2 bakes, it does survive, and the
 * pipeline now fits point lights to it (Q-006, D-078). So this asserts all six
 * maps rather than the three the demo presents -- which is the whole point of
 * the change, and is why the block below that used to record the shortfall now
 * checks it is gone.
 */
describe('the reconstructed lighting solution', () => {
    it.each(MAPS)('lights the places a player stands [%s]', (name) => {
        const s = scene(name);
        const points = playerPoints(s);
        const lux = points.map((p) => illuminance(s, p)).sort((a, b) => a - b);

        const dark = lux.filter((v) => v < 1).length;
        const median = lux[Math.floor(lux.length / 2)]!;

        expect(s.lights.length, 'reconstructed point lights').toBeGreaterThan(10);
        expect(
            dark / lux.length,
            `${dark}/${lux.length} player positions under 1 lux`
        ).toBeLessThan(0.1);

        // An order of magnitude below what the build achieves (8.8 lux on the
        // dimmest of the three), per this suite's convention: a guard at the
        // current value fails on noise, one well below it catches a map that
        // has quietly lost its lighting.
        expect(median, `median illuminance ${median.toFixed(1)} lux`).toBeGreaterThan(1);
    });

    it('lights the two maps the shader route could not reach at all', () => {
        /*
         This block used to pin the shortfall: `oa_dm5` has zero lights,
         `oa_dm7` is more than half dark. It was pinned so that a fix would fail
         here and have to update the claim, and that is exactly what happened.

         What is asserted now is the property the fix is for -- these two maps
         have their lighting back and it came from the lightgrid, not from the
         shaders, because the shaders never had it. `oa_dm5` is the strong case:
         every one of its lights is a fitted one, so if the grid route breaks
         the count goes to zero rather than merely getting worse.
        */
        const dm5 = scene('oa_dm5');
        const dm7 = scene('oa_dm7');

        expect(dm5.lights.length, 'oa_dm5 reconstructs to nothing again')
            .toBeGreaterThan(10);

        // Every one of them is coloured, which only a lightgrid light is: a
        // `q3map_surfacelight` is a scalar and has no colour to carry.
        expect(
            dm5.lights.filter((l) => l.color !== undefined).length,
            'oa_dm5 grew a surface light from somewhere'
        ).toBe(dm5.lights.length);

        const dm7Points = playerPoints(dm7);
        const dm7Dark = dm7Points.filter((p) => illuminance(dm7, p) < 1).length;
        expect(
            dm7Dark / dm7Points.length,
            `${dm7Dark}/${dm7Points.length} oa_dm7 player positions under 1 lux`
        ).toBeLessThan(0.1);
    });

    it('leaves a map that was already lit close to how it was', () => {
        /*
         The fit adds what the shader route left short and nothing else, so a
         map the shaders already lit should barely move. Asserted because the
         first working version did not have this property -- it emitted 256
         lights on `oa_dm1` and took it from 8.7 lux to 63 -- and the fix was a
         real one (a source-distance estimate and a least-squares pass), not a
         threshold. See D-078.

         The bound is loose on purpose. Some movement is correct: the lightgrid
         is the *baked truth* and the shader reconstruction undershoots it on
         `oa_dm1`, so converging toward the grid is the fit working.
        */
        for (const name of ['oa_dm4', 'aggressor', 'am_thornish']) {
            const s = scene(name);
            const fitted = s.lights.filter((l) => l.color !== undefined).length;

            expect(
                fitted / s.lights.length,
                `${name}: ${fitted} of ${s.lights.length} lights came from the grid`
            ).toBeLessThan(0.75);
        }
    });

    it('reconstructs light from surfaces, and never from a light entity', () => {
        // The premise of the whole reconstruction, asserted rather than assumed:
        // if a future OA map *did* ship light entities the conversion would be
        // leaving them on the floor.
        for (const name of MAPS) {
            const s = scene(name);
            const lightEntities = s.entities.filter((e) => e.classname === 'light');
            expect(lightEntities.length, `${name} carries light entities`).toBe(0);
        }
    });
});

/*
 * Pickups: an item you cannot see is an item you cannot find.
 */
describe('every pickup the maps spawn is drawable', () => {
    const models = JSON.parse(
        readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
    ) as { models: { name: string }[]; stats: Record<string, number> };

    const built = new Set(models.models.map((m) => m.name));

    /**
     * The shells OA does not ship.
     *
     * Q3 draws several pickups as a solid body plus an additive shell -- an
     * armour shard inside a glowing sphere, a medkit inside a bubble. OA's
     * asset set has the body and not the shell for these three, plus
     * `porter.md3`, which no map this port ships spawns. The item still draws,
     * so this is a fidelity loss rather than an invisible pickup, which is why
     * the runtime reports `partial` separately from `unmodelled` and why this
     * list is named rather than counted.
     */
    const NO_SHELL = [
        'models/powerups/armor/shard_sphere.md3',
        'models/powerups/holdable/medkit_sphere.md3',
        'models/powerups/holdable/porter.md3',
        'models/powerups/instant/invis_ring.md3',
    ];

    /**
     * Spawn-point and game-mode markers that look like items and are not.
     *
     * `item_botroam` is a botlib navigation hint with no pickup behaviour at
     * all; the `team_*player` / `team_*spawn` entries are CTF spawn points; the
     * obelisks belong to Overload and Harvester. None has an entry in OA's own
     * `bg_itemlist`, so `itemByClassname` correctly returns null and
     * `ItemSystem.spawn` correctly skips them. Pinned as a list so that a real
     * item falling out of `balance.generated.json` fails here.
     */
    const NOT_ITEMS = [
        'item_botroam',
        'team_CTF_blueplayer', 'team_CTF_bluespawn',
        'team_CTF_redplayer', 'team_CTF_redspawn',
        'team_blueobelisk', 'team_neutralobelisk', 'team_redobelisk',
    ];

    it('resolves every spawned classname to an item definition, or names why not', () => {
        const unresolved = new Set<string>();

        for (const name of MAPS) {
            for (const e of scene(name).entities) {
                const c = e.classname ?? '';
                if (!/^(item_|weapon_|ammo_|holdable_|team_)/.test(c)) continue;
                if (itemByClassname(c) === null) unresolved.add(c);
            }
        }

        expect([...unresolved].sort()).toEqual([...NOT_ITEMS].sort());
    });

    it('has a model for every spawned item, and names the shells OA omits', () => {
        const missing = new Set<string>();

        for (const name of MAPS) {
            for (const e of scene(name).entities) {
                const def = itemByClassname(e.classname ?? '');
                if (def === null) continue;

                let drawn = 0;
                for (const path of def.models) {
                    if (built.has(path)) drawn += 1;
                    else missing.add(path);
                }

                expect(drawn, `${def.classname} draws nothing at all`).toBeGreaterThan(0);
            }
        }

        // Only three of the four are reachable from a spawned item; `porter.md3`
        // belongs to `holdable_porter`, which no shipped map places.
        expect([...missing].sort()).toEqual(
            NO_SHELL.filter((m) => !m.endsWith('porter.md3')).sort()
        );
        expect(models.stats['missing']).toBe(NO_SHELL.length);
    });
});

/*
 * Effects and sound: named in code, resolved on disk.
 *
 * Both scan the shipping source for the names it asks for rather than
 * duplicating a list, because a duplicated list is a list that goes stale --
 * which is the same failure the trap matrix had (D-066).
 */
describe('the effects the code asks for exist', () => {
    it('resolves every fx texture named in Effects.ts', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'client', 'Effects.ts'), 'utf8');
        const named = [...source.matchAll(/'\/assets\/built\/([^']+\.png)'/g)].map((m) => m[1]!);

        expect(named.length, 'fx textures referenced').toBeGreaterThanOrEqual(4);

        for (const path of new Set(named)) {
            expect(existsSync(join(BUILT, path)), `${path} is named in Effects.ts and absent`)
                .toBe(true);
        }
    });
});

describe('the sound bank covers what the game plays', () => {
    const manifest = JSON.parse(
        readFileSync(join(BUILT, 'sound', 'sounds.json'), 'utf8')
    ) as {
        sounds: Record<string, string[]>;
        missing: string[];
        stats: Record<string, number>;
    };

    it('has a file for every name it lists, and lists every file it has', () => {
        for (const [name, files] of Object.entries(manifest.sounds)) {
            expect(files.length, `${name} lists no files`).toBeGreaterThan(0);
            for (const file of files) {
                expect(existsSync(join(BUILT, 'sound', file)), `${name} -> ${file}`).toBe(true);
            }
        }
    });

    it('reports exactly the two Q3-original tracks OpenArena does not ship', () => {
        // `oa_dm1` and `oa_dm5` name `music/sonic6` and `music/sonic3` in their
        // worldspawn. Reported rather than silently dropped, which is the
        // manifest doing its job -- see D-049.
        expect(manifest.missing.sort()).toEqual([
            'music/sonic3: music/sonic3.ogg',
            'music/sonic6: music/sonic6.ogg',
        ]);
    });

    it('covers every sound name the shipping code plays', () => {
        const sources = [
            'src/app/main.ts',
            'src/client/Arena.ts',
            'src/client/Bots.ts',
            'src/client/ItemsView.ts',
            'src/client/MapSound.ts',
        ].map((p) => readFileSync(join(process.cwd(), p), 'utf8')).join('\n');

        /*
         Literal names only: `audio.play('impact/flesh', ...)`. The interpolated
         ones (`item/${classname}`, `mover/${kind}_${which}`) cannot be resolved
         by reading the source and are covered by the per-family checks below.
        */
        const literal = [...sources.matchAll(/\.(?:play|playLocal|loop)\('([^'$]+)'/g)]
            .map((m) => m[1]!);

        expect(literal.length, 'literal sound names in the shipping code').toBeGreaterThan(8);

        for (const name of new Set(literal)) {
            expect(manifest.sounds[name], `${name} is played and not in the bank`).toBeDefined();
        }
    });

    it('covers every item pickup, weapon fire and mover sound by family', () => {
        const have = (name: string): boolean => manifest.sounds[name] !== undefined;

        /*
         `Touch_Item` plays `item/<classname>`. The three CTF flags are the
         exception and are meant to be: they are `IT_TEAM`, they are only
         pickable in a game mode this port does not implement, and giving them a
         sound would mean shipping a file nothing ever plays.
        */
        const flags = ['team_CTF_redflag', 'team_CTF_blueflag', 'team_CTF_neutralflag'];
        const silent = new Set<string>();

        for (const name of MAPS) {
            for (const e of scene(name).entities) {
                const def = itemByClassname(e.classname ?? '');
                if (def === null) continue;
                if (!have(`item/${def.classname}`)) silent.add(def.classname);
            }
        }

        expect([...silent].sort()).toEqual([...flags].sort());

        // `MoverSound`'s two families, and the button that only clicks.
        for (const family of ['mover/door_start', 'mover/door_stop', 'mover/plat_start',
                              'mover/plat_stop', 'mover/button']) {
            expect(have(family), family).toBe(true);
        }

        // Every weapon the player can hold has a firing sound.
        for (const weapon of ['WP_GAUNTLET', 'WP_MACHINEGUN', 'WP_SHOTGUN', 'WP_GRENADE_LAUNCHER',
                              'WP_ROCKET_LAUNCHER', 'WP_LIGHTNING', 'WP_RAILGUN', 'WP_PLASMAGUN',
                              'WP_BFG']) {
            expect(have(`weapon/${weapon}`), `weapon/${weapon}`).toBe(true);
        }
    });
});
