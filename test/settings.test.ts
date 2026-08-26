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

import { describe, expect, it, vi } from 'vitest';

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

/**
 * A viewport that is not a round number, which is the whole point of it.
 *
 * The bug this fixture exists to refuse shipped because the browser it was
 * checked in was 1280 x 720, where every render scale tried happened to multiply
 * to an integer. The first real window was 969 tall, 90% of it is
 * 872.0999999999999, and `Renderer.resize` asserts integers.
 */
const VIEWPORT: { readonly width: number; readonly height: number } = { width: 1727, height: 969 };

/**
 * A stand-in that refuses what the real renderer refuses.
 *
 * The point is not fidelity for its own sake. A fake that accepts everything
 * tests only that the port calls something; a fake that carries the same
 * assertions tests that the port calls it with a value it will take. These are
 * `Renderer.resize`, `Renderer.internal_resolution_scale` and
 * `GraphicsEngine3.updateSize` transcribed, and nothing else.
 */
function fakeRenderer() {
    const renderer = {
        /** Output viewport, whole device pixels. `Renderer.resize`'s `#size`. */
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        internalScale: 1,
        resizes: 0,

        /** `Renderer.resize`, whose first two lines are the assertions. */
        resize(x: number, y: number): void {
            for (const [name, v] of [['x', x], ['y', y]] as const) {
                if (!Number.isInteger(v) || v < 0) {
                    throw new Error(`${name} must be an integer, instead was ${v}`);
                }
            }
            renderer.width = x;
            renderer.height = y;
            renderer.resizes++;
        },

        /** `set internal_resolution_scale`, whose four assertions these are. */
        setInternalScale(v: number): void {
            if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`v must be a number`);
            if (!Number.isFinite(v)) throw new Error(`v must be finite, instead was ${v}`);
            if (!(v > 0)) throw new Error(`v must be greater than 0, instead was ${v}`);
            renderer.internalScale = v;
        },

        /** `#update_internal_resolution`, which is where the scale lands. */
        get internalResolution(): [number, number] {
            return [
                Math.floor(renderer.width * renderer.internalScale),
                Math.floor(renderer.height * renderer.internalScale),
            ];
        },
    };

    return renderer;
}

/**
 * Stand-ins for the things the graphics page writes.
 *
 * `pixelRatio` and `updateSize` are here although `GraphicsHost` no longer
 * declares them, and that is deliberate: they are the trap. If a later change
 * puts them back on the interface and writes a fractional ratio, this fixture
 * reproduces `updateSize`'s multiply against a viewport that is not round, and
 * `resize` throws exactly where the engine throws.
 */
