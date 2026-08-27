/*
 * Audio.ts -- the sound bank, on meep's AudioEmitter components.
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
 * Every sound in the port is an `AudioEmitter` component on an entity with a
 * `Transform`, played by `AudioEmitterSystem`. One path, whatever the sound is.
 *
 * Q3's sound API is four calls, and they differ only in what owns the sound and
 * for how long:
 *
 *   S_StartSound(origin, ...)      a one-shot at a point           -> play
 *   S_StartLocalSound(...)         a one-shot with no position     -> playLocal
 *   S_AddLoopingSound(ent, ...)    a loop that lives on an entity  -> loop
 *   S_StartBackgroundTrack(...)    a loop with no position         -> music
 *
 * An emitter expresses all four, because the two axes Q3 varies -- positioned or
 * not, finite or looping -- are exactly `EventDescription.is3D` and whether the
 * root clip loops. `AudioEmitterSystem` reads that pair once at link and routes
 * accordingly: a looping 3D emitter is registered with the `LiveEmitterSet` and
 * only sounds while it is among the nearest in range, and everything else plays
 * directly. So `S_AddLoopSounds`' "rebuild the loop set every frame, nearest
 * wins" is the system's job here rather than this file's, and the entity's
 * `Transform` is `S_UpdateEntityPosition` -- a rocket's fly sound follows the
 * rocket because the position vector the emitter was registered with is the one
 * the rocket writes.
 *
 * An earlier version of this file played one-shots straight into the sopra
 * engine and reserved emitters for loops, on the grounds that a machinegun
 * firing ten times a second should not build and destroy an entity per shot.
 * Two code paths for one concept was the greater cost, and the saving was not
 * what it looked like: a one-shot emitter reaches the same `playEvent` the
 * direct call did, one link later. See D-065.
 *
 * Random variants are picked here rather than by a `RandomContainerAudioClip`,
 * which is the more faithful arrangement: Q3 picks the index itself
 * (`rand() % 4` in `CG_FireWeapon`), so the choice belongs to the game rather
 * than to the audio engine.
 */

import { AudioEmitter } from '@woosh/meep-engine/src/engine/sound/ecs/audio/AudioEmitter.js';
import { SampleAudioClip } from '@woosh/meep-engine/src/engine/sound/sopra/definition/clip/SampleAudioClip.js';
import { EventDescription } from '@woosh/meep-engine/src/engine/sound/sopra/definition/EventDescription.js';
import { buildAttenuationCurve } from '@woosh/meep-engine/src/engine/sound/sopra/util/buildAttenuationCurve.js';
import { interpolate_irradiance_smith } from '@woosh/meep-engine/src/core/math/physics/irradiance/interpolate_irradiance_smith.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

const WORLD_SCALE = 1 / 32;

/**
 * Q3's own falloff bounds, converted.
 *
 * `S_Base`'s `SOUND_RANGE_DEFAULT` is 1250 units, which is 39 m at this port's
 * scale, and `SOUND_FULLVOLUME` is 80 units. Those two numbers are why a rocket
 * across a Q3 arena is faintly audible rather than silent, and why standing next
 * to a plasma gun is loud: the level is flat inside 2.5 m and falls away over
 * the next 36. Loops use the same range, because `S_AddLoopSounds` spatializes
 * through the same `S_SpatializeOrigin` one-shots do.
 */
const DISTANCE_MIN = 80 * WORLD_SCALE;
const DISTANCE_MAX = 1250 * WORLD_SCALE;

/**
 * How many looping 3D emitters may sound at once.
 *
 * This is the `LiveEmitterSet` budget, and it is the port's answer to
 * `S_AddLoopSounds`, which walks every registered loop each frame and keeps the
 * nearest. `oa_dm5` registers 22 map speakers, nineteen of them the same fire
 * loop; the budget is what stops all nineteen from being nineteen live voices.
 * 24 is comfortably more than any one room of a Q3 arena can put in earshot.
 */
export const LOOP_BUDGET = 24;

/**
 * Per-event polyphony caps.
 *
 * These are separate from the budget and compose with it, which is the trap the
 * `LiveEmitterSet` docblock warns about: content-equal events share one sopra
 * polyphony bucket, so a loop cap below the budget would gate the budget and
 * make the nearest-wins promotion churn instead of settle. Loops are therefore
 * capped above `LOOP_BUDGET` and let the budget do the limiting.
 *
 * One-shots are capped at 16 for the opposite reason: a machinegun at 100 ms a
 * shot with three players firing is 30 live voices of one event, and Q3's own
 * `MAX_CHANNELS`-era behaviour is to steal rather than to mix all thirty.
 */
