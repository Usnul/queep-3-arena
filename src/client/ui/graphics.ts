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
 * already owns. That is the whole list, and it is short for a reason worth
 * stating in the file rather than only in the report:
 *
 * `GraphicsEngine3` is a deliberately narrow facade. Its own docblock names what
 * it will not hand out -- `renderer` above all, at a cost it counts in callers --
 * so shadow resolution, anti-aliasing, ambient occlusion, screen-space
 * reflections and the indirect-lighting mode are all properties of a `Renderer`
 * this application cannot reach. That is GAP-024, filed when the same wall
 * stopped the lighting half of phase 8, and it is why a graphics menu for a
 * WebGPU engine has a field of view and a resolution scale on it rather than a
 * quality preset.
 *
 * What is reachable, and is here:
 *
 *   `pixelRatio` + `updateSize()`   render scale
 *   `dynamic_resolution`            adaptive resolution, and its target
 *   `Camera.fov`                    field of view -- the port's own component
 *   `Hud`                           the port's own 2D
 *
 * `dynamic_resolution` is the one the engine explicitly invites: "exposed so
 * that it can be turned off or re-targeted -- a measurement that wants a fixed
 * resolution, **or a settings screen that offers the choice**".
 */

import { CROSSHAIR_DEFAULT, type Hud } from '../Hud.ts';
import { NUM_CROSSHAIRS } from '../crosshair.ts';
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
    readonly pixelRatio: { set(x: number): unknown; getValue(): number };
    readonly dynamic_resolution: {
        enabled: boolean;
        target_frame_rate: number;
        reset(): void;
    };
    updateSize(): void;
}

export interface CameraHost {
    readonly fov: { set(x: number): unknown; getValue(): number };
}

export interface GraphicsPageHosts {
    readonly graphics: GraphicsHost;
    readonly camera: CameraHost;
    readonly hud: Hud;
    /** The `stats.js` panel, if one was built -- see `frameRateCounter.ts`. */
    readonly frameRateCounter: View | null;
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

/** Render scale, as a multiplier on the viewport's CSS pixels. */
const RENDER_SCALE_MIN = 0.5;
const RENDER_SCALE_MAX = 2;

/**
 * Build the graphics page.
 *
 * The settings are values, and the page is a value: nothing here subclasses
 * anything, so the map picker and the match setup this menu is going to grow
 * are another function of this shape and no change to the shell.
 */
export function graphicsPage(hosts: GraphicsPageHosts): SettingsPage {
    const { graphics, camera, hud, frameRateCounter } = hosts;

    let adaptive = graphics.dynamic_resolution.enabled;

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
        {
            kind: 'slider',
            id: 'render-scale',
            section: 'Display',
            label: 'Render scale',
            note: 'Below 100% upscales; above supersamples.',
            initial: 1,
            min: RENDER_SCALE_MIN,
            max: RENDER_SCALE_MAX,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            apply: (v) => {
                graphics.pixelRatio.set(v);

                /*
                 `pixelRatio` is a `Vector1` and has an `onChanged` signal, and
                 nothing in the engine is subscribed to it: `updateSize` is
                 bound to `viewport.size.onChanged` only. So writing the ratio
                 resizes nothing until the window happens to move. Calling it
                 here is the whole of the workaround; GAP-027.
                */
                graphics.updateSize();

                /*
                 The adaptive controller's estimator is a pair of EMAs over
                 frame time, and its own documentation says to `reset()` after
                 "anything that would otherwise pollute the estimators with
                 pre-event samples". Changing the render scale is exactly that.
                */
                graphics.dynamic_resolution.reset();
            },
        },
        {
            kind: 'toggle',
            id: 'adaptive-resolution',
            section: 'Performance',
            label: 'Adaptive resolution',
            note: 'Drops internal resolution when frames run long.',
            initial: adaptive,
            apply: (v) => {
                adaptive = v;
                graphics.dynamic_resolution.enabled = v;
                if (v) graphics.dynamic_resolution.reset();
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
            // Read through the closure rather than off the engine, so the row
            // greys out on the same value the toggle wrote rather than on
            // whatever the controller has done with it since.
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
            section: 'Reticle and readouts',
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
            section: 'Reticle and readouts',
            label: 'Colour crosshair by health',
            note: 'cg_crosshairHealth, which Q3 defaults on.',
            initial: true,
            apply: (v) => {
                hud.crosshairHealth = v;
            },
        },
        {
            kind: 'toggle',
            id: 'speedometer',
            section: 'Reticle and readouts',
            label: 'Speedometer',
            note: 'Units per second, and the peak it decays from.',
            initial: true,
            apply: (v) => hud.setSpeedometerVisible(v),
        },
    ];

    return {
        id: 'graphics',
        title: 'Graphics',
        settings,
        note:
            'Shadow, anti-aliasing, ambient-occlusion and reflection settings are properties ' +
            'of the renderer, which meep does not expose to an application (GAP-024).',
    };
}
