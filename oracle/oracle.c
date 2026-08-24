/*
 * oracle.c -- WASM entry points for the pmove differential test.
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
 * Compiles OpenArena's `bg_pmove.c` and `bg_slidemove.c` against ioquake3's
 * collision model, loads a real BSP, and runs `Pmove` on demand. The TypeScript
 * port is then fed identical inputs and its outputs compared numerically.
 *
 * **Struct layout is exported rather than duplicated.** `playerState_t` and
 * `usercmd_t` are exposed to JavaScript as raw memory plus an offset table
 * emitted by `oracle_offsets`. Every field of `playerState_t` is four bytes wide
 * -- ints, and `vec3_t` which is three floats -- so a single `Int32Array` and
 * `Float32Array` pair over the same buffer reads all of it, indexed by
 * `offset / 4`. Hand-marshalling forty fields across the boundary would
 * introduce exactly the kind of transcription error the oracle exists to catch.
 */

#include <string.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "../.refs/ioq3/code/qcommon/q_shared.h"
#include "../.refs/ioq3/code/qcommon/qcommon.h"
#include "../.refs/ioq3/code/qcommon/cm_public.h"

/*
 OpenArena's gamecode headers, not ioquake3's: `bg_pmove.c` here is OA's, and
 its `pmove_t` carries two fields ioquake3's does not (`pmove_float`,
 `pmove_flags`). Mixing the two headers would silently disagree about the struct
 layout.
*/
#include "../.refs/oa-gamecode/code/game/bg_public.h"

#define EXPORT __attribute__((used)) __attribute__((visibility("default")))

extern void oracle_stage_bsp(void *data, int len);
extern void oracle_hunk_reset(void);

/* ------------------------------------------------------------------ *
 * World
 * ------------------------------------------------------------------ */

static clipHandle_t world_model;
static int world_loaded = 0;

/**
 * Load a BSP into the collision model.
 *
 * The buffer must stay alive for the call; `CM_LoadMap` copies what it keeps
 * into the hunk.
 */
EXPORT int oracle_load_bsp(void *data, int len) {
    int checksum = 0;

    oracle_hunk_reset();
    oracle_stage_bsp(data, len);

    CM_LoadMap("maps/oracle.bsp", qfalse, &checksum);

    world_model = CM_InlineModel(0);
    world_loaded = 1;

    return checksum;
}

EXPORT int oracle_num_inline_models(void) {
    return CM_NumInlineModels();
}

/* ------------------------------------------------------------------ *
 * Trace callbacks
 *
 * `pm->trace` in a real game clips against the world *and* every linked entity.
 * The oracle clips against the world only: entity clipping is `g_*` code, not
 * `bg_*`, and including it would mean porting the server's entity link grid
 * into the oracle just to have something to disagree about. Movement fidelity
 * -- strafe jumps, ramp jumps, air control, stair stepping -- is entirely a
 * function of world geometry.
 * ------------------------------------------------------------------ */

static void oracle_trace_world(trace_t *results, const vec3_t start,
                               const vec3_t mins, const vec3_t maxs,
                               const vec3_t end, int passEntityNum,
                               int contentMask) {
    (void)passEntityNum;

    CM_BoxTrace(results, start, end, (float *)mins, (float *)maxs, world_model,
                contentMask, /* capsule */ qfalse);

    /*
     `CM_BoxTrace` leaves `entityNum` alone; the server fills it in when it
     merges world and entity traces. pmove reads it to decide what it is standing
     on, so the world has to claim it.
    */
    results->entityNum = results->fraction != 1.0f ? ENTITYNUM_WORLD : ENTITYNUM_NONE;
}

static int oracle_pointcontents(const vec3_t point, int passEntityNum) {
    (void)passEntityNum;
    return CM_PointContents(point, world_model);
}

/**
 * Direct access to a single box trace, so the TypeScript `CM_BoxTrace` port can
 * be differentiated on its own before pmove is layered on top. A movement
 * divergence caused by a trace divergence is much easier to find when the trace
 * is tested first.
 *
 * **Floats and ints go to separate buffers.** An earlier version returned
 * everything as `float`, which silently corrupted the flag fields: content masks
 * run to 0x20000001, and a float32 mantissa is 24 bits, so that value came back
 * as 0x20000000. It presented as the port disagreeing about `contents` on one
 * map in five -- a plausible-looking port bug that was entirely in the harness.
 *
 * `fout` receives [allsolid, startsolid, fraction, endpos*3, plane.normal*3,
 * plane.dist]; `iout` receives [surfaceFlags, contents, entityNum].
 */