const ONE_SHOT_MAX_INSTANCES = 16;
const LOOP_MAX_INSTANCES = LOOP_BUDGET + 8;

/**
 * How big a sound is, in scene metres, for the acoustic occlusion test.
 *
 * Not cosmetic, and zero is not the neutral choice. `OcclusionSolver` shoots
 * its rays at points spread over a sphere this size and calls the blocked
 * fraction the occlusion, so a radius of zero sends every ray to the same point
 * and occlusion becomes **boolean** -- measured, not assumed: a source in the
 * open reads exactly 0 and one behind a wall exactly 1, with nothing in
 * between. A player walking past a doorway would hear the sound switch rather
 * than pass behind an edge.
 *
 * A third of a metre is about a Q3 player's shoulder, and it is the smallest
 * radius that still spreads the ray set enough to ramp: an edge crosses it in
 * roughly 70 ms at Q3's run speed, which the solver's own temporal EMA then
 * smooths further. Larger would ramp longer and start leaking sound around
 * corners it should not reach.
 */
const SOURCE_RADIUS = 1 / 3;

/** sopra's default bus tree: master, and effects / music / ambient under it. */
const BUS_EFFECTS = 'effects';
const BUS_MUSIC = 'music';
const BUS_AMBIENT = 'ambient';

interface Manifest {
    readonly sounds: Readonly<Record<string, string[]>>;
    readonly missing: readonly string[];
    readonly stats: Readonly<Record<string, number>>;
}

/** The part of `EntityComponentDataset` this file uses. */
interface EcsDataset {
    removeEntity(entity: number): void;
    entityExists(entity: number): boolean;
}

/** The part of `AudioEmitterSystem` this file uses. */
interface EmitterSystem {
    instanceFor(entity: number): { onEnded: { addOne(handler: () => void): void } } | null;
}

/** How a named sound is routed. Fixed for the life of an `EventDescription`. */
interface Routing {
    readonly is3D: boolean;
    readonly loop: boolean;
    readonly busId: string;
}

const ONE_SHOT_3D: Routing = { is3D: true, loop: false, busId: BUS_EFFECTS };
const ONE_SHOT_2D: Routing = { is3D: false, loop: false, busId: BUS_EFFECTS };
const LOOP_3D: Routing = { is3D: true, loop: true, busId: BUS_AMBIENT };
const LOOP_2D: Routing = { is3D: false, loop: true, busId: BUS_MUSIC };

/**
 * A live looping sound: `S_AddLoopingSound`'s half of the deal.
 *
 * Q3 has no handle -- it re-adds the loop every frame from whatever still wants
 * it, and a loop stops by not being re-added. Retained emitters are the opposite
 * arrangement, so the handle is what `S_StopLoopingSound` needs and `move` is
 * `S_UpdateEntityPosition`.
 */
export interface SoundLoop {
    /** `S_UpdateEntityPosition`: the source has moved. Q3 units. */
    move(originQ3: ArrayLike<number>): void;
    /** `S_StopLoopingSound`. Idempotent. */
    stop(): void;
}

/**
 * A loop's entity, which may not exist yet.
 *
 * The browser will not start an `AudioContext` without a user gesture, so a loop
 * asked for during map load cannot be built when it is asked for. The
 * `Transform` is real from the start -- so `move` is always a plain write, with
 * no queue and no null check -- and only the entity waits.
 */
class Loop implements SoundLoop {
    readonly transform = new Transform();

    private readonly bank: AudioBank;
    private readonly description: EventDescription;

    /** -1 until built, and again after `stop`. */
    private entity = -1;
    private stopped = false;

    constructor(bank: AudioBank, description: EventDescription, positionMeep: readonly number[]) {
        this.bank = bank;
        this.description = description;
        this.transform.position.set(positionMeep[0]!, positionMeep[1]!, positionMeep[2]!);
    }

    /** @internal Called by the bank, once audio is unlocked. */
    materialise(): void {
        if (this.stopped || this.entity !== -1) return;
        this.entity = this.bank.buildEmitter(this.description, this.transform);
    }

    move(originQ3: ArrayLike<number>): void {
        this.transform.position.set(
            originQ3[0]! * WORLD_SCALE,
            originQ3[2]! * WORLD_SCALE,
            -originQ3[1]! * WORLD_SCALE
        );
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;

        if (this.entity !== -1) {
            this.bank.destroyEmitter(this.entity);
            this.entity = -1;
        }
    }
}

