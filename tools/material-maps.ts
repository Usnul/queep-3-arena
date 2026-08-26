/*
 * material-maps.ts -- what the generator has to produce, and whether it has.
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
 * Usage:  node tools/material-maps.ts [--check]
 *
 * Writes `assets/generated/manifest.json`: one entry per *image* that needs
 * generated maps, with the framing to run it in and the classification that will
 * be baked into its ORM. `tools/cosmos/inverse_render.py` reads it, and
 * `tools/cosmos/build_maps.py` reads it again to assemble the results.
 *
 * # Per image, not per material
 *
 * The classification in `material-classification.json` is per *material*, because
 * that is the thing a Q3 shader names and the thing somebody can look at. The
 * generated maps are per *image*, because a normal map belongs to the artwork and
 * two materials pointing at one texture want one normal map between them (D-089).
 *
 * Those two are only compatible while materials sharing an image agree about what
 * it is made of, and nothing was previously stopping them disagreeing. So this
 * checks it: two materials on one image with different metalness or roughness is
 * an error here rather than a race over which one wrote the ORM last.
 *
 * # Wrap or mirror
 *
 * A world texture repeats across a surface and its edges join, so it is laid out
 * by repetition. A model skin does not repeat -- it is an atlas, unwrapped once --
 * so a plain repeat would put a hard seam down the middle of the frame and the
 * network would read it as geometry. Those are mirrored instead, which gives
 * continuous context without inventing an edge. See D-090 for why there has to be
 * a frame at all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ShaderIndex } from './pipeline/shader-index.ts';
import {
    classify,
    DEFAULT_VARIATION,
    inScopeNames,
    loadSpec,
    type MaterialRule,
} from './material-matrix.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const GENERATED = join(ROOT, 'assets', 'generated');
const MATERIALS = join(GENERATED, 'materials');

export interface MapJob {
    /** Virtual texture path -- what `derivedTextureKey` will be built from. */
    readonly image: string;
    /** Path under the repository root, for the generator to read. */
    readonly source: string;
    /** Flattened name the generated files take, matching `writeDerivedTexture`. */
    readonly stem: string;
    readonly framing: 'wrap' | 'mirror';
    readonly metalness: 0 | 1;
    readonly roughness: number;
    readonly variation: number;
    readonly normal: 'keep' | 'drop';
    readonly effect: boolean;
    /** Every material that resolves to this image; for reporting, not for the run. */
    readonly materials: readonly string[];
}

function sameRule(a: MaterialRule, b: MaterialRule): boolean {
    return (
        a.metalness === b.metalness &&
        a.roughness === b.roughness &&
        (a.variation ?? DEFAULT_VARIATION) === (b.variation ?? DEFAULT_VARIATION) &&
        (a.normal ?? 'keep') === (b.normal ?? 'keep')
    );
}

export function buildJobs(index: ShaderIndex): { jobs: MapJob[]; problems: string[] } {
    const spec = loadSpec();
    const problems: string[] = [];

    const byImage = new Map<string, { rule: MaterialRule; from: string; materials: string[] }>();

    for (const name of [...inScopeNames(index).keys()].sort()) {
        const pbr = index.material(name);
        const image = pbr.normal;
        if (image === null) continue;

        const rule = classify(name, spec);
        if (rule === null) {
            problems.push(`${name}: unclassified -- run material-matrix.ts --check`);
            continue;
        }

        const existing = byImage.get(image);
        if (existing === undefined) {
            byImage.set(image, { rule, from: name, materials: [name] });
            continue;
        }

        existing.materials.push(name);
        if (!sameRule(existing.rule, rule)) {
            problems.push(
                `${image}: ${existing.from} and ${name} share this image and disagree -- ` +
                `metalness ${existing.rule.metalness}/${rule.metalness}, ` +
                `roughness ${existing.rule.roughness}/${rule.roughness}. One image is one ORM.`
            );
        }
    }

    const jobs: MapJob[] = [];
    for (const [image, { rule, materials }] of [...byImage.entries()].sort()) {
        const resolved = index.resolveTexture(image);
        if (resolved === null) {
            problems.push(`${image}: in scope but resolves to no file`);
            continue;
        }

        jobs.push({
            image,
            source: join('assets', 'extracted', resolved).replace(/\\/g, '/'),
            stem: image.replace(/[\\/]/g, '_'),
            // A `models/` skin is an atlas and does not repeat; everything under
            // `textures/` is a world surface and does.
            framing: image.startsWith('models/') ? 'mirror' : 'wrap',
            metalness: rule.metalness,
            roughness: rule.roughness,
            variation: rule.variation ?? DEFAULT_VARIATION,
            normal: rule.normal ?? 'keep',
            effect: rule.effect === true,
            materials,
        });
    }

    return { jobs, problems };
}

