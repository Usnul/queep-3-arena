# Assets: provenance and licensing

No game asset is committed to this repository. Everything below is fetched at setup time by
`node tools/fetch-assets.mjs`, extracted into `assets/` (gitignored), and converted into
engine-ready form by the pipeline in `tools/`.

```bash
node tools/fetch-sources.mjs   # reference C sources, pinned commits
node tools/fetch-assets.mjs    # OpenArena 0.8.8 game data
```

---

## Game data

### OpenArena 0.8.8

| | |
|---|---|
| **Source** | `https://downloads.sourceforge.net/project/oarena/openarena-0.8.8.zip` |
| **Project** | OpenArena, https://openarena.ws/ |
| **Size** | 425,189,255 bytes |
| **SHA-256** | `5a8faf7f5b51f351b0a1618c06b6b98a5f1a6758f1d39818de2c87df2a0bac4a` |
| **Retrieved** | 2026-08-24 |
| **Licence** | GPLv2 for code; the content packs are licensed by their individual authors under GPLv2 / CC-BY-SA / CC-BY, catalogued per-file in `baseoa/CREDITS` and `COPYING` inside the archive. |

The archive ships its own `COPYING` and `readme_088.txt`; both are extracted to
`assets/openarena-0.8.8/` and are the authoritative statement of terms for the content. This
port does not restate them and does not redistribute any of it.

Content packs used:

| pk3 | size | what this port takes from it |
|---|---:|---|
| `baseoa/pak0.pk3` | 38.1 MB | base textures, sounds, `scripts/*.shader`, player models, weapon models |
| `baseoa/pak1-maps.pk3` | 38.4 MB | `maps/*.bsp` — the level geometry |
| `baseoa/pak2-players.pk3` | 74.4 MB | player character models and skins |
| `baseoa/pak4-textures.pk3` | 97.1 MB | the bulk of the world texture set |
| `baseoa/pak5-TA.pk3` | 2.9 MB | Team Arena-equivalent items |
| `baseoa/pak6-misc.pk3` | 24.9 MB | miscellaneous, later additions |
| `baseoa/pak6-patch085.pk3` | 37.0 MB | 0.8.5 patch content — overrides earlier paks |
| `baseoa/pak6-patch088.pk3` | 70.6 MB | 0.8.8 patch content — overrides earlier paks |

Not used: `baseoa/pak2-players-mature.pk3` (alternate character skins, not needed) and
`missionpack/mp-pak0.pk3` (Team Arena gametypes, out of scope for deathmatch).

**Load order matters.** Q3 resolves a virtual path by scanning pk3s in reverse alphabetical
order, so `pak6-patch088.pk3` shadows `pak6-patch085.pk3` shadows `pak4-textures.pk3` and so
on. `tools/extract-pk3.mjs` reproduces that ordering when it flattens the archives, and
records which pk3 each surviving file came from in `assets/extracted/manifest.json`. Getting
this backwards yields 0.8.1-era textures on 0.8.8 maps, which looks like a conversion bug and
is not one.

---

## Reference source code

Neither is committed; both are cloned to `.refs/` (gitignored) at a pinned commit by
`tools/fetch-sources.mjs`.

### OpenArena gamecode

| | |
|---|---|
| **Source** | `https://github.com/OpenArena/gamecode.git` |
| **Commit** | `5478aad23b12857d265103f6aa2f5258c78799c8` (2025-12-20) |
| **Licence** | GPL-2.0-only — Copyright (C) 1999-2005 Id Software, Inc.; Copyright (C) OpenArena contributors |
| **Used for** | Gameplay source of truth: `bg_pmove.c`, balance tables in `bg_misc.c`, entity definitions, the `trap_` inventory. |

OpenArena's fork rather than vanilla Q3, because its balance numbers and entity definitions
are the ones that match the OA asset set.

### ioquake3

