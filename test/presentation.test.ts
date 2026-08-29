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
 *     the fallback and reads as "the conversion is broken". This one asserts the
 *     textures a material *names*; the case where it names none at all, and the
 *     rest of what a material and its image have to agree about, is
 *     `materials.test.ts` (D-083).
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

import { impactSound } from '../src/client/impactSound.ts';
import { itemByClassname, weaponItemByTag } from '../src/game/Items.ts';
import balance from '../src/game/balance.generated.json' with { type: 'json' };
import { GRID_SOURCE_RADIUS, SOURCE_EXTENT_FLOOR } from '../tools/pipeline/lightgrid.ts';
import { LOCAL_LIGHT_SCALE } from '../tools/convert-map.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

const MAPS = ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish'] as const;

/** Maps the demo actually presents: the default, and the two built to show off. */
const SHOWCASE = ['oa_dm1', 'aggressor', 'am_thornish'] as const;

interface Material {
    readonly name: string;
    readonly albedo: string | null;
    readonly emissive: string | null;
    readonly emissiveLuminance: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly transparency: string;
}

interface Light {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly lumens: number;
    /** Cutoff radius: how far it reaches. */
    readonly radius: number;
    /** Source radius: how big the emitter is. See D-103. */
    readonly sourceRadius: number;
    /** Present only on lights fitted to the lightgrid; see D-078. */
    readonly color?: readonly number[];
}

interface Scene {
    readonly worldScale: number;
    /** Index 0 is the world model, whose bounds are the map's own. */
    readonly submodels: { minsQ3: number[]; maxsQ3: number[] }[];
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
 * The falloff stops at the emitter's own surface rather than at an epsilon,
 * which is `light_sphere_distance_attenuation` and is why the lights carry a
 * `sourceRadius` at all. At the places a player stands it changes nothing --
 * measured, the median moves by less than a tenth of a lux on all six maps --
 * because a player is metres from a fixture and this is a near-field bound.
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

        const extent = Math.max(l.sourceRadius, SOURCE_EXTENT_FLOOR);

        lux += l.lumens / (4 * Math.PI) / Math.max(d2, extent * extent);
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

    it('does not take a map over with fitted lights', () => {
        /*
         The fit is a correction, not a replacement: a map whose author lit it
         with surface shaders should still be lit by them afterwards. Asserted
         because the first working version did not have this property -- it
         emitted 256 lights on `oa_dm1` and took it from 8.7 lux to 63 -- and
         the fix was a real one (a source-distance estimate and a least-squares
         pass), not a threshold. See D-078.

         What this used to say was that such a map "should barely move", which
         stopped being true at D-105. The fit sizes the surface lights now
         instead of taking them on faith, and on the maps whose shaders declared
         too much it moves them a long way -- `am_thornish` went from delivering
         4.3 times the baked target to 0.58 of it. Moving is the fix. Being
         replaced is still the failure, and it is what this checks.
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

    it.each(MAPS)('agrees with the field q3map2 baked [%s]', (name) => {
        /*
         The claim the rest of this block cannot make. Everything above asks
         whether there is light in the right places; this asks whether there is
         the right *amount* of it, against the only reference that exists -- the
         lightgrid q3map2 baked, which is the same field the fit was solved
         against.

         It could not have been asserted before D-105. The fit was allowed to
         add light and not to remove it, so a map whose shaders declared too
         much simply stayed too bright and no bound here could have held:
         `am_thornish` sat at 2,312% RMS, `oa_dm4` and `aggressor` at around
         250%. All six now land between 52% and 79%.

         **Read off the shipped lights, not off the fit.** They stopped being
         the same set at D-150: the port de-rates every local light by
         `LOCAL_LIGHT_SCALE` after the fit has run, because a Q3 emissive
         surface reaches meep's picture as a glowing face and a baked bounce as
         well as as a point light. So the fitted residual is no longer a
         statement about anything in the bundle, and this asserts the one that
         is -- `shipped`, which is 62% to 85% against the fit's own 52% to 79%.

         The bound is 120% rather than 90% for this suite's usual reason -- a
         guard at the current value fails on noise. It is still far under where
         four of the six were, which is what makes it worth having.
        */
        const s = scene(name);
        const shipped = s.stats.lightingResidualShipped;
        const after = s.stats.lightingResidualAfter;
        const before = s.stats.lightingResidualBefore;

        expect(shipped, `${name} recorded no residual against the lightgrid`).toBeTypeOf('number');
        expect(
            shipped!,
            `RMS ${((shipped ?? 0) * 100).toFixed(0)}% of mean target ` +
            `(the fit's own: ${((after ?? 0) * 100).toFixed(0)}%, ` +
            `shader route alone: ${((before ?? 0) * 100).toFixed(0)}%)`
        ).toBeLessThan(1.2);

        /*
         And the de-rating can only have moved it one way. The fit solves for
         the output that best matches the baked field and the bundle then ships
         70% of it, so on a convex least squares over a fixed geometry the
         shipped field is the worse match by construction -- measured, all six
         move by 4 to 10 points.

         The two ways this can fail are both worth stopping for. Either
         something other than `LOCAL_LIGHT_SCALE` changed the lights after they
         were measured, and the pair of numbers has stopped describing what it
         says it describes; or the fit is systematically over-delivering and a
         blanket 30% cut is closer to the bake than its own answer was, which is
         a finding about the fit and not about this constant. Neither is a
         result to pass silently.
        */
        expect(
            shipped!,
            `${name} ships a solution that agrees with the bake better than the ` +
            `one that was fitted to it`
        ).toBeGreaterThan(after!);
    });

