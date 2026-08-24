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

---

## Derived artefacts

Everything the pipeline writes lands in `assets/` and is gitignored. It is all derivative of
the GPLv2/CC inputs above and carries their terms.

| path | produced by | contents |
|---|---|---|
| `assets/download/` | `fetch-assets.mjs` | the untouched upstream archive |
| `assets/extracted/` | `extract-pk3.mjs` | flattened pk3 contents in Q3 load order, plus `manifest.json` recording the origin pk3 of every file |
| `assets/built/` | the phase-1 pipeline | converted output: maps as meep scene data, textures, glTF models, audio |

---

## The engine

`@woosh/meep-engine` is proprietary, source-available software, Copyright © 2026 Company
Named Limited. It is **not** an asset of this project and is **not** redistributed by it. It
is declared as a peer dependency in `package.json`, is never vendored or committed, and the
Vite config marks it external so it cannot be inlined into a build artefact. See
`node_modules/@woosh/meep-engine/LICENSE` for its terms.
