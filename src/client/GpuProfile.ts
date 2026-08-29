/*
 * GpuProfile.ts -- start and stop a Shade GPU capture, and hand it to the user.
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
 * meep 3.11 ships a GPU profiler under `shade/device/timing/profile/`, and ships
 * it deliberately unwired: `Renderer.profile_session` is a nullable field the
 * engine never assigns, and nothing inside the engine imports the recorder, so
 * an application that does not mention the profiler does not carry a byte of it.
 * This file is this port mentioning it, and `main.ts` is the one place that
 * names the engine's classes.
 *
 * **Nothing here imports meep.** The session, the renderer field, the device and
 * the download are all injected, for the reason `PlayerController` writes meep's
 * input devices out structurally rather than importing them: the whole of this
 * -- the toggle, the key, the metadata, the file name -- is then testable in
 * node, with no GPU and no engine, and the seam where the two type systems meet
 * is one documented cast in the composition root instead of a `vitest`
 * environment that has to boot WebGPU.
 *
 * **A capture is uncapped.** `frame_limit` defaults to `Infinity` and the
 * session keeps everything, which is what makes "hold T on, do the thing, press
 * T off" the interaction rather than "arm N frames and hope". The cost is that a
 * per-frame figure is a per-second one -- about 6 KB a frame at `WORKLOAD`, so
 * roughly 20 MB a minute -- and the session warns on its own once it passes its
 * `byte_budget`. The badge shows the running total for the same reason: a
 * recording nobody can see the size of is a recording somebody leaves on.
 *
 * **What a capture does not carry, it is unreadable without.** A pass taking
 * 0.4 ms says nothing until you know which GPU ran it, so `GPUProfileMeta` is
 * populated here from the live device before the stream is opened. The engine
 * populates none of it; `start()` writes the metadata into the stream and never
 * reads it again, which is why every field has to be set first.
 */

import type { InputSignal } from './PlayerController.ts';

/* ------------------------------------------------------------------ *
 * The shapes of the four engine things this drives, structurally.
 * ------------------------------------------------------------------ */

/** `GPUProfileMeta`, as far as this writes one. */
export interface ProfileMeta {
    note: string;
    engine_version: string;
    adapter_vendor: string;
    adapter_architecture: string;
    adapter_device: string;
    adapter_description: string;
    features: string[];
}

/** `GPUProfileSession`, as far as this drives one. */
export interface ProfileSession {
    /** Populated before {@link start}; the stream is written from it there. */
    readonly meta: ProfileMeta;
    readonly frames_recorded: number;
    readonly bytes_written: number;
    /** Fires per recorded frame with the running byte total. */
    readonly onBytesWritten: InputSignal<(bytes: number) => void>;
    start(): void;
    stop(): ArrayBuffer;
}

/**
 * `GPUDevice`, as far as this reads one.
 *
 * Structural because this repository has no WebGPU type package: `GPUDevice`
 * resolves to nothing here, and naming it would be a compile error rather than
 * a type. `adapterInfo` is optional because several browsers withhold it.
 */
export interface ProfileDevice {
    readonly features: Iterable<string>;
    readonly adapterInfo?: {
        readonly vendor?: string;
        readonly architecture?: string;
        readonly device?: string;
        readonly description?: string;
    };
}

/** meep's `KeyboardDevice`, as far as this listens to one. */
export interface ProfileKeyboard {
    readonly on: {
        readonly down: InputSignal<(event: KeyboardEvent) => void>;
    };
}

/* ------------------------------------------------------------------ *
 * The badge
 * ------------------------------------------------------------------ */

/** What the badge is told while a capture is running. */
export interface RecordingStatus {
    readonly frames: number;
    readonly bytes: number;
}

/** The HUD, as far as this writes to one. `null` means "not recording". */
export interface ProfileBadge {
    setRecording(status: RecordingStatus | null): void;
}

/* ------------------------------------------------------------------ *
 * The binding
 * ------------------------------------------------------------------ */

/**
 * The physical key, and the letter on it.
 *
 * Both, because they disagree on a layout that is not QWERTY and either reading
 * of "bind it to T" is defensible: `KeyT` is the key where T is on a US board,
 * `'t'` is whatever key produces a T on the board actually in front of the
 * player. Accepting both costs one comparison and means neither player has to
 * know which was meant.
 */
const PROFILE_KEY_CODE = 'KeyT';
const PROFILE_KEY = 't';

/** The `timestamp-query` feature, without which every span has no duration. */
const TIMESTAMP_QUERY = 'timestamp-query';

export interface GpuProfileOptions {
    /**
     * Hand the session to the renderer, or clear it.
     *
     * A function rather than the renderer itself: `Renderer.profile_session` is
     * declared in meep's own nominal terms, and the point of this module is that
     * it does not know them.
     */
    readonly bind: (session: ProfileSession | null) => void;

