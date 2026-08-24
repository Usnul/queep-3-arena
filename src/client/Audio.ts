/*
 * Audio.ts -- the sound bank, on meep's sopra engine.
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
 * Q3's sound model is `S_StartSound(origin, entity, channel, handle)`: a
 * fire-and-forget one-shot at a point, and nothing else for anything a weapon or
 * a pickup does. sopra's `playOneShot(description, { position })` is the same
 * shape, so this is a bank of `EventDescription`s and a function that plays one.
 *
 * The alternative -- an `AudioEmitter` component per sound -- is the right
 * answer for a torch that hums, and the wrong one for a machinegun firing ten
 * times a second: it would mean an entity built and destroyed per shot, and
 * `AudioEmitterSystem`'s docblock is explicit that only *looping* events take
 * the spatially-managed path anyway. `AudioEmitterSystem` is still registered,
 * because it is what creates the sopra engine, forwards the listener pose and
 * ticks the mixer.
 *
 * Random variants are picked here rather than by a `RandomContainerAudioClip`,
 * which is the more faithful arrangement: Q3 picks the index itself
 * (`rand() % 4` in `CG_FireWeapon`), so the choice belongs to the game rather
 * than to the audio engine.
 */

import { SampleAudioClip } from '@woosh/meep-engine/src/engine/sound/sopra/definition/clip/SampleAudioClip.js';
import { EventDescription } from '@woosh/meep-engine/src/engine/sound/sopra/definition/EventDescription.js';
import { buildAttenuationCurve } from '@woosh/meep-engine/src/engine/sound/sopra/util/buildAttenuationCurve.js';
import { interpolate_irradiance_smith } from '@woosh/meep-engine/src/core/math/physics/irradiance/interpolate_irradiance_smith.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

const WORLD_SCALE = 1 / 32;

/**
 * Q3's own falloff bounds, converted.
 *
 * `S_Base`'s `SOUND_RANGE_DEFAULT` is 1250 units, which is 39 m at this port's
 * scale, and `SOUND_FULLVOLUME` is 80 units. Those two numbers are why a rocket
 * across a Q3 arena is faintly audible rather than silent, and why standing next
 * to a plasma gun is loud: the level is flat inside 2.5 m and falls away over
 * the next 36.
 */
const DISTANCE_MIN = 80 * WORLD_SCALE;
const DISTANCE_MAX = 1250 * WORLD_SCALE;

interface Manifest {
    readonly sounds: Readonly<Record<string, string[]>>;
    readonly missing: readonly string[];
    readonly stats: Readonly<Record<string, number>>;
}

interface SopraLike {
    playOneShot(
        description: unknown,
        options?: { busId?: string; position?: unknown; maxLifetime?: number }
    ): unknown;
}

export class AudioBank {
    private readonly manifest: Manifest;
    private readonly baseUrl: string;
    private readonly sopra: SopraLike | null;

    /** `${name}#${variant}` -> description, built on first play. */
    private readonly cache = new Map<string, EventDescription>();

    /** Reused, because a one-shot per shot must not allocate a vector per shot. */
    private readonly scratch = new Vector3();

    /** Names something asked for that the manifest does not have. Reported once each. */
    readonly unknown: string[] = [];

    /** Off until the AudioContext is resumed, which needs a user gesture. */
    enabled = false;

    constructor(manifest: Manifest, baseUrl: string, sopra: SopraLike | null) {
        this.manifest = manifest;
        this.baseUrl = baseUrl;
        this.sopra = sopra;
    }

    static async load(baseUrl: string, sopra: SopraLike | null): Promise<AudioBank> {
        const response = await fetch(`${baseUrl}/sounds.json`);
        if (!response.ok) throw new Error(`${baseUrl}/sounds.json: HTTP ${response.status}`);

        return new AudioBank((await response.json()) as Manifest, baseUrl, sopra);
    }

    get stats(): Readonly<Record<string, number>> {
        return this.manifest.stats;
    }

