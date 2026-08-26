/*
 * fetch-material-model.mjs -- download the Cosmos DiffusionRenderer weights.
 *
 * Nothing here is committed: `assets/` is gitignored, and the weights are 31 GB
 * anyway. Provenance and licence for both files are in `ASSETS.md`.
 *
 * Usage:  node tools/fetch-material-model.mjs [--force] [--check]
 *
 * A sibling of `fetch-sources.mjs` and `fetch-assets.mjs` and deliberately not
 * folded into `npm run setup`. The two existing fetchers get you a playable
 * demo; this one gets you a 31 GB download and a CUDA GPU requirement, and is
 * only needed to *regenerate* the material maps rather than to run anything.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKPOINTS = join(ROOT, 'assets', 'ml', 'checkpoints');

/**
 * What to fetch, and how to know it arrived intact.
 *
 * The `md5` on the DiT is not this project's invention -- it is the digest
 * upstream publishes for that exact file in
 * `scripts/download_diffusion_renderer_checkpoints.py`, which is as close to a
 * pin as a Hugging Face `main` branch offers. A tokenizer file has no published
 * digest, so those are checked by size only and the size is recorded here from
 * the fetch that this pipeline was built against.
 */
export const FILES = [
    {
        repo: 'nvidia/Diffusion_Renderer_Inverse_Cosmos_7B',
        file: 'model.pt',
        bytes: 28940280602,
        md5: '77eb5beddf131bfc8235a300132f22e4',
    },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'autoencoder.jit', bytes: 212300573 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'decoder.jit', bytes: 126022330 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'encoder.jit', bytes: 86272108 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'mean_std.pt', bytes: 4290 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'image_mean_std.pt', bytes: 2370 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'config.json', bytes: 51 },
    { repo: 'nvidia/Cosmos-Tokenize1-CV8x8x8-720p', file: 'model_config.yaml', bytes: 92 },
];

function localPath(entry) {
    return join(CHECKPOINTS, entry.repo.split('/')[1], entry.file);
}

async function md5Of(path) {
    const hash = createHash('md5');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

/**
 * Is what is on disk the file that was asked for?
 *
 * Size first, because it is instant and catches the interrupted download, which
 * is the failure this actually sees. The digest is only computed when one is
 * published and the size already matched, since hashing 29 GB takes about a
 * minute and is pure waste on a file that is visibly truncated.
 */
async function verify(entry, { deep }) {
    const path = localPath(entry);
    if (!existsSync(path)) return 'missing';

    const size = statSync(path).size;
    if (size !== entry.bytes) return `${size} bytes, expected ${entry.bytes}`;

    if (deep && entry.md5 !== undefined) {
        const digest = await md5Of(path);
        if (digest !== entry.md5) return `md5 ${digest}, expected ${entry.md5}`;
    }

    return null;
}

async function fetchOne(entry, force) {
    const path = localPath(entry);
    const label = `${entry.repo.split('/')[1]}/${entry.file}`;

    if (!force) {
        const problem = await verify(entry, { deep: false });
        if (problem === null) {
            console.log(`${label}: already present`);
            return;
        }
        if (problem !== 'missing') console.log(`${label}: ${problem}, re-fetching`);
    }

    mkdirSync(dirname(path), { recursive: true });

    const url = `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`;
    console.log(`${label}: downloading ${(entry.bytes / 1e9).toFixed(2)} GB`);

    const response = await fetch(url);
    if (!response.ok || response.body === null) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    // Written to a temporary name and moved, so an interrupted run leaves no file
    // that the size check would have to catch on the next one.
    const partial = `${path}.partial`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rm(path, { force: true });
    const { rename } = await import('node:fs/promises');
    await rename(partial, path);

    const problem = await verify(entry, { deep: true });
    if (problem !== null) throw new Error(`${label}: ${problem}`);

    console.log(`${label}: ok`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const force = process.argv.includes('--force');
    const checkOnly = process.argv.includes('--check');

    let bad = 0;
    for (const entry of FILES) {
        if (checkOnly) {
            const problem = await verify(entry, { deep: true });
            const label = `${entry.repo.split('/')[1]}/${entry.file}`;
            if (problem !== null) {
                console.error(`${label}: ${problem}`);
                bad += 1;
            } else {
                console.log(`${label}: ok`);
            }
        } else {
            await fetchOne(entry, force);
        }
    }

    if (bad > 0) process.exit(1);
}
