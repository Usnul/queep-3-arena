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
 * WebGPU engine was a resolution scale and a field of view rather than a quality
 * preset -- and why the field of view was the only row on it that was not about
 * the frame cost at all.
 *
 * **3.6.0 opened it**, by the narrowest door and with a warning on it: a
 * `renderer` getter whose docblock is "Danger zone. Be careful with what you do,
 * with great Renderer comes great responsibility." That is what makes the shadow
 * row and the three feature rows below possible, and it is the same property
 * `main.ts` already uses to put a scene into Brick4 (D-107).
 *
 * What is reachable, and is here:
 *
 *   `dynamic_resolution`   adaptive resolution, its target, and the render scale
 *   `Shadows`              which lights cast, over the renderer's master switch
 *   `renderer`             ambient occlusion, reflections and bloom -- three
 *                          `feature_*` booleans, written straight through
 *
 * **What is not here is not always what is out of reach.** Two rows left this
 * page under their own power. The field of view and the two crosshair rows are
 * on the gameplay page, because a `cg_` cvar with no frame cost and a different
 * right answer per player is not a graphics setting however it was first filed
 * (D-126). Motion blur is gone entirely, switch and strength both, because a
 * Quake player wants the frame they turn onto to be readable and a row nobody
 * should move is worse than no row (D-127); the flag it wrote is the renderer's
 * own `false`, so nothing here has to hold it down.
 *
 * Quality presets are still absent (GAP-024). `GTAO` lives in the private
 * `Renderer.#postprocess`; SSR's trace resolution is a `graph_pass` argument,
 * and bloom intensity and mip count are call arguments too. The renderer picks
 * them. Shadow resolution and atlas size are module-private constants.
 *
 * **Some effect tuning is public.** The renderer owns `MotionBlur`, hands it out
 * through `get motion_blur()`, and the getter's docblock is an instruction --
 * "Configure it via `renderer.motion_blur.*` (currently `strength`); toggle the
 * effect with `feature_motion_blur_enabled`". `dof` has the same shape. So for
 * the effects the engine added most recently the flag and the tuning are
 * deliberately separated and both are public. Meep 3.19.0 also exposes `ssr`,
 * with reprojection and spatial-denoising controls; this page keeps its single
 * reflections toggle. See D-109 for the motion-blur row that demonstrated the
 * pattern and D-127 for why this port does not ship it.
 *
 * This page therefore has the effects and not their presets, which is why those
 * rows are toggles rather than a Low / Medium / High -- that would be three
 * labels over one boolean each, which is a worse control than the boolean.
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

import { SHADOW_MODE_DEFAULT, type ShadowMode } from '../Shadows.ts';
import type { Setting, SettingsPage } from './Settings.ts';
import type { View } from './meep.ts';

/**
 * The renderer's own feature switches, reached through 3.6.0's getter.
 *
 * Three booleans. Since meep 3.19.0, screen-space reflections work with Brick4
 * as well as IBL, so the page does not need to read the indirect-lighting mode.
 *
 * `feature_motion_blur_enabled` is deliberately absent, and its absence is the
 * whole of how motion blur stays off: the field initializer in `Renderer` is
 * `false`, no row writes it, and a flag nothing in the port can name cannot be
 * turned on by a stale key in storage either (D-127).
 *
 * `feature_ssao_enabled` is GTAO, and the name is the engine's history rather
 * than a mistake in it -- `PostProcess.ssao` is constructed `new GTAO(graphics)`
 * and what runs is the horizon search and bent-normal integration in
 * `postprocess/gtao/`, not a hemisphere of depth taps.
 */
export interface RendererFeatures {
    /** GTAO. See above for why the flag is spelled the older way. */
    feature_ssao_enabled: boolean;
    feature_ssr_enabled: boolean;
    feature_bloom_enabled: boolean;
}

/**
 * The parts of `GraphicsEngine3` this page writes.
 *
 * Structural rather than the class itself, so the page can be built and tested
 * against a stand-in. Nothing here is optional in the engine; the narrowing is
 * for the caller's benefit, not the engine's.
 */