function hosts(): {
    graphics: GraphicsHost & {
        renderer: ReturnType<typeof fakeRenderer>;
        resets: number;
        pixelRatio: { set(x: number): void; getValue(): number };
        updateSize(): void;
    };
    camera: CameraHost & { value: number };
    hud: HudStub;
} {
    const renderer = fakeRenderer();

    const graphics = {
        renderer,
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

        /** `GraphicsEngine3.updateSize`, which does not round the product. */
        updateSize(): void {
            renderer.resize(VIEWPORT.width * graphics.ratio, VIEWPORT.height * graphics.ratio);
        },

        dynamic_resolution: {
            enabled: true,
            target_frame_rate: 30,
            get_scale: (): number => renderer.internalScale,
            set_scale: (v: number): void => renderer.setInternalScale(v),
            reset(): void {
                graphics.resets++;
            },
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
        expect(h.graphics.dynamic_resolution.target_frame_rate).toBe(FRAME_RATE_TARGET_DEFAULT);
        expect(h.hud.crosshair).toBe(4);
        expect(h.hud.speedometer).toBe(true);
    });

    it('never hands the renderer a scale it refuses, at any step of the slider', () => {
        /*
         The regression this file exists for. `pixelRatio` -- the obvious render
         scale, and the one this shipped with -- multiplies into the viewport
         size and is asserted to be an integer, so 90% of a 969-tall window is
         872.0999999999999 and throws. It was missed because the browser it was
         checked in was 1280 x 720, where every scale tried came out whole.

         So: walk every value the slider can produce, against a viewport that is
         not round, through a fake carrying the engine's own assertions.
        */
        const h = hosts();
        const settings = new Settings([pageFor(h)]);
        settings.applyAll();

        settings.set('adaptive-resolution', false);

        const scale = settings.definition('render-scale');
        expect(scale.kind).toBe('slider');
        if (scale.kind !== 'slider') return;

        /*
         `Settings.applyOne` catches, so that one bad row cannot take the rest of
         the page down -- which means a setting that throws is a log line and not
         a test failure. Watching the log is how the throw itself becomes the
         diagnostic rather than whatever goes stale downstream of it.
        */
        const failures = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        for (let v = scale.min; v <= scale.max + 1e-9; v += scale.step) {
            const step = Number(v.toFixed(6));

            expect(() => settings.set('render-scale', step), `${step}`).not.toThrow();

            /*
             Checked here rather than after the loop, so that the engine's own
             message is what a failure reads out. Leaving it to the end lets the
             downstream assertion trip first and report "expected 1 to be 0.5",
             which is the symptom rather than the cause.
            */
            const thrown = failures.mock.calls.map((call) => String(call[1] ?? call[0]));
            expect(thrown, `${step}: ${thrown.join(' | ')}`).toEqual([]);

            expect(settings.get('render-scale'), `${step}`).toBe(step);
            expect(h.graphics.renderer.internalScale, `${step}`).toBe(step);

            // And what it lands on is a resolution, not a fraction of a pixel.
            const [w, hgt] = h.graphics.renderer.internalResolution;
            expect(Number.isInteger(w) && w > 0, `${step} -> ${w}`).toBe(true);
            expect(Number.isInteger(hgt) && hgt > 0, `${step} -> ${hgt}`).toBe(true);
        }

        failures.mockRestore();

        // The renderer was never resized: the render scale is internal, and
        // resizing is what threw.
        expect(h.graphics.renderer.resizes).toBe(0);
    });

    it('leaves the scale alone while the controller owns it, and takes it back after', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);
        settings.applyAll();

        // Adaptive is on by default, so a manual write is held and not applied
        // -- writing it would be overwritten on the controller's next decision.
        expect(settings.set('render-scale', 0.7)).toBe(true);
        expect(settings.get('render-scale')).toBe(0.7);
        expect(h.graphics.renderer.internalScale).toBe(1);

        // ...and the controller moves it where it likes in the meantime.
        h.graphics.dynamic_resolution.set_scale(0.55);

        // Turning adaptive off hands the wheel back, at the value the menu holds
        // rather than the one the controller left behind.
        settings.set('adaptive-resolution', false);
        expect(h.graphics.renderer.internalScale).toBe(0.7);

        // And from then on a write goes straight through.
        settings.set('render-scale', 0.85);
        expect(h.graphics.renderer.internalScale).toBe(0.85);
    });

    it('greys each of the two resolution rows out when the other owns the scale', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);
        settings.applyAll();

        const target = settings.definition('frame-rate-target');
        const scale = settings.definition('render-scale');

        // Adaptive on: it owns the scale, so the target is live and the manual
        // scale is not.
        expect(target.enabled?.()).toBe(true);
        expect(scale.enabled?.()).toBe(false);
        expect(h.graphics.dynamic_resolution.enabled).toBe(true);

        settings.set('adaptive-resolution', false);

        expect(target.enabled?.()).toBe(false);
        expect(scale.enabled?.()).toBe(true);
        expect(h.graphics.dynamic_resolution.enabled).toBe(false);

        // Still writable and still saved while inert -- it is the reading of it
        // that stops, not the holding of it.
        expect(settings.set('frame-rate-target', 144)).toBe(true);
        expect(h.graphics.dynamic_resolution.target_frame_rate).toBe(144);
    });

    it('orders the resolution rows cause before effect', () => {
        // A disabled control directly under the switch that disabled it explains
        // itself; the same control in another section reads as broken.
        const h = hosts();
        const page = pageFor(h);

        const ids = page.settings
            .filter((setting) => setting.section === 'Performance')
            .map((setting) => setting.id);

        expect(ids.indexOf('adaptive-resolution')).toBeLessThan(ids.indexOf('render-scale'));
        expect(ids.indexOf('adaptive-resolution')).toBeLessThan(ids.indexOf('frame-rate-target'));
    });

    it("offers Q3's ten crosshairs and no more", () => {
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
