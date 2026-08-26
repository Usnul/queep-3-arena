/*
 * Hud.ts -- speed and state readout, built on meep's UI.
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
 * A speedometer, not decoration. Strafe jumping is invisible without one: the
 * player's base speed is 320 units/s and a good jump chain reaches 500+, and
 * "does the movement port work" is a question you answer by watching that number
 * climb. Q3's own HUD has no speed readout; every movement-focused mod adds one.
 *
 * The crosshair *is* Q3's, artwork and rules alike: `gfx/2d/crosshair[a-j]` at
 * `cg_crosshairSize`, tinted by `CG_GetColorForHealth` because
 * `cg_crosshairHealth` defaults on, and pulsed for `ITEM_BLOB_TIME` after a
 * pickup. It is a DOM element rather than a drawn quad for the same reason the
 * rest of this file is -- the brief puts the UI on meep's `View` hierarchy, and
 * a screen-space sprite in a deferred renderer is a pass, not a decal.
 *
 * Built on meep's `View` hierarchy rather than raw DOM, per the brief.
 */

import ObservedString from '@woosh/meep-engine/src/core/model/ObservedString.js';

import { EmptyView, LabelView, type View, type ViewWithElement } from './ui/meep.ts';
import {
    crosshairColor,
    crosshairScale,
    crosshairTexture,
    NUM_CROSSHAIRS,
} from './crosshair.ts';

export interface HudState {
    readonly mode: 'play' | 'fly' | 'click-to-play';
    /** Horizontal speed, Q3 units per second. */
    readonly speed: number;
    readonly onGround: boolean;
    readonly map: string;
    /** Weapon id, or empty in fly mode. */
    readonly weapon: string;
    readonly damage: number;
    readonly kills: number;
    readonly deaths: number;
    /** Which collision backend movement is running on. */
    readonly backend: string;
    readonly health: number;
    readonly armor: number;
    /** Rounds for the held weapon; negative means Q3's "infinite". */
    readonly ammo: number;
    /** Most recent pickup name, and when it happened, for the fade. */
    readonly pickup: string;
    readonly pickupAgeSeconds: number;
}

/** Q3's own thresholds: the health number turns red below 25. */
const LOW_HEALTH = 25;

/** How long a pickup name stays on screen. `cg_drawStatus`'s is 3 seconds. */
const PICKUP_SECONDS = 3;

/** Peak speed decays this fast once the player slows, in units per second. */
const PEAK_DECAY = 40;

/**
 * `cg_crosshairSize`, as a fraction of the viewport height.
 *
 * Q3's default is 24 in the 640x480 virtual screen `CG_AdjustFrom640` maps from,
 * so 24/480. That function scales width by `width/640` and height by
 * `height/480` independently, which stretches the crosshair on anything that is
 * not 4:3; the height scale is applied to both axes here instead, so the
 * crosshair is Q3's size at 4:3 and stays round everywhere else.
 */
const CROSSHAIR_FRACTION = 24 / 480;

/** `cg_drawCrosshair`, whose default is 4 in both Q3 and OpenArena. */
export const CROSSHAIR_DEFAULT = 4;

export interface HudOptions {
    /** `cg_drawCrosshair`: which of `gfx/2d/crosshair[a-j]` to draw. */
    readonly crosshair?: number;
}

export class Hud {
    readonly root: View;

    private readonly speedModel = new ObservedString('');
    private readonly peakModel = new ObservedString('');
    private readonly stateModel = new ObservedString('');
    private readonly statusModel = new ObservedString('');
    private readonly pickupModel = new ObservedString('');

    /** The crosshair element, written to directly every frame. */
    private readonly crosshair: ViewWithElement<HTMLElement>;

    /** The speed pair, which the menu can turn off. */
    private readonly speedViews: View[];

    /** `cg_drawCrosshair`, as last set. Kept so a redundant swap is free. */
    private crosshairIndex: number;

    /** `cg_crosshairHealth`, which Q3 defaults on. */
    crosshairHealth = true;

    private peak = 0;
    private lastUpdate = 0;

    constructor(options: HudOptions = {}) {
        const crosshairView = new EmptyView({
            classList: ['queep-hud__crosshair'],
            tag: 'div',
        });

        this.crosshair = crosshairView;
        this.crosshairIndex = -1;
        this.setCrosshair(options.crosshair ?? CROSSHAIR_DEFAULT);

        const speed = new LabelView(this.speedModel, { classList: ['queep-hud__speed'] });
        const peak = new LabelView(this.peakModel, { classList: ['queep-hud__peak'] });

        this.speedViews = [speed, peak];

        const readouts = EmptyView.group(
            [
                new LabelView(this.pickupModel, { classList: ['queep-hud__pickup'] }),
                speed,
                peak,
                new LabelView(this.statusModel, { classList: ['queep-hud__status'] }),
                new LabelView(this.stateModel, { classList: ['queep-hud__state'] }),
            ],
            { classList: ['queep-hud'], tag: 'div' }
        );

        /*
         One root, because `link` adds one child to the stack. The crosshair
         cannot live inside `.queep-hud`: that element is anchored to the bottom
         of the screen and is only as tall as its text, so a child centred in it
         would be centred on the speedometer.
        */
        this.root = EmptyView.group([crosshairView, readouts], {
            classList: ['queep-hud-root'],
            tag: 'div',
        });
    }

