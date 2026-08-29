/*
 * gpu-profile.test.ts -- the capture toggle, without a GPU and without an engine.
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
 * `GpuProfile` is written against structural shapes rather than meep's classes
 * precisely so that this file can exist: the session, the renderer field, the
 * device and the download are all injected, so the whole of the behaviour that
 * is actually this port's -- one key for both ends of a recording, the metadata
 * a capture is unreadable without, the file name, what the badge is told -- is
 * reachable in node.
 *
 * What is deliberately *not* asserted here is anything about the `.sgpt` bytes.
 * Those are the engine's, they are covered by the engine's own suite, and a test
 * that re-derived the container's layout would be testing a copy of it.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    formatBytes,
    GpuProfile,
    type ProfileDevice,
    type ProfileMeta,
    type ProfileSession,
    type RecordingStatus,
} from '../src/client/GpuProfile.ts';

/* ------------------------------------------------------------------ *
 * Stubs
 * ------------------------------------------------------------------ */

/** meep's `Signal`, reduced to what a session and a keyboard need of one. */
class Signal<H> {
    readonly handlers: H[] = [];

    add(handler: H): void {
        this.handlers.push(handler);
    }

    remove(handler: H): void {
        const at = this.handlers.indexOf(handler);
        if (at >= 0) this.handlers.splice(at, 1);
    }

    emit(call: (handler: H) => void): void {
        for (const handler of this.handlers.slice()) call(handler);
    }
}

/**
 * `GPUProfileSession`, reduced to its contract.
 *
 * `start` writing the note into the stream and not reading it again is modelled,
 * because that is the property the metadata has to be populated *before* the
 * start to satisfy, and a stub that let a late write through would let a bug
 * through with it.
 */
class FakeSession implements ProfileSession {
    readonly meta: ProfileMeta = {
        note: '',
        engine_version: '',
        adapter_vendor: '',
        adapter_architecture: '',
        adapter_device: '',
        adapter_description: '',
        features: [],
    };

    readonly onBytesWritten = new Signal<(bytes: number) => void>();

    frames_recorded = 0;
    bytes_written = 0;

    started = false;
    stopped = false;

    /** What `start` saw. Everything written after it is invisible to a reader. */
    committed: ProfileMeta | null = null;

    constructor(readonly options: { level: number; note: string }) {
        this.meta.note = options.note;
    }

    start(): void {
        this.started = true;
        this.committed = { ...this.meta, features: [...this.meta.features] };
    }

    stop(): ArrayBuffer {
        this.stopped = true;
        return new ArrayBuffer(this.bytes_written);
    }

    /** One committed frame, as the renderer's readback would produce. */
    frame(bytes = 2048): void {
        this.frames_recorded++;
        this.bytes_written += bytes;
        this.onBytesWritten.emit((h) => h(this.bytes_written));
    }
}

interface Harness {
    readonly profile: GpuProfile;
    readonly keyboard: { on: { down: Signal<(event: KeyboardEvent) => void> } };
    /** Every session `createSession` has handed out, in order. */
    readonly sessions: FakeSession[];
    /** What the renderer field currently holds. */
    bound: ProfileSession | null;
    readonly downloads: { bytes: ArrayBuffer; filename: string }[];
    readonly badge: RecordingStatus[];
    press(init?: Partial<KeyboardEvent>): void;
}

function harness(options: { device?: ProfileDevice | null; label?: string } = {}): Harness {
    const sessions: FakeSession[] = [];
    const downloads: { bytes: ArrayBuffer; filename: string }[] = [];
    const badge: RecordingStatus[] = [];
    const keyboard = { on: { down: new Signal<(event: KeyboardEvent) => void>() } };

    const state: { bound: ProfileSession | null } = { bound: null };

    const device =
        options.device === undefined
            ? ({ features: ['timestamp-query'] } satisfies ProfileDevice)
            : options.device;

    const profile = new GpuProfile({
        bind: (session) => {
            state.bound = session;
        },
        createSession: (o) => {
            const session = new FakeSession(o);
            sessions.push(session);
            return session;
        },
        download: (bytes, filename) => downloads.push({ bytes, filename }),
        level: 2,
        levelName: 'WORKLOAD',
        device: () => device,
        badge: {
            setRecording: (status) => {
                if (status !== null) badge.push(status);
            },
        },
        label: options.label ?? 'oa_dm1',
        engineVersion: '3.11.0',
        now: () => new Date(2026, 7, 29, 14, 3, 9),
    });

    profile.attach(keyboard);

    return {
        profile,
        keyboard,
        sessions,
        get bound() {
            return state.bound;
        },
        downloads,
        badge,
        press: (init = {}) => {
            const event = { code: 'KeyT', key: 't', repeat: false, ...init } as KeyboardEvent;
            keyboard.on.down.emit((h) => h(event));
        },
    };
}

