# queep-3-arena

Quake III Arena / OpenArena gameplay ported to [meep](https://meep.company-named.com/), a
WebGPU/ECS engine.

**Faithful in simulation, meep-native in presentation.** Movement (`bg_pmove.c`), collision
(`cm_*`), balance numbers and map layout are ported precisely. Everything else — particles,
decals, animation, audio, materials, lighting, UI, bots — uses meep's own systems, and looks
and behaves differently from Q3 as a result. That drift is intentional.

The point of the exercise is the engineering report in [REPORT.md](REPORT.md).

## Setup

Requires Node >= 24 and a WebGPU-capable browser.

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
map.

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

Then open `http://localhost:5173/?map=oa_dm1`. Click to capture the mouse; WASD to move, space
to jump, ctrl to crouch, mouse-1 to fire, 1-9 or the wheel to change weapon.

| query parameter | effect |
|---|---|
| `?map=<name>` | which level to load |
| `?fly=1` | swaps the player for a noclip camera, for inspecting conversions |
| `?trace=clipmap` | runs movement on the ported `cm_trace` instead of meep's physics, for an A/B |
| `?targets=1` | puts the phase-3 shootable boxes back, for testing damage without the bots |

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

One finding in the report is reproducible on its own:

```bash
npm run navmesh-probe
```

which tries to build meep's `NavigationMesh` from a Quake III level three different ways and
reports how many spawn-point pairs it can route between. The answer is 0–5%, and GAP-016
explains why.

## What works

- **Six OpenArena maps** convert and render at 137–253 FPS, with lighting reconstructed as
  dynamic lights from the map's own `.shader` data.
- **Movement** is Q3's, on meep's physics. The ported `cm_trace` is bit-exact against the C and
  is what the physics backend was tuned against: contact normals agree 98–99.6%, and position
  divergence over 400 frames of identical input is 0.06–0.22 units at the median.
- **Weapons** fire with Q3's own damage numbers and fire rates, extracted from the sources
  rather than transcribed.
- **Items** spawn, drop to the floor, bob, spin, get picked up under `BG_CanItemBeGrabbed`'s
  rules and respawn on their own clocks.
- **Movers** — doors, plats, buttons — run `g_mover.c`'s four-state machine, with jump pads
  solved by `AimAtTarget` and teleporters that take you somewhere.
- **15 characters**, converted from MD3 vertex-morph animation to skinned glTF by inferring a
  skeleton the source data does not contain.
- **Positional audio** for weapons, impacts, items, movers, jump pads and footsteps.
- **Bots** on meep's behaviour trees, running the *same* `Pmove` the player does — they route,
  fight, take items, and one has been observed strafe-jumping.
- **Effects** — explosions, smoke, sparks, impact marks, muzzle flashes — are meep's particles,
  GPU decals and clustered lights.

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
