/*
 * gameplay.ts -- the gameplay page: what the player sees the game through.
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
 * Everything the menu could set used to be on the graphics page, because the
 * graphics page was the only page (D-097 built the shell for more and the port
 * had not needed one yet). Three of those rows were never graphics settings, and
 * putting them here is not tidying -- it is the difference between a menu
 * organised by *what a row costs* and one organised by *what a player wants to
 * change*, which is the only organisation a player can navigate.
 *
 * The test is Q3's own, and it is a good one. `cg_fov`, `cg_drawCrosshair` and
 * `cg_crosshairHealth` are `cg_` cvars -- client *game* -- and id put the
 * crosshair rows in the menu under "Game Options", one screen away from the
 * "System" screen that held the renderer. None of the three has a frame cost
 * worth measuring: a field of view is a projection matrix, and a crosshair is
 * one textured quad whichever of the ten it is. What they have instead is a
 * right answer per player and no right answer at all, which is what a gameplay
 * setting is.
 *
 * Field of view leads, because it is the one a player changes first and the one
 * they change with the arena in front of them -- the menu deliberately leaves
 * the game running behind it (see `Menu.ts`) and this is the row that pays for
 * that decision.
 */

import { CROSSHAIR_DEFAULT, type Hud } from '../Hud.ts';
import { NUM_CROSSHAIRS } from '../crosshair.ts';
import type { Setting, SettingsPage } from './Settings.ts';

/**
 * The part of the camera this page writes.
 *
 * Structural rather than meep's `Camera`, so the page can be built and tested
 * without a graphics engine. `main.ts` hands over the `Camera` component itself
 * and not `graphics.camera.camera`: unlike the view weapon (D-081), this writes
 * a value that `CameraSystem3` copies forward rather than reads a pose it has
 * already copied.
 */
export interface CameraHost {
    readonly fov: { set(x: number): unknown; getValue(): number };
}

export interface GameplayPageHosts {
    readonly camera: CameraHost;
    readonly hud: Hud;
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
 * Build the gameplay page.
 *
 * A value, like every page (D-097): the map picker and the match setup this
 * menu is going to grow are another function of this shape and no change to the
 * shell.
 */
export function gameplayPage(hosts: GameplayPageHosts): SettingsPage {
    const { camera, hud } = hosts;

    const settings: Setting[] = [
        {
            kind: 'slider',
            id: 'fov',
            section: 'View',
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
            kind: 'choice',
            id: 'crosshair',
            section: 'Reticle',
            label: 'Crosshair',
            note: 'cg_drawCrosshair. Ten shapes, and no two players want the same one.',
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
        id: 'gameplay',
        title: 'Gameplay',
        settings,
    };
}