export class AudioBank {
    private readonly manifest: Manifest;
    private readonly baseUrl: string;
    private readonly ecd: EcsDataset;
    private readonly system: EmitterSystem | null;

    /** `name#variant#routing` -> description, built on first play. */
    private readonly cache = new Map<string, EventDescription>();

    /**
     * One-shot entities whose instance has ended, waiting to be removed.
     *
     * `onEnded` fires from inside `AudioEmitterSystem.update` -- it is sopra's
     * own tick that notices a one-shot has finished -- and removing an entity
     * there would mutate the dataset while the system that owns it is mid-frame.
     * Draining in `update` puts the removal back on the game tick, which is the
     * same arrangement `Effects` uses for its expiring particle entities.
     */
    private readonly finished: number[] = [];

    /** Loops asked for before the first gesture, built when it arrives. */
    private readonly deferred: Loop[] = [];

    /** The background track, so a second `music` call can replace it. */
    private musicLoop: Loop | null = null;

    /** Live one-shot emitter entities. Diagnostics only. */
    private oneShots = 0;

    /** Registered looping emitters, live or dormant. Diagnostics only. */
    private loops = 0;

    /** Names something asked for that the manifest does not have. Reported once each. */
    readonly unknown: string[] = [];

    /** Off until the AudioContext is resumed, which needs a user gesture. */
    private unlocked = false;

    constructor(
        manifest: Manifest,
        baseUrl: string,
        ecd: EcsDataset,
        system: EmitterSystem | null
    ) {
        this.manifest = manifest;
        this.baseUrl = baseUrl;
        this.ecd = ecd;
        this.system = system;
    }

    static async load(
        baseUrl: string,
        ecd: EcsDataset,
        system: EmitterSystem | null
    ): Promise<AudioBank> {
        const response = await fetch(`${baseUrl}/sounds.json`);
        if (!response.ok) throw new Error(`${baseUrl}/sounds.json: HTTP ${response.status}`);

        return new AudioBank((await response.json()) as Manifest, baseUrl, ecd, system);
    }

    get stats(): Readonly<Record<string, number>> {
        return this.manifest.stats;
    }

    /**
     * Is this a sound the manifest has?
     *
     * For call sites where the absence is the answer rather than a miss: most
     * weapons have no `readySound` and Q3 plays nothing for them, so asking for
     * one and getting silence is correct and must not be reported as a sound the
     * port names and the converter failed to copy.
     */
    has(name: string): boolean {
        const files = this.manifest.sounds[name];
        return files !== undefined && files.length > 0;
    }

    get enabled(): boolean {
        return this.unlocked;
    }

    /** Live one-shot emitters, for the debug overlay. */
    get oneShotCount(): number {
        return this.oneShots;
    }

    /** Registered looping emitters, for the debug overlay and the load log. */
    get loopCount(): number {
        return this.loops;
    }

    /**
     * The first user gesture has landed and the context is running.
     *
     * Everything asked for before now was a loop, and loops are exactly the
     * sounds that should start late rather than not at all: a map's ambience is
     * not a missed event, it is a state.
     */
    enable(): void {
        if (this.unlocked) return;
        this.unlocked = true;

        for (const loop of this.deferred) loop.materialise();
        this.deferred.length = 0;
    }

    /** Retire finished one-shots. Call once per frame. */
    update(): void {
        for (let i = 0; i < this.finished.length; i++) {
            const entity = this.finished[i]!;
            if (this.ecd.entityExists(entity)) this.ecd.removeEntity(entity);
            this.oneShots -= 1;
        }

        this.finished.length = 0;
    }

    /* ------------------------------------------------------------------ *
     * The four Q3 calls.
     * ------------------------------------------------------------------ */

    /** `S_StartSound` at a point, in Q3 units. */
    play(name: string, originQ3: ArrayLike<number>, variant = -1): void {
        const description = this.pick(name, variant, ONE_SHOT_3D);
        if (description === null) return;

        this.playOneShot(description, [
            originQ3[0]! * WORLD_SCALE,
            originQ3[2]! * WORLD_SCALE,
            -originQ3[1]! * WORLD_SCALE,
        ]);
    }

    /** `S_StartLocalSound`: no position, no falloff -- pickups, feedback, the empty click. */
    playLocal(name: string, variant = -1): void {
        const description = this.pick(name, variant, ONE_SHOT_2D);
        if (description === null) return;

        this.playOneShot(description, [0, 0, 0]);
    }