    /**
     * A description for one variant of a named sound.
     *
     * `distanceMin`/`distanceMax`/`attenuation` all take part in
     * `EventDescription.hash`, which the voice manager buckets instances by, so
     * they are set once here and never touched afterwards -- the component's
     * own docblock warns that editing them on a sounding emitter files that
     * instance under a hash it can no longer be found by.
     */
    private describe(name: string, variant: number, is3D: boolean): EventDescription | null {
        const key = `${name}#${variant}#${is3D ? 3 : 2}`;

        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        const files = this.manifest.sounds[name];
        if (files === undefined || files.length === 0) {
            if (!this.unknown.includes(name)) this.unknown.push(name);
            return null;
        }

        const clip = SampleAudioClip.from(`${this.baseUrl}/${files[variant % files.length]!}`, {
            /*
             A little pitch variation on every sample. Q3 does not do this and
             does not need to -- it ships four machinegun flashes and four
             footsteps precisely so the repetition is not audible -- but the
             sets are small and a few percent of pitch spread costs nothing.
             Deliberately small enough not to be heard as an effect.
            */
            pitchRandom: 0.04,
        });

        const description = EventDescription.from(name, clip, {
            is3D,
            distanceMin: DISTANCE_MIN,
            distanceMax: DISTANCE_MAX,
            /*
             Smith rather than linear: it sheds two thirds of its level inside
             the first seventh of the range, which is much closer to Q3's own
             1/r-ish falloff than a straight line, and the curve builder puts
             its keyframes where that curvature is.
            */
            attenuation: is3D
                ? buildAttenuationCurve(DISTANCE_MIN, DISTANCE_MAX, interpolate_irradiance_smith, 0.02)
                : undefined,
            /*
             A machinegun at 100 ms a shot with three players firing is 30 live
             voices of one event. The cap is Q3's own `MAX_CHANNELS`-era
             behaviour rather than a guess at what sounds right.
            */
            maxInstances: 16,
        });

        this.cache.set(key, description);
        return description;
    }

    /** `S_StartSound` at a point, in Q3 units. */
    play(name: string, originQ3: ArrayLike<number>, variant = -1): void {
        if (!this.enabled || this.sopra === null) return;

        const files = this.manifest.sounds[name];
        if (files === undefined) {
            if (!this.unknown.includes(name)) this.unknown.push(name);
            return;
        }

        const pick = variant >= 0 ? variant : (Math.random() * files.length) | 0;
        const description = this.describe(name, pick, true);
        if (description === null) return;

        this.scratch.set(
            originQ3[0]! * WORLD_SCALE,
            originQ3[2]! * WORLD_SCALE,
            -originQ3[1]! * WORLD_SCALE
        );

        this.sopra.playOneShot(description, { position: this.scratch });
    }

    /** `S_StartLocalSound`: no position, no falloff -- pickups, feedback, the empty click. */
    playLocal(name: string, variant = -1): void {
        if (!this.enabled || this.sopra === null) return;

        const files = this.manifest.sounds[name];
        if (files === undefined) {
            if (!this.unknown.includes(name)) this.unknown.push(name);
            return;
        }

        const pick = variant >= 0 ? variant : (Math.random() * files.length) | 0;
        const description = this.describe(name, pick, false);
        if (description === null) return;

        this.sopra.playOneShot(description, {});
    }
}

/**
 * `CG_PlayerAnimation`'s footstep timing, which is not a timer.
 *
 * Q3 fires a footstep from the *animation*, at two fixed points in the leg
 * cycle, so steps speed up with the run rather than drifting against it. There
 * is no animation driving the local player here -- it is a first-person camera
 * -- so the cycle is reconstructed from distance travelled, which is the same
 * quantity the animation is a function of.
 *
 * 96 units is the stride `LEGS_RUN` covers in one cycle at Q3's run speed.
 */
export class Footsteps {
    private distance = 0;
    private wasOnGround = true;

    /** Q3 units between steps. Two per cycle, so half the stride. */
    private static readonly STRIDE = 48;

    /**
     * @returns `'step'`, `'land'` or `null` for this frame.
     */
    update(speed: number, onGround: boolean, deltaSeconds: number): 'step' | 'land' | null {
        const landed = onGround && !this.wasOnGround;
        this.wasOnGround = onGround;

        if (landed) {
            this.distance = 0;
            return 'land';
        }

        if (!onGround) return null;

        this.distance += speed * deltaSeconds;

        if (this.distance >= Footsteps.STRIDE) {
            this.distance -= Footsteps.STRIDE;
            // Below a walk, Q3 plays no footstep at all.
            return speed > 60 ? 'step' : null;
        }

        return null;
    }
}
