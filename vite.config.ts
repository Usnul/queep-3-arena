/*
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { defineConfig, type Plugin } from 'vite';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * meep spawns two workers by building a blob that `importScripts()` a *bare,
 * root-relative* filename:
 *
 *   ThreadedImageDecoder  -> '/bundle-worker-image-decoder.js'
 *   makeTerrainWorkerProxy -> '/bundle-worker-terrain.js'
 *
 * Those files ship in `@woosh/meep-engine/build/`, which is not the web root, so
 * out of the box both fail with `NetworkError: Failed to execute 'importScripts'`.
 * The image decoder degrades to a main-thread codec; the terrain worker does not
 * degrade and rejects.
 *
 * Serving them from node_modules rather than copying them into `public/` is
 * deliberate: `public/` is inside the repository, and meep must never end up in a
 * committed artefact (brief section 3, D-002). See GAP-004.
 */
function meepWorkerBundles(): Plugin {
    const require = createRequire(import.meta.url);

    // Resolving through `.../package.json` -- the usual way to find a package root
    // -- does not work here: meep's `exports` map has no `./package.json` entry, so
    // Node answers ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve one of the bundles
    // instead and take its directory.
    const buildDir = dirname(
        require.resolve('@woosh/meep-engine/build/bundle-worker-terrain.js')
    );

    const SERVED = new Set([
        '/bundle-worker-image-decoder.js',
        '/bundle-worker-terrain.js',
    ]);

    return {
        name: 'queep:meep-worker-bundles',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? '').split('?')[0];

                if (!SERVED.has(url)) {
                    next();
                    return;
                }

                res.setHeader('Content-Type', 'text/javascript');
                // The worker is a blob: URL, a different origin from the page, and
                // the dev server sets COEP: require-corp. Without CORP the browser
                // blocks the script before it ever runs.
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
                createReadStream(resolve(buildDir, `.${url}`)).pipe(res);
            });
        },
    };
}

/**
 * Dev-only: `POST /__shot/<name>` with a PNG data URL body writes
 * `assets/shots/<name>.png`.
 *
 * The renderer's output is the only way to tell a correct conversion from a
 * plausible-looking wrong one, and reading pixels back through a headless
 * automation channel a few bytes at a time is not a way to look at a level. This
 * is the smallest thing that gets a frame onto disk. It exists only in the dev
 * server; there is no production build.
 */
function screenshotSink(): Plugin {
    return {
        name: 'queep:screenshot-sink',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? '').split('?')[0] ?? '';

                if (req.method !== 'POST' || !url.startsWith('/__shot/')) {
                    next();
                    return;
                }

                const name = url.slice('/__shot/'.length).replace(/[^a-z0-9_.-]/gi, '_');
                const chunks: Buffer[] = [];

                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const comma = body.indexOf(',');
                    const dir = resolve(import.meta.dirname, 'assets', 'shots');

                    mkdirSync(dir, { recursive: true });
                    writeFileSync(
                        resolve(dir, `${name}.png`),
                        Buffer.from(body.slice(comma + 1), 'base64')
                    );

                    res.statusCode = 200;
                    res.end(`assets/shots/${name}.png`);
                });
            });
        },
    };
}

interface EnginePatch {
    /** Substring of the module id this applies to. */
    readonly file: string;
    /** What to look for, LF-normalised. */
    readonly find: string;
    readonly replace: string;
    /**
     * How many sites carry the bug in the version this was written against.
     *
     * **Zero matches means meep has fixed it, and is not an error** -- the
     * dependency moves under this repository (3.5.0 to 3.6.0 mid-session, which
     * is how the first entry below became a no-op). Any *other* count is: a
     * patch that half-applies has found code it does not understand, and
     * rewriting it would be worse than not.
     */
    readonly sites: number;
    /** For the log line, and for the error when it half-matches. */
    readonly what: string;
    /** meep versions known to carry the bug, for the report. */
    readonly broken_in: string;
}

