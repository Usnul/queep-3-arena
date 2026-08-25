/*
 * trap-matrix.mjs -- mechanically derive the Q3 syscall coverage matrix.
 *
 * Greps every `trap_*` identifier out of the OpenArena gamecode (game/, cgame/,
 * ui/, q3_ui/), joins it against tools/trap-classification.json, and emits the
 * markdown table that lives in REPORT.md section 2.
 *
 * Running it is the check that the matrix is complete: any syscall the gamecode
 * uses that the classification file does not mention is reported as UNCLASSIFIED
 * and exits non-zero.
 *
 * Usage:  node tools/trap-matrix.mjs [--check] [--out REPORT_SECTION.md]
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 * The source it reads is Copyright (C) 1999-2005 Id Software, Inc. and the
 * OpenArena contributors, released under the GNU General Public License v2.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GAMECODE = join(ROOT, '.refs', 'oa-gamecode', 'code');

/** Modules whose trap_ usage we care about. */
const MODULES = ['game', 'cgame', 'ui', 'q3_ui'];

const TRAP_RE = /\btrap_[A-Za-z0-9_]+/g;

/** @returns {string[]} every .c/.h path under `dir` */
function sources(dir) {
    const out = [];
    const walk = (d) => {
        let entries;
        try {
            entries = readdirSync(d);
        } catch {
            return;
        }
        for (const e of entries) {
            const p = join(d, e);
            if (statSync(p).isDirectory()) walk(p);
            else if (e.endsWith('.c') || e.endsWith('.h')) out.push(p);
        }
    };
    walk(dir);
    return out;
}

/** @returns {Map<string, {count:number, modules:Set<string>}>} */
function collect() {
    /** @type {Map<string, {count:number, modules:Set<string>}>} */
    const traps = new Map();

    for (const mod of MODULES) {
        for (const file of sources(join(GAMECODE, mod))) {
            const text = readFileSync(file, 'utf8');
            const found = text.match(TRAP_RE);
            if (found === null) continue;
            for (const name of found) {
                let rec = traps.get(name);
                if (rec === undefined) {
                    rec = { count: 0, modules: new Set() };
                    traps.set(name, rec);
                }
                rec.count += 1;
                rec.modules.add(mod);
            }
        }
    }

    return traps;
}

function classify(name, spec) {
    const explicit = spec.entries[name];
    if (explicit !== undefined) return explicit;

    for (const rule of spec.prefixRules) {
        if (name.startsWith(rule.prefix)) {
            return { status: rule.status, meep: rule.meep, note: rule.note, viaPrefix: rule.prefix };
        }
    }

    return null;
}

const STATUS_LABEL = {
    'mapped': 'mapped',
    'hybrid': 'hybrid',
    'ported': 'ported',
    'workaround': 'workaround',
    'gap': 'GAP',
    'not-needed': 'not needed',
};

/**
 * Dispositions that assert something was *built*, and therefore have to name
 * where.
 *
 * This is the phase 6 audit rule, and it exists because the matrix drifted:
 * four sound syscalls were marked `mapped` against a component the port never
 * constructed (D-066). A note that describes an intended design reads exactly
 * like one that describes a shipped one, so the note is no longer the evidence.
 * A path in this repository is, because a path can be checked.
 */
const MUST_CITE = new Set(['ported', 'hybrid', 'workaround']);

/**
 * Verify every `evidence` citation resolves.
 *
 * Format is `path::token`; the token must appear literally in the file. A bare
 * `path::` asserts only that the file exists, which is right for a whole-file
 * citation such as an offline converter.
 *
 * @returns {string[]} human-readable failures
 */
function checkEvidence(spec) {
    const problems = [];

    for (const [name, entry] of Object.entries(spec.entries)) {
        const evidence = entry.evidence ?? [];

        if (MUST_CITE.has(entry.status) && evidence.length === 0) {
            problems.push(`${name}: status '${entry.status}' asserts shipped code and cites none`);
        }

        if (entry.status === 'mapped' && evidence.length === 0 && entry.unused === undefined) {
            problems.push(
                `${name}: 'mapped' with no evidence and no 'unused' reason -- ` +
                `say either where it is used or why it is not`
            );
        }

        if (evidence.length > 0 && entry.unused !== undefined) {
            problems.push(`${name}: cites evidence *and* claims to be unused`);
        }

        for (const citation of evidence) {
            const split = citation.indexOf('::');
            const path = split === -1 ? citation : citation.slice(0, split);
            const token = split === -1 ? '' : citation.slice(split + 2);

            let text;
            try {
                text = readFileSync(resolve(ROOT, path), 'utf8');
            } catch {
                problems.push(`${name}: ${path} does not exist`);
                continue;
            }

            if (token !== '' && !text.includes(token)) {
                problems.push(`${name}: ${path} no longer contains '${token}'`);
            }
        }
    }

    return problems;
}