/* ------------------------------------------------------------------ *
 * The toggle
 * ------------------------------------------------------------------ */

describe('the T key', () => {
    it('starts on the first press and stops on the second', () => {
        const h = harness();

        expect(h.profile.recording).toBe(false);

        h.press();

        expect(h.profile.recording).toBe(true);
        expect(h.sessions).toHaveLength(1);
        expect(h.sessions[0]!.started).toBe(true);
        expect(h.bound).toBe(h.sessions[0]);

        h.press();

        expect(h.profile.recording).toBe(false);
        expect(h.sessions[0]!.stopped).toBe(true);

        // The field the renderer reads is cleared, or the next frame opens a
        // recorder against a session that has already been finished.
        expect(h.bound).toBeNull();
    });

    it('downloads the capture when the recording ends, and only then', () => {
        const h = harness();

        h.press();
        h.sessions[0]!.frame();

        expect(h.downloads).toHaveLength(0);

        h.press();

        expect(h.downloads).toHaveLength(1);
        expect(h.downloads[0]!.filename).toBe('queep-oa_dm1-20260829-140309.sgpt');
    });

    /*
     A held key repeats at about thirty a second. Without the guard, holding T
     starts a capture, stops it on the next repeat, and writes a file for every
     repeat after that.
    */
    it('ignores a key repeat', () => {
        const h = harness();

        h.press();
        h.press({ repeat: true });
        h.press({ repeat: true });

        expect(h.profile.recording).toBe(true);
        expect(h.downloads).toHaveLength(0);
    });

    /*
     Ctrl+T is a new tab and Cmd+T is the same; the browser acts on those and
     this must not act on them too. Shift is not in that list on purpose -- it is
     Q3's walk modifier, and a player who is walking should still be able to
     start a capture of what they are walking through.
    */
    it('ignores a browser chord but not the walk modifier', () => {
        const h = harness();

        h.press({ ctrlKey: true });
        h.press({ metaKey: true });
        h.press({ altKey: true });

        expect(h.profile.recording).toBe(false);

        h.press({ shiftKey: true, key: 'T' });

        expect(h.profile.recording).toBe(true);
    });

    it('answers to the letter as well as to the physical key', () => {
        const byLetter = harness();
        byLetter.press({ code: 'KeyY', key: 't' });
        expect(byLetter.profile.recording).toBe(true);

        const byCode = harness();
        byCode.press({ code: 'KeyT', key: 'ф' });
        expect(byCode.profile.recording).toBe(true);
    });

    it('leaves every other key alone', () => {
        const h = harness();

        h.press({ code: 'KeyR', key: 'r' });
        h.press({ code: 'Space', key: ' ' });

        expect(h.profile.recording).toBe(false);
    });

    it('stops listening once detached', () => {
        const h = harness();

        h.profile.detach();
        h.press();

        expect(h.profile.recording).toBe(false);
        expect(h.keyboard.on.down.handlers).toHaveLength(0);
    });

    /** One handler however many times `attach` is called, like every other one. */
    it('attaches once', () => {
        const h = harness();

        h.profile.attach(h.keyboard);
        h.profile.attach(h.keyboard);

        expect(h.keyboard.on.down.handlers).toHaveLength(1);
    });
});

describe('start and stop out of order', () => {
    it('does not start a second capture over a running one', () => {
        const h = harness();

        expect(h.profile.start()).toBe(true);
        expect(h.profile.start()).toBe(false);

        expect(h.sessions).toHaveLength(1);
    });

    it('does not stop, or download, when nothing is running', () => {
        const h = harness();

        expect(h.profile.stop()).toBe(false);
        expect(h.downloads).toHaveLength(0);
    });

    it('builds a fresh session per recording, because a stopped one cannot restart', () => {
        const h = harness();

        h.press();
        h.press();
        h.press();

        expect(h.sessions).toHaveLength(2);
        expect(h.sessions[0]).not.toBe(h.sessions[1]);
        expect(h.bound).toBe(h.sessions[1]);
    });
});

/* ------------------------------------------------------------------ *
 * The metadata
 * ------------------------------------------------------------------ */

