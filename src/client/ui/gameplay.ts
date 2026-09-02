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
 * Bot difficulty leads, and field of view is second. Field of view held the top
 * of this page when it was the row a player changed first, and it lost the slot
 * the day there was a row that decides whether they can play the match at all
 * (D-162). Both are rows a player changes *with the arena in front of them* --
 * the menu deliberately leaves the game running behind it, see `Menu.ts` -- and
 * difficulty is the one where that matters most, because the only way to know
 * whether "Hurt Me Plenty" is the right answer is to watch a bot at it.
 */

import { CROSSHAIR_DEFAULT, type Hud } from '../Hud.ts';
import { NUM_CROSSHAIRS } from '../crosshair.ts';
import { DEFAULT_DIFFICULTY, DIFFICULTIES, difficulty } from '../../game/Difficulty.ts';
import type { DifficultyId } from '../../game/Difficulty.ts';
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

/**
 * Where the difficulty goes when the row is written.
 *
 * A sink rather than the `BotRuntime` itself, and the indirection is not
 * decoration: the menu is built before the map is loaded, so at the moment this
 * page exists there is no roster to write to. `main.ts` holds the chosen level
 * and hands it to `buildRoster` when there finally is one, and forwards later
 * changes to the running match. It also keeps this page buildable in Node,
 * which is what `settings.test.ts` needs.
 */
export interface DifficultyHost {
    setDifficulty(id: DifficultyId): void;
}

export interface GameplayPageHosts {
    readonly camera: CameraHost;
    readonly hud: Hud;
    readonly bots: DifficultyHost;
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
    const { camera, hud, bots } = hosts;

    const settings: Setting[] = [
        {
            kind: 'choice',
            id: 'bot-difficulty',
            section: 'Opponents',
            /*
             First on the page, above field of view, and that is a claim about
             what this row is worth rather than an accident of the order it was
             written in. Every other setting here changes how the game looks to
             the player; this one changes whether they can play it. The port
             shipped without one, which meant every match was at the setting
             nobody would have chosen -- see `Difficulty.ts`.
            */
            label: 'Bot difficulty',
            note: 'g_spSkill. Reaction, aim, and how long they stay interested.',
            initial: DEFAULT_DIFFICULTY,
            options: DIFFICULTIES.map((d) => ({ value: d.id, label: d.label })),
            apply: (v) => bots.setDifficulty(difficulty(String(v)).id),
        },
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
