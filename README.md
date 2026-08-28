# queep-3-arena

Quake III Arena / OpenArena gameplay ported to [meep](https://meep.company-named.com/), a
WebGPU/ECS engine.

**Ported in spirit, not in body.** Balance numbers and map layout are exact. Movement keeps Q3's
*motor* — the acceleration, friction and command-scale functions that make strafe jumping work —
and hands collision resolution to meep's own kinematic solver, so contact behaviour differs from
Q3 by design (D-071). Everything else — particles, decals, animation, audio, materials, lighting,
UI, bots — uses meep's systems and looks and behaves differently as a result. That drift is the
point of the exercise, not a shortfall in it.

The ported `bg_pmove.c` and `cm_*` are still here, bit-exact against the C, as the reference the
shipping path is measured against.

The point of the exercise is the engineering report in [REPORT.md](REPORT.md).

## Setup

Requires Node >= 24, `@woosh/meep-engine` >= 3.9.0, and a WebGPU-capable browser.

```bash
npm install
npm run setup
node tools/convert-map.ts oa_dm1 aggressor oa_dm4 oa_dm5 oa_dm7 am_thornish
node tools/convert-fx.ts
npm run assets
npm run dev
```

`npm run assets` converts the static props, the 15 player characters and the sound bank. It is
separate from the map conversion because it runs once for the whole game rather than once per
map — with one ordering caveat: a map names its own ambience and music, so `npm run
convert-sounds` wants running again after a new map is converted, and says so.

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

### Material maps, optionally

Surfaces render from the Q3 texture alone unless a normal map and an ORM have been generated for
them. Generating them needs an NVIDIA GPU, a 31 GB model download and about ninety minutes, so it
is deliberately not part of `npm run setup` — skip it and the port converts exactly the bundles it
converted before, with roughness 0.85 and no metal anywhere.

```bash
node tools/fetch-material-model.mjs
python -m venv assets/ml/venv    # Python 3.11; see tools/cosmos/requirements.txt for why
assets/ml/venv/Scripts/pip install -r tools/cosmos/requirements.txt
node tools/material-maps.ts
assets/ml/venv/Scripts/python tools/cosmos/inverse_render.py --manifest assets/generated/manifest.json --out assets/generated/raw --passes basecolor normal roughness
assets/ml/venv/Scripts/python tools/cosmos/build_maps.py
```

Then re-run the converters. What each channel is worth, and why two of the four the network offers
are thrown away and replaced by a hand table, is D-092 and D-093.

Then open `http://localhost:5173/?map=oa_dm1`. Click to capture the mouse; WASD to move, space
to jump, ctrl to crouch, mouse-1 to fire, 1-9 or the wheel to change weapon, **escape for the
menu**. Input runs on meep's own `engine.devices` rather than DOM listeners — see GAP-017 for why
that is not optional.

### The menu

Escape opens it, escape or the scrim closes it. The game keeps running behind it and the scrim is
translucent and unblurred on purpose: a render-scale or field-of-view change is judged by what it
does to the picture, so the picture has to still be there (D-099). Settings are saved to
IndexedDB and applied on the next load.

| setting | what it writes |
|---|---|
| Field of view | `Camera.fov`; `cg_fov`, 60–130, default 90 |
| Shadows | which lights cast: off, the sun only, or all of them. Defaults to all (D-108) |
| Ambient occlusion | `feature_ssao_enabled`, which is GTAO. On, and the one of the three the arenas need: the lightmaps shade the level and nothing moving through it (D-109) |
| Screen-space reflections | `feature_ssr_enabled`. Off, and greyed out on any map with a baked light volume — SSR and Brick4 are alternatives in the renderer, and setting the flag there costs the fused indirect path for nothing (D-109) |
| Bloom | `feature_bloom_enabled`. On. Off saves the composite and not the bright pass, which automatic exposure needs either way (D-109) |
| Motion blur | `feature_motion_blur_enabled`, Jimenez 2014 reconstruction. Off, and that one is an argument about the game rather than about cost (D-109) |
| Blur strength | `renderer.motion_blur.strength`, 0.5–3.0x. 1.0 is the real per-frame movement; the ceiling is where the engine stops vouching for the reconstruction (D-109) |
| Adaptive resolution | meep's `DynamicResolutionScaling`, which trades internal resolution for frame time |
| Render scale | `Renderer.internal_resolution_scale`, 50–100%. Alternative to adaptive resolution — each greys the other out (D-101) |
| Frame-rate target | what adaptive resolution aims to hold. Default 60, against the engine's own 30 |
| Frame-rate counter | the `stats.js` panel |
| Crosshair | `cg_drawCrosshair`, `gfx/2d/crosshair[a-j]` |
| Colour crosshair by health | `cg_crosshairHealth`, which Q3 defaults on |

Six of those rows exist because **3.6.0 opened the smallest possible door** — a `renderer` getter
with "Danger zone" written on it — and the shape of what came through it is worth stating: with one
exception they are switches, and there is not a quality setting among them. The `GTAO` and `SSR`
objects are a private field of `Renderer` with no getter, so they are out of reach with the renderer
already in hand; the quality knobs that exist are call arguments `Renderer` hardcodes —
`SSR.graph_pass`'s `mip`, `graph_postprocess_bloom`'s `intensity` and `mips` — and the shadow
*resolution* is a module-private constant, as is the atlas size beside it. So there is no
anti-aliasing row and no Low / Medium / High, and that is still GAP-024 — smaller than it was, and
the menu says so in its own footer rather than looking thin for no reason (D-108, D-109). There is
no supersampling for a second reason: `pixelRatio`, the one property that reaches it, throws on any
scale that is not a whole number (BUG-11).

**Blur strength is the exception, and it points at the fix.** `MotionBlur` is newer than GTAO and
SSR and was built the other way round: the renderer owns one and hands it out, `get motion_blur()`,
with the getter's docblock reading "Configure it via `renderer.motion_blur.*`". `dof` is the same.
The flag and the tuning are deliberately separated and both are public — which is exactly the shape
GAP-024 asks for, already in the package, for whatever the engine added most recently.

A map picker and a match setup screen are the next two pages. The shell takes a list of pages and
nothing in it names "graphics"; what is missing for maps is a manifest of what the pipeline has
actually built (D-097, Q-008).

| query parameter | effect |
|---|---|
| `?map=<name>` | which level to load |
| `?fly=1` | swaps the player for a noclip camera, for inspecting conversions |
| `?move=q3` | runs the ported `bg_pmove.c` whole -- slide-move, ground trace and all -- instead of Q3's motor on meep's `KinematicMover` |
| `?trace=clipmap` | runs collision on the ported `cm_trace` instead of meep's physics, for an A/B; implies `?move=q3` |
| `?targets=1` | puts the phase-3 shootable boxes back, for testing damage without the bots |
| `?crosshair=<0-9>` | `cg_drawCrosshair`: which of Q3's ten reticles to draw. Beats the saved setting for the session; out of range is ignored rather than clamped |

## Verification

```bash
npm run check
```

Typechecks, verifies the `trap_` matrix and balance tables are current, and runs the
differential test suites. The movement suites need the WebAssembly oracle:

```bash
node oracle/build.mjs
```

which compiles OpenArena's `bg_pmove.c` and ioquake3's `cm_*` **unmodified** to WASM. The
TypeScript port is then run against it frame by frame and must agree bit-for-bit — 100,000
randomised traces and roughly 50,000 simulated movement frames, tolerance zero. Emscripten is
expected at `.refs/emsdk`; `oracle/build.mjs` prints the install commands if it is missing.

Three findings in the report are reproducible on their own:

```bash
npm run divergence
```

which runs identical input through the C oracle, the ported clipmap and meep's physics and
reports how far the third drifts from the first, with the second as a bit-exact control.

```bash
npm run bench-match
```

which plays a six-bot deathmatch headlessly on both movement paths and then decomposes the cost of
a single trace. It is where section 5's numbers come from: the shipping path needs 6.0 traces a
frame where driving `bg_pmove` through meep's physics needed 30.4, and in that older arrangement
the ported Q3 rule that decides the answer cost 0.22 µs against the 3.06 of the `shape_cast` in
front of it.

```bash
npm run navmesh-probe
```

which builds meep's `NavigationMesh` from a Quake III level three different ways — solid
brushes, render surfaces, and an extracted walkable surface — repairs each with the engine's
topology toolkit, and reports how many spawn-point pairs `find_path` can route between. The
answers are 5%, 0% and 48%, against 100% for the waypoint graph this port ships. GAP-016 explains
what that difference is, and includes a claim I got wrong twice before getting it right.

## What works

- **Six OpenArena maps** convert and render at 137–253 FPS (measured on meep 3.0.2), with
  lighting reconstructed as dynamic lights from two sources: the map's own `.shader` data, and
  the BSP lightgrid q3map2 bakes. The second exists because the first is not enough — `oa_dm5`
  reconstructed to zero lights over 107,414 triangles and `oa_dm7` left 70 of 79 player positions
  under a lux, because their lighting was authored as `light` entities that q3map2 deletes at
  compile time. Fitting lights to the lightgrid closes that: all six maps are now lit, asserted
  in lux at every spawn point and pickup. See GAP-006 and D-078.
- **Movement** is Q3's motor on meep's kinematic solver: `PM_Accelerate`, `PM_Friction` and
  `PM_CmdScale` produce a desired velocity, and meep's `KinematicMover` resolves it. Strafe
  jumping survives because it lives entirely in the acceleration function and never touches a
  trace -- flat headings top out at exactly 320 u/s and a scripted strafe chain reaches 354.
  Ported in spirit, not in body (D-071).
- **The ported `bg_pmove.c` also ships**, bit-exact against the C, reachable with `?move=q3`. It
  is the reference the new path is judged against rather than the shipping path: the ported
  `cm_trace` agrees with meep's physics on hit-or-miss for 100.0% of 20,000 sampled sweeps, with
  a p90 fraction error of 5.3e-8.
- **Weapons** fire with Q3's own damage numbers and fire rates, extracted from the sources
  rather than transcribed.
- **Items** spawn, drop to the floor, bob, spin, get picked up under `BG_CanItemBeGrabbed`'s
  rules and respawn on their own clocks.
- **Movers** — doors, plats, buttons — run `g_mover.c`'s four-state machine, with jump pads
  solved by `AimAtTarget` and teleporters that take you somewhere.
- **15 characters**, converted from MD3 vertex-morph animation to skinned glTF by inferring a
  skeleton the source data does not contain.
- **Audio** on meep's `AudioEmitter` components, one path for all four of Q3's sound calls:
  positional one-shots for weapons, impacts, items, movers, jump pads and footsteps; looping
  sources that follow what owns them, from map ambience to a rocket's fly sound; and the map's
  own background track.
- **Bots** on meep's behaviour trees, running the *same* movement the player does — they route,
  fight, take items, and one has been observed strafe-jumping. On meep 3.2.0 they are grounded
  89–94% of a match against the ported path's 86–93%, and on `oa_dm1` they engage roughly three
  times as often. The regression that showed on `aggressor` under 3.0.2 was BUG-7 and is gone
  (D-073).
- **Effects** — explosions, smoke, sparks, impact marks, muzzle flashes — are meep's particles,
  GPU decals and clustered lights.
- **The first-person view** — the crosshair and the gun in your hands — is Q3's artwork and Q3's
  arithmetic on meep's own UI and mesh paths: `gfx/2d/crosshair[a-j]` tinted by
  `CG_GetColorForHealth`, and the weapon placed at the offset its hands model's `tag_weapon`
  authored, bobbing on `CG_CalculateWeaponPosition`'s sway. What it does not have is the two
  render flags Q3 leans on — `RF_DEPTHHACK`, so the gun clips into a wall you press against, and
  `RF_MINLIGHT`, so a dark room gets a dark gun (D-080).

- **The menu**, on meep's `View` hierarchy over meep's own `Option` model, with the settings
  saved to IndexedDB. Escape opens it, the game keeps running behind it, and it is a shell over a
  list of pages rather than a screen — a map picker and a match setup screen go in beside
  Graphics without the shell changing (D-097). What is on the graphics page is bounded by what
  the engine hands an application: most quality knobs behind `Renderer` are still out of reach,
  which is GAP-024 for the second time, and the five rows over the renderer's own feature flags —
  shadows, ambient occlusion, reflections, bloom and motion blur — are what 3.6.0 gave back, along
  with the one tuning number of the five that has a getter (D-108, D-109).
- **A stylesheet with defines.** `src/style/_tokens.scss` is the single source for colour, type,
  space, shape, motion and stacking; it emits the same values as `--queep-*` custom properties
  for runtime overrides, and feeds meep's own `--meep-*` theme hooks from the same variables
  (D-098).

Every one of those has an edge it does not reach, and each is written down rather than left to
be discovered: see [DECISIONS.md](DECISIONS.md) D-041, D-045 and D-055 for what movers,
characters and bots respectively do *not* do.

## Documents

| file | what it is |
|---|---|
| [REPORT.md](REPORT.md) | engineering report on meep: syscall coverage matrix, gap register, ergonomics, performance, bugs |
| [DECISIONS.md](DECISIONS.md) | every non-obvious choice, with the reasoning |
| [QUESTIONS.md](QUESTIONS.md) | open questions, each with the default already in use |
| [ASSETS.md](ASSETS.md) | asset provenance and licensing |

## Licence

GPLv2 — see [LICENSE](LICENSE). This is a derivative work of Quake III Arena, Copyright (C)
1999-2005 Id Software, Inc., and of the OpenArena gamecode, both released under the GNU
General Public License v2. Ported files carry attribution headers.

`@woosh/meep-engine` is proprietary, source-available software, Copyright (C) 2026 Company
Named Limited. It is a peer dependency: never vendored, never committed, never bundled into
any artefact produced here. You supply your own licensed copy.
