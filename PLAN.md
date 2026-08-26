# Plan: Phase 8 — surface materials and volumetric lighting

Forward-looking. `DECISIONS.md` records what was decided, `REPORT.md` what was measured; this is
what is intended and has not happened yet. Each step names its exit criterion, because a step that
cannot be checked is a wish.

Every material in the port currently ships `roughness = 0.85`, `metallic = 0`, no ORM and no normal
map -- 93 of 93 on `oa_dm1`, read out of the live engine. That is `shader-to-pbr.ts`'s deliberate
placeholder -- Q3 had no notion of either quantity, so both were "conventions rather than data",
and a uniform rough dielectric was the least-wrong default. It has outlived its usefulness: the
pipeline now reconstructs 33 to 147 real point lights per map (D-012, D-078) and every surface they
fall on is geometrically and materially flat.

---

## What the target is

Per material, three images where today there is one:

| slot | carries | source |
|---|---|---|
| `texture_albedo` | de-lit base colour | network, verified by round-trip |
| `texture_normal` | tangent-space normal | network |
| `texture_orm` | G = roughness, B = metalness, R = 1.0 | network for G, hand table for B |

The R channel stays at 1.0. meep runs GTAO, which samples the g-buffer *shading* normal
(`fragment_shader_gtao.js`) and writes its own visibility and bent-normal targets, so occlusion
follows the normal map for free and a baked AO channel would only fight it.

Nothing here requires engine code, a shader, or a render pass. `INITIAL_INSTRUCTIONS.md` §3 forbids
all three; binding textures the engine already declares is the material system being used as
intended.

---

## What is already established

Measured 2026-08-26 against `1955216`, meep 3.2.0, RTX 4090. Full workings in the accompanying
recommendation; the numbers that drive the plan:

- **The texture set is mostly one material per image.** Two-means clustering in Lab over the 182
  world and prop candidates puts the median separation between cluster centres, in hue alone, at
  **3.6**. 61 clear a hue separation of 8 with a minority cluster above 12%, and the genuine
  metal-against-dielectric boundaries among those sit in the weapons, pickups and characters.
- **Roughness is the visible channel.** Peak GGX response is `1/(pi a^2)`, so 0.85 -> 0.35 is a
  **35x** brighter highlight and 0.85 -> 0.5 is 8.4x.
- **Metalness pays for itself immediately.** F0 goes from 0.04 to the albedo, which is **5.5x** on
  the direct highlight at every roughness for pewter at 0.22. It does not wait on the environment;
  environment quality decides whether the reflection is *right*, not whether the surface reads as
  metal.
- **223 materials in scope** -- 108 world across six maps, 74 static props, 41 character. 39 are
  excluded as blended, unlit, or having no albedo at all.
- **Resolution is the risk.** Median 256 square, 58 at 128, 90 at 512.

---

## Steps

### Step 1 — pilot the network, and measure it by round-trip

Eight textures through **Cosmos DiffusionRenderer** (`nvidia/Diffusion_Renderer_Inverse_Cosmos_7B`,
NVIDIA Open Model License -- commercial use and outputs permitted, unlike RGB↔X's Adobe Research
License, which cannot ship out of a GPLv2 repo and is therefore a benchmark only).

Chosen to span the failure modes rather than to flatter: a tiling stone
(`gothic_block/blocks10`), a tiling metal (`acc_dm3/rivets`), a mixed-material world texture
(`acc_dm3/cop`), a dark low-contrast wall (`e7/e7brnmetal`), two weapon skins (`railgun/skin`,
`shotgun`), `redarmor`, and one character skin.

**The round-trip is the test.** The original texture is the appearance its artist intended. De-light
it, extract the normal, relight the extracted maps under a light matching the implied one, and
compare against the original. That is a real error metric on a flat quad and it fails loudly when
the network invents detail, which is the answer to "an inferred material has no ground truth".

*Exit criterion:* a per-channel verdict -- keep, keep-with-correction, or author by hand -- backed
by the round-trip error and by a tiling check on the two wrapping textures. The expectation going in
is albedo and normal good, roughness usable, metalness weakest; the expectation is not the result.

### Step 2 — carry the slots through the pipeline

Independent of step 1 and runnable alongside it, because the plumbing is the same whatever the
images turn out to be.

- `shader-to-pbr.ts`: `PbrMaterial` gains `normal` and `orm` alongside `albedo`.
- `texture-out.ts`: writes both. Neither is a Q3 blend product, so they bypass the `ImageBlend`
  restatements entirely -- a normal map has no alpha semantics to preserve and must not be
  premultiplied.
- `convert-map.ts` / `convert-models.ts` / `convert-characters.ts`: emit the references.
- `bundle.ts`: binds `texture_normal` and `texture_orm`. Nothing needs changing for tangents --
  `MeshletBatch` already calls `Geometry.ensureTangents()`, and meep derives them from UV0 by
  Lengyel's method.