| | |
|---|---|
| **Source** | `https://github.com/ioquake/ioq3.git` |
| **Commit** | `588393618dbc82e7207c21c6ddecca229944a03a` (2026-07-19) |
| **Licence** | GPL-2.0-only — Copyright (C) 1999-2005 Id Software, Inc.; Copyright (C) ioquake3 contributors |
| **Used for** | `cm_*` collision reference, and the C translation units the pmove differential-test oracle is compiled from. |

### Cosmos DiffusionRenderer

| | |
|---|---|
| **Source** | `https://github.com/nv-tlabs/cosmos-transfer1-diffusion-renderer.git` (formerly `cosmos1-diffusion-renderer`) |
| **Commit** | `0f3e2dc435032ecbad654c2fc2153df85384b138` |
| **Licence** | Apache-2.0 — Copyright (c) 2025 NVIDIA CORPORATION & AFFILIATES |
| **Used for** | The inference code for the inverse renderer that produces the material maps. Run as fetched: nothing in it is patched, vendored or committed. |

Apache-2.0 is not GPLv2-compatible, which is why this is *fetched and run* rather
than copied in. It is a build-time tool that produces images, in the same way
`sharp` produces images, and none of its code enters this repository or anything
this repository ships.

`cosmos_predict1` is Linux-first and reaches for `transformer-engine`, which has
no Windows build. Rather than patch it, `tools/cosmos/te_shim/` supplies the three
functions its diffusion path actually calls, written from their definitions;
`tools/cosmos/check_shim.py` checks those against independent restatements of the
same maths. `DECISIONS.md` D-091 records the whole of it.

---

## Derived artefacts

Everything the pipeline writes lands in `assets/`, and most of it is now **committed** —
`built/`, `extracted/`, `generated/` and `shots/`, about 1.12 GB over 6,450 files. It is all
derivative of the GPLv2/CC inputs above and carries their terms, which means this repository
now *redistributes* that material rather than only fetching it; the attribution it has to
travel with is the provenance table above.

They are committed because they were once deleted and could not be restored from here (D-104),
and because regenerating them is not the same as restoring them — the material phase came back
with different numbers, which is the whole of the note at the top of D-095.

`.gitattributes` sets `assets/** -text`, and that is load-bearing rather than tidy. This
repository is developed with `core.autocrlf=true`, and most of the text in `extracted/` is id
Software and OpenArena material authored on Windows and genuinely CRLF. Committed without it,
`default.cfg` stores as 1,701 bytes against the 1,809 `extract-pk3.mjs` wrote. A tree kept so it
can be restored has to restore to the bytes the pipeline produced.

**Two trees stay untracked, and neither is a preference.** `assets/ml/` is 36 GB whose checkpoint
shards are individually past GitHub's 100 MB hard limit, alongside a pip cache and a venv of
absolute Windows paths. `assets/download/` is the 425 MB upstream archive, which `fetch-assets.mjs`
re-fetches against a recorded SHA-256 — tracking it would have forced Git LFS on the whole
repository to keep a second copy of something already verifiable. Note it is not strictly redundant:
the two pk3s this document declines to mount are in the archive and not in `extracted/`, and
shadowed copies are dropped. Nothing the build reads is only in the zip.

**Tracked or not, none of it is disposable** — being committed makes a tree restorable, not cheap.
This is what each costs to make again, which is what you are spared when a restore is possible and
what you pay when it is not:

