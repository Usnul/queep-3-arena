/*
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        // The differential suites run thousands of traces through both a WASM
        // module and the port; the default 5s timeout is not enough and a
        // timeout here would read as a failure rather than as slowness.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
});
