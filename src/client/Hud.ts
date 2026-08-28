/*
 * Hud.ts -- the status readout, built on meep's UI.
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
 * Q3's status bar is health, armour and ammo, and this is those three -- as
 * meep's `SegmentedResourceBarView` rather than as numbers alone, because a bar
 * with notches answers "how much is left" in the glance a fight allows and three
 * digits do not.
 *
 * **The two ends of the screen wrap toward the player.** Health and armour sit
 * together in the bottom-left corner, ammo and the weapon's own icon in the
 * bottom-right, and each cluster is turned about its inner edge under a shared
 * perspective so the outer edge comes forward -- the inside of a visor rather
 * than a sticker on the glass. It is one `perspective` and two `rotateY`s
 * sharing a vanishing point, which is the whole of why it reads as one curved
 * surface instead of two tilted panels; `_mixins.scss` holds it.
 *
 * **There is no speedometer.** There was, and it was a movement diagnostic from
 * the phase where the question was whether strafe jumping worked. It is not part
 * of the game and it is not on the screen any more.
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
import { Gauge } from './ui/Gauge.ts';
import {
    crosshairColor,
    crosshairScale,
    crosshairTexture,
    NUM_CROSSHAIRS,
} from './crosshair.ts';
import {
    ammoFull,
    ammoIsInfinite,
    ammoIsLow,
    LOW_HEALTH,
    POOL_MAX,
    weaponIcon,
    weaponLabel,
} from './statusBar.ts';

export interface HudState {
    readonly mode: 'play' | 'fly' | 'click-to-play';
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

/** How long a pickup name stays on screen. `cg_drawStatus`'s is 3 seconds. */
const PICKUP_SECONDS = 3;

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

    private readonly stateModel = new ObservedString('');
    private readonly pickupModel = new ObservedString('');

    /** The crosshair element, written to directly every frame. */
    private readonly crosshair: ViewWithElement<HTMLElement>;

    private readonly health = new Gauge({ label: 'health', modifier: 'health', max: POOL_MAX });
    private readonly armor = new Gauge({ label: 'armor', modifier: 'armor', max: POOL_MAX });
    private readonly ammo = new Gauge({ label: 'ammo', modifier: 'ammo', max: 1 });

    /** The weapon's icon, beside the ammo it belongs to. */
    private readonly weapon: ViewWithElement<HTMLElement>;

    /** The two wrapped corners, hidden together when there is no player. */
    private readonly clusters: View[];

    /** `cg_drawCrosshair`, as last set. Kept so a redundant swap is free. */
    private crosshairIndex: number;

    /** Last weapon drawn, so the icon is written on a change and not per frame. */
    private weaponId = '';

    /** `cg_crosshairHealth`, which Q3 defaults on. */
    crosshairHealth = true;

    constructor(options: HudOptions = {}) {
        const crosshairView = new EmptyView({
            classList: ['queep-hud__crosshair'],
            tag: 'div',
        });

        this.crosshair = crosshairView;
        this.crosshairIndex = -1;
        this.setCrosshair(options.crosshair ?? CROSSHAIR_DEFAULT);

        /*
         `role="img"` with a name that is written on every weapon change: the
         icon is a background image, and a background image is the one kind of
         picture that has no text of its own for a screen reader to read.
        */
        this.weapon = new EmptyView({
            classList: ['queep-hud__weapon'],
            tag: 'div',
            attr: { role: 'img', 'aria-label': '' },
        });

        const left = EmptyView.group([this.health.root, this.armor.root], {
            classList: ['queep-hud__cluster', 'queep-hud__cluster--left'],
            tag: 'div',
        });

        const right = EmptyView.group([this.ammo.root, this.weapon], {
            classList: ['queep-hud__cluster', 'queep-hud__cluster--right'],
            tag: 'div',
        });

        this.clusters = [left, right];

        /*
         The middle column faces the player square on, and that is what makes
         the two beside it read as wrapped rather than as crooked: a curve needs
         something flat to be curved away from.
        */
        const middle = EmptyView.group(
            [
                new LabelView(this.pickupModel, { classList: ['queep-hud__pickup'] }),
                new LabelView(this.stateModel, { classList: ['queep-hud__state'] }),
            ],
            { classList: ['queep-hud__middle'], tag: 'div' }
        );

        const readouts = EmptyView.group([left, middle, right], {
            classList: ['queep-hud'],
            tag: 'div',
        });

        /*
         One root, because `link` adds one child to the stack. The crosshair
         cannot live inside `.queep-hud`: that element is anchored to the bottom
         of the screen and is only as tall as its readouts, so a child centred in
         it would be centred on the status bar.
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

    /** Attach to the engine's view stack. */
    link(viewStack: { addChild(v: View): void }): void {
        viewStack.addChild(this.root);
    }

    update(state: HudState): void {
        /*
         Q3's status bar is health, armour and ammo, in that order and nothing
         else. Resisting the urge to add more is part of the point: the reason a
         Q3 HUD reads at a glance mid-fight is that there are three numbers.
        */
        const playing = state.mode !== 'fly';

        for (const cluster of this.clusters) cluster.visible = playing;

        if (playing) {
            this.health.set(state.health, state.health <= LOW_HEALTH);
            this.armor.set(state.armor, false);
            this.updateAmmo(state);
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
                'shift walk  ·  mouse1 fire  ·  1-9 or wheel weapon  ·  esc menu'
            );
        } else if (state.mode === 'fly') {
            this.stateModel.set(`${state.map}  ·  noclip`);
        } else {
            this.stateModel.set(
                `${state.map}  ·  ${state.kills}/${state.deaths}  ·  ` +
                `${state.damage} damage  ·  ${state.onGround ? 'ground' : 'air'}  ·  ` +
                `${state.backend}`
            );
        }
    }

    /**
     * The right-hand corner: the icon, and the bar the weapon scales.
     *
     * Two things move with the weapon and not with the count. The icon is one;
     * the other is where the bar is full, which is per weapon because a full
     * load is (`ammoFull`). Both are written on a change rather than per frame,
     * because setting `background-image` to the URL it already holds is a style
     * recalculation for nothing sixty times a second.
     *
     * The gauntlet has no ammunition rather than none left, so its bar is not
     * drawn at all -- `CG_DrawStatusBar` guards the whole readout with
     * `ammo > -1` for the same reason. The icon stays: what is in your hands is
     * still worth showing.
     */
    private updateAmmo(state: HudState): void {
        if (state.weapon !== this.weaponId) {
            this.weaponId = state.weapon;

            const icon = weaponIcon(state.weapon);

            this.weapon.visible = icon !== null;
            this.weapon.css({ backgroundImage: icon === null ? 'none' : `url("${icon}")` });
            this.weapon.attr({ 'aria-label': weaponLabel(state.weapon) });

            this.ammo.setMax(ammoFull(state.weapon));
        }

        const infinite = ammoIsInfinite(state.ammo);

        this.ammo.visible = !infinite;

        if (!infinite) this.ammo.set(state.ammo, ammoIsLow(state.weapon, state.ammo));
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
