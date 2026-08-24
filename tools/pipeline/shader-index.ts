/*
 * shader-index.ts -- resolve a Q3 shader name to a PBR material and a texture file.
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
 * Q3 resolves a surface's shader name in two steps, and both matter:
 *
 * 1. If a `.shader` script declares that name, its stages define the surface.
 * 2. Otherwise the name is treated as a *texture path* and the renderer looks
 *    for `<name>.tga` then `<name>.jpg`.
 *
 * Most surfaces in a real map take route 2. A converter that only handles route
 * 1 renders about a third of a level and looks broken in a way that is hard to
 * attribute.
 *
 * Shader names also collide across the 104 script files -- later files win in
 * Q3's own load order. Collisions are recorded rather than silently resolved,
 * because a collision is usually a content bug worth knowing about.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseShaderScript, type ShaderScriptEntry } from './shader-script.ts';
import { shaderToPbr, shaderSun, type PbrMaterial, type SunLight } from './shader-to-pbr.ts';
import { readFileSync, readdirSync } from 'node:fs';

/** Extensions Q3's renderer tried, in the order it tried them. */
const TEXTURE_EXTENSIONS = ['.tga', '.jpg', '.jpeg', '.png'] as const;

export interface ShaderIndexStats {
    readonly scriptFiles: number;
    readonly entries: number;
    readonly unique: number;
    readonly collisions: number;
    readonly parseWarnings: readonly string[];
}

export class ShaderIndex {
    private readonly byName = new Map<string, ShaderScriptEntry>();
    private readonly pbrCache = new Map<string, PbrMaterial>();
    private readonly collisions: string[] = [];
    private readonly warnings: string[] = [];
    private scriptFileCount = 0;
    private entryCount = 0;

    /**
     * Root of the flattened pk3 tree, e.g. `assets/extracted`.
     *
     * Written out longhand rather than as a parameter property: Node runs these
     * sources with strip-only type removal, which rejects `constructor(private
     * x)` because it would have to *emit* an assignment rather than delete a
     * type annotation.
     */
    private readonly assetRoot: string;

    constructor(assetRoot: string) {
        this.assetRoot = assetRoot;
    }

    /** Load every `.shader` under `scripts/`, in Q3's load order (alphabetical). */
    load(): this {
        const dir = join(this.assetRoot, 'scripts');
        const files = readdirSync(dir)
            .filter((f) => f.toLowerCase().endsWith('.shader'))
            .sort();

        for (const file of files) {
            this.scriptFileCount += 1;

            // Q3 shader scripts are 8-bit text with occasional high-bit bytes in
            // comments. Decoding as UTF-8 would throw or mangle; latin1 is
            // lossless for the ASCII the parser cares about.
            const source = readFileSync(join(dir, file), 'latin1');

            for (const entry of parseShaderScript(source, file, (w) => this.warnings.push(w))) {
                this.entryCount += 1;

                const prior = this.byName.get(entry.name);
                if (prior !== undefined && prior.source !== entry.source) {
                    this.collisions.push(`${entry.name}: ${prior.source} -> ${entry.source}`);
                }

                this.byName.set(entry.name, entry);
            }
        }

        return this;
    }

    /**
     * Resolve a shader name to a PBR material.
     *
     * Always returns something: a name with no script and no texture on disk
     * still yields a material, with `albedo: null`, so the caller can count how
     * many surfaces ended up untextured instead of the geometry silently
     * vanishing.
     */
    material(name: string): PbrMaterial {
        const key = name.replace(/\\/g, '/').toLowerCase();

        const cached = this.pbrCache.get(key);
        if (cached !== undefined) return cached;

        const entry = this.byName.get(key);

        let material: PbrMaterial;

        if (entry !== undefined) {
            material = shaderToPbr(entry);

            // A script can name an albedo that is not on disk (OA inherited a
            // number of dead references from Q3). Fall back to the shader name
            // as a texture path, which is what the renderer would have done.
            if (material.albedo !== null && this.resolveTexture(material.albedo) === null) {
                material = { ...material, albedo: this.resolveTexture(key) === null ? null : key };
            }
        } else {
            // No script: the name is the texture path.
            material = {
                name: key,
                albedo: this.resolveTexture(key) === null ? null : key,
                emissive: null,
                emissiveIntensity: 0,
                roughness: 0.85,
                metallic: 0,
                transparency: 'opaque',
                alphaCutoff: 0.5,
                doubleSided: false,
                isSky: false,
                isNoDraw: false,
                surfaceLight: 0,
                dropped: [],
                source: '(implicit texture)',
            };
        }

        this.pbrCache.set(key, material);
        return material;
    }

    /**
     * Find the file backing a virtual texture path, trying Q3's extension order.
     * Returns the path relative to the asset root, or `null`.
     */
    resolveTexture(virtualPath: string): string | null {
        const base = virtualPath.replace(/\\/g, '/').toLowerCase().replace(/\.[a-z0-9]+$/, '');

        for (const ext of TEXTURE_EXTENSIONS) {
            const candidate = `${base}${ext}`;
            if (existsSync(join(this.assetRoot, candidate))) return candidate;
        }

        return null;
    }

    /** Every `q3map_sun` in the loaded scripts, keyed by shader name. */
    suns(): Map<string, SunLight> {
        const out = new Map<string, SunLight>();
        for (const [name, entry] of this.byName) {
            const sun = shaderSun(entry);
            if (sun !== null) out.set(name, sun);
        }
        return out;
    }

    stats(): ShaderIndexStats {
        return {
            scriptFiles: this.scriptFileCount,
            entries: this.entryCount,
            unique: this.byName.size,
            collisions: this.collisions.length,
            parseWarnings: this.warnings,
        };
    }
}
