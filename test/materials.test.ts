/*
 * materials.test.ts -- the shader-to-PBR projection, and the invariants a
 * transparent surface has to hold to reach the screen.
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
 * Written after the whole transparency route turned out to be wrong in five
 * independent ways at once, none of which any existing test could see. The suite
 * was green before the fix and green after it, so the first job here is to be a
 * suite that would have been red.
 *
 * Two halves, and they check different things:
 *
 * - the **rules**, on shader text written out in the test. Every case is a real
 *   OA shader reduced to the smallest thing that still has the property, so what
 *   the projection is being asked to do is readable next to the assertion rather
 *   than a name in a bundle.
 * - the **invariants**, on the bundles the pipeline actually wrote. A material's
 *   transparency and the alpha channel of the image it points at are one claim
 *   made in two files, and the failure the maintainer reported -- a solid white
 *   box where a light shaft should be -- is exactly those two disagreeing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { parseShaderScript } from '../tools/pipeline/shader-script.ts';
import { shaderToPbr, type PbrMaterial } from '../tools/pipeline/shader-to-pbr.ts';
import { ShaderIndex } from '../tools/pipeline/shader-index.ts';

const ROOT = process.cwd();
const BUILT = join(ROOT, 'assets', 'built');
const EXTRACTED = join(ROOT, 'assets', 'extracted');

const MAPS = ['oa_dm1', 'oa_dm4', 'oa_dm5', 'oa_dm7', 'aggressor', 'am_thornish'] as const;

/** Project one shader, written out longhand, onto a material. */
function project(source: string): PbrMaterial {
    const entries = parseShaderScript(source, '(test)');
    expect(entries.length, 'the test shader parsed').toBe(1);
    return shaderToPbr(entries[0]!);
}

describe('what decides that a surface is transparent', () => {
    /*
     `FinishShader` sets `shader.sort` from stage 0 alone: later stages can blend
     all they like and the shader still sorts opaque. Every lit Q3 wall is this
     shape -- lightmap, then the diffuse multiplied into it, then a glow.
    */
    it('is stage 0, not any stage: a lightmap-first wall with a glow pass is opaque', () => {
        const m = project(`
textures/base_light/light1_3000
{
    q3map_surfacelight 3000
    {
        map $lightmap
        rgbgen identity
    }
    {
        map textures/base_light/light1.jpg
        blendfunc filter
        rgbgen identity
    }
    {
        map textures/base_light/light1.blend.jpg
        blendfunc add
    }
}`);

        expect(m.transparency).toBe('opaque');
        expect(m.albedo).toBe('textures/base_light/light1');
        expect(m.emissive, 'the additive pass is the glow map').toBe(
            'textures/base_light/light1.blend'
        );
    });

    it('is stage 0, not any stage: an additive stage 0 is transparent', () => {
        const m = project(`
textures/sfx/beam
{
    surfaceparm nolightmap
    cull none
    {
        map textures/sfx/beam.jpg
        tcMod scroll .3 0
        blendFunc GL_ONE GL_ONE
    }
}`);

        expect(m.transparency).toBe('blend');
        expect(m.doubleSided).toBe(true);
    });

    /*
     `ParseStage`: "implicitly assume that a GL_ONE GL_ZERO blend mask disables
     blending".
    */
    it('reads GL_ONE GL_ZERO as no blend at all', () => {
        const m = project(`
textures/test/plain
{
    {
        map textures/test/plain.jpg
        blendFunc GL_ONE GL_ZERO
    }
}`);

        expect(m.transparency).toBe('opaque');
    });

    /*
     `surfaceparm trans` is `CONTENTS_TRANSLUCENT` and nothing else -- the
     renderer never reads it. Reading it as "draw this blended" is what made
     `lavahell` see-through, and this is `lavahell`'s shape.
    */
    it('is not `surfaceparm trans`, which never reached Q3s renderer', () => {
        const m = project(`
textures/liquids/lavahell
{
    surfaceparm trans
    surfaceparm lava
    q3map_surfacelight 666
    {
        map textures/liquids/lavafloor.tga
        tcMod scroll 0.1 0.2
    }
    {
        map textures/liquids/lavafloor.tga
        blendfunc add
        tcMod scroll -0.05 -0.02
    }
}`);

        expect(m.transparency, 'lava is opaque geometry with a glow on top').toBe('opaque');
        expect(m.emissive).toBe('textures/liquids/lavafloor');
        expect(m.emissiveIntensity).toBeCloseTo(0.666, 3);
    });

    /*
     The alpha test belongs to the stage that carries it. OA's plasma gun puts an
     `alphaFunc LT128` on a pulsing glow three stages down; taking the test from
     any stage alpha-tested the whole weapon.
    */
    it('is `mask` only when the *albedo* stage is the one alpha-testing', () => {
        const grate = project(`
textures/test/grate
{
    cull none
    {
        map textures/test/grate.tga
        alphaFunc GE128
        depthWrite
        rgbGen identity
    }
    {
        map $lightmap
        blendfunc filter
        depthFunc equal
    }
}`);
        expect(grate.transparency).toBe('mask');
        expect(grate.alphaCutoff).toBe(0.5);

        const plasma = project(`
models/weapons2/plasma/skin
{
    {
        map models/weapons2/plasma/skin.tga
        rgbGen lightingDiffuse
    }
    {
        map models/weapons2/plasma/skin.tga
        blendfunc add
        rgbGen wave sin 0 1 0 1
        alphaFunc LT128
    }
}`);
        expect(plasma.transparency, 'a later stage alpha-testing is that stage only').toBe(
            'opaque'
        );
        expect(plasma.dropped, 'an inverted test cannot be a cutoff').toContain('alphaFunc LT128');
    });

    it('reads `alphaFunc GT0` as a near-zero cutoff rather than a half one', () => {
        const m = project(`
textures/test/wisp
{
    {
        map textures/test/wisp.tga
        alphaFunc GT0
    }
}`);
        expect(m.transparency).toBe('mask');
        expect(m.alphaCutoff).toBeLessThan(0.1);
    });
});

