# Hand-over: Quake III / OpenArena → meep-engine port

You are starting from an empty repository. Read this whole document before doing anything.

---

## 1. What this project is

Port the gameplay of Quake III Arena (using OpenArena's GPL asset set) to `@woosh/meep-engine`, a proprietary WebGPU/ECS engine published on npm.

There are **two deliverables of equal weight**:

1. **A playable demo** that showcases what meep can do.
2. **An engineering report** (`REPORT.md`) consumed by meep's maintainer and turned directly into an engine backlog.

If you have to choose between them, the report wins. A half-finished demo with an excellent report is a success. A polished demo with a thin report is a failure.

---

## 2. The organising principle

**Faithful in simulation. meep-native in presentation.**

Q3 is not the target — it is source material. Where Q3 has a system and meep has an equivalent system, **use meep's and throw Q3's away**, even when the result looks or behaves differently. Visual and behavioural drift is an accepted cost, not a bug to be filed. You do not need to ask permission for this; it is the point of the exercise.

Replace, don't port:

- **Particles and effects** — rocket trails, explosions, gibs, smoke, muzzle flashes. Q3's `cg_effects.c` / `cg_localents.c` go in the bin; use meep's particle system.
- **Bullet marks and blood splatter** — use meep's GPU decals, not Q3's mark polygons.
- **Animation** — MD3 vertex-morph with tag hierarchies is a 1999 constraint. Use whatever meep does natively. If that means converting or re-rigging characters and losing exact frame fidelity, take the trade.
- **Networking** — delete entirely. Single process. Do not port snapshots, delta compression, or client prediction.
- **Sound** — meep's positional audio, not Q3's mixer.
- **Bots** — botlib and AAS are ~100k LOC of misery. Use meep's behaviour trees, blackboard, and pathfinding. Bots behaving differently from Q3 bots is fine and expected.
- **Materials** — meep has a PBR material system. Use it. Map Q3 `.shader` scripts onto PBR inputs offline: textures become albedo, derive or default the rest. Multi-pass blends, `tcMod`, `deformVertexes`, `rgbGen wave` and friends are 1999 fixed-function tricks — drop them. Where a Q3 surface has no sensible PBR equivalent, pick something that looks decent and note it. **Do not write shaders.** Not a `.shader` interpreter, not custom WGSL, not a bespoke render pass. If an effect can't be expressed with meep's existing materials, cut the effect and file a gap entry.
- **Lighting** — your call whether to keep Q3's baked lightmaps or go fully dynamic with meep's clustered lighting, subject to the same rule: whatever the engine already supports, nothing new. Try the thing that shows meep off.
- **HUD and menus** — meep's UI system.

Keep faithful:

- **`bg_pmove.c`** — movement is the one place fidelity is non-negotiable. Strafe-jumping, air control, ramp jumps, and acceleration must match. Get this wrong and nothing else matters.
- **Collision traces** (`cm_*`) — because pmove depends on them.
- **Balance numbers** — weapon damage, fire rates, knockback, item respawn timers, armour absorption, ammo counts.
- **Map geometry and layout.**

---

## 3. Hard constraints

**Licensing — these are not negotiable:**

- The port is a derivative of GPLv2 code. The repo is GPLv2. Every ported file carries attribution to id Software / OpenArena.
- **meep is proprietary and must never be vendored, committed, or inlined into a bundle.** Declare it as a peer dependency. Configure the build so the engine stays an external runtime import, not part of any committed or shipped artifact.
- Do not set up hosting or deployment. Do not produce a bundled build for distribution. Source-only release.
- Don't commit large binary assets. Fetch them with a script at setup time, and record provenance and licence for every asset source in `ASSETS.md`.

**You cannot modify the engine.** You have no write access to meep. When it doesn't do what you need, work around it and file it in the report. Resist any urge to patch, monkey-patch, or fork the engine to make your life easier — the friction *is* the data.

**You write no rendering code.** No shaders, no render passes, no material extensions, no engine-level graphics work of any kind. Use meep's existing PBR materials, lighting, particles, decals and trails as they ship. If something can't be done with what's there, it doesn't get done — cut it and file a gap entry. The demo exists to show what the engine already does, so a feature you had to build yourself proves nothing.

---

## 4. Sources

- **Gamecode:** OpenArena's fork (not vanilla Q3) — its balance and entity definitions match the OA assets. Pin a specific commit and record it.
- **Engine reference:** `ioquake3` for `cm_*` and general clarification. Pin a commit.
- **Assets:** OpenArena 0.8.8 pk3s.

If you can't obtain any of these programmatically, say so immediately — that's one of the few things worth interrupting me for.

---

## 5. The `trap_` audit

Q3's gameplay talks to its engine exclusively through `trap_*` syscalls. Grep for them across `game/`, `cgame/`, and `ui/` and you get a complete, mechanically-derived list of every service the gameplay layer demands — roughly 100 functions.

Build a coverage matrix from it early and maintain it as you go: **Q3 syscall → meep facility → gap / workaround / not needed.** This is the spine of the report. It's also a good way to plan, because it tells you what you're in for before you write the code.

---

## 6. Verifying pmove without a human in the loop

Compile ioq3's `bg_pmove.c` and `cm_trace.c` to WASM with Emscripten and differential-test your JS port against it. Feed identical `pmove_t` inputs across thousands of randomised frames and compare outputs numerically.

This gives you a ground-truth oracle you can self-correct against, so nobody has to line-review a translation of physics code. Set a divergence threshold, make it a CI check, and treat regressions as blocking. Do this in phase 2, before any gameplay depends on it.

---

## 7. Phases

Each phase ends with: commit, update `REPORT.md` and `DECISIONS.md`, and post any accumulated questions in one batch.

0. **Setup.** TypeScript, strict mode. Bundler and test runner are your call — record them. Repo layout, meep installed, blank scene rendering. If meep's type coverage is incomplete or wrong, do not paper over it with `any` and move on silently: work around it, and file each instance as a gap entry. Type quality is a first-class finding, not an inconvenience. *Exit: `tsc --noEmit` clean and something renders.*
1. **Asset pipeline.** pk3 extraction, BSP → meep scene, `.shader` → meep materials, models, sounds. *Exit: fly through a map at a stable frame rate.*
2. **Collision and movement.** Oracle-verified. *Exit: divergence under threshold across the randomised suite.*
3. **Game simulation.** Entities as ECS components, items, weapons, damage, respawn. *Exit: playable deathmatch against a stationary target.*
4. **Presentation.** meep particles, decals, audio, HUD, lighting. *Exit: it looks like a showcase, not a test harness.*
5. **Bots.** On meep's AI stack. *Exit: a real match is playable.*
6. **Report finalisation.**

Scope cuts within a phase are yours to make. Record them in `DECISIONS.md` and move on.

---

## 8. The report

`REPORT.md`, written for meep's maintainer, who will convert it into a backlog. **Append to it continuously as you work** — do not reconstruct it at the end. Reconstructed reports lose exactly the detail that makes them useful.

Sections:

1. **Executive summary** — the ten things that matter most, ranked.
2. **`trap_` coverage matrix.**
3. **Gap register** — structured entries, format below.
4. **Ergonomics** — API friction, discoverability, confusing naming, unhelpful error messages, docs that were wrong or missing.
5. **Performance** — with numbers, and what you did about them.
6. **Engine bugs** — each with a minimal reproduction.
7. **What worked well** — so the maintainer doesn't regress it. Be specific; "great engine" is useless.
8. **Docs and samples gaps** — what you wished existed when you were stuck.

Gap entry format:

```
### GAP-014: <short title>
- Needed:      what the port required
- meep offers: what exists today, or nothing
- Workaround:  what you did, roughly how much code, roughly how long
- Severity:    blocker | major | minor | papercut
- Suggested fix: what would have made this a non-issue
- Evidence:    src/path/to/thing.js, commit abc123
```

**On honesty:** if you spent three hours fighting something, that is the single most valuable signal in the document. Write it down. Do not soften it, do not blame yourself for it, and do not pad the report with praise. A report concluding that everything was smooth is a failed report — I know the engine has rough edges and I need to know which ones cost real time.

---

## 9. Working with me

I want my involvement close to zero. Behave accordingly:

- **Never block on me.** Pick the most reasonable default, record it in `DECISIONS.md` with your reasoning, and keep going. I can override later.
- **Batch questions.** Accumulate them in `QUESTIONS.md` and surface them at phase boundaries in one message. Interrupt mid-phase only for something genuinely blocking — unobtainable assets, a licensing question, a decision that would be expensive to reverse.
- **Don't ask me how to use meep.** Read the source, the `/samples` folder, and the docs. Working it out yourself is the experiment. If you couldn't work it out, that's a gap entry, not a question.
- **Don't ask for permission to deviate from Q3.** Deviation is the plan. Just log it.

Files you maintain: `REPORT.md`, `DECISIONS.md`, `QUESTIONS.md`, `ASSETS.md`. Nothing else — I don't want a documentation estate.

---

## 10. Anti-goals

Do not: reimplement Q3's renderer, write shaders or render passes of any kind, write a `.shader` interpreter, write a QVM interpreter, port netcode, port botlib or AAS, chase pixel-accurate parity with Q3 screenshots, vendor the engine, or set up deployment.

---

## 11. First actions

1. Read the OpenArena gamecode enough to build the `trap_` matrix.
2. Read meep's source and samples enough to form a view of how you'll map onto it.
3. Post one plan: architecture, phase estimates, the decisions you've already made, and anything genuinely blocking.

Then start. Don't wait for a reply unless something in step 3 was blocking.
