/*
 * constants.ts -- movement constants and flags from bg_public.h.
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
 * These are balance numbers, and the brief keeps balance faithful. Nothing here
 * is tuned, rounded or "modernised" -- `JUMP_VELOCITY` is 270 because it is 270,
 * and a strafe jump that clears a gap in Q3 has to clear it here.
 */

/**
 * Float literals must be rounded to float32.
 *
 * `#define OVERCLIP 1.001f` is a *float* constant: the value the C actually
 * multiplies by is 1.0010000467300415, not 1.001. Using the double drifts the
 * port from the oracle by one ULP per clip, which compounds -- it showed up as a
 * last-digit position difference after ~140 frames of bunny hopping, and nowhere
 * before that.
 *
 * Only constants that are not exactly representable in binary need this
 * (`0.25`, `0.5`, `100.0` and friends are exact), but it is applied wherever the
 * C wrote an `f` suffix so the correspondence is checkable by eye rather than by
 * remembering which decimals are dyadic.
 */
const F = Math.fround;

/* ---- pmove tunables, from the top of bg_pmove.c ---- */

export const pm_stopspeed = 100.0;
export const pm_duckScale = 0.25;
export const pm_swimScale = 0.50;
export const pm_wadeScale = F(0.70);

/** OpenArena addition, used when `DF_FAST_WATER_MOVE` is set. */
export const pm_swimFastScale = 5.0;

export const pm_accelerate = 10.0;
export const pm_airaccelerate = 1.0;
export const pm_wateraccelerate = 4.0;
export const pm_flyaccelerate = 8.0;

export const pm_friction = 6.0;
export const pm_waterfriction = 1.0;
export const pm_flightfriction = 3.0;
export const pm_spectatorfriction = 5.0;

/* ---- bg_public.h ---- */

export const STEPSIZE = 18;
export const JUMP_VELOCITY = 270;

export const MINS_Z = -24;
export const DEFAULT_VIEWHEIGHT = 26;
export const CROUCH_VIEWHEIGHT = 12;
export const DEAD_VIEWHEIGHT = -16;

/** OpenArena's `cg_enableQ` Quake-scale viewheight. Unused at the default cvar value. */
export const QUACK_VIEWHEIGHT = 22;

/** `bg_local.h`. Slopes shallower than this are not walkable. */
export const MIN_WALK_NORMAL = F(0.7);
export const OVERCLIP = F(1.001);

export const TIMER_LAND = 130;
export const TIMER_GESTURE = 34 * 66 + 50;

export const MAX_CLIP_PLANES = 5;
export const MAXTOUCH = 32;

export const ENTITYNUM_NONE = 1023;
export const ENTITYNUM_WORLD = 1022;

export const PS_PMOVEFRAMECOUNTBITS = 6;

/** `pmtype_t`. Order matters: `pm_type >= PM_DEAD` gates input. */
export const PM_NORMAL = 0;
export const PM_NOCLIP = 1;
export const PM_SPECTATOR = 2;
export const PM_DEAD = 3;
export const PM_FREEZE = 4;
export const PM_INTERMISSION = 5;
export const PM_SPINTERMISSION = 6;

/** `pmflags_t`. */
export const PMF_DUCKED = 1;
export const PMF_JUMP_HELD = 2;
export const PMF_BACKWARDS_JUMP = 8;
export const PMF_BACKWARDS_RUN = 16;
export const PMF_TIME_LAND = 32;
export const PMF_TIME_KNOCKBACK = 64;
export const PMF_TIME_WATERJUMP = 256;
export const PMF_RESPAWNED = 512;
export const PMF_USE_ITEM_HELD = 1024;
export const PMF_GRAPPLE_PULL = 2048;
export const PMF_FOLLOW = 4096;
export const PMF_SCOREBOARD = 8192;
export const PMF_INVULEXPAND = 16384;
/** OpenArena: elimination warmup suppresses weapon handling. */
export const PMF_ELIMWARMUP = 32768;

export const PMF_ALL_TIMES = PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_KNOCKBACK;

/** Buttons, `bg_public.h`. */
export const BUTTON_ATTACK = 1;
export const BUTTON_TALK = 2;
export const BUTTON_USE_HOLDABLE = 4;
export const BUTTON_GESTURE = 8;
export const BUTTON_WALKING = 16;

/** Powerup slots used by movement. */
export const PW_QUAD = 1;
export const PW_BATTLESUIT = 2;
export const PW_HASTE = 3;
export const PW_INVIS = 4;
export const PW_REGEN = 5;
export const PW_FLIGHT = 6;
export const PW_INVULNERABILITY = 14;

export const STAT_HEALTH = 0;

/** `eFlags`. */
export const EF_TALK = 8;
export const EF_FIRING = 0x0010;

/** OpenArena dmflags that reach pmove through `pmove_flags`. */
export const DF_NO_BUNNY = 512;
export const DF_FAST_WATER_MOVE = 1024;

/** Events, `bg_public.h`. Only the ones pmove raises. */
export const EV_NONE = 0;
export const EV_FOOTSTEP = 1;
export const EV_FOOTSTEP_METAL = 2;
export const EV_FOOTSPLASH = 3;
export const EV_FOOTWADE = 4;
export const EV_SWIM = 5;
export const EV_STEP_4 = 6;
export const EV_STEP_8 = 7;
export const EV_STEP_12 = 8;
export const EV_STEP_16 = 9;
export const EV_FALL_SHORT = 10;
export const EV_FALL_MEDIUM = 11;
export const EV_FALL_FAR = 12;
export const EV_JUMP_PAD = 13;
export const EV_JUMP = 14;
export const EV_WATER_TOUCH = 15;
export const EV_WATER_LEAVE = 16;
export const EV_WATER_UNDER = 17;
export const EV_WATER_CLEAR = 18;

/** Animation numbers pmove sets. `ANIM_TOGGLEBIT` flips to restart an animation. */
export const ANIM_TOGGLEBIT = 128;

export const LEGS_WALKCR = 6;
export const LEGS_WALK = 7;
export const LEGS_RUN = 8;
export const LEGS_BACK = 9;
export const LEGS_SWIM = 10;
export const LEGS_JUMP = 11;
export const LEGS_LAND = 12;
export const LEGS_JUMPB = 13;
export const LEGS_LANDB = 14;
export const LEGS_IDLE = 15;
export const LEGS_IDLECR = 16;
export const LEGS_TURN = 17;

/** OpenArena additions used by `PM_Footsteps`. */
export const LEGS_BACKCR = 18;
export const LEGS_BACKWALK = 19;
export const LEGS_STRAFE_LEFT = 20;
export const LEGS_STRAFE_RIGHT = 21;

export const TORSO_GESTURE = 3;

/** `MAX_PS_EVENTS` in q_shared.h. */
export const MAX_PS_EVENTS = 2;
export const MAX_STATS = 16;
export const MAX_PERSISTANT = 16;
export const MAX_POWERUPS = 16;
export const MAX_WEAPONS = 16;