describe('what a capture says about itself', () => {
    /*
     `start` writes the metadata into the stream and does not read it again, so
     every field has to be set before it. This asserts against what the fake saw
     at `start`, not against the object afterwards, because the second would
     pass on a version of this that wrote the adapter in too late.
    */
    it('is populated before the stream is opened', () => {
        const h = harness({
            device: {
                features: ['timestamp-query', 'float32-blendable'],
                adapterInfo: {
                    vendor: 'nvidia',
                    architecture: 'ampere',
                    device: '',
                    description: 'NVIDIA GeForce RTX 3070',
                },
            },
        });

        h.press();

        const committed = h.sessions[0]!.committed;

        expect(committed).not.toBeNull();
        expect(committed!.engine_version).toBe('3.11.0');
        expect(committed!.adapter_vendor).toBe('nvidia');
        expect(committed!.adapter_architecture).toBe('ampere');
        expect(committed!.adapter_description).toBe('NVIDIA GeForce RTX 3070');

        // Sorted, so two captures off one machine compare as equal text.
        expect(committed!.features).toEqual(['float32-blendable', 'timestamp-query']);
    });

    it('carries the map and the level in the note', () => {
        const h = harness({ label: 'am_thornish' });

        h.press();

        expect(h.sessions[0]!.options.note).toBe('queep-3-arena · am_thornish · WORKLOAD');
        expect(h.sessions[0]!.options.level).toBe(2);
    });

    /*
     The capture is the thing that gets sent to somebody else, and a file full of
     zero-duration spans with nothing to explain them reads as a broken renderer
     rather than as a browser withholding a feature.
    */
    it('says so in the capture when the device cannot time anything', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ device: { features: ['float32-blendable'] } });

        h.press();

        expect(h.sessions[0]!.options.note).toContain('no timestamp-query');
        expect(warn).toHaveBeenCalledOnce();

        warn.mockRestore();
    });

    /** A browser that withholds `adapterInfo` is ordinary, not a failure. */
    it('degrades to the empty strings the engine already defaults to', () => {
        const h = harness({ device: { features: [] } });

        h.press();

        const committed = h.sessions[0]!.committed!;

        expect(committed.adapter_vendor).toBe('');
        expect(committed.adapter_description).toBe('');
        expect(committed.features).toEqual([]);
    });

    /*
     No device yet is not the same as a device that cannot time. Warning about
     missing timings on a machine that has not been asked would be a guess
     presented as a fact.
    */
    it('does not claim timings are unavailable before there is a device', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({ device: null });

        h.press();

        expect(h.sessions[0]!.options.note).not.toContain('no timestamp-query');
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });
});

/* ------------------------------------------------------------------ *
 * The badge
 * ------------------------------------------------------------------ */

describe('the badge', () => {
    it('is shown at zero the moment recording starts', () => {
        const h = harness();

        h.press();

        expect(h.badge).toEqual([{ frames: 0, bytes: 0 }]);
    });

    it('follows the running total, frame by frame', () => {
        const h = harness();

        h.press();
        h.sessions[0]!.frame(2048);
        h.sessions[0]!.frame(1024);

        expect(h.badge).toEqual([
            { frames: 0, bytes: 0 },
            { frames: 1, bytes: 2048 },
            { frames: 2, bytes: 3072 },
        ]);
    });

    it('is hidden when the recording ends', () => {
        const hidden: (RecordingStatus | null)[] = [];
        const sessions: FakeSession[] = [];

        const profile = new GpuProfile({
            bind: () => {},
            createSession: (o) => {
                const s = new FakeSession(o);
                sessions.push(s);
                return s;
            },
            download: () => {},
            level: 0,
            levelName: 'TIMING',
            badge: { setRecording: (status) => hidden.push(status) },
        });

        profile.start();
        profile.stop();

        expect(hidden).toEqual([{ frames: 0, bytes: 0 }, null]);
    });

    /*
     The session's own signal is the only thing driving the badge, so a handler
     left behind would repaint from a session that has been finished.
    */
    it('stops following a session it has stopped', () => {
        const h = harness();

        h.press();

        const session = h.sessions[0]!;
        expect(session.onBytesWritten.handlers).toHaveLength(1);

        h.press();
        expect(session.onBytesWritten.handlers).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ *
 * Odds
 * ------------------------------------------------------------------ */

describe('the file name', () => {
    /** It is a map name off a query string, and that is not a file name. */
    it('sanitises the label', () => {
        const h = harness({ label: '../../etc/passwd' });

        h.press();
        h.press();

        expect(h.downloads[0]!.filename).toBe('queep-.._.._etc_passwd-20260829-140309.sgpt');
    });

    it('drops the label when there is none', () => {
        const h = harness({ label: '' });

        h.press();
        h.press();

        expect(h.downloads[0]!.filename).toBe('queep-20260829-140309.sgpt');
    });
});

/*
 A capture stopped within a few frames of starting has nothing in it: a frame is
 committed when its timing readback lands, two or three frames after submit, and
 anything arriving after `stop()` is dropped. The download still happens --
 pressing the key asked for a file -- and the warning is what explains the size.
*/
describe('an empty capture', () => {
    it('is still downloaded, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness();

        h.press();
        h.press();

        expect(h.downloads).toHaveLength(1);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]![0])).toContain('no frames');

        warn.mockRestore();
    });
});

describe('formatBytes', () => {
    /** Binary units, because the session's own budget warning reports MiB. */
    it('reads in the units the engine already warns in', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(1023)).toBe('1023 B');
        expect(formatBytes(1024)).toBe('1 KiB');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
        expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MiB');
    });
});