describe('an additive shader is a transparent emitter', () => {
    /*
     `GL_SRC_ALPHA GL_ONE` is the form OA's flames and most of its sprites use,
     and the one an `a === 'gl_one'` test misses. Missing it left every torch in
     the game an opaque black-and-orange quad -- the reported bug.
    */
    it('recognises GL_SRC_ALPHA GL_ONE, which is what every OA flame uses', () => {
        const m = project(`
textures/sfx/flame2
{
    qer_editorimage textures/sfx/flame5.tga
    cull disable
    q3map_surfacelight 3787
    {
        animmap 8 textures/sfx/flame1.tga textures/sfx/flame2.tga
        blendfunc gl_src_alpha gl_one
        rgbGen wave inversesawtooth 0 1 0 8
    }
}`);

        expect(m.transparency).toBe('blend');
        expect(m.albedoBlend).toBe('addAlpha');
        expect(m.albedo, 'the stage names the image, not the editor preview').toBe(
            'textures/sfx/flame1'
        );
        expect(m.emissive).toBe('textures/sfx/flame1');
    });

    /*
     Recognised by the *destination* factor: a stage that keeps the whole
     destination cannot occlude, so its coverage is its own brightness. This is
     `clear_calm1`, OA's water.
    */
    it('recognises any blend whose destination factor is GL_ONE', () => {
        const m = project(`
textures/liquids/clear_calm1
{
    cull none
    {
        map textures/liquids/pool3d_5e.jpg
        blendFunc gl_dst_color gl_one
        rgbgen identity
    }
    {
        map $lightmap
        blendFunc gl_dst_color gl_zero
        rgbgen identity
    }
}`);

        expect(m.transparency).toBe('blend');
        expect(m.albedoBlend).toBe('add');
    });

    it('glows at unit intensity with no `q3map_surfacelight` to ask', () => {
        const m = project(`
textures/sfx/beam
{
    cull none
    {
        map textures/sfx/beam.jpg
        blendFunc GL_ONE GL_ONE
    }
}`);

        expect(m.surfaceLight).toBe(0);
        expect(m.emissive).toBe('textures/sfx/beam');
        expect(
            m.emissiveIntensity,
            'gating the glow on a light-compiler directive is what unbound every beam'
        ).toBe(1);
    });

    /*
     The runtime binds the emissive only when the intensity is above zero, so a
     material naming one at zero is a glow map that never reaches the GPU.
    */
    it('never names an emissive it then gives zero intensity', () => {
        for (const name of MAPS) {
            const scene = JSON.parse(readFileSync(join(BUILT, name, 'scene.json'), 'utf8'));
            for (const m of scene.materials) {
                if (m.emissive === null) continue;
                expect(m.emissiveIntensity, `${name}: ${m.name} names an emissive`).toBeGreaterThan(
                    0
                );
            }
        }
    });
});

