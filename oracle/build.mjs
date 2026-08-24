/*
 * build.mjs -- compile the pmove oracle to WebAssembly.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 *
 * ---
 *
 * Sources are OpenArena's `bg_pmove.c` / `bg_slidemove.c` and ioquake3's
 * `cm_*`, compiled **unmodified** from the pinned clones in `.refs/`. The only
 * new C is `oracle.c` (entry points) and `shim.c` (the twelve engine functions
 * the collision model calls).
 *
 * Output is `oracle/build/oracle.mjs` + `.wasm`, an ES module Vitest imports
 * directly -- no subprocess, no serialisation format to keep in sync.
 *
 * Usage:  node oracle/build.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REFS = join(ROOT, '.refs');
const OUT_DIR = join(HERE, 'build');

const EMCC = join(REFS, 'emsdk', 'upstream', 'emscripten', 'emcc.exe');
const EMCC_POSIX = join(REFS, 'emsdk', 'upstream', 'emscripten', 'emcc');

const OA_GAME = join(REFS, 'oa-gamecode', 'code', 'game');
const IOQ3_COMMON = join(REFS, 'ioq3', 'code', 'qcommon');

/**
 * Translation units.
 *
 * `bg_pmove.c` and `bg_slidemove.c` are OpenArena's, because that is what the
 * TypeScript port is a port of -- OA's differs from ioquake3's by more than
 * formatting (`pm_wadeScale`, `pm_swimFastScale`, and the `pmove_float` /
 * `pmove_flags` additions to `pmove_t`).
 *
 * `q_math.c` and `q_shared.c` are OA's for the same reason: `bg_pmove` calls
 * into them and a difference in, say, `AngleNormalize180` would be a difference
 * in movement.
 *
 * `cm_*` are ioquake3's, per the brief -- OA does not ship engine code.
 */
const SOURCES = [
    join(HERE, 'oracle.c'),
    join(HERE, 'shim.c'),

    join(OA_GAME, 'bg_pmove.c'),
    join(OA_GAME, 'bg_slidemove.c'),
    // `bg_misc.c` for `BG_AddPredictableEventToPlayerstate` and `bg_itemlist`,
    // both of which pmove references directly.
    join(OA_GAME, 'bg_misc.c'),
    join(REFS, 'oa-gamecode', 'code', 'qcommon', 'q_math.c'),
    // String helpers (`Q_strncpyz` and friends) that cm_load.c calls.
    join(REFS, 'oa-gamecode', 'code', 'qcommon', 'q_shared.c'),

    join(IOQ3_COMMON, 'cm_load.c'),
    join(IOQ3_COMMON, 'cm_trace.c'),
    join(IOQ3_COMMON, 'cm_patch.c'),
    join(IOQ3_COMMON, 'cm_polylib.c'),
    join(IOQ3_COMMON, 'cm_test.c'),
];

const EXPORTED = [
    '_oracle_load_bsp',
    '_oracle_num_inline_models',
    '_oracle_box_trace',
    '_oracle_point_contents',
    '_oracle_ps_ptr',
    '_oracle_cmd_ptr',
    '_oracle_ps_size',
    '_oracle_cmd_size',
    '_oracle_offsets',
    '_oracle_offset_count',
    '_oracle_reset',
    '_oracle_pmove',
    '_oracle_pm_results',
    '_oracle_update_view_angles',
    '_malloc',
    '_free',
];

function emccPath() {
    if (existsSync(EMCC)) return EMCC;
    if (existsSync(EMCC_POSIX)) return EMCC_POSIX;
    throw new Error(
        `emcc not found under ${join(REFS, 'emsdk')}\n` +
        `Install it with:\n` +
        `  git clone --depth 1 https://github.com/emscripten-core/emsdk .refs/emsdk\n` +
        `  cd .refs/emsdk && python emsdk.py install latest && python emsdk.py activate latest`
    );
}

function main() {
    for (const src of SOURCES) {
        if (!existsSync(src)) {
            throw new Error(`missing source ${src}\nrun: node tools/fetch-sources.mjs`);
        }
    }

    mkdirSync(OUT_DIR, { recursive: true });

    const args = [
        ...SOURCES,
        '-o', join(OUT_DIR, 'oracle.mjs'),

        /*
         -O1 rather than -O2. The oracle's value is that it is a faithful
         execution of the C, and aggressive float optimisation is the one thing
         that could make it *stop* being that. -ffp-contract=off for the same
         reason: fusing a multiply-add changes the rounding of exactly the dot
         products that decide which plane a trace reports.
        */
        '-O1',
        '-ffp-contract=off',
        '-fno-fast-math',

        /*
         Q3_VM and BOTLIB are tested with `#ifdef`, not `#if`, so defining either
         to 0 still selects the QVM code path -- which pulls in `bg_lib.h` and
         redefines `size_t`, `va_list` and `intptr_t` against the real libc. They
         must be left undefined entirely.
        */
        '-DDEDICATED=1',

        /*
         NDEBUG selects the release forms of `Hunk_Alloc` and `Z_Malloc`. Under a
         debug build q_shared.h and qcommon.h rewrite both into `*Debug` variants
         taking file/line, which the shim would then have to mirror for no
         benefit. It also disables `assert`, matching a shipped engine build --
         the oracle is meant to be what the game does, not what a developer build
         does.
        */
        '-DNDEBUG',

        /*
         OpenArena's `q_platform.h` predates WebAssembly and `#error`s out on an
         unrecognised platform. ioquake3's has an `__EMSCRIPTEN__` block; OA's
         does not. Supplying the same six macros on the command line satisfies
         OA's guards without editing its source -- which is the property that
         makes this an oracle rather than a second implementation.
        */
        '-DOS_STRING="emscripten"',
        '-DARCH_STRING="wasm32"',
        '-DID_INLINE=inline',
        "-DPATH_SEP='/'",
        '-DDLL_EXT=".wasm"',
        '-DQ3_LITTLE_ENDIAN',

        '-Wno-implicit-function-declaration',
        '-Wno-incompatible-pointer-types',
        '-Wno-int-conversion',

        '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_ES6=1',
        '-s', `EXPORTED_FUNCTIONS=${JSON.stringify(EXPORTED)}`,
        '-s', "EXPORTED_RUNTIME_METHODS=['HEAPF32','HEAP32','HEAPU8','HEAPU32']",
        '-s', 'ALLOW_MEMORY_GROWTH=1',
        '-s', 'INITIAL_MEMORY=134217728',
        '-s', 'ENVIRONMENT=node,web',
        '-s', 'ASSERTIONS=1',
    ];

    console.log(`emcc: ${SOURCES.length} translation units -> oracle/build/oracle.mjs`);

    execFileSync(emccPath(), args, { stdio: 'inherit', cwd: HERE });

    console.log('oracle built');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
