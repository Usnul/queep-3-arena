/*
 * host.ts -- `npm run host`.
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
 * A dedicated server, as a command line. Node runs this file's TypeScript
 * directly by stripping the types, which is why the pipeline's style rules
 * apply here too (D-016): no enums, no parameter properties, no decorators.
 *
 *   npm run host -- --map oa_dm1 --bots 4 --port 5300 --difficulty bring-it-on
 *
 * Then a browser joins with `?map=oa_dm1&join=ws://localhost:5300`.
 */

import { join } from 'node:path';

import { WsHost } from '../src/server/wsHost.ts';
import { DEFAULT_DIFFICULTY, DIFFICULTIES } from '../src/game/Difficulty.ts';
import { PROTOCOL_VERSION } from '../src/net/protocol.ts';

interface Args {
    map: string;
    bots: number;
    port: number;
    difficulty: string;
    seed: number;
    fragLimit: number;
}

function parse(argv: readonly string[]): Args {
    const args: Args = {
        map: 'oa_dm1',
        bots: 4,
        port: 5300,
        difficulty: DEFAULT_DIFFICULTY,
        seed: 0x5eed,
        fragLimit: 0,
    };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];

        switch (flag) {
            case '--map':
                args.map = value ?? args.map;
                i += 1;
                break;
            case '--bots':
                args.bots = Number(value ?? args.bots) | 0;
                i += 1;
                break;
            case '--port':
                args.port = Number(value ?? args.port) | 0;
                i += 1;
                break;
            case '--difficulty':
                args.difficulty = value ?? args.difficulty;
                i += 1;
                break;
            case '--seed':
                args.seed = Number(value ?? args.seed) | 0;
                i += 1;
                break;
            case '--fraglimit':
                args.fragLimit = Number(value ?? args.fragLimit) | 0;
                i += 1;
                break;
            case '--help':
            case '-h':
                usage();
                process.exit(0);
                break;
            default:
                if (flag !== undefined && flag.startsWith('--')) {
                    console.error(`unknown option ${flag}`);
                    usage();
                    process.exit(1);
                }
        }
    }

    const names = DIFFICULTIES.map((d) => d.id);
    if (!names.includes(args.difficulty as never)) {
        console.error(`unknown difficulty '${args.difficulty}'; one of ${names.join(', ')}`);
        process.exit(1);
    }

    return args;
}

function usage(): void {
    console.log(
        [
            `queep-3-arena host, protocol v${PROTOCOL_VERSION}`,
            '',
            '  npm run host -- [options]',
            '',
            '  --map <name>          level to host (default oa_dm1)',
            '  --bots <n>            bots to fill the map with (default 4)',
            '  --port <n>            WebSocket port (default 5300)',
            `  --difficulty <name>   ${DIFFICULTIES.map((d) => d.id).join(' | ')}`,
            '  --seed <n>            seeds every draw the simulation makes',
            '  --fraglimit <n>       0 for no limit',
            '',
            '  Join from a browser with ?map=<name>&join=ws://localhost:<port>',
        ].join('\n')
    );
}

const args = parse(process.argv.slice(2));

const wsHost = await WsHost.create({
    map: args.map,
    bots: args.bots,
    port: args.port,
    difficulty: args.difficulty,
    seed: args.seed,
    fragLimit: args.fragLimit,
    assetRoot: join(process.cwd(), 'assets', 'built'),
});

wsHost.start();

/*
 A clean exit matters here in a way it does not for the other tools: the port
 stays bound until the server closes, so a host killed with the socket open
 makes the next `npm run host` fail with EADDRINUSE, which reads as "the build
 is broken" rather than "the last one is still finishing".
*/
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        console.log('\nqueep host: shutting down');
        void wsHost.close().then(() => process.exit(0));
    });
}