    it.each(MAPS)('carries the de-rating the converter applies today [%s]', (name) => {
        /*
         `assets/built/` is committed, so a bundle can be older than the code
         that writes it. Nothing else in a scene file moves when
         `LOCAL_LIGHT_SCALE` does -- the lights are just dimmer, and dimmer is
         what the whole tree looks like anyway -- so a stale bundle would
         otherwise present as the port having quietly kept the old brightness on
         some maps and not others.

         The value itself is pinned rather than only compared, because 70% is
         the *request* (D-150) and not an artefact: a change to it is a change
         to how the game looks and belongs in a diff that says so.
        */
        expect(LOCAL_LIGHT_SCALE).toBeCloseTo(0.7, 10);
        expect(
            scene(name).stats.localLightScale,
            `${name} was built at a different de-rating than the converter applies`
        ).toBeCloseTo(LOCAL_LIGHT_SCALE, 10);
    });

    it.each(MAPS)('keeps a light inside the room it lights [%s]', (name) => {
        /*
         A cutoff radius is where the renderer stops evaluating a light, and it
         used to be set from the shader directive that declared the light --
         `6 + surfacelight / 120` metres -- which is a number about a texture
         being asked a question about a room. On `oa_dm1` that gave sixteen of
         thirty-three lights an influence sphere larger than the entire map, and
         left a third of the light-to-point pairs a shading point evaluated
         delivering under half a lux each.

         The reach is a fraction of the local level now (D-105), so it is
         bounded by how bright the place is rather than by how large a number
         the mapper typed.

         Summed over the map rather than per light, and against the map's own
         volume rather than a constant, because a single far-reaching light is
         not the failure -- a fit standing in for a distant source really does
         place one, and `oa_dm7` has five. The failure is every light reaching
         everywhere, which is what the shader directive produced and what a
         shading point pays for: the six maps ran at 6 to 18 times their own
         volume in summed influence and now run at 1 to 7.
        */
        const s = scene(name);
        const world = s.submodels[0]!;
        const span = [0, 1, 2].map((i) => (world.maxsQ3[i]! - world.minsQ3[i]!) * s.worldScale);
        const volume = span[0]! * span[1]! * span[2]!;

        // Clamped per light: a sphere that engulfs the map is not more of a
        // problem for covering twice it, and leaving it unclamped would let one
        // outlier decide the number.
        const influence = s.lights.reduce(
            (a, l) => a + Math.min((4 / 3) * Math.PI * l.radius ** 3, volume),
            0
        );

        expect(
            influence / volume,
            `${s.lights.length} lights cover ${(influence / volume).toFixed(1)}x the map's own volume`
        ).toBeLessThan(10);
    });

    it.each(MAPS)('gives every light a volume rather than leaving it a point [%s]', (name) => {
        /*
         Shade shades sphere lights. A light with no radius is a delta source,
         and the renderer's fallback for one is a *centimetre* -- so the ceiling
         a fixture hangs from is lit as if all of its output came from a marble
         a few centimetres across, its highlight is a mirror point, and its
         terminator is a hard edge. That was the picture, and this is the
         property that stops it coming back.

         The bound below is against the renderer's own fallback rather than
         against zero: `sourceRadius: 0.005` would pass a `> 0` check and mean
         nothing, because `light_sphere_distance_attenuation` would floor it.
        */
        const s = scene(name);

        for (const l of s.lights) {
            expect(Number.isFinite(l.sourceRadius), 'sourceRadius is not a number').toBe(true);
            expect(
                l.sourceRadius,
                `a light at ${l.x.toFixed(1)},${l.y.toFixed(1)},${l.z.toFixed(1)} is still a point`
            ).toBeGreaterThan(SOURCE_EXTENT_FLOOR);

            /*
             How big it is against how far it reaches. Not a renderer
             requirement -- the shader handles `r > cutoff` -- but a source
             larger than its own influence is a light that has stopped
             describing anything, and it is the shape a units mix-up takes.
            */
            expect(l.sourceRadius, 'a source bigger than its own reach').toBeLessThanOrEqual(
                l.radius
            );
        }
    });