function main() {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const outIdx = args.indexOf('--out');
    const outPath = outIdx === -1 ? null : args[outIdx + 1];

    const spec = JSON.parse(readFileSync(join(HERE, 'trap-classification.json'), 'utf8'));
    const traps = collect();

    if (traps.size === 0) {
        console.error(
            `no trap_ symbols found under ${GAMECODE}\n` +
            `run: node tools/fetch-sources.mjs`
        );
        process.exit(2);
    }

    const names = [...traps.keys()].sort();
    const unclassified = [];
    const rows = [];
    const tally = Object.create(null);

    for (const name of names) {
        const rec = traps.get(name);
        const c = classify(name, spec);

        if (c === null) {
            unclassified.push(name);
            continue;
        }

        tally[c.status] = (tally[c.status] ?? 0) + 1;
        if (c.status === 'mapped') {
            const key = (c.evidence ?? []).length > 0 ? 'mapped-built' : 'mapped-unused';
            tally[key] = (tally[key] ?? 0) + 1;
        }
        rows.push({ name, rec, c });
    }

    // Report the by-status counts and the detail table.
    let md = '';
    md += '<!-- GENERATED BY tools/trap-matrix.mjs -- DO NOT EDIT BY HAND -->\n\n';
    md += `Mechanically derived from the OpenArena gamecode at \`.refs/oa-gamecode\`. `;
    md += `**${names.length} distinct \`trap_*\` symbols** appear across \`game/\`, \`cgame/\`, \`ui/\` and \`q3_ui/\`. `;
    md += `Occurrence counts include the prototype and the syscall-stub definition, so a syscall used once shows a count of 3.\n\n`;

    md += '| status | count | meaning |\n|---|---:|---|\n';
    md += `| \`mapped\`, exercised | ${tally['mapped-built'] ?? 0} | a meep facility does the job, and this port calls it |\n`;
    md += `| \`mapped\`, not exercised | ${tally['mapped-unused'] ?? 0} | the facility exists and would do the job; this port never needed it |\n`;
    md += `| \`hybrid\` | ${tally['hybrid'] ?? 0} | a meep facility does part of the job and ported Q3 code does the rest |\n`;
    md += `| \`ported\` | ${tally['ported'] ?? 0} | reimplemented faithfully in TypeScript; deliberately *not* mapped onto meep |\n`;
    md += `| \`workaround\` | ${tally['workaround'] ?? 0} | meep has no direct facility; solved outside the engine |\n`;
    md += `| \`GAP\` | ${tally['gap'] ?? 0} | no reasonable answer; see gap register |\n`;
    md += `| \`not needed\` | ${tally['not-needed'] ?? 0} | the whole subsystem is out of scope (netcode, botlib, CD keys, cinematics) |\n`;
    md += '\n';

    md += '| Q3 syscall | uses | modules | disposition | meep facility | where it lives | notes |\n';
    md += '|---|---:|---|---|---|---|---|\n';
    for (const { name, rec, c } of rows) {
        const mods = [...rec.modules].sort().join(', ');
        const note = c.viaPrefix === undefined
            ? c.note
            : `${c.note} _(classified by prefix \`${c.viaPrefix}\`)_`;
        const cited = c.evidence ?? [];
        const where = cited.length > 0
            ? cited.map((e) => `\`${e.split('::')[0]}\``).join('<br>')
            : c.unused === undefined ? '--' : `*not exercised.* ${c.unused}`;
        md += `| \`${name}\` | ${rec.count} | ${mods} | ${STATUS_LABEL[c.status]} | ${c.meep} | ${where} | ${note} |\n`;
    }

    if (outPath !== null) {
        // Splice between markers rather than writing a file of its own: the brief
        // allows exactly four documents, so the matrix has to live inside REPORT.md.
        const target = resolve(ROOT, outPath);
        const existing = readFileSync(target, 'utf8');
        const begin = '<!-- BEGIN TRAP MATRIX -->';
        const end = '<!-- END TRAP MATRIX -->';
        const a = existing.indexOf(begin);
        const b = existing.indexOf(end);

        if (a === -1 || b === -1 || b < a) {
            console.error(`${outPath}: missing ${begin} / ${end} markers`);
            process.exit(2);
        }

        writeFileSync(
            target,
            existing.slice(0, a + begin.length) + '\n\n' + md + '\n' + existing.slice(b)
        );
        console.error(`spliced trap matrix into ${outPath}`);
    } else if (!checkOnly) {
        process.stdout.write(md);
    }

    const evidenceProblems = checkEvidence(spec);

    if (evidenceProblems.length > 0) {
        console.error(`\nEVIDENCE (${evidenceProblems.length}):`);
        for (const p of evidenceProblems) console.error(`  ${p}`);
        console.error(
            '\nEvery `ported`, `hybrid` or `workaround` entry must cite a path in this\n' +
            'repository, and every `mapped` entry must cite one or say why it is not\n' +
            'exercised. See D-066.'
        );
        process.exit(1);
    }

    if (unclassified.length > 0) {
        console.error(`\nUNCLASSIFIED (${unclassified.length}):`);
        for (const n of unclassified) console.error(`  ${n}  (${traps.get(n).count} uses)`);
        console.error('\nAdd them to tools/trap-classification.json.');
        process.exit(1);
    }

    const cited =
        (tally['mapped-built'] ?? 0) + (tally['hybrid'] ?? 0) +
        (tally['ported'] ?? 0) + (tally['workaround'] ?? 0);

    console.error(`ok: ${names.length} syscalls, all classified, ${cited} cited in code`);
}

main();
