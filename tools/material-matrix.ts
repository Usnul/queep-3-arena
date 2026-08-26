/*
 * material-matrix.ts -- apply and check tools/material-classification.json.
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
 * Usage:  node tools/material-matrix.ts [--check]
 *
 * A sibling of `trap-matrix.mjs` and deliberately the same shape: rules applied
 * in order, per-entry overrides, and a `--check` wired into `npm run check` that
 * fails on anything unclassified. The reason it is data and not a heuristic is
 * `shader-to-pbr.ts:583`, which already records the objection to guessing a
 * material from its name, and D-092, which measured what happens when the
 * guessing is done by a network instead: metalness that segments by shape and
 * flips with the input framing.
 *
 * # What "unclassified" means
 *
 * The in-scope set is every material named by a built bundle whose `PbrMaterial`
 * is owed generated maps -- has an albedo, is not sky, nodraw, unlit or blended.
 * That is the same rule `shaderToPbr` applies, imported rather than restated, so
 * the two cannot drift.
 *
 * The check therefore needs the bundles to have been built. So does half the
 * test suite, so this is not a new requirement; it does mean the failure mode on
 * a fresh clone is "run npm run setup first" rather than a confusing pass.
 *
 * # Why a bit and a level rather than two textures
 *
 * Metalness is one bit per material across this asset set, and where it is not,
 * the boundary is a hard paint edge. Roughness has a level per material and
 * variation within it: the level is here, and the variation comes from the
 * generated ORM, scaled by `variation`. That split is what D-092 measured --
 * the network's roughness contributes nothing to a round trip as an absolute
 * value and returns 0.76 and 0.21 for the same wall depending on framing, but
 * the *shape* of it (mortar smoother than block face) is right.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ShaderIndex } from './pipeline/shader-index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = join(ROOT, 'assets', 'built');
const EXTRACTED = join(ROOT, 'assets', 'extracted');
const SPEC = join(ROOT, 'tools', 'material-classification.json');

/** How much of the generated ORM's variation to keep, when a rule does not say. */
export const DEFAULT_VARIATION = 0.15;

export interface MaterialRule {
    readonly metalness: 0 | 1;
    readonly roughness: number;
    /** Fraction of the generated roughness's spread to keep around `roughness`. */
    readonly variation?: number;
    /** `drop` refuses a generated normal map for this material. */
    readonly normal?: 'keep' | 'drop';
    /**
     * Not a surface: a `tcGen environment` fake reflection, a powerup shell, a
     * glyph on black. Recorded rather than merely dropped, because "this is not
     * artwork of a surface" is a different statement from "the normal map came
     * out wrong".
     */
    readonly effect?: boolean;
    readonly note?: string;
}

interface Spec {
    readonly prefixRules: (MaterialRule & { readonly prefix: string })[];
    readonly entries: Record<string, MaterialRule>;
}

export function loadSpec(): Spec {
    return JSON.parse(readFileSync(SPEC, 'utf8')) as Spec;
}

/** First matching rule wins, entries first. `null` when nothing covers it. */
export function classify(name: string, spec: Spec): (MaterialRule & { via: string }) | null {
    const explicit = spec.entries[name];
    if (explicit !== undefined) return { ...explicit, via: 'entry' };

    for (const rule of spec.prefixRules) {
        if (name.startsWith(rule.prefix)) return { ...rule, via: rule.prefix };
    }

    return null;
}

/**
 * Every material a built bundle names, with the kind of bundle it came from.
 *
 * A name can appear in more than one kind -- a weapon skin is both a prop and,
 * on the maps that place one as scenery, a world material -- so this is a set
 * and not a concatenation.
 */
export function builtMaterialNames(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const add = (name: string, kind: string) => {
        const set = out.get(name) ?? new Set<string>();
        set.add(kind);
        out.set(name, set);
    };

    if (!existsSync(BUILT)) return out;

    for (const dir of readdirSync(BUILT)) {
        const scene = join(BUILT, dir, 'scene.json');
        if (!existsSync(scene)) continue;
        for (const m of JSON.parse(readFileSync(scene, 'utf8')).materials as { name: string }[]) {
            add(m.name, 'world');
        }
    }

    const models = join(BUILT, 'models', 'models.json');
    if (existsSync(models)) {
        for (const m of JSON.parse(readFileSync(models, 'utf8')).materials as { name: string }[]) {
            add(m.name, 'prop');
        }
    }

    const characters = join(BUILT, 'characters');
    if (existsSync(characters)) {
        for (const c of readdirSync(characters)) {
            const gltf = join(characters, c, `${c}.gltf`);
            if (!existsSync(gltf)) continue;
            const doc = JSON.parse(readFileSync(gltf, 'utf8')) as { materials?: { name: string }[] };
            for (const m of doc.materials ?? []) add(m.name, 'character');
        }
    }

    return out;
}