| tree | rebuilt by | cost |
|---|---|---|
| `assets/download/` | `fetch-assets.mjs` | a 425 MB fetch, and it assumes the upstream mirror is still serving 0.8.8 |
| `assets/extracted/` | `extract-pk3.mjs` | minutes, from `download/` |
| `assets/built/` | `convert-map.ts` × 6 maps, then `convert-fx.ts` and `npm run assets` | tens of minutes, and `convert-sounds` has to run again after the maps |
| `assets/built/*/audio-probes.bin` | `bake-audio.ts` | four to thirteen minutes per map and about forty for all six, at the one-metre spacing D-144 set; needs only `collision.bsp`, so it can be re-run without re-converting anything |
| `assets/built/*/lightmap.svlm` | `?bake=lightmap`, per map | two to six minutes per map on an NVIDIA 4090, six maps; needs the map converted and a WebGPU device, and meep's bake path needs `meepBakePathFixes()` in `vite.config.ts` to run at all (REPORT.md BUG-13) |
| `assets/generated/` | `material-maps.ts`, `inverse_render.py`, `build_maps.py` | **about two and a half hours on an NVIDIA 4090.** Seeded (`--seed 1000`) and *still not reproducible*: regenerating it after the D-104 deletion, from a byte-identical manifest and unmoved weights, gave 133 normal maps where the first run gave 130, and moved individual textures a long way (`acc_dm3/rivets` 126° → 172.4°). Expect D-095's **categories**, not its counts, and re-measure rather than re-cite |
| `assets/ml/` | `fetch-material-model.mjs`, then a venv rebuild | a 31 GB model download |

**`built/` and `generated/` are rebuilt interleaved, not in that order.** The two rows above read
as a sequence and are not one: `material-maps.ts` takes its scope from `inScopeNames`, which reads
the material names out of the *built bundles*, so it cannot be the first thing a rebuild runs. From
nothing on disk it goes converters → `material-maps.ts` → `inverse_render.py` → `build_maps.py` →
**converters again**. The first pass exists only to name the materials; with `generated/materials/`
still empty it writes exactly the pre-material-phase bundles, which is why it is safe to run twice.
The second pass is the one that binds the maps. Skipping the first pass does not fail — it writes a
manifest of zero images and every later step then succeeds at doing nothing, which is why
`material-maps.ts` now refuses an empty scope instead of writing that manifest.

So: **no tool, script or cleanup step may run a recursive delete that can reach `assets/`** — and
that includes deletes aimed somewhere else that reach it through a symlink or a Windows junction,
which is how it happened once already. D-104 has the mechanism.

| path | produced by | contents |
|---|---|---|
| `assets/download/` | `fetch-assets.mjs` | the untouched upstream archive |
| `assets/extracted/` | `extract-pk3.mjs` | flattened pk3 contents in Q3 load order, plus `manifest.json` recording the origin pk3 of every file |
| `assets/built/<map>/` | `convert-map.ts` | `scene.json` (materials, mesh table, submodel table, lights, entities), `geometry.bin`, `textures/`, and the untouched `collision.bsp`. A material names its textures by path *plus the Q3 blend the stage that named it used*, because one image referenced through two blends is two files (D-083) |
| `assets/built/<map>/audio-probes.bin` | `bake-audio.ts` | the map's acoustic probe field: a position and a per-band RT60 for each of the six to forty-seven thousand probes covering its air -- a metre apart at their closest, which is about half a player (D-144) -- measured offline by casting rays at the same brush solids the physics bodies are built from. What `ProbeReverbRenderer` reads at the listener, so a hall rings and a corridor does not. Separate from `convert-map.ts` because it is minutes per map and depends on nothing the converter produces except `collision.bsp` |
| `assets/built/<map>/lightmap.svlm` | `?bake=lightmap` in the browser | the map's baked indirect lighting: brick4's sparse voxel hierarchy of irradiance probes, which Shade samples per shading point instead of the single distant environment map. Not a Node tool and cannot be one -- the bake is a compute shader that traces the loaded scene several bounces deep -- so it runs in the dev server's browser and posts its result back through `/__bake/`. See `src/client/VolumetricLight.ts` |
| `assets/built/models/` | `convert-models.ts` | one bundle of every static prop -- pickups, weapon world models, ammo, gibs -- as `models.json` plus `models.bin`, plus the weapons' `*_hand.md3`, which carry no geometry and are converted for the `tag_weapon` that places a first-person weapon (D-080) |
| `assets/built/characters/<name>/` | `convert-characters.ts` | player models as skinned glTF: `<name>.gltf`, `<name>.bin`, textures. The skeleton is *inferred* from MD3's vertex-morph frames (DECISIONS.md D-042) and is not present in the source data |
| `assets/built/sound/` | `convert-sounds.ts` | the WAVs the port triggers and the OGG music the maps name, path-flattened, plus `sounds.json`. Copied byte-for-byte rather than transcoded. Half the list comes from the gamecode and half is read out of the built maps' `target_speaker` and `worldspawn` keys, so this runs *after* `convert-map.ts` |
| `assets/built/fx/` | `convert-fx.ts` | effect textures for particles and decals, plus the 2D art the HUD draws: `gfx/2d/crosshair[a-j]` and the `iconw_*` weapon icons. Each is converted for the Q3 blend it was authored against rather than copied, which for an impact mark means discarding the colour and keeping the luminance as coverage (D-079). The icon list is read out of `balance.generated.json` rather than written here, so the set converted and the set the HUD asks for cannot disagree (D-102) |
| `assets/generated/raw/` | `tools/cosmos/inverse_render.py` | the inverse renderer's own output, one image per G-buffer pass. Kept so `build_maps.py` can be re-run without re-inferring, which is 80 minutes of GPU |
| `assets/generated/materials/` | `tools/cosmos/build_maps.py` | what a bundle actually binds: `<image>.albedo.png` (de-lit and re-tinted), `<image>.normal.png` (only where it survived the checks) and `<image>.orm.png`. The converters pick these up automatically; with the directory empty they write exactly the bundles they wrote before the material phase |