function main(): void {
    const checkOnly = process.argv.includes('--check');
    const index = new ShaderIndex(EXTRACTED).load();
    const { jobs, problems } = buildJobs(index);

    if (problems.length > 0) {
        console.error(`PROBLEMS (${problems.length}):`);
        for (const p of problems) console.error(`  ${p}`);
        process.exit(1);
    }

    const wantNormal = jobs.filter((j) => j.normal === 'keep');
    const haveNormal = wantNormal.filter((j) => existsSync(join(MATERIALS, `${j.stem}.normal.png`)));
    const haveOrm = jobs.filter((j) => existsSync(join(MATERIALS, `${j.stem}.orm.png`)));

    if (checkOnly) {
        const missing = [
            ...wantNormal.filter((j) => !existsSync(join(MATERIALS, `${j.stem}.normal.png`))).map((j) => `${j.image} normal`),
            ...jobs.filter((j) => !existsSync(join(MATERIALS, `${j.stem}.orm.png`))).map((j) => `${j.image} orm`),
        ];
        if (missing.length > 0) {
            console.error(`MISSING (${missing.length} of ${wantNormal.length + jobs.length}):`);
            for (const m of missing.slice(0, 20)) console.error(`  ${m}`);
            if (missing.length > 20) console.error(`  ... and ${missing.length - 20} more`);
            console.error('\nRun tools/cosmos/inverse_render.py and then tools/cosmos/build_maps.py.');
            process.exit(1);
        }
        console.error(`ok: ${jobs.length} images, ${wantNormal.length} normals and ${jobs.length} ORMs present`);
        return;
    }

    //
    // The scope comes from the *built bundles* -- `inScopeNames` reads what the
    // converters wrote under `assets/built` -- so with no bundles on disk there
    // is nothing to ask for and this writes an empty manifest. That is not an
    // empty answer, it is the question never having been asked: the generator
    // then has no work, `build_maps.py` writes no maps, and the converters run
    // again quite happily and produce exactly the pre-material-phase bundles.
    // Every step reports success and the material phase is silently gone.
    //
    // `--check` has always refused this (it exits on `scoped.size === 0`). The
    // write path did not, which is the asymmetry that made it a trap rather
    // than an error, and it is how a rebuild after the D-104 deletion first
    // went: `material-maps.ts` before the converters, "0 images", exit 0.
    //
    if (jobs.length === 0) {
        console.error(
            'no images in scope, so there is nothing to generate maps for.\n' +
            'The scope is read out of the built bundles under assets/built, which means the\n' +
            'converters have to have run at least once before this does:\n' +
            '  node tools/convert-map.ts oa_dm1 aggressor oa_dm4 oa_dm5 oa_dm7 am_thornish\n' +
            '  node tools/convert-fx.ts && npm run assets\n' +
            'With assets/generated/materials empty those write the pre-material-phase bundles\n' +
            '(ASSETS.md says so); run this again afterwards, then the generator, then convert\n' +
            'a second time so the maps reach the bundles.'
        );
        process.exit(1);
    }

    mkdirSync(GENERATED, { recursive: true });
    const out = join(GENERATED, 'manifest.json');
    writeFileSync(out, `${JSON.stringify({ jobs }, null, 2)}\n`, 'utf8');

    const wrap = jobs.filter((j) => j.framing === 'wrap').length;
    console.log(`${jobs.length} images (${wrap} wrap, ${jobs.length - wrap} mirror)`);
    console.log(`  normal wanted:   ${wantNormal.length}  present: ${haveNormal.length}`);
    console.log(`  orm wanted:      ${jobs.length}  present: ${haveOrm.length}`);
    console.log(`  metal:           ${jobs.filter((j) => j.metalness === 1).length}`);
    console.log(`wrote ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) main();