/** The names that are owed generated maps, by the same rule `shaderToPbr` uses. */
export function inScopeNames(index: ShaderIndex): Map<string, Set<string>> {
    const all = builtMaterialNames();
    const scoped = new Map<string, Set<string>>();
    for (const [name, kinds] of all) {
        if (index.material(name).normal !== null) scoped.set(name, kinds);
    }
    return scoped;
}

function validate(name: string, rule: MaterialRule): string[] {
    const problems: string[] = [];

    if (rule.metalness !== 0 && rule.metalness !== 1) {
        problems.push(`${name}: metalness is ${rule.metalness}, and it is a bit`);
    }
    if (!(rule.roughness >= 0.03 && rule.roughness <= 1)) {
        problems.push(
            `${name}: roughness ${rule.roughness} is outside 0.03..1 -- below 0.03 GGX is a ` +
            `numerically unstable mirror and meep clamps it anyway`
        );
    }
    if (rule.variation !== undefined && !(rule.variation >= 0 && rule.variation <= 1)) {
        problems.push(`${name}: variation ${rule.variation} is outside 0..1`);
    }
    if (rule.normal !== undefined && rule.normal !== 'keep' && rule.normal !== 'drop') {
        problems.push(`${name}: normal is '${rule.normal}', expected 'keep' or 'drop'`);
    }

    return problems;
}

function report(spec: Spec, scoped: Map<string, Set<string>>): void {
    const byRule = new Map<string, number>();
    let metal = 0;
    let dropped = 0;
    let roughnessTotal = 0;

    for (const name of scoped.keys()) {
        const rule = classify(name, spec)!;
        byRule.set(rule.via, (byRule.get(rule.via) ?? 0) + 1);
        if (rule.metalness === 1) metal += 1;
        if (rule.normal === 'drop') dropped += 1;
        roughnessTotal += rule.roughness;
    }

    console.log(`${scoped.size} materials in scope`);
    console.log(`  metal:            ${metal} (${((100 * metal) / scoped.size).toFixed(1)}%)`);
    console.log(`  mean roughness:   ${(roughnessTotal / scoped.size).toFixed(3)}`);
    console.log(`  normal dropped:   ${dropped}`);
    console.log(`  rules used:       ${byRule.size} of ${spec.prefixRules.length + Object.keys(spec.entries).length}`);

    const unused = [
        ...spec.prefixRules.filter((r) => !byRule.has(r.prefix)).map((r) => r.prefix),
        ...Object.keys(spec.entries).filter((k) => !scoped.has(k)),
    ];
    if (unused.length > 0) {
        console.log(`  matching nothing: ${unused.join(', ')}`);
    }
}

function main(): void {
    const checkOnly = process.argv.includes('--check');
    const spec = loadSpec();
    const index = new ShaderIndex(EXTRACTED).load();
    const scoped = inScopeNames(index);

    if (scoped.size === 0) {
        console.error(
            'no built bundles under assets/built -- run `npm run setup` and the converters first'
        );
        process.exit(1);
    }

    const problems: string[] = [];
    for (const [name, rule] of Object.entries(spec.entries)) problems.push(...validate(name, rule));
    for (const rule of spec.prefixRules) problems.push(...validate(rule.prefix, rule));

    const unclassified = [...scoped.entries()]
        .filter(([name]) => classify(name, spec) === null)
        .map(([name, kinds]) => `${name}  (${[...kinds].join(', ')})`);

    if (process.argv.includes('--list')) {
        const rows = [...scoped.keys()].sort().map((name) => {
            const rule = classify(name, spec)!;
            return { name, rule };
        });
        for (const { name, rule } of rows) {
            const flags = [rule.normal === 'drop' ? 'no-normal' : '', rule.effect ? 'effect' : '']
                .filter(Boolean)
                .join(' ');
            console.log(
                `${rule.metalness === 1 ? 'metal' : '     '}  ${rule.roughness.toFixed(2)}  ` +
                `${name.padEnd(46)}${flags ? `  ${flags}` : ''}`
            );
        }
        console.log();
    }

    if (!checkOnly) report(spec, scoped);

    if (problems.length > 0) {
        console.error(`\nINVALID (${problems.length}):`);
        for (const p of problems) console.error(`  ${p}`);
        process.exit(1);
    }

    if (unclassified.length > 0) {
        console.error(`\nUNCLASSIFIED (${unclassified.length}):`);
        for (const n of unclassified) console.error(`  ${n}`);
        console.error(
            '\nAdd them to tools/material-classification.json. A material with no entry would\n' +
            'otherwise ship at the 0.85 placeholder, which is the thing this phase exists to end.'
        );
        process.exit(1);
    }

    console.error(`ok: ${scoped.size} materials, all classified`);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) main();
