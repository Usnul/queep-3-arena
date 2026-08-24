/*
 * texture-out.ts -- resolve a Q3 virtual texture path and write it next to a bundle.
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
 * Lifted out of `convert-map.ts` when the model converter needed the same
 * behaviour. TGA is decoded and re-encoded because browsers do not read it;
 * JPEG and PNG are copied byte-for-byte, because re-encoding them would only
 * lose quality to no purpose.
 */

import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import type { ShaderIndex } from './shader-index.ts';
import { decodeTga } from './tga.ts';

/**
 * Memo of virtual path -> written filename. An empty string records "resolved
 * to nothing", so a missing texture is looked up once rather than once per
 * material that references it.
 */
export type TextureCache = Map<string, string>;

export async function writeTexture(
    index: ShaderIndex,
    assetRoot: string,
    virtualPath: string,
    outDir: string,
    written: TextureCache
): Promise<string | null> {
    const existing = written.get(virtualPath);
    if (existing !== undefined) return existing === '' ? null : existing;

    const resolved = index.resolveTexture(virtualPath);
    if (resolved === null) {
        written.set(virtualPath, '');
        return null;
    }

    const src = join(assetRoot, resolved);
    const flat = virtualPath.replace(/[\\/]/g, '_');

    try {
        if (resolved.endsWith('.tga')) {
            const decoded = decodeTga(readFileSync(src));
            const out = `${flat}.png`;
            await sharp(Buffer.from(decoded.rgba), {
                raw: { width: decoded.width, height: decoded.height, channels: 4 },
            })
                .png({ compressionLevel: 9 })
                .toFile(join(outDir, out));
            written.set(virtualPath, out);
            return out;
        }

        const ext = resolved.slice(resolved.lastIndexOf('.'));
        const out = `${flat}${ext}`;
        copyFileSync(src, join(outDir, out));
        written.set(virtualPath, out);
        return out;
    } catch (e) {
        console.warn(`  texture ${virtualPath}: ${(e as Error).message}`);
        written.set(virtualPath, '');
        return null;
    }
}
