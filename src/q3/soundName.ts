/*
 * soundName.ts -- Q3's rules for turning a map's sound key into a path, and the
 * port's rule for turning a path into a manifest name.
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
 * Shared by `tools/convert-sounds.ts`, which decides which files to copy, and by
 * `src/client/MapSound.ts`, which decides what to ask the bank for. They have to
 * agree exactly -- a map naming a sound the converter flattened differently is a
 * silent miss -- so the agreement is one function rather than two conventions.
 */

/**
 * `SP_target_speaker`'s normalisation of a `noise` key.
 *
 * Two rules come straight from the C. A key with no `.wav` in it gets one
 * appended (`Com_sprintf(buffer, sizeof(buffer), "%s.wav", s)`), which is how
 * maps get away with `"noise" "world/wind1"`. And a key beginning with `*` is
 * forced to spawnflag 8 -- an "activator" speaker that plays a client-relative
 * sound on whoever triggered it, which is a player sound and not a map one.
 *
 * The leading slash some maps carry (`aggressor` writes `/sound/world/wind1.wav`)
 * is not in the C, because Q3's filesystem strips it on the way to the pak.
 *
 * @returns the path under the game directory, or null if this is not a sound the
 *          map itself owns.
 */
export function speakerNoisePath(noise: string): string | null {
    const trimmed = noise.trim();

    if (trimmed.length === 0) return null;

    // Client-relative: an activator speaker, played on a player rather than here.
    if (trimmed.startsWith('*')) return null;

    const rooted = trimmed.replace(/^[/\\]+/, '').replace(/\\/g, '/');

    return rooted.includes('.wav') ? rooted : `${rooted}.wav`;
}

/**
 * The manifest name for a Q3 sound path.
 *
 * `sound/world/wind1.wav` -> `world/wind1`, `music/oa14.ogg` -> `music/oa14`.
 * The `sound/` prefix goes because every effect carries it and it says nothing;
 * the extension goes because the converter is free to change it and the name is
 * what the game refers to the sound by.
 */
export function soundName(path: string): string {
    return path
        .replace(/\\/g, '/')
        .replace(/^[/\\]+/, '')
        .replace(/^sound\//, '')
        .replace(/\.[^./]+$/, '');
}
