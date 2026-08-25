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
map — with one ordering caveat: a map names its own ambience and music, so `npm run
convert-sounds` wants running again after a new map is converted, and says so.

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

Then open `http://localhost:5173/?map=oa_dm1`. Click to capture the mouse; WASD to move, space
to jump, ctrl to crouch, mouse-1 to fire, 1-9 or the wheel to change weapon. Input runs on meep's
own `engine.devices` rather than DOM listeners — see GAP-017 for why that is not optional.

| query parameter | effect |
|---|---|
| `?map=<name>` | which level to load |
| `?fly=1` | swaps the player for a noclip camera, for inspecting conversions |
| `?move=q3` | runs the ported `bg_pmove.c` whole -- slide-move, ground trace and all -- instead of Q3's motor on meep's `KinematicMover` |
| `?trace=clipmap` | runs collision on the ported `cm_trace` instead of meep's physics, for an A/B; implies `?move=q3` |
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

Three findings in the report are reproducible on their own:

```bash
npm run divergence
```

which runs identical input through the C oracle, the ported clipmap and meep's physics and
reports how far the third drifts from the first, with the second as a bit-exact control.

```bash
npm run bench-match
```

which plays a six-bot deathmatch headlessly on both collision backends and then decomposes the
cost of a single trace. It is where section 5's claim comes from that the ported Q3 rule which
decides the answer costs 0.29 µs and the `shape_cast` in front of it costs 3.49.

```bash
npm run navmesh-probe
```

which builds meep's `NavigationMesh` from a Quake III level three different ways — solid
brushes, render surfaces, and an extracted walkable surface — repairs each with the engine's
topology toolkit, and reports how many spawn-point pairs `find_path` can route between. The
answers are 5%, 0% and 48%, against 100% for the waypoint graph this port ships. GAP-016 explains
what that difference is, and includes a claim I got wrong twice before getting it right.

## What works

- **Six OpenArena maps** convert and render at 137–253 FPS, with lighting reconstructed as
  dynamic lights from the map's own `.shader` data. Four of the six come out well lit; `oa_dm5`
  and `oa_dm7` do not, because their lighting was authored as `light` entities that q3map2
  deletes at compile time. That is measured rather than estimated — see GAP-006.
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
- **Bots** on meep's behaviour trees — they route, fight, take items, and one has been observed
  strafe-jumping. They still run the ported `bg_pmove`, so since D-071 the player and the bots
  move on different solvers; that is a known inconsistency and the next change, not a design
  position.
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