    /**
     * `cg_drawCrosshair`: pick one of Q3's ten.
     *
     * The image is a *mask*, not a background: Q3's crosshairs are white with an
     * alpha channel and `cg_crosshairHealth` tints them, so the colour has to
     * come from somewhere the tint can reach. Masking a solid fill puts the
     * colour in `background-color`, where a per-frame write costs nothing and no
     * second copy of the image is needed.
     */
    setCrosshair(index: number): void {
        const wrapped = Math.max(0, Math.trunc(index)) % NUM_CROSSHAIRS;
        if (wrapped === this.crosshairIndex) return;

        this.crosshairIndex = wrapped;

        const mask = `url("${crosshairTexture(wrapped)}") center / contain no-repeat`;
        this.crosshair.css({ mask, webkitMask: mask });
    }

    /**
     * The speedometer, which is the port's own readout rather than Q3's.
     *
     * Worth being able to turn off for exactly the reason it is worth having:
     * it is a movement diagnostic, and a screenshot of the arena is not a
     * movement diagnostic.
     */
    setSpeedometerVisible(visible: boolean): void {
        for (const view of this.speedViews) view.visible = visible;
    }

    /** Attach to the engine's view stack. */
    link(viewStack: { addChild(v: View): void }): void {
        viewStack.addChild(this.root);
    }

    update(state: HudState): void {
        const now = performance.now();
        const dt = this.lastUpdate === 0 ? 0 : (now - this.lastUpdate) / 1000;
        this.lastUpdate = now;

        if (state.speed > this.peak) {
            this.peak = state.speed;
        } else {
            this.peak = Math.max(state.speed, this.peak - PEAK_DECAY * dt);
        }

        this.speedModel.set(`${Math.round(state.speed)}`);
        this.peakModel.set(`peak ${Math.round(this.peak)} ups`);

        /*
         Q3's status bar is health, armour, ammo, in that order and nothing
         else. Resisting the urge to add more is part of the point: the reason
         a Q3 HUD reads at a glance mid-fight is that there are three numbers.
        */
        if (state.mode !== 'fly') {
            const ammo = state.ammo < 0 ? '--' : `${state.ammo}`;
            const low = state.health <= LOW_HEALTH ? ' !' : '';
            this.statusModel.set(
                `${state.health} health${low}   ${state.armor} armor   ${ammo} ammo`
            );
        } else {
            this.statusModel.set('');
        }

        if (state.pickup !== '' && state.pickupAgeSeconds < PICKUP_SECONDS) {
            this.pickupModel.set(state.pickup);
        } else {
            this.pickupModel.set('');
        }

        this.updateCrosshair(state);

        if (state.mode === 'click-to-play') {
            this.stateModel.set(
                'click to play  ·  WASD move  ·  space jump  ·  ctrl crouch  ·  ' +
                'mouse1 fire  ·  1-9 or wheel weapon  ·  esc menu'
            );
        } else if (state.mode === 'fly') {
            this.stateModel.set(`${state.map}  ·  noclip`);
        } else {
            const weapon = state.weapon.replace(/^WP_/, '').toLowerCase().replace(/_/g, ' ');
            this.stateModel.set(
                `${state.map}  ·  ${weapon}  ·  ${state.kills}/${state.deaths}  ·  ` +
                `${state.damage} damage  ·  ${state.onGround ? 'ground' : 'air'}  ·  ` +
                `${state.backend}`
            );
        }
    }

    /**
     * `CG_DrawCrosshair`, which is three writes and a visibility test.
     *
     * Hidden only in fly mode -- Q3 hides it for a spectator and in third
     * person, and the noclip camera is the port's version of both. It stays up
     * while the pointer is unlocked, because the thing it is aiming is still
     * pointed wherever the camera is.
     */
    private updateCrosshair(state: HudState): void {
        const style = this.crosshair.el.style;

        if (state.mode === 'fly') {
            style.display = 'none';
            return;
        }

        style.display = 'block';

        const size = CROSSHAIR_FRACTION * 100 * crosshairScale(state.pickupAgeSeconds);
        style.width = `${size}vh`;
        style.height = `${size}vh`;

        // `cg_crosshairHealth 0` is a plain white reticle. Q3 draws it in
        // `cg_crosshairColor`'s colour then; the port has no such setting, and
        // white is what that cvar defaults to.
        const [r, g, b] = this.crosshairHealth
            ? crosshairColor(state.health, state.armor)
            : [1, 1, 1];

        style.backgroundColor =
            `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
    }
}
