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
 *   *.ogg           the files themselves, path-flattened
 *
 * Transcoded to Ogg Vorbis, which is what a web target wants and what this tree
 * can afford: OA ships these as 11-44.1 kHz mono PCM WAV, 7.6 MB of it, and
 * `assets/` is committed. Vorbis brings that to 1.2 MB. It is not a new format
 * dependency either -- the bank already carried one Vorbis file, `music/OA14.ogg`,
 * OA's own music, through the same `decodeAudioData` path every other sound
 * takes. Opus was measured against it and is not better here; see D-175.
 *
 * A source that is already Ogg is copied rather than re-encoded, because lossy
 * to lossy is generation loss bought for nothing.
 *
 * Every transcode is verified by decoding it back and comparing it against the
 * source, sample for sample. A lapped transform does not have to return the
 * length it was given, and most of the failures worth catching here -- the wrong
 * file, a leading delay, a channel dropped -- show up as a signal that no longer
 * correlates with the one that went in. Same reason `bake-audio.ts` reads its
 * own output back rather than trusting a serializer.
 *
 * Needs `ffmpeg` on PATH, built with libvorbis. See README's Setup.
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

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { soundName, speakerNoisePath } from '../src/q3/soundName.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const BUILT = join(ROOT, 'assets', 'built');

/**
 * Vorbis quality, as ffmpeg's `-q:a`.
 *
 * Measured over the whole bank against 7,768 KB of source WAV: q3 is 1,075 KB,
 * q4 is 1,136 KB, q5 is 1,260 KB and q6 is 1,416 KB. The 124 KB between q4 and
 * q5 buys a uniform 1.6 dB across every file, on a bank that is 1.2 MB either
 * way, so it is bought. Above q5 the curve stops paying: q6 costs another
 * 156 KB for 1.4 dB on material that was 11-44.1 kHz mono to begin with.
 */
const VORBIS_QUALITY = 5;

/**
 * How far the Ogg's declared length may sit from the source's, in samples.
 *
 * One, for the rounding in reading a duration back as seconds. It is otherwise
 * exact, and it is checked *here* rather than by decoding, because the two
 * decoders to hand disagree about what a Vorbis file's length even is: over
 * these 85 files ffmpeg's returns up to 256 samples fewer than the granule
 * positions declare, and Chrome's returns between 14 and 1,111 samples more,
 * padding out to whole blocks. Neither is losing or inventing audio -- the
 * signals correlate at offset zero and the declared lengths are exact -- so a
 * check against either decoder's idea of length would be a check on the
 * decoder. What the encoder is answerable for is the file, and the file says
 * how long it is.
 *
 * The padding is not free at the runtime end, though: it is why the bank
 * carries a duration per file and why `Audio.ts` hands it to `loopEnd`. See
 * D-175.
 */
const LENGTH_TOLERANCE = 1;

/**
 * How poorly a decoded file may correlate with its source before the transcode
 * is treated as broken rather than merely lossy, in dB.
 *
 * Deliberately far below the measured worst, which is 11.4 dB on
 * `item/item_quad` -- a loud noisy pickup, where a perceptual codec substitutes
 * noise it does not have to reproduce and signal-to-noise stops meaning very
 * much. This is not a quality gate and would be a bad one: it is a wiring
 * check, and the failures it exists to catch -- the wrong file encoded, a
 * leading delay shifting every sample, a stereo source silently collapsed, an
 * encoder that wrote nothing -- all land at or below zero.
 */
const CORRELATION_FLOOR = 3;

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
    /** What encoded the bank, because a Vorbis file is a function of its encoder. */
    readonly encoder: string;
    /** Logical name -> written filenames, in the order Q3 would pick between. */
    readonly sounds: Readonly<Record<string, string[]>>;
    /**
     * Written filename -> how much audio is really in it, in seconds.
     *
     * The source's length, not the decoder's. A browser decoding Vorbis hands
     * back whole blocks and so overshoots by up to 23 ms, which for a one-shot
     * is a decay tail nobody notices and for a loop is a hole at the seam once
     * a second. `Audio.ts` spends this on `loopEnd`.
     */
    readonly durations: Readonly<Record<string, number>>;
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

/**
 * The written filename for a Q3 path.
 *
 * Flattened, because the manifest is one directory: `sound/world/wind1.wav`
 * becomes `world_wind1.ogg`. The extension moves with the encoding and the
 * *name* does not -- `soundName` strips the extension for exactly this reason,
 * so nothing downstream has to know which of the two a sound arrived as.
 */
