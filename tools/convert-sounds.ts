/*
 * convert-sounds.ts -- collect the sounds the port actually plays.
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
 * Output, under `assets/built/sound/`:
 *
 *   sounds.json     logical name -> file, plus what was missing
 *   *.wav           the files themselves, path-flattened
 *
 * Copied rather than transcoded. OA's sounds are 22.05 kHz mono PCM WAV, which
 * every browser decodes natively through `decodeAudioData`, and re-encoding to
 * Opus would trade a real quality loss for a saving on 3 MB of assets that are
 * not committed anyway.
 *
 * The list is curated rather than "everything under `sound/`": OA ships 40 MB of
 * audio, most of it announcer lines, taunts and per-character voice for modes
 * this port does not have. What is here is what something in the port triggers,
 * which is also why the manifest reports misses -- a sound named by the code and
 * absent from disk is a bug, and a sound on disk that nothing names is not.
 *
 * Half the list is curated and the other half is read out of the maps, because
 * half of it is: `target_speaker` names its own ambience and `worldspawn` names
 * its own music, and which files those are is a property of the map rather than
 * of the port. Those are collected from the *built* maps under `assets/built/`,
 * so converting a new map means running this again -- which the output says.
 *
 * Usage:  node tools/convert-sounds.ts
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { soundName, speakerNoisePath } from '../src/q3/soundName.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');

/**
 * Logical name -> Q3 path, or a list of paths Q3 picks between at random.
 *
 * The names are the port's, the paths are `cg_weapons.c`'s and `g_*.c`'s. Where
 * Q3 randomises -- footsteps, machinegun flashes, ricochets -- the whole set is
 * here and the runtime picks, because a single machinegun sample repeating at
 * 100 ms intervals is a distinctly different weapon to listen to.
 */