describe('what is a glow map and what is 1999 fake specular', () => {
    /*
     Q3 draws a weapon skin twice -- diffuse, then additively at a specular
     coefficient. `RB_CalcSpecularAlpha` computes that coefficient from the
     lights, so it is shading, and a PBR material shades. Promoting it to an
     emissive lights the railgun up like a lamp.
    */
    it('drops an additive pass shaded by the scene when there is a real albedo', () => {
        const m = project(`
models/weapons2/railgun/skin
{
    {
        map models/weapons2/railgun/skin.tga
        rgbGen lightingDiffuse
    }
    {
        map models/weapons2/railgun/skin.tga
        blendfunc gl_src_alpha gl_one
        rgbGen lightingDiffuse
        alphaGen lightingSpecular
    }
}`);

        expect(m.transparency).toBe('opaque');
        expect(m.albedo).toBe('models/weapons2/railgun/skin');
        expect(m.emissive, 'a highlight is not a glow map').toBeNull();
    });

    it('keeps it when it is the whole shader, because an effect has to get its colour somewhere', () => {
        const m = project(`
models/weapons2/railgun/glass
{
    cull disable
    {
        map textures/effects/tinfx2.tga
        blendfunc add
        rgbGen lightingDiffuse
        tcGen environment
    }
}`);

        expect(m.transparency).toBe('blend');
        expect(m.albedo).toBe('textures/effects/tinfx2');
        expect(m.emissive).toBe('textures/effects/tinfx2');
    });

    it('keeps an unshaded additive pass over a real albedo', () => {
        const m = project(`
models/weapons/nailgun/nailgun
{
    {
        map models/weapons/nailgun/nailgun.tga
        rgbGen lightingDiffuse
    }
    {
        map models/weapons/nailgun/glow.tga
        blendfunc add
        rgbGen wave sin 0.25 0.75 0 0.25
    }
}`);

        expect(m.emissive).toBe('models/weapons/nailgun/glow');
        expect(m.emissiveIntensity).toBe(1);
    });
});