    /** Build a session. `new GPUProfileSession(...)`, in the composition root. */
    readonly createSession: (options: { level: number; note: string }) => ProfileSession;

    /** Save the capture. `downloadAsFile`, in the composition root. */
    readonly download: (bytes: ArrayBuffer, filename: string) => void;

    /** One of `GPUProfileLevel`, and what to call it in the capture. */
    readonly level: number;
    readonly levelName: string;

    /**
     * The live device, for the metadata a capture is unreadable without.
     *
     * A thunk, not a value: there is no device until the engine has started one,
     * and a device that is lost is replaced rather than repaired.
     */
    readonly device?: () => ProfileDevice | null;

    /** Where the running total is shown. */
    readonly badge?: ProfileBadge | null;

    /** Goes in the note and the file name. The map, here. */
    readonly label?: string;

    /** Which build of meep produced the capture. */
    readonly engineVersion?: string;

    /** Injected so a file name is not a thing a test has to have a clock for. */
    readonly now?: () => Date;
}

/**
 * One GPU capture at a time, toggled by a key and downloaded when it ends.
 *
 * `start` and `stop` are the whole of the lifecycle and both are safe to call
 * in the wrong state -- starting a running capture and stopping a stopped one
 * both do nothing and say so in the return value, which is what lets one key be
 * bound to both.
 */
export class GpuProfile {
    private readonly options: GpuProfileOptions;

    /** The capture in progress, or null. This *is* the recording state. */
    private session: ProfileSession | null = null;

    private keyboard: ProfileKeyboard | null = null;

    constructor(options: GpuProfileOptions) {
        this.options = options;
    }

    get recording(): boolean {
        return this.session !== null;
    }

    /** Frames committed so far, or zero when nothing is recording. */
    get frames(): number {
        return this.session?.frames_recorded ?? 0;
    }

    /** Bytes written so far, or zero when nothing is recording. */
    get bytes(): number {
        return this.session?.bytes_written ?? 0;
    }

    /** Listen for the key. Idempotent, like every other `attach` here. */
    attach(keyboard: ProfileKeyboard): void {
        if (this.keyboard !== null) return;

        this.keyboard = keyboard;
        keyboard.on.down.add(this.onKeyDown);
    }

    detach(): void {
        const keyboard = this.keyboard;
        if (keyboard === null) return;

        this.keyboard = null;
        keyboard.on.down.remove(this.onKeyDown);
    }

    /**
     * The key. One key for both ends, because a recording is a state and a
     * state with two keys is a state you can get out of step with.
     */
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        /*
         A held key repeats. Without this, holding T starts a capture, stops it
         on the next repeat, and then downloads a file every repeat after that
         -- about thirty of them a second.
        */
        if (event.repeat) return;

        /*
         Ctrl+T is a new tab and Cmd+T is the same; a chord that already means
         something to the browser must not also mean something here. Shift is
         deliberately not in this list: it is Q3's walk modifier, held for
         seconds at a time, and a player who is walking should still be able to
         start a capture of what they are walking through.
        */
        if (event.ctrlKey || event.altKey || event.metaKey) return;

        if (event.code !== PROFILE_KEY_CODE && event.key.toLowerCase() !== PROFILE_KEY) return;