---

## Model weights

Not committed, not redistributed, and large enough that they are fetched to
`assets/ml/checkpoints/` — gitignored with the rest of `assets/` — by

```bash
node tools/fetch-material-model.mjs
```

### Diffusion Renderer, inverse (Cosmos 7B)

| | |
|---|---|
| **Source** | `https://huggingface.co/nvidia/Diffusion_Renderer_Inverse_Cosmos_7B` |
| **Revision** | `main` at `model.pt`, MD5 `77eb5beddf131bfc8235a300132f22e4` — the checksum upstream's own `scripts/download_diffusion_renderer_checkpoints.py` publishes for this file |
| **Size** | 28,940,280,602 bytes |
| **Retrieved** | 2026-08-26 |
| **Licence** | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) — permits commercial use, and states that NVIDIA claims no ownership of the outputs |
| **Used for** | Estimating base colour, normal, roughness and metalness from a Q3 texture. |

The licence is the reason this model and not another. RGB↔X is the obvious
alternative and it is a better fit for the data, but it ships under the Adobe
Research License, which is non-commercial and cannot travel out of a GPLv2
repository — so it was used as a benchmark and none of its output is anywhere
near this pipeline.

### Cosmos Tokenize1 CV8x8x8 720p

| | |
|---|---|
| **Source** | `https://huggingface.co/nvidia/Cosmos-Tokenize1-CV8x8x8-720p` |
| **Revision** | `main`, the `.jit` encoder/decoder plus `mean_std.pt` and `config.json` |
| **Retrieved** | 2026-08-26 |
| **Licence** | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) |
| **Used for** | The video autoencoder the diffusion renderer samples in. Required by it; not used on its own. |

The T5 text encoder the Cosmos world models need is **not** fetched. The
diffusion renderer is configured `has_text_input=False` and its
`_load_text_encoder_model` is a no-op, so eleven gigabytes of language model
would sit unused; upstream's own download script has the same line commented out.

---

## The engine

`@woosh/meep-engine` is proprietary, source-available software, Copyright © 2026 Company
Named Limited. It is **not** an asset of this project and is **not** redistributed by it. It
is declared as a peer dependency in `package.json`, is never vendored or committed, and the
Vite config marks it external so it cannot be inlined into a build artefact. See
`node_modules/@woosh/meep-engine/LICENSE` for its terms.