    it('sizes a fixture from its own geometry rather than from a default', () => {
        /*
         The claim worth testing is not that the numbers are there but that they
         were *measured*: a blanket constant would satisfy every bound above and
         reintroduce exactly the arbitrariness the surface route exists to avoid.
         A surface light's radius comes from the emitting area it was clustered
         out of, so a map with light panels and trim strips has a spread of them.

         `oa_dm5` is excluded because it has no surface lights at all -- every
         one of its lights is fitted to the grid, and a fitted light has no
         geometry to be measured from, so those *are* one constant. See D-078.
        */
        for (const name of ['oa_dm1', 'oa_dm4', 'oa_dm7', 'aggressor', 'am_thornish']) {
            const s = scene(name);
            const surface = s.lights.filter((l) => l.color === undefined);
            const sizes = new Set(surface.map((l) => l.sourceRadius));

            expect(surface.length, `${name} has no surface lights`).toBeGreaterThan(0);
            expect(
                sizes.size,
                `${name}: ${surface.length} surface lights, ${sizes.size} distinct sizes`
            ).toBeGreaterThan(1);
        }

        // ...and the fitted ones are the constant, deliberately.
        const dm5 = scene('oa_dm5');
        for (const l of dm5.lights) {
            expect(l.sourceRadius).toBeCloseTo(GRID_SOURCE_RADIUS, 10);
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
 * Muzzle flashes: the light goes where the model says, so the model has to say.
 *
 * `ViewWeapon` hangs the player's own flash on `tag_flash`, which is a point the
 * people who made the weapon authored and the pipeline copies through. A weapon
 * whose model reaches the bundle without one still fires and still lights the
 * room -- `Arena` falls back to the shot's own origin -- but it fires with the
 * light back in the middle of the screen, which is the defect D-115 fixed. That
 * is a silent regression, so the tags are counted here rather than trusted.
 */
describe('every weapon that can flash has a point to flash from', () => {
    const bundle = JSON.parse(
        readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
    ) as { models: { name: string; tags: { name: string }[] }[] };

    const byName = new Map(bundle.models.map((m) => [m.name, m]));

    /**
     * The two that ship none, and why each is fine.
     *
     * The gauntlet has no muzzle: Q3 lights it from the player's own origin for
     * as long as the trigger is held, which is roughly where the fallback puts
     * it. OA's prox launcher model carries no tags at all -- not `tag_flash`,
     * not `tag_barrel` -- so there is nothing to hang anything on.
     */
    const NO_FLASH_TAG = ['WP_GAUNTLET', 'WP_PROX_LAUNCHER'];

    it('carries `tag_flash` on every weapon model but the two that cannot', () => {
        const without: string[] = [];

        for (const weapon of Object.keys(balance.weapons)) {
            const path = weaponItemByTag(weapon)?.models[0];
            expect(path, `${weapon} has no world model in the item table`).toBeDefined();

            const model = byName.get(path!);
            expect(model, `${weapon}: ${path} never reached the bundle`).toBeDefined();

            if (!model!.tags.some((t) => t.name === 'tag_flash')) without.push(weapon);
        }

        expect(without.sort()).toEqual([...NO_FLASH_TAG].sort());
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

        /*
         The decals name their texture by leaf, because `mark` builds the URL --
         so a scan for whole paths sees the particle sprites and none of the
         marks, and used to assert "every fx texture" while checking three of
         seven. `first-person.test.ts` is what checks their *contents*; this is
         what checks they are on disk at all.
        */
        const marks = [...source.matchAll(/'(mark_[a-z_]+)'/g)].map((m) => `fx/${m[1]!}.png`);

        expect(named.length, 'fx sprites referenced').toBeGreaterThanOrEqual(4);
        expect(marks.length, 'decal marks referenced').toBeGreaterThanOrEqual(2);

        for (const path of new Set([...named, ...marks])) {
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

        /*
         A floor, so that a regex that has stopped matching anything cannot pass
         this quietly. It was `> 8` and is now `>= 8`, because the two impact
         names moved out of these call sites and into `impactSound.ts` -- a
         table, which this scan cannot see and the per-weapon block below checks
         directly instead. A name that leaves the scan has to arrive somewhere
         that is checked; these did.
        */
        expect(literal.length, 'literal sound names in the shipping code')
            .toBeGreaterThanOrEqual(8);

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

        /*
         Every weapon has a firing sound, and the list is **read** rather than
         written down. It used to name nine weapons; `balance.weapons` has
         twelve, and the three it did not name -- the chaingun, the nailgun and
         the prox launcher -- fired in silence, with the test that exists to
         catch exactly that agreeing with them. `Arena.muzzleFlash` plays
         `weapon/<id>` for whatever `WeaponSystem` fired, and what it can fire is
         this table. See D-146.
        */
        const weapons = Object.keys(balance.weapons);
        expect(weapons.length, 'weapons in the balance table').toBeGreaterThanOrEqual(12);

        for (const weapon of weapons) {
            expect(have(`weapon/${weapon}`), `weapon/${weapon}`).toBe(true);
        }

        /*
         And an impact sound for every weapon Q3 gives one. `impactSound` is
         `CG_MissileHitWall`'s `sfx` column, so a null is the C's own silence --
         the shotgun's eleven pellets and the gauntlet, which never reaches the
         switch there -- and everything else has to be a name the bank has. This
         is the check the two hard-coded names it replaced could not fail: they
         were in the bank by construction, whatever weapon was firing.
        */
        for (const weapon of weapons) {
            const sfx = impactSound(weapon);
            if (sfx === null) continue;

            expect(have(sfx), `${weapon} impacts with ${sfx}`).toBe(true);
        }
    });
});