        this.toggle();
    };

    /** @returns whether a capture is running after the call. */
    toggle(): boolean {
        if (this.session === null) {
            this.start();
        } else {
            this.stop();
        }

        return this.session !== null;
    }

    /** @returns false when one was already running, which is not an error. */
    start(): boolean {
        if (this.session !== null) return false;

        const session = this.options.createSession({
            level: this.options.level,
            note: this.note(),
        });

        this.describe(session.meta);

        session.onBytesWritten.add(this.onBytesWritten);

        this.session = session;

        /*
         Bound first and started second, which is the order meep's own example
         uses. Either works -- `begin_frame` returns null for a session that is
         not running, so a frame that lands between the two records nothing --
         and matching the documented order is one less thing to re-derive.
        */
        this.options.bind(session);
        session.start();

        if (!this.timestampsAvailable()) {
            console.warn(
                '[queep] GPU capture started without the `timestamp-query` feature: pass ' +
                'spans will be recorded with no durations. The structure of the frame is ' +
                'still captured. Chrome offers the feature behind ' +
                'chrome://flags/#enable-webgpu-developer-features on hardware that withholds it.'
            );
        }

        this.paint();

        return true;
    }

    /** @returns false when nothing was running, which is not an error. */
    stop(): boolean {
        const session = this.session;
        if (session === null) return false;

        this.session = null;
        session.onBytesWritten.remove(this.onBytesWritten);

        const bytes = session.stop();

        /*
         Cleared after the stop rather than before, though nothing runs between
         the two. What the clear actually prevents is the *next* frame opening a
         recorder; the frames already submitted are a different matter, and they
         are dropped rather than waited for -- `Renderer` commits a frame when
         its timing readback lands, which is two or three frames after submit,
         and `record_frame` ignores anything arriving after `stop()`. So a
         capture loses its last few frames by construction. That is the engine's
         documented behaviour and the right trade: the alternative is a `stop`
         that does not return until the GPU has caught up.
        */
        this.options.bind(null);

        this.paint();

        const frames = session.frames_recorded;
        const filename = this.filename();

        if (frames === 0) {
            console.warn(
                `[queep] GPU capture recorded no frames; saving the header anyway as ` +
                `${filename}. A capture stopped within a few frames of starting loses all ` +
                `of them: a frame is committed when its timing readback lands, which is ` +
                `two or three frames after it was submitted.`
            );
        } else {
            console.info(
                `[queep] GPU capture: ${frames} frames, ${formatBytes(bytes.byteLength)} ` +
                `at ${this.options.levelName} -> ${filename}`
            );
        }

        this.options.download(bytes, filename);

        return true;
    }

    /** Repaint the badge from whatever the session currently says. */
    private readonly onBytesWritten = (): void => {
        this.paint();
    };

    private paint(): void {
        const badge = this.options.badge;
        if (badge === undefined || badge === null) return;

        const session = this.session;

        badge.setRecording(
            session === null
                ? null
                : { frames: session.frames_recorded, bytes: session.bytes_written }
        );
    }

    /**
     * Everything about the machine that the numbers mean nothing without.
     *
     * `features` is sorted so that two captures off the same machine compare as
     * equal text, and every adapter field degrades to the empty string the
     * engine already defaults it to -- a browser withholding `adapterInfo` is
     * the ordinary case, not a failure.
     */
    private describe(meta: ProfileMeta): void {
        const version = this.options.engineVersion;
        if (version !== undefined && version !== '') meta.engine_version = version;

        const device = this.device();
        if (device === null) return;

        const info = device.adapterInfo;

        if (info !== undefined && info !== null) {
            meta.adapter_vendor = info.vendor ?? '';
            meta.adapter_architecture = info.architecture ?? '';
            meta.adapter_device = info.device ?? '';
            meta.adapter_description = info.description ?? '';
        }

        meta.features = [...device.features].sort();
    }

    /**
     * What the capture says about itself.
     *
     * The missing-timers case is stated *in the capture* and not only in the
     * console, because the console belongs to the session that recorded it and
     * the capture is the thing that gets sent to somebody else. A file full of
     * zero-duration spans with nothing to explain them reads as a broken
     * renderer.
     */
    private note(): string {
        const parts = ['queep-3-arena'];

        const label = this.options.label ?? '';
        if (label !== '') parts.push(label);

        parts.push(this.options.levelName);

        if (!this.timestampsAvailable()) {
            parts.push('no timestamp-query: pass spans carry no durations');
        }

        return parts.join(' · ');
    }

    private device(): ProfileDevice | null {
        return this.options.device?.() ?? null;
    }

    /**
     * Is the device one that can time anything?
     *
     * Absent is not an error and does not stop a capture: the frame graph, the
     * dispatch sizes and the resource declarations are all still worth having,
     * and meep degrades to recording them with the timers switched off rather
     * than throwing.
     *
     * Unknown -- no device yet -- is treated as available, because warning that
     * timings are unavailable on a machine that has not been asked yet would be
     * a guess presented as a fact.
     */
    private timestampsAvailable(): boolean {
        const device = this.device();
        if (device === null) return true;

        for (const feature of device.features) {
            if (feature === TIMESTAMP_QUERY) return true;
        }

        return false;
    }

    /**
     * `queep-<label>-<yyyymmdd-hhmmss>.sgpt`.
     *
     * Local time and not ISO: these are sorted in a downloads folder by somebody
     * who is trying to remember which run was the slow one, and "when I pressed
     * the key" is the thing they remember. The label is sanitised because it is
     * a map name off a query string, and a query string is not a file name.
     */
    private filename(): string {
        const at = this.options.now?.() ?? new Date();

        const stamp =
            `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
            `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

        const label = (this.options.label ?? '').replace(/[^a-z0-9_.-]/gi, '_');

        return label === '' ? `queep-${stamp}.sgpt` : `queep-${label}-${stamp}.sgpt`;
    }
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

/**
 * Binary units, because that is what the session's own budget warning uses and
 * two figures for one number in one console is worse than either figure alone.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;

    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
