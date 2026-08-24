/*
 * extract-pk3.mjs -- flatten the OpenArena pk3 archives into a virtual filesystem.
 *
 * A pk3 is a zip. Q3 mounts several of them and resolves a virtual path by
 * scanning them in *reverse alphabetical* order, so `pak6-patch088.pk3` shadows
 * `pak6-patch085.pk3` shadows `pak4-textures.pk3` and so on. Reproducing that
 * ordering is not optional: get it backwards and you render 0.8.1-era textures on
 * 0.8.8 maps, which looks exactly like a conversion bug and is not one.
 *
 * Output:
 *   assets/extracted/<virtual/path>     the winning copy of every file
 *   assets/extracted/manifest.json      which pk3 each survivor came from, and
 *                                       what it shadowed
 *
 * Usage:  node tools/extract-pk3.mjs [--force] [--only <glob-ish prefix>]
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 * The archives it reads are Copyright (C) the OpenArena contributors; see
 * ASSETS.md.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'assets', 'download', 'openarena-0.8.8.zip');
const OUT = join(ROOT, 'assets', 'extracted');

/**
 * pk3s to mount, in Q3 load order (later entries win).
 *
 * `pak2-players-mature.pk3` and `missionpack/mp-pak0.pk3` are deliberately not
 * mounted -- see ASSETS.md.
 */
const PK3_LOAD_ORDER = [
    'openarena-0.8.8/baseoa/pak0.pk3',
    'openarena-0.8.8/baseoa/pak1-maps.pk3',
    'openarena-0.8.8/baseoa/pak2-players.pk3',
    'openarena-0.8.8/baseoa/pak4-textures.pk3',
    'openarena-0.8.8/baseoa/pak5-TA.pk3',
    'openarena-0.8.8/baseoa/pak6-misc.pk3',
    'openarena-0.8.8/baseoa/pak6-patch085.pk3',
    'openarena-0.8.8/baseoa/pak6-patch088.pk3',
];

/* ------------------------------------------------------------------ *
 * Minimal zip reader.
 *
 * Node has no zip support and the archives are nested (a zip of pk3s, each
 * itself a zip), so both levels are read from memory rather than shelling out
 * twice. Only the two compression methods Q3 tooling ever produced are handled:
 * 0 (stored) and 8 (deflate).
 * ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;

/**
 * @param {Buffer} buf
 * @returns {{name:string, method:number, compressedSize:number, size:number, localOffset:number}[]}
 */
