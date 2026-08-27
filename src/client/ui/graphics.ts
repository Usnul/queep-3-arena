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
 * with great Renderer comes great responsibility." That is what makes the shadow
 * row and the four feature rows below possible, and it is the same property
 * `main.ts` already uses to put a scene into Brick4 (D-107).
 *
 * What is reachable, and is here:
 *
 *   `dynamic_resolution`   adaptive resolution, its target, and the render scale
 *   `Camera.fov`           field of view -- the port's own component
 *   `Shadows`              which lights cast, over the renderer's master switch
 *   `renderer`             ambient occlusion, reflections, bloom and motion blur
 *                          -- four `feature_*` booleans, written straight through
 *   `renderer.motion_blur` the blur strength, and the only quality knob on this
 *                          page that is not a resolution
 *   `Hud`                  the port's own 2D
 *
 * **What is out of reach is the quality behind three of those four switches**,
 * and that is what keeps GAP-024 open rather than closed. It is out of reach
 * twice over. The `GTAO` and `SSR` objects live in `Renderer.#postprocess`, a
 * private field with no getter, so they cannot be reached with the renderer
 * already in hand. And their quality is a call argument rather than a property
 * in any case: `SSR.graph_pass` takes a `mip`, "higher mip = lower resolution
 * trace", and `graph_postprocess_bloom` takes an `intensity` and a `mips`, and
 * `Renderer` calls all three of them without. The shadow resolution is a third
 * shape of the same thing: `DEFAULT_SHADOWMAP_LOCAL_RESOLUTION` is a
 * module-private constant, as is the atlas size beside it.
 *
 * **Motion blur is the exception, and it is the interesting one.** `MotionBlur`
 * is a newer subsystem than either, and it was built the other way round: the
 * renderer owns one, hands it out through `get motion_blur()`, and the getter's
 * docblock is an instruction -- "Configure it via `renderer.motion_blur.*`
 * (currently `strength`); toggle the effect with `feature_motion_blur_enabled`".
 * `dof` has the same shape. So the flag and the tuning are deliberately
 * separated, both are public, and a settings screen is clearly among the callers
 * that was meant. That is the shape GAP-024 asks for, already in the package,
 * for the effects the engine added most recently.
 *
 * The rest of this page therefore has the effects and not their presets, which
 * is why those rows are toggles rather than a Low / Medium / High -- that would
 * be three labels over one boolean each, which is a worse control than the
 * boolean.
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

import { ShadeIndirectLightingMode } from '@woosh/meep-engine/src/shade/renderer/ShadeIndirectLightingMode.js';

import { CROSSHAIR_DEFAULT, type Hud } from '../Hud.ts';
import { NUM_CROSSHAIRS } from '../crosshair.ts';
import { SHADOW_MODE_DEFAULT, type ShadowMode } from '../Shadows.ts';
import type { Setting, SettingsPage } from './Settings.ts';
import type { View } from './meep.ts';

/**
 * The renderer's own feature switches, reached through 3.6.0's getter.
 *
 * Three booleans and one number, and the number is read rather than written: the
 * indirect-lighting mode is `main.ts`'s to set, once, from whether the map has a
 * bake (D-107). It is declared here because the reflections row has to ask.
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
    feature_motion_blur_enabled: boolean;
    /**
     * The one thing behind any of these switches that can be configured.
     *
     * `readonly` because the renderer builds the `MotionBlur` in `init` and
     * hands it out through a getter; what is settable is what is on it, which is
     * `strength` and nothing else. See `MOTION_BLUR_STRENGTH_DEFAULT`.
     */
    readonly motion_blur: { strength: number };
    /** Read, never written. See `reflectionsReachable`. */
    readonly indirect_lighting_mode: number;
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
 * Velocity scale for the motion-blur reconstruction, and the range it stays
 * honest over. Both are the engine's own numbers rather than taste.
 *
 * `MotionBlur.strength` is documented as "`1.0` is physical (matches the real
 * per-frame pixel displacement)", which at the frame rates a shooter runs at is
 * "deliberately subtle -- each frame only integrates a few ms of motion", and
 * `2.0`-`3.0` is "a longer shutter", cinematic 180 degrees on 24 fps source.
 *
 * The ceiling is 3 because that is where the engine stops vouching for it:
 * `strength` scales velocities inside the reconstruction pass and does *not*
 * rescale the TileMax/NeighborMax pyramid underneath, so past about 3 "samples
 * beyond the dilation reach can pick up unrelated velocities at silhouettes".
 * A slider whose top third smears the wrong pixels onto a moving player is not a
 * quality setting. The floor is 0.5, half of physical, which is as close to
 * "barely there" as the effect gets before the reconstruction's own
 * half-velocity cutoff turns it off a pixel at a time.
 */
