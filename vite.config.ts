/*
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { defineConfig, type Plugin } from 'vite';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
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
 * meep is proprietary and must never end up inside a committed or shipped
 * artefact (brief section 3). Marking it external is the mechanical enforcement
 * of that: even if someone later adds a build step, rollup cannot inline the
 * engine into the output. Anyone running this supplies their own licensed copy.
 *
 * The trailing-slash form covers the deep `@woosh/meep-engine/src/...` imports
 * that every call site uses -- the package has no root entry point.
 */
const MEEP_EXTERNAL = [/^@woosh\/meep-engine(\/.*)?$/];

export default defineConfig({
    plugins: [meepWorkerBundles()],

    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src'),
        },
    },

    server: {
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
