/*
 * graphics.ts -- the graphics page, and what in the engine each row reaches.
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
 * Every row here writes something the engine already exposes and the port
 * already owns. That is the whole list, and it was shorter than a graphics menu
 * usually is for a reason worth stating in the file rather than only in the
 * report:
 *
 * `GraphicsEngine3` is a deliberately narrow facade. Its own docblock names what
 * it will not hand out -- `renderer` above all, at a cost it counts in callers --
 * so shadow resolution, anti-aliasing, ambient occlusion, screen-space
 * reflections and the indirect-lighting mode were all properties of a `Renderer`
 * this application could not reach. That is GAP-024, filed when the same wall
 * stopped the lighting half of phase 8, and it is why a graphics menu for a
 * WebGPU engine had a field of view and a resolution scale on it rather than a
 * quality preset.
 *
 * **3.6.0 opened it**, by the narrowest door and with a warning on it: a
 * `renderer` getter whose docblock is "Danger zone. Be careful with what you do,
 * with great Renderer comes great responsibility." That is what makes the
 * shadow row below possible, and it is the same property `main.ts` already uses
 * to put a scene into Brick4 (D-107). What the page still does not have is a
 * shadow *resolution*, which is `DEFAULT_SHADOWMAP_LOCAL_RESOLUTION` and a
 * module-private constant -- so GAP-024 is smaller rather than closed.
 *
 * What is reachable, and is here:
 *
 *   `dynamic_resolution`   adaptive resolution, its target, and the render scale
 *   `Camera.fov`           field of view -- the port's own component
 *   `Shadows`              which lights cast, over the renderer's master switch
 *   `Hud`                  the port's own 2D
 *
 * `dynamic_resolution` is the one the engine explicitly invites: "exposed so
 * that it can be turned off or re-targeted -- a measurement that wants a fixed
 * resolution, **or a settings screen that offers the choice**".
 *
 * ---
 *
 * **The render scale is `internal_resolution_scale`, and it is reached through
 * the controller.** That deserves stating plainly, because it is the one thing
 * in this file that is not the front door.
 *
 * `GraphicsEngine3.pixelRatio` looks like the render scale and is not usable as
 * one. Two independent defects: nothing subscribes to its `onChanged`, so
 * writing it resizes nothing until the window happens to move (GAP-027); and
 * `updateSize()` multiplies it into the viewport size and hands the product to
 * `Renderer.resize`, which asserts both arguments are integers. A viewport 969
 * tall at 90% is 872.0999999999999 and throws (BUG-11). It is not a scale that
 * can be set to a scale.
 *
 * What a render-scale setting actually wants is `Renderer.internal_resolution_scale`
 * -- *"Fraction of the output resolution. If this is set to 0.5 for example,
 * internal resolution will be 50% of the output resolution"* -- which floors
 * internally, takes any positive number, and is upscaled back by the renderer's
 * own TAA/NSS rather than by the browser stretching a smaller canvas. The
 * engine's own playground presents exactly this value as a percentage slider
 * labelled "Scale" (`shade/playground/main.js:2637`).
 *
 * An application cannot reach it. `GraphicsEngine3` hands out no renderer, and
 * the only reference to it outside the renderer is the pair of closures the
 * facade assigns into `DynamicResolutionScaling`:
 *
 *     this.#dynamic_resolution.get_scale = () => this.#renderer.internal_resolution_scale;
 *     this.#dynamic_resolution.set_scale = v => { this.#renderer.internal_resolution_scale = v; };
 *
 * Those are public properties on a public object, so calling them is an API
 * call and not a monkey-patch -- but they are the controller's plumbing, and
 * using them as the port's render-scale setter is reaching around a facade that
 * deliberately hides what is behind them. Recorded rather than dressed up: it is
 * the same wall as GAP-024, and the honest fix is a property on the facade.
 *
 * The consequence for the menu is real and is not a workaround: the manual scale
 * and the adaptive controller write the same number, so they are alternatives.
 * Each greys the other's row out, which is how every shipped game presents this
 * pair anyway.
 */

import { CROSSHAIR_DEFAULT, type Hud } from '../Hud.ts';
import { NUM_CROSSHAIRS } from '../crosshair.ts';
import { SHADOW_MODE_DEFAULT, type ShadowMode } from '../Shadows.ts';
import type { Setting, SettingsPage } from './Settings.ts';
import type { View } from './meep.ts';