describe('which stage becomes the albedo', () => {
    /*
     `VertexLightingCollapse`'s ranking, which is Q3 answering the same question:
     if only one pass can be drawn, which one carries the surface? A `tcGen
     environment` pass is a reflection and ranks below the skin, which is how
     `xlight5` stopped being a picture of an environment map.
    */
    it('ranks a plain stage above an environment-mapped one', () => {
        const m = project(`
textures/base_light/xlight5
{
    q3map_surfacelight 1000
    {
        map textures/effects/envmap2.tga
        rgbGen identity
        tcGen environment
    }
    {
        map textures/base_light/xlight5.tga
        blendfunc gl_one gl_one_minus_src_alpha
        rgbGen identity
    }
    {
        map $lightmap
        blendfunc filter
        tcGen lightmap
    }
    {
        map textures/base_light/xlight5.blend.tga
        blendfunc add
    }
}`);

        expect(m.albedo).toBe('textures/base_light/xlight5');
        expect(m.emissive).toBe('textures/base_light/xlight5.blend');
    });

    it('falls back to the editor image only when no stage names one', () => {
        const m = project(`
textures/test/nostages
{
    qer_editorimage textures/test/preview.tga
    surfaceparm nolightmap
}`);

        expect(m.albedo).toBe('textures/test/preview');
        expect(m.albedoBlend).toBe('opaque');
    });

    /*
     An opaque material's albedo carries no alpha whatever blend named it: meep
     divides the colour by that alpha and the surface goes black where it was
     zero. `am_thornish`'s launch pads are the shape -- an opaque stage 0, and a
     `blendFunc blend` decal that outranks it.
    */
    it('strips the alpha off an opaque materials albedo', () => {
        const m = project(`
textures/bubctf1/e8_launchpad1
{
    q3map_surfacelight 100
    {
        map textures/bubctf1/e8_launchpad1_fx.tga
        rgbGen identity
        tcMod scroll 0 3
    }
    {
        map textures/bubctf1/e8_launchpad1.tga
        blendfunc blend
        rgbGen identity
    }
}`);

        expect(m.transparency).toBe('opaque');
        expect(m.albedo).toBe('textures/bubctf1/e8_launchpad1');
        expect(m.albedoBlend).toBe('opaque');
    });
});

describe('resolving a name to a file, the way R_FindShader does', () => {
    const index = new ShaderIndex(EXTRACTED).load();

    /*
     `R_LoadImage` tries the name it was given before it strips anything. Every
     Q3 glow map is `<texture>.blend.tga`, and `.blend` looks exactly like an
     extension: stripping first resolved all of them to the base texture beside
     them, so a light's emissive was a second copy of its diffuse.
    */
    it('does not mistake `.blend` for a file extension', () => {
        expect(index.resolveTexture('textures/base_light/ceil1_38.blend')).toBe(
            'textures/base_light/ceil1_38.blend.tga'
        );
        expect(index.resolveTexture('textures/base_light/ceil1_38')).toBe(
            'textures/base_light/ceil1_38.tga'
        );
    });

    /*
     `R_FindShader` runs `COM_StripExtension` first. MD3 surfaces name their skins
     with the extension left on, and eleven pickup models missed their scripts
     without this.
     */
    it('strips a real extension before looking a shader up', () => {
        const withExtension = index.material('models/powerups/orb/r_orb.png');
        const without = index.material('models/powerups/orb/r_orb');

        expect(withExtension.source, 'found the script, not the implicit-texture branch').not.toBe(
            '(implicit texture)'
        );
        expect(withExtension.albedo).toBe(without.albedo);
        expect(withExtension.transparency).toBe('blend');
    });
});

/*
 * The invariants, checked against what the pipeline actually wrote.
 *
 * These are the ones the reported bug would have tripped: a blended material
 * whose albedo image is fully opaque draws as a solid box and, because meep's
 * OIT weights every fragment by that same alpha, takes the surfaces behind it
 * with it.
 */