function flatName(path: string): string {
    return path
        .replace(/^sound\//, '')
        .replace(/[\\/]/g, '_')
        .replace(/\.wav$/i, '.ogg');
}

/** ffmpeg's version line, and the check that it is there to give one. */
function ffmpegVersion(): string {
    let out: string;
    try {
        out = execFileSync('ffmpeg', ['-version'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
    } catch {
        throw new Error(
            'ffmpeg is not on PATH. The sound bank is transcoded to Ogg Vorbis, so this ' +
            'converter needs it -- see README, Setup.'
        );
    }

    if (!out.includes('--enable-libvorbis')) {
        throw new Error(
            'this ffmpeg was built without libvorbis, which is what encodes the bank. ' +
            'Its configuration line is in `ffmpeg -version`.'
        );
    }

    return out.split('\n', 1)[0]!.trim();
}

/** Transcode one file to Ogg Vorbis, preserving its sample rate and channels. */
function encode(source: string, out: string): void {
    execFileSync(
        'ffmpeg',
        [
            '-y',
            '-v', 'error',
            '-i', source,
            // Nothing in a Q3 WAV's chunks is worth carrying, and dropping it
            // keeps the output a function of the audio alone.
            '-map_metadata', '-1',
            /*
             The same input has to produce the same bytes, because `assets/` is
             committed and the README tells you to run this again every time a
             map is converted. Without these the audio is identical and the file
             is not: ffmpeg gives each Ogg stream a random serial number, so all
             85 files came out with different checksums on every run -- 24 bytes
             each, the serial and the page CRCs that follow from it. `bitexact`
             also drops the encoder's vendor string from the comment header,
             which is the other thing in here that is a property of the tool
             rather than of the sound.
            */
            '-fflags', '+bitexact',
            '-flags:a', '+bitexact',
            '-c:a', 'libvorbis',
            '-q:a', String(VORBIS_QUALITY),
            out,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] }
    );
}

/**
 * Decode a file to mono float samples at its own sample rate.
 *
 * No `-ar`: the encoder does not resample, so the source and its transcode come
 * back at the same rate and are directly comparable. Asking for a rate here
 * would put a resampler between the two and measure that instead.
 */
function decode(path: string): Float32Array {
    const raw = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-'],
        { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 }
    );

    if ((raw.byteLength & 3) !== 0) {
        throw new Error(`${path}: decoded to ${raw.byteLength} bytes, which is not whole f32 samples`);
    }

    // Copied into an array of its own: `execFileSync` hands back a Buffer that
    // may be a view into a pool at an offset `Float32Array` cannot start at.
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);

    return new Float32Array(bytes.buffer);
}

/**
 * The sample rate in a RIFF/WAVE header.
 *
 * Only so the round-trip report can speak in milliseconds; a delta counted in
 * samples says nothing about whether a loop will click. The chunks are walked
 * rather than assumed, because `fmt ` is only *usually* the first one.
 */
function wavSampleRate(source: string): number {
    const wav = readFileSync(source);

    if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
        wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`${source}: not a RIFF/WAVE file`);
    }

    for (let at = 12; at + 8 <= wav.length;) {
        const size = wav.readUInt32LE(at + 4);

        // The rate is bytes 12..15 of the chunk body, so 16 have to be there.
        if (wav.toString('ascii', at, at + 4) === 'fmt ' && at + 16 <= wav.length) {
            return wav.readUInt32LE(at + 12);
        }

        // Chunks are word-aligned, and an odd size carries a pad byte.
        at += 8 + size + (size & 1);
    }

    throw new Error(`${source}: RIFF/WAVE with no \`fmt \` chunk`);
}

/** How long a file says it is, in seconds, from its container. */
function declaredSeconds(path: string): number {
    const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        { stdio: ['ignore', 'pipe', 'inherit'] }
    ).toString().trim();

    const seconds = Number(out);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${path}: no usable duration (\`ffprobe\` said ${JSON.stringify(out)})`);
    }

    return seconds;
}

interface RoundTrip {
    readonly samples: number;
    readonly rate: number;
    /** What the Ogg's granule positions say it holds, in samples. */
    readonly declared: number;
    /** How well the transcode correlates with its source, in dB. */
    readonly decibels: number;
}

/** Read a transcode back and measure it against the source it came from. */
function verify(source: string, out: string): RoundTrip {
    const rate = wavSampleRate(source);

    const before = decode(source);
    const after = decode(out);

    /*
     Over what the two decoders agree exists. ffmpeg stops short of the declared
     end by up to a block, so the last few milliseconds are simply not on offer
     here; `LENGTH_TOLERANCE` is what covers that end, and this covers whether
     the samples in between are the same sound at the same offset.
    */
    const overlap = Math.min(before.length, after.length);

    let error = 0;
    let signal = 0;

    for (let i = 0; i < overlap; i++) {
        const difference = before[i]! - after[i]!;
        error += difference * difference;
        signal += before[i]! * before[i]!;
    }

    return {
        samples: before.length,
        rate,
        declared: Math.round(declaredSeconds(out) * rate),
        // A silent source correlates with a silent transcode; say so rather
        // than dividing by zero and calling a legitimate file broken.
        decibels: signal === 0 ? Infinity : 10 * Math.log10(signal / (error || Number.MIN_VALUE)),
    };
}