*Exit criterion:* `npm run check` green, and a material with a normal map bound renders with
per-texel lighting variation under a point light in `?fly=1`.

### Step 3 — generate the set

Whatever channels survived step 1, across all 223.

Tiling is handled by tiling the input 3x3 and cropping the centre -- 9x the compute, and it is a
mitigation rather than a guarantee, because attention is not wrap-equivariant. Verified per texture
by comparing opposite edges, not assumed.

*Exit criterion:* every one of the 223 has the channels its verdict called for, and no wrapping
world texture regresses on the edge-continuity check.

### Step 4 — author what the network should not decide

Metalness above all: for most of the set the answer is a single bit, and where it is not, the
boundary is a hard paint edge that a mask states better than an inference does.

A hand-checked `tools/material-classification.json` on the `trap-classification.json` pattern the
repo already runs: `prefixRules` applied in order over the Q3 texture directories -- which are
already named for material families, `gothic_block`, `base_trim`, `evil1_metals`, `e7brnmetal` --
plus per-material overrides, and a `--check` mode wired into `npm run check` that fails on anything
unclassified, exactly as `trap-matrix.mjs --check` does.

This is data, not a heuristic, which is the objection `shader-to-pbr.ts:583` already records against
name-based guessing. It also gives an override channel for every texture the network gets visibly
wrong, which is what makes step 3 safe to run in bulk.

*Exit criterion:* converting a new map fails the check rather than silently shipping it at 0.85.

### Step 5 — SSR, then a baked brick4 volumetric lightmap

Not a gate on metalness, an improvement to it. Worth doing once the maps have something specular to
show.

`feature_ssr_enabled` is a renderer flag and costs nothing to try. Brick4 is the real prize and is
the single best answer to Q-002 and GAP-006 -- the port gave up on importing Q3's lightmap because
meep's lightmapper is a baker with no import path, and brick4 bakes indirect light meep's own way
rather than reconstructing id's.

**This step needs meep 3.3.0.** 3.2.0 has the whole brick4 machinery -- `ShadeIndirectLightingMode.Brick4`,
the specular path that reads roughness out of the g-buffer, and `brick4_bake_for_scene({scene,
renderer, cell_size, max_memory_usage_bytes})`, whose own docblock says it is *"confirmed to work on
RTX 4090"*. What it hands back is a bare `{tree, binary: ArrayBuffer}` with no component to put it
in, so every map would need its own wiring.

3.3.0 adds a **`VolumetricLightMap` component**, which makes brick4 lightmaps straightforward to
use and -- the part that matters here -- gives a simple deserialisation and import path. That fits
this port's shape exactly: bake offline in a tool, write the binary beside the map bundle the way
`geometry.bin` and `collision.bsp` already are, and attach the component at load. Without it the
bake result has nowhere to live but bespoke per-map code.

So: bump the `@woosh/meep-engine` peer dependency to `^3.3.0`, add `tools/bake-lighting.ts` as a
sibling of `convert-map.ts`, emit `lighting.bin` per map, and attach `VolumetricLightMap` in
`bundle.ts`.

*Exit criterion:* `oa_dm1` renders under `ShadeIndirectLightingMode.Brick4` from a bundled bake with
no runtime bake step, and the indoor maps stop taking their ambient from a procedural blue sky.

---

## Risks, named rather than discovered later

- **The network is out of domain.** These models are trained on photographs and photoreal renders of
  scenes; OA's textures are hand-painted, tiling, and stylised. Step 1 exists to find this out on
  eight textures instead of 223.
- **Resolution runs the wrong way.** Cosmos operates at 704x1280 and the median input is 256 square.
  A 4-5x upscale round trip either adds detail or invents it, and the difference is visible
  immediately on a stone wall.
- **Tiling may not survive.** If the 3x3-and-crop does not hold the seam, the world textures fall
  back to step 4's table and only the props and characters take network output. That is a
  degradation, not a failure -- the props and characters are where the multi-material boundaries
  are anyway.
- **3.3.0 may move something else.** The port is pinned at 3.2.0 and the upgrade is not free; it
  belongs in its own commit ahead of step 5, with `npm run check` as the gate.
- **Weights are large.** Roughly 15-20 GB, plus a CUDA torch install. Nothing is committed --
  `ASSETS.md` covers fetched inputs and would gain an entry for the model, its licence, and its
  pinned revision.

## Not in scope

Writing shaders, render passes, or material extensions; patching the engine; deriving height or
normals from albedo luminance, which embosses painted shading rather than recovering surface; and
baking an AO channel into the ORM, which is GTAO's job and would double up with it.

## Ordering

Steps 1 and 2 run in parallel. Step 3 needs 1. Step 4 can start any time and must land before 3 is
trusted in bulk. Step 5 needs the meep bump and nothing else.
