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
 * Usage:  node tools/convert-sounds.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    'weapon/empty': 'sound/weapons/noammo.wav',
    'weapon/change': 'sound/weapons/change.wav',

    /* ---- weapons: impact ---- */
    'impact/bullet': [
        'sound/weapons/machinegun/ric1.wav',
        'sound/weapons/machinegun/ric2.wav',
        'sound/weapons/machinegun/ric3.wav',
    ],
    'impact/rocket': 'sound/weapons/rocket/rocklx1a.wav',
    'impact/plasma': 'sound/weapons/plasma/plasmx1a.wav',
    'impact/grenade': 'sound/weapons/grenade/hgrenb1a.wav',
    'impact/lightning': 'sound/weapons/lightning/lg_hit.wav',
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

function convertSounds(): void {
    const outDir = join(BUILT, 'sound');
    mkdirSync(outDir, { recursive: true });

    const all: Record<string, string | string[]> = { ...SOUNDS, ...itemSounds() };

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

            const source = join(EXTRACTED, path);
            if (!existsSync(source)) {
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
        },
    };

    writeFileSync(join(outDir, 'sounds.json'), JSON.stringify(manifest, null, 1));

    console.log(
        `sounds: ${manifest.stats['names']} names, ${manifest.stats['files']} files, ` +
        `${manifest.stats['kilobytes']} KB` +
        (missing.length > 0 ? `\n  missing: ${missing.join(', ')}` : '')
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    convertSounds();
}