/**
 * The parts of `GraphicsEngine3` this page writes.
 *
 * Structural rather than the class itself, so the page can be built and tested
 * against a stand-in. Nothing here is optional in the engine; the narrowing is
 * for the caller's benefit, not the engine's.
 */
export interface GraphicsHost {
    readonly dynamic_resolution: {
        enabled: boolean;
        target_frame_rate: number;
        /** Reads `Renderer.internal_resolution_scale`. See the file header. */
        get_scale: () => number;
        /** Writes it. Only meaningful while `enabled` is false. */
        set_scale: (value: number) => void;
        reset(): void;
    };
}

export interface CameraHost {
    readonly fov: { set(x: number): unknown; getValue(): number };
}

/** The part of `Shadows` this page writes. See `Shadows.ts` for what it does. */
export interface ShadowHost {
    readonly mode: ShadowMode;
    setMode(raw: unknown): boolean;
}

export interface GraphicsPageHosts {
    readonly graphics: GraphicsHost;
    readonly camera: CameraHost;
    readonly hud: Hud;
    /** The `stats.js` panel, if one was built -- see `frameRateCounter.ts`. */
    readonly frameRateCounter: View | null;
    readonly shadows: ShadowHost;
}

/**
 * `cg_fov`'s own default, and the range Q3's `cg_fov` cvar accepts.
 *
 * Q3 clamps to 1..160 and every competitive config sits between 90 and 120. The
 * range is narrowed to where the game is playable rather than to where the cvar
 * is legal: 60 is claustrophobic and 130 is already a fish-eye at 16:9, and a
 * slider whose useful travel is a fifth of its width is a worse control than one
 * that cannot reach the settings nobody wants.
 */
export const FOV_DEFAULT = 90;

/**
 * The engine targets 30 and says so deliberately -- "the game's target is the
 * game's decision (D39)". This is the game making it: a 30 Hz floor-holder in a
 * shooter lets the resolution controller sit still through the whole range where
 * a Quake player can feel the difference.
 */
export const FRAME_RATE_TARGET_DEFAULT = 60;

/**
 * Render scale, as a fraction of the output resolution.
 *
 * The renderer accepts any positive number and the engine's own playground
 * offers 0.1 to 1. The floor here is 0.5 because below that a 1080p arena is
 * being upscaled from under 540 lines and the port would be showing off the
 * upscaler rather than the renderer; the ceiling is 1 because above it the
 * quantity stops being "internal resolution" and becomes supersampling, which is
 * `pixelRatio`'s job and `pixelRatio` throws (BUG-11).
 *
 * `DynamicResolutionScaling`'s own bounds for comparison: `min_scale` 0.43,
 * `max_scale` 1.0.
 */
const RENDER_SCALE_MIN = 0.5;
const RENDER_SCALE_MAX = 1;

/**
 * Build the graphics page.
 *
 * The settings are values, and the page is a value: nothing here subclasses
 * anything, so the map picker and the match setup this menu is going to grow
 * are another function of this shape and no change to the shell.
 */
