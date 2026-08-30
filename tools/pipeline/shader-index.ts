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
import {
    shaderToPbr,
    shaderSun,
    IOR_DEFAULT,
    type PbrMaterial,
    type SunLight,
} from './shader-to-pbr.ts';
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
        /*
         `R_FindShader` runs `COM_StripExtension` before it looks anything up, so
         a surface naming `models/powerups/orb/b_orb.png` finds the *shader*
         called `models/powerups/orb/b_orb`. MD3 surfaces name their skins with
         the extension left on often enough for this to matter: without it,
         eleven of the pickup models missed their scripts and fell through to the
         implicit-texture branch below, which has no stages and therefore no
         transparency, no glow and -- for the ones whose script was the only
         thing naming a real file -- no texture either.
        */
        const key = name.replace(/\\/g, '/').toLowerCase().replace(/\.[a-z0-9]+$/, '');

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
                const albedo = this.resolveTexture(key) === null ? null : key;

                /*
                 The generated maps are keyed by the image they were derived from,
                 so they have to follow the albedo through this substitution --
                 otherwise the material asks for a normal map belonging to a
                 texture that was not on disk, which resolves to nothing and
                 quietly costs the surface its normal.
                */
                material = {
                    ...material,
                    albedo,
                    normal: material.normal === null ? null : albedo,
                    orm: material.orm === null ? null : albedo,
                };
            }
        } else {
            // No script: the name is the texture path.
            const implicit = this.resolveTexture(key) === null ? null : key;
            material = {
                name: key,
                albedo: implicit,
                albedoBlend: 'opaque',
                // An ordinary lit opaque surface, so it takes both generated maps.
                normal: implicit,
                orm: implicit,
                emissive: null,
                emissiveLuminance: 0,
                // No stages at all, so no glow pass and no test on one.
                emissiveAlphaTest: null,
                // No script, so no `tcGen` either: this samples the model's UVs.
                environmentMapped: false,
                roughness: 0.85,
                metallic: 0,
                // Opaque, and no `surfaceparm` to call it water: nothing to
                // transmit and no reason to leave plate glass.
                transmission: 0,
                ior: IOR_DEFAULT,
                transparency: 'opaque',
                alphaCutoff: 0.5,
                doubleSided: false,
                isSky: false,
                isNoDraw: false,
                // Q3 gives a name with no script a default shader that is lit.
                unlit: false,
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
     *
     * `R_LoadImage` tries the name it was handed *first* and only then strips a
     * trailing extension and tries the loaders' own. Doing it the other way round
     * -- strip first, always -- is not a subtle difference: every Q3 glow map is
     * named `<texture>.blend.tga`, and `.blend` looks exactly like an extension.
     * Stripping it unconditionally resolved every one of them to the base texture
     * beside it, so a light's emissive was a second copy of its diffuse and the
     * whole fixture glowed instead of the bright part of it.
     */
    resolveTexture(virtualPath: string): string | null {
        const path = virtualPath.replace(/\\/g, '/').toLowerCase();

        for (const ext of TEXTURE_EXTENSIONS) {
            const candidate = `${path}${ext}`;
            if (existsSync(join(this.assetRoot, candidate))) return candidate;
        }

        const base = path.replace(/\.[a-z0-9]+$/, '');
        if (base !== path) {
            for (const ext of TEXTURE_EXTENSIONS) {
                const candidate = `${base}${ext}`;
                if (existsSync(join(this.assetRoot, candidate))) return candidate;
            }
        }

        return null;
    }

    /**
     * The parsed script entry for `name`, or `null` if no script declares it.
     *
     * The stages as written, before {@link material} has decided what they mean.
     * A caller that wants the *shader* rather than the material it converts to
     * needs them: `extract-effect-widths.ts` reads the `map`/`animmap` paths out
     * of a beam shader to measure the artwork Q3 actually painted, and a
     * `PbrMaterial` has already thrown the frame list away by then.
     *
     * Names are lowercased on load, as Q3 lowercases them, so this does the same
     * to its argument rather than making every caller remember to.
     */
    entry(name: string): ShaderScriptEntry | null {
        return this.byName.get(name.toLowerCase()) ?? null;
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
