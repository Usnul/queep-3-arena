/*
 * audio.ts -- the audio page: three faders, over meep's own mixer.
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
 * Three rows, and every one of the three decisions behind them is about *which
 * gain node* rather than about the control -- because the control is a slider,
 * and the routing is where this can quietly be wrong.
 *
 * **Master is the `SoundEngine`'s gain node, and not sopra's master bus.** Those
 * look interchangeable and are not. `ProbeReverbRenderer` is constructed
 * `new ProbeReverbRenderer(sound.context, sound.destination)`, so its wet return
 * mixes into the engine's destination -- *outside* the sopra bus tree. A master
 * fader on sopra's `master` bus would pull the dry signal down and leave the
 * reverberation of it where it was: turn the volume to zero in a hall and the
 * room would still be audible. The `SoundEngine`'s own gain node is downstream
 * of both and is therefore the only node in the graph that is actually a
 * master. See `configureAcoustics` in `main.ts` for the send that makes this so.
 *
 * **Effects writes two buses.** `AudioBank` routes one-shots to `effects` and
 * looping map speakers to `ambient` (`LOOP_3D`), which is a mixing distinction
 * and not one a player has a word for: a burning brazier and the rocket that
 * flew past it are both "the game making noise". Q3 did not split them either
 * -- `s_volume` covered everything `S_Base` mixed, loops included. So one row
 * moves both, and its note says so rather than leaving a player to discover that
 * the fire in the corner ignores the volume control.
 *
 * **A fader is a fraction of the mix the engine ships, not an absolute gain.**
 * `SopraEngine.defaultBuses()` is not flat: effects sits at 1.2 and music at
 * 0.1, which the engine calls the legacy mix. A slider that wrote a linear gain
 * and defaulted to 1.0 would therefore *quieten* every effect and raise the
 * background track by 20 dB on the first frame the menu applied its defaults --
 * a settings screen that changes the game by existing. Each row instead reads
 * its bus's shipped level once, before anything has written to it, and scales
 * that. 100% is the mix as shipped, whatever the engine ships next.
 *
 * The consequence is that these faders attenuate and do not boost, which is what
 * a volume control is for. If the music at 100% is too quiet, that is the
 * engine's mix, and the place to argue with it is the bus definition.
 */

import type { Setting, SettingsPage } from './Settings.ts';

/**
 * The one property on meep's `SoundEngine` this page writes.
 *
 * `volume` is a real accessor over the master `GainNode`, installed with
 * `Object.defineProperties` in the constructor -- and it is absent from
 * `SoundEngine.d.ts`, which declares only the fields assigned through `this`.
 * So the property exists, works, and cannot be seen by TypeScript: GAP-034, and
 * the reason `main.ts` casts rather than this file asking for the class.
 */
export interface MasterHost {
    volume: number;
}

/**
 * sopra's `BusGraph`, narrowed to the three calls a fader makes.
 *
 * `has` is asked before either of the others because the bus tree is
 * replaceable -- `SopraEngine.setBuses` takes any list of `BusDefinition`s --
 * and a `getVolume` on a bus that is not in the graph is not a question a
 * settings page should be answering with an exception.
 */
export interface MixerHost {
    has(id: string): boolean;
    getVolume(id: string): number;
    setVolume(id: string, linear: number): void;
}

export interface AudioPageHosts {
    /**
     * Null when the engine started without sound, which is a browser refusing an
     * `AudioContext` rather than an error. The page still builds, still saves,
     * and writes nothing.
     */
    readonly master: MasterHost | null;
    /** Null until a sound system has called `obtainSopra`. Same reasoning. */
    readonly buses: MixerHost | null;
}

/** sopra's own bus ids, kept stable by the engine "so the settings UI keeps resolving". */
const BUS_EFFECTS = 'effects';
const BUS_AMBIENT = 'ambient';
const BUS_MUSIC = 'music';

/**
 * Where the three faders start: all the way up, which is the mix as shipped.
 *
 * Not so much a taste decision as the absence of one. The port has no mix of its
 * own to assert -- the balance between a rocket and a background track is
 * `defaultBuses()`'s, and this page scales it rather than replacing it -- so the
 * honest default is the one that changes nothing.
 */
export const VOLUME_DEFAULT = 1;

/** 5% notches: fine enough to find a level, coarse enough to hit one. */
const VOLUME_STEP = 0.05;

/**
 * Build the audio page.
 *
 * The shipped levels are read here, once, and that timing is load-bearing: it
 * has to happen before any fader has written, or a page built a second time
 * would capture its own output and the mix would ratchet down by whatever the
 * player had chosen. The page is built once per session, from `main.ts`, before
 * `applyAll` and long before storage arrives.
 */
export function audioPage(hosts: AudioPageHosts): SettingsPage {
    const { master, buses } = hosts;

    /** The engine's own level for a bus, or null if there is no such bus. */
    const shipped = (id: string): number | null =>
        buses !== null && buses.has(id) ? buses.getVolume(id) : null;

    const shippedEffects = shipped(BUS_EFFECTS);
    const shippedAmbient = shipped(BUS_AMBIENT);
    const shippedMusic = shipped(BUS_MUSIC);

    /** Scale a bus by the fader, if the bus is there to scale. */
    const fade = (id: string, base: number | null, fraction: number): void => {
        if (buses === null || base === null) return;
        buses.setVolume(id, base * fraction);
    };

    const percent = (v: number): string => `${Math.round(v * 100)}%`;

    const settings: Setting[] = [
        {
            kind: 'slider',
            id: 'volume-master',
            section: 'Volume',
            label: 'Master',
            note: 'Everything, reverberation included -- the last gain before the speakers.',
            initial: VOLUME_DEFAULT,
            min: 0,
            max: 1,
            step: VOLUME_STEP,
            format: percent,
            apply: (v) => {
                /*
                 The `SoundEngine`'s node rather than sopra's `master` bus. See
                 the file header: the reverb return joins the graph below the bus
                 tree, so the bus is not the last word and this is.
                */
                if (master !== null) master.volume = v;
            },
        },
        {
            kind: 'slider',
            id: 'volume-effects',
            section: 'Volume',
            label: 'Effects',
            note: "Weapons, impacts, pickups, and the map's own looping ambience.",
            initial: VOLUME_DEFAULT,
            min: 0,
            max: 1,
            step: VOLUME_STEP,
            format: percent,
            apply: (v) => {
                fade(BUS_EFFECTS, shippedEffects, v);
                // The looping speakers, which are a separate bus and not a
                // separate thing to a player. See the file header.
                fade(BUS_AMBIENT, shippedAmbient, v);
            },
        },
        {
            kind: 'slider',
            id: 'volume-music',
            section: 'Volume',
            label: 'Music',
            note: "The background track the map's `worldspawn` asks for, where it has one.",
            initial: VOLUME_DEFAULT,
            min: 0,
            max: 1,
            step: VOLUME_STEP,
            format: percent,
            apply: (v) => {
                fade(BUS_MUSIC, shippedMusic, v);
            },
        },
    ];

    return {
        id: 'audio',
        title: 'Audio',
        settings,
        note:
            'Full is the mix the engine ships rather than unity gain, so these faders quieten ' +
            'and do not boost: the balance between a rocket and a background track is ' +
            "sopra's, and this page scales it. What the level does to a sound -- the wall it " +
            'is heard through, the reverberation of the room it is in -- is measured from the ' +
            'map rather than chosen here.',
    };
}
