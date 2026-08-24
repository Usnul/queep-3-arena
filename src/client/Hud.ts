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
 * Built on meep's `View` hierarchy rather than raw DOM, per the brief. The full
 * Q3 HUD -- health, armour, ammo, weapon list -- lands in phase 4 when there is
 * game state behind it.
 */

import View from '@woosh/meep-engine/src/view/View.js';
import EmptyView from '@woosh/meep-engine/src/view/elements/EmptyView.js';
import LabelView from '@woosh/meep-engine/src/view/common/LabelView.js';
import ObservedString from '@woosh/meep-engine/src/core/model/ObservedString.js';

/**
 * Corrective type for `LabelView`'s options.
 *
 * `LabelView`'s implementation is `constructor(model, { classList = [], ...,
 * size, css } = {})` -- the whole bag defaults to `{}`, so every field is
 * optional at runtime. Its JSDoc marks four of the six with `[brackets]` and
 * forgets `size` and `css`, so the generated `.d.ts` declares those two
 * **required** and rejects `new LabelView(model, { classList })` at compile
 * time even though it is exactly what the code supports.
 *
 * Per the brief, this is corrected with a narrow local type rather than papered
 * over with `any`: the constructor keeps its real signature everywhere else, and
 * the instance is recorded in GAP-001.
 */
type LabelViewOptions = {
    classList?: string[];
    tag?: string;
    transform?: unknown;
    format?: unknown;
    size?: unknown;
    css?: unknown;
};

type LabelViewCtor = new (model: unknown, options?: LabelViewOptions) => View;

const Label = LabelView as unknown as LabelViewCtor;

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

export class Hud {
    readonly root: View;

    private readonly speedModel = new ObservedString('');
    private readonly peakModel = new ObservedString('');
    private readonly stateModel = new ObservedString('');
    private readonly statusModel = new ObservedString('');
    private readonly pickupModel = new ObservedString('');

    private statusRoot: View | null = null;

    private peak = 0;
    private lastUpdate = 0;

    constructor() {
        const styles = document.createElement('style');
        styles.textContent = HUD_CSS;
        document.head.appendChild(styles);

        this.root = EmptyView.group(
            [
                new Label(this.pickupModel, { classList: ['queep-hud__pickup'] }),
                new Label(this.speedModel, { classList: ['queep-hud__speed'] }),
                new Label(this.peakModel, { classList: ['queep-hud__peak'] }),
                new Label(this.statusModel, { classList: ['queep-hud__status'] }),
                new Label(this.stateModel, { classList: ['queep-hud__state'] }),
            ],
            { classList: ['queep-hud'], tag: 'div', css: {} }
        );
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

        if (state.mode === 'click-to-play') {
            this.stateModel.set(
                'click to play  ·  WASD move  ·  space jump  ·  ctrl crouch  ·  ' +
                'mouse1 fire  ·  1-9 or wheel weapon'
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
}

/*
 Injected rather than imported as a stylesheet: meep declares CSS and SCSS files
 as having side effects, so Vite would own the file's lifecycle -- more machinery
 than three rules deserve. The HUD is replaced wholesale in phase 4.
*/
const HUD_CSS = `
.queep-hud {
    position: absolute;
    left: 0; right: 0; bottom: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    pointer-events: none;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    color: #f0f0f0;
}
.queep-hud__speed { font-size: 44px; font-weight: 600; line-height: 1; }
.queep-hud__peak  { font-size: 13px; opacity: 0.75; }
.queep-hud__state { font-size: 12px; opacity: 0.55; margin-top: 6px; }
.queep-hud__status { font-size: 20px; font-weight: 600; letter-spacing: 0.04em; margin-top: 8px; }
.queep-hud__pickup { font-size: 16px; opacity: 0.85; margin-bottom: 10px; min-height: 19px; }
`;
