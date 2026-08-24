/*
 * fetch-sources.mjs -- clone the reference C sources at pinned commits.
 *
 * Nothing here is committed to this repo: `.refs/` is gitignored. The clones are
 * read-only reference material for the port and the build input for the pmove
 * oracle (see oracle/).
 *
 * Usage:  node tools/fetch-sources.mjs [--force]
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFS = join(ROOT, '.refs');

/**
 * Pinned by commit, not by tag or branch. Both projects still receive commits;
 * an unpinned clone would silently change the balance numbers under the port
 * and the oracle under the movement tests.
 */
export const SOURCES = [
    {
        name: 'oa-gamecode',
        url: 'https://github.com/OpenArena/gamecode.git',
        // 2025-12-20 "fixed the shotgun smoke puff not appearing in anything BUT water"
        commit: '5478aad23b12857d265103f6aa2f5258c78799c8',
        why: 'Gameplay source of truth: balance tables, entity definitions, bg_pmove.c.',
        licence: 'GPL-2.0-only (id Software / OpenArena contributors)',
    },
    {
        name: 'ioq3',
        url: 'https://github.com/ioquake/ioq3.git',
        // 2026-07-19 "Read and write CD key in lowercase"
        commit: '588393618dbc82e7207c21c6ddecca229944a03a',
        why: 'Engine reference for cm_* collision, and the C sources the pmove oracle is built from.',
        licence: 'GPL-2.0-only (id Software / ioquake3 contributors)',
    },
];

function git(args, cwd) {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function fetchOne(src, force) {
    const dir = join(REFS, src.name);

    if (existsSync(dir)) {
        if (!force) {
            let head = '';
            try {
                head = git(['rev-parse', 'HEAD'], dir);
            } catch { /* not a git dir */ }

            if (head === src.commit) {
                console.log(`${src.name}: already at ${src.commit.slice(0, 10)}`);
                return;
            }

            // Present but on the wrong commit -- try to move it before re-cloning.
            try {
                git(['fetch', '--depth', '200', 'origin', src.commit], dir);
                git(['checkout', '--detach', src.commit], dir);
                console.log(`${src.name}: moved to ${src.commit.slice(0, 10)}`);
                return;
            } catch {
                console.log(`${src.name}: could not move to pin, re-cloning`);
            }
        }
        rmSync(dir, { recursive: true, force: true });
    }

    mkdirSync(REFS, { recursive: true });

    console.log(`${src.name}: cloning ${src.url}`);
    git(['clone', '--depth', '200', '--filter=blob:none', src.url, dir], REFS);

    try {
        git(['checkout', '--detach', src.commit], dir);
    } catch {
        // Pin is older than the shallow window -- deepen and retry.
        git(['fetch', '--unshallow'], dir);
        git(['checkout', '--detach', src.commit], dir);
    }

    console.log(`${src.name}: at ${src.commit.slice(0, 10)}`);
}

// `pathToFileURL` rather than string-building: on Windows `process.argv[1]` is
// `H:\git\...`, whose file URL is `file:///H:/git/...` -- three slashes and a drive
// letter that a naive template literal gets wrong, silently turning this script
// into a no-op.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const force = process.argv.includes('--force');
    for (const src of SOURCES) fetchOne(src, force);
}