const MEEP_PATCHES: readonly EnginePatch[] = [
    /*
     `StaticSceneBVH.raycast_nearest` and `.raycast` call
     `bvh_query_user_data_ray` with their argument pairs swapped.

     The function is `(result, result_offset, bvh, root, ...)`, which is what the
     two callers in `core/` pass; both callers here pass
     `(bvh, bvh.root, result, 0, ...)`. So `bvh` binds to a plain `[]`, its
     `__data_float32` is undefined, and the first AABB test reads `undefined[0]`.
     Every scene with geometry in it throws.
    */
    {
        file: 'shade/renderer/scene/bvh/StaticSceneBVH.js',
        what: 'StaticSceneBVH argument order',
        broken_in: '3.5.0; fixed in 3.6.0',
        sites: 2,
        find: `bvh_query_user_data_ray(
            bvh,
            bvh.root,
            scratch_instance_hits,
            0,`,
        replace: `bvh_query_user_data_ray(
            scratch_instance_hits,
            0,
            bvh,
            bvh.root,`,
    },

    /*
     `brick4_bake_basic` records two compute passes over one buffer and hands the
     second the *pre-write* handle, so the frame graph's validator rejects the
     graph it just recorded:

       Pass 1 'Brick4 / Resolve probes' reads version 0 of 'encoded probe data',
       which pass 0 'Brick4 / Bake probes' has already superseded with version 1.

     `graph_compute_pass` returns the outputs it produced, named after the
     shader's own resources, and that is the handle the read has to name. The
     bytes were always right -- both handles are the same buffer, which is what
     the message means by "the read returns the newer contents" -- so this is
     the dependency edge being undeclared rather than a wrong result.
    */
    {
        file: 'brick4/gpu/bake/brick4_bake_basic.js',
        what: 'brick4 bake pass dependency',
        broken_in: '3.5.0, 3.6.0',
        sites: 1,
        find: `        graph_compute_pass({
            graph,
            shader: shader_brick4_bake_probes,`,
        replace: `        const bake_pass_outputs = graph_compute_pass({
            graph,
            shader: shader_brick4_bake_probes,`,
    },
    {
        file: 'brick4/gpu/bake/brick4_bake_basic.js',
        what: 'brick4 resolve pass input',
        broken_in: '3.5.0, 3.6.0',
        sites: 1,
        find: `                input: gr_cycle_trace_data,`,
        replace: `                input: bake_pass_outputs.output,`,
    },
];

/**
 * meep cannot bake a volumetric lightmap without this. Two independent defects
 * sit on the only code path that produces one, so `brick4_bake_for_scene` --
 * the engine's own documented entry point -- throws on any scene at all. Each
 * patch above says what it is and why, and REPORT.md's engine-bug section has
 * both written up.
 *
 * **A patch that finds nothing to fix is a patch that has been fixed upstream**,
 * and is skipped rather than treated as a failure. The `StaticSceneBVH` entry
 * became a no-op mid-session when the dependency moved from 3.5.0 to 3.6.0
 * under this repository, which is exactly the case worth handling quietly. A
 * patch matching *some* of its sites is a different thing: it has found code it
 * no longer understands, and rewriting that would be worse than not, so it
 * throws.
 *
 * This is a **dev-server source transform**, not an edit to `node_modules` and
 * not a copy of meep into the repository: it rewrites a few lines on the way to
 * the browser, and nothing of the engine is committed but the fragments it
 * matches on. Delete an entry once its `broken_in` no longer includes any
 * version this project builds against.
 */
function meepBakePathFixes(): Plugin {
    return {
        name: 'queep:meep-bake-path-fixes',
        enforce: 'pre',
        transform(code, id) {
            const applicable = MEEP_PATCHES.filter((p) => id.includes(p.file));

            if (applicable.length === 0) return null;

            /*
             meep ships these files with CRLF endings, and a pattern written
             with bare newlines matches nothing in them -- which the guard below
             would report as "meep has fixed it", the one wrong conclusion
             available. Normalising is cheaper than escaping every line break,
             and LF-only source is what the browser gets either way.
            */
            let source = code.split('\r\n').join('\n');

            for (const patch of applicable) {
                const sites = source.split(patch.find).length - 1;

                if (sites === 0) {
                    // fixed upstream, or moved out from under the pattern; either
                    // way there is nothing here to rewrite. See `sites`.
                    continue;
                }

                if (sites !== patch.sites) {
                    throw new Error(
                        `queep: the '${patch.what}' patch matched ${sites} of its ${patch.sites} ` +
                        `sites (broken in meep ${patch.broken_in}). A partial match means the ` +
                        `code has changed shape; re-read it before re-applying, and remove the ` +
                        `entry from MEEP_PATCHES in vite.config.ts if meep has fixed it.`
                    );
                }

                source = source.split(patch.find).join(patch.replace);
            }

            return { code: source, map: null };
        },
    };
}

/**
 * Dev-only: `POST /__bake/<map>/<file>` writes `assets/built/<map>/<file>` from
 * the raw request body.
 *
 * The acoustic probe bake is a Node tool because it is arithmetic over brush
 * geometry. The volumetric lightmap bake cannot be: `brick4_bake_basic` is a
 * compute shader, so it runs in the browser, against the live renderer, and its
 * output has to get from there onto disk. meep's own `brick4_bake_for_scene`
 * ends in `downloadAsFile`, which is right for one scene in a console and wrong
 * for six maps in a row.
 *
 * Deliberately narrower than `screenshotSink`: it writes only into an existing
 * `assets/built/<map>/` and only under a sanitised name, so a stray POST cannot
 * create a tree or climb out of one. Dev server only; there is no production
 * build.
 */
