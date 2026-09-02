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

import { ShadeIndirectLightingMode } from '@woosh/meep-engine/src/shade/renderer/ShadeIndirectLightingMode.js';

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
    FRAME_RATE_TARGET_DEFAULT,
    graphicsPage,
    type GraphicsHost,
    type GraphicsPageHosts,
} from '../src/client/ui/graphics.ts';
import {
    FOV_DEFAULT,
    gameplayPage,
    type CameraHost,
    type DifficultyHost,
} from '../src/client/ui/gameplay.ts';
import {
    VOLUME_DEFAULT,
    audioPage,
    type MasterHost,
    type MixerHost,
} from '../src/client/ui/audio.ts';
import { CROSSHAIR_DEFAULT, type Hud } from '../src/client/Hud.ts';
import { SHADOW_MODE_DEFAULT, Shadows } from '../src/client/Shadows.ts';

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
    id: 'crosshair-health',
    section: 'HUD',
    label: 'Colour crosshair by health',
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
        settings.set('crosshair-health', false);
        settings.set('crosshair', 1);

        settings.reset();

        expect(settings.get('fov')).toBe(90);
        expect(settings.get('crosshair-health')).toBe(true);
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
        settings.set('crosshair-health', false);

        const stored = JSON.parse(storage.contents.get('test') ?? '{}') as Record<string, unknown>;
        expect(stored['fov']).toBe(115);
        expect(stored['crosshair-health']).toBe(false);
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
                'crosshair-health': 'yes', // not a boolean
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
        expect(settings.get('crosshair-health')).toBe(true);
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
        expect(second.get('crosshair-health')).toBe(true);
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
    crosshairHealth: boolean;
    setCrosshair(index: number): void;
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
 *
 * The feature flags below have no assertions to carry -- they are plain public
 * booleans -- and are here because they are on the same object in the engine.
 * They start where `Renderer` starts them, so a test that asserts a default has
 * to be told the port's answer rather than agreeing with the engine's by
 * accident.
 */
function fakeRenderer() {
    const renderer = {
        /** Output viewport, whole device pixels. `Renderer.resize`'s `#size`. */
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        internalScale: 1,
        resizes: 0,

        /** `Renderer`'s own initialisers, in its own order. */
        feature_ssr_enabled: false,
        feature_ssao_enabled: true,
        feature_bloom_enabled: true,

        /**
         * `feature_motion_blur_enabled` is deliberately not here, and neither is
         * the `MotionBlur` behind it. The port removed both rows (D-127), so the
         * flag is the renderer's own `false` and nothing in this file should be
         * able to name it -- a fixture that still carried the field would let a
         * page quietly start writing it again without a test noticing.
         */

        /**
         * IBL, which is what a map with no bake leaves it at. Written by the
         * tests that need the other one; never by the page.
         */
        indirect_lighting_mode: ShadeIndirectLightingMode.IBL,

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
    /** The difficulty sink, and what the last write to it was. */
    bots: DifficultyHost & { readonly chosen: string };
    /**
     * The real policy rather than a stub, because it is the half of this row
     * that has anything in it -- the page's own job is to hand `setMode` a
     * string, and `shadows.test.ts` covers what happens to the string next.
     */
    shadows: Shadows;
    /** What the master switch was left at. See `ShadowRendererHost`. */
    shade: { renderer: { feature_shadows_enabled: boolean } };
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
        crosshairHealth: false,
        setCrosshair(index: number): void {
            hud.crosshair = index;
        },
    };

    /*
     Its own object rather than `graphics.renderer`, although in the engine it is
     the same one. `Shadows` takes its host separately -- it is built before the
     menu, from `main.ts`, so that the map's lights can be handed to it as they
     are made -- and giving the fixture the same seam keeps the shadow rows
     honest about which door they go through.
    */
    const shade = { renderer: { feature_shadows_enabled: true } };

    /*
     Where the difficulty row's writes land. `main.ts` sends them to a variable
     and then on to a `BotRuntime`; here they only have to be observable, which
     is what makes the row testable without a match to run it against.
    */
    const bots = { difficulty: '' };

    return {
        graphics,
        camera,
        hud,
        bots: {
            setDifficulty(id: string): void {
                bots.difficulty = id;
            },
            get chosen(): string {
                return bots.difficulty;
            },
        },
        shadows: new Shadows(shade),
        shade,
    };
}

