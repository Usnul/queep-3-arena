/*
 * settings.test.ts -- the menu's model, without the menu.
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
 * A settings screen fails in ways that a screenshot does not show. The four that
 * actually happen, and are therefore what this file is about:
 *
 *   - **A stored value is not a legal value.** `Option.fromJSON` hands whatever
 *     it loaded straight to `write`, with no checking of any kind. So a field of
 *     view of `1e9`, a `null` left by a build that had a different setting under
 *     that key, or a `"4"` where a `4` was expected, all arrive at the engine
 *     unless `coerce` stops them.
 *   - **A change applies and is not saved.** meep only writes to storage from
 *     `Option.on.written`, so a model that keeps its own values and never tells
 *     the option would work perfectly all session and remember nothing. This is
 *     the bug the two-entry-point split in `Settings` exists to prevent, and it
 *     is invisible without a test that reloads.
 *   - **A change is saved and does not apply.** The mirror image: a value that
 *     round-trips through JSON and never reaches the thing it configures.
 *   - **Two writes chase each other.** A control writes the model, the model
 *     applies, the applied-to thing signals, the control redraws and writes
 *     again.
 *
 * None of it needs a DOM, which is the point of `Settings` not having one.
 */

import { describe, expect, it } from 'vitest';

import {
    coerce,
    Settings,
    type ChoiceSetting,
    type SettingsPage,
    type SettingsStorage,
    type SliderSetting,
    type ToggleSetting,
} from '../src/client/ui/Settings.ts';
import {
    FOV_DEFAULT,
    FRAME_RATE_TARGET_DEFAULT,
    graphicsPage,
    type CameraHost,
    type GraphicsHost,
} from '../src/client/ui/graphics.ts';
import type { Hud } from '../src/client/Hud.ts';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const slider: SliderSetting = {
    kind: 'slider',
    id: 'fov',
    section: 'Display',
    label: 'Field of view',
    initial: 90,
    min: 60,
    max: 130,
    step: 1,
    format: (v) => `${v}`,
    apply: () => undefined,
};

/** A step that binary floating point cannot hold, which is the interesting one. */
const fractional: SliderSetting = {
    ...slider,
    id: 'scale',
    initial: 1,
    min: 0.5,
    max: 2,
    step: 0.05,
};

const toggle: ToggleSetting = {
    kind: 'toggle',
    id: 'speedometer',
    section: 'HUD',
    label: 'Speedometer',
    initial: true,
    apply: () => undefined,
};

const choice: ChoiceSetting = {
    kind: 'choice',
    id: 'crosshair',
    section: 'HUD',
    label: 'Crosshair',
    initial: 4,
    options: [0, 1, 2, 3, 4].map((v) => ({ value: v, label: `${v}` })),
    apply: () => undefined,
};

function page(...settings: readonly (SliderSetting | ToggleSetting | ChoiceSetting)[]): SettingsPage {
    return { id: 'test', title: 'Test', settings };
}

/**
 * A storage that behaves the way `IndexedDBStorage` does, minus the database:
 * callback-shaped, and answering `undefined` for a key it has never seen.
 */
function memoryStorage(initial: Record<string, string> = {}): SettingsStorage & {
    readonly contents: Map<string, string>;
    writes: number;
} {
    const contents = new Map<string, string>(Object.entries(initial));

    return {
        contents,
        writes: 0,
        load(key, resolve): void {
            resolve(contents.get(key));
        },
        store(key, value, resolve): void {
            contents.set(key, value);
            this.writes++;
            resolve();
        },
    };
}

/* ------------------------------------------------------------------ *
 * coerce
 * ------------------------------------------------------------------ */