EXPORT void oracle_box_trace(float *fout, int *iout, const float *start,
                             const float *mins, const float *maxs,
                             const float *end, int contentmask) {
    trace_t tr;

    CM_BoxTrace(&tr, start, end, (float *)mins, (float *)maxs, world_model,
                contentmask, /* capsule */ qfalse);

    fout[0] = (float)tr.allsolid;
    fout[1] = (float)tr.startsolid;
    fout[2] = tr.fraction;
    fout[3] = tr.endpos[0];
    fout[4] = tr.endpos[1];
    fout[5] = tr.endpos[2];
    fout[6] = tr.plane.normal[0];
    fout[7] = tr.plane.normal[1];
    fout[8] = tr.plane.normal[2];
    fout[9] = tr.plane.dist;

    iout[0] = tr.surfaceFlags;
    iout[1] = tr.contents;
    iout[2] = tr.entityNum;
}

EXPORT int oracle_point_contents(const float *point) {
    return CM_PointContents(point, world_model);
}

/* ------------------------------------------------------------------ *
 * Pmove
 * ------------------------------------------------------------------ */

static playerState_t ps;
static pmove_t pm;

EXPORT void *oracle_ps_ptr(void) {
    return &ps;
}

EXPORT void *oracle_cmd_ptr(void) {
    return &pm.cmd;
}

EXPORT int oracle_ps_size(void) {
    return (int)sizeof(playerState_t);
}

EXPORT int oracle_cmd_size(void) {
    return (int)sizeof(usercmd_t);
}

/**
 * Field offsets, in bytes, in a fixed order the TypeScript side mirrors.
 *
 * Emitted from `offsetof` rather than assumed, so a struct-layout change in
 * either upstream shows up as a moved offset instead of as silently misread
 * memory.
 */
EXPORT void oracle_offsets(int *out) {
    int i = 0;

    /* playerState_t */
    out[i++] = (int)offsetof(playerState_t, commandTime);
    out[i++] = (int)offsetof(playerState_t, pm_type);
    out[i++] = (int)offsetof(playerState_t, bobCycle);
    out[i++] = (int)offsetof(playerState_t, pm_flags);
    out[i++] = (int)offsetof(playerState_t, pm_time);
    out[i++] = (int)offsetof(playerState_t, origin);
    out[i++] = (int)offsetof(playerState_t, velocity);
    out[i++] = (int)offsetof(playerState_t, weaponTime);
    out[i++] = (int)offsetof(playerState_t, gravity);
    out[i++] = (int)offsetof(playerState_t, speed);
    out[i++] = (int)offsetof(playerState_t, delta_angles);
    out[i++] = (int)offsetof(playerState_t, groundEntityNum);
    out[i++] = (int)offsetof(playerState_t, legsTimer);
    out[i++] = (int)offsetof(playerState_t, legsAnim);
    out[i++] = (int)offsetof(playerState_t, torsoTimer);
    out[i++] = (int)offsetof(playerState_t, torsoAnim);
    out[i++] = (int)offsetof(playerState_t, movementDir);
    out[i++] = (int)offsetof(playerState_t, grapplePoint);
    out[i++] = (int)offsetof(playerState_t, eFlags);
    out[i++] = (int)offsetof(playerState_t, eventSequence);
    out[i++] = (int)offsetof(playerState_t, events);
    out[i++] = (int)offsetof(playerState_t, eventParms);
    out[i++] = (int)offsetof(playerState_t, externalEvent);
    out[i++] = (int)offsetof(playerState_t, clientNum);
    out[i++] = (int)offsetof(playerState_t, weapon);
    out[i++] = (int)offsetof(playerState_t, weaponstate);
    out[i++] = (int)offsetof(playerState_t, viewangles);
    out[i++] = (int)offsetof(playerState_t, viewheight);
    out[i++] = (int)offsetof(playerState_t, damageEvent);
    out[i++] = (int)offsetof(playerState_t, damageYaw);
    out[i++] = (int)offsetof(playerState_t, damagePitch);
    out[i++] = (int)offsetof(playerState_t, damageCount);
    out[i++] = (int)offsetof(playerState_t, stats);
    out[i++] = (int)offsetof(playerState_t, persistant);
    out[i++] = (int)offsetof(playerState_t, powerups);
    out[i++] = (int)offsetof(playerState_t, ammo);
    out[i++] = (int)offsetof(playerState_t, generic1);
    out[i++] = (int)offsetof(playerState_t, loopSound);
    out[i++] = (int)offsetof(playerState_t, jumppad_ent);
    out[i++] = (int)offsetof(playerState_t, pmove_framecount);
    out[i++] = (int)offsetof(playerState_t, jumppad_frame);
    out[i++] = (int)offsetof(playerState_t, entityEventSequence);

    /* usercmd_t */
    out[i++] = (int)offsetof(usercmd_t, serverTime);
    out[i++] = (int)offsetof(usercmd_t, angles);
    out[i++] = (int)offsetof(usercmd_t, buttons);
    out[i++] = (int)offsetof(usercmd_t, weapon);
    out[i++] = (int)offsetof(usercmd_t, forwardmove);
    out[i++] = (int)offsetof(usercmd_t, rightmove);
    out[i++] = (int)offsetof(usercmd_t, upmove);

    /* sizes, so the reader can bounds-check */
    out[i++] = (int)sizeof(playerState_t);
    out[i++] = (int)sizeof(usercmd_t);
    out[i++] = (int)MAX_STATS;
    out[i++] = (int)MAX_PERSISTANT;
    out[i++] = (int)MAX_POWERUPS;
    out[i++] = (int)MAX_WEAPONS;
    out[i++] = (int)MAX_PS_EVENTS;
}