function lightmapSink(): Plugin {
    return {
        name: 'queep:lightmap-sink',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? '').split('?')[0] ?? '';

                if (req.method !== 'POST' || !url.startsWith('/__bake/')) {
                    next();
                    return;
                }

                const parts = url
                    .slice('/__bake/'.length)
                    .split('/')
                    .map((p) => p.replace(/[^a-z0-9_.-]/gi, '_'));

                if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
                    res.statusCode = 400;
                    res.end('expected /__bake/<map>/<file>');
                    return;
                }

                const dir = resolve(import.meta.dirname, 'assets', 'built', parts[0]!);

                // The map has to have been converted already. Writing into a
                // directory that does not exist would put a lightmap somewhere
                // nothing will ever look for it.
                if (!existsSync(dir)) {
                    res.statusCode = 404;
                    res.end(`no such built map: ${parts[0]}`);
                    return;
                }

                const chunks: Buffer[] = [];

                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    const body = Buffer.concat(chunks);
                    const out = resolve(dir, parts[1]!);

                    writeFileSync(out, body);

                    res.statusCode = 200;
                    res.end(`assets/built/${parts[0]}/${parts[1]} (${body.byteLength} bytes)`);
                });
            });
        },
    };
}

/**
 * meep is proprietary and must never end up inside a committed or shipped
 * artefact (brief section 3). Marking it external is the mechanical enforcement
 * of that: even if someone later adds a build step, rollup cannot inline the
 * engine into the output. Anyone running this supplies their own licensed copy.
 *
 * The trailing-slash form covers the deep `@woosh/meep-engine/src/...` imports
 * that every call site uses -- the package has no root entry point.
 */
const MEEP_EXTERNAL = [/^@woosh\/meep-engine(\/.*)?$/];

/**
 * Which meep a GPU capture was recorded against.
 *
 * `GPUProfileMeta.engine_version` exists because a timing is meaningless without
 * the build that produced it, and the engine populates none of its own metadata
 * -- there is no version constant to import, and meep's `exports` map has no
 * `./package.json` entry, so nothing in the browser can read one at runtime
 * either. Resolving it here, once, is what keeps the string in a capture from
 * drifting away from the package that actually produced it.
 *
 * The same two-step as `meepWorkerBundles`: resolve a path the `exports` map
 * does publish, then walk up out of `build/` to the package root.
 */
function meepVersion(): string {
    const require = createRequire(import.meta.url);

    const root = dirname(
        dirname(require.resolve('@woosh/meep-engine/build/bundle-worker-terrain.js'))
    );

    try {
        const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
        const version = (manifest as { version?: unknown }).version;

        return typeof version === 'string' ? version : '';
    } catch {
        /*
         An empty string is what `GPUProfileMeta` already defaults the field to,
         and a capture that cannot name its engine is worth more than a dev
         server that will not start. Nothing else reads this.
        */
        return '';
    }
}

export default defineConfig({
    plugins: [
        meepWorkerBundles(),
        meepBakePathFixes(),
        screenshotSink(),
        lightmapSink(),
    ],

    define: {
        // Read by `main.ts` and written into every GPU capture. See `meepVersion`.
        __MEEP_VERSION__: JSON.stringify(meepVersion()),
    },

    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src'),
        },
    },

    server: {
        // `.claude/launch.json` declares this port, and the Browser pane opens a
        // tab at it before the server has said anything; on Vite's default 5173
        // the tab lands on nothing, or on another project entirely. Declared here
        // so the two agree.
        //
        // Deliberately not `strictPort`: several sessions run against this
        // worktree at once, and the second one to start should step to 5200 rather
        // than refuse to boot. When it does, the pane's tab is wrong again and
        // `preview_logs` has the real port -- that is the cost of sharing a
        // worktree, and not something a fixed port can fix.
        port: 5199,

        // WebGPU and the SharedArrayBuffer paths meep's workers use both want a
        // cross-origin-isolated context.
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        fs: {
            // `assets/built/` is produced by the pipeline and lives outside `public/`
            // because it is large, gitignored, and regenerated.
            allow: ['..'],
        },
    },

    optimizeDeps: {
        // Pre-bundling ~6000 fine-grained modules costs more than it saves, and it
        // fights the externalisation above.
        exclude: ['@woosh/meep-engine'],

        // ...but excluding meep also stops Vite's dependency scanner from walking
        // into it, so it never discovers meep's own CommonJS dependencies. Both of
        // these are UMD bundles that need pre-bundling for named/default interop:
        // without this, `import Stats from "stats.js"` at the top of
        // `EngineHarness.js` throws
        //   "does not provide an export named 'default'"
        // and the whole engine fails to evaluate. See GAP-003.
        include: ['stats.js', 'dat.gui', 'pako', 'opentype.js'],
    },

    build: {
        rollupOptions: {
            external: MEEP_EXTERNAL,
        },
    },
});