/** The graphics page, built against the stand-ins. */
function pageFor(h: ReturnType<typeof hosts>): SettingsPage {
    return graphicsPage({
        graphics: h.graphics,
        frameRateCounter: null,
        shadows: h.shadows,
    });
}

/** The gameplay page, over the same stand-ins. */
function gameplayFor(h: ReturnType<typeof hosts>): SettingsPage {
    return gameplayPage({
        camera: h.camera,
        hud: h.hud as unknown as Hud,
        bots: h.bots,
    });
}

describe('the graphics page', () => {
    it('pushes every default at the engine when it is applied', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        settings.applyAll();

        expect(h.graphics.dynamic_resolution.target_frame_rate).toBe(FRAME_RATE_TARGET_DEFAULT);
        expect(h.shadows.mode).toBe(SHADOW_MODE_DEFAULT);
    });

    /*
     The rows that left. Asserted by absence rather than trusted, because the two
     pages are built from the same `hosts()` and a row that failed to move would
     be a duplicate id -- which `Settings` throws on -- only if *both* pages were
     handed to it, and half of these tests hand it one.
    */
    it('is not where the gameplay rows are', () => {
        const ids = pageFor(hosts()).settings.map((setting) => setting.id);

        expect(ids).not.toContain('fov');
        expect(ids).not.toContain('crosshair');
        expect(ids).not.toContain('crosshair-health');
    });

    /*
     Motion blur, which is gone from the menu entirely (D-127): a Quake player
     wants the frame they turn onto to be readable, and the switch that was one
     flag away was one nobody should move. The whole of how it stays off is that
     nothing writes it -- `Renderer`'s own field initialiser is `false` -- so
     what is worth a test is that nothing does.
    */
    it('has no motion-blur row, and does not reach for the flag behind one', () => {
        const h = hosts();
        const page = pageFor(h);
        const ids = page.settings.map((setting) => setting.id);

        expect(ids).not.toContain('motion-blur');
        expect(ids).not.toContain('motion-blur-strength');

        // And nothing on the page writes the flag by another name. `applyAll`
        // pushes every row at the fixture; a renderer that never grew the
        // property is one no row assigned.
        new Settings([page]).applyAll();

        expect('feature_motion_blur_enabled' in h.graphics.renderer).toBe(false);
        expect('motion_blur' in h.graphics.renderer).toBe(false);
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

    /*
     Off, and off whether or not there is a panel -- which is the change worth an
     assertion, because the row used to start at `frameRateCounter !== null` and
     "on wherever it could be on" is a plausible thing for it to drift back to.
    */
    it('starts the frame-rate counter off, and hides a panel that exists', () => {
        const h = hosts();

        /*
         `stats.js` in an `EmptyView`, narrowed to the one property the row
         writes. Cast because meep's `View` is a class with a good deal more on
         it, and none of the rest is reachable from this row.
        */
        const panel = { visible: true };

        const settings = new Settings([
            graphicsPage({
                graphics: h.graphics,
                frameRateCounter: panel as unknown as GraphicsPageHosts['frameRateCounter'],
                shadows: h.shadows,
            }),
        ]);

        expect(settings.get('frame-rate-counter')).toBe(false);
        expect(settings.definition('frame-rate-counter').enabled?.()).toBe(true);

        // Applied, not merely held: the panel is added by `addFrameRateCounter`
        // before the menu exists and is visible when it arrives, so the default
        // has to be pushed at it rather than assumed.
        settings.applyAll();
        expect(panel.visible).toBe(false);

        expect(settings.set('frame-rate-counter', true)).toBe(true);
        expect(panel.visible).toBe(true);
    });

    it('greys the frame-rate counter out when there is no panel to toggle', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        const counter = settings.definition('frame-rate-counter');

        expect(counter.enabled?.()).toBe(false);
        expect(settings.get('frame-rate-counter')).toBe(false);
    });

    it('offers the three shadow modes, cheapest first', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        const shadows = settings.definition('shadows');
        expect(shadows.kind).toBe('choice');

        if (shadows.kind !== 'choice') return;

        expect(shadows.options.map((o) => o.value)).toEqual(['off', 'sun', 'all']);
    });

    /*
     The row is a `<select>`, so what reaches `apply` is a string and never the
     `ShadowMode` the policy is typed for. That is the seam worth an assertion:
     it is the one place a rename of the mode strings would compile cleanly and
     stop working.
    */
    it('carries a choice through to the policy and to the renderer', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        settings.applyAll();
        expect(h.shade.renderer.feature_shadows_enabled).toBe(true);

        /*
         The default is the middle mode (D-128), so the page arrives with the
         sun casting and the map's own fixtures not -- and both directions off
         it are worth walking, because a `setMode` that ignored its argument
         would agree with whichever one this test only asserted the default of.
        */
        expect(h.shadows.mode).toBe('sun');
        expect(h.shadows.casts('sun')).toBe(true);
        expect(h.shadows.casts('world')).toBe(false);

        expect(settings.set('shadows', 'all')).toBe(true);
        expect(h.shadows.mode).toBe('all');
        expect(h.shadows.casts('world')).toBe(true);

        expect(settings.set('shadows', 'off')).toBe(true);
        expect(h.shade.renderer.feature_shadows_enabled).toBe(false);

        // ...and a value from a build that spelled them differently is refused
        // by `coerce` before the policy is ever asked.
        expect(settings.set('shadows', 'ultra')).toBe(false);
        expect(h.shadows.mode).toBe('off');
    });

    /*
     The three `feature_*` rows that are left. Worth their own assertions and not
     folded into the defaults test above, because all three are the engine's own
     initial value -- an `applyAll` that wrote nothing at all would pass a test
     that only compared them afterwards. So each one is moved off its default
     and back.
    */
    it('pushes the feature switches at the renderer', () => {
        const h = hosts();
        const settings = new Settings([pageFor(h)]);

        settings.applyAll();

        expect(h.graphics.renderer.feature_ssao_enabled).toBe(true);
        expect(h.graphics.renderer.feature_bloom_enabled).toBe(true);
        expect(h.graphics.renderer.feature_ssr_enabled).toBe(false);

        expect(settings.set('ambient-occlusion', false)).toBe(true);
        expect(h.graphics.renderer.feature_ssao_enabled).toBe(false);

        expect(settings.set('bloom', false)).toBe(true);
        expect(h.graphics.renderer.feature_bloom_enabled).toBe(false);

        // On an IBL map, which is what the fixture starts as, reflections are
        // reachable and the flag is written.
        expect(settings.set('reflections', true)).toBe(true);
        expect(h.graphics.renderer.feature_ssr_enabled).toBe(true);

        expect(settings.set('ambient-occlusion', true)).toBe(true);
        expect(h.graphics.renderer.feature_ssao_enabled).toBe(true);
    });

    /*
     The trap, and the reason the reflections row guards its own `apply` instead
     of trusting `enabled` to have greyed the control out. `enabled` is a
     question the *screen* asks; a value arriving out of storage does not go past
     a control at all, and `applyAll` runs before anything is drawn.

     What the stale flag would cost is not nothing, which is why it is refused
     rather than merely useless: `use_fused_indirect` is
     `fused_indirect && mode === Brick4 && !feature_ssr_enabled`, so a true here
     buys the split indirect path and draws no reflection with it.
    */
    it('refuses to enable reflections in Brick4, from the screen or from storage', () => {
        const h = hosts();
        h.graphics.renderer.indirect_lighting_mode = ShadeIndirectLightingMode.Brick4;

        const settings = new Settings([pageFor(h)]);

        expect(settings.definition('reflections').enabled?.()).toBe(false);

        /*
         `set` still returns true -- the value moved, is held and will be saved,
         which is what a greyed-out row does everywhere else on this page. What
         must not move is the renderer.
        */
        expect(settings.set('reflections', true)).toBe(true);
        expect(settings.get('reflections')).toBe(true);
        expect(h.graphics.renderer.feature_ssr_enabled).toBe(false);

        // And the same value arriving the other way, which is the case the
        // control cannot cover: a session on an IBL map saved `true`.
        settings.applyAll();
        expect(h.graphics.renderer.feature_ssr_enabled).toBe(false);
    });

    /*
     `GraphicsEngine3.renderer` is null before `start()` and after `stop()`, and
     its `.d.ts` says otherwise -- so this is the case TypeScript will not catch
     and the browser will. `applyAll` at startup is exactly where it would land.
    */
    it('applies without a renderer', () => {
        const h = hosts();
        const settings = new Settings([
            graphicsPage({
                graphics: { ...h.graphics, renderer: null },
                frameRateCounter: null,
                shadows: h.shadows,
            }),
        ]);

        expect(() => settings.applyAll()).not.toThrow();
        expect(settings.definition('reflections').enabled?.()).toBe(false);

        // The rows that do not need one still work.
        expect(settings.set('adaptive-resolution', false)).toBe(true);
        expect(settings.set('render-scale', 0.75)).toBe(true);
        expect(h.graphics.renderer.internalScale).toBe(0.75);
    });
});