    /**
     * `S_AddLoopingSound`: a loop that belongs to something in the world.
     *
     * @returns a handle, or null if the sound is not in the manifest.
     */
    loop(name: string, originQ3: ArrayLike<number>): SoundLoop | null {
        const description = this.pick(name, 0, LOOP_3D);
        if (description === null) return null;

        return this.startLoop(description, [
            originQ3[0]! * WORLD_SCALE,
            originQ3[2]! * WORLD_SCALE,
            -originQ3[1]! * WORLD_SCALE,
        ]);
    }

    /**
     * `S_StartBackgroundTrack`.
     *
     * `CG_StartMusic` parses two tokens out of `CS_MUSIC` -- an intro track and
     * a loop track -- and passes both. Every map this port ships names one, so
     * the intro is the loop, which is what Q3 does when the second is empty.
     */
    music(track: string): void {
        this.stopMusic();

        const description = this.pick(track, 0, LOOP_2D);
        if (description === null) return;

        this.musicLoop = this.startLoop(description, [0, 0, 0]);
    }

    /** `S_StopBackgroundTrack`. */
    stopMusic(): void {
        this.musicLoop?.stop();
        this.musicLoop = null;
    }

    /* ------------------------------------------------------------------ *
     * Internals.
     * ------------------------------------------------------------------ */

    /**
     * Resolve a name to a description, reporting a miss once.
     *
     * `variant` below zero means "as Q3 would": pick at random from the set.
     */
    private pick(name: string, variant: number, routing: Routing): EventDescription | null {
        const files = this.manifest.sounds[name];

        if (files === undefined || files.length === 0) {
            if (!this.unknown.includes(name)) this.unknown.push(name);
            return null;
        }

        const index = variant >= 0 ? variant : (Math.random() * files.length) | 0;

        return this.describe(name, index % files.length, routing);
    }

    /**
     * A description for one variant of a named sound, under one routing.
     *
     * `distanceMin`/`distanceMax`/`attenuation`/`maxInstances` all take part in
     * `EventDescription.hash`, which the voice manager buckets instances by, so
     * they are set once here and never touched afterwards -- the component's
     * own docblock warns that editing them on a sounding emitter files that
     * instance under a hash it can no longer be found by. Which is also why the
     * routing is part of the cache key rather than a field written later.
     */
    private describe(name: string, variant: number, routing: Routing): EventDescription {
        const key =
            `${name}#${variant}#${routing.busId}#${routing.is3D ? 3 : 2}#${routing.loop ? 'L' : 'F'}`;

        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        const file = this.manifest.sounds[name]![variant]!;

        const clip = SampleAudioClip.from(`${this.baseUrl}/${file}`, {
            loop: routing.loop,
            /*
             A little pitch variation on every sample. Q3 does not do this and
             does not need to -- it ships four machinegun flashes and four
             footsteps precisely so the repetition is not audible -- but the
             sets are small and a few percent of pitch spread costs nothing.
             Deliberately small enough not to be heard as an effect.

             Not on a loop: the spread is per trigger and a loop triggers once,
             so all it would do is detune a map's ambience by a fixed amount
             chosen at random on every load.
            */
            pitchRandom: routing.loop ? 0 : 0.04,
        });

        const description = EventDescription.from(name, clip, {
            busId: routing.busId,
            is3D: routing.is3D,
            distanceMin: DISTANCE_MIN,
            distanceMax: DISTANCE_MAX,
            /*
             Smith rather than linear: it sheds two thirds of its level inside
             the first seventh of the range, which is much closer to Q3's own
             1/r-ish falloff than a straight line, and the curve builder puts
             its keyframes where that curvature is.
            */
            attenuation: routing.is3D
                ? buildAttenuationCurve(DISTANCE_MIN, DISTANCE_MAX, interpolate_irradiance_smith, 0.02)
                : undefined,
            maxInstances: routing.loop ? LOOP_MAX_INSTANCES : ONE_SHOT_MAX_INSTANCES,
        });

        this.cache.set(key, description);
        return description;
    }