export const MOTION_BLUR_STRENGTH_DEFAULT = 1;
const MOTION_BLUR_STRENGTH_MIN = 0.5;
const MOTION_BLUR_STRENGTH_MAX = 3;

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

    /*
     Mirrored for the same reason and one more: the strength row greys out on
     this, and reading it back off `graphics.renderer` would grey the row out
     whenever there is no renderer -- which is startup, and is a page that opens
     with a disabled control under an enabled switch.
    */
    let motionBlur = false;

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

    /**
     * Whether a screen-space reflection would be drawn if one were asked for.
     *
     * Which is: not in Brick4. `Renderer` runs the SSR pass under
     * `feature_ssr_enabled && mode !== Brick4`, with a comment calling the
     * exclusion "a known limitation" -- Brick4 has its own specular, out of the
     * volumetric lightmap, and SSR would be replacing it rather than adding to
     * it. This port is in Brick4 on every map that has a bake (D-107), so that
     * is the common case and not the corner.
     *
     * The flag is worse than inert there, which is why the row below refuses to
     * write it rather than merely greying out. `use_fused_indirect` is
     * `fused_indirect && mode === Brick4 && !feature_ssr_enabled`, so setting it
     * costs the fused Brick4 path -- an extra pair of rgba16float targets and a
     * separate resolve, for the reflections it does not then draw.
     */
    const reflectionsReachable = (): boolean => {
        const renderer = graphics.renderer;

        return (
            renderer !== null &&
            renderer.indirect_lighting_mode !== ShadeIndirectLightingMode.Brick4
        );
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
            /*
             Off, which is the engine's default and is also the only defensible
             one here: the port is in Brick4 on any map with a bake, and the row
             cannot be written there at all. Defaulting it on would mean a
             setting that reads as on and is refused on most of the maps.
            */
            initial: false,
            enabled: reflectionsReachable,
            apply: (v) => {
                feature((renderer) => {
                    // Never true in Brick4 -- see `reflectionsReachable` for what
                    // that would cost. `enabled` greys the row out and this is
                    // what makes the refusal real: a value out of storage, or a
                    // `?gi=ibl` session's `true` arriving on a baked map, both
                    // reach `apply` without going past the control.
                    renderer.feature_ssr_enabled = v && reflectionsReachable();
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
         Off, and the only row on this page whose default is an argument about
         the *game* rather than about what it costs.

         Q3 is a twitch shooter played by people who come round a corner at
         800 units a second and expect the room to be legible on the frame it
         appears in. Reconstruction blur is very good at making a fast turn look
         like a camera and slightly worse at making it readable, and "turn off
         motion blur" is the first line of every competitive config for every
         shooter since. So it is here, because someone will want it and it is one
         flag away, and it is off, because this is Quake.

         The engine's default is false as well, so nothing about the shipped
         picture rests on that argument -- but the argument is why this row does
         not follow the shadow row's "default to the good-looking one" (D-108).
        */
        {
            kind: 'toggle',
            id: 'motion-blur',
            section: 'Effects',
            label: 'Motion blur',
            note: 'Jimenez reconstruction, over the velocity buffer TAA already fills.',
            initial: motionBlur,
            apply: (v) => {
                motionBlur = v;
                feature((renderer) => {
                    renderer.feature_motion_blur_enabled = v;
                });
            },
        },
        /*
         And a slider, which is the thing this page has not had: a quality
         setting behind an effect rather than the effect's on/off.

         It exists because `MotionBlur` is a *newer* subsystem than GTAO and SSR
         and was built the other way round -- the renderer keeps one and hands it
         out, `get motion_blur()`, its docblock reading "Configure it via
         `renderer.motion_blur.*`". `dof` has the same shape. GTAO and SSR live
         in `#postprocess`, which has no getter at all, and their tuning is
         compile-time constants and call arguments the renderer does not forward.
         So the door GAP-024 asks for is one the engine is already holding open
         for the effects it added most recently, which is the most hopeful thing
         in that entry.
        */
        {
            kind: 'slider',
            id: 'motion-blur-strength',
            section: 'Effects',
            label: 'Blur strength',
            note: '1.0 is the real per-frame movement; above that is a longer shutter.',
            initial: MOTION_BLUR_STRENGTH_DEFAULT,
            min: MOTION_BLUR_STRENGTH_MIN,
            max: MOTION_BLUR_STRENGTH_MAX,
            step: 0.1,
            format: (v) => `${v.toFixed(1)}x`,
            enabled: () => motionBlur,
            apply: (v) => {
                /*
                 Written whether or not the effect is on, unlike the render scale
                 one section down. Nothing else writes this number -- there is no
                 controller to take it back -- so a greyed-out row here is simply
                 the one nothing is currently reading, and the value is already
                 right on the frame the toggle above it moves.
                */
                feature((renderer) => {
                    renderer.motion_blur.strength = v;
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
            'Blur strength aside, the effects above are switches and not presets. Their ' +
            'quality -- shadow resolution, bloom strength, the resolution the reflections are ' +
            'traced at -- is either private to the renderer or an argument it hardcodes, ' +
            'rather than merely behind the getter 3.6.0 put a warning on (GAP-024). ' +
            'Anti-aliasing is missing for the same reason, and supersampling for a different ' +
            'one: the one property that reaches it throws on any scale that is not a whole ' +
            'number (BUG-11).',
    };
}