EXPORT int oracle_offset_count(void) {
    return 49 + 7;
}

/** Zero both structs. Called between randomised episodes. */
EXPORT void oracle_reset(void) {
    memset(&ps, 0, sizeof(ps));
    memset(&pm, 0, sizeof(pm));
    pm.ps = &ps;
}

/**
 * Run one `Pmove`.
 *
 * The `pmove_t` flags that are not part of `playerState_t` are passed here
 * rather than being exposed as memory, because they are inputs the test varies
 * per call rather than state that carries between calls.
 */
EXPORT void oracle_pmove(int tracemask, int pmove_fixed, int pmove_msec,
                         int noFootsteps, int gauntletHit, int pmove_float,
                         int pmove_flags) {
    pm.ps = &ps;
    pm.tracemask = tracemask;
    pm.debugLevel = 0;
    pm.noFootsteps = noFootsteps ? qtrue : qfalse;
    pm.gauntletHit = gauntletHit ? qtrue : qfalse;
    pm.pmove_fixed = pmove_fixed;
    pm.pmove_msec = pmove_msec;
    pm.pmove_float = pmove_float;
    pm.pmove_flags = pmove_flags;
    pm.trace = oracle_trace_world;
    pm.pointcontents = oracle_pointcontents;

    Pmove(&pm);
}

/** Outputs of `pmove_t` that are not in `playerState_t`. */
EXPORT void oracle_pm_results(int *out, float *fout) {
    int i;

    out[0] = pm.numtouch;
    out[1] = pm.watertype;
    out[2] = pm.waterlevel;
    out[3] = pm.framecount;

    for (i = 0; i < MAXTOUCH && i < 32; i++) {
        out[4 + i] = i < pm.numtouch ? pm.touchents[i] : -1;
    }

    fout[0] = pm.mins[0];
    fout[1] = pm.mins[1];
    fout[2] = pm.mins[2];
    fout[3] = pm.maxs[0];
    fout[4] = pm.maxs[1];
    fout[5] = pm.maxs[2];
    fout[6] = pm.xyspeed;
}

/**
 * `PM_UpdateViewAngles` on its own -- it is called separately by the client and
 * has its own clamping behaviour worth testing in isolation.
 */
EXPORT void oracle_update_view_angles(void) {
    PM_UpdateViewAngles(&ps, &pm.cmd);
}