    /**
     * Build a one-shot emitter and arrange for its entity to be removed when the
     * sound ends.
     *
     * The removal matters: `AudioEmitterSystem.unlink` stops a direct instance,
     * so an entity retired on a timer that ran short would cut its own sound
     * off. Asking the instance when it ended is exact, and covers a case a
     * duration could not -- a sample whose asset fails to load ends immediately
     * rather than after its nominal length.
     */
    private playOneShot(description: EventDescription, positionMeep: readonly number[]): void {
        if (!this.unlocked || this.system === null) return;

        const transform = new Transform();
        transform.position.set(positionMeep[0]!, positionMeep[1]!, positionMeep[2]!);

        const entity = this.buildEmitter(description, transform);
        this.oneShots += 1;

        const instance = this.system.instanceFor(entity);

        if (instance === null) {
            // Denied by the event's own instance cap, with steal mode declining
            // to make room. There is no sound and never will be; drop it.
            this.finished.push(entity);
            return;
        }

        instance.onEnded.addOne(() => {
            this.finished.push(entity);
        });
    }

    /** Build a looping emitter now, or as soon as audio is unlocked. */
    private startLoop(description: EventDescription, positionMeep: readonly number[]): Loop {
        const loop = new Loop(this, description, positionMeep);

        if (this.unlocked) loop.materialise();
        else this.deferred.push(loop);

        return loop;
    }

    /** @internal One entity, one `Transform`, one `AudioEmitter`. */
    buildEmitter(description: EventDescription, transform: Transform): number {
        const emitter = new AudioEmitter();
        emitter.event = description;

        /*
         Everything with a position in the world is simulated: occluded by the
         level's geometry and given the room's reverberation. Positional is the
         whole test -- a 2D sound is `S_StartLocalSound` or the background
         track, neither of which is happening anywhere for a wall to stand in
         front of, and `AudioEmitter.acoustic` is documented as meaningful only
         for 3D events.

         The flag is what gates the cost. It inserts a three-band crossover into
         the instance's chain and enrols it in the per-frame `AcousticSimulator`
         pass; an emitter without it renders exactly as it did before any of
         this existed, which is also what every emitter does when the acoustic
         systems are not registered at all. See `Acoustics.ts` and
         `configureAcoustics`.
        */
        emitter.acoustic = description.is3D;
        emitter.sourceRadius = SOURCE_RADIUS;

        const entity = new Entity().add(transform).add(emitter);
        entity.build(this.ecd);

        if (description.rootClip.loops()) this.loops += 1;

        return entity.id;
    }

    /** @internal Unlink stops the sound; that is what makes this a stop. */
    destroyEmitter(entity: number): void {
        if (this.ecd.entityExists(entity)) this.ecd.removeEntity(entity);
        this.loops -= 1;
    }
}

/**
 * `PM_Footsteps`' own footfall test, and the landing that is not one of them.
 *
 * **This used to fire every 48 units travelled**, on the reasoning in the
 * docblock it replaces: that the step cycle is a function of distance, because
 * the leg animation is. The animation is not -- `LEGS_RUN` plays at its own
 * frame rate -- and neither is the cycle. `PM_Footsteps` advances
 * `ps->bobCycle` by `bobmove * msec`, so a running player takes a step every
 * 320 ms whatever their speed, and the distance version fired every 150 ms at
 * Q3's own run speed and faster the faster you went. See D-081 and D-082.
 *
 * What is left here is the two things reading a counter cannot do for itself:
 * the crossing test, and the landing. Q3 fires the step when `bobCycle` crosses
 * **64 or 192** -- the peaks of the two arches, not their ends -- which is what
 * `((old + 64) ^ (bobCycle + 64)) & 128` says, and it is why the sound lands
 * with the gun at the top of its sway rather than the bottom.
 */
export class Footsteps {
    private previousCycle = 0;
    private wasOnGround = true;

    /**
     * @param bobCycle `ps.bobCycle`, maintained by whichever solver is running.
     * @param ducked `PMF_DUCKED`; Q3 advances a ducked player's cycle faster and
     *   plays no footstep from it at all, because a crouched player is sneaking.
     * @returns `'step'`, `'land'` or `null` for this frame.
     */
    update(bobCycle: number, onGround: boolean, ducked: boolean): 'step' | 'land' | null {
        const landed = onGround && !this.wasOnGround;
        this.wasOnGround = onGround;

        const previous = this.previousCycle;
        this.previousCycle = bobCycle;

        if (landed) return 'land';
        if (!onGround) return null;

        // The crossing, exactly as the C spells it: bit 128 of the cycle plus 64
        // is set across [64, 191], so a change in it is a crossing of 64 or 192.
        if ((((previous + 64) ^ (bobCycle + 64)) & 128) === 0) return null;

        return ducked ? null : 'step';
    }
}