/* ------------------------------------------------------------------ *
 * The gameplay page
 * ------------------------------------------------------------------ */

/*
 * The three rows that used to be on the graphics page, and the two defaults that
 * changed on the way over. Their own block, because "the crosshair reaches the
 * HUD" is the same assertion wherever the row is filed and the thing worth
 * testing about the move is that it is complete: `Settings` throws on a
 * duplicate id, so the two pages together are the check that no row was copied
 * rather than moved.
 */
describe('the gameplay page', () => {
    it('pushes its defaults at the camera and the HUD', () => {
        const h = hosts();
        const settings = new Settings([gameplayFor(h)]);

        settings.applyAll();

        expect(h.camera.value).toBe(FOV_DEFAULT);
        expect(h.hud.crosshair).toBe(CROSSHAIR_DEFAULT);
        expect(h.hud.crosshairHealth).toBe(true);
    });

    /*
     `crosshaird` rather than id's `crosshaire`, which is the one place this port
     disagrees with `cg_drawCrosshair`'s default (D-129). Written as the index
     *and* the letter because the two are a `String.fromCharCode` apart and a
     test that only checked the number would pass on a page that had renumbered
     the options.
    */
    it("starts on D, which is not cg_drawCrosshair's own default", () => {
        const h = hosts();
        const settings = new Settings([gameplayFor(h)]);

        const crosshair = settings.definition('crosshair');
        expect(crosshair.kind).toBe('choice');
        if (crosshair.kind !== 'choice') return;

        expect(CROSSHAIR_DEFAULT).toBe(3);
        expect(crosshair.initial).toBe(CROSSHAIR_DEFAULT);
        expect(crosshair.options[CROSSHAIR_DEFAULT]?.label).toBe('D');

        // And id's is still one of the ten on offer, which is the whole of what
        // makes this a default rather than a decision taken away from anyone.
        expect(crosshair.options.map((o) => o.value)).toContain(4);
    });

    it("offers Q3's ten crosshairs and no more", () => {
        const h = hosts();
        const settings = new Settings([gameplayFor(h)]);

        const crosshair = settings.definition('crosshair');
        expect(crosshair.kind).toBe('choice');

        if (crosshair.kind !== 'choice') return;

        expect(crosshair.options.map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(crosshair.options.map((o) => o.label)).toEqual(
            ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
        );
    });

    it('carries the field of view to the camera, within the range it offers', () => {
        const h = hosts();
        const settings = new Settings([gameplayFor(h)]);
        settings.applyAll();

        expect(settings.set('fov', 110)).toBe(true);
        expect(h.camera.value).toBe(110);

        // Q3's cvar clamps at 1 and 160; the row is narrowed to where the game
        // is playable, and `coerce` clamps rather than refusing.
        expect(settings.set('fov', 400)).toBe(true);
        expect(h.camera.value).toBe(130);

        expect(settings.set('fov', 1)).toBe(true);
        expect(h.camera.value).toBe(60);
    });

    /*
     The move itself. Both pages into one `Settings`, which is what `main.ts`
     does -- and which throws on a duplicate id, so a row left behind on the
     graphics page fails here rather than showing up twice in the menu.
    */
    it('shares no setting with the graphics page, and is built alongside it', () => {
        const h = hosts();

        const settings = new Settings([gameplayFor(h), pageFor(h)]);

        expect(() => settings.applyAll()).not.toThrow();

        expect(settings.definition('fov').section).toBe('View');
        expect(settings.definition('crosshair').section).toBe('Reticle');
        expect(settings.definition('shadows').section).toBe('Lighting');
    });
});

/* ------------------------------------------------------------------ *
 * The audio page
 * ------------------------------------------------------------------ */

/**
 * sopra's `BusGraph`, and the mix `SopraEngine.defaultBuses()` actually ships.
 *
 * The levels are the fixture's whole point and are the engine's own:
 * `LEGACY_EFFECTS_VOLUME` is **1.2** and `LEGACY_MUSIC_VOLUME` is **0.1**, so
 * the shipped mix is emphatically not flat. A page whose faders wrote linear
 * gains would test green against a fixture that started every bus at 1, and
 * would remix the game on the first frame against the engine.
 */
function fakeBuses(): MixerHost & { levels: Record<string, number> } {
    const levels: Record<string, number> = {
        master: 1,
        effects: 1.2,
        music: 0.1,
        ambient: 1,
    };

    return {
        levels,
        has: (id: string): boolean => id in levels,
        getVolume: (id: string): number => {
            const level = levels[id];
            if (level === undefined) throw new Error(`no such bus '${id}'`);
            return level;
        },
        setVolume: (id: string, linear: number): void => {
            if (!(id in levels)) throw new Error(`no such bus '${id}'`);
            levels[id] = linear;
        },
    };
}

describe('the audio page', () => {
    /*
     The regression the whole design is arranged around. Faders that wrote
     absolute gains and defaulted to 1.0 would, on the first frame `applyAll`
     ran, drop every effect from 1.2 to 1.0 and raise the background track from
     0.1 to 1.0 -- a settings screen that remixes the game by existing, in the
     direction of a twenty-decibel music track.
    */
    it('leaves the shipped mix exactly where it was when it applies its defaults', () => {
        const buses = fakeBuses();
        const master = { volume: 1 };
        const before = { ...buses.levels };

        const settings = new Settings([audioPage({ master, buses })]);
        settings.applyAll();

        expect(buses.levels).toEqual(before);
        expect(master.volume).toBe(1);
    });

    it('scales each bus by its fader rather than replacing it', () => {
        const buses = fakeBuses();
        const master = { volume: 1 };

        const settings = new Settings([audioPage({ master, buses })]);
        settings.applyAll();

        expect(settings.set('volume-music', 0.5)).toBe(true);
        expect(buses.levels['music']).toBeCloseTo(0.05, 10);

        // Half of the shipped 1.2, and not 0.5.
        expect(settings.set('volume-effects', 0.5)).toBe(true);
        expect(buses.levels['effects']).toBeCloseTo(0.6, 10);

        // All the way down is silence, and all the way back up is the mix as
        // shipped -- a multiplier has to be able to return to where it started.
        expect(settings.set('volume-effects', 0)).toBe(true);
        expect(buses.levels['effects']).toBe(0);

        expect(settings.set('volume-effects', VOLUME_DEFAULT)).toBe(true);
        expect(buses.levels['effects']).toBeCloseTo(1.2, 10);
    });

    /*
     One row over two buses. `AudioBank` sends one-shots to `effects` and looping
     map speakers to `ambient`, which is a mixing distinction and not one a
     player has a word for -- so a fader that moved only the first would leave
     the fire in the corner of `oa_dm5` roaring away under a volume control the
     player had set to zero.
    */
    it('takes the looping ambience down with the effects', () => {
        const buses = fakeBuses();
        const settings = new Settings([audioPage({ master: { volume: 1 }, buses })]);
        settings.applyAll();

        settings.set('volume-effects', 0);

        expect(buses.levels['effects']).toBe(0);
        expect(buses.levels['ambient']).toBe(0);

        // ...and nothing else moved with them.
        expect(buses.levels['music']).toBeCloseTo(0.1, 10);
        expect(buses.levels['master']).toBe(1);
    });

    /*
     Master is the `SoundEngine`'s gain node and not sopra's `master` bus, and
     the difference is audible rather than academic: `ProbeReverbRenderer` mixes
     its wet return into `sound.destination`, below the bus tree, so a master
     fader on the bus would take the dry signal to zero and leave the
     reverberation of it at full level.
    */
    it('writes master below the bus tree, where the reverb return also lands', () => {
        const buses = fakeBuses();
        const master = { volume: 1 };

        const settings = new Settings([audioPage({ master, buses })]);
        settings.applyAll();

        expect(settings.set('volume-master', 0)).toBe(true);
        expect(master.volume).toBe(0);

        // The bus is untouched. If this ever fails, the wet tail of every sound
        // survives a master fader set to silence.
        expect(buses.levels['master']).toBe(1);
    });

    /*
     No `AudioContext`, which is a browser decision and not an error, and no
     sopra engine, which is what a run with no sound systems looks like.
     `applyAll` runs at startup either way.
    */
    it('applies with no sound engine at all', () => {
        const settings = new Settings([audioPage({ master: null, buses: null })]);

        expect(() => settings.applyAll()).not.toThrow();

        // The values are still held and still saved -- a session that had no
        // audio should not forget the levels a session that did had chosen.
        expect(settings.set('volume-music', 0.25)).toBe(true);
        expect(settings.get('volume-music')).toBe(0.25);
    });

    /*
     `SopraEngine.setBuses` takes any list of `BusDefinition`s, so the bus tree
     is not a constant, and a page that assumed the four default ids would throw
     out of `getVolume` on a game that had replaced it.
    */
    it('ignores a bus the mixer does not have', () => {
        const buses = fakeBuses();
        delete buses.levels['music'];

        const settings = new Settings([audioPage({ master: { volume: 1 }, buses })]);

        expect(() => settings.applyAll()).not.toThrow();

        expect(settings.set('volume-music', 0.5)).toBe(true);
        expect(settings.get('volume-music')).toBe(0.5);
        expect(buses.has('music')).toBe(false);

        // The two that are there still work.
        settings.set('volume-effects', 0.5);
        expect(buses.levels['effects']).toBeCloseTo(0.6, 10);
    });

    /*
     A fader is a fraction of the shipped mix, and the fraction is what is
     stored. So a level chosen in one session has to mean the same thing in the
     next -- which it does only because the shipped level is read at page build,
     before anything has written to it, rather than read back off the bus. A page
     that read the bus lazily would compound its own output and the mix would
     ratchet down one reload at a time.
    */
    it('means the same thing after a reload as it did before one', async () => {
        const buses = fakeBuses();
        const store = memoryStorage();

        const first = new Settings([audioPage({ master: { volume: 1 }, buses })]);
        await first.attach(store);
        first.applyAll();

        first.set('volume-effects', 0.4);
        expect(buses.levels['effects']).toBeCloseTo(0.48, 10);

        // A second session, over a mixer back at the shipped mix because the
        // engine builds it fresh.
        const reloaded = fakeBuses();
        const second = new Settings([audioPage({ master: { volume: 1 }, buses: reloaded })]);
        await second.attach(store);
        second.applyAll();

        expect(second.get('volume-effects')).toBe(0.4);
        expect(reloaded.levels['effects']).toBeCloseTo(0.48, 10);
    });
});
