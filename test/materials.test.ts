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
 * Written after the whole transparency route turned out to be wrong in six
 * independent ways at once, none of which any existing test could see, and then
 * extended when the fix made a seventh visible (D-083, D-084). The suite was
 * green before all of that and green after it, so the first job here is to be a
 * suite that would have been red.
 *
 * Three parts, and they check different things:
 *
 * - the **rules**, on shader text written out in the test. Every case is a real
 *   OA shader reduced to the smallest thing that still has the property, so what
 *   the projection is being asked to do is readable next to the assertion rather
 *   than a name in a bundle.
 * - the **invariants**, on the bundles the pipeline actually wrote. A material's
 *   transparency and the alpha channel of the image it points at are one claim
 *   made in two files, and the failure the maintainer reported -- a solid white
 *   box where a light shaft should be -- is exactly those two disagreeing.
 * - the **orientation**, on the same bundles' geometry. A texture coordinate is
 *   only wrong relative to something, and for a mirrored one that something has
 *   to be a surface with a top and a bottom.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { parseShaderScript } from '../tools/pipeline/shader-script.ts';
import {
    shaderToPbr,
    TRANSMISSIVE,
    UNLIT_LUMINANCE,
    type PbrMaterial,
} from '../tools/pipeline/shader-to-pbr.ts';
import { ShaderIndex } from '../tools/pipeline/shader-index.ts';
import { derivedTextureKey, textureKey, texturePathOf } from '../tools/pipeline/texture-out.ts';
import { classify, inScopeNames, loadSpec } from '../tools/material-matrix.ts';

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

        /*
         The projection knows the surface emits and does not know how brightly:
         a luminance needs the surface's area and the flux placed on it, and
         neither is a property of the shader. The map converter supplies it,
         and the bundle invariant below checks that it did.
        */
        expect(m.surfaceLight).toBe(666);
        expect(m.unlit, 'lava has no lightmap stage, so Q3 draws it unshaded').toBe(true);
        expect(m.emissiveLuminance).toBe(UNLIT_LUMINANCE);
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
            m.emissiveLuminance,
            'gating the glow on a light-compiler directive is what unbound every beam'
        ).toBe(UNLIT_LUMINANCE);
    });

    /*
     The runtime binds the emissive only when the intensity is above zero, so a
     material naming one at zero is a glow map that never reaches the GPU.
    */
    it('never names an emissive it then gives zero luminance', () => {
        for (const name of MAPS) {
            const scene = JSON.parse(readFileSync(join(BUILT, name, 'scene.json'), 'utf8'));
            for (const m of scene.materials) {
                if (m.emissive === null) continue;
                expect(m.emissiveLuminance, `${name}: ${m.name} names an emissive`).toBeGreaterThan(
                    0
                );
            }
        }
    });
});

/*
 * Q3 lights a surface in one of three ways and the third is "not at all".
 * `FinishShader` tracks `hasLightmapStage` for exactly that reason. A renderer
 * that shades everything from photometric lights has one way to say "not
 * shaded", which is to emit it.
 */