const SOUNDS: Readonly<Record<string, string | string[]>> = {
    /* ---- weapons: fire ---- */
    'weapon/WP_GAUNTLET': 'sound/weapons/melee/fstatck.wav',
    'weapon/WP_MACHINEGUN': [
        'sound/weapons/machinegun/machgf1b.wav',
        'sound/weapons/machinegun/machgf2b.wav',
        'sound/weapons/machinegun/machgf3b.wav',
        'sound/weapons/machinegun/machgf4b.wav',
    ],
    'weapon/WP_SHOTGUN': 'sound/weapons/shotgun/sshotf1b.wav',
    'weapon/WP_GRENADE_LAUNCHER': 'sound/weapons/grenade/grenlf1a.wav',
    'weapon/WP_ROCKET_LAUNCHER': 'sound/weapons/rocket/rocklf1a.wav',
    'weapon/WP_LIGHTNING': 'sound/weapons/lightning/lg_fire.wav',
    'weapon/WP_RAILGUN': 'sound/weapons/railgun/railgf1a.wav',
    'weapon/WP_PLASMAGUN': 'sound/weapons/plasma/hyprbf1a.wav',
    'weapon/WP_BFG': 'sound/weapons/bfg/bfg_fire.wav',
    /*
     The three the mission pack added, and the three this list did not have.
     `balance.generated.json` carries twelve weapons and `Arena.muzzleFlash`
     plays `weapon/<id>` for whichever one fired, so a weapon missing from here
     is a weapon that fires in silence -- which is what the chaingun, the nailgun
     and the prox launcher did. They are `weaponInfo->flashSound[]` in
     `CG_RegisterWeapon`'s `#ifdef MISSIONPACK` cases; OpenArena ships all four
     files of the chaingun's set, so it randomises like the machinegun does.
     See D-146.
    */
    'weapon/WP_CHAINGUN': [
        'sound/weapons/vulcan/vulcanf1b.wav',
        'sound/weapons/vulcan/vulcanf2b.wav',
        'sound/weapons/vulcan/vulcanf3b.wav',
        'sound/weapons/vulcan/vulcanf4b.wav',
    ],
    'weapon/WP_NAILGUN': 'sound/weapons/nailgun/wnalfire.wav',
    'weapon/WP_PROX_LAUNCHER': 'sound/weapons/proxmine/wstbfire.wav',
    'weapon/empty': 'sound/weapons/noammo.wav',
    'weapon/change': 'sound/weapons/change.wav',

    /*
     ---- weapons: impact ----

     `CG_MissileHitWall`'s `sfx`, one name per row of `Arena.IMPACT_SOUNDS`. The
     shotgun and the gauntlet are absent because the C plays nothing for them,
     not because a file is missing.

     `impact/grenade` used to be here, against `weapons/grenade/hgrenb1a.wav`.
     That file is `cgs.media.hgrenb1aSound`, which `EV_GRENADE_BOUNCE` plays when
     a grenade *bounces*; the grenade's detonation is `sfx_rockexp` like the
     rocket's. Nothing in the port ever named it -- this port detonates a grenade
     on its first contact, so there is no bounce to play it on -- and a row that
     reads like an impact and is not is worse than no row.
    */
    'impact/bullet': [
        'sound/weapons/machinegun/ric1.wav',
        'sound/weapons/machinegun/ric2.wav',
        'sound/weapons/machinegun/ric3.wav',
    ],
    'impact/rocket': 'sound/weapons/rocket/rocklx1a.wav',
    'impact/plasma': 'sound/weapons/plasma/plasmx1a.wav',
    // `sfx_lghit1/2/3`, and the C picks between all three.
    'impact/lightning': [
        'sound/weapons/lightning/lg_hit.wav',
        'sound/weapons/lightning/lg_hit2.wav',
        'sound/weapons/lightning/lg_hit3.wav',
    ],
    'impact/prox': 'sound/weapons/proxmine/wstbexpl.wav',
    /*
     `sfx_nghit` is `weapons/nailgun/wnalimpd.wav`, which OpenArena does not
     ship; `wnalimpm` -- the metal-surface variant of the same impact -- is what
     it has, and stands in for every surface. `Arena.IMPACT_SOUNDS` says so at
     the row that names this.
    */
    'impact/nail': 'sound/weapons/nailgun/wnalimpm.wav',
    'impact/flesh': ['sound/player/gibimp1.wav', 'sound/player/gibimp2.wav', 'sound/player/gibimp3.wav'],

    /* ---- feedback ---- */
    'feedback/hit': 'sound/feedback/hit.wav',

    /* ---- player ---- */
    'player/footstep': [
        'sound/player/footsteps/step1.wav',
        'sound/player/footsteps/step2.wav',
        'sound/player/footsteps/step3.wav',
        'sound/player/footsteps/step4.wav',
    ],
    'player/land': 'sound/player/land1.wav',
    'player/jump': 'sound/player/sarge/jump1.wav',

    /* ---- movers, from SP_func_door / SP_func_plat / SP_func_button ---- */
    'mover/door_start': 'sound/movers/doors/dr1_strt.wav',
    'mover/door_stop': 'sound/movers/doors/dr1_end.wav',
    'mover/plat_start': 'sound/movers/plats/pt1_strt.wav',
    'mover/plat_stop': 'sound/movers/plats/pt1_end.wav',
    'mover/button': 'sound/movers/switches/butn2.wav',

    /* ---- world ---- */
    'world/jumppad': 'sound/world/jumppad.wav',
    'world/telein': 'sound/world/telein.wav',
    'world/teleout': 'sound/world/teleout.wav',

    /*
     ---- loops ----

     Everything below is played through `trap_S_AddLoopingSound` in Q3 rather
     than `trap_S_StartSound`, which is a property of the call site and not of
     the file: the same `rockfly.wav` is a loop under a rocket and would be a
     one-shot anywhere else. The names carry the field they come from in
     `weaponInfo_t`, because that is what says which is which.

     `CG_Missile`, one per weapon that has a `missileSound`. The grenade
     launcher deliberately has none -- a grenade arcs silently and lands with a
     bounce -- and the nailgun's is commented out in the OA source.
    */
    'missile/WP_ROCKET_LAUNCHER': 'sound/weapons/rocket/rockfly.wav',
    'missile/WP_PLASMAGUN': 'sound/weapons/plasma/lasfly.wav',
    'missile/WP_BFG': 'sound/weapons/rocket/rockfly.wav',

    /*
     `CG_AddPlayerWeapon`, which plays `firingSound` while `EF_FIRING` is set
     and `readySound` otherwise -- and only for a weapon seen in the third
     person (`if ( !ps )`), so these are the sounds other players make and never
     the sounds you make.
    */
    'firing/WP_GAUNTLET': 'sound/weapons/melee/fstrun.wav',
    'firing/WP_LIGHTNING': 'sound/weapons/lightning/lg_hum.wav',
    'firing/WP_CHAINGUN': 'sound/weapons/vulcan/wvulfire.wav',
    'ready/WP_GAUNTLET': 'sound/weapons/melee/fsthum.wav',
    'ready/WP_RAILGUN': 'sound/weapons/railgun/rg_hum.wav',
    'ready/WP_BFG': 'sound/weapons/bfg/bfg_hum.wav',

    /** `CG_Item`: a weapon lying in the map hovers, and hovering is audible. */
    'item/hover': 'sound/weapons/weapon_hover.wav',
};

interface Manifest {
    readonly generator: string;
    /** Logical name -> written filenames, in the order Q3 would pick between. */
    readonly sounds: Readonly<Record<string, string[]>>;
    readonly missing: readonly string[];
    readonly stats: Readonly<Record<string, number>>;
}

/** Every `pickupSound` in the generated balance table, keyed `item/<classname>`. */
function itemSounds(): Record<string, string> {
    const balance = JSON.parse(
        readFileSync(join(ROOT, 'src', 'game', 'balance.generated.json'), 'utf8')
    ) as { items: { classname: string; pickupSound: string }[] };

    const out: Record<string, string> = {};
    for (const item of balance.items) {
        if (typeof item.pickupSound === 'string' && item.pickupSound.length > 0) {
            out[`item/${item.classname}`] = item.pickupSound;
        }
    }
    return out;
}