describe('a materials transparency and its albedo image agree', () => {
    interface Bundle {
        readonly materials: readonly {
            name: string;
            albedo: string | null;
            albedoBlend: string;
            transparency: string;
        }[];
        readonly textures: Readonly<Record<string, string | null>>;
    }

    interface Alpha {
        readonly min: number;
        readonly max: number;
    }

    const alphaCache = new Map<string, Promise<Alpha>>();

    function alphaRange(file: string): Promise<Alpha> {
        let p = alphaCache.get(file);
        if (p === undefined) {
            p = (async () => {
                const raw = await sharp(file)
                    .ensureAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                let min = 255;
                let max = 0;
                for (let i = 3; i < raw.data.length; i += 4) {
                    const a = raw.data[i]!;
                    if (a < min) min = a;
                    if (a > max) max = a;
                }
                return { min, max };
            })();
            alphaCache.set(file, p);
        }
        return p;
    }

    /**
     * Materials that legitimately fail the coverage check, named rather than
     * filtered by a pattern so that a *new* one is a failure.
     *
     * `bfgtube` is a `blendFunc blend` stage whose translucency came entirely
     * from an `alphaGen wave inversesawtooth` -- the image itself is opaque and
     * the wave is dropped (see the projection's own `dropped` list). It draws
     * solid, which is the honest consequence of dropping `alphaGen`, and it is
     * one surface on one weapon.
     */
    const OPAQUE_BY_DESIGN = new Set(['models/weapons2/bfg/bfgtube']);

    /**
     * The one material in the whole set with no texture at all: `telep.md3`
     * names its shader `E:/projects/oa/newtele/Circle`, an absolute path off the
     * artist's machine that OA shipped and no file answers to.
     */
    const UNTEXTURED_BY_CONTENT = new Set(['E:/projects/oa/newtele/Circle']);

    const bundles: { label: string; bundle: Bundle; textureDir: string }[] = [
        ...MAPS.map((name) => ({
            label: name,
            bundle: JSON.parse(readFileSync(join(BUILT, name, 'scene.json'), 'utf8')) as Bundle,
            textureDir: join(BUILT, name, 'textures'),
        })),
        {
            label: 'models',
            bundle: JSON.parse(
                readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
            ) as Bundle,
            textureDir: join(BUILT, 'models', 'textures'),
        },
    ];

    it.each(bundles)('every material has an albedo image [$label]', ({ label, bundle }) => {
        const untextured = bundle.materials
            .filter((m) => m.albedo === null || !bundle.textures[m.albedo])
            .map((m) => m.name);

        expect(untextured.filter((n) => !UNTEXTURED_BY_CONTENT.has(n)), label).toEqual([]);
    });

    it.each(bundles)(
        'a blended material has coverage to blend with [$label]',
        async ({ label, bundle, textureDir }) => {
            const solid: string[] = [];

            for (const m of bundle.materials) {
                if (m.transparency === 'opaque' || m.albedo === null) continue;
                const file = bundle.textures[m.albedo];
                if (!file) continue;

                const { min } = await alphaRange(join(textureDir, file));
                if (min === 255 && !OPAQUE_BY_DESIGN.has(m.name)) {
                    solid.push(`${m.name} (${m.albedoBlend} -> ${file})`);
                }
            }

            expect(solid, `${label}: transparent in name only`).toEqual([]);
        }
    );

    it.each(bundles)(
        'an opaque materials albedo carries no alpha to divide by [$label]',
        async ({ label, bundle, textureDir }) => {
            const holed: string[] = [];

            for (const m of bundle.materials) {
                if (m.transparency !== 'opaque' || m.albedo === null) continue;
                const file = bundle.textures[m.albedo];
                if (!file) continue;

                const { min } = await alphaRange(join(textureDir, file));
                if (min < 255) holed.push(`${m.name} -> ${file} (alpha down to ${min})`);
            }

            expect(holed, `${label}: meep shades these black where alpha is zero`).toEqual([]);
        }
    );

    it('writes a separate file when one image is restated two ways', () => {
        const scene = JSON.parse(
            readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')
        ) as Bundle;

        const beam = scene.materials.find((m) => m.name === 'textures/sfx/beam');
        expect(beam, 'oa_dm1 still has the light shaft that started all this').toBeDefined();

        const coverage = scene.textures[beam!.albedo!];
        const colour = scene.textures['textures/sfx/beam'];

        expect(beam!.albedo).toBe('textures/sfx/beam#add');
        expect(coverage, 'the albedo is the restated copy').not.toBe(colour);
        expect(existsSync(join(BUILT, 'oa_dm1', 'textures', coverage!))).toBe(true);
        expect(existsSync(join(BUILT, 'oa_dm1', 'textures', colour!))).toBe(true);
    });
});
