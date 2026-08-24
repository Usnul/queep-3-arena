/*
 * fetch-assets.mjs -- download the OpenArena 0.8.8 game data.
 *
 * Nothing this downloads is committed. `assets/` is gitignored in full; see
 * ASSETS.md for provenance and licensing of everything fetched here.
 *
 * Usage:  node tools/fetch-assets.mjs [--force]
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOWNLOAD_DIR = join(ROOT, 'assets', 'download');

export const ARCHIVES = [
    {
        name: 'openarena-0.8.8.zip',
        // SourceForge serves through rotating mirrors, which is exactly why the
        // hash below is checked rather than the URL trusted.
        url: 'https://downloads.sourceforge.net/project/oarena/openarena-0.8.8.zip',
        bytes: 425189255,
        sha256: '5a8faf7f5b51f351b0a1618c06b6b98a5f1a6758f1d39818de2c87df2a0bac4a',
        licence: 'GPLv2 (code) + per-asset GPLv2/CC-BY-SA/CC-BY; see COPYING inside the archive',
    },
];

async function sha256(path) {
    const hash = createHash('sha256');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}

function human(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function fetchOne(archive, force) {
    const dest = join(DOWNLOAD_DIR, archive.name);

    if (existsSync(dest) && !force) {
        const size = statSync(dest).size;
        if (size === archive.bytes) {
            const got = await sha256(dest);
            if (got === archive.sha256) {
                console.log(`${archive.name}: present and verified`);
                return dest;
            }
            console.log(`${archive.name}: hash mismatch, re-downloading`);
        } else {
            console.log(`${archive.name}: wrong size (${human(size)}), re-downloading`);
        }
    }

    mkdirSync(DOWNLOAD_DIR, { recursive: true });

    console.log(`${archive.name}: downloading ${human(archive.bytes)} from ${archive.url}`);

    const response = await fetch(archive.url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${archive.name}: HTTP ${response.status} ${response.statusText}`);
    }
    if (response.body === null) {
        throw new Error(`${archive.name}: empty response body`);
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));

    const size = statSync(dest).size;
    if (size !== archive.bytes) {
        throw new Error(`${archive.name}: expected ${archive.bytes} bytes, got ${size}`);
    }

    const got = await sha256(dest);
    if (got !== archive.sha256) {
        throw new Error(
            `${archive.name}: SHA-256 mismatch\n  expected ${archive.sha256}\n  got      ${got}\n` +
            `The mirror served something other than the release recorded in ASSETS.md.`
        );
    }

    console.log(`${archive.name}: verified ${archive.sha256.slice(0, 16)}...`);
    return dest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const force = process.argv.includes('--force');
    for (const archive of ARCHIVES) {
        await fetchOne(archive, force);
    }
    console.log('\nNext: node tools/extract-pk3.mjs');
}
