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
node tools/convert-map.ts oa_dm1 aggressor oa_dm2
node tools/convert-fx.ts
npm run dev
```

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

Then open `http://localhost:5173/?map=oa_dm1`. Click to capture the mouse; WASD to move, space
to jump, ctrl to crouch, mouse-1 to fire, number keys to change weapon. `?fly=1` swaps the
player for a noclip camera.

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

## What works

- Six OpenArena maps convert and render at 137–253 FPS, with lighting reconstructed as dynamic
  lights from the map's own `.shader` data.
- Movement and collision are bit-exact against the C: strafe jumping, ramp jumps, stair
  stepping, crouching, water.
- Rockets, machinegun, shotgun, railgun and plasma fire with Q3's own damage numbers, against
  targets that take damage, die and respawn.
- Effects — explosions, smoke, sparks, impact marks, muzzle flashes — are meep's particles,
  GPU decals and clustered lights.

Not done: items and pickups, doors and platforms, player models and animation, audio, bots. See
[REPORT.md](REPORT.md) for the state of each phase and [DECISIONS.md](DECISIONS.md) for what was
cut and why.

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
