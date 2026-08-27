/*
 * optionalAsset.ts -- fetching a file that is allowed not to be there.
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
 * **`response.ok` does not mean the file exists**, and on this dev server it
 * almost never does. Vite answers an unmatched path with the SPA fallback: 418
 * bytes of `index.html`, `content-type: text/html`, **status 200**. So a
 * `!r.ok` guard around an optional asset does not fire, and the caller gets a
 * document where it asked for a binary.
 *
 * That is not a hypothetical. `loadVolumetricLightMap` shipped that guard for
 * about ten minutes and the console said
 * `indirect lighting: brick4, 0.00 MB baked volume` on a map with no bake at
 * all -- Brick4 mode turned on over 418 bytes of HTML, which the GPU would have
 * been asked to traverse as a sparse voxel hierarchy. `loadProbeField` had the
 * same guard, latent only because every built map happened to have been baked.
 *
 * The two required loaders (`scene.json`, `collision.bsp`) are not affected in
 * the same way: they parse what comes back, and HTML fails that loudly. It is
 * specifically *optional* assets, where "absent" is a supported answer, that
 * need a test which distinguishes absent from present.
 */

/**
 * Fetch a binary asset that may legitimately be missing.
 *
 * Returns null when the file is not there -- by status, or by the dev server
 * having answered with its HTML fallback instead.
 *
 * A zero-length body is also null. Nothing here produces empty files on
 * purpose, so one is a bake that died halfway, and every consumer of these
 * treats "no bytes" as "no asset" anyway.
 */
export async function fetchOptionalBinary(url: string): Promise<ArrayBuffer | null> {
    const response = await fetch(url);

    if (!response.ok) return null;

    /*
     The fallback is HTML and every asset here is not, so the content type is
     the whole test. Checked before the body is read: `text/html` on a path
     under `assets/built/` is the fallback and never a real file.
    */
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return null;

    const data = await response.arrayBuffer();

    return data.byteLength === 0 ? null : data;
}