describe('coerce', () => {
    it('clamps a slider to its range', () => {
        expect(coerce(slider, 1e9)).toBe(130);
        expect(coerce(slider, -1e9)).toBe(60);
        expect(coerce(slider, 105)).toBe(105);
    });

    it('snaps to the step, and does not leave float dust behind', () => {
        // 0.5 + 5 * 0.05 is 0.75 exactly in decimal and 0.7500000000000001 in
        // binary, and the readout beside the slider would say so.
        expect(coerce(fractional, 0.7499)).toBe(0.75);
        expect(coerce(fractional, 1.23)).toBe(1.25);
        expect(coerce(fractional, 1.22)).toBe(1.2);
    });

    it('never returns a snapped value outside the range', () => {
        // A range that is not a whole number of steps: 0 to 10 by 3.
        const awkward: SliderSetting = { ...slider, min: 0, max: 10, step: 3 };

        expect(coerce(awkward, 10)).toBeLessThanOrEqual(10);
        expect(coerce(awkward, 10)).toBeGreaterThanOrEqual(0);
        expect(coerce(awkward, 9.9)).toBe(9);
    });

    it('rejects the things a stored value can be that a number is not', () => {
        /*
         `[]` and `[7]` are in here because they are the ones that got through:
         `Number([])` is 0 and `Number([7])` is 7, so an array out of a stale
         save clamped to the bottom of the range rather than being refused.
        */
        const rejected: unknown[] = [
            NaN, Infinity, -Infinity,
            null, undefined, '', '   ', 'ninety',
            {}, [], [7], true, false,
        ];

        for (const bad of rejected) {
            expect(coerce(slider, bad), `${String(bad)} should be refused`).toBeNull();
        }
    });

    it('takes a slider from the two types a value can actually arrive as', () => {
        // A number from a range input, a number or a string out of JSON.
        expect(coerce(slider, 100)).toBe(100);
        expect(coerce(slider, '100')).toBe(100);
    });

    it('takes a toggle only from a real boolean', () => {
        expect(coerce(toggle, true)).toBe(true);
        expect(coerce(toggle, false)).toBe(false);

        // The JSON-ish truthiness a hand-edited save could carry.
        for (const bad of [1, 0, 'true', 'false', null]) {
            expect(coerce(toggle, bad)).toBeNull();
        }
    });

    it('takes a choice by value, and by the string a <select> hands back', () => {
        expect(coerce(choice, 3)).toBe(3);
        expect(coerce(choice, '3')).toBe(3);

        // ...but not by anything that merely parses to one of them, because
        // `Number('04')` is 4 and `"04"` is not an option this menu offered.
        expect(coerce(choice, '04')).toBeNull();
        expect(coerce(choice, '3.0')).toBeNull();
        expect(coerce(choice, 9)).toBeNull();
    });
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

describe('Settings', () => {
    it('applies a change once, and announces it once', () => {
        const applied: number[] = [];
        const announced: [string, unknown][] = [];

        const settings = new Settings([
            page({ ...slider, apply: (v: number) => applied.push(v) }),
        ]);
        settings.onChanged.add((id: string, v: unknown) => announced.push([id, v]));

        expect(settings.set('fov', 110)).toBe(true);
        expect(applied).toEqual([110]);
        expect(announced).toEqual([['fov', 110]]);

        // The same value again is not a change, and a rejected value is not one
        // either. Both matter: the first is what stops a control that redraws on
        // `onChanged` from writing back and going round again.
        expect(settings.set('fov', 110)).toBe(false);
        expect(settings.set('fov', NaN)).toBe(false);
        expect(applied).toEqual([110]);
        expect(announced).toHaveLength(1);
    });

    it('keeps the old value when a new one is rejected', () => {
        const settings = new Settings([page(slider)]);

        settings.set('fov', 100);
        settings.set('fov', 'nonsense');

        expect(settings.get('fov')).toBe(100);
    });

    it('survives a setting whose apply throws', () => {
        const settings = new Settings([
            page(
                {
                    ...slider,
                    apply: () => {
                        throw new Error('the engine said no');
                    },
                },
                toggle
            ),
        ]);

        // The write still lands and the *next* setting still applies -- one bad
        // row must not take the rest of the page with it.
        expect(() => settings.set('fov', 100)).not.toThrow();
        expect(settings.get('fov')).toBe(100);
        expect(() => settings.applyAll()).not.toThrow();
    });

    it('resets every setting to its shipped default', () => {
        const settings = new Settings([page(slider, toggle, choice)]);

        settings.set('fov', 120);
        settings.set('speedometer', false);
        settings.set('crosshair', 1);

        settings.reset();

        expect(settings.get('fov')).toBe(90);
        expect(settings.get('speedometer')).toBe(true);
        expect(settings.get('crosshair')).toBe(4);
    });

    it('refuses two settings with the same id', () => {
        expect(() => new Settings([page(slider), page(slider)])).toThrow(/duplicate/);
    });

    it('refuses an id it does not have, rather than inventing one', () => {
        const settings = new Settings([page(slider)]);

        expect(() => settings.get('nope')).toThrow(/no such setting/);
        expect(() => settings.set('nope', 1)).toThrow(/no such setting/);
    });
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

describe('Settings persistence', () => {
    it('saves a change made through the menu', async () => {
        // The failure this is here for: `Settings` holds the values itself, and
        // meep only writes to storage from `Option.on.written`. A model that
        // never told the option would work all session and remember nothing.
        const storage = memoryStorage();
        const settings = new Settings([page(slider, toggle, choice)]);

        await settings.attach(storage, 'test');
        settings.set('fov', 115);
        settings.set('speedometer', false);

        const stored = JSON.parse(storage.contents.get('test') ?? '{}') as Record<string, unknown>;
        expect(stored['fov']).toBe(115);
        expect(stored['speedometer']).toBe(false);
    });

    it('does not write while it is loading', async () => {
        const storage = memoryStorage({ test: JSON.stringify({ fov: 115 }) });
        const settings = new Settings([page(slider)]);

        await settings.attach(storage, 'test');

        expect(settings.get('fov')).toBe(115);
        expect(storage.writes).toBe(0);
    });

    it('loads a stored value and applies it', async () => {
        const applied: number[] = [];
        const storage = memoryStorage({ test: JSON.stringify({ fov: 100 }) });

        const settings = new Settings([
            page({ ...slider, apply: (v: number) => applied.push(v) }),
        ]);

        await settings.attach(storage, 'test');

        expect(settings.get('fov')).toBe(100);
        expect(applied).toEqual([100]);
    });

    it('ignores stored rubbish rather than passing it to the engine', async () => {
        const applied: unknown[] = [];
        const storage = memoryStorage({
            test: JSON.stringify({
                fov: 1e9, // out of range
                speedometer: 'yes', // not a boolean
                crosshair: 99, // not an option
                gone: 12, // a setting this build no longer has
            }),
        });

        const settings = new Settings([
            page(
                { ...slider, apply: (v: number) => applied.push(v) },
                { ...toggle, apply: (v: boolean) => applied.push(v) },
                { ...choice, apply: (v: number | string) => applied.push(v) }
            ),
        ]);

        await settings.attach(storage, 'test');

        // The field of view clamps -- it was a number, just a silly one. The
        // other two are not values these settings can take at all, so they keep
        // their defaults and nothing is applied for them.
        expect(settings.get('fov')).toBe(130);
        expect(settings.get('speedometer')).toBe(true);
        expect(settings.get('crosshair')).toBe(4);
        expect(applied).toEqual([130]);
    });

    it('round-trips through a reload', async () => {
        const storage = memoryStorage();

        const first = new Settings([page(slider, toggle, choice)]);
        await first.attach(storage, 'test');
        first.set('fov', 105);
        first.set('crosshair', 0);

        const second = new Settings([page(slider, toggle, choice)]);
        await second.attach(storage, 'test');

        expect(second.get('fov')).toBe(105);
        expect(second.get('crosshair')).toBe(0);
        expect(second.get('speedometer')).toBe(true);
    });

    it('survives a stored blob that is not the shape it expects', async () => {
        /*
         `OptionGroup.fromJSON` does `json.hasOwnProperty(id)` on whatever came
         back, so a stored `null` throws inside meep's own promise chain, and a
         truncated string throws in `JSON.parse` before that. Both have to leave
         a usable settings screen behind -- and, less obviously, both have to
         leave the *save* hook attached, because `attachToStorage` binds it in a
         `finally` and a caller that swallowed the rejection could easily have
         swallowed the binding with it.
        */
        for (const blob of ['null', '{"fov":', 'not json at all', '42']) {
            const storage = memoryStorage({ test: blob });
            const settings = new Settings([page(slider)]);

            await settings.attach(storage, 'test');

            expect(settings.get('fov'), blob).toBe(90);

            settings.set('fov', 111);
            expect(settings.get('fov')).toBe(111);

            const stored = JSON.parse(storage.contents.get('test') ?? '{}') as Record<string, unknown>;
            expect(stored['fov'], `${blob} should still save`).toBe(111);
        }
    });

    it('starts at the defaults when storage cannot be read', async () => {
        const settings = new Settings([page(slider)]);

        await settings.attach(
            {
                load: (_key, _resolve, reject) => reject(new Error('private browsing')),
                store: (_key, _value, _resolve, reject) => reject(new Error('private browsing')),
            },
            'test'
        );

        expect(settings.get('fov')).toBe(90);
        expect(() => settings.set('fov', 100)).not.toThrow();
    });
});

/* ------------------------------------------------------------------ *
 * The graphics page
 * ------------------------------------------------------------------ */

/**
 * What the fake HUD records, under names of its own.
 *
 * Not an intersection with `Hud`: `Hud.crosshairIndex` is private, and a
 * `Hud & { crosshairIndex: number }` collapses to `never` because TypeScript
 * will not let a private member be widened by an intersection. The stub is its
 * own type and is cast where it is handed over, which is the only place the
 * page needs it to be a `Hud`.
 */
interface HudStub {
    crosshair: number;
    speedometer: boolean;
    crosshairHealth: boolean;
    setCrosshair(index: number): void;
    setSpeedometerVisible(visible: boolean): void;
}

/** Stand-ins for the four things the graphics page writes. */
function hosts(): {
    graphics: GraphicsHost & { resizes: number; resets: number };
    camera: CameraHost & { value: number };
    hud: HudStub;
} {
    const graphics = {
        resizes: 0,
        resets: 0,
        ratio: 1,
        pixelRatio: {
            set(x: number): void {
                graphics.ratio = x;
            },
            getValue(): number {
                return graphics.ratio;
            },
        },
        dynamic_resolution: {
            enabled: true,
            target_frame_rate: 30,
            reset(): void {
                graphics.resets++;
            },
        },
        updateSize(): void {
            graphics.resizes++;
        },
    };

    const camera = {
        value: 0,
        fov: {
            set(x: number): void {
                camera.value = x;
            },
            getValue(): number {
                return camera.value;
            },
        },
    };

    const hud: HudStub = {
        crosshair: -1,
        speedometer: false,
        crosshairHealth: false,
        setCrosshair(index: number): void {
            hud.crosshair = index;
        },
        setSpeedometerVisible(visible: boolean): void {
            hud.speedometer = visible;
        },
    };

    return { graphics, camera, hud };
}

/** The page, built against the stand-ins. */
function pageFor(h: ReturnType<typeof hosts>): SettingsPage {
    return graphicsPage({
        graphics: h.graphics,
        camera: h.camera,
        hud: h.hud as unknown as Hud,
        frameRateCounter: null,
    });
}

describe('the graphics page', () => {
    it('pushes every default at the engine when it is applied', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        settings.applyAll();

        expect(h.camera.value).toBe(FOV_DEFAULT);
        expect(h.graphics.pixelRatio.getValue()).toBe(1);
        expect(h.graphics.dynamic_resolution.target_frame_rate).toBe(FRAME_RATE_TARGET_DEFAULT);
        expect(h.hud.crosshair).toBe(4);
        expect(h.hud.speedometer).toBe(true);
    });

    it('resizes when the render scale moves, because nothing else will', () => {
        // `pixelRatio` has an `onChanged` signal that the engine subscribes
        // nothing to: `updateSize` is bound to `viewport.size.onChanged` alone,
        // so writing the ratio changes the picture at the next window resize and
        // not before. GAP-027.
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        const before = h.graphics.resizes;
        settings.set('render-scale', 0.75);

        expect(h.graphics.pixelRatio.getValue()).toBe(0.75);
        expect(h.graphics.resizes).toBe(before + 1);
    });

    it('greys the frame-rate target out when adaptive resolution is off', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);
        settings.applyAll();

        const target = settings.definition('frame-rate-target');

        expect(target.enabled?.()).toBe(true);

        settings.set('adaptive-resolution', false);
        expect(target.enabled?.()).toBe(false);
        expect(h.graphics.dynamic_resolution.enabled).toBe(false);

        // Still writable and still saved while it is inert -- it is the reading
        // of it that stops, not the holding of it.
        expect(settings.set('frame-rate-target', 144)).toBe(true);
        expect(h.graphics.dynamic_resolution.target_frame_rate).toBe(144);
    });

    it('offers Q3\'s ten crosshairs and no more', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        const crosshair = settings.definition('crosshair');
        expect(crosshair.kind).toBe('choice');

        if (crosshair.kind !== 'choice') return;

        expect(crosshair.options.map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(crosshair.options.map((o) => o.label)).toEqual(
            ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
        );
    });

    it('greys the frame-rate counter out when there is no panel to toggle', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        const counter = settings.definition('frame-rate-counter');

        expect(counter.enabled?.()).toBe(false);
        expect(settings.get('frame-rate-counter')).toBe(false);
    });
});