describe('an unlit Q3 surface emits its own texture', () => {
    /*
     `textures/acc_dm5/flame`, the torch on `oa_dm5`: no `$lightmap` stage, no
     `rgbGen lightingDiffuse`, and no additive pass either -- two plain
     `blendFunc blend` stages of a fire texture, which Q3 draws at full
     brightness. Shading it instead lit the torches with the room they light.
    */
    it('gives a flame drawn with two plain blend stages an emissive', () => {
        const m = project(`
textures/acc_dm5/flame
{
    surfaceparm nolightmap
    cull none
    {
        map textures/acc_dm5/flame.tga
        tcMod Scroll 1 0
        blendFunc blend
    }
    {
        map textures/acc_dm5/flame.tga
        blendFunc blend
        rgbGen wave sin 2 0 .1 1.5
    }
}`);

        expect(m.unlit).toBe(true);
        expect(m.emissive, 'an unlit surface emits what it would have reflected').toBe(
            'textures/acc_dm5/flame'
        );
        expect(m.emissiveLuminance).toBe(UNLIT_LUMINANCE);
    });

    it('leaves a lightmapped surface alone', () => {
        const m = project(`
textures/acc_dm5/mud_trans
{
    cull none
    {
        map textures/acc_dm5/mud02.jpg
    }
    {
        map $lightmap
        rgbGen identity
        blendFunc GL_DST_COLOR GL_ZERO
    }
}`);

        expect(m.unlit).toBe(false);
        expect(m.emissive, 'a wall is lit, not emitting').toBeNull();
    });

    /*
     A multiply subtracts light rather than adding it, so a fog brush emitting
     its own grey would be a lamp in the shape of a cloud.
    */
    it('refuses to make a fog brush emit', () => {
        const m = project(`
textures/sfx/xnotsodensegreyfog
{
    surfaceparm fog
    cull disable
    {
        map textures/liquids/kc_fogcloud3.tga
        blendfunc filter
    }
}`);

        expect(m.unlit).toBe(true);
        expect(m.albedoBlend).toBe('filter');
        expect(m.emissive).toBeNull();
    });

    /*
     A name with no script at all is never unlit: Q3 builds it a default shader
     carrying a lightmap stage when the surface has a lightmap, and vertex
     lighting when it does not. Every ordinary wall in the game arrives that way.
    */
    it('never calls an implicit texture unlit', () => {
        const wall = new ShaderIndex(EXTRACTED).load().material('textures/gothic_block/blocks18c');

        expect(wall.source).toBe('(implicit texture)');
        expect(wall.unlit).toBe(false);
        expect(wall.emissive).toBeNull();
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
        expect(m.unlit, 'the diffuse pass is `rgbGen lightingDiffuse`, so the gun is lit').toBe(
            false
        );
        expect(m.emissiveLuminance).toBe(UNLIT_LUMINANCE);
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

describe('a shader that never asked for the models texture coordinates', () => {
    /*
     `RB_CalcEnvironmentTexCoords` builds a stage's UVs per frame from the
     reflected view vector. An MD3 drawn only through such stages therefore
     carries whatever UVs its author left in it, and OA's are filler: the four
     health crosses' are arbitrary and `mega_cross.md3`'s are the same `(0, 1)`
     on all 52 vertices. Sampling a spherical environment map at those is what
     the reported bug was -- a pickup covered in torn black and olive patches,
     and a mega health cross drawn in `envmapblue2`'s bottom-left texel, which
     is black.
    */
    it('is flagged when every drawn pass is `tcGen environment`', () => {
        const m = project(`
mediumCross
{
    {
        map textures/effects/envmapligh.tga
        tcMod rotate -76
        tcGen environment
    }
    {
        map textures/effects/envmapyel.tga
        blendfunc add
        tcMod rotate 54
        tcGen environment
    }
}`);

        expect(m.environmentMapped).toBe(true);
    });

    /*
     The ordinary shape, and the reason the flag needs *every* pass: a diffuse
     skin with a chrome highlight over it does name a surface, and `rankStage`
     has already preferred the skin for the albedo.
    */
    it('is not flagged when a real skin is underneath the chrome', () => {
        const m = project(`
models/weapons2/gauntlet/gauntlet
{
    {
        map models/weapons2/gauntlet/gauntlet.tga
        rgbGen lightingDiffuse
    }
    {
        map textures/effects/tinfx.tga
        blendfunc add
        tcGen environment
    }
}`);

        expect(m.environmentMapped).toBe(false);
        expect(m.albedo).toBe('models/weapons2/gauntlet/gauntlet');
    });

    /* A `$whiteimage` pass is not drawn, so it does not vote. */
    it('is not decided by a pass that names no image', () => {
        const m = project(`
textures/test/chrome
{
    {
        map textures/effects/tinfx2.tga
        tcGen environment
    }
    {
        map $whiteimage
        blendfunc filter
    }
}`);

        expect(m.environmentMapped).toBe(true);
    });

    /*
     Flatness and blend are two independent statements about one image and both
     have to reach the bundle, because an additive shell is flattened *and* then
     restated as coverage. One `#` either way, so `texturePathOf` still answers.
    */
    it('names a flattened reference distinctly from the same image unflattened', () => {
        const path = 'textures/effects/mediumhelth';

        expect(textureKey(path, 'opaque')).toBe(path);
        expect(textureKey(path, 'opaque', true)).toBe(`${path}#flat`);
        expect(textureKey(path, 'addAlpha', true)).toBe(`${path}#addAlpha.flat`);
        expect(textureKey(path, 'addAlpha', true)).not.toBe(textureKey(path, 'addAlpha'));

        expect(texturePathOf(textureKey(path, 'addAlpha', true))).toBe(path);
        expect(derivedTextureKey(path, 'orm', true)).toBe(`${path}#orm.flat`);
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

/*
 * The env-mapped pickups, checked against what the pipeline actually wrote.
 *
 * The rule tests above prove the projection recognises them. This proves the
 * consequence reached disk, which is the half the reported bug lived in: the
 * material was right about everything except that its albedo was a 64x64 chrome
 * reflection being sampled at texture coordinates nobody had ever read.
 */
describe('an env-mapped materials images are one texel', () => {
    interface Bundle {
        readonly materials: readonly {
            name: string;
            albedo: string | null;
            orm: string | null;
            emissive: string | null;
        }[];
        readonly textures: Readonly<Record<string, string | null>>;
    }

    const index = new ShaderIndex(EXTRACTED).load();
    const bundle = JSON.parse(
        readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
    ) as Bundle;
    const textureDir = join(BUILT, 'models', 'textures');

    const envMapped = bundle.materials.filter((m) => index.material(m.name).environmentMapped);

    it('finds them in the bundle at all', () => {
        // The four health crosses, their four shells, and fourteen others.
        expect(envMapped.length).toBeGreaterThanOrEqual(8);
        expect(envMapped.map((m) => m.name)).toEqual(
            expect.arrayContaining(['smallCross', 'mediumCross', 'largeCross', 'megaCross'])
        );
    });

    it.each(['albedo', 'orm', 'emissive'] as const)(
        'wrote every %s of one as a single texel',
        async (slot) => {
            const wrong: string[] = [];

            for (const m of envMapped) {
                const key = m[slot];
                if (key === null) continue;

                const file = bundle.textures[key];
                if (!file) continue;

                const meta = await sharp(join(textureDir, file)).metadata();
                if (meta.width !== 1 || meta.height !== 1) {
                    wrong.push(`${m.name} ${slot} -> ${file} is ${meta.width}x${meta.height}`);
                }
            }

            expect(wrong).toEqual([]);
        }
    );

    /*
     The mean, and specifically not the corner. `mega_cross.md3` and all four
     shells put every vertex at `(0, 1)`, so before this they drew exactly one
     texel of their image: black for the mega cross, and a coverage of 1/255 --
     nothing at all -- for the shells.
    */
    it('took the images mean and not whichever texel the UVs happened to land on', async () => {
        const mega = envMapped.find((m) => m.name === 'megaCross')!;
        const file = bundle.textures[mega.albedo!]!;

        const raw = await sharp(join(textureDir, file))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        // `envmapblue2.jpg` is a blue chrome map on black; its corner is (0, 0, 0).
        expect([raw.data[0], raw.data[1], raw.data[2]]).not.toEqual([0, 0, 0]);
        expect(raw.data[2], 'and it is blue, which is what a mega health is').toBeGreaterThan(
            raw.data[0]!
        );
    });

    /*
     A generated ORM's mean *is* the classified roughness -- the variation was
     scattered around it -- so flattening it keeps the number the table names
     while dropping the part that depended on the UVs. `greenchrm`'s spread runs
     0.03 to 1.00, a mirror to a matte over one small health cross.
    */
    it('kept the classified roughness when it flattened the ORM', async () => {
        const small = envMapped.find((m) => m.name === 'smallCross')!;

        // The key is owed whether or not the generator has run, and it has to
        // say `flat` -- an ORM sampled at UVs that mean nothing is the same bug
        // as an albedo sampled at them.
        expect(small.orm).toBe('textures/oafx/greenchrm#orm.flat');

        /*
         The pixels can only be checked when there is a file, which is the whole
         of what `writeDerivedTexture` promises: `assets/generated/materials` is
         a separate pipeline stage and a bundle built without it is a valid
         bundle. Guarded rather than asserted, so a clean tree does not fail a
         suite over an artefact `material-maps.ts --check` already owns.
        */
        const file = bundle.textures[small.orm!];
        if (!file) return;

        const raw = await sharp(join(textureDir, file))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const rule = classify('smallCross', loadSpec())!;
        expect(raw.data[1]! / 255).toBeCloseTo(rule.roughness, 1);
        expect(raw.data[2]! / 255).toBeCloseTo(rule.metalness, 1);
    });
});

/*
 * The texture coordinates, which turned out to be mirrored on every surface in
 * the game and to have been that way since phase 1.
 *
 * Q3 and glTF agree: coordinate zero is the image's *top* row. Q3's loaders
 * normalise to top-row-first before upload and `glTexImage2D` puts buffer row 0
 * at `t = 0`; glTF says (0, 0) is the upper-left corner and meep's loader passes
 * `TEXCOORD_0` through untouched. `1 - t` is therefore not a translation between
 * two conventions, it is a mirror -- and a mirrored brick wall is still a brick
 * wall, which is why it survived six phases and a screenshot review.
 *
 * What caught it is the one surface where up and down are not interchangeable.
 */
describe('texture coordinates keep Q3s orientation', () => {
    interface Bundle {
        readonly materials: readonly { name: string; albedo: string }[];
        readonly textures: Readonly<Record<string, string | null>>;
        readonly meshes: readonly {
            material: number;
            vertexOffset: number;
            vertexCount: number;
        }[];
        readonly vertexStride: number;
        readonly vertexBytes: number;
    }

    function geometry(map: string): { bundle: Bundle; verts: Float32Array } {
        const bundle = JSON.parse(
            readFileSync(join(BUILT, map, 'scene.json'), 'utf8')
        ) as Bundle;
        const bin = readFileSync(join(BUILT, map, 'geometry.bin'));
        const verts = new Float32Array(
            bin.buffer.slice(bin.byteOffset, bin.byteOffset + bundle.vertexBytes)
        );
        return { bundle, verts };
    }

    /*
     `textures/sfx/beam` on `oa_dm1` is a light shaft: four faces of a volume
     hanging off a ceiling fixture, textured with a gradient that is bright for
     the top third of the image and black for the rest. Which end of it is bright
     is not a matter of taste, and Q3 gives its ceiling end `t = 0`.
    */
    it('puts the bright end of a light shaft at the lamp', async () => {
        const { bundle, verts } = geometry('oa_dm1');
        const stride = bundle.vertexStride;

        const index = bundle.materials.findIndex((m) => m.name === 'textures/sfx/beam');
        expect(index, 'oa_dm1 still has the light shaft').toBeGreaterThanOrEqual(0);

        let top: { y: number; v: number } | null = null;
        let bottom: { y: number; v: number } | null = null;

        for (const mesh of bundle.meshes) {
            if (mesh.material !== index) continue;
            for (let i = 0; i < mesh.vertexCount; i++) {
                const o = (mesh.vertexOffset + i) * stride;
                const p = { y: verts[o + 1]!, v: verts[o + 7]! };
                if (top === null || p.y > top.y) top = p;
                if (bottom === null || p.y < bottom.y) bottom = p;
            }
        }

        expect(top, 'the shaft has vertices').not.toBeNull();
        expect(bottom!.y).toBeLessThan(top!.y - 1);

        // Q3's own coordinate, unmirrored: the ceiling end is V = 0.
        expect(top!.v).toBeCloseTo(0, 2);
        expect(bottom!.v).toBeCloseTo(1, 2);

        /*
         And end to end, through the restated image: the coverage the OIT pass
         reads has to be higher at the lamp than at the floor. Asserting the UV
         alone would still pass if the gradient were ever rewritten.
        */
        const file = bundle.textures[bundle.materials[index]!.albedo]!;
        const image = await sharp(join(BUILT, 'oa_dm1', 'textures', file))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const { width, height } = image.info;
        const alphaAtV = (v: number): number => {
            const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
            let sum = 0;
            for (let x = 0; x < width; x++) sum += image.data[(y * width + x) * 4 + 3]!;
            return sum / width;
        };

        expect(alphaAtV(top!.v), 'coverage at the lamp').toBeGreaterThan(alphaAtV(bottom!.v) + 32);
    });

    /*
     The general form of the same claim, which is what would have caught it
     without anybody noticing a beam: on a vertical wall Q3's `t` grows
     *downward*, so the image's top row lands at the top of the wall. Not every
     face -- a mapper is free to mirror one deliberately, and a few hundred do --
     but the great majority, and a whole-set mirror flips the ratio rather than
     shifting it.
    */
    it.each(['oa_dm1', 'aggressor', 'am_thornish'])(
        'grows V downward on a vertical wall, as Q3 does [%s]',
        (map) => {
            const { bundle, verts } = geometry(map);
            const stride = bundle.vertexStride;

            let upright = 0;
            let mirrored = 0;

            for (const mesh of bundle.meshes) {
                for (let i = 0; i + 2 < mesh.vertexCount; i += 3) {
                    const tri = [0, 1, 2].map((k) => {
                        const o = (mesh.vertexOffset + i + k) * stride;
                        return { y: verts[o + 1]!, ny: verts[o + 4]!, v: verts[o + 7]! };
                    });

                    // Vertical faces only: a floor's V runs along a horizontal axis.
                    if (Math.abs(tri[0]!.ny) > 0.3) continue;

                    const ys = tri.map((p) => p.y);
                    if (Math.max(...ys) - Math.min(...ys) < 0.25) continue;

                    const high = tri[ys.indexOf(Math.max(...ys))]!;
                    const low = tri[ys.indexOf(Math.min(...ys))]!;
                    if (high.v === low.v) continue;

                    if (high.v < low.v) upright += 1;
                    else mirrored += 1;
                }
            }

            expect(upright + mirrored, 'vertical faces to judge').toBeGreaterThan(100);
            expect(
                upright / (upright + mirrored),
                `${map}: ${upright} upright against ${mirrored} mirrored`
            ).toBeGreaterThan(0.6);
        }
    );
});

/*
 * The emissive, which is a luminance in cd/m2 sitting beside a diffuse term
 * computed from photometric lights -- meep adds them together and says so:
 * `outgoing_light = diffuse + specular + emissive`.
 *
 * It was `q3map_surfacelight / 1000`, which is not in any unit. That put a
 * ceiling panel at 0.3 while the wall it lit sat at several cd/m2, so every
 * light fixture in the game was dimmer than what it illuminated, and the field
 * was called an intensity so nothing said otherwise (D-085).
 */
describe('a light fixture is as bright as the light it emits', () => {
    interface Bundle {
        readonly materials: readonly {
            name: string;
            emissive: string | null;
            emissiveLuminance: number;
            surfaceLight: number;
            unlit: boolean;
        }[];
        readonly meshes: readonly {
            material: number;
            vertexOffset: number;
            indexOffset: number;
            indexCount: number;
        }[];
        readonly lights: readonly { lumens: number; material?: number }[];
        readonly vertexStride: number;
        readonly vertexBytes: number;
        readonly indexBytes: number;
    }

    /** Summed triangle area per material index, in scene square metres. */
    function areaByMaterial(map: string, bundle: Bundle): Map<number, number> {
        const bin = readFileSync(join(BUILT, map, 'geometry.bin'));
        const base = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
        const verts = new Float32Array(base, 0, bundle.vertexBytes / 4);
        const indices = new Uint32Array(base, bundle.vertexBytes, bundle.indexBytes / 4);
        const stride = bundle.vertexStride;

        const area = new Map<number, number>();

        for (const mesh of bundle.meshes) {
            let sum = 0;
            for (let i = 0; i < mesh.indexCount; i += 3) {
                const p = [0, 1, 2].map((k) => {
                    const o = (mesh.vertexOffset + indices[mesh.indexOffset + i + k]!) * stride;
                    return [verts[o]!, verts[o + 1]!, verts[o + 2]!];
                });
                const u = [
                    p[1]![0]! - p[0]![0]!,
                    p[1]![1]! - p[0]![1]!,
                    p[1]![2]! - p[0]![2]!,
                ];
                const v = [
                    p[2]![0]! - p[0]![0]!,
                    p[2]![1]! - p[0]![1]!,
                    p[2]![2]! - p[0]![2]!,
                ];
                sum +=
                    0.5 *
                    Math.hypot(
                        u[1]! * v[2]! - u[2]! * v[1]!,
                        u[2]! * v[0]! - u[0]! * v[2]!,
                        u[0]! * v[1]! - u[1]! * v[0]!
                    );
            }
            area.set(mesh.material, (area.get(mesh.material) ?? 0) + sum);
        }

        return area;
    }

    /*
     A Lambertian emitter radiating flux F over area A has luminance F / (pi A),
     and the port decides F itself -- so the face and the lights standing in
     front of it are one emission described twice, and the arithmetic joining
     them can be checked rather than trusted.

     What F *is* changed at D-105. It used to be one cluster's worth of
     `q3map_surfacelight` per fixture, so this asserted that the luminance came
     back as a whole number of clusters; that number is now whatever the
     lightgrid fit settled on and is a whole number of nothing. The pairing it
     was really testing survives intact, because each surface light records the
     material it came out of: sum their flux, divide by the area, and it has to
     be the luminance that shipped.

     Which is the stronger form of the same check. The old one could be
     satisfied by any rule that happened to land on an integer multiple; this
     one only by the two actually being derived from each other.
    */
    /** Declared emitters seen per map, so the aggregate check below can be sure. */
    const checked = new Map<string, number>();

    it.each(MAPS)('derives it from the flux it placed, not from a divisor [%s]', (map) => {
        const bundle = JSON.parse(
            readFileSync(join(BUILT, map, 'scene.json'), 'utf8')
        ) as Bundle;
        const area = areaByMaterial(map, bundle);

        /** Flux actually placed in front of each material, in lumens. */
        const flux = new Map<number, number>();
        for (const l of bundle.lights) {
            if (l.material === undefined) continue;
            flux.set(l.material, (flux.get(l.material) ?? 0) + l.lumens);
        }

        let declared = 0;

        bundle.materials.forEach((m, i) => {
            if (m.surfaceLight <= 0 || m.emissive === null) return;

            const a = area.get(i);
            if (a === undefined || a === 0) return;

            declared += 1;

            /*
             A surface that is both declared and unlit takes whichever of the two
             is larger, so lava is not made dimmer than an ordinary unlit texture
             by 666 lumens spread over 38 square metres. Same for a fixture the
             fit drove to nothing, which is on the floor for the same reason and
             by the same rule. Either way the shipped number is the floor and
             says nothing about the flux, so there is nothing here to check.
            */
            if (m.emissiveLuminance === UNLIT_LUMINANCE) return;

            const expected = (flux.get(i) ?? 0) / (Math.PI * a);

            expect(
                Math.abs(m.emissiveLuminance - expected) / Math.max(expected, 1e-9),
                `${map}: ${m.name} ships ${m.emissiveLuminance.toFixed(1)} cd/m2, ` +
                `but its ${(flux.get(i) ?? 0).toFixed(0)} lm over ${a.toFixed(1)} m2 ` +
                `is ${expected.toFixed(1)}`
            ).toBeLessThan(1e-6);

            /*
             And not a face lit by nothing. A material that declared a light and
             kept a luminance above the floor must have flux behind it -- that is
             the pairing, and zero on either side with a number on the other is
             the failure this whole block is for.
            */
            expect(
                flux.get(i) ?? 0,
                `${map}: ${m.name} glows at ${m.emissiveLuminance.toFixed(1)} cd/m2 with no light behind it`
            ).toBeGreaterThan(0);
        });

        checked.set(map, declared);
    });

    /*
     `oa_dm5` is the map whose author lit it with `light` entities: it has no
     `q3map_surfacelight` shader anywhere and reconstructs entirely from the
     lightgrid (Q-006). So the count is asserted over the set rather than per
     map, which is what stops the check above from quietly checking nothing.
    */
    it('has declared emitters to check in the first place', () => {
        const total = [...checked.values()].reduce((a, b) => a + b, 0);

        expect(checked.size, 'every map was visited').toBe(MAPS.length);
        expect(total, 'declared emitters across the set').toBeGreaterThan(10);
        expect(checked.get('oa_dm5'), 'oa_dm5 lights from the grid alone').toBe(0);
    });

    /*
     And the floor the whole thing exists to hold: a surface that Q3 declared as
     a light source must not be dimmer than the placeholder given to a beam
     nobody declared anything about. `surfaceLight / 1000` failed this on eleven
     of the fourteen declared emitters in the set.
    */
    it.each(MAPS)('never leaves a declared emitter below the undeclared floor [%s]', (map) => {
        const bundle = JSON.parse(
            readFileSync(join(BUILT, map, 'scene.json'), 'utf8')
        ) as Bundle;

        const dim = bundle.materials
            .filter((m) => m.surfaceLight > 0 && m.emissive !== null && m.emissiveLuminance < 1)
            .map((m) => `${m.name} at ${m.emissiveLuminance.toFixed(2)} cd/m2`);

        expect(dim, `${map}: declared lights dimmer than an undeclared glow`).toEqual([]);
    });
});

/*
 * Which materials are owed the generated maps, and how a bundle names them.
 *
 * The rule lives in `shaderToPbr` and is one line, but it is the line that
 * decides how much of the material phase there is: 108 of 128 world materials
 * across the six maps, and a rule that quietly said "none of them" would look
 * exactly like a pipeline nobody had run the generator for yet.
 */
describe('which surfaces are owed a normal map and an ORM', () => {
    /** Only the field the two bundle-reading cases below actually look at. */
    interface Bundle {
        materials: { name: string }[];
    }

    it('gives an ordinary lit wall both, named for the image and not for the blend', () => {
        const m = project(`
textures/gothic_block/blocks10
{
    {
        map $lightmap
        rgbGen identity
    }
    {
        map textures/gothic_block/blocks10.tga
        blendFunc GL_DST_COLOR GL_ZERO
    }
}`);

        expect(m.albedo).toBe('textures/gothic_block/blocks10');
        expect(m.normal).toBe(m.albedo);
        expect(m.orm).toBe(m.albedo);

        expect(derivedTextureKey(m.normal!, 'normal')).toBe(
            'textures/gothic_block/blocks10#normal'
        );
        expect(derivedTextureKey(m.orm!, 'orm')).toBe('textures/gothic_block/blocks10#orm');
    });

    /*
     The distinction that costs nothing on an opaque wall and everything here: a
     Q3 image referenced through two blends is two files and two `textureKey`s,
     but it is one piece of artwork and therefore one normal map. Keying the
     generated maps off the texture key instead would generate the same image
     twice and bind the wrong copy to whichever material was converted second.
    */
    it('keys the generated maps by the image, where the albedo is keyed by the blend too', () => {
        const grate = project(`
textures/base_support/metalbase09_ow
{
    {
        map textures/base_support/metalbase09_ow.tga
        alphaFunc GE128
        depthWrite
        rgbGen identity
    }
    {
        map $lightmap
        blendFunc GL_DST_COLOR GL_ZERO
        depthFunc equal
    }
}`);

        expect(grate.transparency, 'alphaFunc on stage 0 is a mask').toBe('mask');
        expect(grate.normal, 'an alpha-tested surface is still a surface').toBe(grate.albedo);

        // Same image, two names: one carries the blend, one does not.
        expect(textureKey(grate.albedo!, grate.albedoBlend)).not.toBe(grate.albedo);
        expect(derivedTextureKey(grate.normal!, 'normal')).toBe(
            'textures/base_support/metalbase09_ow#normal'
        );
    });

    it('refuses an additive beam, whose albedo is coverage with the colour thrown away', () => {
        const m = project(`
textures/sfx/beam
{
    surfaceparm trans
    {
        map textures/sfx/beam.tga
        blendFunc GL_ONE GL_ONE
    }
}`);

        expect(m.transparency, 'an additive stage 0 is transparent').toBe('blend');
        expect(m.normal).toBeNull();
        expect(m.orm).toBeNull();
    });

    it('refuses an unlit surface, which this port emits rather than shades', () => {
        const m = project(`
textures/liquids/lava
{
    surfaceparm lava
    {
        map textures/liquids/lava.tga
        rgbGen identity
    }
}`);

        expect(m.unlit, 'no $lightmap stage anywhere').toBe(true);
        expect(m.normal).toBeNull();
    });

    it('refuses a sky, which is drawn as the environment rather than as a surface', () => {
        const m = project(`
textures/skies/killsky
{
    qer_editorimage textures/skies/killsky.tga
    surfaceparm sky
    q3map_sun 1 1 1 100 0 45
}`);

        expect(m.isSky).toBe(true);
        expect(m.normal).toBeNull();
        expect(m.orm).toBeNull();
    });

    it('refuses a material with no albedo to derive anything from', () => {
        const m = project(`
textures/common/caulk
{
    surfaceparm nodraw
    surfaceparm nolightmap
}`);

        expect(m.albedo).toBeNull();
        expect(m.normal).toBeNull();
        expect(m.orm).toBeNull();
    });

    /*
     The substitution in `ShaderIndex.material` rewrites the albedo when a script
     names an image that is not on disk, and the generated maps are keyed by that
     image. Letting them keep the dead path would ask for a normal map belonging
     to a texture that never existed, which resolves to nothing -- and looks
     exactly like a texture the generator has not reached yet.
    */
    it('follows the albedo when a dead script reference is substituted', () => {
        const index = new ShaderIndex(EXTRACTED).load();

        const substituted = [...MAPS]
            .flatMap((map) => {
                const path = join(BUILT, map, 'scene.json');
                if (!existsSync(path)) return [];
                const bundle = JSON.parse(readFileSync(path, 'utf8')) as Bundle;
                return bundle.materials.map((m) => m.name);
            })
            .map((name) => index.material(name))
            .filter((m) => m.normal !== null && m.normal !== m.albedo);

        expect(
            substituted.map((m) => `${m.name}: albedo ${m.albedo}, normal ${m.normal}`),
            'a generated map pointing at an image the material does not use'
        ).toEqual([]);
    });

    it('agrees with the map bundles about how many surfaces are in scope', () => {
        const index = new ShaderIndex(EXTRACTED).load();

        const seen = new Map<string, PbrMaterial>();
        for (const map of MAPS) {
            const path = join(BUILT, map, 'scene.json');
            if (!existsSync(path)) continue;
            const bundle = JSON.parse(readFileSync(path, 'utf8')) as Bundle;
            for (const m of bundle.materials) seen.set(m.name, index.material(m.name));
        }

        const inScope = [...seen.values()].filter((m) => m.normal !== null);

        // Measured 2026-08-26 over the six built maps. Pinned because the number
        // is the size of the job, and a change to the rule that halves it should
        // be a failing test rather than a quiet saving.
        expect(seen.size, 'world materials across the six maps').toBe(128);
        expect(inScope.length, 'of those, owed generated maps').toBe(108);
    });
});

/*
 * The hand table, and the property that makes generating the other channels in
 * bulk safe: nothing reaches a bundle without somebody having looked at it.
 *
 * `node tools/material-matrix.ts --check` is the enforcement and runs in
 * `npm run check`. These cases are here because the check can only fail on what
 * has been built, and because the interesting property is not "the current set
 * passes" but "a material nobody has classified does not quietly get a default".
 */
describe('the hand-authored material table', () => {
    const spec = loadSpec();
    const index = new ShaderIndex(EXTRACTED).load();

    it('covers every material that is owed generated maps', () => {
        const unclassified = [...inScopeNames(index).keys()]
            .filter((name) => classify(name, spec) === null)
            .sort();

        expect(unclassified, 'materials with no rule and no entry').toEqual([]);
    });

    /*
     The whole point. `trap-classification.json` has the same property and it is
     what makes `--check` mean anything: a catch-all rule would turn every future
     omission into a silent 0.85, which is the placeholder this phase exists to
     replace.
    */
    it('has no catch-all, so a texture family nobody has seen fails rather than defaults', () => {
        for (const name of [
            'textures/some_new_map/wall01',
            'models/mapobjects/statue/marble',
            'NewPowerupSkin',
        ]) {
            expect(classify(name, spec), `${name} should be unclassified`).toBeNull();
        }
    });

    it('states metalness as a bit and roughness inside GGX-stable range', () => {
        const bad: string[] = [];
        for (const name of inScopeNames(index).keys()) {
            const rule = classify(name, spec)!;
            if (rule.metalness !== 0 && rule.metalness !== 1) bad.push(`${name}: metalness ${rule.metalness}`);
            if (!(rule.roughness >= 0.03 && rule.roughness <= 1)) bad.push(`${name}: roughness ${rule.roughness}`);
        }
        expect(bad).toEqual([]);
    });

    /*
     Rust is iron oxide. It is the most common way to get a PBR set wrong,
     because the name says metal and the physics does not, and a rusted surface
     shaded as a conductor reads as a mirror exactly where the paint has failed.
     Pinned by name because these are the four families where the mistake was
     available.
    */
    it('classifies corrosion as a dielectric and the metal under it as metal', () => {
        for (const rusted of [
            'textures/base_trim/deeprust',
            'textures/gothic_trim/pitted_rust',
            'textures/gothic_trim/pitted_rust3_black',
            'textures/acc_dm5/rust',
        ]) {
            expect(classify(rusted, spec)?.metalness, rusted).toBe(0);
        }

        for (const metal of [
            'textures/base_trim/pewter',
            'textures/base_wall/bluemetal1b_chrome',
            'textures/gothic_floor/q1metal7_99stair',
            'textures/acc_dm3/rivets',
        ]) {
            expect(classify(metal, spec)?.metalness, metal).toBe(1);
        }
    });

    /*
     A variant letter is not a suffix on the same material. `e8_base1` is a steel
     hatch and `e8_base1c` is brick, and prefix rules cannot tell them apart --
     which is what `entries` is for, and is worth a case because the rule reads
     as if it covers both.
    */
    it('lets an entry override a prefix rule that would be wrong', () => {
        expect(classify('textures/e8/e8_base1', spec)?.metalness).toBe(1);
        expect(classify('textures/e8/e8_base1c', spec)?.metalness).toBe(0);
    });

    /*
     Sixteen materials in the set are not artwork of a surface at all -- Q3
     `tcGen environment` fake reflections, powerup shells, glyphs on black. They
     are in scope by the mechanical rule because their shaders are opaque and lit,
     and a normal map for them would be the network inventing relief in a starburst.
    */
    it('refuses a normal map for the effect surfaces', () => {
        const dropped = [...inScopeNames(index).keys()].filter(
            (n) => classify(n, spec)?.normal === 'drop'
        );

        expect(dropped.length, 'materials with the normal map switched off').toBe(16);
        expect(classify('quadDamage', spec)?.effect).toBe(true);
        expect(classify('textures/gothic_block/blocks10', spec)?.normal).toBeUndefined();
    });
});

/*
 `am_thornish`'s window panels, written out as `evil8.shader` has them: one
 `blendfunc add` pass of an environment map over a lightmap, which is Q3 for "a
 clear pane with a chrome reflection on it".
*/
const DSIGLASS = `
textures/dsi/dsiglass
{
    qer_editorimage textures/dsi/dsiglass.tga
    surfaceparm trans
    cull disable
    qer_trans 0.5
    {
        map textures/effects/tinfx.tga
        blendfunc add
        rgbGen identity
        tcGen environment
    }
    {
        map $lightmap
        blendfunc filter
        rgbGen identity
        tcGen lightmap
    }
}`;

describe('a pane of glass is a transparent interface and not a transparent image', () => {
    it('transmits, at plate glass', () => {
        const m = project(DSIGLASS);

        expect(m.transparency).toBe('blend');
        expect(m.transmission, 'clear: no diffuse base left at all').toBe(1);
        expect(m.ior, 'F0 = 0.04').toBe(1.5);
    });

    /*
     `derivedFrom` refuses a generated ORM to anything blended, so a blended
     material's `roughness` is the number the renderer uses rather than a
     multiplier over a sampled one. At the 0.85 default the Fresnel reflection --
     which is the only thing a fully transmissive surface has left -- smears into
     the haze this change is about.
    */
    it('is smooth, because a blended material has no ORM to carry roughness for it', () => {
        const m = project(DSIGLASS);

        expect(m.orm).toBeNull();
        expect(m.roughness).toBeLessThan(0.2);
    });

    it('stops emitting the fake reflection that is now computed for real', () => {
        const m = project(DSIGLASS);

        expect(m.emissive, 'a `tcGen environment` pass is a reflection, not a glow').toBeNull();
        expect(m.emissiveLuminance).toBe(0);
    });

    /*
     The rule that this table exists instead of. "Blended, and every drawn stage
     `tcGen environment`" describes `dsiglass` exactly -- and describes 31
     shaders in the OA set, 25 of which are powerup shells. Zeroing a quad
     shell's diffuse and handing its coverage to view-angle Fresnel is the
     correct treatment of a window and the deletion of a powerup.
    */
    it('does not catch a powerup shell, which has the identical shader shape', () => {
        const m = project(`
powerups/quad
{
    cull none
    {
        map models/powerups/quad.tga
        blendfunc add
        rgbGen identity
        tcGen environment
    }
}`);

        expect(m.environmentMapped, 'the same structural signal as the glass').toBe(true);
        expect(m.transparency).toBe('blend');
        expect(m.transmission, 'and still a shell rather than a window').toBe(0);
        expect(m.emissive, 'so it keeps the glow that is all it is').not.toBeNull();
    });
});

describe('a liquid reflects like the liquid it is', () => {
    /*
     The clear pool family: `gl_dst_color gl_one` passes of the pool3d images
     under a lightmap, `surfaceparm water`, and `clear` in the name. This is
     `am_thornish` and `oa_dm7`'s water.
    */
    it('gives clear water transmission and waters own index', () => {
        const m = project(`
textures/liquids/clear_calm1
{
    qer_editorimage textures/liquids/pool3d_5e.jpg
    surfaceparm trans
    surfaceparm nonsolid
    surfaceparm water
    cull none
    {
        map textures/liquids/pool3d_5e.jpg
        blendFunc gl_dst_color gl_one
        rgbgen identity
        tcmod turb .04 .01 .5 .03
    }
    {
        map $lightmap
        blendFunc gl_dst_color gl_zero
        rgbgen identity
    }
}`);

        expect(m.transmission).toBe(1);
        expect(m.ior, 'F0 = 0.02, half of glass').toBeCloseTo(1.333, 3);
        expect(m.emissive, 'the brightening passes were never a glow either').toBeNull();
    });

    /*
     meep carries no per-channel transmission tint, and says so: for coloured or
     dark liquid the legacy alpha-blend path is the authoring path. Transmission
     would throw the brown away and leave clear water in a mud pit. The index is
     the part that is true of water however it was drawn, and it is the part
     this surface was getting wrong.
    */
    it('leaves a murky water alpha-blended, and still fixes its Fresnel', () => {
        const m = project(`
textures/acc_dm5/brwnwater
{
    surfaceparm trans
    surfaceparm nonsolid
    surfaceparm water
    cull disable
    {
        map textures/acc_dm5/brwnwater.tga
        blendFunc blend
        tcmod scroll .025 -.001
    }
}`);

        expect(m.transmission, 'still an image, not an interface').toBe(0);
        expect(m.transparency).toBe('blend');
        expect(m.ior).toBeCloseTo(1.333, 3);
    });

    /*
     Five shaders in `liquid_lavas.shader` declare `surfaceparm water` beside
     `surfaceparm lava`. That pairing says "a liquid volume you can be inside
     of", not "this liquid is water", and molten rock is neither aqueous nor
     something this port can measure.
    */
    it('does not read lavas stray `surfaceparm water` as water', () => {
        const m = project(`
textures/liquids/lavahell
{
    qer_editorimage textures/liquids/lavahell.tga
    q3map_lightimage textures/liquids/lavafloor.tga
    surfaceparm nolightmap
    surfaceparm trans
    surfaceparm nomarks
    surfaceparm lava
    surfaceparm water
    q3map_surfacelight 3000
    cull disable
    {
        map textures/liquids/lavahell.tga
        tcmod scroll .05 .05
    }
}`);

        expect(m.ior).toBe(1.5);
        expect(m.transmission).toBe(0);
    });

    /*
     A declared `q3map_surfacelight` is a statement about the surface rather
     than an artefact of how it was blended, and `convert-map.ts` fits a real
     light to it, so the emissive survives the drop that the glass gets.
    */
    it('keeps a declared emitters emissive even where it transmits', () => {
        const m = project(`
textures/liquids2/clear_ripple1_q3dm1light
{
    qer_editorimage textures/liquids/pool3d_5e.jpg
    surfaceparm trans
    surfaceparm nonsolid
    surfaceparm water
    q3map_surfacelight 100
    cull disable
    {
        map textures/liquids/pool3d_5e.jpg
        blendFunc gl_dst_color gl_one
        rgbgen identity
    }
    {
        map textures/effects/sky.jpg
        tcgen environment
        blendfunc add
        rgbgen vertex
    }
}`);

        expect(m.transmission).toBe(1);
        expect(m.emissive).not.toBeNull();
        expect(m.emissiveLuminance).toBeGreaterThan(0);
    });
});

describe('the built maps carry the transmissive surfaces', () => {
    interface TransBundle {
        readonly materials: readonly {
            readonly name: string;
            readonly transmission?: number;
            readonly ior?: number;
            readonly roughness: number;
            readonly emissive: string | null;
        }[];
    }

    const built = MAPS.map((name) => ({
        name,
        bundle: JSON.parse(
            readFileSync(join(BUILT, name, 'scene.json'), 'utf8')
        ) as TransBundle,
    }));

    it('has am_thornishs glass, transmitting and no longer glowing', () => {
        const map = built.find((b) => b.name === 'am_thornish')!;
        const glass = map.bundle.materials.find((m) => m.name === 'textures/dsi/dsiglass');

        expect(glass, 'am_thornish still has its window panels').toBeDefined();
        expect(glass!.transmission).toBe(1);
        expect(glass!.ior).toBe(1.5);
        expect(glass!.roughness).toBeLessThan(0.2);
        expect(glass!.emissive).toBeNull();
    });

    /*
     The water in the shipped six, named rather than pattern-matched, because
     the name is precisely the thing that does not say: `acc_dm5/fx_waterfall`
     and `acc_dm5/watershore` both have `water` in them and neither declares
     `surfaceparm water`. They are the foam and spray sprites -- the one part of
     water that really is diffuse rather than an interface -- and they stay at
     plate glass along with everything else that is not a liquid.
    */
    const WATER = new Set([
        'textures/liquids/clear_calm1', // am_thornish, oa_dm7
        'textures/acc_dm5/brwnwater', // oa_dm5
        'textures/liquids/tele', // aggressor
    ]);

    it('gives every surface Q3 called water the index of water, and nothing else', () => {
        const seen = new Set<string>();

        for (const { name, bundle } of built) {
            for (const m of bundle.materials) {
                if (WATER.has(m.name)) {
                    seen.add(m.name);
                    expect(m.ior, `${name}: ${m.name}`).toBeCloseTo(1.333, 3);
                } else {
                    expect(m.ior, `${name}: ${m.name}`).toBe(1.5);
                }
            }
        }

        expect(seen, 'every liquid named here is in a shipped map').toEqual(WATER);
    });

    /*
     The whole-set invariant, and the one that would catch a rule quietly
     growing back: nothing transmits unless it was named, and everything else
     sits on meep's own default.
    */
    it('leaves every unlisted surface opaque-based and at plate glass', () => {
        for (const { name, bundle } of built) {
            for (const m of bundle.materials) {
                const listed = TRANSMISSIVE[m.name.toLowerCase()];
                if (listed === undefined) {
                    expect(m.transmission, `${name}: ${m.name}`).toBe(0);
                } else {
                    expect(m.transmission, `${name}: ${m.name}`).toBe(listed.transmission);
                    expect(m.roughness, `${name}: ${m.name}`).toBe(listed.roughness);
                }
            }
        }
    });
});
