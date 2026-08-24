/*
 * Entities.ts -- parser for the Quake III BSP entity lump.
 *
 * Ported from the tokenizer in ioquake3's `code/qcommon/q_shared.c`
 * (`COM_ParseExt`) and the spawn-string walk in `code/game/g_spawn.c`.
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
 * The entity lump is one string of brace-delimited key/value blocks:
 *
 *     {
 *     "classname" "info_player_deathmatch"
 *     "origin" "128 -256 24"
 *     "angle" "90"
 *     }
 *
 * In Q3 the gamecode walked this with `trap_GetEntityToken` one token at a time
 * because the QVM could not be handed a string of unbounded length. There is no
 * such constraint here, so this parses the whole lump at once and returns
 * records.
 */

/** A parsed entity: every key lowercased, values kept verbatim. */
export type EntityRecord = Readonly<Record<string, string>>;

/**
 * Parse the entity lump.
 *
 * Tolerant in the same places Q3's tokenizer is: `//` line comments, arbitrary
 * whitespace, and stray tokens outside braces are all skipped rather than
 * treated as errors. Real maps in the wild contain all three.
 */
export function parseEntities(source: string): EntityRecord[] {
    const out: EntityRecord[] = [];

    let i = 0;
    const n = source.length;

    /** Advance past whitespace and `//` comments. */
    const skipBlank = (): void => {
        for (;;) {
            while (i < n && source.charCodeAt(i) <= 32) i += 1;

            if (i + 1 < n && source[i] === '/' && source[i + 1] === '/') {
                while (i < n && source[i] !== '\n') i += 1;
                continue;
            }

            return;
        }
    };

    /** Read one token: a quoted string, or a run of non-space characters. */
    const token = (): string | null => {
        skipBlank();
        if (i >= n) return null;

        if (source[i] === '"') {
            i += 1;
            const start = i;
            while (i < n && source[i] !== '"') i += 1;
            const s = source.slice(start, i);
            i += 1; // closing quote
            return s;
        }

        const start = i;
        while (i < n && source.charCodeAt(i) > 32) i += 1;
        return source.slice(start, i);
    };

    for (;;) {
        const open = token();
        if (open === null) break;

        // Skip anything that is not the start of a block. The entity lump is
        // nul-padded to a lump boundary, so the tail is usually a run of empty
        // tokens rather than a clean end.
        if (open !== '{') continue;

        const entity: Record<string, string> = {};

        for (;;) {
            const key = token();
            if (key === null || key === '}') break;

            const value = token();
            if (value === null) break;

            // Q3 keys are matched case-insensitively; values are not (they carry
            // texture paths, target names and targetnames that are compared as-is
            // elsewhere, and lowercasing them would break `target`/`targetname`
            // pairing on maps that mix case).
            entity[key.toLowerCase()] = value;
        }

        if (Object.keys(entity).length > 0) {
            out.push(entity);
        }
    }

    return out;
}

/**
 * Read a `"x y z"` value as a vector, in Q3 coordinates (Z-up).
 *
 * Returns `fallback` when the key is absent or does not parse -- entity lumps
 * routinely carry malformed origins on hand-edited maps, and refusing to load a
 * whole level over one bad light is not worth it.
 */
export function entityVector(
    entity: EntityRecord,
    key: string,
    fallback: readonly [number, number, number] = [0, 0, 0]
): [number, number, number] {
    const raw = entity[key];
    if (raw === undefined) return [...fallback];

    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3) return [...fallback];

    const x = Number.parseFloat(parts[0]!);
    const y = Number.parseFloat(parts[1]!);
    const z = Number.parseFloat(parts[2]!);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return [...fallback];
    }

    return [x, y, z];
}

/** Read a numeric value, falling back when absent or unparseable. */
export function entityNumber(entity: EntityRecord, key: string, fallback: number): number {
    const raw = entity[key];
    if (raw === undefined) return fallback;

    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
}

/**
 * Q3 stores a single-axis rotation as `"angle"` and a full orientation as
 * `"angles"` (`pitch yaw roll`). `angle` values -1 and -2 are the sentinels
 * `ANGLE_UP` and `ANGLE_DOWN` from qfiles.h rather than real yaws.
 */
export function entityYaw(entity: EntityRecord): number {
    const angles = entity['angles'];
    if (angles !== undefined) {
        return entityVector(entity, 'angles')[1];
    }

    const angle = entityNumber(entity, 'angle', 0);
    if (angle === -1 || angle === -2) return 0;

    return angle;
}
