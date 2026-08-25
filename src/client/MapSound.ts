/*
 * MapSound.ts -- the sound the map itself owns: ambience and the background track.
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
 * Two things in a Q3 map make sound without anything happening.
 *
 * `target_speaker` with the `looped-on` spawnflag is a point in the world that
 * hums. `SP_target_speaker` gives it `ent->s.loopSound = ent->noise_index` and
 * `ent->s.eType = ET_SPEAKER`, and the client then plays it every frame from
 * `CG_EntityEffects` -- through `trap_S_AddRealLoopingSound` rather than
 * `trap_S_AddLoopingSound`, the "real" variant meaning it is not merged with
 * other copies of the same sound the way ordinary entity loops are. `oa_dm5`
 * has 22 of them, nineteen the same fire loop, which is exactly the case the
 * merge exists for; here the `LiveEmitterSet` budget does that job instead, by
 * only sounding the nearest few.
 *
 * And `worldspawn` carries a `music` key, which `SP_worldspawn` copies into
 * `CS_MUSIC` and `CG_StartMusic` hands to `trap_S_StartBackgroundTrack`.
 *
 * Both were listed as mapped in the trap matrix long before either was built.
 * See D-066.
 */

import type { BundleEntity } from './map/SceneBundle.ts';
import type { AudioBank, SoundLoop } from './Audio.ts';
import { soundName, speakerNoisePath } from '../q3/soundName.ts';

/** `target_speaker` spawnflags, from the `/*QUAKED` block in `g_target.c`. */
const SPEAKER_LOOPED_ON = 1;
const SPEAKER_LOOPED_OFF = 2;

export interface MapSoundStats {
    /** Looping speakers started. */
    readonly speakers: number;
    /** Speakers seen and deliberately not started, by reason. */
    readonly skipped: readonly string[];
    /** The track that started, or null. */
    readonly music: string | null;
}

/**
 * Start a map's ambience and its background track.
 *
 * Handles come back so a map change can stop them, which is the whole of what
 * `S_StopLoopingSound` and `S_StopBackgroundTrack` are for here. Nothing calls
 * that yet -- the port loads one map per page -- but a bank that can only ever
 * start sounds is a bank that leaks on the first thing that unloads a map.
 */
export class MapSound {
    private readonly bank: AudioBank;
    private readonly loops: SoundLoop[] = [];

    readonly stats: MapSoundStats;

    constructor(bank: AudioBank, entities: readonly BundleEntity[]) {
        this.bank = bank;

        const skipped: string[] = [];
        let speakers = 0;

        for (const entity of entities) {
            if (entity.classname !== 'target_speaker') continue;

            const flags = Number(entity['spawnflags'] ?? 0) | 0;

            /*
             A speaker with neither looped flag is a triggered one-shot -- it
             waits for a `target` to fire it, and its `wait`/`random` keys are
             the repeat interval Q3 gives it once fired. Nothing in this port
             fires map targets, so starting it would be inventing a sound the
             map does not make. `looped-off` is the same speaker pre-armed but
             silent, and is skipped for the same reason.
            */
            if ((flags & SPEAKER_LOOPED_ON) === 0) {
                skipped.push((flags & SPEAKER_LOOPED_OFF) !== 0 ? 'looped-off' : 'triggered');
                continue;
            }

            const noise = entity['noise'];
            if (typeof noise !== 'string') {
                skipped.push('no noise key');
                continue;
            }

            const path = speakerNoisePath(noise);
            if (path === null) {
                skipped.push(`client-relative ${noise}`);
                continue;
            }

            /*
             `spawnflags & 4` is `global`, which sets `SVF_BROADCAST` -- the
             server sends the entity to every client regardless of PVS. It is a
             transmission flag, not a mixing one: the client still spatializes
             it from its origin. This port has no PVS to be culled by, so the
             flag is already honoured by doing nothing.
            */
            const loop = this.bank.loop(soundName(path), entity._originQ3);

            if (loop === null) {
                skipped.push(`missing ${path}`);
                continue;
            }

            this.loops.push(loop);
            speakers += 1;
        }

        const worldspawn = entities.find((e) => e.classname === 'worldspawn');
        const track = worldspawn?.['music'];
        let music: string | null = null;

        if (typeof track === 'string' && track.trim().length > 0) {
            /*
             `CG_StartMusic` parses two tokens: an intro and a loop. No map this
             port ships names a second, so the first is both -- which is what Q3
             does with an empty loop token.
            */
            const name = soundName(track.trim().split(/\s+/)[0]!);

            const before = bank.unknown.length;
            bank.music(name);

            // The bank reports a name it does not have by appending to `unknown`.
            if (bank.unknown.length === before) music = name;
            else skipped.push(`missing music ${track}`);
        }

        this.stats = { speakers, skipped, music };
    }

    /** `S_StopLoopingSound` over the lot, plus `S_StopBackgroundTrack`. */
    stop(): void {
        for (const loop of this.loops) loop.stop();
        this.loops.length = 0;
        this.bank.stopMusic();
    }
}
