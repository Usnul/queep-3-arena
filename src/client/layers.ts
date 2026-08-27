/*
 * layers.ts -- what may touch what, as a bitmask.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Q3 asks "does this brush block *this kind of* move" per trace, by handing a
 * `contentMask` to `CM_BoxTrace`. meep asks it once, per body, as a
 * `layer`/`mask` pair the narrowphase gates on. The two only have to agree where
 * something is resolved by a *contact* rather than by a query -- which, in this
 * port, means missiles and nothing else. Every other collision here is a
 * `shape_cast` or an `overlap`, and meep's queries consult the caller's filter
 * callback and never these.
 *
 * **`PLAYERCLIP` is the reason this file exists.** The level's bodies are built
 * once, with `MASK_PLAYERSOLID`, because they exist to stop players -- so a
 * brush that is player-clip and nothing else is a body like any other. Q3's
 * `MASK_SHOT` does not include `CONTENTS_PLAYERCLIP`: a rocket flies straight
 * through the invisible barriers that keep players out of a ledge, and a map
 * that uses them to fence a pit expects exactly that. Without a layer for it,
 * moving missiles onto the physics engine silently walls off every player-clip
 * brush in the game -- which is how this was found, with a rocket detonating on
 * thin air 18 units in front of the muzzle.
 */

import { CONTENTS } from '../q3/cm/ClipMap.ts';

/** Level geometry a shot stops on: `CONTENTS_SOLID`. */
export const LAYER_WORLD = 1;

/** Players and bots. */
export const LAYER_CHARACTER = 2;

/** Rockets, plasma, grenades. */
export const LAYER_MISSILE = 4;

/**
 * `CONTENTS_PLAYERCLIP` with no `CONTENTS_SOLID` behind it.
 *
 * Solid to a player, transparent to a shot, which is the whole point of the
 * content flag.
 */
export const LAYER_PLAYERCLIP = 8;

/** What a missile is allowed to touch. `MASK_SHOT`, as a layer mask. */
export const MISSILE_MASK = LAYER_WORLD | LAYER_CHARACTER;

/**
 * The layer a level brush belongs to, from the contents it was compiled with.
 *
 * A brush that is solid *and* player-clip is solid -- the clip flag adds a
 * restriction for players and takes nothing away from anyone else.
 */
export function layerForContents(contents: number): number {
    if ((contents & CONTENTS.SOLID) !== 0) return LAYER_WORLD;
    if ((contents & CONTENTS.PLAYERCLIP) !== 0) return LAYER_PLAYERCLIP;
    return LAYER_WORLD;
}
