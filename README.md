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
npm run dev
```

`npm run setup` clones the reference C sources at pinned commits and downloads the OpenArena
0.8.8 game data (425 MB). Nothing it fetches is committed — see [ASSETS.md](ASSETS.md) for
provenance and licensing of every input.

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