export function graphicsPage(hosts: GraphicsPageHosts): SettingsPage {
    const { graphics, camera, hud, frameRateCounter, shadows } = hosts;

    /*
     Mirrored in closures rather than read back off the engine, so that a row
     greys out on the value the menu wrote rather than on whatever the
     resolution controller has done with it since -- which, once adaptive
     resolution is running, is a different number every few seconds.
    */
    let adaptive = graphics.dynamic_resolution.enabled;
    let renderScale = graphics.dynamic_resolution.get_scale();

    /**
     * Pin the render scale, unless the controller owns it.
     *
     * Writing it while `enabled` is true would be overwritten by the controller
     * on its next decision, which is worse than not writing it: the setting
     * would appear to work and then drift.
     */
    const pinRenderScale = (): void => {
        if (!adaptive) graphics.dynamic_resolution.set_scale(renderScale);
    };

    const settings: Setting[] = [
        {
            kind: 'slider',
            id: 'fov',
            section: 'Display',
            label: 'Field of view',
            note: "cg_fov. Q3's own default is 90.",
            initial: FOV_DEFAULT,
            min: 60,
            max: 130,
            step: 1,
            format: (v) => `${v}°`,
            apply: (v) => camera.fov.set(v),
        },
        /*
         Which lights cast, rather than a shadow *quality*, because which lights
         cast is what an application can set and quality is not: the local
         shadowmap resolution is a module-private constant in the renderer's
         shadow context, and the atlas size is another beside it.

         The three values are cheapest first and the labels say which lights
         rather than "low / medium / high", because the axis really is which
         lights -- a player choosing between them is choosing whether the room's
         own lamps throw anything, which is a picture they can imagine, and not
         a number of texels they cannot.
        */
        {
            kind: 'choice',
            id: 'shadows',
            section: 'Lighting',
            label: 'Shadows',
            note: 'Every light on a Q3 arena is a fixture; all of them casting is the expensive one.',
            initial: SHADOW_MODE_DEFAULT,
            options: [
                { value: 'off', label: 'Off' },
                { value: 'sun', label: 'Sunlight only' },
                { value: 'all', label: 'All lights' },
            ],
            apply: (v) => {
                shadows.setMode(v);
            },
        },
        /*
         The controller and the manual scale write the same number, so the three
         rows are ordered cause-then-effect: the toggle that owns the quantity
         first, and the two rows it governs beneath it -- one greying out when it
         is on, the other when it is off. A disabled control directly under the
         switch that disabled it explains itself; the same control in another
         section reads as broken.
        */
        {
            kind: 'toggle',
            id: 'adaptive-resolution',
            section: 'Performance',
            label: 'Adaptive resolution',
            note: 'Sets the render scale itself, to hold the target below.',
            initial: adaptive,
            apply: (v) => {
                adaptive = v;
                graphics.dynamic_resolution.enabled = v;

                if (v) {
                    /*
                     The controller's estimator is a pair of EMAs over frame
                     time, and its own documentation says to `reset()` after
                     "anything that would otherwise pollute the estimators with
                     pre-event samples". Handing it the wheel is exactly that.
                    */
                    graphics.dynamic_resolution.reset();
                } else {
                    // Take the scale back from wherever the controller left it.
                    pinRenderScale();
                }
            },
        },
        {
            kind: 'slider',
            id: 'render-scale',
            section: 'Performance',
            label: 'Render scale',
            note: 'What the arena is drawn at before the renderer upscales it.',
            initial: 1,
            min: RENDER_SCALE_MIN,
            max: RENDER_SCALE_MAX,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            enabled: () => !adaptive,
            apply: (v) => {
                renderScale = v;
                pinRenderScale();
            },
        },
        {
            kind: 'choice',
            id: 'frame-rate-target',
            section: 'Performance',
            label: 'Frame-rate target',
            note: 'What adaptive resolution aims to hold.',
            initial: FRAME_RATE_TARGET_DEFAULT,
            options: [30, 60, 72, 90, 120, 144].map((rate) => ({
                value: rate,
                label: `${rate} fps`,
            })),
            enabled: () => adaptive,
            apply: (v) => {
                graphics.dynamic_resolution.target_frame_rate = Number(v);
            },
        },
        {
            kind: 'toggle',
            id: 'frame-rate-counter',
            section: 'Performance',
            label: 'Frame-rate counter',
            initial: frameRateCounter !== null,
            enabled: () => frameRateCounter !== null,
            apply: (v) => {
                if (frameRateCounter !== null) frameRateCounter.visible = v;
            },
        },
        {
            kind: 'choice',
            id: 'crosshair',
            section: 'Reticle',
            label: 'Crosshair',
            note: "cg_drawCrosshair. id's default, E, is a dot rather than a cross.",
            initial: CROSSHAIR_DEFAULT,
            // `gfx/2d/crosshair[a-j]`, which is what the index selects and what
            // the files are called. Named by their letter rather than numbered,
            // because a `<select>` cannot show the shapes and the letter is at
            // least the thing on disk.
            options: Array.from({ length: NUM_CROSSHAIRS }, (_, i) => ({
                value: i,
                label: String.fromCharCode('A'.charCodeAt(0) + i),
            })),
            apply: (v) => hud.setCrosshair(Number(v)),
        },
        {
            kind: 'toggle',
            id: 'crosshair-health',
            section: 'Reticle',
            label: 'Colour crosshair by health',
            note: 'cg_crosshairHealth, which Q3 defaults on.',
            initial: true,
            apply: (v) => {
                hud.crosshairHealth = v;
            },
        },
    ];

    return {
        id: 'graphics',
        title: 'Graphics',
        settings,
        note:
            'Shadow resolution, anti-aliasing, ambient-occlusion and reflection settings are ' +
            'properties of the renderer, and are either private to it or reachable only ' +
            'through the getter 3.6.0 put a warning on (GAP-024). Supersampling is missing ' +
            'for a second reason: the one property that reaches it throws on any scale that ' +
            'is not a whole number (BUG-11).',
    };
}