interface BuiltEntity extends Record<string, unknown> {
    classname?: string;
}

/**
 * Every sound the *built* maps name for themselves.
 *
 * `target_speaker` carries a `noise` key and `worldspawn` carries a `music` key,
 * and neither is knowable from the gamecode -- they are per-map data. The names
 * are derived by `soundName`, the same function the runtime derives them with,
 * so a map's string and the copied file cannot drift apart.
 *
 * Only looping speakers are collected. A speaker with neither looped flag waits
 * for a trigger this port does not fire, and copying its sample would put a file
 * in the manifest that nothing can ever play.
 */
function mapSounds(): { sounds: Record<string, string>; maps: number } {
    const out: Record<string, string> = {};
    let maps = 0;

    let names: string[];
    try {
        names = readdirSync(BUILT);
    } catch {
        return { sounds: out, maps: 0 };
    }

    for (const name of names) {
        const scenePath = join(BUILT, name, 'scene.json');
        if (!existsSync(scenePath)) continue;

        let entities: BuiltEntity[];
        try {
            entities = (JSON.parse(readFileSync(scenePath, 'utf8')) as { entities?: BuiltEntity[] })
                .entities ?? [];
        } catch {
            continue;
        }

        maps += 1;

        for (const entity of entities) {
            if (entity.classname === 'target_speaker') {
                if (((Number(entity['spawnflags'] ?? 0) | 0) & 1) === 0) continue;

                const noise = entity['noise'];
                if (typeof noise !== 'string') continue;

                const path = speakerNoisePath(noise);
                if (path !== null) out[soundName(path)] = path;
                continue;
            }

            if (entity.classname === 'worldspawn') {
                const music = entity['music'];
                if (typeof music !== 'string' || music.trim().length === 0) continue;

                // `CG_StartMusic` parses an intro token and a loop token.
                for (const token of music.trim().split(/\s+/)) {
                    out[soundName(token)] = token;
                }
            }
        }
    }

    return { sounds: out, maps };
}

/**
 * The file on disk for a Q3 path, tolerating case.
 *
 * Q3's own filesystem is case-insensitive on the platforms it shipped for, and
 * OA's maps take advantage: `aggressor` asks for `music/OA14.ogg` and the pk3
 * holds `music/oa14.ogg`. The manifest name stays the one the map wrote, so the
 * runtime -- which derives it from the same string -- still finds it.
 */
function resolveSource(path: string): string | null {
    const direct = join(EXTRACTED, path);
    if (existsSync(direct)) return direct;

    const lowered = join(EXTRACTED, path.toLowerCase());
    return existsSync(lowered) ? lowered : null;
}

function convertSounds(): void {
    const outDir = join(BUILT, 'sound');
    mkdirSync(outDir, { recursive: true });

    const fromMaps = mapSounds();
    const all: Record<string, string | string[]> = {
        ...SOUNDS,
        ...itemSounds(),
        ...fromMaps.sounds,
    };

    const sounds: Record<string, string[]> = {};
    const missing: string[] = [];
    const written = new Map<string, string>();
    let bytes = 0;

    for (const [name, value] of Object.entries(all)) {
        const paths = Array.isArray(value) ? value : [value];
        const files: string[] = [];

        for (const path of paths) {
            const cached = written.get(path);
            if (cached !== undefined) {
                files.push(cached);
                continue;
            }

            const source = resolveSource(path);
            if (source === null) {
                missing.push(`${name}: ${path}`);
                continue;
            }

            const flat = path.replace(/^sound\//, '').replace(/[\\/]/g, '_');
            copyFileSync(source, join(outDir, flat));

            bytes += readFileSync(source).byteLength;
            written.set(path, flat);
            files.push(flat);
        }

        if (files.length > 0) sounds[name] = files;
    }

    const manifest: Manifest = {
        generator: 'queep-3-arena tools/convert-sounds.ts',
        sounds,
        missing,
        stats: {
            names: Object.keys(sounds).length,
            files: written.size,
            kilobytes: Math.round(bytes / 1024),
            missing: missing.length,
            maps: fromMaps.maps,
            fromMaps: Object.keys(fromMaps.sounds).length,
        },
    };

    writeFileSync(join(outDir, 'sounds.json'), JSON.stringify(manifest, null, 1));

    console.log(
        `sounds: ${manifest.stats['names']} names, ${manifest.stats['files']} files, ` +
        `${manifest.stats['kilobytes']} KB` +
        `\n  ${manifest.stats['fromMaps']} named by ${manifest.stats['maps']} built maps ` +
        `(run this again after converting a map)` +
        (missing.length > 0 ? `\n  missing: ${missing.join(', ')}` : '')
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    convertSounds();
}