function convertSounds(): void {
    const encoder = ffmpegVersion();

    const outDir = join(BUILT, 'sound');
    mkdirSync(outDir, { recursive: true });

    const fromMaps = mapSounds();
    const all: Record<string, string | string[]> = {
        ...SOUNDS,
        ...itemSounds(),
        ...fromMaps.sounds,
    };

    const sounds: Record<string, string[]> = {};
    const durations: Record<string, number> = {};
    const missing: string[] = [];
    const written = new Map<string, string>();
    const damaged: string[] = [];

    let bytes = 0;
    let sourceBytes = 0;
    let copied = 0;
    let worstCorrelation: { file: string; trip: RoundTrip } | null = null;

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

            const flat = flatName(path);
            const out = join(outDir, flat);

            /*
             Two Q3 paths cannot share one written name. They could not before
             either -- `a/b.wav` and `a_b.wav` flatten alike -- but moving every
             extension to `.ogg` adds a way for it to happen that was not there
             before: `x/y.wav` and `x/y.ogg` are two distinct files upstream and
             one file here. The second would silently overwrite the first and
             both manifest entries would point at whichever won.
            */
            const clash = [...written].find(([, name]) => name === flat);
            if (clash !== undefined) {
                throw new Error(`${path} and ${clash[0]} both flatten to ${flat}`);
            }

            if (/\.wav$/i.test(path)) {
                encode(source, out);

                const trip = verify(source, out);

                if (Math.abs(trip.declared - trip.samples) > LENGTH_TOLERANCE) {
                    damaged.push(
                        `${flat}: ${trip.samples} samples went in and the file says ${trip.declared}`
                    );
                } else if (trip.decibels < CORRELATION_FLOOR) {
                    damaged.push(`${flat}: decodes to ${trip.decibels.toFixed(1)} dB of its source`);
                }

                if (worstCorrelation === null || trip.decibels < worstCorrelation.trip.decibels) {
                    worstCorrelation = { file: flat, trip };
                }

                durations[flat] = trip.samples / trip.rate;
            } else {
                // Already Ogg -- OA's music. Re-encoding it would be a second
                // generation of loss for nothing.
                copyFileSync(source, out);
                copied += 1;

                durations[flat] = declaredSeconds(out);
            }

            bytes += statSync(out).size;
            sourceBytes += statSync(source).size;
            written.set(path, flat);
            files.push(flat);
        }

        if (files.length > 0) sounds[name] = files;
    }

    if (damaged.length > 0) {
        throw new Error(
            `the round trip damaged ${damaged.length} of ${written.size} files:\n  ` +
            damaged.join('\n  ')
        );
    }

    const manifest: Manifest = {
        generator: 'queep-3-arena tools/convert-sounds.ts',
        encoder: `${encoder}, libvorbis -q:a ${VORBIS_QUALITY}`,
        sounds,
        durations,
        missing,
        stats: {
            names: Object.keys(sounds).length,
            files: written.size,
            kilobytes: Math.round(bytes / 1024),
            sourceKilobytes: Math.round(sourceBytes / 1024),
            missing: missing.length,
            maps: fromMaps.maps,
            fromMaps: Object.keys(fromMaps.sounds).length,
        },
    };

    writeFileSync(join(outDir, 'sounds.json'), JSON.stringify(manifest, null, 1));

    console.log(
        `sounds: ${manifest.stats['names']} names, ${manifest.stats['files']} files, ` +
        `${manifest.stats['kilobytes']} KB ` +
        `(from ${manifest.stats['sourceKilobytes']} KB; ` +
        `${written.size - copied} transcoded to Vorbis -q:a ${VORBIS_QUALITY}, ` +
        `${copied} already Ogg and copied)` +
        (worstCorrelation === null
            ? ''
            : `\n  every transcode declares its source's length; the weakest correlation is ` +
              `${worstCorrelation.file} at ${worstCorrelation.trip.decibels.toFixed(1)} dB`) +
        `\n  ${manifest.stats['fromMaps']} named by ${manifest.stats['maps']} built maps ` +
        `(run this again after converting a map)` +
        (missing.length > 0 ? `\n  missing: ${missing.join(', ')}` : '')
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
    convertSounds();
}