function readCentralDirectory(buf) {
    // The end-of-central-directory record is at the tail, after a comment of up
    // to 64 KiB, so it has to be found by scanning backwards for the signature.
    let eocd = -1;
    const scanFrom = Math.max(0, buf.length - 66_000);
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record');

    let entryCount = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64: pak2-players.pk3 and friends are comfortably under 4 GiB, but the
    // outer archive uses ZIP64 fields on some mirrors, and a 0xFFFFFFFF sentinel
    // silently read as a real offset produces gibberish rather than an error.
    if (cdOffset === 0xffffffff || entryCount === 0xffff) {
        const locator = eocd - 20;
        if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
            const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
            if (buf.readUInt32LE(eocd64) !== EOCD64_SIG) {
                throw new Error('zip64 locator points at a non-zip64 record');
            }
            entryCount = Number(buf.readBigUInt64LE(eocd64 + 32));
            cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
        }
    }

    const entries = [];
    let p = cdOffset;

    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(p) !== CDH_SIG) {
            throw new Error(`central directory entry ${i} has a bad signature`);
        }

        const method = buf.readUInt16LE(p + 10);
        let compressedSize = buf.readUInt32LE(p + 20);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        let localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

        // ZIP64 extended information extra field, if any of the three fields
        // above is the 0xFFFFFFFF sentinel.
        if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
            let e = p + 46 + nameLen;
            const end = e + extraLen;
            while (e + 4 <= end) {
                const tag = buf.readUInt16LE(e);
                const len = buf.readUInt16LE(e + 2);
                if (tag === 0x0001) {
                    let q = e + 4;
                    if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
                    if (compressedSize === 0xffffffff) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
                    if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); }
                    break;
                }
                e += 4 + len;
            }
        }

        entries.push({ name, method, compressedSize, size, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

/**
 * @param {Buffer} buf whole archive
 * @param {{method:number, compressedSize:number, size:number, localOffset:number, name:string}} entry
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
    // The local file header repeats the name and extra-field lengths, and those
    // can differ from the central directory's, so the data offset must be
    // computed from the local header rather than assumed.
    const lh = entry.localOffset;
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);

    throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

/* ------------------------------------------------------------------ */

function normalise(name) {
    // Q3 paths are case-insensitive and backslash-tolerant. Lowercasing here is
    // what makes a `.shader` script that says `textures/Base_Floor/x` find a file
    // stored as `textures/base_floor/x.tga`.
    return name.replace(/\\/g, '/').toLowerCase();
}

function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const onlyIdx = args.indexOf('--only');
    const only = onlyIdx === -1 ? null : args[onlyIdx + 1];

    if (!existsSync(ARCHIVE)) {
        console.error(`missing ${ARCHIVE}\nrun: node tools/fetch-assets.mjs`);
        process.exit(2);
    }

    if (existsSync(OUT) && !force) {
        const manifestPath = join(OUT, 'manifest.json');
        if (existsSync(manifestPath)) {
            const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
            console.log(`already extracted: ${m.fileCount} files (--force to redo)`);
            return;
        }
    }

    if (force && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });

    console.log(`reading ${ARCHIVE}`);
    const outer = readFileSync(ARCHIVE);
    const outerEntries = readCentralDirectory(outer);

    /** virtual path -> { pk3, size, shadowed: string[] } */
    const winners = new Map();
    /** virtual path -> Buffer */
    const contents = new Map();

    for (const pk3Path of PK3_LOAD_ORDER) {
        const entry = outerEntries.find((e) => e.name === pk3Path);
        if (entry === undefined) {
            throw new Error(`archive does not contain ${pk3Path}`);
        }

        const pk3 = readEntry(outer, entry);
        const inner = readCentralDirectory(pk3);
        const pk3Name = pk3Path.split('/').pop();

        let added = 0;
        let shadowed = 0;

        for (const file of inner) {
            if (file.name.endsWith('/')) continue;

            const vpath = normalise(file.name);
            if (only !== null && !vpath.startsWith(only)) continue;

            const prior = winners.get(vpath);
            if (prior !== undefined) {
                prior.shadowed.push(prior.pk3);
                prior.pk3 = pk3Name;
                prior.size = file.size;
                shadowed += 1;
            } else {
                winners.set(vpath, { pk3: pk3Name, size: file.size, shadowed: [] });
                added += 1;
            }

            contents.set(vpath, readEntry(pk3, file));
        }

        console.log(`  ${pk3Name}: ${added} new, ${shadowed} overriding`);
    }

    console.log(`writing ${winners.size} files to assets/extracted/`);

    for (const [vpath, data] of contents) {
        const dest = join(OUT, vpath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
    }

    // Q3 has no directory listing at runtime and neither does a browser, so the
    // manifest is what stands in for `trap_FS_GetFileList` later on.
    const byExtension = Object.create(null);
    for (const vpath of winners.keys()) {
        const ext = vpath.includes('.') ? vpath.slice(vpath.lastIndexOf('.')) : '(none)';
        byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }

    writeFileSync(
        join(OUT, 'manifest.json'),
        JSON.stringify(
            {
                source: 'openarena-0.8.8.zip',
                loadOrder: PK3_LOAD_ORDER,
                fileCount: winners.size,
                byExtension,
                files: Object.fromEntries(
                    [...winners.entries()].map(([k, v]) => [
                        k,
                        v.shadowed.length === 0 ? v.pk3 : { pk3: v.pk3, shadowed: v.shadowed },
                    ])
                ),
            },
            null,
            1
        )
    );

    const top = Object.entries(byExtension).sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('\nby extension:');
    for (const [ext, n] of top) console.log(`  ${ext.padEnd(8)} ${n}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