export interface GraphicsHost {
    /**
     * Shade's renderer, or null.
     *
     * Null is what the getter's own docblock promises -- "`null` before a
     * successful start and again after stop" -- while the `.d.ts` beside it
     * declares `Renderer` with no null and is wrong. Same declaration `Shadows`
     * writes around, and read on each write rather than held for the same
     * reason: a renderer replaced by a `stop()`/`start()` is the one the next
     * write has to land on.
     */
    readonly renderer: RendererFeatures | null;
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

/** The part of `Shadows` this page writes. See `Shadows.ts` for what it does. */
export interface ShadowHost {
    readonly mode: ShadowMode;
    setMode(raw: unknown): boolean;
}

export interface GraphicsPageHosts {
    readonly graphics: GraphicsHost;
    /** The `stats.js` panel, if one was built -- see `frameRateCounter.ts`. */
    readonly frameRateCounter: View | null;
    readonly shadows: ShadowHost;
}

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
    const { graphics, frameRateCounter, shadows } = hosts;

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

    /**
     * Write one of the renderer's feature flags, if there is a renderer.
     *
     * Through the facade on every call rather than off a held reference, for the
     * reason `GraphicsHost.renderer` gives. The null case is not defensive
     * padding: `applyAll` runs at startup and the tests run in Node, and both
     * are entitled to a page with nothing behind it.
     */
    const feature = (write: (renderer: RendererFeatures) => void): void => {
        const renderer = graphics.renderer;
        if (renderer !== null) write(renderer);
    };

    const settings: Setting[] = [
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
         Ambient occlusion under the shadows, because the two are the same
         question asked at two scales and a player reads them together: the
         shadow row decides whether the room's fixtures throw anything across
         the room, and this one decides whether two surfaces go dark where they
         meet.

         It is also the one of these three the arenas need most. A Q3 map's
         static shading is in its lightmaps at luxel resolution, which is coarse
         and, more to the point, is a property of the *level*: a player, a weapon
         model, an item spinning on its pedestal and a rocket in flight are all
         outside the bake entirely. GTAO is the only thing in this renderer that
         shades where those meet the floor.
        */
        {
            kind: 'toggle',
            id: 'ambient-occlusion',
            section: 'Lighting',
            label: 'Ambient occlusion',
            note: 'The lightmaps shade the level; this shades everything moving through it.',
            initial: true,
            apply: (v) => {
                /*
                 Off is not only "no darkening". The pass also produces the bent
                 normals the indirect lighting is then sampled along, and with it
                 off the renderer falls back to the shading normals -- so this
                 row moves the whole indirect term a little, not just the
                 creases. The engine's own default is on, and so is this.
                */
                feature((renderer) => {
                    renderer.feature_ssao_enabled = v;
                });
            },
        },
        {
            kind: 'toggle',
            id: 'reflections',
            section: 'Lighting',
            label: 'Screen-space reflections',
            note: 'Traced against what is already on screen, so it reflects only what is.',
            // Keep the engine's off default; reflections add a screen-space trace.
            initial: false,
            enabled: () => graphics.renderer !== null,
            apply: (v) => {
                feature((renderer) => {
                    renderer.feature_ssr_enabled = v;
                });
            },
        },
        {
            kind: 'toggle',
            id: 'bloom',
            section: 'Effects',
            label: 'Bloom',
            note: 'Automatic exposure needs the same bright pass, so off saves the composite only.',
            initial: true,
            apply: (v) => {
                feature((renderer) => {
                    renderer.feature_bloom_enabled = v;
                });
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
        /*
         Off, and off is a change from what this shipped with -- the row used to
         start at `frameRateCounter !== null`, which is to say "on wherever there
         is a panel to show", because the panel had been the port's own
         instrumentation before it was a setting.

         It is a HUD element, and the arena is what the player came to look at.
         `cg_drawFPS` is 0 in Q3 too. The counter stays one click away for
         anyone tuning the two rows above it, which is what it is for.
        */
        {
            kind: 'toggle',
            id: 'frame-rate-counter',
            section: 'Performance',
            label: 'Frame-rate counter',
            initial: false,
            enabled: () => frameRateCounter !== null,
            apply: (v) => {
                if (frameRateCounter !== null) frameRateCounter.visible = v;
            },
        },
    ];

    return {
        id: 'graphics',
        title: 'Graphics',
        settings,
        note:
            'Effects can be toggled individually. Disable adaptive resolution to choose a ' +
            'fixed render scale.',
    };
}
