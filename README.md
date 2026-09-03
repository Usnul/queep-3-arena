# queep-3-arena

Quake III Arena / OpenArena gameplay ported to [meep](https://meep.company-named.com/), a
WebGPU/ECS engine.

**Ported in spirit, not in body.** Balance numbers and map layout are exact. Movement keeps Q3's
*motor* — the acceleration, friction and command-scale functions that make strafe jumping work —
and hands collision resolution to meep's own kinematic solver, so contact behaviour differs from
Q3 by design (D-071). Everything else — particles, decals, animation, audio, materials, lighting,
UI, bots — uses meep's systems and looks and behaves differently as a result. That drift is the
point of the exercise, not a shortfall in it.

The ported `bg_pmove.c` and `cm_*` are still here as the reference the shipping path is measured
against. They agreed with the C bit-for-bit until D-174 traded that for meep's own vector maths:
every discrete answer a trace gives is still identical over 100,000 sweeps, and the price is a
fifth-decimal difference in where along one it stopped.

**The point of the exercise is the engineering report in [REPORT.md](REPORT.md).** This file is an
index: every reasoned choice below is a pointer into the documents at the bottom, where the
argument actually lives.

## Setup

Requires Node 24+, a WebGPU-capable browser, and your own licensed copy of `@woosh/meep-engine`,
which is a peer dependency — `package.json` holds the version range. `ffmpeg` on PATH, built with
libvorbis, for the sound bank: `convert-sounds.ts` transcodes it to Ogg Vorbis (D-175) and says so
if it cannot find one.

```bash
npm install
npm run setup
node tools/convert-map.ts oa_dm1 aggressor oa_dm4 oa_dm5 oa_dm7 am_thornish
node tools/convert-fx.ts
npm run assets
npm run dev
```

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

`npm run assets` converts the static props, the 15 player characters and the sound bank, once for
the whole game rather than once per map. One ordering caveat: a map names its own ambience and
music, so `npm run convert-sounds` wants running again after a new map is converted, and says so.
The sound bank comes out as Ogg Vorbis — 7.6 MB of OpenArena WAV becomes 1.2 MB, and every
transcode is checked against the source it came from before the manifest is written.

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

## Playing

Open `http://localhost:5173/?map=oa_dm1`. Click to capture the mouse; WASD to move, space to jump,
ctrl to crouch, shift to walk, mouse-1 to fire, 1-9 or the wheel to change weapon, **escape for the
menu**. Input runs on meep's own `engine.devices` rather than DOM listeners — see GAP-017 for why
that is not optional.

| query parameter | effect |
|---|---|
| `?map=<name>` | which level to load |
| `?fly=1` | swaps the player for a noclip camera, for inspecting conversions |
| `?join=ws://host:port` | joins a match on a dedicated host instead of running one locally. `?name=` and `?character=` go with it. The map must be the host's, and the client says so plainly if it is not |
| `?move=q3` | runs the ported `bg_pmove.c` whole -- slide-move, ground trace and all -- instead of Q3's motor on meep's `KinematicMover` |
| `?trace=clipmap` | runs collision on the ported `cm_trace` instead of meep's physics, for an A/B; implies `?move=q3` |
| `?targets=1` | puts the phase-3 shootable boxes back, for testing damage without the bots |
| `?crosshair=<0-9>` | `cg_drawCrosshair`: which of Q3's ten reticles to draw. Beats the saved setting for the session; out of range is ignored rather than clamped |
| `?fog=off` | empties the air, taking the map's volumetric lighting with it -- the volume is what turns Shade's volumetrics on at all, so this is the whole feature and its frame cost (D-151, D-154) |

### Multiplayer

Start a host, then point a browser at it:

```bash
npm run host -- --map oa_dm1 --bots 4
```

```
http://localhost:5173/?map=oa_dm1&join=ws://localhost:5300
```

The host takes `--map`, `--bots`, `--port` (5300), `--difficulty`, `--seed` and `--fraglimit`. It
runs the whole match — movement, weapons, items, bots, scoring — and every browser is a client that
predicts its own player and is corrected by the host. Up to sixteen slots, bots included.

**What v1 does not do**, none of it an oversight (D-185): no reconnect, so a dropped socket is a
return to the menu and a second join is a new player who happens to get the same slot; no kick, ban
or anti-cheat beyond ownership — a client cannot drive somebody else's player, which is tested, but
it can send whatever it likes for its own; no idle reaping, so a socket that dies without closing
holds its slot until TCP notices; no chat and no server browser (join by address). There **is** a
scoreboard: hold tab, and it is built from `NetPlayerInfo` while you hold it (D-190).

The session runs at **30 Hz**, which is half single-player's rate. That is a deliberate trade and it
costs something real: `bg_pmove` is stepped at the session rate, so a networked strafe jump tops out
about 4.5% slower than a local one (D-184). What it buys is 45.8 KB/s a client instead of 88.7, and
event delivery that stops losing shots on a lossy link.

### The menu

Escape opens it, and the game keeps running behind a translucent, unblurred scrim: a render-scale
or field-of-view change is judged by what it does to the picture, so the picture has to still be
there (D-099). Settings save to IndexedDB. Three pages — Gameplay, Graphics, Audio — split by
whether a row has a right answer: every graphics row has one for a given machine, and no gameplay
or audio row does (D-126). The shell takes a list of pages and names none of them; a map picker and
a match setup screen are the next two (D-097, Q-008).

What is *not* on the graphics page is the more interesting half. Those rows are feature switches
with no quality setting among them, because the knobs that would tune them are private to
`Renderer` or hardcoded at its call sites — GAP-024, with D-108, D-109 and D-127 recording what was
offered, what was refused and what was removed. The audio faders are fractions of the mix the
engine ships rather than absolute gains, which is not a flourish: written as gains defaulting to
1.0, they would remix the game on the first frame the menu applied its defaults (GAP-034).

## Verification

```bash
npm run check
```

Typechecks, verifies the `trap_` matrix and balance tables are current, and runs the differential
test suites. The movement suites need the WebAssembly oracle:

```bash
node oracle/build.mjs
```

which compiles OpenArena's `bg_pmove.c` and ioquake3's `cm_*` **unmodified** to WASM. The
TypeScript port is then run against it — 100,000 randomised traces, and roughly 170,000 movement
frames compared one step at a time. Traces must agree *exactly* on every discrete answer (hit or
miss, which plane, what contents, whether the box started solid) and to 1e-4 on the fraction;
movement is held to a divergence rate rather than to equality. D-174 says what changed, what it
measured, and why the suites still fail on a 0.001 change to `OVERCLIP`. Emscripten is expected at
`.refs/emsdk`; `oracle/build.mjs` prints the install commands if it is missing.

Three findings in the report reproduce on their own:

| command | what it shows |
|---|---|
| `npm run divergence` | identical input through the C oracle, the ported clipmap and meep's physics, and how far the third drifts from the first — the second is the control, and its own worst disagreement with the C is three orders of magnitude below the third's |
| `npm run bench-match` | a six-bot deathmatch played headlessly on both movement paths, then the cost of a single trace decomposed. Section 5's numbers come from here: the shipping path needs 6.0 traces a frame where driving `bg_pmove` through meep's physics needed 30.4, and in that older arrangement the ported Q3 rule that decides the answer cost 0.22 µs against the 3.06 of the `shape_cast` in front of it |
| `npm run bench-net` | what a host frame costs by how many people are in the match, and the milliseconds of CPU a second of match takes. Section 5's networking table comes from here |
| `npm run navmesh-probe` | meep's `NavigationMesh` built from a Quake III level three ways — solid brushes, render surfaces, and an extracted walkable surface — each repaired with the engine's topology toolkit. 5%, 0% and 48% of spawn-point pairs are routable, against 100% for the waypoint graph this port ships. GAP-016 explains what that difference is, and includes a claim I got wrong twice before getting it right |

## What works

- **Six OpenArena maps**, lit by dynamic lights reconstructed from the map's own `.shader` data
  and from the BSP lightgrid q3map2 bakes. The second source exists because the first is not
  enough: two maps came back with almost no light at all, their lighting having been authored as
  `light` entities q3map2 deletes at compile time. All six are now asserted in lux at every spawn
  point and pickup (GAP-006, D-078).
- **Movement**: Q3's motor on meep's kinematic solver. Strafe jumping survives because it lives
  entirely in the acceleration function and never touches a trace — flat headings top out at
  exactly 320 u/s and a scripted strafe chain reaches 354 (D-071).
- **The ported `bg_pmove.c`**, measured against the C step by step and reachable with `?move=q3`.
  It is the reference the new path is judged against rather than the shipping path.
- **Multiplayer**, on meep's server-authoritative session: a dedicated host, browser clients that
  predict their own player and reconcile against the host, remote players drawn exactly where the
  host put them, and bots that shoot at every human rather than the first one. Two clients and four
  bots for 45 seconds is a test, not a demo. What it costs on the wire and on the host's CPU is in
  REPORT section 5, and sixteen slots costs a client **245 KB/s** down on an 80 ms link — 1.96
  Mbit/s, which is not a problem and was only ever reported as one because it was measured against
  an undated 48 KB/s line in the plan (D-196). What is left is a hosting cost: roughly 16 Mbit/s of
  host egress per eight humans, multiplied by concurrent matches.
- **Weapons** with Q3's own damage numbers and fire rates, extracted from the sources rather than
  transcribed.
- **Items** that spawn, drop to the floor, bob, spin, obey `BG_CanItemBeGrabbed` and respawn on
  their own clocks.
- **Movers** — doors, plats, buttons — on `g_mover.c`'s four-state machine, with jump pads solved
  by `AimAtTarget` and teleporters that take you somewhere.
- **15 characters**, converted from MD3 vertex-morph animation to skinned glTF by inferring a
  skeleton the source data does not contain.
- **Audio** on meep's `AudioEmitter` components, one path for all four of Q3's sound calls:
  positional one-shots, looping sources that follow what owns them, and the map's own background
  track. Ogg Vorbis, looped at the length the file declares rather than the length the browser's
  decoder returns — those differ, and the difference is a hole at the seam (D-175).
- **Bots** on meep's behaviour trees, running the *same* movement the player does — they route,
  fight, take items, and one has been observed strafe-jumping. On meep 3.2.0, grounded 89–94% of
  a match against the ported path's 86–93% (D-073).
- **Effects** — explosions, smoke, sparks, impact marks, muzzle flashes — on meep's particles, GPU
  decals and clustered lights.
- **The first-person view**: Q3's artwork and Q3's arithmetic on meep's own UI and mesh paths.
  What it does not have is the two render flags Q3 leans on — `RF_DEPTHHACK`, so the gun clips
  into a wall you press against, and `RF_MINLIGHT`, so a dark room gets a dark gun (D-080).
- **The menu**, on meep's `View` hierarchy over meep's own `Option` model (D-097, D-126).
- **A stylesheet with defines**: `src/style/_tokens.scss` is the single source for colour, type,
  space, shape, motion and stacking. It emits the same values as `--queep-*` custom properties for
  runtime overrides, and feeds meep's own `--meep-*` theme hooks from the same variables (D-098).

Every one of those has an edge it does not reach, and each is written down rather than left to be
discovered: see [DECISIONS.md](DECISIONS.md) D-041, D-045 and D-055 for what movers, characters
and bots respectively do *not* do.

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
