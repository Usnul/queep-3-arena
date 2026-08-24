/*
 * shim.c -- the twelve engine functions ioquake3's collision model needs.
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
 * `cm_load.c`, `cm_trace.c`, `cm_patch.c`, `cm_polylib.c` and `cm_test.c` are
 * compiled here unmodified. Grepping them for external calls yields exactly
 * twelve engine functions, all implemented below. Nothing else of ioquake3 is
 * needed -- no filesystem, no cvar system, no hunk allocator, no console.
 *
 * The point of the oracle is that the C is *untouched*. Every deviation between
 * it and the TypeScript port is then unambiguously the port's, which is the only
 * property that makes a differential test worth running.
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdarg.h>

#include "../.refs/ioq3/code/qcommon/q_shared.h"
#include "../.refs/ioq3/code/qcommon/qcommon.h"

/* ------------------------------------------------------------------ *
 * Memory.
 *
 * The hunk is a bump allocator in the real engine and everything in it lives
 * for the lifetime of a map. Here it is one large calloc'd block, reset when a
 * new BSP is loaded. Using malloc per allocation would work too; a bump
 * allocator is closer to the original and makes "free everything" trivial.
 * ------------------------------------------------------------------ */

#define HUNK_SIZE (64 * 1024 * 1024)

static byte *hunk_base = NULL;
static int   hunk_used = 0;

void oracle_hunk_reset(void) {
    if (hunk_base == NULL) {
        hunk_base = (byte *)calloc(1, HUNK_SIZE);
    }
    hunk_used = 0;
}

void *Hunk_Alloc(int size, ha_pref preference) {
    void *p;

    (void)preference;

    if (hunk_base == NULL) {
        oracle_hunk_reset();
    }

    /* 16-byte align, as the engine's own hunk does. */
    size = (size + 15) & ~15;

    if (hunk_used + size > HUNK_SIZE) {
        Com_Error(ERR_FATAL, "Hunk_Alloc: out of memory (%i requested, %i used)",
                  size, hunk_used);
        return NULL;
    }

    p = hunk_base + hunk_used;
    hunk_used += size;

    memset(p, 0, size);

    return p;
}

void *Z_Malloc(int size) {
    void *p = malloc(size);
    if (p != NULL) {
        memset(p, 0, size);
    }
    return p;
}

void *Z_TagMalloc(int size, int tag) {
    (void)tag;
    return Z_Malloc(size);
}

void Z_Free(void *ptr) {
    free(ptr);
}

/*
 `Com_Memset` and `Com_Memcpy` are `#define`d straight to `memset`/`memcpy` in
 `q_shared.h` outside the QVM build, so there is nothing to implement -- and
 defining them here would collide with libc.
*/

/* ------------------------------------------------------------------ *
 * Filesystem.
 *
 * `CM_LoadMap` calls `FS_ReadFile` for the .bsp. The oracle is handed the bytes
 * from JavaScript instead, so this returns the buffer that was staged.
 * ------------------------------------------------------------------ */

static void *staged_bsp = NULL;
static int   staged_bsp_len = 0;

void oracle_stage_bsp(void *data, int len) {
    staged_bsp = data;
    staged_bsp_len = len;
}

/* `long`, not `int`: qcommon.h declares it that way outside the QVM build. */
long FS_ReadFile(const char *qpath, void **buffer) {
    (void)qpath;

    if (staged_bsp == NULL) {
        if (buffer != NULL) {
            *buffer = NULL;
        }
        return -1;
    }

    if (buffer != NULL) {
        *buffer = staged_bsp;
    }

    return staged_bsp_len;
}

void FS_FreeFile(void *buffer) {
    /* The staged buffer is owned by the caller across the WASM boundary. */
    (void)buffer;
}

/* ------------------------------------------------------------------ *
 * Cvars.
 *
 * `CM_LoadMap` reads `cm_noAreas`, `cm_noCurves` and `cm_playerCurveClip`. All
 * three keep their shipped defaults; the oracle must behave like a stock engine.
 * ------------------------------------------------------------------ */

static cvar_t stub_cvars[8];
static int    stub_cvar_count = 0;

cvar_t *Cvar_Get(const char *name, const char *value, int flags) {
    cvar_t *c;

    (void)flags;

    if (stub_cvar_count >= 8) {
        return &stub_cvars[0];
    }

    c = &stub_cvars[stub_cvar_count++];

    c->name = (char *)name;
    c->string = (char *)value;
    c->value = (float)atof(value);
    c->integer = atoi(value);

    return c;
}

/* ------------------------------------------------------------------ *
 * Diagnostics.
 * ------------------------------------------------------------------ */

void QDECL Com_Printf(const char *fmt, ...) {
    (void)fmt;
}

void QDECL Com_DPrintf(const char *fmt, ...) {
    (void)fmt;
}

void QDECL Com_Error(int level, const char *fmt, ...) {
    va_list argptr;
    char text[1024];

    (void)level;

    va_start(argptr, fmt);
    vsnprintf(text, sizeof(text), fmt, argptr);
    va_end(argptr);

    /*
     Aborting rather than returning is deliberate. A differential test whose
     oracle silently continued after a fatal error would compare the port
     against garbage and report agreement or disagreement equally meaninglessly.
    */
    fprintf(stderr, "oracle Com_Error: %s\n", text);
    abort();
}

/*
 * `CM_LoadMap` checksums the BSP to detect client/server map mismatch. Nothing
 * in the oracle compares checksums, but the function has to exist and has to be
 * deterministic.
 */
unsigned Com_BlockChecksum(const void *buffer, int length) {
    const byte *p = (const byte *)buffer;
    unsigned h = 2166136261u;
    int i;

    for (i = 0; i < length; i++) {
        h ^= p[i];
        h *= 16777619u;
    }

    return h;
}

/* ------------------------------------------------------------------ *
 * Gamecode symbols `bg_pmove.c` references but does not define.
 *
 * These are normally supplied by the VM host or by other gamecode
 * translation units. Only the ones pmove actually reads are provided.
 * ------------------------------------------------------------------ */

#include "../.refs/oa-gamecode/code/game/bg_public.h"

/*
 `trap_SnapVector` is the engine syscall behind Q3's `SnapVector`. It rounds
 each component to the nearest integer, and it is *movement-visible*: pmove snaps
 velocity every frame, so the rounding is part of how the game feels rather than
 an optimisation. The engine's own implementation is a round-to-nearest, which is
 what `rint` gives with the default rounding mode.
*/
void trap_SnapVector(float *v) {
    v[0] = (float)((int)(v[0] + (v[0] >= 0 ? 0.5f : -0.5f)));
    v[1] = (float)((int)(v[1] + (v[1] >= 0 ? 0.5f : -0.5f)));
    v[2] = (float)((int)(v[2] + (v[2] >= 0 ? 0.5f : -0.5f)));
}

/*
 An OpenArena cgame cvar ("leilei - map changes player/weapons scale (for q1
 adaptations)"). `bg_pmove.c` reads `cg_enableQ.value` in two places, both
 gating a non-default player scale. Zero is the shipped default and the only
 value the port implements; the differential test therefore exercises the same
 branch on both sides.
*/
vmCvar_t cg_enableQ;
