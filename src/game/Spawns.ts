/*
 * Spawns.ts -- where players and bots enter a level.
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
 * `SelectSpawnPoint`, reduced to the part a free-for-all needs, plus a fallback
 * chain Q3 does not have and this port does.
 *
 * Q3 looks for `info_player_deathmatch` and calls `G_Error` when there is none,
 * because a Q3 server knows what gametype it is running and refuses a map that
 * cannot host it. This port has one gametype and six maps, and one of the six --
 * `am_thornish`, the largest and the one the performance numbers are quoted
 * from -- is a Team Arena map with **no `info_player_deathmatch` at all**. Its
 * entry points are 24 CTF team spawns and 16 `info_player_start`.
 *
 * Filtering for the deathmatch keyword alone therefore produced an empty list on
 * that map, which meant no bots, and a death respawning the player at the world
 * origin because `spawns[random] ?? [0, 0, 0]` did exactly what it was written
 * to do. Found in phase 6 by `test/presentation.test.ts` noticing that the map
 * had no spawn points of the expected kind, not by playing it -- which is the
 * argument for the test.
 */

/** The subset of a parsed BSP entity this needs. */
export interface SpawnEntity {
    readonly classname?: string | undefined;
    readonly _originQ3: readonly number[];
    readonly angle?: unknown;
}

/**
 * Entry-point classnames, in the order Q3 would prefer them.
 *
 * The CTF spawns come before `info_player_start` deliberately: on a CTF map the
 * team spawns are the ones placed for combat, while `info_player_start` is
 * frequently a single lobby position the map never expects to be fought over.
 * Both teams are taken, because a free-for-all has no teams.
 */
const PREFERENCE: readonly (readonly string[])[] = [
    ['info_player_deathmatch'],
    ['team_CTF_redspawn', 'team_CTF_bluespawn'],
    ['team_CTF_redplayer', 'team_CTF_blueplayer'],
    ['info_player_start'],
];

export interface SpawnSet<T extends SpawnEntity> {
    /** The entities themselves, in map order, so callers keep every key. */
    readonly points: readonly T[];
    /** Which classnames these came from, for the startup log. */
    readonly kind: string;
}

/**
 * Every point a player or bot may enter the level at.
 *
 * Returns the first non-empty tier of `PREFERENCE` rather than the union: mixing
 * combat spawns with a lobby `info_player_start` would put a bot in the lobby
 * for the whole match on a map that has both.
 */
export function spawnPoints<T extends SpawnEntity>(entities: readonly T[]): SpawnSet<T> {
    for (const tier of PREFERENCE) {
        const points = entities.filter(
            (e) => e.classname !== undefined && tier.includes(e.classname)
        );

        if (points.length > 0) return { points, kind: tier.join(' + ') };
    }

    return { points: [], kind: 'none' };
}
