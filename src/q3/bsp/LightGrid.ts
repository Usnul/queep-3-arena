/*
 * LightGrid.ts -- q3map2's baked irradiance volume, decoded.
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
 * `R_LoadLightGrid` and `R_SetupEntityLightingGrid`, ported for the asset
 * pipeline rather than for a renderer.
 *
 * q3map2 bakes two products. `LUMP_LIGHTMAPS` is a surface product -- texels on
 * the faces it lit -- and meep cannot import one (GAP-006). `LUMP_LIGHTGRID` is
 * a *volume* product: a regular lattice over the whole world model, eight bytes
 * per cell, holding the ambient colour arriving from everywhere, the directed
 * colour arriving from the dominant source, and the direction that source is
 * in. Q3 used it to light the models -- players, weapons, items -- that were
 * not part of the lightmap.
 *
 * It is the only surviving record of a map's lighting on a level whose author
 * used `light` entities, because q3map2 deletes those after baking. Two of this
 * port's six maps are lit that way, and one of them, `oa_dm5`, reconstructed to
 * exactly zero lights over 107,414 triangles before this existed. See Q-006 and
 * D-078.
 *
 * Nothing here decides what to *do* with the samples; that is
 * `tools/pipeline/lightgrid.ts`. This file answers "what did q3map2 measure,
 * and where".
 */

import type { BspFile } from './BspFile.ts';
import { parseEntities, type EntityRecord } from './Entities.ts';

/** `tr.world->lightGridSize` before worldspawn overrides it. Q3 units. */
export const DEFAULT_GRID_SIZE: readonly [number, number, number] = [64, 64, 128];

/** `dgridPoint_t` is eight bytes. */
export const GRID_POINT_BYTES = 8;

export interface GridSample {
    /** Light arriving from every direction, 0-255 per channel. */
    readonly ambient: readonly [number, number, number];
    /** Light arriving from `direction`, 0-255 per channel. */
    readonly directed: readonly [number, number, number];
    /**
     * Unit vector, Q3 axes, pointing *toward* the dominant source.
     *
     * `[0, 0, 1]` when the cell has no directed component, because the encoded
     * lat/long of an unlit cell is `0, 0`, which decodes to a legal but
     * meaningless direction.
     */
    readonly direction: readonly [number, number, number];
    /** Cell centre in Q3 world units. */
    readonly origin: readonly [number, number, number];
}

export interface LightGrid {
    /** Cell dimensions in Q3 units, from worldspawn `gridsize`. */
    readonly size: readonly [number, number, number];
    /** World position of cell `(0, 0, 0)`. */
    readonly origin: readonly [number, number, number];
    /** Cell counts along each axis. */
    readonly bounds: readonly [number, number, number];
    readonly count: number;
    /** Sample at a linear index, `x + y * nx + z * nx * ny`. */
    at(index: number): GridSample;
}

/**
 * `gridsize` off worldspawn, or Q3's default.
 *
 * A map that sets it is not exotic -- `am_thornish` does not, but the key is
 * standard and a wrong assumption here silently misplaces every sample by up to
 * a cell, which reads as lighting that is subtly in the wrong room.
 */
export function gridSizeFrom(entities: readonly EntityRecord[]): [number, number, number] {
    const worldspawn = entities.find((e) => e['classname'] === 'worldspawn');
    const raw = worldspawn?.['gridsize'];

    if (typeof raw !== 'string') return [...DEFAULT_GRID_SIZE];

    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v) || v <= 0)) {
        return [...DEFAULT_GRID_SIZE];
    }

    return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Read the lattice, or `null` if the map has no lightgrid.
 *
 * **Throws if the lattice arithmetic disagrees with the lump length.** That
 * check is the whole reason this can be trusted: the grid's geometry is not
 * stored in the file, it is *recomputed* from the world model's bounds and the
 * cell size, exactly as `R_LoadLightGrid` recomputes it. Get any part of that
 * wrong -- the rounding direction, the off-by-one in `bounds`, the `gridsize`
 * default -- and every sample still decodes, into the wrong place. The point
 * count is the one cross-check the file offers, and it is exact: on all six
 * maps here the formula predicts the lump length to the byte.
 */
export function readLightGrid(bsp: BspFile): LightGrid | null {
    const count = bsp.numLightGridPoints;
    if (count === 0) return null;

    const world = bsp.models[0];
    if (world === undefined) return null;

    const size = gridSizeFrom(parseEntities(bsp.entityString));

    const origin: [number, number, number] = [0, 0, 0];
    const bounds: [number, number, number] = [0, 0, 0];

    for (let i = 0; i < 3; i++) {
        const step = size[i]!;
        origin[i] = step * Math.ceil(world.mins[i]! / step);
        const hi = step * Math.floor(world.maxs[i]! / step);
        bounds[i] = (hi - origin[i]) / step + 1;
    }

    const expected = bounds[0] * bounds[1] * bounds[2];
    if (expected !== count) {
        throw new Error(
            `lightgrid lattice ${bounds.join('x')} at ${size.join(',')} predicts ` +
            `${expected} points, lump holds ${count}`
        );
    }

    const bytes = bsp.lightGridPoints;
    const strideY = bounds[0];
    const strideZ = bounds[0] * bounds[1];

    return {
        size,
        origin,
        bounds,
        count,
        at(index: number): GridSample {
            const p = index * GRID_POINT_BYTES;

            const z = Math.floor(index / strideZ);
            const y = Math.floor((index - z * strideZ) / strideY);
            const x = index - z * strideZ - y * strideY;

            return {
                ambient: [bytes[p]!, bytes[p + 1]!, bytes[p + 2]!],
                directed: [bytes[p + 3]!, bytes[p + 4]!, bytes[p + 5]!],
                direction: decodeDirection(bytes[p + 6]!, bytes[p + 7]!),
                origin: [
                    origin[0] + x * size[0]!,
                    origin[1] + y * size[1]!,
                    origin[2] + z * size[2]!,
                ],
            };
        },
    };
}

/**
 * `R_SetupEntityLightingGrid`'s lat/long decode.
 *
 * Two bytes over the full circle each. Q3 does it through `tr.sinTable` with
 * `sinTable[a + N/4] == cos(a)`, which is the same three lines with the
 * quarter-turn written out:
 *
 *     x = cos(lat) * sin(lng)
 *     y = sin(lat) * sin(lng)
 *     z = cos(lng)
 *
 * The names are the file format's and they are the wrong way round -- `lng` is
 * the polar angle and `lat` the azimuth -- which is worth knowing before
 * checking this against a spherical-coordinates reference and concluding it is
 * transposed.
 *
 * @param lngByte `latLong[0]`, the polar angle from +Z.
 * @param latByte `latLong[1]`, the azimuth in the XY plane.
 */
export function decodeDirection(
    lngByte: number,
    latByte: number
): [number, number, number] {
    // A cell with no directed light encodes 0, 0, which decodes to +Z. Reporting
    // that as a real direction would have the pipeline place a light above every
    // unlit cell in the map.
    if (lngByte === 0 && latByte === 0) return [0, 0, 1];

    const lat = (latByte * 2 * Math.PI) / 256;
    const lng = (lngByte * 2 * Math.PI) / 256;

    return [
        Math.cos(lat) * Math.sin(lng),
        Math.sin(lat) * Math.sin(lng),
        Math.cos(lng),
    ];
}
