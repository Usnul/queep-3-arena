# Decisions

Every non-obvious choice, with the reasoning, so it can be overridden later without
re-deriving the argument. Newest phase last.

---

## Phase 0 — setup

### D-001: Repository licence changed from MIT to GPLv2

The repository was initialised with an MIT `LICENSE`. The port is a derivative work of
`bg_pmove.c`, `cm_trace.c` and the OpenArena gamecode, all GPL-2.0-only, so MIT was not an
available option. `LICENSE` is now the GPLv2 text verbatim, and `package.json` declares
`"license": "GPL-2.0-or-later"`.

Every file that contains ported logic carries an id Software / OpenArena attribution header.
Files that are original to this port (the asset pipeline, the meep integration layer) carry a
plain GPLv2 header without the id attribution, because claiming id's copyright on code they
did not write would be wrong in the other direction.

**meep is unaffected by this.** GPLv2 binds this repository's own source; it does not reach a
proprietary peer dependency that is neither vendored nor linked into a distributed binary.
That is why the "never vendor, never bundle" constraint is enforced mechanically rather than
by good intentions — see D-002.

### D-002: meep stays external, enforced by the build config

`@woosh/meep-engine` is declared in `peerDependencies` only. It is installed locally so the
port can be developed and typechecked, but:

- `.gitignore` excludes `node_modules/`, so no engine source is ever committed;
- the Vite config marks `@woosh/meep-engine` external in `build.rollupOptions`, so it cannot
  be inlined into a bundle even by accident;
- no build for distribution is produced at all, and no deployment is configured (brief §3).

The release is source-only. Anyone running it supplies their own licensed copy of meep.

### D-003: Vite 6 and Vitest 3

**Vite** because meep is deep-import-only ESM with ~6000 modules and no bundled entry point;
a dev server that serves native ESM without a bundling step is the only setup where a
cold-start edit-refresh cycle stays usable at that module count. It also makes the
externalisation in D-002 a one-line config rather than a plugin.

**Vitest** because meep itself is tested with Vitest, so its own test utilities and any future
fixture-sharing work without a second runner's semantics in the way. It shares Vite's
resolution, which matters: the deep `.js` imports must resolve identically in tests and in the
app, or the pmove oracle would be testing a differently-resolved module graph than the one
that ships.

### D-004: TypeScript `strict`, with `skipLibCheck: true` under protest

`strict: true`, plus `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax` and `isolatedModules`.

`skipLibCheck: true` is set because meep's published declarations do not typecheck standalone
— see GAP-001 in `REPORT.md`. This is recorded as a gap rather than absorbed silently, per the
brief's instruction that type quality is a finding and not an inconvenience. The port's own
code uses no `any` to work around engine types; where a meep type is wrong or missing, the
port declares a local corrective type and the instance goes in the gap register.

Two strict-adjacent flags are deliberately **off**:

- `noUncheckedIndexedAccess` — the ported physics code is dense array indexing over
  fixed-size plane and brush tables. Turning it on produces thousands of non-null assertions
  in code whose whole purpose is to be a line-by-line-auditable translation of C, which
  defeats the point of the translation being auditable.
- `exactOptionalPropertyTypes` — friction with meep's JSDoc-derived optional properties, no
  benefit to this port.

### D-005: Reference sources pinned by commit, not by tag

Both `OpenArena/gamecode` and `ioquake/ioq3` are still receiving commits. A branch or tag
reference would let the balance numbers drift under the port, and — worse — let the pmove
oracle drift under the movement tests, turning a green differential suite red for reasons
unrelated to the port. `tools/fetch-sources.mjs` pins:

- `oa-gamecode` @ `5478aad23b12857d265103f6aa2f5258c78799c8`
- `ioq3` @ `588393618dbc82e7207c21c6ddecca229944a03a`

### D-006: The `trap_` matrix is generated, not written

`tools/trap-matrix.mjs` greps the pinned gamecode for `trap_*` and joins the result against a
hand-written classification in `tools/trap-classification.json`. It exits non-zero if the
gamecode uses a syscall the classification does not cover, and splices the table into
`REPORT.md` between markers.

The matrix is the spine of the report, and a hand-maintained table of 309 rows would be wrong
within a day. Generating it means "complete" is a property the tooling checks rather than a
claim in prose. It also settles the count honestly: of 309 distinct symbols, 205 belong to
subsystems this port deletes wholesale (botlib, AAS, netcode, CD keys, cinematics, server
browser), which is worth stating before anyone reads the raw number as a measure of what an
engine must provide.

### D-007: Collision is ported, not mapped onto meep's physics

meep ships a rigid-body engine with GJK+EPA, CCD, a two-tree BVH broadphase and a kinematic
first-person character controller — on paper, exactly what a shooter needs. This port uses
none of it for player movement, and that is not a criticism of it.

Q3 movement is *defined* by the exact behaviour of `CM_BoxTrace`: which plane it reports when
a sweep straddles a brush edge, how `allsolid`/`startsolid` are flagged, the `1/32` unit
surface offset, and how `PM_SlideMove` clips velocity against up to five accumulated planes.
Strafe-jumping, ramp-jumps and air control are emergent from those specifics. Any other
narrowphase — however correct — produces different contact normals and therefore a different
game. Since the brief makes movement fidelity non-negotiable and everything else replaceable,
`cm_*` is ported verbatim and meep's physics is left for the things where drift is acceptable
(gibs, debris, ragdolls).

Consequence for the report: 19 syscalls sit in the `ported` column. That column is not a gap
list. It is the boundary of where fidelity beats integration, and it is worth the maintainer
knowing that a physics engine being excellent does not make it substitutable here.

### D-008: The pmove oracle is Emscripten-built, per the brief

Emscripten 6.0.8 is installed to `.refs/emsdk` (gitignored). Docker was present on the host
but its daemon was not running, and starting it was not this port's business; a local emsdk
is self-contained and makes the oracle build reproducible from `tools/` alone.

The alternative — a native binary exchanging test vectors over stdio — would have been an
equally valid oracle and slightly less setup. WASM wins because it runs in-process under
Vitest, so the differential test is a normal unit test with no subprocess, no serialisation
format to keep in sync, and no second thing to install in CI.

### D-009: Assets are fetched, never committed

The OA 0.8.8 archive is 425 MB. `tools/fetch-assets.mjs` downloads it and verifies the
SHA-256 recorded in `ASSETS.md`; `assets/` is gitignored in full. Verifying the hash rather
than trusting the URL matters because SourceForge serves through rotating mirrors.

### D-010: Windows path handling in tooling

`tools/fetch-sources.mjs` initially used the common
``import.meta.url === `file://${process.argv[1]}` `` entry-point guard, which is wrong on
Windows: `process.argv[1]` is `H:\git\...` and the correct URL is `file:///H:/git/...` —
three slashes and a drive letter. The guard silently evaluated false and the script did
nothing, exiting 0. All tooling now uses `pathToFileURL()`. Noted because it is the kind of
silent no-op that costs an hour when it happens inside CI rather than in front of you.

---

## Phase 1 — asset pipeline

### D-011: The simulation runs in Q3 units; the presentation layer runs in metres

Geometry, light positions and light radii are multiplied by exactly **1/32** in
`tools/convert-map.ts`. The simulation is not scaled at all.

The original plan (recorded here as it was, because the reasoning for the change is the
useful part) was to keep everything in Q3 units, on the grounds that `bg_pmove` is full of
literal constants — jump velocity 270, step height 18, the 1/8-unit velocity snap — whose
relationships to each other *are* the movement feel, and that scaling them risked divergence
against the phase-2 oracle.

That reasoning is still right about the simulation and was wrong about the renderer. meep's
lights are photometric: `PointLight.intensity` is candela, falloff is inverse-square **in scene
units**. At Q3 scale a ceiling light is ~300 units from the floor, and a level lit to a normal
brightness needs intensities in the millions. Loaded 1:1, the map renders black. See GAP-005 —
this cost about 90 minutes.

So the two systems keep their own units and the pipeline converts once, offline. The
conversion is a multiply at a single boundary rather than a factor threaded through the
physics.

**1/32 rather than 0.0254** (one Q3 unit as one inch, the usual folklore figure) for two
reasons. It puts the 56-unit player bounding box at 1.75 m instead of an implausible 1.42 m.
And it is a power of two, so the conversion is exact in binary floating point and contributes
no rounding error of its own — which matters when the same positions round-trip between a
simulation that must match a C oracle bit-for-bit and a renderer that does not care.

### D-012: Static lighting is reconstructed as dynamic lights, not imported

Q3 ships every level's lighting baked into the BSP as 128×128 lightmap pages. Two facts
together ruled that route out:

1. **meep cannot import baked lightmaps.** Its lightmap subsystem is a *baker* — see GAP-006.
2. **q3map2 strips every `light` entity from the compiled BSP** after baking. Confirmed
   empirically: across six OA maps, `light` entity count is **zero** in all of them. The lights
   only exist in the `.map` sources, which are not shipped.

So neither the baked result nor the original sources are available. What *is* available is the
`.shader` scripts, and they carry the light data q3map2 itself used: 679 `q3map_surfacelight`
declarations, 527 `q3map_lightimage`, 66 `q3map_sun`. The pipeline therefore:

- gives every `q3map_surfacelight` surface a PBR emissive, so it glows;
- places a real point light at each such surface's centroid, clustering within 3 m so a ceiling
  of panels becomes one light per fixture rather than one per polygon;
- converts `q3map_sun` into a directional light with the map's own intended azimuth and
  elevation.

This produces between 0 and 147 dynamic lights per map from real map data. It is a deviation
from Q3's appearance and it is the deviation the brief asks for: it is the version that shows
what the engine does. The performance answer is in the report — light count did not register.

**The zero is not a typo and it is the reason for D-078.** This route only carries a map's
lighting if its author lit it with surface shaders; `oa_dm5` reconstructs to nothing at all from
it. The lightgrid fit runs after this one and fills what it leaves short, which takes the shipped
range to 33 to 329.

### D-013: `.shader` scripts are read structurally, never interpreted

`tools/pipeline/shader-script.ts` reads a script's structure — name, global directives, stage
directives — and hands back tokens. It never evaluates one. `shader-to-pbr.ts` then picks out
about a dozen directives that carry information a PBR material can represent, and counts
everything it drops.

Writing a `.shader` interpreter is an explicit anti-goal, and the boundary is easy to erode one
directive at a time. Keeping extraction and projection in separate files, with the projection
holding an explicit list of what it drops, makes crossing that line a visible act rather than a
drift.

The projection that matters: a Q3 lit surface is conventionally three stages — `$lightmap`,
then the diffuse with `blendFunc filter`, then a `.blend` texture with `blendfunc add`. That
maps cleanly onto PBR: the filter stage is **albedo**, and an additive stage over a lit surface
*is* a **glow map**, so it becomes emissive. Measured lossiness across the whole OA set is in
the report's performance section.

### D-014: Only BSP model 0 becomes static geometry

Models 1..n are brush entities — doors, plats, buttons — which move. Merging them into the
world would weld every door permanently open. They are recorded and left for phase 3, where
they become their own entities with their own transforms.

### D-015: A dev-only screenshot endpoint

`vite.config.ts` serves `POST /__shot/<name>`, writing a PNG to `assets/shots/`. Verifying a
BSP conversion means *looking* at it — the difference between a correct conversion and a
plausible-looking wrong one is not visible in statistics, and reading pixels back through an
automation channel a few bytes at a time is not looking. It exists only in the dev server, and
there is no production build.

### D-016: Node's strip-only TypeScript constrains the pipeline's style

Node 24 runs `.ts` directly, which is why `tools/` can import `src/q3/**` and the BSP reader
can be shared between the pipeline and the runtime rather than written twice. The cost is that
strip-only type removal rejects anything requiring code generation: **no parameter
properties** (`constructor(private x)`), no enums, no namespaces, no decorators. Imports must
also carry a real `.ts` extension, hence `allowImportingTsExtensions`.

Sharing the reader is worth the constraint. A disagreement between two BSP readers about, say,
plane winding would surface as a physics bug that looks like a rendering bug.

---

## Phase 2 — collision and movement

### D-017: Patch (curved surface) collision is not ported yet

**Superseded in part by D-125** — curved surfaces are solid on the physics backend now. The
ported `boxTrace` still does not see them, so the rest of this entry stands for that path.

`cm_patch.c` is 1,763 lines that turn `MST_PATCH` surfaces into collision hulls. It is deferred,
and the deferral is contained rather than hidden:

- `ClipMap` counts `numPatches` for every map it loads, so a caller can tell whether a given
  level is affected.
- The differential test runs only on maps with **zero** patches — 25 of the 72 in the OA set —
  so the gap cannot mask a divergence in what *is* ported. `oa_dm1`, `aggressor`, `oa_dm2`,
  `q3dm6ish` and `islanddm` are the five it uses, spanning 449 to 9,384 brushes.

Consequence while it is missing: on a patch-bearing map, curved surfaces are not solid to
`boxTrace`. That is a real gap and it is why the deferral is recorded here rather than treated
as done.

### D-018: Capsule tracing is not ported

`CM_BoxTrace`'s `capsule` parameter and the `CM_Trace*Capsule*` family are unported. Every call
in OpenArena's movement path passes `qfalse`; capsules exist for player-vs-player clipping in
ioquake3, which is server-side entity code this port replaces with meep's BVH anyway
(`trap_EntitiesInBox` in the matrix). Porting ~400 lines of dead code to have it agree with an
oracle that never exercises it is not worth the reading burden on `trace.ts`.

### D-019: The port reproduced the C's float32 rounding, rather than tolerating divergence

**Struck by D-174.** Kept because the argument is still the right one for a port whose goal is
bit-exactness, and because two of the bugs below were found by the exactness it bought. What
changed is the goal, not the reasoning.

`cm_trace.c` computes in `float`. JavaScript computes in `float64`, which is *more* precise --
and that was treated as a problem, not a benefit, because the trace's decisions are exact
comparisons on near-cancelling quantities (`d1 > 0 && d2 >= d1`, `enterFrac < leaveFrac`,
`t1 >= offset + 1`). Being more precise than the oracle produces a *different* answer, not a
better one.

Measured at the time: 4,000 randomised player-sized sweeps against `oa_dm1` in double precision
produced 2 divergences -- one a 1.4e-5 fraction difference, one a grazing contact the port missed
entirely because a tie broke the other way.

So `src/q3/cm/trace.ts` wrapped every arithmetic step in `Math.fround`, `src/q3/math.ts` was a
float32 vec3 library, and `dot3` reproduced `DotProduct`'s left-to-right association exactly.
`Math.fround` compiles to a single machine instruction under V8, so the runtime cost was
negligible; the cost was readability, paid down with a block comment explaining why.

The payoff was that the differential tests could demand **exact** equality. A tolerance would have
hidden precisely the class of bug this exercise exists to catch -- and did: see D-020.

### D-020: Two real bugs the oracle caught that review would not have

Both were found by the differential suite, and neither was visible by reading the port against
the C.

1. **The missing `SURFACE_CLIP_EPSILON` in `CM_BoundsIntersect`.** The C widens a brush's
   bounding box by 1/8 unit on every axis *before* deciding whether to test the brush at all.
   I had written a plain AABB overlap. The result was that the port silently skipped brushes it
   merely grazed — 1 divergence in 4,000 sweeps, invisible in ordinary play, and exactly the
   kind of thing that makes a strafe jump land differently on one map in twenty.

2. **A float32 mantissa in the test harness.** The oracle originally marshalled the whole
   `trace_t` back as floats. Content masks run to `0x20000001`, which needs 30 mantissa bits, so
   it came back as `0x20000000`. This presented as the *port* disagreeing about `contents` on
   one map in five — a convincing-looking port bug that was entirely in the measuring
   instrument. Flag fields now travel through an int buffer.

The second is worth recording precisely because it is embarrassing: a differential test is only
as trustworthy as its plumbing, and "the port is wrong" was the wrong conclusion for an hour.

### D-021: The oracle is built from OpenArena's `bg_pmove.c`, not ioquake3's

The brief says to compile ioquake3's `bg_pmove.c`. The two differ by more than formatting —
`pm_wadeScale`, `pm_swimFastScale`, the `cg_enableQ` scale hook, and two extra `pmove_t` fields
(`pmove_float`, `pmove_flags`) — across 710 differing lines. Since the port is of OA's gameplay
and the assets are OA's, an oracle built from ioquake3's pmove would be testing the port against
code the port is not a port of.

So: **`bg_pmove.c`, `bg_slidemove.c`, `bg_misc.c`, `q_math.c` and `q_shared.c` are OpenArena's;
`cm_*` are ioquake3's**, which is the split the brief actually intends — OA does not ship engine
code.

All of it compiles **unmodified**. Making that work needed only build-configuration changes:
`Q3_VM` and `BOTLIB` must be left *undefined* rather than defined to 0 (they are tested with
`#ifdef`), `NDEBUG` selects the release allocator forms, and OA's `q_platform.h` predates
WebAssembly so the six platform macros ioquake3's `__EMSCRIPTEN__` block defines are supplied on
the command line. Unmodified sources are the property that makes this an oracle rather than a
second implementation.

### D-022: The weapon state machine and torso animation are not ported

`PM_Weapon`, `PM_BeginWeaponChange`, `PM_FinishWeaponChange`, `PM_TorsoAnimation` and
`PM_Animate` write `weaponTime`, `weaponstate`, `torsoAnim` and `torsoTimer`. None of those feed
back into position or velocity, so movement does not need them; phase 3 does, and adds them
there.

The interesting part is how the differential test copes. Those functions *raise events*, so the
oracle's `eventSequence` would run ahead of the port's for a reason unrelated to movement. Two
options:

1. Exclude `eventSequence` from the comparison. Rejected: it would also hide a genuinely
   missing *movement* event, which is the failure mode this suite most needs to catch — and
   which it did in fact catch twice (D-023).
2. Make the C take its own early-out. `PM_Weapon` opens with
   `if ( ps->persistant[PERS_TEAM] == TEAM_SPECTATOR || ... ) return;`, and `PERS_TEAM` is read
   nowhere else in `bg_pmove.c` or `bg_slidemove.c`. Setting it on both sides disables exactly
   the unported subsystem and nothing else, without modifying any C.

Option 2 is what the suite does.

### D-023: Four real bugs the pmove oracle caught

**Bugs 1 and 2 are float32-fidelity findings and are no longer live requirements** -- D-174 struck
the rounding they are about, and `OVERCLIP` is the decimal `1.001` again. They stay because they
are the evidence for what exactness bought while the port had it, and because bugs 3 and 4 are
transcription bugs that the suite still catches.

None of these were visible by reading the port next to the C. All four produced *plausible*
behaviour — a player who moves, jumps and collides — and would have been found, if at all, as
"the movement feels slightly wrong".

1. **`OVERCLIP` is `1.001f`, not `1.001`.** The float32 value is 1.0010000467300415, and every
   surface clip multiplies by it. Using the double drifted by one ULP per clip, which showed up
   only after ~140 frames of bunny hopping and nowhere earlier. `MIN_WALK_NORMAL` is `0.7f` for
   the same reason.

2. **`PM_CrashLand`'s `t` stays in double.** `t = (-b - sqrt(den)) / (2*a)`: `sqrt` returns a
   double, so the numerator promotes and the whole expression stays double until it lands in the
   `float t`. Rounding the square root early shifted `delta` by a few ULPs, and `delta` is
   compared against 1, 7, 40 and 60 — a landing sitting just either side of `delta < 1` changes
   whether an event fires at all.

3. **`PM_StepSlideMove` raises step events I had not ported.** The `EV_STEP_4`/`8`/`12`/`16`
   block sits after an `#if 0` at the bottom of `bg_slidemove.c`, and I stopped reading the
   function at the `PM_ClipVelocity` above it. Position and velocity agreed bit-for-bit; the
   port was exactly one event behind after ~40 frames.

4. **`CM_PositionTest` expands the box for leaf selection only.** The C builds a local
   `leafList_t` whose `bounds` are the player box grown by one unit on each axis, and uses that
   for the tree walk — while `CM_TestBoxInBrush` keeps rejecting brushes against the
   *unexpanded* `tw->bounds`. I had written the expanded box into `tw->bounds`, making the axial
   rejection one unit too generous, so a player standing on a floor tested as inside it.
   Symptom: crouch, release crouch, and `PM_CheckDuck`'s headroom probe reports solid, so the
   player never stands up again.

**Bug 4 also exposed a hole in the trace suite.** `CM_PositionTest` runs only when
`start == end`, and randomised sweeps never generate that, so the entire position-test path was
untested — the *pmove* suite found it instead. The trace suite now has a dedicated
position-test case, alternating standing and crouched boxes. Worth stating as a general lesson:
a differential suite over randomised inputs tests the paths random inputs reach, and degenerate
cases have to be asked for by name.

---

## Phase 3 — game simulation

### D-024: Balance numbers are extracted from the C, not transcribed

`tools/extract-balance.mjs` parses `bg_itemlist[]` out of `bg_misc.c` (60 items) and pulls every
weapon's damage, splash, projectile speed, fire rate and item respawn time from `g_weapon.c`,
`g_missile.c`, `bg_pmove.c` and `g_items.c`. Output is committed as
`src/game/balance.generated.json`; `--check` fails if it drifts.

Each regex is **scoped to a named C function** rather than searched file-wide. That earned its
keep immediately: `Weapon_Gauntlet` is an *empty function* in OpenArena, and the gauntlet's
damage and reach live in `CheckGauntletAttack`. A file-wide search for
`damage = <n> * s_quadFactor` would have matched some other weapon and produced a plausible
wrong number that nothing would ever have caught.

### D-025: The simulation raises events; the presentation decides what they look like

`WeaponSystem` knows about damage and traces and nothing about rendering. `Effects` knows about
particles and decals and nothing about damage. `Arena` is the only class that knows both, and
it is thin.

This is not architecture for its own sake — it is what makes the Q3 replacement rule tractable.
The brief says particles, decals and sound are meep's and Q3's go in the bin, while damage and
balance stay faithful. Those two rules apply to different sides of this line, and keeping them
in separate files means neither can quietly contaminate the other.

### D-026: Weapon spread reproduces `Q_crandom`, not `Math.random`

Shotgun pellet placement is a balance number. Q3 lays out its eleven pellets by a specific
sequence from a per-shot seed, and a different distribution — even one with the same variance —
is a different weapon at close range. The generator is reproduced and seeded per shot as the C
does.

### D-027: Targets are boxes, and the target is not a player

Phase 3's exit condition is "playable deathmatch against a stationary target". The target is a
player-sized box (`-15,-15,-24` to `15,15,32`) with health, hit detection and a respawn timer,
placed at the map's own spare spawn points.

Player-sized deliberately: splash falloff is computed from the *closest point on the bounding
box* rather than from the centre, as `G_RadiusDamage` does, so a wrongly-sized target would
silently change how much splash damage lands. Getting the box right means the damage numbers
being verified are the real ones.

Not ported into this: player-vs-player collision, gibbing, or the death animation. A killed
target detonates and comes back after three seconds, which makes the kill legible without
inventing content.

### D-028: `dead` is set before the hit event, not after

Found by testing: rocket damage was exactly 100, the target's health reached exactly 0, and the
kill counter stayed at zero. The event was being raised before the flag was set, so the only
listener that cares whether a hit was fatal could never see that it was.

Q3 does the same thing the right way round — `G_Damage` calls `player_die` from inside itself
rather than after returning. Recorded because the failure mode is instructive: every *number*
was correct and the bug was purely in ordering, which is exactly the kind of thing a damage
test that only asserts on health totals will not catch.

---

## Direction change - meep's physics for movement

### D-029: Movement runs on meep's physics; the ported `cm_*` becomes the reference

Overriding D-007 on the maintainer's instruction: *"I appreciate that collision code in Q3 is
entirely different from the standard modern physics engine, but I believe that meep's physics is
the right way to go here, tuning movement and controls to match as closely as possible."*

**What changed, and what deliberately did not.** `pm->trace` is a callback in Q3 and is a
callback here, so the swap happens at that one seam. `bg_pmove` itself is untouched - the
acceleration, the plane clipping, the step logic, the velocity snap, all of which is where
strafe jumping actually lives. Only the question *"what does this box hit"* is answered
differently.

**The collision volumes are still Q3's.** Every solid brush becomes one static `RigidBody` with
a `ConvexHullShape3D`. A Q3 brush is the intersection of its half-spaces, which is exactly a
convex polyhedron, so `brushHull.ts` converts the plane set into vertices and faces losslessly
using `cm_polylib.c`'s own winding algorithm. Building collision from the *render* geometry
instead would have been wrong in both directions - Q3 maps carry `playerclip` brushes that block
and do not draw, and detail brushes that draw and do not block.

**The oracle became the tuning instrument rather than a pass/fail gate.** "As closely as
possible" is not actionable without a number. `tools/measure-divergence.ts` runs identical input
through three configurations - the C oracle, the port on the ported clipmap, and the port on
meep physics - and reports how far the third drifts from the first. The attribution argument was
"the second is bit-exact, so any divergence in the third is the collision backend and nothing
else"; since D-174 the second is not bit-exact, and the argument is the measured one instead --
the clipmap's own worst single-step disagreement with the C is 1e-3 units against a backend
divergence measured in whole units, three orders of magnitude apart, so the attribution holds
with room to spare. The clipmap backend still ships behind `?trace=clipmap` so an A/B is a refresh rather than
a rebuild.

Measured on `oa_dm1` and `aggressor`, in Q3 units (one unit is roughly 3 cm):

| metric | result |
|---|---|
| contact normals agreeing with Q3 | 98.2-99.6% of valid-plane hits |
| sweep fraction error | median 0, p90 ~1.5e-3 |
| hit/miss agreement | 88-90% |
| position error, median | 0.00-0.22 units |
| position error, bunny-hop p90 | 0.12 units |

### D-030: Three things had to be restored on top of meep's physics

Each was found by measurement, not by reading, and each is a case where meep's answer is
reasonable and Q3's is different.

1. **The surface epsilon.** `CM_TraceThroughBrush` computes
   `f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2)`, so every Q3 trace stops 1/8 unit short and a
   resting player floats in a small gap. `shape_cast` stops exactly at contact, which sounds
   better and is catastrophic: the player lands flush, that resting contact then blocks every
   subsequent sweep at `t = 0`, and they freeze one frame after touching down. Measured:
   bit-exact for nine frames of falling, then permanent divergence at the instant of landing.

2. **`startsolid` is not "touching".** `shape_cast` reports `t = 0` both for a box resting *on*
   a floor and for one buried *in* it. Q3 distinguishes them - `startsolid` means behind every
   plane of a brush - and the difference matters because `startsolid` routes pmove into
   `PM_CorrectAllSolid`, which jitters the player a unit in each direction hunting for space.
   `overlap_shape` answers exactly the right question, so it is asked rather than guessed at.

3. **Contact plane selection at corners.** The dominant remaining error, and the most
   interesting one. EPA returns the minimum-penetration axis; `CM_TraceThroughBrush` returns the
   **latest entering plane**. On a flat wall they agree. In a corner they do not: measured,
   meep returned `[0, 1, 0]` where Q3 returned `[-1, 0, 0]`, `PM_SlideMove` clipped velocity
   against the wrong plane, accumulated a contradictory one on the retry, hit its five-plane
   limit and zeroed the player's velocity - the player stopped dead, wedged, a metre from the
   corner. The plane is now re-derived by Q3's rule against the hit brush's own planes, and
   across every brush the box is touching, because `CM_TraceThroughLeaf` compares entry
   fractions across all brushes in a leaf and a corner is usually two brushes rather than two
   faces. This one change took bunny-hop's p90 error from 56 units to 0.12.

### D-031: What is still different, and what it costs

Honest about the remainder rather than quiet about it.

- **Flush contacts.** Q3 maintains an invariant that a player is never closer than
  `SURFACE_CLIP_EPSILON` to a surface. The physics backend can reach a genuinely flush position
  (zero gap), which Q3 would call `startsolid` and which has no valid contact plane. It is
  recoverable - the player slides out - but it is a state Q3 never enters. This is the cause of
  the remaining `walk-into-walls` divergence, whose median is 0.09 units but whose tail is long.
- **1,381 of 20,000 sampled sweeps** report a blocking contact where the clipmap reports none,
  almost all of them at `t = 0` resting contacts. An attempt to make these permissive - letting
  the move complete, which is what `CM_TraceThroughBrush` does when a sweep starts inside a brush
  and exits it - was **eight times worse**: hit/miss agreement fell from 88% to 10% and the
  player began tunnelling through walls. The reason is that Q3's early return is *per brush* and
  the leaf's other brushes are still tested; a whole-trace `fraction = 1` skips all of them.
  Reverted, and recorded because it read as obviously correct.
- **Long-horizon divergence is expected and is not the number to tune on.** Two runs that
  separate then explore different parts of a level produce arbitrarily large position errors.
  The median and the early-frame behaviour are the meaningful figures; the max is chaos.

### D-032: `cm_trace` stays, and stays the reference

The ported clipmap is not dead code. It is:

- the **reference** the physics backend is measured against, and the reason any divergence can
  be attributed to the backend rather than to the port;
- the source of **`CONTENTS_*` queries** - water, lava, slime, teleporters. Those are Q3
  semantics, not collision, and a physics engine has no opinion on whether a volume is slime;
- the **contact plane oracle** - `PhysicsWorld` re-derives normals using the same rule, against
  the same brush planes;
- a **shipping A/B**, behind `?trace=clipmap`.

Its differential suites still run against the C. They stopped demanding bit-exactness at D-174
and demand measured agreement instead; the heading used to say "and stays bit-exact".

---

## Breadth: items and pickups

### D-033: Items are simulation, their bob and spin are presentation, and the split is Q3's own

`src/game/Items.ts` holds spawning, touching, giving and respawning, in Q3 units, importing
nothing from meep. `src/client/ItemsView.ts` holds the bobbing, the spinning and the hiding.
That is not a tidiness preference -- it is where Q3 draws the same line. The server knows an item
exists and where; that it bobs at `4 + cos((time + 1000) * (0.005 + entityNumber * 0.00001)) * 4`
and spins once every 2048 ms is decided entirely in `cg_ents.c` and never leaves the client.

Both rates are ported rather than chosen. They are part of how a Q3 level reads at speed: a
rocket launcher catches the eye across a room because of the rotation, and the per-entity term in
the bob rate is what stops a row of eight armour shards pulsing in unison.

Picked-up items toggle `ShadedGeometryFlags.Visible` rather than being destroyed and rebuilt. The
naive version costs a meshlet build per item per respawn -- on a level with 31 pickups and a
25-second armour cycle that is a rebuild every second, for geometry that never changed.

### D-034: Faithful includes the parts that look like mistakes

`BG_PlayerTouchesItem` accepts a player between 50 units behind an item and 44 in front of it on
X, and is symmetric on Y and Z. Nothing explains the asymmetry, it is almost certainly a typo,
and it is ported verbatim with a test pinning both bounds. The same applies to health pickups
being allowed past max health based on their *quantity* being 5 or 100 rather than on a flag.

The argument for keeping them is not reverence. It is that these are the rules players learned:
the strafe jump is a bug too, and a port that quietly fixes bugs produces a game that is
recognisably wrong in ways nobody can name. Where a Q3 rule genuinely could not be reproduced,
that is a gap entry, not a silent improvement.

### D-035: One model bundle, lazy meshlets

76 static models -- every pickup, weapon world model, ammo box and gib -- convert into a single
`models.json` plus `models.bin`, and geometry is built on first use rather than at load.

The first half is about request shape: 900 KB across 76 files is a batching problem. The second
half is GAP-008: `meshlet_geometry_build_from_geometry` is synchronous and on the main thread, a
typical arena spawns about 20 distinct models, and building all 113 meshes up front would spend
most of that time on props the level never places. Measured, the lazy build costs 4-6 ms on
`oa_dm1`.

MD3's own animation is not read here. Item models are single-frame; player models are the
vertex-morph case the brief says to replace rather than port, and they go through a separate
converter.

### D-036: The physics bodies had no colliders, and the harness that measured them hid it

Recorded as a decision rather than only as GAP-014, because the *process* failure is the part
worth not repeating. The headless divergence harness deliberately duplicates `PhysicsWorld`'s
trace maths so that a conversion bug cannot cancel itself out of the measurement (D-029). It also
builds its bodies by calling `PhysicsSystem.link` and `attach_collider` directly, because there
is no ECS under Node.

That second duplication was not deliberate and it is the one that cost time: it meant the
harness never needed `ColliderObserverSystem`, so the browser path -- which does -- was
unexercised by every test in the suite while reporting excellent numbers. Independence bought
trustworthy measurements of the algorithm and, in the same stroke, stopped measuring the thing
that actually ships.

The fix in the code is a factory that registers both systems before building any body, so the
order cannot be got wrong from outside. The fix in the process is that the browser build is now
smoke-checked -- player at rest on a floor, items at `floor + 15 + 1/8` -- as part of finishing
a phase rather than as part of looking at it.

---

## Breadth: movers, triggers and jump pads

### D-037: Brush entities are BSP submodels, and the converter had to stop pretending otherwise

`convert-map.ts` originally emitted model 0 and left a comment saying models 1..n were phase-3
work. That comment was right about the danger and wrong about the timing: a converter that merges
every model into one vertex block welds every door permanently open, and one that emits only
model 0 leaves a level with holes where its doors should be.

Each BSP model now gets its own group map and its own vertex block, and `scene.json` carries a
`submodels` table saying which meshes belong to which. Model 0 is drawn as one static batch;
1..n each get a transform. The same split runs through collision: `buildHulls` grew a brush range
so the world's brushes become static bodies and a submodel's become that mover's.

The failure mode this avoids is worth naming, because it is invisible. An unranged `buildHulls`
turns a door's brushes into *static* bodies at the door's closed position -- so the door's
geometry opens and its collision does not, and the level looks correct while being unplayable in
one specific doorway.

### D-038: Movers ride on meep's kinematic bodies, and the clipmap backend clips against them by hand

Two backends, two mechanisms, one simulation.

On the physics backend a submodel's brushes become `KinematicVelocity` bodies and `MoversView`
writes their transforms. `shape_cast` then finds them with no further work: the world trace and
the entity trace are the same query, which is a genuine simplification over Q3, where
`SV_Trace` walks the world and then loops over every solid entity by hand.

`KinematicVelocity` rather than the better-named `KinematicPosition` because the latter's own
docblock says it is reserved and not implemented, with an explicit instruction to prefer velocity
until it lands. This port has no dynamic bodies for a mover to push, so only the query broadphase
matters, and that tracks the transform.

The ported clipmap needs the loop, so it has one: `entityClip.ts` is `SV_ClipMoveToEntities`
reduced to the translation-only case, since Q3 doors, plats and buttons all have zero angles.
Keeping the A/B honest was the point, and it paid immediately -- both backends report a sweep
fraction of exactly 0.424 through a closed door on `oa_dm1` and exactly 1.0 through the same
doorway once it opens.

### D-039: Unimplemented brush entities are solid rather than absent

`func_static` is spawned as a static body. So is anything else with a brush model that this port
does not simulate -- `func_rotating`, `func_bobbing`, `func_train` -- and each is named in
`MoverSystem.unhandled` so the loss is recorded.

The alternative is dropping them, and the two failures are not symmetric. A fan that does not
spin is a cosmetic loss in one corner of one room. A fan you can walk through is a hole in the
map, and it is the kind of hole a player finds and a developer does not. Triggers are the
exception and are genuinely dropped: an unimplemented trigger is non-solid and invisible in Q3
too, so ignoring it costs a behaviour rather than a wall.

### D-040: Jump pads are solved, not scripted

`trigger_push` in Q3 does not carry a velocity. It carries a `target`, and `AimAtTarget` solves
for the launch that lands there under `g_gravity`: `time = sqrt(height / (0.5 * gravity))`, so
the vertical component is `time * gravity` and the horizontal is whatever covers the ground
distance in that time. That is ported rather than approximated, and the test asserts the
*property* rather than the numbers -- it integrates each solved launch forward under gravity and
checks it arrives within a hundredth of a unit of the target. Measured on `oa_dm7`, all four
pads.

Two things fall out of doing it properly. Q3 deletes a pad whose target is not above it, because
`sqrt` of a negative puts a NaN in `ps->velocity` and a NaN there propagates through every
subsequent pmove; that guard is ported. And `BG_TouchJumpPad` *overwrites* velocity rather than
adding to it, which is why a jump pad launches you identically however fast you ran onto it --
a detail players rely on and a naive `+=` would break.

### D-041: What movers do not do

Recorded rather than left to be discovered.

- **No crush.** `G_MoverPush` calls `ent->blocked` when a push cannot be resolved, and
  `Blocked_Door` either damages the player for `dmg` or reverses the door. Here a mover simply
  displaces whatever it overlaps, so it is possible to be shoved into geometry rather than
  crushed or reprieved. Riding and being pushed both work; being crushed does not.
- **No `func_rotating`, `func_bobbing`, `func_pendulum` or `func_train`.** All four are solid and
  stationary, per D-039. None appear in the six converted maps.
- **No shootable doors.** `oa_dm1`'s `*8` has `health 1` and opens when shot. The damage system
  does not reach brush entities yet, so it stays shut. It is the only one across the six maps.
- **No door teaming.** Q3 links doors that touch into a team with a shared trigger and a single
  master. Doors that should open together do so here because they share a `targetname`, which
  covers every case in the six maps but is not the same rule.

---

## Breadth: characters

### D-042: MD3 vertex morph becomes a skeleton by decomposition, not by hand-rigging

The brief says to replace the animation pipeline rather than port it, and meep's loader makes that
concrete: `load_gltf` maps the glTF `weights` channel to `-1` and skips it, so there is no
morph-target path and no amount of care with the MD3 data will produce one. A Q3 player model has
no bones. One has to be *inferred*.

The method is a reduced skinning decomposition, after Le & Deng's SSDR without the weight-solve
stage:

1. **Cluster by trajectory.** Two vertices that follow the same path through every frame belong to
   the same bone, which is the definition of a bone. k-means over the concatenated per-frame
   positions therefore finds bones without being told what a limb is. Absolute positions rather
   than displacements, because displacement-only features merge the left and right feet -- they
   follow mirrored paths that are identical in magnitude for half the cycle.
2. **Fit a rigid transform per cluster per frame**, by Kabsch, via Horn's quaternion method. Not an
   SVD: an SVD-based Kabsch has to check `det(R) < 0` and flip a column, and getting that wrong
   produces a reflection that reconstructs the points perfectly and turns the model inside out.
   Horn's method goes straight to a quaternion and cannot reflect.
3. **Reassign and refit.** Each vertex moves to whichever cluster reconstructs it best across all
   frames. This is what lets a bad initial split recover.

Seeding is farthest-point rather than random, so the pipeline is deterministic. A converter that
emits a different skeleton on every run makes every diff useless.

**Measured, 32 joints per part, across the 15 convertible characters** (one Q3 unit is about 3 cm):

| | mean error | worst |
|---|---|---|
| best (`smarine`) | 0.005-0.009 | 0.15 |
| median | ~0.07 | ~1.8 |
| worst (`gargoyle` torso) | 0.267 | 4.21 |

A mean of 0.07 units is two millimetres on a 1.75 m character. The joint count was chosen from the
curve rather than by taste: on `sarge`'s legs, 16 joints gives 0.102, 24 gives 0.043, and 32 gives
0.042 -- the knee is at 24, and the torso keeps improving to 32, so 32 for both.

Every vertex ends with a single influence at weight 1. Real skinning blends four; the cost of not
doing so is a crease at cluster boundaries rather than a bend. Solving for smooth weights is the
obvious next step and is not done.

The alternative worth naming because it is tempting: one joint per vertex, with each joint's
translation track *being* that vertex's trajectory. That is bit-exact, and it turns a 278-vertex
leg into a 278-joint skeleton with a 17 KB matrix palette per instance. Exactness is not worth 40x
the joints when the error at 32 is a fraction of a millimetre.

### D-043: The three-part structure survives into the glTF, because it is load-bearing

A Q3 player is `lower.md3`, `upper.md3`, `head.md3`, joined by `tag_torso` and `tag_head`, and the
split is not an artefact of 1999 tooling: **the legs and the torso animate independently**. A
player runs and fires at the same time, from two clips chosen by different rules from different
state.

So the output is two skins and two sets of clips over disjoint joint sets, with Q3's own
`LEGS_*` / `TORSO_*` / `BOTH_*` names kept. Playing one of each is two entries in meep's clip list,
not a blend tree. The torso's joints are children of the `tag_torso` node, so the tag composes with
the torso's own rig instead of having to be baked into every frame of it.

Two details that are silent failures if missed, both pinned by tests:

- **The legs frame correction.** `animation.cfg` writes legs frame numbers as offsets into the
  whole animation set, but they index into `lower.md3`, which does not contain the torso-only
  frames. `CG_ParseAnimationFile` subtracts the gap. On `sarge` that gap is 63, and without it
  every legs animation plays 63 frames late -- running plays a death.
- **The tag axis convention.** MD3 stores forward/left/up, and they are the *columns* of the
  local-to-parent rotation, not the rows. `CG_PositionRotatedEntityOnTag` settles it by composing
  the origin as `parent + sum(origin[i] * parentAxis[i])`. Reading them as rows transposes every
  tag, which inverts each rotation -- heads face backwards on any character whose torso is turned,
  and are correct on any character standing square.

### D-044: The verification is a numerical replay, not a screenshot

There are four places for this pipeline to be wrong -- the rig, the axis conversion, the frame
sampling, and the tag composition -- and all four produce a model that loads and renders and is
subtly wrong. Looking at it catches a mirrored character; it does not catch a run cycle that is
one frame out.

So `test/characters.test.ts` reads the emitted glTF back, evaluates the skinning by hand the way a
renderer would -- inverse bind matrix, joint quaternion, joint translation -- and compares against
the MD3 frames the file was built from. The tolerance is the rig's own measured error rather than
a number chosen to make it pass, so a sampling bug shows up as a mean an order of magnitude above
the rig's.

The tag test checks the rotation by what it *does* rather than by its components: applying it to
the local forward axis must give the tag's own forward vector. A transposed matrix-to-quaternion
conversion passes any component-wise check loose enough to pass at all, and fails this one at once.

The structural half runs over all 15 characters, because the failures it catches -- an out-of-range
joint index, weights that do not sum to one, a missing `POSITION` min/max -- are per-model and are
exactly the kind of thing that first appears on the fourteenth.

### D-045: What the character pipeline does not do

- **`angelyss` is not converted.** OA 0.8.8 ships its `lower.md3` and no `upper.md3` or
  `head.md3`. Reported rather than silently skipped.
- **One influence per vertex**, so joints crease rather than bend. See D-042.
- **No LOD.** MD3 carries up to three levels of detail as separate files (`lower_1.md3`,
  `lower_2.md3`); only the base model is read.
- **No weapon attachment.** `tag_weapon` is parsed and not used, because there is no third-person
  view to hang a weapon in yet.
- **Heads never animate**, which is faithful: Q3 draws the head at frame 0 always.

---

## Breadth: audio

### D-046: One-shots through sopra directly, not `AudioEmitter` components

**Reversed by D-065.** Kept as written, because the argument below is the one that had to be
answered and the answer turned out to be about consistency rather than about cost.

Q3's sound model for everything a weapon, a pickup or a door does is
`S_StartSound(origin, entity, channel, handle)`: fire-and-forget, at a point, no handle kept.
sopra's `playOneShot(description, { position })` is the same shape, so the port is a bank of
`EventDescription`s and a function that plays one.

The component route -- an `AudioEmitter` entity per sound -- is the right answer for a torch that
hums and the wrong one for a machinegun firing ten times a second: an entity built and destroyed
per shot. `AudioEmitterSystem`'s own docblock settles it, in that only *looping* events take the
spatially-managed path; a finite one-shot takes the direct path anyway. The system is still
registered, because it is what creates the shared sopra engine, registers the sound asset loader,
forwards the listener pose and ticks the mixer.

Random variants are picked by the game, not by a `RandomContainerAudioClip`. That is the faithful
arrangement -- `CG_FireWeapon` does `rand() % 4` itself -- and it means the four machinegun
flashes and four footsteps behave as Q3 intends rather than as the audio engine's container
policy decides.

### D-047: Attenuation is Q3's range, on a curve that matches its shape

`S_Base`'s `SOUND_RANGE_DEFAULT` is 1250 units and `SOUND_FULLVOLUME` is 80, which at this port's
scale is flat inside 2.5 m and falling away over the next 36. Those two numbers are why a rocket
across a Q3 arena is faintly audible rather than silent.

The curve is built with `buildAttenuationCurve` over `interpolate_irradiance_smith` rather than a
straight line. Smith sheds two thirds of its level inside the first seventh of the range, which is
much closer to Q3's own falloff than linear, and the builder's own docblock explains why it
matters: keyframes land where the curvature is rather than being spread evenly across a long quiet
tail nobody hears themselves cross.

Measured in the running app, by tapping the master bus with an `AnalyserNode` and reading RMS
after playing one rocket at a series of distances from the listener:

| distance (Q3 units) | 0 | 80 | 300 | 800 | 1250 |
|---|---|---|---|---|---|
| RMS | 0.891 | 0.795 | 0.193 | 0.034 | 0.000 |

Flat to `distanceMin`, monotonic after it, silent at `distanceMax`. That is the check that matters
and it is not one a headless test can make -- Web Audio needs a browser and a running context --
so it is recorded here with its method rather than pinned by a test.

### D-048: Footsteps come from distance travelled, because they cannot come from the animation

`CG_PlayerAnimation` fires a footstep from two fixed points in the leg cycle, so steps speed up
with the run rather than drifting against it. There is no animation driving the local player here
-- it is a first-person camera -- so the cycle is reconstructed from the quantity the animation is
itself a function of: distance travelled, one step every 48 units. Below a walk Q3 plays no
footstep at all, which is kept.

### D-049: The sound set is curated, and misses are reported

OA ships about 40 MB of audio, most of it announcer lines, taunts and per-character voice for
modes this port does not have. `convert-sounds.ts` copies the 77 files something in the port
actually triggers -- 8.1 MB, of which 1 MB is one music track and 2.7 MB is long ambient loops --
and the manifest records anything named by the code and absent from disk, because that is a bug,
while a file on disk that nothing names is not.

Half the list is curated and the other half is read out of the built maps, because half of it is
per-map data rather than gamecode: `target_speaker` names its own ambience and `worldspawn` names
its own music (D-066). Both halves are named by the same `soundName` the runtime derives names
with, so a map's string and the copied file cannot drift apart. Two names come back missing on
every run -- `oa_dm1` and `oa_dm5` ask for `music/sonic6.ogg` and `music/sonic3.ogg`, Q3-original
tracks OA does not ship -- and that is the manifest doing its job rather than a fault to fix.

Copied rather than transcoded, which lasted until someone checked the premise: "assets that are
not committed anyway" was wrong -- `assets/` is committed, and only `ml/` and `download/` are not.
The bank is Ogg Vorbis now, at a sixth of the size, and the quality argument was measured rather
than assumed. See D-175.

---

## Breadth: bots

### D-050: A bot is a `usercmd_t`, not a moving object

Every bot owns a `pmove_t` built by the same `createPmoveHost` the player uses, fills a
`usercmd_t`, and runs `Pmove`. That is Q3's own arrangement -- `BotAIStartFrame` fills a
`usercmd_t` and hands it to the same `ClientThink` a human's goes through -- and it is the
property worth keeping: a bot accelerates, strafes, steps, falls and strafe-jumps identically to
the player, because it is running the identical code.

The alternative, and what most ports do, is to lerp a bot toward its next waypoint. That produces
something that occupies the same room as the player and is not the same kind of object: it cannot
be out-strafed, it does not slide off a ramp, and it arrives places the player cannot.

Measured on `oa_dm1`: six bots at 1.3-1.8 ms a frame including perception, the behaviour tree,
`Pmove` and character placement. One bot was observed at 381 units per second, which is above the
320-unit run speed -- it had strafe-jumped, without anything in the bot code knowing what that is.

`createPmoveHost` was extracted from `PlayerController` for this, and the extraction is the point
rather than a tidy-up: two movement setups is two games.

### D-051: Navigation is a floor sample, and the first two attempts are in the record

No AAS, per the brief. What replaced it took three tries, and the failures are more useful than
the result.

1. **Item and spawn entities as nodes.** The reasoning was sound -- AAS goal areas are
   overwhelmingly item locations -- and the result was not: 50 nodes, 91 links, and a largest
   connected component of *three*. Items are scattered and the straight line between two of them
   almost always clips a pillar.
2. **A floor sample at 96-unit spacing.** 357 nodes, and a largest component of 29%. Better, and
   still one component per storey: a walk link cannot cross a drop, and a Q3 arena is layered.
3. **64-unit spacing, one-way drop edges, and teleporters and jump pads as edges.** 766 nodes,
   1,956 links, 213 drops, and 53% in one piece.

Each number is measured, and the spacing was chosen from the curve rather than by feel: on
`oa_dm7` the largest component is 49% at 96-unit spacing, 91% at 64, and 92% at 48. 64 is where it
flattens, and the reason is that a Q3 corridor is often 128 wide -- at 96 spacing it gets a single
column of nodes, and a single column makes a T-junction into two components.

Two edge kinds are not optional on a Q3 map:

- **Drops**, which are AAS's `TRAVEL_WALKOFFLEDGE`. Without them the graph is per-floor.
- **Jump pads and teleporters**, which are how a map like `oa_dm7` connects at all. Measured:
  item-to-item reachability there goes from 33% to 51% purely by adding the four pads as edges.

The operational metric is not the component size but "can a bot get from one item to another":
85% on `oa_dm1`, 95% on `aggressor`, 51% on `oa_dm7`, 27% on `am_thornish`. The last two are maps
built around jumping, and a walk-only graph is honestly worse at them.

### D-052: Three bugs that each looked like a different bug

Recorded because each cost real time and each had a misleading symptom.

- **Bots planned routes and stood still.** The behaviour tree was ticked every frame and never
  restarted. A tree is a *plan*: once the root reports `Succeeded` it is finished, and
  `SequenceBehavior.finalize` parks its cursor past the last child, so every subsequent tick
  short-circuits to `Succeeded` on the first line. The first frame's planning branch succeeded and
  the tree was still reporting that success 900 frames later. Q3 has the same shape and hides it --
  `AINode_*` returns and is called afresh next frame -- so the restart is now explicit, with the
  reason written down next to it.
- **Bots walked into walls forever.** The route's first node came from `nearest`, which is
  straight-line, so a bot standing a stride from a wall frequently had its nearest node on the far
  side of it. Fixed by `nearestReachable`, which considers candidates nearest-first and takes the
  first one a player-sized box can actually sweep to.
- **Two of six bots never moved at all.** They spawned at `info_player_deathmatch` points whose
  neighbourhood in the graph was a three-node island. Q3 does not have this problem because AAS
  guarantees every spawn point is in a reachable area; this graph carries no such guarantee, so
  bot spawns are snapped to the nearest node in the graph's main body. It is a spawn-time
  correction rather than a runtime one on purpose -- a bot that *wanders* into an island is still
  stuck there, and that is the truth about the graph rather than something to hide.

### D-053: The tree is small, and its shape is the argument

    Selector
      Sequence [ Condition(enemy visible or recently seen) -> Fight  ]
      Sequence [ Condition(has a route)                    -> Travel ]
      Action   [ pick a goal and a route                            ]

A Q3 deathmatch bot does three things in strict priority and this says so in the order it is meant
to be read. The equivalent in `ai_dmq3.c` is spread across a dozen functions and an `ainode_t`
function pointer, and the priority is implicit in which node sets which other node.

The two long-running leaves are custom `Behavior` subclasses, because `ActionBehavior` is
single-shot and travelling takes many frames -- which is the whole reason a behaviour tree is a
tree rather than a switch statement.

Goal selection is the part of `BotChooseLTGItem` that survives without Q3's character files:
score every reachable item by what the bot lacks, minus a distance penalty. Q3's fuzzy weights come
out of per-character `.c` files this port does not have, and inventing them would be guesswork
dressed as fidelity.

### D-054: Armour, and the player as something that can be shot

Bots fired a hundred rounds each into the player and did nothing, because `weapons.targets` held
only the shootable boxes and the other bots. The player is now a `Damageable` whose `origin` is a
live reference to `ps.origin` and whose `health` and `armor` are accessors over the same inventory
the HUD reads -- one number, not two that can disagree.

That made `G_Damage`'s armour split worth porting: `save = ceil(damage * 0.66)`, capped by the
armour on hand, taken off health. The ceiling matters at low damage -- a 5-point hit takes 4 from
armour and 1 from health -- and it is why 100 armour is worth roughly 200 effective health, which
is in turn why a Q3 player runs a route instead of camping.

### D-055: What the bots do not do

- **No rocket jumping, and no jumping to reach anything.** The graph has no jump edges, so a bot
  goes where it can walk, drop, teleport or be launched. Jumping happens only as stuck recovery.
- **No aim prediction.** A bot fires at where the player *is*. Q3 leads its target based on skill.
- **No fuzzy weapon preference, no chat, no team play, no taunts.**
- **`SelectSpawnPoint` is a random pick**, where Q3 scores every point by distance from the
  nearest enemy so a respawn does not materialise in front of one.
- **Bots do not fight each other well.** They see the player specifically, not each other:
  `perceive` traces to one enemy. They *hit* each other with splash and stray fire, and the damage
  counts, but there is no bot-versus-bot target selection.

---

## Corrections found by running the whole thing

### D-056: OA ships MD3 surfaces with no geometry, and two of them broke two characters

`tony`'s `l_belt` and `u_vest` are 0 vertices and 0 triangles. `neko/upper.md3` is 278 frames and
**no surfaces at all** -- a placeholder whose only job is to carry `tag_head`. Q3's renderer skips
both without comment.

The converter did not, and the failure travelled a long way from its cause: zero-vertex surfaces
became zero-count glTF accessors, and rigging a skeleton over no vertices produced `NaN`
centroids that `JSON.stringify` writes as `null`. The loader then rejected the file with
`expected x to be a number, instead was 'object'(=null)`, naming neither the file nor the field.

Two characters of fifteen, found by loading all fifteen in the browser rather than by any test.
`drawableSurfaces` now filters them at the reader, `decomposeSkin` refuses to decompose nothing,
and the structural test asserts that every accessor has a non-zero count and every number in the
file is finite -- which is the assertion that would have caught it, and which the earlier version
did not make because it only checked that `min`/`max` were *present*.

### D-057: 28% of every character's joints owned no vertices

Chasing the above turned up a second, quieter one. k-means with farthest-point seeding does
produce empty clusters -- a seed lands on an outlier, the refinement pass moves its only vertices
elsewhere, and nothing comes back. An empty cluster became a joint at the world origin: it owned
no vertices, deformed nothing, and contributed two no-op animation channels to every clip.

Measured on `sarge`'s torso: **nine of thirty-two joints**. Across the roster, compacting them
away took joint counts from a uniform 64 to 30-64 and file sizes down about 20% -- `sarge` from
387 KB to 312 KB, `major` from 379 to 268 -- with **reconstruction error unchanged to three
decimal places**, which is the proof that they were contributing nothing.

It was not a correctness bug on its own; meep's loader prunes no-op channels on the way in, and
the pose is identical either way. It became one for `neko`, whose torso has no geometry at all: its
`TORSO_*` clips carried nothing but two channels placing a head at its own rest pose, those pruned
to zero, and a zero-channel clip trips an assertion inside `MeshSystem3` that names no model.

Three fixes, each of which would have been enough alone and all of which are right: empty clusters
are compacted away, tag nodes are authored with their frame-0 rest pose rather than identity (so
their channels are not no-ops, and the unposed model is correct in any viewer), and a `TORSO_*`
clip is not emitted for a character with no torso.

---

### D-058: The navmesh evaluation was wrong twice, and the corrected version changed the decision's reasoning but not the decision

D-051 recorded the waypoint graph as the replacement for AAS. GAP-016 recorded *why* meep's
`NavigationMesh` was not used, and the first two versions of that reasoning were both wrong. The
maintainer pointed at `bt_mesh_append` and `bt_merge_verts_by_distance` and observed that meep's
topology tooling is world-class, which it is.

**First error: I said the package had no way to repair arbitrary geometry into a manifold
surface.** It has an extensive one, in `core/geom/3d/topology` -- merge by distance, fuse duplicate
edges, resolve T-junctions, kill degenerate faces, split pinched vertices, close boundary holes,
compact, plus validation. I had hand-rolled a grid-snapping weld instead, which is strictly worse:
`bt_mesh_vertex_merge_distance`'s docblock even explains why the naive version fails, because
below the float32 step a tolerance degenerates into an exact-bits match. The tool I needed was
there, and its docblock described my exact problem and the order to call things in.

**Second error: running the real repair on brush solids changed nothing, and I nearly recorded
that as the tool failing.** `bt_mesh_resolve_t_junctions` reported zero splits. That is correct
behaviour -- it splits *boundary* edges, ones with a single face, and a soup of closed convex
brushes has none. The input was wrong, not the tool.

**What was actually missing** was upstream of any of it, and is obvious in hindsight: a navmesh
wants a *surface*, and a Q3 map is interpenetrating *volumes*. Extracting the walkable surface --
`MIN_WALK_NORMAL` for "is this a floor", `pointContents` for "is it buried", about forty lines and
both numbers Q3's own -- takes spawn-pair routability from 5% to 48%, and the repair then yields
`manifold: true` after 267 T-junction splits.

**The decision stands, on better evidence.** 48% against the trace-built graph's 100% on the same
metric, because welding cannot union overlapping coplanar patches and the extracted surface stays
about a hundred islands. Closing that needs a boolean union or Recast-style voxelisation, which
is genuinely not in the package.

Two process notes, since the failure was mine both times:

- **I compared on mismatched metrics.** The withdrawn version put the navmesh's *spawn-pair* 5%
  next to the waypoint graph's *item-pair* 85%, which flattered the graph. The probe now measures
  both on spawn pairs, and the graph's real number on that metric is 100% -- so the conclusion
  survived, but it survived by luck rather than by rigour.
- **"The engine cannot do X" deserves a higher bar than "I could not do X with the engine."** Two
  hours of trying is not the same as a gap, and the first version of GAP-016 asserted the former
  from the latter. The entry now leads with the correction, because a report whose errors are
  visible is worth more than one that is merely confident.

---

### D-059: Input runs on meep's devices, and the previous arrangement was a bug I had documented as a decision

The port originally read input from raw DOM listeners on `graphics.domElement`, and a comment in
`PlayerController` called that deliberate. It was not. It never worked at all: the canvas and the
whole view stack above it are `pointer-events: none`, so no mouse event reaches them, and the
element meep's own devices listen on -- `viewStack.el` -- is never focused, so no key event
reaches that either. The game rendered, simulated, updated its HUD, and ignored every input
(GAP-017).

It survived because every claim I made about movement was verified through headless harnesses
against the C oracle, and the browser build was only ever checked for *load* errors. The lesson is
the same one D-036 records about the physics colliders: a measurement taken through a test harness
says nothing about the path that ships.

Input is now `engine.devices.keyboard` and `engine.devices.pointer`, which is both the fix and the
better arrangement:

- **Held keys are switches, not bookkeeping.** `keyboard.keys.w.is_down` is polled once a frame,
  so there is no held-key set to get out of step and no key that can stick down because its keyup
  landed while the window was unfocused. The old code needed a `blur` handler for exactly that.
- **The pointer-lock delta arrives already extracted.** `pointer.on.move` sends
  `(position, event, delta)` and the third argument is `movementX`/`movementY`, so the look code
  never touches the raw event -- which is also what makes the device swappable for a gamepad or a
  recorded input stream.
- **The attack button is polled too**, for the same reason as the movement keys: an edge-tracked
  flag survives a lost pointer lock and the symptom is a weapon that keeps firing after you let go.

The only DOM listener left is `pointerlockchange`, because pointer lock is a browser capability
rather than an input one.

Two app-level corrections are required first, and they are CSS on an element the engine hands over
rather than changes to the engine: `pointer-events: auto` on the view stack, so it is a hit-test
target at all, and `focus()` on it, so keyboard events land there. Both are in `main.ts` with the
reasoning next to them.

---

### D-060: Quake III winds clockwise, and the whole port rendered inside-out

Reported: the floor does not draw. It did not, and neither did anything else facing the camera --
every triangle in every converted map, prop and character was wound backwards, so the renderer
culled all of them. Standing in a room you saw the *far* side of the next room through the near
walls (GAP-018).

Q3 winds its triangles **clockwise seen from the front**; glTF and meep wind counter-clockwise.
The converters preserved the source winding, on the reasoning that the axis map
`(x, y, z) -> (x, z, -y)` has determinant +1 and therefore preserves orientation. That reasoning
is correct and beside the point: preserving the winding is exactly the wrong thing when the source
convention is already the opposite of the target's.

Measured rather than recalled, by comparing each triangle's winding-derived normal against the
vertex normals the format itself ships:

| source | agree | disagree |
|---|---|---|
| `aggressor` world surfaces | 0 | 3,272 |
| `oa_dm1` world surfaces | 158 | 7,348 |
| `oa_dm5` patch tessellation | 6 | 88,378 |
| `rocketl.md3` | 0 | 204 |

Uniform across BSP surfaces, patch tessellation and MD3, so all three converters reverse and the
fix is one line in each. `brushHull.ts` already did -- with a comment explaining that Q3's
`BaseWindingForPlane` is clockwise from outside. I found the convention once, wrote it down,
applied it to the collision hulls, and never asked whether the render path had the same problem.

**Two earlier claims in the report are wrong because of it**, and both are corrected in place
rather than quietly edited:

- GAP-006 said "the floors look untextured" and blamed missing lightmaps, calling it the single
  most visible quality gap. The floors were not untextured; they were not being drawn. I had a
  plausible story for a symptom and stopped looking, which is the more expensive mistake.
- The ergonomics section praised `ShadeMaterial.draw_side` for documenting itself as
  non-functional. The docblock is stale -- `Front` and `Double` both work -- and believing it cost
  the port double-sided surfaces for its entire life. `cull none` materials now set
  `ShadeDrawSide.Double`: five of `oa_dm1`'s materials, eight of `oa_dm5`'s.

`test/winding.test.ts` now asserts the invariant across every map, the prop bundle and three
characters, and it needs no oracle: every one of these formats ships vertex normals, so the cross
product of a triangle's edges must agree with the normals at its corners. Four lines of
arithmetic, and the first thing I would write in any geometry converter from now on.

The character check tests the *converter's* invariant rather than an absolute threshold, because
`skelebot`'s own MD3 has mixed winding -- 57% clockwise on the legs, 74% on the head. Q3 renders
it with the same artefacts. Asserting "reversed relative to the source" holds for well-authored
content and badly-authored content alike.

---

### D-061: The invisible obstacle, and three ways the harness was not measuring the game

Reported: a spot where the player could not move left or right and could only creep forwards and
back along an invisible line. That is exactly what `PM_SlideMove` does when handed two
contradictory contact planes -- clip against the first, achieve nothing, retry, accumulate the
second, project onto the line where they meet. Three planes and it stops dead.

Three separate defects, each of which alone was enough.

**1. The contact-plane rule was never actually consulted in the browser.** `PhysicsWorld`
declared `hullByEntity` and `hullByBody`, read them in the plane selection, and **never wrote
them**. Every lookup missed, so every contact normal fell back to `shape_cast`'s
minimum-penetration axis -- precisely the wrong answer GAP-012 is about, and which for a player
standing on a floor is frequently *the floor*. A horizontal move clipped against a horizontal
plane does nothing, so pmove retried and wedged. The headless harness *did* populate those maps,
which is why every measurement in this document looked healthy while the browser build had no Q3
contact semantics at all.

**2. The rule itself was only half implemented.** `planeFromHull` took the plane with the greatest
entry fraction over a brush's planes, which is the first half of `CM_TraceThroughBrush`. The
second half -- the leave fraction, and the `enterFrac < leaveFrac` test that decides whether the
brush blocks *at all* -- was missing. Without it, every brush the box merely passes near
contributes a candidate.

The fix for both is to stop re-deriving it. `trace.ts` now exports `traceBrushList`, which runs
the ported, oracle-verified `CM_TraceThroughBrush` over an explicit brush list, and the physics
backend calls it. The answer is identical to the clipmap's by construction rather than by careful
re-reading -- which is what D-030 claimed and did not deliver.

**3. The harness was measuring different geometry.** `HeadlessPhysics` built hulls from *every*
brush including brush entities, at their authored positions; `PhysicsWorld` builds model 0 and
gives movers kinematic bodies. So the harness had doors and buttons welded into the world.

**All three are the same failure**, and it is the one D-036 already named: the harness carried its
own copy of the trace so that a coordinate bug could not cancel itself out of the measurement.
That reasoning was thin -- the real independence is the bit-exact clipmap control, which is a
genuinely separate path -- and the duplication has now hidden three bugs. The query half is
extracted into `PhysicsTrace` and shared. Body *construction* still differs, because one goes
through the ECS and the other cannot; the query does not.

**Measured, `oa_dm1`, before and after:**

| | before | after |
|---|---|---|
| contact normals agreeing with Q3 | 99.6% | **100.0%** |
| bunny-hop, max divergence | 1.3 | **0.2** |
| bunny-hop, within 1 unit | 98% | **100%** |
| bunny-hop, first divergence > 1 unit | frame 134 | **never** |
| strafe-jump p90 | 271.0 | **121.3** |
| chaos p90 | 1.28 | **0.18** |
| hit/miss agreement | 88.2% | 88.7% |

Those are the harness's numbers, and they moved only a little, because the harness was already
running the good path. The browser build is the one that changed.

**The regression guard is geometric rather than dynamic.** `test/physics-wedge.test.ts` asks the
question the symptom actually poses: at every standing position the floor sampler can find, can
the player leave? A spot the clipmap says is open in eight directions and the physics says is shut
in eight is a wedge. `oa_dm1` had one before the fix and has none after; `aggressor` has none.

The divergence harness could not have caught this. It measures *displacement under scripted
input*, and a wedge is a place you have to already be standing in. Two harnesses measuring
different things, and the gap between them was the bug.

---

### D-062: A player model's origin is the player's origin, and the assets say so

Reported: enemies appear half-buried in the ground.

`Character.place` subtracted 24 from the height before placing the model, on the stated belief that
"a player model's origin is at its feet in Q3 and `ps.origin` is 24 units above them". The first
half of that is false. A Q3 player MD3 is authored with its local origin *at* `ps.origin` -- the
same point the collision box measures its `-24` and `+32` from -- so subtracting the 24 sinks the
model by exactly the distance from the origin to the feet, and the feet end up 24 units under the
floor. On a 56-unit model that is the waist.

`CG_Player` never adjusts it either: `VectorCopy( cent->lerpOrigin, legs.origin )`. The same fact
appears from the other side in `CG_PlayerShadow`, which finds the ground by tracing down from
`origin[2] - 24`.

The assets are unambiguous, which is what makes this worth writing down rather than just fixing.
Standing each character in `LEGS_IDLE` and reading `lower.md3`'s frame bounds:

| | `mins[2]` |
|---|---|
| `skelebot` | -25.1 |
| `major` | -25.1 |
| `tony` | -24.9 |
| `beret` | -24.9 |
| `sarge` | -24.8 |
| `neko` | -24.8 |
| `kyonshi` | -24.7 |
| `penguin` | -24.7 |
| `sergei` | -24.5 |
| `assassin` | -24.3 |
| `merman` | -24.2 |
| `gargoyle` | -23.6 |
| `sorceress` | -22.8 |
| `smarine` | -22.6 |
| `liz` | -19.0 (she hovers) |

Mean -23.9 over sixteen models including `angelyss`, which the port does not ship. `tag_head` says
it a second way: 20 to 29 units above the origin, where a feet-origin model would put it at 44 to
53.

**The guard is in `characters.test.ts` and measures the converted glTF, not the MD3.** It stands
each character in `LEGS_IDLE`, skins frame 0 by hand, and asserts the lowest vertex is below -16
and above -30. That band is the measured spread widened a little; the assertion that matters is
that it is nowhere near zero, so re-origining the converter to put feet on the ground would fail
loudly rather than silently moving every character.

Writing it caught a second thing. The first version read `primitives[0]`, which is the whole model
for thirteen characters and is a piece of `neko`'s head-dress for `neko`, whose legs are five
surfaces -- so it reported her lowest vertex at +0.6 and failed. The existing end-to-end test has
the same narrowness and gets away with it because it only runs on `sarge`. A test that reads one
surface of a multi-surface format is measuring whichever model the author happened to open.

---

### D-063: "Is the sweep blocked" is not a question `shape_cast` can answer, and pmove asks it constantly

Two reports, one defect. A player stuck in an open corridor -- running at 320 units a second
against a position that never changed. And a bot apparently standing in mid-air against a wall,
which is not what it was doing: it had stopped falling.

Both are the physics backend answering "blocked, at zero distance, with no plane" to sweeps the
clipmap says are free. `PM_SlideMove` clips velocity against the reported plane, achieves nothing,
retries, gets the same answer, and gives up; `PM_StepSlideMove`'s probe straight up comes back
blocked too, so there is no step to rescue it; and `PM_GroundTrace`, reading `normal[2] = 0`,
decides the player is on a slope too steep to stand on and stops applying ground friction to a
player who is not moving anyway.

**There were three separate causes**, found in that order.

**1. `allsolid` was hardcoded to false.** `CM_TraceThroughBrush` reports three states: outside,
`startsolid` (began inside a brush the sweep leaves), and `allsolid` (began inside and never gets
out). pmove treats the third as a call for help -- `PM_GroundTrace` hands it to
`PM_CorrectAllSolid`, which jitters the player a unit at a time until it finds free space. The
backend never reported it, so the recovery Q3 provides for exactly this situation could not run.

**2. The position test conflated touching with being buried.** A zero-length trace answers "am I
stuck here", and the old implementation swept a hair with `shape_cast` and called any contact
solid. Inside `PM_CorrectAllSolid` that is fatal: every position a standing player jitters to
still touches the floor, so every candidate reads as solid and the search reports that there is no
way out. `CM_TestBoxInBrush` is the function that draws the line, and over a zero-length sweep
`CM_TraceThroughBrush` reduces to it exactly -- `d1 === d2` for every plane -- so it is now run
rather than approximated.

**3. And the one that actually mattered: Q3's brush test is not "does the swept box touch this
brush".** This is the interesting half and it is written up as GAP-019.

Measured at the reported position, `oa_dm1` (704.91, 686.92, 24.93), moving one frame at
(2.56, 0.58, 0):

| brush 414, plane | `d1` | `d2` | |
|---|---|---|---|
| `(-0.71, 0.71, 0)` | 0.007 | -1.393 | entering: `f = (0.007 - 0.125) / 1.400 = -0.084`, clamped to 0 |
| `(0, 1, 0)` | -0.080 | 0.500 | leaving: `f = (-0.080 + 0.125) / -0.580 = -0.078` |

`enterFrac < leaveFrac` is `0 < -0.078`, which is false, so **the brush does not block** -- even
though the box is seven thousandths of a unit from one of its faces and moving into it. The
`SURFACE_CLIP_EPSILON` term drags both fractions negative and the interval comes out empty. That
is a signed-distance interval test over the brush's half-spaces. `shape_cast` answers a different
predicate -- does the swept volume intersect this convex body -- and at sub-epsilon distances the
two disagree systematically, because *every* surface a player rests against is sub-epsilon away.

**The fix keeps meep doing the sweep.** `traceBrushList` already runs the ported, oracle-verified
brush test over the brushes `overlap_shape` finds, so when `shape_cast` reports a contact at zero
distance on a body whose brush that trace has already cleared, the two are not disagreeing about
the world -- they are answering different questions, and Q3's is the one `bg_pmove` was written
against. `PhysicsTrace.alreadyRuledOn` is that check.

The alternative was to hand the whole sweep to `traceBrushList` over a swept-volume gather, which
would make static collision exactly the clipmap's and reduce meep to a broadphase. That is a real
option and it would measure better, but it reverses D-029 and the direction to use meep's physics
for movement, so it is not taken unilaterally. It is noted in GAP-019 as what the gap costs.

**Measured, `oa_dm1`, before and after:**

| | before | after |
|---|---|---|
| trace hit/miss agreement | 88.7% | **99.9%** |
| sweeps where physics passes and the clipmap blocks | -- | **0** |
| contact normals agreeing with Q3 | 100.0% | 100.0% |
| strafe-jump p90 | 121.3 | **34.0** |
| walk-into-walls p90 | 1.77 | **0.22** |
| chaos p90 | 0.18 | 0.18 |

`aggressor` lands at 99.8% hit/miss and 99.8% normals.

**The regression guard is the dynamic question, and the static one could not have caught this.**
`test/physics-wedge.test.ts` already asked, at every standing position, whether a 32-unit sweep can
leave in eight directions. It passed clean on the broken build, because one sweep is not what
pmove does -- pmove accelerates, clips, retries, steps and pushes down, and the ways it can fail to
make progress are invisible in a single trace. The new half runs pmove for 120 frames from each
sampled position at each of eight headings and compares distance travelled against the clipmap.
On the broken build: 23 of 656 walks stall on `oa_dm1`. After: none, on either map.

Two details of that test worth keeping. It starts from two heights -- flush on the floor, which is
what the sampler produces and what `PM_CorrectAllSolid` is for, and four units up, an ordinary
standing position; the first two causes above only show up flush, and the third only shows up
standing, so a single start height would have found half the bug and declared victory. And it
re-checks a suspected stall by putting the *control* where the physics run stopped: the two runs
diverge by fractions of a unit at a landing and can then take different turns at a junction, so
"physics got less far" is not on its own a defect -- one of them may have walked into a corner the
map really has. Without that check the test reports two false positives on `oa_dm1`, both of them
a genuine 45-degree dead end that stops the clipmap just as dead.

`tools/trace-compare.ts` is the instrument the fix was found with, kept because the next report of
this kind will start the same way: a screenshot, a coordinate, and no idea which of a hundred
traces per frame is the wrong one.

---

### D-064: The falling player who never lands, and why three reports were all this

Reported: characters hovering above the ground. Before that, characters half-buried. Before that, a
bot standing in mid-air. Two of those I answered by moving the model, which was wrong twice --
once in each direction -- and the third by fixing something real that was not this.

The actual defect is one line of geometry, and it had been in the physics backend since the swap.

**Q3 stops a box before it touches.** `CM_TraceThroughBrush` offsets every plane outward by
`SURFACE_CLIP_EPSILON`: `f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2)`. A trace stops an eighth of a
unit short of the surface and a resting player floats in that gap. The backend reproduced this by
subtracting the epsilon from the answer -- sweep the exact box, then pull the contact back by
`e / length`.

Those are the same thing only when the sweep reaches the surface. **A move that ends a twentieth of
a unit above the floor does not reach it**, so `shape_cast` correctly reported no hit, and Q3 blocks
that move because its offset plane is already crossed.

Measured, `oa_dm1`, a player dropped four units and left alone. Frame 12, the move `(0, 0, -0.602)`:

| | fraction | ends at |
|---|---|---|
| clipmap | 0.8724 | -119.875, velocity zeroed, `groundEntityNum = 0` |
| physics | 1.0000 | -119.952, velocity **-78**, `groundEntityNum = ENTITYNUM_NONE` |

The next frame it bounced back up at +78 and it never stopped. Across 60 sampled standing positions
on `oa_dm1`, **63 of 64 dropped players never landed**; on `aggressor`, 61 of 62.

**Nobody ever saw a bouncing player**, because the bounce is under a tenth of a unit and the camera
sits at eye height. What everybody saw was the consequence: `groundEntityNum` stuck at
`ENTITYNUM_NONE` is what `Character.legsFor` reads to choose `LEGS_JUMP`, so every bot in the level
stood with its legs tucked up. Hovering. And with the model dropped 24 units by the placement bug
that D-062 fixed, the same tucked-up pose read as half-buried instead.

**The fix is to put the epsilon where Q3 puts it.** For a box against a plane, offsetting the plane
outward by `e` is the same as growing the box by `e`, so the swept shape carries it and the
fraction is `hit.t / length` with nothing subtracted.

| `oa_dm1` | before | after |
|---|---|---|
| trace hit/miss agreement | 99.9% | **100.0%** |
| sweeps the clipmap blocks and physics does not | 12 | **0** |
| fraction abs error, median / p90 | 0 / 1.3e-3 | 0 / **5.3e-8** |
| chaos p90 / max / within 1u | 0.18 / 188 / 91% | **0.00** / **0.1** / **100%** |
| walk-into-walls p90 | 0.22 | **0.11** |
| dropped players that never land | 63 of 64 | **0** |

`aggressor` likewise reaches 100.0% hit/miss, and strafe-jump p90 falls from 79.1 to 9.2. The
fraction error dropping to 1e-8 is the headline: the sweep now returns Q3's number rather than an
approximation of it.

**What got worse, stated plainly.** Contact normals on `oa_dm1` went from 100.0% to 99.5%, with five
sweeps where the physics blocks and the clipmap does not. And the static wedge scan started failing
at the sampler's own positions. That second one is worth the detail:

| start height | sweeps agreeing, `oa_dm1` | `aggressor` |
|---|---|---|
| flush (floor + 24) | 93.1% | 86.0% |
| resting (floor + 24 + 1/8) | **100.00%** of 6128 | **100.00%** of 4896 |

The flush position is the one the floor sampler reports and the one no player occupies: the box is
interpenetrating the floor plane by exactly the epsilon, which pmove corrects on the first frame.
Growing the swept box makes that degenerate state worse and every reachable state exact. So the
static scan now samples at the resting height and says why, and the flush case stays covered by the
`walking` block, which starts from it deliberately and relies on `PM_CorrectAllSolid` to recover.

**On how this was found, because the method is the point.**

Three reports in a row were answered by moving a model and asking the user whether it looked right.
That is not a method. The user said so, and was right.

What replaced it: the browser was unavailable -- the preview pane does not composite, so
`MeshSystem3` never loads a model and `AnimationSystem3` never poses one, and no amount of driving
the page from the console gets a number out of it. So every question had to be turned into one Node
could answer. Drop a player, wait sixty frames, ask `groundEntityNum`. That is four lines, it
reproduces on both maps, and it fails 63 times out of 64.

Two tests came out of it and both are in `physics-wedge.test.ts`:

- **`lands, and knows it has landed`** -- the clipmap decides which sampled positions are fair to
  judge, since some are over pits where falling is correct.
- **`rests where Q3 rests`** -- because "grounded" and "grounded in the right place" are different
  claims, and the model's feet are drawn from the origin, so a resting height off by a unit is a
  character floating by a unit.

And the placement claim finally got a test. `Character.place` was the wrong shape to check: it
builds an ECS entity and fetches a glTF. The arithmetic is now `sceneFromQ3`, exported and pure, so
`characters.test` can compose it with the asset's own measured foot offset and assert the feet land
on the floor for all fifteen characters. Reverting D-062's fix makes it fail with "expected -24.19
to be greater than -2", which is the half-burying, in a test, in a second.

Neither half of that claim is checkable alone. The asset test says the feet hang 24 units below the
model's origin. The placement code says the origin goes at `ps.origin`. Both were separately true
and correct while the characters were visibly wrong, because nothing multiplied them together.

---

### D-065: Every sound is an `AudioEmitter`, and the one-shot exception was not worth its second code path

D-046 argued that a one-shot should skip the component layer and call `sopra.playOneShot` directly,
because an `AudioEmitter` per machinegun round means an entity built and destroyed ten times a
second. The premise was right and the conclusion was wrong.

What the premise misses is where a one-shot emitter actually goes. `AudioEmitterSystem` picks its
routing once, at link: a looping 3D emitter is registered with the `LiveEmitterSet` and left
dormant until it is among the nearest in range, and *everything else* -- 2D sounds, and finite 3D
one-shots -- takes the direct path, which is `sopra.playEvent` with the same description, the same
position vector and `oneShot: true`. So the component route does not add a spatial-management tier
to a gunshot. It adds an entity, a `Transform` and one observer dispatch, and then arrives at the
call the direct route was making anyway. Measured in the running app, 20 machinegun one-shots fired
in one frame produce 20 emitter entities and leave the dataset at exactly the count it started at
once they finish.

What the exception cost was the interesting part. Two routes meant two answers to every question
that came up afterwards. Where does the bus id go. What stops this. Which of these is affected by
`distanceMax`. And -- the one that mattered -- when a loop is finally needed, does it go through the
component route, in which case the file now has both, or does it get a third thing. The port had
already answered that badly once, by claiming four looping-sound syscalls were mapped to a
component nothing built (D-066).

The one thing the component route genuinely needs and the direct route did not is a way to know
when a sound has ended, because `AudioEmitterSystem.unlink` stops a direct instance -- an entity
retired on a timer that ran short would cut off its own sound. `instanceFor(entity).onEnded` is
exact, and it also covers a case a duration could not: a sample whose asset fails to load ends
immediately rather than after its nominal length. The removal is deferred one frame into
`AudioBank.update` rather than done in the handler, because `onEnded` fires from inside
`AudioEmitterSystem.update` and removing an entity there mutates the dataset while the system that
owns it is mid-frame. `Effects` retires its particle entities the same way and for the same reason.

**What is now one path rather than two:**

| Q3 call | emitter |
|---|---|
| `S_StartSound` | finite, `is3D` |
| `S_StartLocalSound` | finite, not `is3D` |
| `S_AddLoopingSound` / `S_AddRealLoopingSound` | looping, `is3D` |
| `S_StartBackgroundTrack` | looping, not `is3D`, music bus |

The two axes Q3 varies -- positioned or not, finite or looping -- are exactly the two the system
routes on. That is not a coincidence to be clever about; it is the reason one component expresses
all four.

### D-066: The trap matrix said four sound calls were mapped, and three of them were not

`trap_S_AddLoopingSound`, `trap_S_AddRealLoopingSound`, `trap_S_StopLoopingSound` and
`trap_S_UpdateEntityPosition` were all marked `mapped`, against "looping sound emitter" and
"Transform on emitter entity". `trap_S_StartBackgroundTrack` was marked `mapped` against "music bus
/ streaming source". None of those existed. `AudioBank` had `play` and `playLocal` and no way to
start a loop, stop a sound, or play music at all, and nothing in the port ever constructed an
`AudioEmitter`.

This is a worse failure than a gap, because a gap is visible and this was not: the matrix is
generated from a classification file, so an entry that describes an intended design reads exactly
like an entry that describes a built one. The rule the file now follows is that a `mapped` note
names the call site, and a call site can be checked.

**What was built to make them true**, each against the Q3 code that makes the call:

- **`CG_EntityEffects`, the `ET_SPEAKER` branch.** `SP_target_speaker` sets `s.loopSound` when the
  `looped-on` spawnflag is present, and the client plays it through `AddRealLoopingSound` -- the
  "real" variant meaning it is not merged with other copies of itself. `MapSound` starts one
  emitter per such speaker, named by the entity's own `noise` key. 22 on `oa_dm5`, 10 on `oa_dm4`,
  3 on `aggressor`. A speaker with neither looped flag is a triggered one-shot waiting on a
  `target` this port does not fire, and is skipped and counted rather than started, because
  starting it would invent a sound the map does not make.
- **`CG_Missile`'s `weapon->missileSound`.** A rocket, a plasma bolt and a BFG shot carry a fly
  loop; a grenade deliberately does not. This is the one that needs all three of the remaining
  calls -- the loop starts with the projectile, `SoundLoop.move` writes the `Transform` the emitter
  was registered with (which the spatial index tracks reactively, so the BVH leaf refits only when
  the rocket actually moves), and it stops when the projectile is gone.
- **`CG_Item`, `IT_WEAPON`.** A weapon lying in the map hovers audibly. Stopped on pickup and
  started again on respawn rather than muted, because a stopped loop is one fewer emitter in the
  live set and a muted one is not.
- **`CG_AddPlayerWeapon`, under `if ( !ps )`.** `firingSound` while `EF_FIRING`, `readySound`
  otherwise -- and only in the third person, so these are deliberately sounds the player never
  hears from their own gun. Bots get them; `fireCooldown > 0` stands in for `EF_FIRING`, which is
  the same question the torso animation already answers with it. Most weapons have neither sound,
  which is why the lookup is guarded by `AudioBank.has` rather than by a pair of branches: asking
  for a `readySound` a machinegun does not have must not be reported as a missing file.
- **`SP_worldspawn`'s `music` key**, via `CS_MUSIC` and `CG_StartMusic`, which parses an intro
  token and a loop token. No map this port ships names a second.

**What `S_AddLoopSounds` did that the `LiveEmitterSet` does instead.** Q3 rebuilds the loop set
every frame and merges identical loops within a radius, keeping the loudest, which is exactly the
`oa_dm5` case: nineteen of its 22 speakers are the same `firesoft` sample. Retained emitters cannot
merge, so the equivalent here is the budget -- registered emitters stay dormant and only the
nearest `LOOP_BUDGET` in range are promoted to voices. That composes with, and can be gated by, the
event's own polyphony cap, which is the trap the `LiveEmitterSet` docblock warns about:
content-equal events share one sopra bucket, so a loop capped below the budget would make promotion
churn instead of settle. Loops are therefore capped above it.

**Measured in the running app**, by driving `entityManager.simulate` on a timer and tapping the
master bus with an `AnalyserNode` -- D-047's instrument, for the same reason: Web Audio needs a
browser and a running context, so this is not a check a headless test can make.

| `oa_dm5` unless noted | |
|---|---|
| speakers registered | 22 |
| looping emitters registered in total | 27 |
| live at the spawn point | 23 |
| live standing next to one firesoft speaker | 12 |
| attenuation, 1 m from a speaker | 1.000 |
| attenuation, across the map | 0.006 |
| master bus RMS, ambience only | 0.107 |
| master bus RMS, `aggressor` music only | 0.542 |
| entities after 20 machinegun one-shots finish | unchanged |

The live count falling from 23 to 12 when the listener moves is the budget doing `S_AddLoopSounds`'
job, and the 1.000 is `SOUND_FULLVOLUME`: inside `distanceMin` a Q3 sound does not attenuate at all.
The rocket fly loop was traced separately -- it appears with the projectile, its `Transform` tracks
the flight, and it is gone on the frame the rocket detonates.

**What still is not built**, and is now recorded as such rather than as mapped: the flight
powerup's loop (`CG_PlayerPowerups`), which needs powerup state the port does not carry, and the
gauntlet's `firingSound`, which needs the gauntlet's own firing flag rather than a fire-rate
cooldown.

---

## Phase 6 — report finalisation

### D-067: The trap matrix was re-derived from scratch, and every number in it moved

D-066 found that four sound syscalls were marked `mapped` against a component the port had never
constructed, and adopted a rule: a `mapped` note names a call site, because a call site can be
checked. Phase 6 applied that rule to all 142 explicit entries rather than to the five that had
already been caught, and the rule is now enforced by `tools/trap-matrix.mjs --check` rather than
by remembering it.

**The mechanism.** Every entry whose disposition asserts something was built carries
`evidence: ["path::token", ...]`. The generator resolves each path and checks that the token
appears in the file; a `ported`, `hybrid` or `workaround` entry with no evidence fails the check,
and a `mapped` entry must carry either evidence or an explicit `unused` reason. `npm run check`
runs it, so the matrix cannot describe an intention again without someone deleting the rule.

**What moved, and why each one was wrong.**

| was | now | why |
|---|---|---|
| `mapped 77` | `mapped, exercised 31` + `mapped, not exercised 18` | The single number conflated "meep does this and we use it" with "meep does this and we never needed it". 18 facilities are real, would do the job, and were idle: no menus so no fonts, no 2D HUD art so no image drawing, four settings so no cvar system, no console so no clipboard, no on-screen debugging so no `DebugDrawSystem3`. |
| `trap_Trace`, `trap_CM_BoxTrace` — `ported` | `hybrid` | Written before the physics swap and never revisited. The shipping backend is meep's broadphase and sweep with Q3's per-brush rule behind it, and *both halves are load-bearing*: `shape_cast` cannot express the blocking predicate (GAP-019) or the standoff (GAP-020). Calling it `ported` credited meep with nothing; calling it `mapped` would have credited it with the whole thing. |
| `trap_CM_TransformedBoxTrace`, `trap_SetBrushModel` — `ported` | `hybrid` | Same reason, plus the genuine win: on the physics backend a mover is a kinematic body the world trace already finds, so `SV_ClipMoveToEntities` collapses into the same query. |
| `trap_R_LightForPoint` — `GAP` | `mapped` | The matrix's only `GAP`, and it pointed at a gap-register entry that does not exist. It is not a gap: Q3 needs a lightgrid because its models sit outside the lighting solution, and meep's do not. The real gap it was standing in for is GAP-006, which belongs to `trap_R_LoadWorldMap`. |
| `trap_R_RegisterSkin`, `trap_R_RegisterShader` — `mapped` | `workaround` | Both are resolved offline into baked glTF materials. Runtime skin switching is a capability this port does not have, and `mapped` hid that. |
| `trap_TraceCapsule` and four siblings — `ported` | `not needed` | Nothing was ported. OA traces the player as a box, so the capsule branches are dead code (D-018), and claiming them as ported work was simply false. |
| nine `trap_Cvar_*` — `mapped` against `engine/options` | `workaround` against URL query parameters | The port never imported `engine/options`. Its four knobs are `?map=`, `?trace=`, `?fly=` and `?targets=`. |
| `trap_EntitiesInBox`, `trap_EntityContact` — `mapped` against the BVH | `workaround` | The port keeps its own arrays and tests AABBs directly. At 31 items and 6 brush entities a broadphase costs more than it saves. Worth recording as a facility correctly *not* used. |
| nine console syscalls, three configstring, three userinfo — `mapped` | `not needed` | No console shipped, and configstrings and userinfo exist only to cross a client/server boundary this port does not have. |

**What this does to the headline.** `227 not needed / 31 exercised / 18 available / 4 hybrid /
7 ported / 22 workaround / 0 gap`. The engine comes out of this looking *narrower and more
honest* rather than worse: 31 facilities carried a Quake III port, which is the interesting
number, and the 18 idle ones are evidence of breadth rather than of failure.

**The uncomfortable part**, recorded because the brief asks for it: the previous matrix was
written early, described a plan, and was then maintained by editing notes rather than by
re-deriving. It survived five phases and a `--check` that only verified *completeness* — every
syscall classified — while never verifying *truth*. A check that cannot fail on the thing that
actually goes wrong is worse than no check, because it is quoted as evidence.

### D-068: `am_thornish` has no `info_player_deathmatch`, and the largest map in the build had no bots

Found by `test/presentation.test.ts` asserting that every shipped map has at least four spawn
points, not by playing it.

`main.ts` selected spawn points by filtering entities for `classname === 'info_player_deathmatch'`,
in three separate places. `am_thornish` is a Team Arena map: its entry points are 24 CTF team
spawns and 16 `info_player_start`, and it has zero `info_player_deathmatch`. The filter therefore
produced an empty list, which meant no bots at all on that map, and a death respawning the player
at `[0, 0, 0]` because the respawn line reads `botSpawns[random] ?? [0, 0, 0]` and did exactly
what it says.

Q3 itself would refuse the map — `SelectRandomDeathmatchSpawnPoint` calls `G_Error` when it finds
none — because a Q3 server knows its gametype and will not host a map that cannot support it.
That is the right behaviour for a server and the wrong behaviour for a demo with six maps and one
gametype, so `spawnPoints` (`src/game/Spawns.ts`) walks a preference chain instead:
`info_player_deathmatch`, then the CTF team spawns, then the CTF player markers, then
`info_player_start`.

It returns the **first non-empty tier rather than the union**, deliberately. Mixing combat spawns
with `info_player_start` on a map that has both would put bots in a lobby position the map never
expects to be fought over. The tiers are ordered so the combat spawns win.

Three tests pin it, including one asserting that `am_thornish` still has no deathmatch spawn and
resolves to exactly 24 CTF ones — so if the asset pipeline ever starts synthesising them, the
change is visible rather than silent.

### D-069: The phase 4 and 5 exit criteria are now tests, and one of them does not fully pass

The brief's exit criteria for phases 4 and 5 are "it looks like a showcase, not a test harness"
and "a real match is playable". Both had been signed off by looking at the running application.
This project's record with that method is: two wrong fixes shipped from screenshots in one
session, a measurement harness that reported healthy numbers for code the browser was not running
(D-036), and the same failure again a session later (D-061). The preview browser in the previous
session did not composite frames at all, so `MeshSystem3` never loaded a model and no live
measurement was possible from it.

So both criteria were rewritten as headless Node checks. Neither can judge whether something looks
good; both can refuse every failure mode that judgement would catch, and each of those is a
number.

**`test/presentation.test.ts` (36 tests)** — every texture a material names is on disk, every
material carries real PBR inputs rather than one default, every mesh has geometry and a material,
every spawned pickup resolves to a model, every fx texture named in `Effects.ts` exists, every
sound the shipping code plays is in the bank, and every place a player stands receives light.

The last one is computed rather than asserted from a screenshot: illuminance in lux at every
spawn point and pickup, using the same photometric arithmetic `loadMap` hands the engine —
`cd = lm / 4π`, inverse-square in scene metres, cut off at each light's `distance`. Reproducing
that arithmetic in the test rather than calling the engine's copy is deliberate; the engine's
needs a graphics device.

**The result is that the criterion does not hold uniformly**, which is the finding:

| map | point lights | median lux | player positions under 1 lux |
|---|---:|---:|---:|
| `am_thornish` | 147 | 58.0 | 0 / 95 |
| `oa_dm4` | 22 | 31.4 | 0 / 47 |
| `aggressor` | 63 | 22.5 | 0 / 38 |
| `oa_dm1` | 22 | 8.8 | 0 / 38 |
| `oa_dm7` | 13 | 0.0 | 70 / 79 |
| `oa_dm5` | **0** | 0.0 | 36 / 36 |

The test asserts the criterion on the default map and the two showcase maps, and *pins* the two
failures rather than loosening the threshold to cover them. Loosening would have made the suite
pass and the report wrong.

**Why it fails there.** The lighting reconstruction reads `q3map_surfacelight` off the shader set
and `q3map_sun` off worldspawn, because those are the only lighting inputs that survive
compilation: q3map2 deletes every `light` entity from a compiled BSP, which the test also asserts,
across all six maps. `oa_dm5` is 107,414 triangles of level lit entirely by `light` entities and a
lightmap, so there is nothing left to read.

**The route not taken, and why.** The BSP's lightgrid (lump 15) is the other baked product of
q3map2 and it *does* survive: an ambient plus a directional sample per grid cell, covering the
whole playable volume. Emitting point lights from bright cells would give `oa_dm5` a lighting
solution with no rendering code, no engine change and no lightmap slot — pure asset-pipeline work,
roughly half a day. It is not done. The brief's phase 6 is report finalisation, the shortfall is
now measured, pinned and attributed in GAP-006, and inventing a feature during the reporting phase
would be the wrong trade against leaving the report incomplete. Recorded here so the next person
finds the idea rather than the absence.

**`test/match.test.ts` (16 tests)** — six bots and one standing player for 30 simulated seconds at
125 Hz on the shipping physics backend, with no renderer and no engine boot. Bots leave their
spawns, cross the level, take pickups, find the player and open fire; the dead come back; no state
goes non-finite. The same match runs on the clipmap backend as a guard against a collision change
that traps every bot where it stands — the failure that actually happened twice — comparing total
distance walked and share of the navigation graph reached.

Nothing in the shipping code had to change to make this possible, which is itself a finding and is
in section 7: `WeaponSystem`, `ItemSystem` and `MoverSystem` never knew about the ECS,
`BotRuntime.spawn` already took a null `Character`, and `PhysicsSystem` drives headless.

**The player in that match is a dummy, and it has to be.** The first version ran bots only and
measured zero shots fired, which looked like a bug and is not: bots in this port fight the player
and not each other, because Q3's target selection scores every client and this one does not
(D-055). A stationary player is the smallest arrangement in which the tree's fight branch ever
runs. The cut is now asserted directly in its own test — with no player, nobody fires — so the
report's claim and the code cannot drift apart, and implementing bot-versus-bot selection will
fail that test and force the report to be updated.

### D-070: The two loudest findings in the report were overreach, and the engine's own solver is why

Raised by the maintainer, in these terms: *"You decided not to use the physics engine for
collisions, and not to use kinematic controller, and now you bitch that the shapecast query is not
as amazing as you had hoped."*

One third of that is wrong and two thirds land. Taking them in order.

**"You decided not to use the physics engine for collisions."** This one is backwards, and the
record is clear: the port *does* use meep's physics for collision, and it does so on the
maintainer's own instruction, against an initial recommendation not to (D-029). That is the whole
reason `PhysicsTrace` exists.

**"...and not to use the kinematic controller."** True, and the consequence is worse than the
observation. `engine/control/first-person/collision/KinematicMover.js` is 635 lines of kinematic
character solver. Its constructor takes `skin = 0.005` — the standoff GAP-020 asserted had "no
expression in the API". Its first step is depenetration via `overlap()` plus
`compute_penetration`, which is public, exhaustively documented, and is exactly the start-solid
recovery GAP-019 asserted a `shape_cast`-based backend "silently removes". Beside it,
`DESIGN_COLLISION.md` is 365 lines that set out recover → slide → stairs → ground → settle, with a
constants table citing Quake `numbumps 4`, Quake 3 `MIN_WALK_NORMAL 0.7`, Quake `SV_FlyMove`
crease handling and Fauerby's `veryCloseDistance ~0.005` for the skin. It names the exact symptom
this port reported -- "Band-test + active snap ... is what structurally kills the landing
**bounce**" -- as a solved problem.

I never opened any of it. GAP-009, at phase 2, evaluated `FirstPersonPlayerController`, concluded
correctly that a feel-first configurable controller cannot host `bg_pmove`, and wrote that up --
and in the same paragraph *named* `KinematicMover` before treating the directory as decided. Two
phases later I filed its capabilities as absent from the engine.

**"...and now you bitch that the shapecast query is not as amazing as you had hoped."** Fair on
the framing, and the framing was doing real damage: both entries were `blocker`, they were the
top-ranked item in the executive summary, and the claim attached to them was that *every* consumer
building a character controller would hit all three. That claim is false. Every consumer who
builds one out of the raw query layer while ignoring the solver will hit them.

**What changed.**

- **GAP-020 is withdrawn.** Not softened -- withdrawn. It asked for a `standoff` parameter on
  `shape_cast` and cited PhysX, Bullet and Unity as precedent. The precedent actually cuts the
  other way: `CharacterController.skinWidth` is on Unity's *controller*, not on
  `Physics.SphereCast`, and meep has made the same call deliberately and documented it.
- **GAP-019 drops from blocker to minor** and is reframed as what it actually is: Q3's per-brush
  interval rule cannot be expressed through `shape_cast`, which matters *because this port is
  required to reproduce Q3's arithmetic exactly*. That is a constraint the brief imposed and I
  accepted; it is not a defect in a query that correctly answers a different question. The
  `allsolid` bullet is corrected outright, since `compute_penetration` is the answer.
- **GAP-021 is new** and carries the residue that is genuinely the engine's: a solver whose own
  docblock says it is controller-agnostic, and whose imports confirm it -- `Vector3`, `Ray3`,
  `Transform`, `Collider`, `compute_penetration`, `PhysicsSurfacePoint`, nothing from the
  controller -- is namespaced at `engine/control/first-person/collision/`, and the most useful
  collision document in the package sits beside it. A consumer who has ruled out the first-person
  controller has been handed a path that says those files are not for them. The fix is a directory
  move plus a re-export.
- **The executive summary is re-ranked again.** The first-run experience returns to the top; the
  new item 2 is this failure, stated as what a maintainer can act on.
- **Section 5's 11× is reattributed.** It is not "what the gaps cost". It is what it costs to keep
  Quake III's arithmetic while running on meep's broadphase -- a trade this port chose.

**Would `KinematicMover` have been used?** For the slide-move itself, no, and that is worth being
precise about rather than conceding wholesale: `move()` *is* the slide loop -- recover, sweep,
clip, crease, dead-stop -- and replacing `PM_SlideMove` is exactly what the brief forbids. So the
correct outcome of reading it in phase 2 would have been a GAP-009-shaped positioning entry: *the
engine has a good kinematic solver and a Q3 port cannot use it, because the solver is the
algorithm and Q3's algorithm is the deliverable.* That is a useful finding. What I filed instead
was two claims of absence about things that were present.

Three of the port's individual pieces would still have changed: `compute_penetration` answers
`PM_CorrectAllSolid` directly, the `skin` option would have removed GAP-020 before it was written,
and the constants table would have been the most useful page in the package during phase 2b.

**The pattern, since this is now the third instance.** A conclusion about one component was
allowed to cover its neighbours: a stale docblock cost double-sided surfaces for the whole port
(D-060 / GAP-007), a wrong reading of `NavigationMesh` took two rounds to correct (D-058 /
GAP-016), and rejecting a controller cost six hours and two wrong fixes (this entry). None was
caught by a test, because they are failures to look rather than failures to check. The mitigation
that would actually have worked is dull: when an entry is about to claim the engine *cannot* do
something, read the directory, not the file.

**What is deliberately not done.** The collision backend is not being rewritten onto
`compute_penetration` now. It is measured at 100.0% hit/miss agreement with a bit-exact control
and zero median divergence, the change would be unmeasured churn during a reporting phase, and the
honest record of what the port would have looked like is more valuable here than the port looking
different. Recorded as the alternative, in GAP-019 and GAP-021, rather than silently taken.

### D-071: Movement runs on meep's kinematic solver, and `bg_pmove`'s slide-move is retired

The maintainer, reversing the brief: *"We're looking to port Q3 in spirit, not in body. If you
lack exact precise semantic of movement in Q3 within the physics engine, the right move is to
change the movement semantic to be meep's."*

That overrides brief section 2, which said `bg_pmove.c` fidelity was "the one place fidelity is
non-negotiable" and that collision traces had to be faithful "because pmove depends on them". It
also settles what the previous three exchanges were circling: the port had been spending its
effort making a general-purpose sweep reproduce a 1999 brush-interval test, and the answer is to
stop.

**The split.** "Spirit" is not "vaguely Q3-ish", and the line is sharper than it looks:

| Q3 keeps -- the spirit | meep takes -- the body |
|---|---|
| `PM_CmdScale` | recover (depenetration via `compute_penetration`) |
| `PM_Friction` | sweep-and-slide, crease-aware |
| **`PM_Accelerate`** | stairs (`stepHeight`) |
| wishdir / wishspeed, ground-plane projection | ground categorise + stick |
| `JUMP_VELOCITY`, gravity, `pm_duckScale` | contact normals, the standoff |

`PM_Accelerate` is the whole reason this split works. Strafe jumping exists because `addspeed` is
capped against the *projection* of current velocity onto `wishdir`, so a player moving nearly
perpendicular to where they are pushing gets the full acceleration on top of the speed they
already have. That is arithmetic on a velocity vector. **No trace is involved in it at all.** So
the trick that makes Q3 movement worth porting is entirely on the side that stays, and every
contact semantic -- the thing that was expensive -- is entirely on the side that goes.

`src/client/MeepMove.ts` is that, and it is 400 lines against the 1,766 of `pmove.ts`.

**What this deletes as a *requirement*.** GAP-019's per-brush blocking rule and GAP-012's
latest-entering-plane normal were both needed *only* to make meep's sweep answer Q3's question.
Nothing asks Q3's question any more. `PhysicsTrace` and its per-brush re-derivation stay in the
tree because `?trace=clipmap` and the divergence harness still use them, and because the ported
`bg_pmove` is the reference any claim about the new path is measured against -- but the shipping
player no longer goes near them.

**What it costs, stated plainly.** Contact fractions differ, so a ramp launches at a slightly
different angle and a corner is rounded rather than clipped. There is no oracle for the new path
and there cannot be one: it is deliberately not the C. `test/meepmove.test.ts` replaces
bit-exactness with twenty behavioural assertions, each naming the property of Q3 movement it
protects -- tops out at exactly `ps.speed`, diagonal is not faster, one jump per press, the
strafe-jump chain exceeds the 320 base, a dropped player rests, a player pushed into walls keeps
moving, nothing goes non-finite. Measured on the new path: flat headings peak at **320.0** u/s,
and a scripted strafe chain reaches **354**.

**Integration.** `PlayerMovement` writes the existing `playerState_t` rather than replacing it, so
weapons, items, the HUD, character placement and the bots all read `ps.origin` / `ps.velocity` /
`ps.groundEntityNum` unchanged and cannot tell which solver ran. That kept the change to one
branch in `PlayerController` instead of a rewrite of `main.ts`. `?move=q3` selects the ported
path, and `?trace=clipmap` implies it.

**Three things this turned up that reasoning would not have.**

1. **`KinematicMover` wants feet-at-origin shapes, and meep's shapes are centre-origin.** The
   contract is real -- "Reference point is the capsule bottom (`position.y`)" -- and the way to
   satisfy it is to wrap the shape in a `TransformedShape3D` offset by half its height, which is
   what the engine's own `makePostureCapsule` does. It is documented in
   `FirstPersonPlayerControllerSystem`, not in `KinematicMover`, so a consumer driving the mover
   directly does not meet it. Passing a centre-origin box with a centred position is silent: the
   sweep is correct, and `_groundedAt` rays down `2 * stepHeight` from `position.y + stepHeight`,
   which for a 56-unit Q3 box stops ten units *above* the feet and can never reach the floor. The
   player hangs, ungrounded, at spawn height. An hour.
2. **A real engine bug, BUG-7.** `raycast` reports `t = 0` with a face normal for a ray whose
   origin is inside a convex hull's *AABB* but outside the hull. Reproduced in twenty lines with
   no map data. It breaks `_categorizeGround`'s walkability probe above any brush that does not
   fill its bounding box -- which in a Q3 level means every wedge and every ramp -- and it costs
   one of `aggressor`'s nine spawn platforms.
3. **The maintainer's direction was right in a way I could not have argued from the outside.**
   Thirty minutes of using the engine's own solver found a genuine engine bug. Three sessions of
   bending the query layer to Q3's semantics found none, because the workaround was carefully
   avoiding the code path the bug is in.

**What is not done, and is not hidden.** The bots still run the ported `bg_pmove` through
`PmoveHost`, so the player and the bots now move on different solvers. D-050's reasoning still
holds -- "a bot moving through a different `pmove_t` is a bot playing a different game" -- and
this is now true and was not before. `Bot` takes the same `PhysicsTraceBackend` the player used,
so the migration is the same `PlayerMovement` swap; it is the next change, not a design position.
Recorded here rather than left for someone to notice from the fact that bots corner differently.

### D-072: Bots move on the same solver the player does again, and the migration found an inverted constant

D-071 left the player on `MeepMove` and the bots on the ported `bg_pmove`, and said so rather than
hiding it. This closes that. `Bot` takes a `moverHost` exactly as `PlayerController` does, builds a
`PlayerMovement` when it gets one, and `?move=q3` still selects the ported path for both.

Bot.ts's opening paragraph has always claimed that a bot is the same physical object as the player
because it fills a `usercmd_t` and hands it to the same movement code. For one commit that was
false. It is true again, and the file now says which claim it is making.

**The bug the migration surfaced, which is the useful part.**

Migrating the bots made a number available that had not existed before: the fraction of frames a
bot is grounded over a match, on each solver. It came out at **6.1%** on the meep path against
**85.6%** on the ported path. A bot that is never grounded accelerates at `pm_airaccelerate` (1)
rather than `pm_accelerate` (10), so the expected symptom was bots that crawl.

They did not crawl. They reached 322 units/s and walked 27,000 units a match. That contradiction
is what located it: movement was correct and only the *report* of it was wrong.

`PlayerMovement.step` mirrors `MoveState.grounded` into `ps.groundEntityNum`, and it declared its
own copy of Q3's sentinels — **inverted**. Q3 has `ENTITYNUM_NONE = 1023` and
`ENTITYNUM_WORLD = 1022`; the local pair had them the other way round, so every consumer of
`groundEntityNum` received the exact opposite of the truth: `Bot.onGround`, the leg animation,
footsteps, the HUD's ground readout, and the tree's stuck detection. The player had been running
that way since D-071 and nothing caught it.

Nothing caught it because `test/meepmove.test.ts` asserts `state.grounded` — the internal field,
which was right — and never asserts the mirrored one. **A test that reads the source of a value
cannot catch a bug in the copy of it**, and the mirror is exactly where a bridging class earns its
keep or fails. The constants are now imported from `constants.ts`; the fix is one import and the
lesson is that the duplicate existed at all.

Measured after the fix, six bots and a standing player over 30 s at 125 Hz:

| | grounded | stuck | shots | pickups | walked |
|---|---|---|---|---|---|
| `oa_dm1`, meep | **93.9%** | 3.2% | **374** | **16** | 28,543 |
| `oa_dm1`, ported | 85.6% | 7.8% | 110 | 10 | 31,073 |
| `aggressor`, meep | **51.6%** | **23.3%** | **10** | 13 | 17,918 |
| `aggressor`, ported | 92.5% | 2.6% | 420 | 16 | 25,003 |

**`oa_dm1` is better on every axis that matters** — better grounded than the ported path, less
than half the stuck time, three times the engagement, and it costs 215 µs a frame against the
ported path's 47 and against the *old* meep-physics-under-pmove arrangement's 356. Fewer queries:
`KinematicMover` issues 6.0 traces a frame where pmove through `PhysicsTrace` issued 30.4.

**`aggressor` is worse on every one of them**, and the correlation available is BUG-7. Sampling
every navigation-graph node and casting the walkability probe `KinematicMover` casts:

| map | probe returns `t = 0` inside a body | probe finds a real surface |
|---|---|---|
| `oa_dm1` | 1.3% | 96.0% |
| `oa_dm4` | 4.5% | 95.2% |
| `aggressor` | **10.4%** | 84.0% |

`aggressor` has the highest rate measured and the worst regression, and the mechanism is
plausible end to end: probe fails, bot is not grounded, air acceleration, crawls, reads as stuck,
abandons its route, re-plans, repeats. **That is a correlation and I have not proven it accounts
for the whole 40-point grounding gap.** Stated as a correlation rather than a cause, because the
last four exchanges have all been about claiming more than the evidence supports.

**What is pinned rather than fixed.** `test/match.test.ts` asserts the shot count per map with
both measured values written into the test, and asserts damage where it lands. A fix in either
direction fails a test and forces this entry to be revisited, which is the intended behaviour.
The alternative — one threshold low enough for both — would have hidden a 40× difference between
two maps behind a green suite.

**What I would do next, in order**: confirm or refute the BUG-7 attribution by stubbing the probe
against the clipmap and re-measuring `aggressor`'s grounding; if confirmed, the fix is in the
engine and the workaround at this level is a documented ground re-test after `move`. Not done
here: the maintainer asked for the migration, the migration is done and measured, and building a
second workaround before confirming its cause is the mistake GAP-019 already made once.

### D-073: meep 3.2.0, BUG-7 fixed, and the pinned tests deleted

The maintainer: *"BUG-7 fixed in meep `3.2.0`."* And, separately: *"tests must never 'pass' with
incorrect behavior, so the practice of 'pinning' broken behavior is wrong. Failing tests are
better."*

Both land. The peer dependency is now `^3.2.0`.

**The fix is real and the numbers moved with it.** The synthetic probe, and then every navigation
node of three levels:

| map | `t = 0` inside a body, 3.0.2 → 3.2.0 | real surface found, 3.0.2 → 3.2.0 |
|---|---|---|
| `oa_dm1` | 1.3% → **0.0%** | 96.0% → 97.1% |
| `oa_dm4` | 4.5% → **0.0%** | 95.2% → 99.2% |
| `aggressor` | 10.4% → **0.0%** | 84.0% → 92.5% |

False hits gone, real hits up. Downstream, on `aggressor` -- the map that had the worst rate and
the worst regression when the bots moved onto meep's solver:

| | grounded | stuck | shots | pickups | walked |
|---|---|---|---|---|---|
| 3.0.2 | 51.6% | 23.3% | 10 | 13 | 17,918 |
| **3.2.0** | **89.4%** | **4.4%** | **220** | **16** | **24,391** |
| ported `bg_pmove` | 92.5% | 2.6% | 420 | 16 | 25,003 |

**This settles a question D-072 deliberately left open.** That entry recorded the link between the
probe failure and the bots' behaviour as a *correlation* and refused to call it a cause, because I
had not shown the whole gap was BUG-7. One changed line upstream moved every number in the table.
The correlation was the cause, and the method is worth keeping: when a correlation cannot be
untangled locally, an upstream fix is a controlled trial, and waiting for one beats guessing or
building a workaround on a hunch.

**The pinning was wrong and the tests are rewritten.** Two of them asserted the broken value so
the suite would stay green:

- `meepmove.test.ts`, "grounds at every spawn except where BUG-7 hides the floor", expecting
  exactly one failure on `aggressor`.
- `match.test.ts`, a per-map shot floor of 5 on `aggressor` against 100 elsewhere, and a damage
  assertion skipped on `aggressor` entirely.

Both now assert what ought to be true -- every spawn grounds, every map's bots fire and connect --
with one threshold and no per-map special cases. Both pass on 3.2.0, and the first of them failed
the moment the engine was upgraded, which is exactly the signal a pin destroys.

The reasoning I used at the time was that a pin plus a comment records the defect and makes a fix
visible. It does neither for the person who matters: someone reading a green run sees a working
system, and the comment is only read by whoever is already editing that file. A failing test is a
standing statement of what is broken, in the one place nobody can skip. The measured number
belongs in the failure *message*; it does not belong in the assertion.

**A defect in this report's own BUG-7 reproduction, found while confirming the fix.** The snippet
published in section 6 wound its hull faces inconsistently. On 3.2.0 that hull raycasts to a clean
**miss**, which looks like a regression and is not one; the maintainer spotted the likely cause
immediately ("I think your hull was inside out"). Re-running with outward-consistent winding gives
`t = 1.8000` and the correct slope normal, against 3.0.2's `t = 0` -- so the bug and the fix are
both confirmed, and the published repro has been corrected.

Worth recording as a finding in its own right, because the failure is silent and asymmetric:
`ConvexHullShape3D.from` accepts inconsistent winding without complaint, and every query built on
the support function then behaves correctly -- `overlap` classifies interior and exterior points
right, `support` returns correct extreme points, and `.volume` returns the correct 4. Only
`raycast`, which uses the face list, is winding-sensitive, and it silently returns nothing. The
suggested check I would have wanted is a signed volume or a winding pass in the constructor: it
would turn a silent wrong answer into a constructor error. `.volume` as it stands cannot be used
for this, which is worth knowing since it is the obvious thing to reach for.

None of this touched the real measurements: `brushHull` emits correctly-wound hulls, so every
whole-level number above was always sound.

**BUG-6 is also fixed in 3.2.0**, incidentally -- `ShadeMaterial.draw_side`'s docblock now
describes what the code does. BUG-1 through BUG-5 still reproduce; the `.d.ts` error count drifted
from 664 across 152 files to 674 across 154.

### D-074: The bridge dropped `PM_UpdateViewAngles`, and the player could not aim

Reported by the maintainer: *"after the mover changes, camera controls no longer seem to work.
That is - I can't aim with the mouse at all."*

`PmoveSingle`'s first act is `PM_UpdateViewAngles(pm->ps, pm->cmd)`, which turns the command's
16-bit angles into `ps.viewangles`. D-071 replaced `runPmove` with `PlayerMovement.step` on the
shipping path and did not replace that call, so `ps.viewangles` was never written again. It held
whatever it was initialised to, forever.

Three things read it, and all three froze:

- `PlayerController.writeCamera` orients the camera from it -- the reported symptom.
- `onFire` passes it as the shot direction, so every weapon fired along world yaw zero.
- The movement command's own yaw was read back out of it, so `wishdir` was built from yaw zero
  and holding forward always walked the same way through the world however you turned.

The mouse handler was fine throughout: it accumulated `this.pitch` and `this.yaw` and wrote them
into `cmd.angles` every frame. The command was correct and nothing consumed it.

**Why the tests did not catch it, which is the part worth keeping.** `meepmove.test.ts` drives
`MeepMove` directly with a `MoveCommand` carrying an explicit `yaw`, and reads `MoveState`. It
never goes through the bridge and never looks at a `playerState_t`. `match.test.ts` drives bots,
and a bot's yaw comes from its own field rather than from `ps.viewangles`, so bots aimed correctly
while the player could not. Between them the two suites covered the solver and the AI and left the
seam between them untested -- and the seam is exactly where a replacement drops things.

This is the second time. D-072 was the same shape: `ps.groundEntityNum` written with Q3's
sentinels inverted, invisible because every test read `MoveState.grounded`, the source, rather
than the copy.

**The fix is structural rather than a restored line.** `PlayerMovement.step` now takes the whole
`pmove_t` instead of a `MoveCommand` the caller assembled, and does `PM_UpdateViewAngles` itself
before building the command from `ps.viewangles`. The caller no longer has any part of
`PmoveSingle`'s job: previously `PlayerController` and `Bot` each built their own `MoveCommand`,
which is why they diverged, and why one of them was wrong. Both now hand over the `pmove_t` and
a crouch flag.

**And a test for the seam, which is what was missing.** `test/meepmove.test.ts` gains "the bridge
maintains what `PmoveSingle` maintained": it runs the ported path and the meep path from the same
spawn with identical commands and compares the `playerState_t` bookkeeping frame by frame -- not
positions, which are deliberately not equal any more, but view angles, pitch clamping, yaw wrap,
`groundEntityNum` against Q3's own sentinels, and `viewheight` against posture. Plus one
behavioural check that the player walks where it is looking, since that is the half a user
notices.

Verified to actually catch it: commenting the `PM_UpdateViewAngles` call out fails three of the
five, and restoring it passes all twenty-five. A regression test that does not fail on the
regression is decoration.

**The general lesson, since it now has two instances.** When a replacement stands in for something
that maintained state as a side effect, the risk is not the behaviour you replaced -- it is the
bookkeeping you did not know you had inherited. The test for that is parity against the thing
replaced, on the *fields*, not on the behaviour. `bg_pmove` is still in the tree and still
bit-exact, which is what makes that test possible; retiring it entirely would have removed the
only oracle for this class of bug.

### D-075: The bridge dropped the player's *box*, and no plat in the game carried anyone

Third instance of one mistake, found by finally writing the test the second instance said was
missing.

`PM_CheckDuck` writes two things: `ps.viewheight`, and `pm->mins` / `pm->maxs` -- the player's
bounding box. D-071 replaced `PmoveSingle` with `PlayerMovement.step`, which carried the view
height across and not the box. `createPmoveHost` initialises both to `vec3()`, so on the shipping
path `pm.mins` and `pm.maxs` were **`[0, 0, 0]` for the entire game**.

`main.ts` builds the box every mover asks about out of exactly those two:

```js
playerMins[i] = ps.origin[i] + player.mins[i];
playerMaxs[i] = ps.origin[i] + player.maxs[i];
```

So the player was a zero-size point at `ps.origin` -- which sits 24 units above the soles, i.e.
at chest height -- and that point was what `movers.update`, `movers.touchButtons` and
`carryDisplacement` were handed.

**What that broke, in order of how obvious it is:**

- **No plat carried anyone.** `carryDisplacement`'s rider test is "are the player's feet within a
  unit of the top of this thing", and the feet were reported 24 units above where they are. Both
  branches -- the standing-on-top band and the overlap fallback -- miss for the same reason.
- **Buttons could not be pressed by walking into them**, only by standing so that a point at
  chest height was inside the button's brush.
- **Every trigger volume shrank to a point.** Teleporters, jump pads and hurt triggers fired on
  the chest rather than the body, so a trigger whose brush ends below chest height -- a floor
  pad -- was harder to fire or impossible.
- Crouching changed nothing about what the world thought you were, so the one case `main.ts`
  explicitly reads the box for -- "a trigger test against the standing box would open a door you
  cannot fit through" -- did the opposite of its comment.

The `?move=q3` path was correct throughout, which is the signature of every bug in this family
and the reason the test is written as a two-path comparison.

**The fix** is six lines in `PlayerMovement.step`, next to the view height, sourced from
`boxForState` so posture and box cannot disagree. `PmoveLike` grows `mins` and `maxs`, which is
the honest signature: the bridge stands in for `PmoveSingle`, and `PmoveSingle` writes them.

**The test, which is the actual deliverable here.** `test/player-controller.test.ts`, 34 cases.
D-074 ended by saying the two suites covered the solver and the AI and left the seam between them
untested; that was still true, because the fix it shipped was a test of `PlayerMovement`, not of
the thing the browser builds. Nothing in the suite constructed a `PlayerController`.

This one does, through meep's own input-device shapes -- a keyboard whose keys are live switches,
a pointer that hands `(position, event, delta)`, a `document` stub for pointer lock -- and asserts
against the *real* consumers: the camera transform, `Footsteps`, `Character.legsFor`,
`WeaponSystem`'s angle handling, `carryDisplacement`, and the exact fields `Hud.update` is passed.
Twenty-two of the 34 run on both solvers, because "does the ported path do this too" separates a
port bug from a bridge bug and is the first thing worth knowing.

Verified to catch it: zeroing the six lines again fails four cases and passes thirty.

**Two things about writing it that are worth more than the bug.**

1. **A test that positions its fixture using the value under test cannot fail.** The plat case
   first placed the platform's top at `rig.boxMins[2]` -- the reported box -- so with a zeroed box
   the plat moved to chest height too and the player rode it happily. It passed the regression
   check. It now anchors to `ps.origin + MINS_Z`, Q3's own geometry, and fails. The same shape as
   D-072's "a test that reads the source of a value cannot catch a bug in the copy of it".
2. **The rig reproduces `main.ts`'s frame order rather than a tidier one** -- solve, then audio
   off the result, then movers, then the world's writes back into `ps`. Two cases exist only
   because that order is load-bearing: a teleporter and a jump pad both write `ps` *between*
   frames, and a solver that trusted its own last-frame output over `ps` on entry would ignore
   both.

**What the rig could not test, stated rather than skipped.** The synthetic plat is carried
sideways, not upwards. The headless collision world has no body for it, so a rising plat is one
the solver cannot see and it drops the player back onto the real floor -- the net lift would
measure ground stick, not carry. Sideways the floor is under the player either way, so the
distance travelled is the carry and nothing else. The obvious worry -- that a rising plat in the browser is a real
kinematic body, so `KinematicMover` might lift the player too and `carryDisplacement`'s vertical
term would be double-counting -- is settled by reading the solver rather than guessing: it has no
moving-platform support at all, and its `MoveResult` is `{hit, grounded, groundNormal}` with no
identity for what you are standing on. There is nothing to double-count with, and a consumer
could not write the carry themselves from what `move()` returns. Filed as GAP-022.

### D-076: The between-frames block moved out of `main()`, because a test of a copied ordering is a test of the copy

`test/player-controller.test.ts` originally reproduced `main.ts`'s frame by hand -- build the
player's box, run the movers, apply the carry, apply the teleport. That is the same mistake in a
new place. D-072's lesson was "a test that reads the source of a value cannot catch a bug in the
copy of it"; a test that re-implements an ordering cannot catch a bug in the ordering.

`src/game/WorldEffects.ts` is the four things the world does to a player between two frames --
carried by a plat, teleported, launched by a jump pad, hurt by a trigger -- plus the frame that
applies them in `G_RunFrame`'s order. `main.ts` and the test now both call it. Fifty lines left
`main()`; the mover event callbacks there keep the audio and hand the state to a recorder.

Worth stating why the block was untestable and not merely untested: it was an inline closure
between an engine boot and a render loop, closing over four mutable locals. Nothing could reach
it without a browser and a GPU. The extraction is the same move as `sceneFromQ3` and
`spawnPoints`, applied to the one part of the frame that three separate bugs have now passed
through.

Two things the extraction made visible on its own:

- **Teleport turns the player one frame late**, because the effects run after the solve and
  `setYaw` writes the command accumulator that `PM_UpdateViewAngles` has already read. Q3 has the
  same one-frame structure -- `TeleportPlayer` writes `ps->delta_angles` and the *next* pmove
  turns it into a view angle -- so this is correct, and it is now asserted frame-by-frame rather
  than left as "eventually", which would have hidden a teleport that stopped turning the player
  entirely.
- **`trigger_hurt` is the one effect that does not land in `playerState_t`.** Health lives in the
  inventory, so `apply` returns the number and the caller spends it. A return value nobody reads
  is how a mover event goes missing, so there is a case for it.

### D-077: What the browser could and could not verify, and why

The browser build had not been run since the movement rewrite. It has now been, on every shipped
map and every movement mode, against meep 3.2.0 -- and the ceiling on what that proves is worth
recording rather than glossing.

**Verified, live, no errors or warnings beyond the two known ones:** `oa_dm1`, `oa_dm4`,
`oa_dm5`, `oa_dm7`, `aggressor` and `am_thornish` all boot; `?move=q3` and `?trace=clipmap` both
select the ported path and boot; the WebGPU device comes up; the asset pipeline, physics body
construction (529-820 static bodies), mover kinematic bodies, navigation graph, bots, characters
and audio all initialise. Three numbers confirm findings that until now were only measured
headlessly: `oa_dm5` reports **0 lights over 107,414 triangles** (Q-006), `am_thornish` reports
**520 patches not solid** (D-017), and `oa_dm7` rejects two `item_health` as spawned in a solid.

> Since superseded for the middle number: D-125 makes those 520 patches solid on the physics
> backend, as 5,937 convex facets, and the body count on that map goes from 756 to 6,693.
> `?trace=clipmap` still passes through them, which is the half of D-017 that remains.

**Not verified: a single simulated frame.** meep's `Ticker` bootstraps its loop with one
`requestAnimationFrame` and suspends outright if `document.visibilityState` is `hidden` at
`start()`. The browser pane available here is never displayed, so the page is permanently hidden,
rAF never fires, and the fallback `setTimeout` chain is downstream of the rAF that would have
started it. The engine's own overlay says so: `FPS: Infinity, RENDER: 0.00ms, SIMULATION:
0.00ms`. Nothing about the frame loop, the HUD text, rendering or input can be checked from here,
and no amount of driving the page changes that.

That is why the work went into `player-controller.test.ts` rather than into a screenshot. The
headless rig runs the real `PlayerController`, the real `KinematicMover` against a real
`PhysicsSystem`, the real `WorldEffects`, the real `Footsteps` and the real map collision; the
only stub in the movement path is `ecd.getComponent`, two methods. What genuinely cannot be
reached without a display is rendering and the tick source -- and the port writes no rendering
code by the brief.

**Not a suggestion that anyone verify visually.** If a frame loop bug exists it will be found the
way the last three were: by asking what `PmoveSingle` maintained that its replacement does not,
and writing the parity case. That question has now been asked of every field, and it
turned up one more: `ps.stats[STAT_HEALTH]`, which `Bot` mirrors every frame and
`PlayerController` never has, so the player's copy held its spawn value for the whole game. Three
places in `bg_pmove` read it -- `PM_UpdateViewAngles` refuses to turn a corpse, `PmoveSingle`
drops `CONTENTS_BODY` so a corpse falls through players, and the medium-fall event is suppressed
for the dead -- and none of them ever saw a dead player. Unlike D-072, D-074 and D-075 this one
predates the movement rewrite and was wrong on both paths, which is why it is written up here
rather than as a fourth instance.

Fixed with the mirror plus two things the mirror does not give for free: the look accumulator
freezes with the view, so two seconds of unread mouse movement does not arrive at once on
respawn (Q3 avoids the same snap with `ps->delta_angles`, which is a server telling a client
where it now looks; there is no server here, so the client simply stops), and the movement
command and trigger are gated on the same test, so a corpse does not walk off holding forward or
keep firing.

### D-078: The lighting comes back, from the baked product nobody had read

Q-006, answered by doing it. `oa_dm5` had **zero** reconstructed point lights over 107,414
triangles and `oa_dm7` left 70 of 79 player positions under a lux, because both were lit with
`light` entities and q3map2 deletes those after baking. The shader route -- `q3map_surfacelight`
plus `q3map_sun` -- only carries a map's lighting if its author used surface shaders, and two of
six did not.

`LUMP_LIGHTGRID` is the other thing q3map2 bakes and it does survive: a regular lattice over the
world model, eight bytes a cell, an ambient colour, a directed colour and the direction the
directed light arrived from. It is what Q3 lit *models* with, because models sit outside the
lightmap.

**The reader is verifiable and that is why it can be trusted.** None of the lattice geometry is
stored in the file -- `R_LoadLightGrid` recomputes it from the world model's bounds and the
worldspawn `gridsize`, and there are four independent chances to be off by one, each of which
still decodes eight legal-looking bytes per cell into the wrong place. The point count is the one
cross-check the format offers and it is exact. On all six maps the formula predicts the lump
length to the byte, and `readLightGrid` throws rather than proceeding if it ever does not.

**The fit is the interesting half, and it went wrong twice in ways worth recording.**

Turning a sampled irradiance field back into sources is an inverse problem with no unique answer,
so this fits rather than solves. Every lit cell becomes a *site* with a target illuminance; sites
are visited brightest first; each is given a light only if the lights already there leave it
short, placed toward the source and sized to close the shortfall.

1. **A fixed placement offset made a volume of fireflies.** The first working version put every
   light one metre along the sample's direction. That is the wrong distance for almost every real
   source, and the error is not cosmetic: a light fitted to deliver the right illuminance at its
   own cell from 1 m away under-delivers by nine times at range if the true source was 3 m away,
   and the far field is most of the room. It emitted **256 lights on `oa_dm1`** -- hitting the
   cap, so silently truncated -- against the 22 its shaders already give it.

   The fix is that the grid can be asked. Two samples on a line through a source determine its
   distance: with `E ~ 1/d^2`, this cell and its neighbour one step further away give
   `d = s / (sqrt(E0/E1) - 1)`. Clamped hard, because the source is not a point, the neighbour
   may be shadowed, and the bytes are quantised. `oa_dm1` went from 256 lights to 11.

2. **Greedy placement over-delivers and no threshold fixes it.** Each light is sized against the
   lights placed *before* it and every light after adds more on top; measured, the result was two
   to three times the grid's target. Constraining the sites that received lights was not enough
   either -- that left `oa_dm1` at 52 lux against a 21 lux target, because the cells *between* the
   lights are unconstrained and that is most of the map.

   So the objective is the residual over every cell, and holding all but one light fixed makes it
   a one-variable least squares with a closed form. Sweeping that over the lights is coordinate
   descent: monotone, local, converges in eight passes. The alternative was to divide the
   calibration constant by the measured overshoot, which would have produced the same medians and
   hidden a fixable error inside a number that is supposed to mean something.

**The calibration is measured, and its spread is stated rather than smoothed.** q3map2's bytes
have no physical unit and meep's lights are photometric, so one number bridges them. It is taken
from the maps whose reconstruction the demo already accepts -- median delivered lux at player
positions over median grid brightness at the same places -- and those give 0.084, 0.202, 0.194
and 1.193. Fourteen times, end to end. The median, 0.2, ships. The spread is itself a finding:
the shader route is only approximately calibrated, and a map with 147 bright shader emitters is
not measuring the same thing as one with 22 in corridors.

**Results.** Lights added, and median lux at the places a player stands:

| map | lights | added | median lux | under 1 lux |
|---|---:|---:|---|---|
| `oa_dm5` | 0 -> 39 | **+39** | 0.0 -> **10.0** | 36/36 -> 1/37 |
| `oa_dm7` | 13 -> 38 | +25 | 0.0 -> **27.3** | 70/79 -> 0/80 |
| `oa_dm1` | 22 -> 33 | +11 | 8.7 -> 15.8 | 0 -> 0 |
| `oa_dm4` | 22 -> 44 | +22 | 32.6 -> 33.2 | 0 -> 0 |
| `aggressor` | 63 -> 90 | +27 | 20.2 -> 20.6 | 0 -> 0 |
| `am_thornish` | 147 -> 329 | +182 | 57.6 -> 57.6 | 0 -> 0 |

The three maps the demo presents move by 0.4 lux, 2%, and nothing. That is the deficit
formulation working: it is not gated on "is this map dark", it simply has nothing to add where
the shaders already meet the target.

**A finding that fell out of it, about this port and not about meep.** Fitting against the grid
means measuring the existing solution against it, and the existing solution overshoots: RMS error
against the baked field is 256% on `oa_dm4`, 332% on `aggressor` and **6,855%** on `am_thornish`,
which delivers 58 lux at player height where q3map2 baked 10. Passing `q3map_surfacelight`
through as lumens is far too generous on a map with many bright shader emitters. Now that there
is a reference it could be calibrated per map. Not done here: it would re-light the three maps the
demo presents, which is a larger change than this one and belongs in its own.

**Done in D-105**, and per map was not enough — the surface lights became free variables in this
same least squares, because the declared values are wrong in both directions within a single map.
`am_thornish` now delivers 7.1 lux at player height against the 7.7 the grid baked.

**What was pinned is now asserted.** `test/presentation.test.ts` pinned the shortfall -- "records
the two maps where the reconstruction is thin" -- specifically so a fix would fail there and
force the claim to be rewritten. It did, and it has: the lighting criterion is asserted on all six
maps rather than the three the demo presents, `oa_dm5` must have more than ten lights and every
one of them must carry a colour (only a lightgrid light does; a `q3map_surfacelight` is a
scalar), and a separate case asserts that the maps which were already lit did not get taken over
by the fit.

**Light colour now reaches the runtime.** `BundleLight.color` is optional: absent means the
tungsten default a surface light has always had, present means the colour q3map2 baked into that
cell. A room lit red in Q3 is lit red here.

## What the player could not see

### D-079: Not one decal had ever been drawn, and the thing that stopped them was a sign

The port has had impact marks since phase 3. `Effects.mark` builds them, `bulletImpact` and
`explosion` call it, a 2,048-entry ring retires the oldest, `DecalSystem3` is registered in
`main`, the textures are on disk, and the report counts the whole arrangement as phase-4
complete. None of it was ever on screen.

**The fade.** meep's decal composite takes a decal's *outward* direction as `-axis_z` -- a decal
projects along its own +Z, **into** the surface -- and fades on
`smoothstep(0.35, 0.6, dot(face_normal, outward))`. `Effects.mark` oriented the projector by
looking *along* the surface normal, which makes `outward` the exact opposite of the surface it
was aimed at, scores a dot of -1, and fades to zero. The composite's inner loop `continue`s on
that, so every decal in the game was skipped, silently, on every frame, on every surface.

The CPU side is indistinguishable from a working one, and that is the part worth keeping: the
entity exists, the component is correct, the texture loads, the atlas patch is acquired, the GPU
record is packed, and `DecalSystem3.record_count` reports 2 for two shots either way. Every
observable this port could reach said the decals were fine.

There is nothing to blame for the sign but the code that got it wrong. meep documents the
convention exactly, in `chunk_decal_surface_frame`, in a docblock that also explains why the fade
doubles as the grazing-angle rejection and therefore cannot warn about it. What it does not do is
say it anywhere a consumer looks -- `Decal` and `DecalSystem3` are both silent on which way a
decal points -- and that is filed as GAP-023 rather than offered as an excuse.

**The textures, which were wrong in a second and independent way.** Q3 draws every impact mark
with `blendfunc gl_zero gl_one_minus_src_color`: the result is `dst * (1 - src)`, so a *bright*
texel darkens the wall most. `convert-fx.ts` had `mark_bullet` sharing the additive sprites'
conversion -- keep the colour, promote luminance to alpha -- and `mark_burn` and `mark_hole`
copied across untouched, alpha channel and all.

Had the fade been right, that would have drawn white blobs where bullets hit and a two-metre
**opaque black square** centred on every explosion, because those two TGAs are fully opaque and
carry the mark in their colour. The first bug was hiding the second, and fixing only the sign
would have looked like a regression.

The conversion is now stated in terms of the Q3 blend each image was authored for, because for
these images that blend has an exact restatement: `dst * (1 - src)` with a greyscale source *is*
`src.rgb * a + dst * (1 - a)` with `src.rgb = 0` and `a = luminance(src)`. Black, at coverage
equal to brightness. `plasma_mrk` is the one Q3 drew with a plain `blendfunc blend` and is the one
whose own RGBA was already right; `scripts/decals.shader` is the record of which is which.

**Two smaller things fixed on the way, both of them Q3's own behaviour.**

- An explosion's scorch mark was projected straight down, because `explosion()` had no surface to
  work from and assumed Q3's up. Correct on a floor and invisible on a wall, which is the more
  common rocket. `WeaponEvents.explosion` now carries the impact normal, taken from the trace that
  stopped the missile and absent when nothing did -- a rocket that caught a player in the open
  struck no surface, and `trace.planeNormal` there is whatever the last unblocked trace left
  behind.
- `CG_ImpactMark` spins every mark by `random() * 360`. Without it a wall taking a magazine of
  machinegun fire is tiled with the same stamp at the same angle. The roll is a parameter rather
  than a call to `Math.random` inside `mark`, so the placement stays testable.

The mark sizes are now `CG_MissileHitWall`'s, read as the radii they are in the C. They were being
passed as radii and consumed as diameters, so every mark was half the size Q3 draws -- which
nobody could have noticed, since none of them drew.

**What the test does, and what it deliberately does not.** `test/first-person.test.ts` asserts the
*fade*, computed from the decal's own matrix through a transcription of
`chunk_decal_surface_frame`, over eight surface orientations including both poles the look
rotation special-cases. It asserts 1, not "greater than zero": the fade is a smoothstep, so a
projector sixty degrees out still scores above zero and would draw a smeared ghost. It also
asserts that the box encloses the point it was placed at, that the mark textures are black
wherever they cover, and that they are not uniformly opaque -- which is the black-square failure
stated as a number.

A test that counted decal entities would have passed throughout the two phases this was broken.
That is the whole reason none of these assertions counts anything.

### D-080: A crosshair and a gun, on Q3's own numbers rather than on taste

Neither existed. The HUD had a speedometer, a status line and no reticle; the player held nothing.
Both are the kind of feature where the arrangement is obvious and every constant is a judgement
call, so every constant here is read out of the C or out of the shipped assets.

**The crosshair** is `CG_DrawCrosshair`, which is three rules and an image:

- `gfx/2d/crosshair[a-j]`, all ten converted, because `cg_drawCrosshair` is a number from 0 to 9
  and choosing one at build time moves a player preference into the pipeline. The default is id's
  own **4**, which resolves to `crosshaire` and is a single dot -- not the cross most people
  picture, and what both Q3 and OpenArena ship. `?crosshair=N` disagrees without a rebuild.
- `cg_crosshairSize 24` against the 640x480 virtual screen `CG_AdjustFrom640` maps from, so 5% of
  the viewport height. Q3 scales width by `width/640` and height by `height/480` independently,
  which stretches the reticle on anything that is not 4:3; the height scale is used for both axes
  here, so it is Q3's size at 4:3 and round everywhere else.
- `cg_crosshairHealth`, which defaults on, tinting through `CG_GetColorForHealth`. Armour counts
  toward the colour only as far as it can absorb -- `health * p / (1 - p)` at `ARMOR_PROTECTION`
  -- so it is a damage indicator rather than an armour readout, and a crosshair on 1 health and
  200 armour is red.
- The `ITEM_BLOB_TIME` pulse on a pickup, which snaps to normal size at the instant of the pickup
  and grows to double over the next fifth of a second. That is backwards from what "pulse"
  suggests, and it is what the C does.

It is a DOM element with the crosshair as a CSS *mask* over a solid fill, which is what puts the
tint somewhere `cg_crosshairHealth` can reach without a second copy of the image. Sizes and
colours are written to `style` directly rather than through an `ObservedString`, and that turned
out to matter for a reason nothing predicted: `LabelView` writes its text through `frameThrottle`,
so in a document that is permanently hidden -- which is every browser this project has been able
to drive (D-077) -- the HUD's *text* cannot be observed and the crosshair's geometry can.

**The view weapon** is `CG_AddViewWeapon`, minus the renderer.

Where it sits is measured rather than chosen. Q3 draws a hands model at the view origin and hangs
the weapon off its `tag_weapon`, so that tag *is* the offset from the eye, per weapon, authored by
the people who made the game. `convert-models.ts` now converts the `*_hand.md3` files for it; in
OpenArena they carry no geometry at all -- the arms Q3 shipped are gone, and what is left is the
tag and the animation frames -- so six of them cost 0 triangles and buy 6 tags. Seven weapons ship
none, which is not a defect: `CG_RegisterWeapon` falls back to
`models/weapons2/shotgun/shotgun_hand.md3` for exactly that case and so does `ViewWeapon`. They
are filtered out of the converter's `missing` list and printed on their own line instead, because
an expected absence in a list whose job is to be read is noise.

The result for the machinegun is 6.16 units in front of the eye, 5.83 to the right and 7.80 below
it, and the test asserts that against the MD3 rather than against a screenshot. The sign on the
middle component is the one that would survive review if it were wrong, because a gun in the left
hand looks deliberate.

The bob is `CG_CalculateWeaponPosition` -- the walk sway, whose roll and yaw invert on alternate
steps, and the idle drift on a one-second sine whose `xyspeed + 40` scale is what keeps a standing
player's gun alive.

**The paragraph that follows is superseded by D-081 and kept because the mistake in it is the
useful part.** Reconstructing the cycle from distance was the right instinct -- Q3 does fire the
bob and the footfall from one counter -- aimed at the wrong quantity, and the gun ran at twice
Q3's rate as a result.

Q3 drives both from `ps->bobCycle`, which the ported `bg_pmove.c` maintains and
the shipping movement path (D-071) does not; reading it would have given a gun that bobs under
`?move=q3` and is dead still otherwise. It is reconstructed from distance travelled instead, over
the same `FOOTSTEP_STRIDE` the footstep sounds already use, so the dip and the footfall are one
event -- which is what they are in Q3, where one counter fires both.

**Three things Q3 does that this does not, all of them the renderer.** `RF_DEPTHHACK` squashes the
gun's depth range so it can never poke through a wall; this draws through the scene's own G-buffer
pass, so the gun clips into geometry you stand against exactly as any other object would.
`RF_MINLIGHT` puts a floor under the gun's lighting; nothing here corresponds, so a dark room gets
a dark gun. `RF_FIRST_PERSON` keeps it out of mirrors and out of the shadow pass, and only the
second half matters here -- that is one flag, and it is cleared, because a view model half a metre
from the eye otherwise throws its own shadow across the scene whenever a light is behind the
player. The landing dip is not ported either, for a different reason: it is scaled by
`cg.landChange`, which comes from the `EV_FALL_SHORT`/`MEDIUM`/`FAR` split, and nothing in this
port carries a landing's severity.

**What was verified live, and what was not.** D-077's ceiling still holds: the browser pane is
permanently `document.visibilityState === 'hidden'`, `requestAnimationFrame` never fires, and no
frame is ever simulated or drawn. But the tick signal can be sent by hand from the console, and
everything downstream of it then runs for real. Ten ticks on `oa_dm1` build the machinegun's two
pieces from the real bundle and place them 6.16 forward, 5.83 right and 7.80 below the real camera
transform; the crosshair sizes to 36 px in a 720 px viewport and tints white, then yellow at 70
health and red at 20; firing into four different walls produces four marks whose outward
directions are those walls' own normals, and `DecalSystem3` packs every one of them.

What still cannot be checked from here is a rendered pixel, and no screenshot is offered in place
of one.

### D-081: The gun jerked, and it was two mistakes with the same shape

Reported as "the weapon moves with jerks" the session after D-080 shipped it. Two causes, and
neither is in the placement arithmetic the tests were written against -- both are about *which
value* that arithmetic was handed.

**The camera the gun was welded to was not the camera the frame was drawn with.**

`Engine`'s constructor subscribes `entityManager.update` to the ticker. Every application handler
is added later, so every application handler runs *after* every system. `CameraSystem3` copies the
camera entity's `Transform` onto Shade's camera during that update -- and what it copies is
therefore the pose `PlayerController.update` wrote at the end of the **previous** tick.
`ViewWeapon` was handed the camera entity's transform, immediately after `player.update` had
written this tick's pose into it.

So the gun was placed from pose N and the frame was drawn from pose N-1, every frame, for ever.
The displacement is exactly the mouse movement of one tick. Measured on `oa_dm1` by feeding ten
irregular frame times and ten irregular mouse deltas and taking the angle between the gun's barrel
and the forward of the camera Shade would draw with:

| mouse delta this tick | barrel to rendered forward |
|---:|---:|
| 12 deg | 12.95 deg |
| 4 deg | 4.07 deg |
| 20 deg | 20.09 deg |

The gun swung across the screen by however far the player had just turned, frame after frame, in
whatever irregular pattern the hand and the frame rate produced between them. A flick threw it off
the side. After the fix the same ten frames give a spread of **0.082 degrees**, and all of that is
the idle drift, which is meant to be there.

The fix is not a reordering. Ordering is what made this possible in the first place, and a comment
saying "call this before that" is a rule that gets broken by the next person to touch the tick
loop. `ViewWeapon` is now handed `graphics.camera.camera.transform` -- the renderer's own camera --
which is written by exactly one thing, `CameraSystem3`, inside `entityManager.update`, and is
therefore settled before any application handler runs no matter where in one this is called. The
requirement is stated where the parameter is declared rather than where the call happens.

**And Q3's bob is a clock, not an odometer.**

`PM_Footsteps` advances `ps->bobCycle` by `bobmove * msec` -- a fixed 0.4 per millisecond running,
0.5 ducked -- so one arch takes 320 ms whatever the player's speed. Sprinting does not bob you
faster; it moves you further per bob, and `LEGS_RUN` plays at its own frame rate to match.

D-080 reconstructed the cycle from *distance travelled* instead, sharing `FOOTSTEP_STRIDE` with the
footstep sounds on the reasoning that Q3 fires both from one counter -- which is true, and was the
right instinct pointed at the wrong quantity. At Q3's own 320 unit/s run speed 48 units per step
comes out at 6.7 arches a second against the C's 3.1, and a strafe-jump chain at 500+ went half as
fast again. What reads as a bob at 3 Hz reads as a shiver at 7.

`WeaponBob` is now `PM_Footsteps`' own arithmetic run from the same inputs -- grounded, asking to
move, ducked, and the frame time -- which needs neither `ps.bobCycle` (the shipping movement path
does not maintain it, D-071) nor a reconstruction. Measured live at 320 unit/s: three turning
points a second, 3.56 degrees of yaw, and 0.27 degrees of movement per 8 ms with no step anywhere
larger. Two new accessors carry the gates the cycle needs: `PlayerController.moving`, which is the
*command* rather than the velocity because Q3 stops the cycle when the keys come up rather than
when the sliding stops, and `ducked`, which is `PMF_DUCKED` rather than the crouch key because
`PM_CheckDuck` refuses to stand you up under a ceiling.

The counter is held as a float where the C holds an integer. `bobCycle` is a byte because it goes
on the wire, and truncating it is visible in the sine at 300 fps; nothing here is transmitted, so
the artefact is not reproduced.

**What this says about the tests written in D-080.** They asserted the placement arithmetic -- that
the barrel comes out along the view it was given, that the offset lands in the right hand -- and
every one of them still passes, unchanged, on code that shook so badly it was the first thing
anyone said about it. They were the right assertions about the wrong scope: correct given the
inputs, and silent about whether the inputs were the right ones. The cases added here are about the
*rates and the frames* rather than the geometry: an arch every 320 ms at three different speeds, a
cycle that stops with the keys rather than with the velocity, and a sway whose largest step over a
second is bounded by its own analytic slope -- 0.4 degrees, against the 6.4 a parity flip landing
off the zero would inject.

**Still open, and not changed here.** `Footsteps` in `Audio.ts` has the same defect: it plays a
footstep every 48 units travelled, so at run speed it fires every 150 ms against Q3's 320. Its
docblock justifies the distance reconstruction as "the same quantity the animation is a function
of", and that premise is what is wrong -- `bobCycle` is a function of time. Fixing it is the same
three lines and it halves the footstep rate at a run, which is an audible gameplay change nobody
asked for; it is flagged rather than folded in.

*Asked for, and done in D-082 -- where it turned out not to be three lines, because the right fix
was to stop keeping a second copy of the counter at all.*

### D-082: The gait is one counter again, and it lives where Q3 keeps it

D-081 fixed the view weapon's bob and left the footstep sounds running at the rate that had been
wrong the whole time, on the grounds that halving the footstep rate is an audible change nobody
had asked for. The maintainer asked for it. This is that, and it is bigger than the three lines
predicted -- because doing it properly meant putting the counter back where Q3 keeps it instead of
fixing a second copy of it.

**Q3 has one gait.** `PM_Footsteps` maintains `ps->bobCycle`, and everything downstream reads it:
the footstep events come from the crossing test inside that same function, `CG_OffsetFirstPersonView`
takes the view bob from `cg.bobfracsin`, and `CG_CalculateWeaponPosition` takes the gun's sway from
the same. One clock, three consumers.

This port had grown three answers to the question. `Footsteps` counted distance in
`Audio.ts`. `WeaponBob` counted distance again in `ViewWeapon.ts`. And the ported `bg_pmove.c`
maintained the real `ps.bobCycle` faithfully -- which nothing read, because the shipping movement
path (D-071) does not run `PM_Footsteps` and so left the field at zero forever.

So the counter moved to `PlayerController`, which is the port's stand-in for `PmoveSingle` on the
kinematic path. `updateBobCycle` is `PM_Footsteps` minus the leg animations, which belong to a
character the local player does not have, and minus the event queue, which this port does not have
either. It runs **only** on the kinematic path; the ported path already does it, and doing it twice
would double the rate.

The arithmetic is the C's including the truncation. `bobCycle` is a byte on Q3's wire, so
`trunc(old + bobmove * msec)` drops the fraction of a cycle a frame does not fill rather than
carrying it -- at this rig's 8 ms tick, `0.4 * 8 = 3.2` advances the counter by 3, which is a 6%
rate loss that Q3 also pays. Reproducing it is what makes the two movement paths comparable tick
for tick, and `player-controller.test.ts` now compares them: after 200 running frames both report
the **same** `bobCycle` and the same number of footsteps, and both park at 0 when the keys come up.

**What changed audibly.** A running player took a step every 150 ms and now takes one every 320 ms.
Measured in the browser on `oa_dm1` by wrapping the sound bank rather than the class: one second of
holding forward asked for `player/footstep` **three** times, against six or seven before.

**Three details of the C that came back with it, none of which the distance version could express.**

- The cycle is gated on `pm->cmd.forwardmove || pm->cmd.rightmove` -- on *asking* to move, not on
  moving. Release the keys at a sprint and Q3 stops the gait immediately rather than letting it
  coast out with the velocity. Below 5 units it also resets the counter to zero, so the next stride
  starts level instead of wherever the last one was interrupted.
- A ducked player's cycle runs *faster* (`bobmove = 0.5`) and plays **no footstep at all**. Both
  halves are Q3's: the bob is a gait and the silence is stealth. The old version had neither, and a
  crouched player padded along at full volume.
- The footstep fires where `bobCycle` crosses **64 or 192** -- the peaks of the two arches, not
  their ends. `((old + 64) ^ (bobCycle + 64)) & 128` is the whole test, and its consequence is that
  the sound lands with the gun at the top of its sway rather than the bottom. That is not what a
  foot does and it is what Q3 does.

`FOOTSTEP_STRIDE` is gone rather than corrected. There is no stride length in this any more: 320 ms
at Q3's 320 unit/s run speed works out at 102 units of ground per step, against the 48 the old
constant asserted, and the reason it is not a constant is that it is not a property of the gait --
it is what the gait and the speed happen to multiply out to.

### D-083: The transparency route, which was wrong in six independent ways

The maintainer, with a screenshot: *"I think transparent materials are not properly used, or
textures are messed up. The white thing, I believe, is supposed to have transparency on it, it
doesn't -- it looks 100% opaque. This messed with OIT because alpha is 100% too. The torches on the
walls clearly were intended to have alpha in the flame texture too."*

Both are right, they have different causes, and looking for the shared cause turned up four more.
The white thing is `textures/sfx/beam` on `oa_dm1` -- eight triangles of light shaft over the
corridor, drawn as a solid white box. The torches are `textures/sfx/flame2`, twenty triangles of
opaque black-and-orange quad.

**1. `blendFunc GL_SRC_ALPHA GL_ONE` was not recognised as additive.** `isAdditive` tested
`src === 'gl_one'` and then `dst === 'gl_one'`, which catches `blendfunc add` and misses the form
OA's flames, sprites and half its effects actually use. A stage it missed matched no other branch
either -- not `filter`, not alpha-blend, not "no blendfunc" -- so it contributed *nothing*: no
albedo, no emissive, no transparency. The material fell through to `qer_editorimage`, the preview
picture the level editor shows in its texture browser, and rendered that, opaque.

The rule is now stated by the blend's **destination** factor rather than by a list of source
factors: a stage whose destination factor is `GL_ONE` keeps the whole framebuffer, so it cannot
occlude anything, so whatever coverage it has is its own brightness. One sentence covering
`GL_ONE GL_ONE`, `GL_SRC_ALPHA GL_ONE` and `GL_DST_COLOR GL_ONE` -- flames, beams and water.

**2. Transparency was decided by `surfaceparm trans`, which Q3's renderer never reads.**
`tr_shader.c`'s `infoParms` maps it to `CONTENTS_TRANSLUCENT` with surface flags of **zero**, and
the comment beside it says what it is for: *"don't eat contained surfaces"*, a hint to the BSP
compiler about vis and light. It has nothing to do with drawing.

What decides drawing is `FinishShader`, and it asks one question: does **stage 0** set blend bits?
If it does the shader sorts into `SS_BLEND0`; if it does not, `shader.sort = SS_OPAQUE`, however
many later stages blend. That is now the whole rule here too, including `ParseStage`'s two
normalisations -- the `add`/`filter`/`blend` shorthands, and *"implicitly assume that a GL_ONE
GL_ZERO blend mask disables blending"*.

Reading `surfaceparm trans` instead was wrong in both directions at once. It made
`textures/liquids/lavahell` -- opaque geometry with an additive second pass -- see-through, and it
rescued `textures/sfx/beam` into the transparent bucket by accident, which is how the beam ended up
transparent-in-name and solid-in-fact. Fixing only the flames would have left the beam exactly as
reported.

**3. Nothing gave a transparent surface any coverage, so `beam` was a white box.**
`textures/sfx/beam` names one image, `beam.jpg`, through `GL_ONE GL_ONE`. The additive branch
routed it to the emissive slot and `continue`d before it could be an albedo, so the material had
`albedo: null`; the runtime then bound no albedo texture, meep sampled its white default at alpha 1,
and `surface_alpha = t_diffuse.a * albedo_color.a` came out at exactly 1. A fragment at full opacity
in the OIT accumulation is not merely opaque, it dominates the moment-based transmittance around it,
which is the second half of what the maintainer saw.

A Q3 additive image has no alpha channel to give: it is authored over black and its *brightness* is
how much of the destination it replaces. That is D-079's identity, and this is the same restatement
applied to shader materials rather than to sprites. Such a shader is now an alpha-blended material
with

- albedo: the same image restated as **black with `luminance` in alpha**, so it contributes
  coverage and no diffuse;
- emissive: the image itself, at intensity 1 or at `q3map_surfacelight`.

which composites to `src * L + dst * (1 - L)` against Q3's `dst + src`. The two agree where the
image is black and where it is bright, and the port under-brightens in between rather than
over-brightening. `beam.add.png` averages 9% coverage; the water on `oa_dm7` 17%; the quad aura 4%.
None of them is a box any more.

**4. Every glow map in the game resolved to the wrong file.** Q3 names a glow `<texture>.blend.tga`
and `.blend` looks exactly like an extension. `resolveTexture` stripped a trailing `.<ext>`
unconditionally and *then* tried the loaders' extensions, so `textures/base_light/ceil1_38.blend`
resolved to `ceil1_38.tga` -- the base texture sitting beside it. Every emissive was a second copy
of its own diffuse, so the whole fixture glowed instead of the bright part of it.

`R_LoadImage` tries the name it was handed first and only strips afterwards. Doing it in that order
resolves `ceil1_38.blend.tga` correctly and leaves the stripping fallback for the names that need
it. `R_FindShader` has the mirror-image behaviour on the *shader* side -- it runs
`COM_StripExtension` before looking anything up -- which `ShaderIndex.material` did not, so eleven
pickup models whose MD3 surfaces name their skins with the extension left on missed their scripts
entirely and fell through to the implicit-texture branch, which has no stages and therefore no
transparency and no glow.

**5. An alpha channel Q3 ignored is load-bearing in meep, and nineteen images had one.** Uploads are
premultiplied and both shading paths divide the colour back out by alpha, so a texel at alpha 0
shades **black** whatever `transparency_mode` says. Q3 had no such coupling: a stage with no
`blendFunc`, or `filter`, or `add` never looked at the alpha channel, and a great many OA textures
carry a leftover one. The red armour, the yellow armour, the railgun skin, the plasma gun, the three
CTF flags and the gib membranes are all in that state, and all of them were rendering with black
patches in the shape of a mask nobody meant to apply.

So a texture reference is not a path any more, it is a path **plus the Q3 blend the stage that named
it used**, and `texture-out.ts` holds one restatement per blend: alpha forced opaque, alpha kept,
luminance into alpha, `255 - luminance` into alpha, or the colour divided back out of alpha. Bundles
key their texture table by path-plus-blend, because one image referenced two ways is two files.
Filed against the engine as BUG-9 and as a docs gap: the contract is stated precisely, in a comment
inside `fragment_gbuffer`'s WGSL, and not on the field a consumer assigns.

**6. The reader lost brace balance, and the report's lossiness numbers were the casualty.**
`shader-script.ts` acted on a brace only when it was a line's *first* token. Thirty-six lines across
five OA scripts put a directive on a brace line, and a line ending in `}` therefore never closed its
stage: the rest of that shader was swallowed into it and the entry ran on past its own end.
Recovering that is 72 more entries and 36 more unique shader names, none of them on a converted map
-- and it moves every drop count in section 5, because directives swallowed into an over-long stage
were being counted where they did not belong.

The one that moved most is `deformVertexes`, from 2 to **376**. That was never a measurement: it is
only ever written at shader level and the counter only ever read stages, so the two it found were
two the brace bug had misfiled. It is the largest single category of dropped geometry animation in
the set -- every flame that flickered, every banner that waved, every sprite that turned to face the
camera -- and the report had it at two. The tokens on a shared brace line are still dropped, because
splitting them needs the per-directive arities this reader deliberately does not have; they are now
warned about instead of being silent.

---

**Two rules came out of the fix rather than going into it, and both are Q3's own.**

*Which stage is the albedo* used to be "the first one that is opaque or `filter`". On
`textures/base_light/xlight5` that is a `tcGen environment` reflection pass, so the light rendered
as a picture of an environment map; on the three CTF flags it is a chrome envmap or an electric-zap
overlay, so none of the flags was its own texture. The port now ranks candidates with
`VertexLightingCollapse`'s weights -- `-5` for a `tcGen` that is not the texture's own, `-5` for any
`tcMod`, `-3` for a non-identity `rgbGen`, earliest wins ties -- which is Q3 answering exactly this
question when it drops to vertex lighting: if only one of these passes can be drawn, which one
carries the surface? Eight shipping materials change, and every one of them changes to the image a
person would have picked.

*Which additive pass is a glow* needed a discriminator, because Q3 draws a weapon skin twice --
diffuse, then additively at a specular coefficient -- and that second pass has exactly the shape of
a glow map. `RB_CalcSpecularAlpha` computes the coefficient from the scene's lights, so it is
shading, and a PBR material shades. An additive pass whose `rgbGen`/`alphaGen` is a `lighting*`
form, or whose `tcGen` is `environment`, is therefore *not* promoted -- unless it is the whole
shader, at which point the surface is an effect, its colour has to come from somewhere, and emitted
is the only place left. Without that rule the fix lit up the railgun, the BFG, the gauntlet, the
plasma gun and both armours like lamps.

**What it comes to.** Across the six converted maps and the model bundle: no material is left
without an albedo image (was 2 on the maps, 27 on the models); 20 map materials and 18 model
materials are blended where 21 and 1 were before, and the ones that changed are beams, flames,
water, fog, glass and every powerup shell; 3 map materials and 7 model materials are alpha-tested,
which is the grates, the flags, the gib membranes and the machinegun's iron sight and nothing else.
`textures/liquids/lavahell` is opaque again, and `textures/common/portal` -- which had been drawing
as a solid black wall, because `invisible.tga` is 128x128 of alpha zero -- is invisible.

**What is still wrong, named rather than left to be found.** `models/weapons2/bfg/bfgtube` is a
`blendFunc blend` stage whose translucency came entirely from an `alphaGen wave inversesawtooth`;
the image is opaque, the wave is dropped, and the tube draws solid. `alphaFunc LT128` -- draw where
the image is *more* transparent -- is an inverted test a cutoff cannot express, and is recorded as a
drop rather than mapped onto its own opposite. `alphaCutoff` survives in the bundles for the glTF
character path and is inert for maps and models, because meep alpha-tests stochastically against
blue noise rather than against a threshold. `GL_DST_COLOR GL_ONE` is treated as plain additive,
which over-brightens where the destination is dark; the only shipping surfaces are two pools of
water. And `E:/projects/oa/newtele/Circle` is a shader name that OpenArena shipped -- an absolute
path off an artist's machine that no file answers to. It is the one material in the whole set with
no texture at all, and it is named in `materials.test.ts` so that a *second* one would fail.

**How this was checked, and the one link that was not.** `test/materials.test.ts` is new and it is
the point of the exercise: the existing suite was green before this change and green after it, so
the first job was a suite that would have been red. Thirteen of its rule cases fail against the old
projection, verified by reverting the four pipeline files and re-running. The rules are asserted on
shader text written out in the test -- every case a real OA shader cut down to the smallest thing
that still has the property -- and the invariants on the bundles the pipeline actually wrote: every
material resolves an albedo image, no blended material's albedo is fully opaque, no opaque
material's albedo carries alpha for meep to divide by. The runtime half was checked by building the
materials in the browser and reading back what reached `StandardShadeMaterial`: nine materials on
`oa_dm1` are transparent or emissive, all nine have an albedo texture bound, and none of them
reaches the OIT pass at `surface_alpha` 1 for want of one.

Not checked: the pixels. The preview pane was not displayed for this session, so the page never
composited -- `requestAnimationFrame` fired **zero** times in 1.5 seconds of waiting -- and D-015
exists because this project has already shipped two wrong fixes on the strength of screenshots taken
through that channel. Everything above is bundle-level and runtime-object-level evidence, and the
frame that would confirm it is one screenshot away for anyone with the window open.

*It was, and the frame found a seventh -- the one all six of these had been hiding. See D-084.*

### D-084: Every texture in the game was upside down, and only one surface could say so

The maintainer, looking at what D-083 produced: *"that fixture at the top... it gained
transparency, but it looks almost inverted, getting more opaque towards the bottom. I think it's
supposed to model a light beam."*

It is a light beam -- `textures/sfx/beam` on `oa_dm1`, four faces of a 12 x 3 x 3.5 m volume hanging
off the ceiling fixture -- and it was inverted. Not by the restatement, which was right: `beam.jpg`
is bright for the top third of the image and black for the other two thirds, and
`beam.add.png` carries exactly that as coverage, 134 falling to 0. The gradient was landing on the
wrong end of the shaft.

**`pushVertex` had been storing `1 - t` since phase 1, and that is a mirror rather than a
translation.** Both conventions put coordinate zero on the image's *top* row:

- Q3's loaders normalise to top-row-first before upload. `R_LoadTGA` reads a bottom-origin file and
  writes its rows backwards into the buffer -- `for(row=rows-1; row>=0; row--)` -- and refuses to
  flip a top-down one, warning instead. `R_LoadJPG` takes libjpeg's scanlines in order, and libjpeg
  emits the top one first. Then `glTexImage2D` puts buffer row 0 at `t = 0`.
- glTF says it outright: (0, 0) is the upper-left corner of the image. meep's loader passes
  `TEXCOORD_0` through untouched, there is no flip anywhere in its material path, and
  `resample_cube_to_octahedral` states the same premise in a docblock: *a decoded image's first row
  is its top*.

So the two agree, and `1 - t` mirrors every surface in the game vertically.

**Measured rather than argued, because the argument had already been lost once.** Of the vertical
wall faces in `oa_dm1`, `aggressor` and `am_thornish`, **2,216 have Q3's `t` falling as world z
rises and 100 have it rising** -- Q3 puts an image's top row at the top of a wall, and the hundred
are mappers mirroring a face on purpose. The flip was putting the top row at the bottom on all of
them.

**Why six phases of looking at the thing did not catch it.** A mirrored brick wall is a brick wall.
A mirrored floor tile is a floor tile. The OA texture set is overwhelmingly tiling masonry, metal
plate and trim, and vertical mirror symmetry is close to free in that material. The surfaces where
it is *not* free are the ones whose gradient means something -- and the only such surface in
`oa_dm1` is the light shaft, which until D-083 was drawing as a solid white box and therefore had
no gradient to be wrong about. Fixing the transparency is what made the mirror visible: the second
bug was hiding behind the first, the same way the decal fade hid the decal textures in D-079.

**What it changes.** Every texture on every map, every static prop and every character skin, plus
the lightmap UV set, which nothing reads yet (GAP-006) and which was mirrored the same way. Nothing
in the geometry, the winding or the normals: a UV flip is independent of all three, which is why
this was never going to show up as a physics or lighting discrepancy.

`materials.test.ts` asserts it two ways, and both fail against the old flip. The specific one is the
shaft: the ceiling end of `textures/sfx/beam` is `V = 0`, and -- read through the restated image
rather than off the UV alone, so that rewriting the gradient cannot quietly satisfy it -- the
coverage at the lamp is at least 32/255 higher than at the floor. The general one is the wall
convention: on each of the three maps, the vertical faces whose V is smallest at the top have to
outnumber the mirrored ones, which a whole-set flip inverts rather than nudges. `oa_dm1` runs 1,221
against 42.

`torch.md3` is the MD3 half of the same check and is the reason the model and character converters
were changed too: a straight vertical prop with a plain wrap, `corr(model z, t) = -1.00`. The other
props are irregular unwraps and correlate weakly in the same direction, which is what an irregular
unwrap should do and is not evidence on its own.

### D-085: The light fixtures were dimmer than what they lit, because the emissive was in no unit

The maintainer, with a screenshot of a wall light: *"there are for example these light fixtures,
that should probably have emissiveness, but don't appear to have it."*

They had it. `base_light/ceil1_38` was emitting **0.3**, and the wall it was lighting sat at
several. So the fixture was there, bound, and darker than its own pool of light.

**meep adds `material.emissive` straight into the shading result** --
`outgoing_light = reflected_light.diffuse + reflected_light.specular + total_emissive_radiance`,
in `chunk_shade_standard_material_direct` and in both OIT forward variants. The diffuse term on
the other side of that `+` is computed from lights whose intensity is candela, over a scene
authored in metres. So `emissive` is a **luminance**, in cd/m2, and the port was filling it with
`q3map_surfacelight / 1000`, capped at 8 -- a number in no unit at all, arrived at by asking what
looked reasonable in a range that was never the range.

Measured against the port's own lighting: the maps run 8.7 to 57.6 lux at the places a player
stands (D-078), which through a Q3 texture's albedo puts an ordinary lit wall at roughly 1 to 6
cd/m2. Eleven of the fourteen declared emitters in the shipping set were below that. A light
fixture cannot be dimmer than the wall it illuminates, and that is a statement about physics
rather than about taste, which is what made it fixable rather than tunable.

**The port already decides how much light comes out of these surfaces.** `q3map_surfacelight` is
passed through as lumens, one cluster's worth per fixture (D-012, D-078). A Lambertian emitter
radiating flux F over area A has luminance `F / (pi * A)`, so the fixture's face has a right answer
derived from the light already placed on it. Emissive and point light stop being two unrelated
guesses and become two views of one emission.

Areas are summed from the triangles rather than from the bounding-box proxy `recordLightSample`
uses for placement, because this one *divides* a flux and a factor of two in the area is a factor
of two in how bright the fixture looks.

| | before | after |
|---|---:|---:|
| `base_light/ceil1_38` (oa_dm1) | 0.3 | **95.5** |
| `gothic_light/skulllight01` (oa_dm4) | 0.3 | **111.6** |
| `gothic_light/ironcrosslt2_20000` (oa_dm4) | 8 | **1,591** |
| `evil8_lights/evil8_rlight` (aggressor) | 0.95 | **1,122** |
| `base_light/light5_15k` (am_thornish) | 8 | **9,549** |
| `sfx/flame2`, a torch (oa_dm1) | 3.787 | **5,963** |

The right-hand column is conservative against the real world, which is the sign worth having that
nothing here is inflated: the diffuser of an office ceiling panel runs 2,000 to 8,000 cd/m2, and
`ceil1_38` lands at 96. Where a value is still low -- `bubctf1/e8_launchpad1` at 2.2, `lavahell` at
5.6 -- it is low because the port's *light* reconstruction gave that surface very little flux for
its area, and the two now say the same thing. That is D-078's calibration to revisit, not this one.

**The undeclared case keeps a placeholder, and it is now labelled as one.** A beam, a flame or a
powerup shell with an additive pass and no `q3map_surfacelight` carries no photometric information
at all; Q3 drew it at full strength into an LDR framebuffer, which says "about as bright as a fully
lit wall" and nothing more precise. One cd/m2 is the bottom of the 1-to-6 band this port's own lit
surfaces occupy, and `shader-to-pbr.ts` now says that in those words instead of dividing a
light-compiler directive by a thousand.

**`emissiveIntensity` is `emissiveLuminance` throughout.** The old name is most of why the old
value survived: an "intensity" invites a 0-to-1 reading and there is nothing to check it against,
where a luminance has a unit and can be wrong.

**What was checked, and the risk that was not.** `materials.test.ts` asserts the derivation rather
than the numbers: a material's luminance divided by one cluster's worth over its own area has to
come back a whole number -- the count of fixtures the light pass gave it -- which no divisor
satisfies by accident. Eleven of its thirteen cases fail against the old formula, and the two that
pass are `oa_dm5`, which has no `q3map_surfacelight` anywhere and lights entirely from the grid.
A second check refuses to let any declared emitter sit below the undeclared placeholder.

The risk that cannot be checked from here is exposure. The renderer is HDR with histogram
auto-exposure and ACES, so these values do not clip -- the emissive G-buffer is RGBE9995 and
saturates at 65,408 cd/m2, comfortably above the highest of them -- and the metering reads the
70th to 95th percentile of screen luminance, so a small bright fixture falls in the excluded top
five per cent rather than dragging the whole frame down. That is an argument from the shader
source, not from a frame: a wall of lights filling the view would still stop the aperture down,
which is what a camera does and may not be what a Quake III level wants.

### D-087: A Q3 flame is not lit, and the port was lighting it

The maintainer, on `oa_dm5`: *"the torches are a bit meh, not bright enough for sure."*

D-085 had just put every *declared* emitter on a photometric footing, and this torch is not one.
`textures/acc_dm5/flame` declares nothing -- no `q3map_surfacelight`, because `oa_dm5`'s author lit
the map with `light` entities that q3map2 then stripped (Q-006). It is two plain `blendFunc blend`
stages of a fire texture, and the port was giving it an albedo, no emissive, and the room's own
lighting. A torch shaded by the light it is supposed to be casting.

**Q3 lights a surface in one of three ways and the third is "not at all".** `FinishShader` tracks
`hasLightmapStage` for exactly that reason:

- a stage of `$lightmap` modulates the surface by the baked light;
- `rgbGen lightingDiffuse` / `alphaGen lightingSpecular` shade it dynamically, which is how models
  are drawn;
- **neither** means `identityLighting` -- the texture at its own brightness, whatever the room is
  doing.

Nineteen of the 162 shipping map materials are the third kind and every one is an effect: flames,
beams, waterfalls, fog, portals, lava. Thirty-one of the model materials are, and they are the
powerup shells, the auras, and eleven ammo boxes that OpenArena deliberately draws fullbright so a
pickup is findable in a dark corner. Nothing else -- no wall, no weapon body, no character.

A renderer that shades everything from photometric lights has exactly one way to say "not shaded",
which is to emit it. So an unlit surface now emits its own texture.

**`tcGen environment` had to join the test, and finding out why is the useful part.** The first
version asked only about `$lightmap` and `rgbGen lighting*`, and it made 54 model materials emit
instead of 31 -- the extra 23 being the chrome shells on the health pickups, the domination point
skins and the rune icons, all of which are `tcGen environment`. An environment pass *is* shaded by
the scene; it samples the surroundings. It is the same distinction `isShadedPass` already drew for
deciding which additive passes are glow maps and which are 1999's fake specular (D-083), so the two
now share one predicate rather than disagreeing about the same shaders.

A `filter` albedo is the other exception. A multiply subtracts light rather than adding it, so
`textures/sfx/xnotsodensegreyfog` emitting its own grey would be a lamp in the shape of a cloud.

**How bright is "unlit"?** This is the number D-085 left as an admitted placeholder of 1 cd/m2, and
there is a better one available. A lightgrid byte is `LUX_PER_BYTE` lux and a byte holds 255, so 51
lux is the most illumination this port's calibration admits anywhere; a Lambertian surface under it
reflects `51 / pi` times its albedo. An unlit surface emits what a fully lit one of the same texture
would reflect -- which is Q3's own equivalence, since an unlit stage and a lightmapped stage at full
white draw the same pixel. That is **16.2 cd/m2**, against the 1 to 6 an ordinary lit wall runs on
these maps, so a torch is three to sixteen times brighter than the room it is in.

`LUX_PER_BYTE` moved from `convert-map.ts` to `lightgrid.ts` to make that one definition rather than
two. It is the lightgrid's own unit and it now lives with the lightgrid.

**A surface can be both declared and unlit, and lava is.** The two say different things: "Q3 drew
this without shading it" is a floor on how it looks, and "the port credits it with F lumens over
area A" is a floor on how it looks given what it emits. Neither is an upper bound, so the larger
wins. That keeps `sfx/flame2` at the 5,963 cd/m2 its own 3,787 lumens imply, and stops `lavahell` --
666 lumens spread over 38 square metres, which works out at 5.6 -- from being dimmer than an
ordinary unlit texture.

**What is approximated and not hidden.** An unlit blended surface still has its albedo bound and
therefore still picks up a little diffuse on top of what it emits. Writing a black-albedo variant
the way the additive path does would remove it exactly, at one more file per material; against an
emissive of 16.2 in a room of 1 to 6, the double count is under a third and it did not seem worth
six more textures. The eleven fullbright ammo boxes are faithful to Q3 and will still look odd to
anyone expecting a modern renderer to shade a crate.

`materials.test.ts` covers the rule on shader text -- the flame gets an emissive, a lightmapped wall
does not, a fog brush does not, and an implicit texture is never unlit -- and the flame case fails
against the version without it.

### D-086: One dead flag, two symptoms, and a day spent looking for the second bug

The maintainer: *"The pickups are static, they are not moving, and I assume they are supposed to.
Also, walking through these does nothing, no sound, no visible stat change, the object doesn't
disappear either."*

Three complaints, and the natural reading is two or three faults: something wrong with the
animation, something wrong with the touch test, something wrong with the audio. It is one fault,
and the reason it presents as three is worth more than the fix.

**`ItemsView` hid a collected pickup by clearing `ShadedGeometryFlags.Visible`**, whose entire
docblock reads *"If set to false will not render"*. The flag is read by nothing in the engine --
two references in 5,953 files, both of them in `ShadedGeometry.js`, one a default and one an
equality mask, neither a renderer. Visibility in Shade is *membership*: `ShadedGeometrySystem3.link`
adds a `Mesh` to the scene and `unlink` removes it, and `Node3D` has no visible bit at all. Filed
as BUG-10.

So a collected item stayed on screen. And **the same `present` flag that failed to hide it also
stops it animating** -- `update` does `if (!item.present) continue` before the spin and the bob,
correctly, because there is no point animating something nobody can see. With the hiding broken,
that `continue` became the second symptom: the pickup froze in place instead of vanishing.

The third symptom is not a symptom. Walking through *did* pick the item up: the armour went up, the
event fired, the sound played. It just did not look like it, because the thing on the floor did not
move and did not go away -- and a second pass over it a moment later genuinely does nothing, because
it has already been taken and has 25 seconds of respawn to sit out.

**How it was actually found, which is the part worth keeping.** Three sessions of reasoning got the
mechanism wrong twice. The first theory was an exception mid-frame -- meep's `Signal.dispatch`
swallows handler exceptions into a `console.error`, so a throw in the app's one tick handler
silently deletes every line below it, and `player.update` is the first line while `items.update` is
the sixth. That is a real hazard and it is now guarded, one named phase at a time, but it was not
this. The second theory was the renderer not following the transform. Also wrong: 53 of 93 scene
nodes on `oa_dm1` move every frame.

What settled it was one line of data from the maintainer's own session:

```
{ map: 'oa_dm1', clockAdvanced: 1, meshesMoving: 25,
  nearestItem: 'item_armor_shard', nearestDistance: 12, nearestPresent: false }
```

`nearestPresent: false` at a distance of 12 units, with the shard still visible on screen. The
simulation said the item was gone; the screen disagreed. Every earlier theory had been about the
frame not running, and the frame was running fine -- 25 meshes moving proves it. The bug was in the
one place neither of us had instrumented, which is the sentence that connects the two.

**The fix** is to take the `ShadedGeometry` component off the entity and put the same instance back
on respawn. `link` reuses the `Geometry` and the `ShadeMaterial` it is handed, and the meshlet build
belongs to `ModelLibrary` and is shared across every copy of a model, so nothing is re-derived: the
cost of a pickup is one `Mesh`, three signal bindings and a scene insert, twice per respawn cycle.
The old docblock rejected "destroying and rebuilding the entity" on exactly that ground and was
right to; it is the *entity* that is expensive to rebuild, not the component's membership of it.
The entity stays, so the `Transform` survives the hidden interval and the item reappears where it
was rather than at the origin.

**`test/items-view.test.ts` is new**, and it exists because neither half of this was visible to
anything that already ran. `items.test.ts` tests the simulation and is right not to know about
meshes -- it would have said, correctly, that the pickup worked. A screenshot cannot tell a
stationary pickup from a pickup. What was missing was a test of the layer in between: what the view
does to the scene graph when the simulation says an item has gone. Two of its six cases fail against
the flag; the other four pin the spin period, the health-item double rate and the per-entity bob
offset, which are the things the maintainer asked about and which nothing had asserted either.

**Also from this, and unrelated to the cause.** meep's `Signal.dispatch` swallowing handler
exceptions means one throw in this application's single tick listener silently deletes the rest of
the frame for the remainder of the session, with the player still walking because `player.update` is
the first line. The frame is now nine named phases -- player, view weapon, arena, audio, items, bots,
mortality, player audio, movers -- each reported once by name if it throws, with the phases after it
still running. It was written to diagnose this and did not, which is a fair description of most
instrumentation; it stays because the failure it guards against is real, silent, and would present
as almost exactly what was reported here.

### D-088: The same dead flag, in the file nobody re-checked

The maintainer: *"When I switch weapons, the previously held weapon's model gets left behind in
the world. When I switch back to that weapon it gets teleported into my hand."*

This is D-086 again, in `ViewWeapon` instead of `ItemsView`, and it is worth its own entry only
because of what it says about how the first fix was done.

`ViewWeapon` put a weapon away with `geometry.writeFlag(ShadedGeometryFlags.Visible, false)`. That
flag is documented as *"If set to false will not render"* and is read by nothing in the engine
(BUG-10). So the weapon you switched away from stayed in the scene. And because `update` writes the
transform of the *held* weapon only, the abandoned one stopped moving at the pose it was last drawn
at -- half a metre in front of where the player's eye happened to be -- and hung there. Selecting it
again resumed the writes, and it crossed the map in one frame. Two complaints, one cause, and the
second is the first seen from the other side: it was never teleported *in*, it was left *out*.

**The fix is D-086's.** Visibility in Shade is membership, so `show` adds the `ShadedGeometry` back
to its entity and removes it again, and the entity and its `Transform` outlive the hidden interval
so a weapon is still built once and kept. The one addition is ordering: `update` now places the
weapon *before* it hands it to the scene. `ShadedGeometrySystem3.link` copies the transform onto its
`Mesh` as its last act, so showing first would link at a stale pose -- or, for a weapon being drawn
for the very first time, at the world origin -- and then correct it on the next transform signal.
Nothing renders in between, so this buys one redundant placement rather than a visible frame; the
reason to write it that way round is that the other order is only correct by accident of when the
tick runs, which is the mistake D-081 already made once in this file.

**What this actually costs, and why the entry exists.** When BUG-10 was found, `ItemsView` was
fixed, the flag was filed, the report was written, a test was added, and the search that proved the
flag dead -- *"two references in 5,953 files"* -- was run against the **engine's** tree. BUG-10 even
quotes the command, `grep -rn "ShadedGeometryFlags.Visible" src/`, and that `src/` is
`node_modules/@woosh/meep-engine/src`. The same line against *this* `src/` was never typed. It would
have returned two more hits, both in `ViewWeapon.ts`, and closed both bugs in one commit. It was not run, because
the bug had been explained and explaining a bug feels like finishing it.

So the rule this leaves behind is narrow and mechanical: **when a dependency's API turns out not to
work, grep your own tree for the other callers before writing the fix up.** The write-up is what
makes it feel closed, and it is the last moment anyone will look.

There were exactly two callers, and the second was reported the same day the first was fixed -- in
the next session, by the maintainer, before anything else had been touched. It had been drawing a
rocket launcher hanging in mid-air on `oa_dm1` since it shipped in phase 4, and nothing said so,
including the test file whose subject it was: `first-person.test.ts` owns the gun's arithmetic and
passed throughout, correctly, because every number the gun is placed with is right.
Which entities carry a mesh is a different question, and `test/view-weapon.test.ts` is where it is
now asked -- six of its seven cases fail against the flag.

**What the rule turned up when it was actually applied.** `ShadedGeometryFlags.DeferredBoundsUpdate`
is set by three files here -- `ItemsView`, `ViewWeapon`, `loadMap` -- each with a comment saying it
is the case the flag exists for. On this render path it does nothing. The flag is read in exactly
one place, `ShadedGeometry.updateTransform`, which parks the component in a `DeferredBoundsQueue`
that something has to have handed it via `bindBoundsQueue`; `bindBoundsQueue` is defined and called
by nothing in 5,947 files. Its own docblock says `@see ShadedGeometrySystem.flushBoundsUpdates`, and
there is no `ShadedGeometrySystem` in the package -- only `ShadedGeometrySystem3`, which owns no BVH,
binds no queue, and never subscribes `updateTransform` at all. So the flag is inert rather than
wrong, the measured numbers in its docblock presumably belong to the mesh-v2 BVH path this port does
not use, and setting it costs one `|=`.

**The flag is left alone** and no code changed for it. It is free, it is right if this port ever
moves onto that path, and unpicking three files to remove a no-op is the sort of churn that makes a
bug fix hard to read. It is written down because the entry above is an argument for grepping your
own tree, and the first thing that grep found was a second flag in the same enum making a promise
the shipping path does not keep. Worth filing against 3.2.0 alongside BUG-10 -- a docblock citing a
class the package does not contain is the same defect as a flag no renderer reads -- but that is the
maintainer's call and not this commit's.

**Not fixed here, and named so it is not mistaken for an oversight.** A weapon whose model converts
but whose hands tag does not resolve re-runs `library.components()` every frame and drops the
`ShadedGeometry` instances it allocates. It is unreachable unless the asset pipeline has not been
run at all (`CG_RegisterWeapon`'s fallback to `shotgun_hand.md3` catches every real case), it
allocates garbage rather than leaking, and `acquire`'s own de-duplication of the `unmodelled` list
shows the path was always known to repeat. It is a separate, smaller thing than the bug that was
reported.

---

## Phase 8 — surface materials

### D-089: The material slots go through the pipeline before there is anything to put in them

`PbrMaterial` gains `normal` and `orm`, `texture-out.ts` gains `writeDerivedTexture`, the three
converters emit the references, and `bundle.ts` binds `texture_normal` and `texture_orm`. Nothing
it produces is different yet: `assets/generated/materials/` is empty, so re-running
`convert-models.ts` against it gives a byte-identical `models.bin`, an identical texture table, an
identical model table, and materials that differ only by the two new fields, both `null`.

That is the point. The plumbing and the images are independent problems and the plumbing is the
one with a definite answer, so it lands first, green, and changes nothing. When step 3 writes the
first normal map, converting the map picks it up and binds it with nothing further to change.

**A material names what it is owed; the texture table says what exists.** Those are different
questions and conflating them was the first version of this. A `null` in a bundle's texture table
has always meant "the shader named this image and it is not on disk" -- worth recording, because it
is a conversion failure. A generated map that has not been produced yet is not a failure, so it
gets no entry at all, and the material keeps its `<path>#normal` key regardless. `buildMaterials`
reads an unresolved key as no texture, so the runtime behaviour is identical either way, and
`scene.json` gains a record of which surfaces are in scope that step 4's check can read.

**Three things in it were not obvious.**

*A generated map is keyed by the image, not by the texture key.* The bundles have keyed textures by
path *plus Q3 blend* since D-083, because one image referenced through two blends is two files. A
normal map is not: `blocks10` referenced once opaque and once through a filter is one stone wall
and wants one normal map. So `derivedTextureKey` takes a virtual path where `textureKey` takes a
path and a blend, and a bundle's texture table holds both kinds of key side by side, which is safe
because no `ImageBlend` is called `normal` or `orm`.

*The factors stop being values and become multipliers.* meep's g-buffer pass computes
`orm_sample.g * roughness_factor` and `orm_sample.b * metallic_factor`, and with no ORM bound
`orm_sample` is a white default pixel -- so today's `roughness_factor = 0.85` *is* the roughness
only because it is being multiplied by one. Bind an ORM without changing them and every metal in
the map is multiplied back to a dielectric by `metallic_factor = 0`, and every measured roughness
is scaled by 0.85 for no reason anyone could later reconstruct. So both go to 1 exactly when an
ORM is present, and `shader-to-pbr.ts`'s numbers stay in charge when it is not.

*The R channel is written at 1.0 and not at an occlusion.* meep runs GTAO, which samples the
g-buffer *shading* normal -- the one the normal map has already perturbed -- so occlusion follows
the normal map for free and a baked AO channel would double up with it. 1.0 is also what the
default pixel holds, so `ambient_factors` sees exactly what it saw before.

**What is in scope, mechanically.** A material is owed both maps when it has an albedo and is not
sky, not nodraw, not unlit, and not blended. Over the six built maps that is **108 of 128** world
materials, which is exactly the number the phase was planned against.

Props and characters are not exact: 62 of 93 and 34 of 41 here, against 74 and 41 in the planning
note. The 19-material difference is very close to the unlit exclusion on those two groups -- 16
props and, with the four blended characters, most of the rest -- so the likely explanation is that
the note counted before excluding unlit, and the world figure agrees because a world map has few
unlit surfaces that survive to a bundle. That is a plausible reconciliation and not a demonstrated
one, and it is recorded as such rather than tidied into agreement: the rule is the rule either way,
and `test/materials.test.ts` pins 128 and 108 so that a change to it which halves the job is a
failing test rather than a quiet saving.

**The plan's other number reconciles exactly, and is worth stating because it looks like it does
not.** "93 of 93 materials on `oa_dm1`" is a live-engine count and `oa_dm1`'s bundle holds 31
materials. The other 62 are the static props, which are loaded into the same scene from the model
bundle. 31 + 62 = 93.

### D-090: Cosmos DiffusionRenderer only works at 1280x704, and fails silently everywhere else

The model card gives the input resolution as 704x1280 and the DiT accepts anything up to 1920 on a
side, so the first attempt fed it square textures at whatever size was convenient. Every one of
them came back wrong, and none came back *obviously* wrong -- no error, no warning, and each
output a plausible-looking image.

`gothic_block/blocks10`, basecolor and roughness, 15 steps, seed 1000:

| framing | basecolor mean | roughness mean | what it looked like |
|---|---|---|---|
| 704x704 | (5, 6, 6) | (0.3, 0.2, 0.3) | black, with faint mortar lines |
| 1280x1280 | (188, 127, 52) | (115, 66, 33) | orange blur |
| 1536x1536, 3x3 tiled | (231, 91, 7) | (234, 109, 39) | orange blur |
| **1280x704** | (79, 78, 73) | (82.5, 83.4, 83.7) | structured stone, grey mortar |

The tell is the **roughness pass going coloured**. Roughness is a scalar; the model emits it as an
RGB image and every correct output is achromatic to within a unit or two. At 1536 square it came
back (234, 109, 39), which is not a bad roughness map, it is not a roughness map at all. Anything
grading these outputs should check that before it checks anything else.

It is the aspect ratio and not the environment: the same checkpoint, in the same shimmed install,
produces well-behaved G-buffers on the repo's own 1280x704 example photographs.

**So every texture is presented inside one 1280x704 frame**, and the only question left is how.
`wrap`/`mirror` tiles the texture across the frame at its own pixel scale and keeps one interior
copy; `fit` resamples one copy to fill the frame. Tiling has no resampling and no distortion in it,
and it is also the answer to the tiling risk, because every texel of the kept copy has real
neighbourhood on all four sides. D-092 measures the two against each other.

### D-091: Transformer Engine is reimplemented rather than installed, because it is three functions

Cosmos-Predict1 states it runs on Linux only. Nearly all of that is
`transformer-engine[pytorch]==1.12.0`, which builds against CUDA with a toolchain that has no
Windows equivalent, and this port is developed on Windows with an RTX 4090. The alternatives were
a WSL distribution or a container; both were avoidable, because the dependency turns out to be
very small.

Across `cosmos_predict1/diffusion` -- the whole inference path the renderer takes -- Transformer
Engine is reached for three times, all in `module/attention.py`: `DotProductAttention`,
`apply_rotary_pos_emb`, and `te.pytorch.RMSNorm`. Nothing else in that tree names it.
`tools/cosmos/te_shim/` supplies those three, written from their definitions rather than copied
-- Transformer Engine is Apache-2.0, which does not travel into a GPLv2 tree -- plus a handful of
import-time stubs that raise if anything ever constructs one.

**The Cosmos source is used exactly as fetched.** No patch, no vendoring, nothing to re-apply the
next time it is cloned. `PYTHONPATH` puts the shim first and the import resolves.

Two details were load-bearing and neither would have failed loudly:

- **The RMSNorm parameter has to be called `weight`.** Cosmos builds these inside `nn.Sequential`s
  and loads a 7B checkpoint over the result by name. A parameter called anything else does not
  error -- it arrives as a missing key, keeps its all-ones initialisation, and the model runs with
  its QK normalisation silently disabled.
- **The rotary embedding's half-split has to match the frequency layout.** Cosmos builds its
  frequencies as three axis blocks repeated twice, which is the contiguous-halves convention:
  channel `i` pairs with channel `i + d/2`. Pairing adjacent channels instead still produces
  output, and the output still looks like a G-buffer.

There is no real Transformer Engine here to differential-test against, so
`tools/cosmos/check_shim.py` checks each piece against a property written a different way from the
implementation: RMSNorm against an elementwise restatement and against scale invariance, the
rotary embedding against norm preservation, additive composition, identity at zero and an explicit
2-vector rotation, and the attention against an explicit per-head softmax. Twelve checks, all
passing. The end-to-end evidence is the control run: the same install produces good G-buffers on
the upstream example photographs.

`megatron-core` is also on the path and also does not install on Windows, for two unrelated
reasons -- its sdist contains a directory named `pytorch:24.07`, which NTFS will not create, and
its `setup.py` shells out to `python3` to build a training-only C++ extension. Both are worked
around at install time rather than in this repository.

### D-092: The per-channel verdict, and the round trip that had to be rebuilt to give one

Eight textures, both framings, four passes each. The exit criterion for the pilot was a per-channel
verdict backed by a round-trip error, and the first version of that error measured nothing.

**Why the obvious round trip is useless.** Relight the extracted maps and compare against the
original -- and the material the port ships today scores an RMSE of exactly **zero**, on every
texture. It has to. On a flat quad with one fitted light, a material whose albedo *is* the texture
reproduces the texture: the fit sets the light to nothing and the ambient to one. The placeholder
is a perfect round trip precisely because it has not decomposed anything, so "does it reproduce
the original" cannot separate a good decomposition from no decomposition.

What separates them is the *shape* of the error across an ablation. The network's albedo has had
the painted shading taken out of it, so on its own it cannot reproduce the source, and how badly it
fails measures how much was removed. Everything added after it has to put that shading back out of
geometry and surface rather than out of paint. So the number is **recovery** --
`(rmse[albedo] - rmse[full]) / rmse[albedo]` -- the fraction of the de-lighting the other channels
explain. It also catches invented detail from the same side: detail with no counterpart in the
source cannot reduce the residual.

**Per-channel contribution to recovery**, wrap/mirror framing, RMSE in 8-bit units:

| texture | albedo | +normal | +roughness | full | normal | roughness | metal |
|---|---:|---:|---:|---:|---:|---:|---:|
| `gothic_block/blocks10` | 9.29 | 6.93 | 7.16 | 7.59 | **+25.4%** | -2.5% | -4.6% |
| `acc_dm3/rivets` | 24.70 | 24.71 | 24.71 | 24.40 | -0.1% | +0.0% | +1.3% |
| `acc_dm3/cop` | 18.56 | 17.81 | 17.78 | 30.78 | +4.0% | +0.2% | **-70.1%** |
| `e7/e7brnmetal` | 3.22 | 3.01 | 2.53 | 2.51 | +6.5% | +15.0% | +0.7% |
| `weapons2/railgun/skin` | 27.26 | 26.27 | 26.37 | 38.93 | +3.6% | -0.4% | **-46.1%** |
| `weapons2/shotgun` | 20.84 | 20.59 | 20.70 | 25.49 | +1.2% | -0.5% | **-23.0%** |
| `powerups/redarmor` | 14.61 | 13.15 | 13.16 | 13.16 | +10.0% | -0.0% | -0.0% |
| `players/major/torso` | 55.04 | 53.70 | 54.11 | 58.26 | +2.4% | -0.7% | -7.5% |

**`albedo` -- keep, with a correction, and the correction is not optional.**

Every de-lit albedo came back brighter and *greyer* than its source. `blocks10` goes from
(0.23, 0.15, 0.08) to (0.51, 0.49, 0.46) at a chroma of 0.019: a brown stone wall returns as light
grey stone. The model is trained on photographs, where a brown cast over a stone wall usually *is*
the light. On a hand-painted Q3 texture the brown is paint, and it is the only statement anyone
ever made about what the wall is made of.

What the network is nonetheless right about is *where* the shading is, and that is carried entirely
by the ratio of luminances. So `retint()` keeps the ratio and discards the hue shift: the source's
colour at every texel, scaled by how much darker or lighter the network says that texel should be.

It improves the round trip on **16 of 16** runs, by 1% to 58%, median 26%:

| texture | albedo+normal | retinted+normal | chroma, raw -> retinted |
|---|---:|---:|---|
| `gothic_block/blocks10` | 6.93 | **4.36** | 0.019 -> 0.118 |
| `acc_dm3/rivets` | 24.71 | 21.26 | 0.040 -> 0.041 |
| `acc_dm3/cop` | 17.81 | 17.57 | 0.046 -> 0.039 |
| `e7/e7brnmetal` | 3.01 | **1.96** | 0.031 -> 0.013 |
| `weapons2/railgun/skin` | 26.27 | 22.23 | 0.015 -> 0.026 |
| `weapons2/shotgun` | 20.59 | **11.84** | 0.016 -> 0.028 |
| `powerups/redarmor` | 13.15 | 9.67 | 0.163 -> 0.193 |
| `players/major/torso` | 53.70 | **22.41** | 0.026 -> 0.020 |

This is not a way of getting a better de-lighting out of the model. It is a way of using the part
of the answer that survives being out of domain.

**`normal` -- keep, and it is the channel that pays for the phase.**

Positive on 15 of 16 runs and the only channel that consistently is. On the two world textures with
real relief it is worth +25.4% and +4.0%, and visually it is better than the numbers: `blocks10`
comes back with per-block bevels, mortar recesses and surface grain, and `acc_dm3/cop` with the
raised panel geometry cleanly separated from the flat trim.

Two qualifications. `acc_dm3/rivets` came back **inverted** -- a mean tilt of 127.6 degrees, normals
pointing into the surface, the map visibly green rather than blue -- so this fails on some inputs
and the per-texture check has to catch it. And on props and characters the network reads *painted*
shading as geometry: the railgun's normal map contains the barrel's curvature, which the model
already has. That is double-counting, and it is why the prop numbers are +1% to +4% where the world
numbers are +25%.

**`roughness` -- keep-with-correction at best, and it is close to worthless.**

Contribution runs -2.5% to +15.0% and is a median of roughly zero. Worse, it is unstable to the
framing: `blocks10` returns 0.76 under `wrap` and 0.21 under `fit`; `e7brnmetal` returns 0.44 and
0.76; `major/torso` returns 0.31 and 0.77. The maps *look* right -- mortar smoother than block face
-- but nothing in the round trip depends on them being right.

**`metalness` -- author by hand. It is not weak, it is anti-informative.**

The worst numbers in the table are all this channel: -231%, -84%, -70%, -46%, -36%, -26%, -23%. And
the reason is visible in the maps. Given `acc_dm3/cop`, the network returns a hard binary mask of
the *raised panel's shape* -- white on the cross, black around it -- when the panel and the trim are
the same rusted metal. It is segmenting by shape, not by material.

Then it flips with the framing. The same artwork, two layouts:

| texture | metal, tiled | metal, fit |
|---|---:|---:|
| `gothic_block/blocks10` | 0.11 | **0.96** |
| `weapons2/shotgun` | 0.83 | **0.00** |
| `players/major/torso` | 0.99 | **0.00** |
| `powerups/redarmor` | 0.00 | **0.50** |

A stone wall at 96% metal, a character skin at 99% and then 0%. That is not a weak signal; it is no
signal, and it is exactly the case D-092's step 4 table exists for. The plan's prior was "metalness
weakest"; the measurement is worse than the prior.

**Tiling survives, which the plan was not counting on.**

The seam measure is not "how different are the two edges" -- some textures genuinely change across
a tile -- but how much *more* different they are than neighbouring interior column pairs, which is
what the eye reads as a line. Negative means the wrap edges are closer than ordinary neighbours.
8-bit units:

| texture | source | basecolor | normal | roughness | metallic |
|---|---:|---:|---:|---:|---:|
| `gothic_block/blocks10` wrap | -0.82 | -1.22 | -0.88 | -2.63 | 0.28 |
| `gothic_block/blocks10` fit | -0.82 | 2.08 | 1.67 | **21.11** | **28.37** |
| `acc_dm3/rivets` wrap | -2.12 | 0.62 | 4.75 | 0.65 | -1.72 |
| `e7/e7brnmetal` wrap | 0.76 | 0.06 | 0.60 | 0.70 | 1.31 |
| `e7/e7brnmetal` fit | 0.76 | 3.11 | **17.30** | 1.92 | -0.28 |

Tiling the texture across the frame and keeping an interior copy holds the seam to within a unit or
two of what the source itself has. `acc_dm3/cop` is excluded from that reading because its *source*
scores 47.35 -- it is a trim texture and does not wrap continuously in the first place, and the
generated maps come back *less* discontinuous than the artwork.

So the plan's third named risk does not materialise, on the condition that the framing is
`wrap`/`mirror`. `fit` breaks seams by 17 to 89 units as well as everything else it breaks, and is
kept only as the control that made this a measurement.

**What this means for steps 3 and 4.** Albedo and normal ship, with the retint on the first and a
per-texture inversion check on the second. Roughness ships as a hand table, not as an inference --
it costs the same either way and the table cannot return 0.76 and 0.21 for the same wall. Metalness
was always going to be step 4's job and now has a measurement saying so rather than a prior.

### D-093: The material table, and the one property that makes it worth having

`tools/material-classification.json` on the `trap-classification.json` pattern: prefix rules applied
in order over the Q3 texture directories -- which are already named for material families -- plus
per-material entries that win over them, plus `node tools/material-matrix.ts --check` in
`npm run check`. **204 materials, all classified**, 64 of them metal, mean roughness 0.623 against
the 0.85 placeholder it replaces.

**The property that matters is that there is no catch-all.** A default rule would turn every future
omission into a silent 0.85, which is the exact failure this phase exists to end, so
`textures/some_new_map/wall01` classifies as *nothing* and the check fails. That is the plan's exit
criterion stated as a mechanism rather than an intention, and `test/materials.test.ts` asserts it
against three invented names.

**It was authored by looking at the textures, not at their names.** All 204 were rendered into
labelled contact sheets and read. That is the difference between this and the heuristic
`shader-to-pbr.ts:583` argues against, and it caught things a name could not:

- `textures/e8/e8_base1` is a steel hatch and `textures/e8/e8_base1c` is brick. The trailing letter
  is a variant marker, not a suffix on the same material, and the prefix rule reads as if it covers
  both. There is a test for this one because the mistake is invisible in the rule list.
- Sixteen materials are not artwork of a surface at all -- `tcGen environment` fake reflections
  (`BlueDomSkin`, `tinfx`'s neighbours), powerup shells, glyphs on black. They are in scope by the
  mechanical rule, because their shaders are opaque and lit, and they carry `normal: "drop"`.
- **Rust is a dielectric.** Five families are named for corrosion -- `deeprust`, `pitted_rust` and
  its three variants, `acc_dm5/rust` -- and every one of them is `metalness: 0`. Iron oxide is not a
  conductor, and a rusted surface shaded as one reads as a mirror exactly where the paint has
  failed, which is the opposite of what corrosion does. It is the most available mistake in the set
  and it is pinned by a test.

**Roughness is split into a level and a variation.** The table carries the level; the generated ORM
carries the shape around it, scaled by `variation` (0.15 by default). That split is what D-092
measured: the network's roughness is worthless as an absolute -- 0.76 and 0.21 for the same wall
depending on framing -- while the *relative* structure in it, mortar smoother than block face, is
right. Taking one and not the other is the only reading of that measurement that uses it.

**Metalness is one bit, and the bit is per material rather than per texel.** For this asset set that
is not a simplification: two-means clustering over the 182 world and prop candidates put the median
hue separation between cluster centres at 3.6, and the genuine metal-against-dielectric boundaries
are in the weapons, pickups and characters, where they are hard paint edges. `redArmor` and
`yellowArmor` are the deliberate approximations -- both carry grey shoulder spheres on the same
image as a lacquered metal shell -- and the shell is the dominant area.

### D-094: The lighting half of the phase is cut, and the reason is one line the facade does not have

`feature_ssr_enabled` and `indirect_lighting_mode` are properties of `Renderer`.
`GraphicsEngine3` constructs a `Renderer` privately and never hands it out -- deliberately, with a
docblock that names the absence and counts the 44 callers a getter would have had. There is no
other route: a `RenderExtension` is given a `FrameContext` carrying a graph, a view, a phase and a
resolution; `GPUViewContext` exposes a camera and a scene; `EngineHarness.bootstrap` configures the
engine and not the renderer; and no shipped system holds a renderer either. So this port cannot set
either flag, and `brick4_bake_for_scene` takes a renderer as an argument and is unreachable for the
same reason.

GAP-024 has the full argument and the line numbers. What matters here is the decision: **steps 1 to
4 ship and step 5 does not.** The brief's rule is that something which cannot be done with what is
there does not get done, and this is that case rather than a case of it being hard.

**What was checked before concluding it, because "the API does not allow it" is the easiest wrong
answer in a report.** Every `.renderer` reference in the package outside the playground -- 16, none
of them a route. Every system in `engine/graphics3/` -- all go through extensions. `add_extension`,
`scene_context`, `set_environment_map` and `dynamic_resolution`, which are the four things the
facade does forward. `EngineHarness`'s static escape hatches, of which `shadeScene` is the one this
port already uses. The playground, which turns SSR on in one line -- and does it against a
`Renderer` it constructed itself, having never gone near `GraphicsEngine3`.

**There is a route to half of it, and it is not worth taking.** `Renderer` is exported, so this port
could construct a second one, initialise it on an offscreen canvas, hand it the same `Scene` and
bake. What it could not do is *display* the result, because the frame that reaches the screen is
drawn by the renderer inside the facade. Making the second renderer the one that draws means
abandoning `GraphicsEngine3`, and with it every `*System3` this port runs -- shaded geometry,
lights, meshes, decals, particles, animation, all of which take the facade in their constructors.
That is a rewrite of the port's entire rendering integration to reach two boolean settings.

**The phase is still worth having without it.** Steps 1 to 4 were never gated on step 5: 108 world
materials get a normal map and an ORM whose roughness and metalness are real, and those are read by
the deferred pass under the IBL mode the port already runs. What is lost is the indirect specular
that would have made metalness *reflect* something rather than only change its highlight, and the
baked bounce that would have stopped the indoor maps taking their ambient from a procedural sky.
Q-002 and GAP-006 stay open, and now have a second reason.

**Filed rather than worked around, and this is the phase's headline finding for the maintainer.**
3.3.0 added `VolumetricLightMap` -- a component, in the ECS layer, whose entire purpose is to let an
application carry a baked lightmap. Its system's docblock then says, accurately, that uploading one
is "necessary for Brick4 lighting and not sufficient for it", because the setting that makes the
renderer read it is on the other side of a boundary the facade holds for good reasons. Both halves
were designed carefully. The seam between them is where this stopped.

### D-095: The set, generated -- 183 images, 133 normal maps, and 38 refusals with reasons

> **Re-measured 2026-08-26.** The set this decision originally described was destroyed with the
> rest of `assets/` (D-104) and regenerated from scratch. Every number below is the *regenerated*
> set. The generator is seeded (`--seed 1000`) and the deterministic half reproduced exactly --
> 183 images, 171 normals asked for, 537 passes, 204 materials sharing 183 textures, and the whole
> ORM story -- but the diffusion half did not. The differences are called out inline as
> "previously N", and the reasons they moved are in the last section. What the phase *claims* is
> unchanged; several of the numbers it claims it with are not.

537 network passes over **183 unique images**, two and a half hours on the 4090, then assembly.
The count is 183 rather than 204 because the classification is per material and the maps are per
image: 21 materials share a texture with another.

**What shipped:**

| | | |
|---|---:|---|
| images | 183 | same |
| de-lit albedos | 171 | same |
| normal maps kept | **133** of 171 asked for | previously 130 |
| ORMs | 183 | same |

Read out of the live engine on `oa_dm1` with items spawned: **59 materials, 31 with a normal map,
41 with an ORM** (previously 34 with a normal map; the other two are unchanged), `roughness_factor`
1.0 on those 41 and 0.85 on the 18 without, `metallic_factor` 1.0 and 0. Against the sentence this
phase started from -- 93 of 93 at roughness 0.85, metallic 0, no ORM and no normal map -- that is
the placeholder gone from every surface the table had something to say about.

That `oa_dm1` moved *down* by three while the set as a whole moved *up* by three is not a
contradiction: the maps that changed status are not the same maps. On `oa_dm1` the ten materials
that have an ORM and no normal are refused for reasons the report names --
`base_light/xlight5` and `gothic_trim/baseboard10_f` on seams, `clown/light_base` and
`weapons2/grenadel/newgren` as flat, `base_trim/dirty_pewter` inverted at 179.1 degrees, and the
four env-mapped pickups plus `armor/shard` which the table refuses outright.

The ORM says what it was told to say, and this is the part of the phase that re-inferred *without*
moving. R is 1.00 on all 183; G is the table's level with the network's variation around it
(`blocks10` 0.833 +/- 0.102 against a table level of 0.85, `pewter` 0.352 +/- 0.143 against 0.35 --
previously 0.829 +/- 0.098 and 0.352 +/- 0.144); B is 0.00 or 1.00 across the whole set and nothing
between. That the ORM is stable while the normal maps are not is exactly what the design predicts:
G takes only the *shape* of the network's roughness, centred on its own mean and scaled by the
table's `variation`, so a different draw has to disagree about the texture's internal contrast
before it can move the number. The normal map takes the network's answer directly.

**38 normal maps were refused, and the reasons are the interesting part.** The table below is the
whole 183: the first four rows are the 38 refusals out of the 171 asked for, and the last row is
the 12 the table never asked about.

| reason | count | previously | what it means |
|---|---:|---:|---|
| seam | 15 | 17 | wraps visibly worse than the source does |
| flat | 14 | 15 | nothing left once the lean was removed; see below |
| inverted | 5 | 5 | mean tilt over 90 degrees; the average texel faces *into* the surface |
| implausible relief | 4 | 4 | mean tilt 45 to 90 degrees -- not inverted, just not a surface |
| refused by the table | 12 | 12 | effect artwork; see D-093 -- never asked for, so not one of the 38 |

The five inversions include `acc_dm3/rivets` at **172.4 degrees** (previously 126), which is the
failure the pilot found by hand on eight textures. Finding four more of it in 171 is the check
earning its place: one in thirty-four, invisible in a thumbnail, and it would have lit every rivet
from the wrong side. That the count is five both times while the angle moved by forty-six degrees
is the shape of this whole re-measurement: the model disagrees with itself about *how* wrong a map
is, and agrees about *which* maps are wrong.

**The systematic error nobody was looking for: every normal map leaned.**

Across the 171 the network produced, the X channel means average 0.5003 and the Y channel means
average **0.5566** -- 71 maps past 0.55 in Y against 31 in X. That is a whole-map tilt of about six
degrees on average and much more on some: `gothic_floor/q1metal7_99stair` came back leaning 22.9
degrees across a flat stair tread. (Previously 0.4945 and 0.5417, 49 in Y against 16 in X, and that
stair at forty degrees. The lean got *worse* on re-inference, which is the one direction that makes
the correction below matter more rather than less.)

It is the model's own prior showing through, and it is not really its fault. It estimates normals
for photographs of scenes, where surfaces genuinely do tilt away from the camera -- and a photograph
has no tangent frame for the answer to have been relative to. Handing it a texture and reading the
result as tangent-space is this pipeline's interpretation, not the model's claim.

The correction follows from what a texture *is*. A normal map for a texture has to average to the
flat normal, because the surface it will be painted on is what carries the slope, and a Q3 brush is
flat. So the DC is removed from the two tangent components before anything else looks at the map:
median 9.1 degrees taken out, mean 12.8, 22 maps over 20 degrees, one at 70.

It is done *before* the tilt test rather than after, and that reshuffles the refusals rather than
just reducing them. Measured on the regenerated set by running the tilt test both ways: **8** maps
that would have been thrown out as implausible relief were a plausible map with a large offset on
it, and came back (previously 11). **14** turned out to be *nothing but* the offset -- mean tilt
under one degree once centred -- and are now refused as flat, correctly: they were carrying a lean
and no relief at all (previously 15). On the tilt test alone that is 153 maps before centring and
148 after; the seam test then takes it to the 133 that shipped.

The centring is not as tight as it was, and the reason is worth keeping. Subtracting the DC makes
the mean exactly zero, but the renormalise-and-encode after it does not preserve that, and a map
with strong relief clips against 0 and 1. The 133 come out with a **median deviation of 0.0016**
and 88 of them within 0.003 -- but 22 are past 0.01 and `evil8_trim/e8basictrim_blue` is at 0.116.
D-095 previously claimed all 130 within 0.003 on both channels, which is not true of this set and,
given the mechanism, was probably a happier draw rather than a property of the method.

**Two mistakes in the checks themselves, both caught by running them.**

*The seam rule was wrong before it was right.* It refused any map whose seam was more than four
units worse than its source -- and refused `textures/sfx/metalfloor_wall_14b` at a seam of **-1.5**
(previously -0.1), which is edges *closer* than ordinary interior neighbours and no line to see at
all, because its source scores -5.5. That source figure is measured off the extracted texture
rather than off the network, so it is the one number in this section that came back identical, and
it is why the example still holds: the map is still well under the 6-unit visibility floor and
still more than 4 worse than its unusually continuous source. Comparing only against the source
punishes a texture for having been unusually continuous to begin with. The rule now needs the seam
to be both visible in absolute terms and worse than the source, and six units separates the two
framings the pilot measured with room on both sides. Six maps came back.

*"Inverted" was doing two jobs.* Fifteen of the nineteen original refusals were between 45 and 90
degrees, which is not inversion -- it is a normal map describing relief no painted wall has. Both
are refused and the report now says which, because a claim in a report should be the claim that was
tested. (That 15-of-19 was measured on the destroyed set and is left as the history it is. The same
split on the regenerated set, taken before centring so it is the same question, is **13 of 18**:
still the large majority, still not inversion.)

**Two things that only showed up once the maps existed, both in the pipeline rather than the maps.**

*A refused normal map was being counted as a missing texture.* `textureCounts` reads the cache's
`byKey` map and reports every empty entry as a reference that resolved to nothing, which for a Q3
image is a conversion failure worth failing a test over -- the shader named it and it is not there.
A generated map that was refused on purpose is not that, and `presentation.test.ts` failed on all
six maps saying textures were missing while nothing was wrong. The generated maps now memoise
separately.

*Renaming a file left the old one behind.* The de-lit albedo is written as `<name>.delit.png`, and
the converters had always added to `textures/` rather than emptying it -- so turning the de-lighting
on left 33 orphaned albedos in the model bundle beside their replacements, a third of the bundle in
files nothing references. The directory is now cleared per run. That was latent long before this
phase: any change to how a restatement names its output would have done it.

**The level hold does not move the round trip, and that is why it is safe.** `build_albedo` puts the
mean luminance back where the source had it (D-092's measurement was made without that step). A
uniform scale on the albedo is exactly what the fitted light absorbs, so every recovery figure in
D-092 is unchanged by it -- which is the point: it is a change to how the map sits against this
port's photometry, not a change to the decomposition.

**What the forced re-run proved: `--seed 1000` does not make this reproducible, and the checks are
why that is survivable.**

Regenerating the whole set after D-104 was not planned, and it answered a question this phase had
only assumed the answer to. The seed is fixed, the manifest is byte-identical, the model and its
weights never moved, and the second run still produced a *different set of maps*. Not wildly
different -- 133 kept against 130, with the categories of refusal holding to within two -- but
different map by map, and on individual textures the disagreement is large: `acc_dm3/rivets`
inverted at 126 degrees one run and 172.4 the next, `q1metal7_99stair` leaning forty degrees one
run and 22.9 the next. Anything downstream that pinned an exact per-image number to this pipeline
was pinning it to a draw.

The useful part is *which* numbers held. Everything decided by the table, the manifest or the
extracted art came back identical -- 183 images, 171 asked, 12 refused by the table, 204 materials
over 183 textures, 537 passes, R and B in every ORM, and `metalfloor_wall_14b`'s source seam of
-5.5 to the decimal. Everything decided by the network moved. The ORM sits in between and barely
moved, because it only ever takes the network's *shape*.

So the refusal checks are not a filter that happens to run after inference; they are what makes an
unreproducible generator usable at all. The categories are stable to within two out of 171 across
two independent draws, which is the sense in which this pipeline can be said to work: not that it
produces a particular normal map, but that it recognises the same *kinds* of failure whichever map
it is handed. A pipeline whose output is a draw needs its acceptance test to be the reproducible
part, and here it is.

Practically, for whoever regenerates this next: do not expect these counts, expect these
categories, and re-measure rather than re-cite. ASSETS.md's rebuild table now says so too.

---

## Phase 9 — the menu

### D-096: Settings persist through meep's option model, and deliberately not through `engine.options`

The engine has everything a settings screen needs for persistence and assembles it in an order
that puts it out of reach. `Engine` owns an `OptionGroup` at `engine.options`; `Option`
serialises to JSON; `OptionGroup.attachToStorage(key, storage)` loads on attach and saves on
every write; `engine.storage` is an `IndexedDBStorage`. An application should have nothing to
build and nothing to decide.

What it has instead is `Engine.start()`, whose last statement is

```js
await this.options.attachToStorage('lazykitty.komrade.options', this.storage);
```

and `attachToStorage`, which binds the save hook by walking the options that exist at that
moment and never walks again. `EngineHarness.bootstrap()` awaits `start()`. So every option an
application adds is added after the walk: not loaded, not saved, and not reported. On a stock
engine the walk binds **zero** hooks, because nothing in the engine puts anything in that group.

So this port builds an `OptionGroup` of its own, populates it, and attaches it itself under
`queep-3-arena.settings`. Same classes, same storage, right order. GAP-026 has the evidence.

**Two things follow from using meep's `Option` rather than a plain map, and both are worth
having.** `Option.write` is a wrapper that raises `on.written` after the real write returns, and
`attachToStorage` hangs the save hook off exactly that signal — so `Settings` has two entry
points rather than one. A value arriving *through* the option, which is how a loaded value
arrives, is announced by the wrapper; a value arriving from the menu is announced by `Settings`
explicitly. Collapsing the two would either save twice for one change or, in the arrangement
that looks tidier, never save at all: a model that holds its own values and never tells the
option works perfectly for a whole session and remembers nothing. That is the failure
`settings.test.ts` exists to refuse.

The second is `Option.settings`, which is dat.GUI's shape — `{min, max, values}`. The port fills
it in properly even though it draws its own menu, because it is three lines and it means meep's
own `OptionsView` renders these settings correctly if anybody ever wants the debug view.

### D-097: The menu is a shell over a list of pages, and the pages are data

The ask was a menu with graphics settings, and map switching and match setup "later on". The
second half is a statement about shape rather than about scope, so the shape is what this
decides.

A page is a value: `{ id, title, settings, note }`, where a setting is one of three shapes —
slider, toggle, choice — each carrying its own `apply` closure over whatever it configures.
`Menu` takes the list and builds a page list, a content area, sections and rows from it. There
is no page class, no subclassing, and nothing in `Menu.ts` that names "graphics".

So a map picker is `mapsPage(...)` returning a `SettingsPage` whose one `choice` setting has the
built maps as its options and an `apply` that loads one; a match screen is `matchPage(...)` with
a bot count and a frag limit. Neither needs the shell to change. That claim is not left as an
assertion: the shell was driven with a three-page settings model in the running application —
Graphics, Maps, Match — and checked for exactly one visible page, the right nav item marked
active, and a choice on the *Maps* page writing through to its `apply`.

**What is not built, and why.** Map switching needs a list of built maps, and there is no
manifest: `assets/built/` is gitignored, produced per map by `convert-map.ts` on demand, and its
contents are whatever the person running the pipeline asked for. A hardcoded list of the six
that happen to be converted here would be wrong on anybody else's checkout and would look like a
feature. The honest version emits a manifest from the converter, and that is a pipeline change
rather than a menu one — Q-008.

Match setup needs the bot roster to be a runtime quantity, and it is currently derived: one bot
per spawn point beyond the player's, capped by the roster (D-068's reasoning — "a map built for
eight players gets seven opponents"). Making it a setting means deciding what overrides that,
which is a gameplay decision and not a menu one.

### D-098: One stylesheet with defines, and the HUD moved onto it

There was no stylesheet. `index.html` carried four properties inline and `Hud.ts` carried the
rest as a template literal appended to `<head>`, with a comment explaining that three rules did
not justify a file. That was true and stopped being true the moment there was a second screen:
the HUD and the menu have to agree about what "muted text" and "one step of space" mean, and two
files cannot agree about a constant that lives inside one of them as a string.

`sass` as a dev dependency, `src/style/`, and one entry point that `main.ts` imports.

**Two layers from one source.** `_tokens.scss` holds the Sass variables — colour, type, space,
shape, motion, stacking — and `emit-custom-properties()` writes the same values out as
`--queep-*` custom properties. Sass variables are what arithmetic and `map.get` read and they
vanish from the output; custom properties are what a subtree can override and what devtools can
be poked at while the game runs. Writing the second from the first is what stops them drifting.

**And a third consumer, which is the part that is not housekeeping.** meep's
`view/layout/layout.scss` routes every colour and font through a `--meep-*` property with a dark
fallback, explicitly so that "a host theme can re-skin the constructs by defining the tokens on
an ancestor". `emit-meep-aliases()` is this port being that host theme. It currently emits eight
declarations nothing reads, because the port mounts none of those constructs; it is eight lines
against a documented contract, and the alternative is discovering the mismatch when a
`TabbedView` is first mounted and renders in the editor's blue. The names and the *shapes* come
from reading the file rather than from guessing — `--meep-font` is consumed as a `font:`
shorthand, so a bare family list would be an invalid declaration and every construct would
silently fall back to its default.

**The HUD's sizes moved onto the scales, and a few of them shifted by a pixel or two.** 12px
state text onto 11px `micro`, 6px and 10px margins onto the 4px grid, a 2px flex gap onto 4px.
Deliberate: a scale with a hole punched in it for every value the HUD happened to have first is
not a scale. Geometry — where the readouts sit, where the crosshair sits, what takes pointer
events — is unchanged.

**No viewport units, and that is not a style preference.** The menu is a child of meep's view
stack, which is an absolutely positioned element the engine sizes from the window -- so `100vw`
and the surface the UI is actually drawn on agree on a full-window game and nowhere else. The
panel is `max-width: 100%` against a padded parent rather than `calc(100vw - 32px)`, and the
compact layout is a **container query** on the menu's own width rather than a media query on the
window's.

The case that found it is a browser reporting `innerWidth: 0`, where `calc(100vw - 32px)` clamps
to zero and the panel vanishes entirely rather than being merely wrong; the cases that matter are
an embedded viewport and a split pane. It also made the breakpoint checkable -- the compact switch
was verified at six view-stack widths in the running application, in an environment where the
window itself has no width at all, which a media query would have made impossible to test.

### D-099: What a graphics menu for this engine can contain, which is four things

The page has a field of view, a render scale, adaptive resolution and its target, and four
reticle-and-readout toggles. There is no anti-aliasing, no shadow quality, no ambient occlusion,
no reflections and no quality preset, and that is not an omission.

`GraphicsEngine3` is a deliberately narrow facade whose own docblock names what it will not hand
out — `renderer` above all, at a cost it counts in callers. Shadow resolution, AA, GTAO, SSR and
the indirect-lighting mode are all properties of a `Renderer` this application cannot reach.
That wall is GAP-024, first hit when it cut the lighting half of phase 8, and this is the second
thing it has now cost. The page says so in its own footer rather than looking thin for no stated
reason.

What is reachable is reachable properly:

| setting | route | note |
|---|---|---|
| field of view | `Camera.fov` | the port's own component; `cg_fov`, default 90 |
| render scale | `dynamic_resolution.set_scale` | see D-101; not `pixelRatio` |
| adaptive resolution | `dynamic_resolution.enabled` | the engine explicitly invites this |
| frame-rate target | `dynamic_resolution.target_frame_rate` | default moved from 30 to 60 |
| frame-rate counter | the view `addFpsCounter` added | GAP-028 |
| crosshair, health tint | `Hud` | `cg_drawCrosshair`, `cg_crosshairHealth` |

`dynamic_resolution` is the one the engine asks for by name: "exposed so that it can be turned
off or re-targeted — a measurement that wants a fixed resolution, **or a settings screen that
offers the choice**".

**The frame-rate target defaults to 60 rather than the engine's 30.** `GraphicsEngine3` sets 30
and says why: it is a floor-holder rather than a governor, and "the game's target is the game's
decision (D39)". This is the game making it. A 30 Hz floor means the resolution controller sits
still through the whole range where a Quake player can feel the difference, which is the wrong
trade for this game and the right one for the engine's default.

**The menu does not pause the game, and the scrim is translucent and unblurred.** Both follow
from what the screen is for: a render-scale or field-of-view change is judged by what it does to
the picture, so the picture has to still be there and still be sharp. A `backdrop-filter: blur()`
was written and then removed for exactly that reason — it hides the aliasing the setting exists
to trade against. It is also Q3's own behaviour; its menu never paused a deathmatch.

### D-100: The menu takes the input while it is open, and hands it back on the way out

meep's `PointerDevice` and `KeyboardDevice` listen on the view stack, which is the menu's own
ancestor. Three consequences, all of which had to be handled and none of which are the engine
doing anything wrong:

- **A click on a slider is also a click on the game.** `PlayerController.onPointerDown` answers
  any click by asking for the pointer lock back, which would shut the menu in the same frame it
  opened. Every pointer and key event is stopped at the menu's root while it is open.
- **Stopped, not flagged.** `PointerDevice` calls `preventDefault()` on `pointermove` and on
  `wheel`. A cancelled `pointermove` is a range input that will not drag and a cancelled `wheel`
  is a settings page that will not scroll, so the events have to not arrive rather than arrive
  and be ignored.
- **Escape is handled on `document`, in the capture phase.** Bubble would not work, because the
  menu's own root is what stops key events from reaching anything above it — a bubble listener on
  the document would open the menu and never close it.

On the way out the focus goes back to the view stack unconditionally, because the controls inside
the menu are focusable and closing while one has focus leaves focus on an element that has just
become invisible: the browser moves it to `<body>`, and the game silently stops answering the
keyboard.

The pointer lock goes back only when the gesture that closed the menu was a pointer one.
`requestPointerLock` needs a transient user activation and Escape does not grant one — the
specification excludes it, being the key that ends things — so asking after an Escape is a
guaranteed rejection and a console error to go with it. `Menu.close` therefore carries a cause,
and the application asks only when the answer will be yes. Closing with Escape leaves the HUD
saying "click to play", which is what it has always said.

**A related pre-existing defect, fixed while in the area.** Both older call sites wrote `void
this.element.requestPointerLock()`. `void` discards the value and does nothing about the
rejection, so every refused lock was an unhandled promise rejection in the console — which is how
this was noticed at all. All three now go through `takePointerLock`, which also normalises the
return type: the method is specified to return a promise and older engines return `undefined`,
so `.catch` cannot be called on the result directly.

### D-101: The render scale is the renderer's internal scale, because the property that looks like it cannot be set

Shipped on `GraphicsEngine3.pixelRatio`, which is the obvious choice and is unusable. Reported
from a real window within the hour:

```
[queep] setting 'render-scale' failed to apply
  Error: y must be an integer, instead was 872.0999999999999
    at Renderer.resize (Renderer.js:1445)
    at GraphicsEngine3.updateSize (GraphicsEngine3.js:701)
```

`pixelRatio` is a `Vector1` — a float — and `updateSize()` multiplies it into the viewport size
and hands the product to `Renderer.resize`, which asserts both arguments are integers. The
reporter's window was 969 tall; 90% of 969 is not an integer, and neither is 90% of most numbers.
The only ratios that work are the ones dividing both viewport dimensions, which in practice means
whole numbers. BUG-11.

**It is worse than a throw, which is why the fix is a change of route rather than a guard.** The
ratio is stored, and `viewport.size.onChanged` calls `updateSize` on every later window resize —
so once a fractional ratio is set, *every subsequent resize* throws inside meep's signal
dispatch, which catches and logs and carries on. The renderer is never resized again for the rest
of the session, and the evidence is one console line naming a function. A setting that can leave
the renderer permanently detached from the window is not one to keep behind a `try`.

**What a render scale actually wants is `Renderer.internal_resolution_scale`** — *"Fraction of the
output resolution. If this is set to 0.5 for example, internal resolution will be 50% of the
output resolution"*. It floors internally, takes any positive number, and what it produces is
upscaled back by the renderer's own TAA/NSS rather than by the browser stretching a smaller
canvas. It is a better setting on quality grounds independently of the bug, and the engine's own
playground presents exactly this value as a percentage slider labelled "Scale".

**An application cannot reach it, and what this port does instead is worth being plain about.**
`GraphicsEngine3` hands out no renderer. The only reference to the property outside `Renderer` is
the pair of closures the facade assigns into the resolution controller:

```js
this.#dynamic_resolution.get_scale = () => this.#renderer.internal_resolution_scale;
this.#dynamic_resolution.set_scale = v => { this.#renderer.internal_resolution_scale = v; };
```

Calling `graphics.dynamic_resolution.set_scale(v)` is a public method on a public object, so it is
an API call and not a monkey-patch, and it does not touch engine source. It is still reaching
around a facade that hides what is behind it, and it is recorded as that rather than presented as
the intended path. GAP-027 has the suggested fix, which is a forwarded property in the shape
`set_environment_map` already has.

**The consequence in the menu is not a compromise.** The manual scale and the adaptive controller
write the same number, so they are alternatives, and each greys the other's row out — which is how
every shipped game presents this pair. The three rows are ordered cause before effect: the toggle
that owns the quantity, then the two rows it governs, one going inert each way. A disabled control
directly under the switch that disabled it explains itself; the same control in another section
reads as broken.

**Why the port's own checks missed it, which is the part worth keeping.** Two failures, and
neither was bad luck:

- The browser check ran at 1280 x 720. Every scale tried — 0.75, 1.5 — multiplies to an integer
  on both axes at that size. A round viewport is the one place this bug does not exist.
- The test's fake `GraphicsHost` recorded that `updateSize` had been called and asserted nothing
  about the value. A fake that accepts everything tests that the port calls something; it cannot
  test that the port calls it with a value the real thing will take.

Both are fixed in the same shape: the fixture viewport is now 1727 x 969, and the fake carries
`Renderer.resize`'s and `internal_resolution_scale`'s assertions transcribed from the engine. The
new test walks every step the slider can produce and fails on the engine's own message. It was
confirmed to fail by putting the bug back — a regression test that has never been seen to fail is
a regression test in name only.

One more thing came out of the same fix. `Settings.applyOne` catches so that one bad row cannot
take the rest of the page down, which means a setting that throws is a log line rather than a
test failure. The test therefore watches `console.error` inside the loop, so that what a failure
reads out is `x must be an integer, instead was 863.5` rather than whatever went stale
downstream of it.

### D-102: The status bar is three bars in two turned corners, and the speedometer is gone

Q3's status bar is health, armour and ammo, drawn as three numbers along the bottom of the
screen. This port's was a speedometer, a peak-speed line and one run-on line of text — which was
the right HUD for the phase that built it, when the open question was whether strafe jumping
worked and there was no inventory behind the numbers to draw (Q-004). The state exists now, so
the readout is the one the game actually has.

**The three resources are `SegmentedResourceBarView`, which meep ships and does not style.** The
view builds a fill, a ghost, a notch canvas and a highlight list, gives each a class, and there
is no rule for any of them anywhere in the engine — so `hud.scss` is not decorating the
component, it is the whole of its appearance. Two of its details are worth having and are why it
was worth using over a `<progress>`:

- **The notches are a quantity, not a percentage.** `RESOURCE_BAR_SEGMENTS` picks the largest of
  2/10/40/200/1000 that fits the maximum, so a bar full at 200 is notched every 40 and a bar full
  at 10 is notched every 2. Health and armour share one maximum and therefore one notch spacing,
  which is what makes "80 health and 120 armour" a thing you see rather than read.
- **The ghost is the trailing edge.** It is sized to the total and painted behind the fill, so
  with a transition on its width the fill drops instantly on a hit and the ghost follows it down.
  The eye catches that where it misses two digits changing.

**Where full is, for ammo, is per weapon, and it is the one number the game never states.** Q3
draws ammo as a count and has no bar, so nothing in the source says what a full rocket launcher
is. `MAX_AMMO` is the obvious answer and is wrong in play: it is 200 for everything, so a rocket
launcher holding every rocket on the map would draw at 5% and read as empty. `ammoFull` takes the
largest amount Q3 itself hands the player at once — the weapon pickup's load, a box of its
ammunition, or the spawn loadout, which is the largest only for the machinegun — so a full
rocket launcher is 10 and notched every 2. Going red is Q3's own arithmetic and not a threshold
chosen here: `CG_CheckAmmo` prices a round of the heavy weapons at 1000 and everything else at
200 and warns below 5000, which is five rockets and twenty-five bullets.

**The two corners are turned toward the player, and one number keeps them on the screen.** One
`perspective` on the row both clusters sit in, so they share a vanishing point and read as two
ends of one curved surface rather than two tilted panels; each cluster then turns about its
*inner* edge, so the outer end swings forward. That last part is what makes it a wrap and is also
what nearly broke it: a near edge is magnified, magnification is about the vanishing point, and
so the outer end is thrown away from the middle of the screen by an amount that grows with how
far from the middle it already is. The bottom-left corner cleared the window at 1280 and hung 51px
off it at 1920. No inset can fix that, because the overflow scales with the screen width and the
inset does not.

`$hud-wrap-depth` fixes it: push the cluster back by at least the depth its own turn will lift it
through, and every corner of it sits at or behind the screen plane where the projection can only
shrink it. Nothing overflows at any width — measured at 1280, 1920, 2560 and 3440 — and the
turn is untouched, because what the eye reads is the *difference* in depth across the cluster and
subtracting a constant from both ends leaves that alone.

**What the corners cost is width, and below 1100px they give some back.** Two clusters and their
insets are about 660px before anything is left for what sits between them, and the line of
controls in the middle wraps to three lines at 1024 and eight at 800. A container query — on the
HUD's own root, for the same reason the menu's is on its own panel: meep's view stack is not
always the whole window — takes the bars from 224px to 160px and the numbers one step down the
scale. Nothing moves and nothing is dropped.

**The weapon icon is Q3's `iconw_*`, and neither side of it holds a list.** `convert-fx.ts` reads
the icon field of every `IT_WEAPON` row in `balance.generated.json` and writes the leaf of the
path; `statusBar.ts` slices the same field of the same file to build the URL. A weapon added to
the table is converted and drawn without either file being edited, which is the same rule the
trap matrix is under (D-066): a duplicated list is a list that goes stale.

**The gauntlet draws no bar.** `ammo > -1` is the test `CG_DrawStatusBar` guards its whole ammo
readout with, and a negative count is the absence of a count rather than a small one. The icon
stays: what is in your hands is worth showing whether or not it consumes anything.

### D-103: A map's lights are spheres the size of the fixtures they came from

Every light this port imports was a point. Not "approximately a point" — `radius = 0`, which is
the field Shade's `Light` carries and documents as "how big is the light source, used for area
lighting calculations", and which the ECS `Light` component has no way to set (GAP-030). So the
question "is there any volume to these lights, or are they modelled as points" has a one-word
answer, and the follow-on question is what the right volume is.

**What the zero was costing.** Three separate parts of the shading path read that radius, and all
three degrade to their sharpest form at zero:

- `light_sphere_distance_attenuation` caps the falloff at `1 / r^2` once the receiver is at or
  inside the emitter. With no radius the cap is the shader's own `MIN_RADIUS`, one centimetre. A
  point 5 cm from a ceiling panel was therefore being lit as though the panel's entire output came
  from a marble — 127 times the irradiance the same flux off a 1 m² face delivers.
- `re_direct_physical` takes `sin(theta_source)` from it, bends the specular lobe to the
  representative point on the sphere and widens roughness by the source's solid angle. At zero
  every fixture in the level makes a mirror-sharp highlight.
- The same value drives the soft-horizon wrap that stands in for `saturate(N.L)`, so the
  terminator is a hard edge; and for the sun, the SDF tracer's penumbra, so every shadow the map
  casts is a hard line.

That is a complete description of "the lights look harsh", and none of it is a mistake in the
conversion. It is one unset field.

**The sizes are measured, not chosen.** A surface light already knows how big it is: it *is* a
cluster of emitting faces, and the pipeline summed their areas to place it. A sphere of radius
`sqrt(A / pi)` has the same projected area from every direction as a face of area `A` seen
head-on, which is the equivalence all three uses above rest on, so that is the radius. Across the
six maps it lands between 0.25 m and 1 m with a median of 0.28 to 0.56 m depending on the map —
a metre-square ceiling panel, which is what a Q3 light texture is.

It is bounded at both ends and both bounds are load-bearing. Below 5 cm the number is smaller
than the shader's own delta-source fallback and buys nothing. Above 1 m the emitter has stopped
being a fixture: uncapped, the largest on `oa_dm4` reaches 6.2 m and on `oa_dm1` 3.5 m, and a sphere
that size at a pool's centroid would flatten every surface within it — inside the sphere the
attenuation is constant and the terminator is gone. Clamping does not dim the pool; attenuation
past `r` is inverse-square either way.

**A fitted light gets 0.25 m, and that is the one number here that is a choice.** A light fitted
to the lightgrid has no emitter to measure — it is an inference from where light arrived (D-078).
What pins it is the fit's own arithmetic: `d` is floored at a quarter metre, and the comment on
that floor already calls it "a bare bulb against the surface". Making the radius that same
quarter metre states the shape the sizing had already assumed, and because the renderer's
attenuation is unchanged for `d >= r`, **no site the fit measured moves**. The volume is free.

**The fit had to learn the same model.** `fitGridLights` only adds what the existing lights leave
short, so its forward model has to be the renderer's. Left dividing by `d^2` it would credit a
cell pressed against a light panel with hundreds of times what the panel will now deliver there,
find no deficit, and leave the place dark. `perLumen` is the shader's attenuation transcribed,
and both the greedy pass and the least-squares sweeps go through it.

**Measured effect on the lighting solution: none.** Median illuminance at every place a player
stands, across all six maps, moves by less than a tenth of a lux, and the light count is
unchanged everywhere except `oa_dm7`, which gains one fitted light. That is the expected result
and it is the point — this is a near-field bound and a specular width, and a player is metres
from a fixture. What changed is what a fixture looks like from arm's length, which is not
something a lux number at eye height can see.

**The sun gets 0.006475**, which is `make_sunlight`'s own figure for the sun — a `disk_radius` is
a sine, not a length, so that is 0.37 of a degree against a true quarter degree. The engine's
number rather than the textbook one, because it is the sun every other meep scene is lit by and
because the error is on the soft side. It is the only light in a converted map that casts
shadows, so it is also the only one where the volume buys a penumbra rather than a highlight.

**Where it is applied is a workaround and is written up as one.** The ECS component has no field
for extent, and the Shade light that does is private to `LightSystem3`, so `applyLightVolumes`
walks `Scene.lights.elements` after `loadMap` has built the entities and matches each light back
to its bundle record by position. The alternatives were worse: duplicating `LightSystem3` to get
at the object it creates, or shipping delta sources. See GAP-030 for the two-line fix that would
remove the whole file.

### D-104: The asset tree was deleted by a cleanup step, because a junction is a door that opens both ways

On 2026-08-26 `assets/built`, `assets/download`, `assets/extracted` and `assets/generated` were
destroyed. Recorded here rather than quietly rebuilt, because the mechanism is not obvious, the
same shape of mistake is available to anyone working in this repository, and the rule it produces
constrains the tooling.

**What happened.** Two sessions were working in this worktree at once. To typecheck a commit
without the other session's in-flight, non-compiling changes in it, one of them made a throwaway
`git worktree`, and — because `node_modules`, `assets` and `oracle` are all gitignored and
therefore absent from a fresh checkout — junctioned all three into it so the tools would resolve.
`git worktree remove --force` then walked that directory, followed the `assets` junction into the
real tree, and deleted through it. It got as far as `assets/ml/build` before aborting on a path
too long for the Win32 API, which is the only reason the 28 GB of model checkpoints beside it
survived. What it printed was `failed to delete ...: Filename too long`, so the interesting half
of the message was the half it did not print.

**Why the obvious defences do not apply.** A junction is not a symlink and is not marked as one in
a directory listing; `Test-Path`, `ls` and every recursive delete treat it as an ordinary
directory. `git worktree remove` is not a delete you wrote, so nothing about the call site says
"recursive". And the tree it ate is gitignored on purpose (brief section 3: no large binaries
committed), so git had nothing to restore and nothing to warn about — the same property that makes
the repository small makes this unrecoverable. A command-line delete does not reach the recycle
bin.

**The rules that follow**, in the order they would each have stopped it:

- **Nothing links to real repository data from a directory that will be deleted.** If an isolated
  tree needs `node_modules` or `assets`, it gets a copy or it does without. This is the one that
  matters; the rest are belt and braces.
- **Verification does not need a second checkout.** `git show <sha>:<path>` reads any committed
  file and `git diff <sha> <sha>` compares trees, which is what the isolated typecheck was
  actually after. Where a real checkout is unavoidable, it is left in the scratchpad — an
  abandoned temporary directory costs nothing, and deleting it is the only step in the whole
  sequence that can lose data.
- **`--force` on a cleanup command is a request to skip the check that would have caught this.**
  The plain `git worktree remove` refuses a worktree with untracked content in it, and untracked
  content is exactly what those junctions were.

**What it cost, honestly.** The maps, models, characters, sounds and fx are a re-run of the
pipeline. `assets/generated` is ninety minutes of GPU inference, and while `inverse_render.py`
takes a seed, a diffusion model reproduced across a re-run is a claim to test rather than assume —
D-095's counts and the per-channel verdicts in the report were measured against the set that was
on disk, not against a set that can be conjured back. ASSETS.md now carries the rebuild cost of
every tree, so the next person to reach for `rm -rf` can read what it is worth first.

### D-105: `q3map_surfacelight` was never a number of lumens, and the reach was that number again

The port read `q3map_surfacelight` off a shader and shipped it as the fixture's luminous flux, one
cluster's worth per fixture. Every consequence of a light in a converted map came out of that one
integer: `oa_dm1`'s torches emit 3,787 lm because `textures/sfx/flame2` says
`q3map_surfacelight 3787`, they shine at 301 cd because that is `3787 / 4pi`, and they reach 37.6 m
because the cutoff radius was `6 + 3787 / 120`.

**The directive is a per-unit-area quantity and it was read as a per-fixture one.** That ignores how
much surface is emitting, and on `oa_dm1` the result inverts:

| shader | declared | clusters | m² per cluster | lm per cluster | implied lm/m² |
|---|---:|---:|---:|---:|---:|
| `sfx/flame2` | 3787 | 10 | 0.20 | 3787 | **18,734** |
| `base_light/ceil1_38` | 300 | 6 | 1.00 | 300 | 300 |
| `base_light/xlight5` | 1000 | 1 | 22.0 | 1000 | 45 |
| `gothic_block/mkc_evil_e3window` | 200 | 4 | 8.0 | 200 | 25 |
| `liquids/lavahell` | 666 | 1 | 38.0 | 666 | **18** |

A thousandfold spread in radiance across one level, with the largest emitters the dimmest per unit
area: ten torch quads covering 2 m² held **90% of the map's reconstructed flux over 2% of its
emitting area**, and the 38 m² lava lake got 666 lm. `UNLIT_LUMINANCE` was already flooring that
lava so it did not come out dimmer than a texture nobody declared anything about — a symptom being
patched rather than a rule being fixed.

**The error is not a scale factor.** D-078 recorded the overshoot and guessed at a per-map
calibration; the guess was too kind. Fitting one global scale per map against the baked lightgrid
gives 0.91 for `oa_dm1` and 0.022 for `am_thornish`, and within a single map the declared values are
wrong in both directions at once — `oa_dm4` now ships `ironcrosslt2_20000` at 0.22 of what it
declared and `skulllight01` at 5.4 times. No divisor was available to be found.

**The fix is that the machinery to size these lights already existed and was being withheld from
them.** `fitGridLights` fits point lights to `LUMP_LIGHTGRID` by least-squares coordinate descent
over every lit cell (D-078). It took the surface lights as `existing`: read into the residual, never
adjusted. So the one number in the solution that nothing measured was the one doing most of the
lighting, and because the fit could only *add*, a map whose shaders declared too much stayed too
bright no matter how well the fit behaved.

They are free variables now, in the same objective, against the same field, in the same sweeps.
`q3map_surfacelight` stops being a claim about lumens and becomes what it can support: the mapper's
statement that light comes out of here, and a starting point.

**Reach is a fraction of the local level, not an absolute lux floor.** The old cutoff was 0.25 lux,
and no absolute number can be right for two maps at once — a quarter lux is 1% of `oa_dm1`'s median
illuminance and 5% of `am_thornish`'s. Sixteen of `oa_dm1`'s 33 lights had an influence sphere
larger than the entire map, a shading point had a median of 15 lights in range, and a third of those
pairs were delivering under half a lux each.

It is 3% of the baked level in the region the light works in, weighted by the light's own
contribution so that a lamp over a bright atrium is measured against the atrium and one in a dark
corridor against the corridor.

**Output and reach had to be solved together, and the first attempt did not.** Fitting output over a
fixed generous reach and cutting each light back afterwards ships a field nobody optimised: every
light is sized on the promise of lighting cells it is then not evaluated at. Measured on `oa_dm1`,
delivered illuminance came out at 0.52 of the baked target while the fit reported closing to 0.8.
The loop alternates instead — sweeps against exactly the sites a light will be evaluated at, then a
resize, then again — and ends on a sweep, so what ships is an output fitted at the reach it ships
with. Three rounds; the third moves the residual by under a point.

**The sun was on the other scale entirely.** `q3map_sun`'s intensity was divided by 45 and capped at
6, chosen so a typical map landed near meep's `make_sunlight` default of 2.2 — which is the engine's
*artist-facing* convention, while every point light in this port is in real photometric units and a
`DirectionalLight`'s intensity is lux. `am_thornish`'s sun was 3.3 lux, less than one of its own
torches at seven metres. No divisor works there either: `q3map_sun 150` is worth 43.8 lux of baked
directed light on `aggressor` and 17.3 on `am_thornish`. So it is measured off the same field as
everything else — the median directed component at cells with a clear trace to sky — and falls back
to the old formula on a map with too few such cells for a median to mean anything.

**Results.** RMS against the baked field, and illuminance where a player stands:

| map | RMS before | RMS after | player-height lux | lights in range | summed reach |
|---|---:|---:|---|---:|---|
| `oa_dm1` | 87% | **79%** | 16.7 → 14.9 | 15 → 5 | 18.2× → 7.3× |
| `oa_dm4` | 256% | **67%** | 32.9 → 23.9 | 7 → 5 | 6.1× → 3.6× |
| `oa_dm5` | 139% | **65%** | 10.8 → 11.1 | 9 → 5 | 14.6× → 5.8× |
| `oa_dm7` | 116% | **63%** | 27.3 → 26.1 | 12 → 6 | 16.5× → 6.7× |
| `aggressor` | 250% | **52%** | 20.2 → 11.7 | 17 → 6 | 12.0× → 5.1× |
| `am_thornish` | 2312% | **78%** | 54.2 → **7.1** | 24 → 4 | 17.5× → 0.9× |

"RMS before" is the shader route on its own, and "summed reach" is the lights' influence volume
against the map's own. `am_thornish` is the case D-078 called out and could not fix: it delivered
54 lux at player height where the grid baked 7.7, and it now delivers 7.1.

Nothing went dark. Player positions under 1 lux stayed at zero on five maps and `oa_dm5` lost the
one it had; `am_thornish` gained one of 136. The median number of lights a shading point evaluates
fell by two-thirds to three-quarters everywhere, which is the reach fix and is free.

**What the fit may now do that it could not before: take a fixture away.** A surface light the
sweeps drive to nothing is dropped — 22 of 63 on `aggressor`, 7 of 22 on `oa_dm1` — because a GPU
light the baked field says contributes nothing measurable is being paid for and not seen. The *face*
still glows: the declared-emitter floor that used to be redundant is now load-bearing and says so,
because `e8/e8jumpspawn02b` on `am_thornish` went to 0.00 cd/m² and stopped glowing at all before it
was written down.

**The pairing D-093 established had to be re-established.** A material's emissive luminance is its
flux over its area, and that flux is no longer anything a shader declared, so it is summed back up
from the lights after the fit. Each surface light records the material it came out of —
`BundleLight.material`, the mirror of `color`, which only a fitted light carries — and
`materials.test.ts` checks the two against each other directly rather than, as before, checking that
the luminance came back as a whole number of clusters.

**What is asserted now that could not have been.** `presentation.test.ts` gains a bound on the
residual against the baked field, which no map could have passed before this — four of the six were
over it — and a bound on summed reach against the map's own volume, which five of the six failed.
The bundle carries `lightingResidualAfter`, so the claim is checkable from the artifact rather than
only from a build log.

**Two things this does not claim.** The absolute scale is still `LUX_PER_BYTE = 0.2`, which puts a
Q3 interior at tens of lux where a real one is hundreds. Everything here is calibrated to the bake,
and the bake's own unit is a bridge that was measured once against the route this entry has just
rewritten — circular, and it does not matter while the renderer's exposure is automatic, but it is
the next thing to be suspicious of if that ever changes. And the bake is itself clipped: 16.5% of
`oa_dm1`'s lit cells and 30.3% of `oa_dm4`'s have a saturated byte, so the reference is flat-topped
at 102 lux exactly where the bright fixtures are, and a fit against it is pulled down there.
### D-106: The level is what a sound has to get through, and the room it rings in was measured once

Quake III models no acoustics at all. `S_StartSound` pans a sample by distance and direction and
stops there: no occlusion, no reverberation, no medium. meep 3.5 ships all three. This is what
wiring them cost, what was chosen where Q3 had nothing to port, and the two things that were
measured rather than assumed.

**The occluders are the physics bodies.** `AcousticSimulationSystem` links the triple `AcousticBody
+ Collider + Transform` and raycasts the collider's shape directly, so a Q3 brush is already an
acoustic occluder in everything but one component; `PhysicsWorld.addStaticHull` adds it as each body
is built. There is no second copy of the level and no second conversion, and a `func_door` occludes
as it moves because the system tracks the transform it already has.

Which brushes get one is not "all of them". The bodies are built for `MASK_PLAYERSOLID`, which takes
`CONTENTS_PLAYERCLIP` — the invisible fences that keep players off ledges — and a fence a rocket
flies through -- `layers.ts` gates a missile on `MASK_SHOT`, which excludes it -- is not a wall its
sound should stop at. `occludesSound` is `CONTENTS_SOLID` and nothing else: 516 of `oa_dm1`'s 529
static bodies.

**The reverberation is baked, and the bake shares the runtime's geometry by construction.**
`tools/bake-audio.ts` covers each map's air with probes and measures a per-band RT60 at each by
casting rays into the solids. It builds those solids with `hullShape` — the same function
`PhysicsWorld` and `HeadlessPhysics` build their colliders with, extracted here because it had been
written out three times. A reverberation measured in a room the runtime does not have is wrong in a
way nothing reports, which is D-036's lesson in a third place. That it held is checkable rather than
asserted: the bake counts 516 occluders for `oa_dm1` and the browser counts 516; both count 862 for
`oa_dm5`.

| map | occluders | probes | file | bake | mid-band RT60 (mean) | longest band | probes at the 3 s ceiling |
|---|---:|---:|---:|---:|---|---:|---:|
| `oa_dm1` | 516 | 364 | 21.3 KB | 84 s | 0.07–2.58 (0.93) | 4.11 s | 92 |
| `oa_dm4` | 728 | 351 | 20.6 KB | 233 s | 0.00–2.41 (0.65) | 3.72 s | 60 |
| `oa_dm5` | 862 | 373 | 21.9 KB | 141 s | 0.09–2.97 (0.98) | 3.86 s | 87 |
| `oa_dm7` | 359 | 652 | 38.2 KB | 103 s | 0.08–3.00 (1.71) | 6.33 s | 342 |
| `aggressor` | 820 | 339 | 19.9 KB | 204 s | 0.00–2.89 (0.93) | 4.60 s | 83 |
| `am_thornish` | 751 | 2,206 | 129.3 KB | 66 s | 0.04–3.00 (1.40) | 8.06 s | 758 |

**Superseded by D-144 for every column of that table.** The spacing hint above is four metres, and
four metres turned out to exclude rather than merely coarsen: the cover's clearance floor scales
from it, so nothing narrower than 64 Q3 units received a probe at all. The field is baked at one
metre now — about half a player — and the numbers here are what it looked like before.

**Corner-leak pathing is off, and the file format is why.** meep's serializer carries probe
positions, per-band RT60 and per-band arrival direction, and deliberately carries neither the probe
visibility graph nor the reflector lobes: both are functions of the geometry rather than of the
probes, so re-deriving them at load costs what the bake costs. `AcousticSimulator.apply` gates
pathing on `probeField.hasVisibility`, so a field without one is a supported state rather than a
broken one, and `acoustics.test.ts` asserts it loads that way — if a later meep serializes the
graph, that test failing is the notice that pathing became affordable.

**Transmission is deliberately not zero, and that is a gameplay decision rather than an acoustic
one.** `EventInstance.setAcoustic` uses transmission as the per-band floor a fully occluded source
keeps — `(1 - occlusion) + occlusion * transmission` — so `Q3_SURFACE`'s `[0.5, 0.25, 0.08]` makes a
sound behind a wall *muffled* rather than gone: the lows carry, the top end does not. Hearing an
enemy through a wall is not a defect in Quake III. With no occlusion modelled at all it is the
game's positional-audio channel, and a port that adds occlusion silently closes it. Pathing would be
the other way to keep it open, and is not available for the reason above.

**A point source occludes boolean, and that was measured, not reasoned about.** `OcclusionSolver`
shoots its rays at points spread over a sphere of the source's radius and calls the blocked fraction
the occlusion — so `AudioEmitter.sourceRadius = 0` sends every ray to the same place. Sweeping a
source across a brush edge in the running game:

| source radius | 0.5 m | 0.75 | 1.0 | 1.25 | 1.5 | 1.75 | 2.0 m |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0 (point) | 0 | 0 | 0 | **1** | 1 | 1 | 1 |
| 1/3 m | 0 | 0 | 0.13 | 0.53 | 0.89 | 1 | 1 |

A step, against a ramp. A player walking past a doorway would have heard the sound switch on.
Sources get a third of a metre — about a Q3 player's shoulder, and the smallest radius that still
spreads the ray set enough to ramp; an edge crosses it in roughly 70 ms at Q3 run speed, which the
solver's own temporal EMA smooths further.

**The RT60 ceiling is a design decision and the bake is not wrong.** `am_thornish` genuinely measures
8.06 s in its largest volume, which is what Sabine gives for a hall that size behind surfaces as live
as `Q3_SURFACE`. It is clamped to 3 s anyway, for two reasons. `reverbImpulseResponse` sizes its
buffer from the RT60 with no cap, so 8 s is a 387,000-sample stereo buffer plus three `Float64Array`
scratch bands the same length — about 11 MB, synthesised on the main thread every time the listener
crosses a probe cell that differs enough to re-bake, which is a stutter caused by walking. And a
seven-second tail smears exactly what Quake III uses sound for. The clamp is applied by the bake
rather than at load, so the shipped file holds what is played, and it is *reported* — the table's
last column is a map saying how much of it is being reshaped. `am_thornish` is 34% of its probes,
which is the number to look at first if that map ever sounds flat.

**Cost, measured.** The full 24-source `LOOP_BUDGET` at meep's default 16 rays per source, against
`oa_dm5`'s 862 occluders, is **0.433 ms per frame** — 2.6% of a 60 Hz frame. The load cost is one
component and one BVH insert per solid brush, inside the same tens of milliseconds the bodies
already take.

**What this does not claim.** The reverb send level (0.35, about -9 dB) and `Q3_SURFACE`'s
coefficients are judgements, not measurements: Q3 shipped bone dry, so there is no original to match
and nothing here was tuned by ear against one. The absorption numbers are what put the RT60s in the
table, so they and the ceiling are two knobs pointed at the same quantity — if the maps ever want
retuning, absorption is the one that changes the *shape* and the ceiling is the one that changes
where it stops. `ProbeReverbRenderer` also picks its probe by plain nearest-neighbour rather than
nearest-*visible*, so a listener close to a wall can read the room on the other side of it; meep has
`nearestVisibleIndex` and the reverb renderer does not use it. GAP-031 through GAP-033 record the
engine-side halves of all of this.
### D-107: The room's ambient light is where you are standing, and getting it required patching the engine twice

Every build before this rendered indirect light from `ShadeIndirectLightingMode.IBL` -- one distant
environment map, sampled identically everywhere. It is why `make_default_environment` is in
`main.ts` at all: without an environment, Shade renders every surface unlit, and "my geometry is
black" reads as a material problem (REPORT.md ergonomics). The consequence is that a sealed Q3
corridor receives exactly as much ambient as the courtyard outside it. No bounce, no colour bleed,
no dark.

Brick4 is the other end of that: a sparse voxel hierarchy of irradiance probes, baked against the
map's own geometry and lights, sampled per shading point. The ambient term becomes a function of
position.

**The runtime half is three lines and works.** `VolumetricLightMapSystem3` uploads whichever
`VolumetricLightMap` component linked first into the one `Brick4LightMap` the scene keeps, and
re-uploads after a device restart; the component is the bytes and nothing else. So loading a bake is
fetch, assign, attach. Two things are worth stating because neither is implied by the other:
uploading a lightmap does not turn Brick4 on -- the mode is the renderer's setting and a scene in
IBL never reads the buffer -- and turning Brick4 on without a lightmap reads an empty buffer, which
is a black level rather than an unlit one. So the mode follows the map: Brick4 when there is a bake,
IBL when there is not, and `?gi=ibl` to opt back out and compare.

**The bake cannot be a Node tool, unlike the acoustic one.** `brick4_bake_basic` is a compute
shader: it traces the scene several bounces deep at tens of thousands of samples a probe, and there
is no CPU path. So it runs in the browser against the live renderer -- `?bake=lightmap` -- and posts
its result to a dev-server sink that writes it next to `scene.json`, the same shape as the
screenshot sink. meep's own `brick4_bake_for_scene` ends in `downloadAsFile`, which is right for one
scene in a console and wrong for six maps in a row.

| map | baked | probes | bake |
|---|---:|---:|---:|
| `oa_dm4` | 0.92 MB | | ~2 min |
| `oa_dm1` | 1.12 MB | 32,074 | 3 min |
| `oa_dm5` | 1.13 MB | | ~3 min |
| `am_thornish` | 1.73 MB | 49,924 | 6 min |
| `aggressor` | 1.75 MB | | ~3 min |
| `oa_dm7` | 2.90 MB | 83,490 | 5 min |

**It did not work, and the reason is the finding.** meep 3.5.0 could not bake a volumetric lightmap
at all. Two independent defects sit on the only code path that produces one:
`StaticSceneBVH.raycast_nearest` passes `bvh_query_user_data_ray` its argument pairs swapped and
throws on any scene with geometry in it (REPORT.md BUG-12, **fixed in 3.6.0**, which landed while
this was being written); and `brick4_bake_basic` records a frame graph its own validator rejects,
because the second of its two compute passes reads the pre-write handle of the buffer the first one
writes (BUG-13, **live on 3.5.0 and 3.6.0**). The second is two lines.

`meepBakePathFixes()` in `vite.config.ts` rewrites both on the way to the browser. That is a
dev-server source transform and not an edit to `node_modules`, and it is deliberately the smallest
thing that works: four lines of matched text, a hard error on a *partial* match, and a silent skip
when a pattern is absent entirely -- because absent means fixed upstream, which is not hypothetical.
The `StaticSceneBVH` entry became a no-op mid-session when the dependency moved to 3.6.0 underneath
this work, and the guard is what noticed.

The shape of those two bugs says more than either: they are independent, they sit on the *only*
route to a `VolumetricLightMap`, and the second is caught by the engine's own validator the first
time the graph compiles. Nothing has run this code. What that makes of the surrounding work is
worth being explicit about -- the runtime half is well built and worked first time against a real
1.12 MB bake -- so the gap is one end-to-end test that bakes a two-box scene and asserts a non-empty
structure.

**Two things the review caught that the first version got wrong.** Re-baking a map that already had
a lightmap attached a *second* component, and `VolumetricLightMapSystem3` wires whichever linked
first and silently ignores the rest -- so the file was written correctly and the level stayed lit by
the map it had just replaced, which is indistinguishable from a bake that did nothing. The bake
assigns into the existing component instead, whose `version` is precisely what the system watches.
And `?gi=ibl` was overridden by a bake finishing, so an explicit "show me the environment map" would
silently stop meaning that.

**What is not claimed.** (`LIGHTMAP_MEMORY_BUDGET` is 10 MB as of D-144, which also found that the
cell size below is not the probe spacing it reads as. The reasoning in this paragraph is unchanged
and the numbers in it still hold: ten buys the same purge eight did.) It is 8 MB rather than the
engine's 16 because of one map: `am_thornish` does not converge, and at the 32 MB this was first set to it reached 601,000
probes with a 57-minute bake ahead of it. Eight bounds it at 49,924 and leaves the other five
untouched -- checked by re-baking `oa_dm7`, the closest to the cap, and getting a byte-identical
file back. The cell size is meep's own default and was not tuned. And nothing here has been looked
at in a lit window by a person: the preview browser runs this application in a hidden tab where
`requestAnimationFrame` never fires, so every claim above is about bytes, probe counts and component
state rather than about how the arenas look.
### D-108: Every light casts, and which ones do is a row in the menu

Before this, four places in the port each decided the question for themselves and permanently: the
map's point lights said no, the map's sun said yes, the explosion flash said no, and the muzzle
flash said no. Three of those four were the same decision written three times, with the same
reasoning in the comment each time -- q3map2 already baked the static shadowing into the lightmaps,
so the sun was the only light that had to cast for an arena to read as lit.

That reasoning is still true and is no longer the only defensible answer, because the lights in
question are not decoration. They are reconstructed fixtures standing where the level's own lamps
are, sized to the fixture (D-103) and coloured from the lightgrid (D-105). Having them throw
shadows is the difference between a room lit by a renderer and a room lit by its light fittings.

So the flag moved out of the four comments and into `src/client/Shadows.ts`, and the menu got a row.

| mode | sun | map lights | effect flashes | `feature_shadows_enabled` |
|---|---|---|---|---|
| Off | no | no | no | false |
| Sunlight only | yes | no | no | true |
| All lights | yes | yes | yes | true |

Three values rather than a toggle, because the three costs are genuinely different and the middle
one is what every build before this shipped -- a toggle would have made "what it used to do" and
"nothing at all" the same position. `All lights` is the default, which is the expensive one on
purpose; the two cheaper rows are for hardware that cannot hold the frame rate, which is what a
graphics menu is for. Off is the renderer's own master switch and not merely a scene with nothing
casting: with `feature_shadows_enabled` false the shadow context treats every map as evictable and
the pass stops running.

**The flag is written on the ECS component, not on Shade's light**, and that is the one thing here
worth getting wrong once and not twice. Shade's `Light` has a `casts_shadow` and it is right there
on `scene.lights.elements`, which is where `applyLightVolumes` has to write `radius` because the
component has no field for extent (GAP-030). It is the wrong door for this one: `LightSystem3`
binds a `refresh` to `component.castShadow.onChanged` and copies the component's value over Shade's
on every colour, intensity, angle, penumbra or distance change, so a flag written on Shade's light
survives until the next unrelated property write. `castShadow` is a supported, observed, followed
property, and using it is the whole of the runtime cost of this feature.

The engine takes it from there without being told twice. `GPUSceneShadowmapContext.process_lights`
runs every frame and detects `casts_shadow` flips itself -- its own docblock says the light
collection's version does not move for them -- so a light that starts casting is allocated an atlas
rect and its face views on the next frame, and one that stops has them reclaimed.

**What `all` costs, stated rather than waved at.** A point light is a cube, six views, or four on
the tetrahedral path; the per-frame refresh budget is 32 views. So `am_thornish`'s 325 lights cannot
all refresh in a frame and are not meant to: `compute_shadowmap_update_score` scores a local light
by `projected_area_px * (1 + staleness)`, which is zero for a light that is off-screen, very large
for one that has just appeared, and in between by how much of the screen it covers. The atlas is
8192 square against a 128-pixel local map, which is room for far more lights than any of these maps
has. The cost is the handful of lights the player can currently see, over a static shadow for
everything else that holds until something moves.

**The effect flashes are asked, and the map's lights are followed.** Two shapes for one question,
because a flash is 50 to 90 milliseconds and a match makes thousands of them: a registry that held
those would be a list of dead components growing all match, and a setting changed while one is on
screen cannot matter to a light with six frames left. So `Effects` asks `casts('effect')` once per
light at the moment it makes one, and the map's lights -- built once, at load, and alive as long as
the level -- are handed to `follow` and rewritten whenever the mode moves. Nothing unregisters,
because nothing unloads a map: `?map=` is read at startup and changing it means a reload.

The honest note about the flashes is that a machinegun is ten of them a second and each one that
casts binds an atlas rect and its face views for the fifty milliseconds it exists. That is the
mode's cost rather than the effect's, and it is one row of the menu away from not being paid -- but
"every light casts" is what `all` says, so every light casts.

**This is GAP-024 getting smaller.** The graphics page's footer has said since it was written that
shadow, AA, ambient-occlusion and reflection settings are properties of a `Renderer` that
`GraphicsEngine3` hands to nobody, and that is why a graphics menu for a WebGPU engine had a field
of view on it and no quality preset. 3.6.0 added a `renderer` getter -- "Danger zone. Be careful
with what you do, with great Renderer comes great responsibility" -- which is the same door D-107
went through to put a scene into Brick4. It is one property this row needs and it is now reachable.
What is still not reachable is the shadow *resolution*: `DEFAULT_SHADOWMAP_LOCAL_RESOLUTION` is a
module-private constant in the shadow context, as is the atlas size, so a quality slider remains
what GAP-024 says it is. The footer was rewritten to say the smaller thing rather than the old one.

**What is verified.** The policy itself, in Node, against meep's real `Light` component -- including
that the write raises the `onChanged` the engine binds to, which is the failure this feature would
have had if the flag had gone on the wrong object. And end to end in the running application, on
two maps, by reading Shade's own light collection back:

| | `oa_dm1` (28 lights, no sun) | `oa_dm4` (53 lights, sun) |
|---|---|---|
| All lights | 28 points casting | 53 points + 1 directional |
| Sunlight only | 0 | 0 points + 1 directional |
| Off | 0, `feature_shadows_enabled` false | 0, `feature_shadows_enabled` false |

The `<select>` drives it, the stored mode comes back over a reload, a mode from a build that spelled
them differently is refused by `coerce` before the policy is asked, and the two effect flashes reach
Shade's collection with `casts_shadow` true.

**What is not.** Anything about the picture, and anything about the frame cost. The preview browser
runs this application in a hidden tab where `requestAnimationFrame` does not fire -- confirmed here
rather than assumed, and the log's `RENDER: 0.00ms` is the same fact -- so no frame has been drawn,
no shadow map has been rasterized, and nobody has looked at a lit room. Every claim above is about
component state and the contents of a light collection. The same limitation D-107 recorded, and for
now it bounds the whole of this port's rendering work.

### D-109: The renderer's feature switches are rows, and reflections is a row that refuses

The graphics page's footer said for most of this port's life that ambient occlusion and reflections
were properties of a `Renderer` an application could not reach. 3.6.0's `renderer` getter made that
false, D-108 spent it on shadows, and this spends it on the rest of them.

| row | writes | default | why that default |
|---|---|---|---|
| Ambient occlusion | `feature_ssao_enabled` | on | the engine's own, and the one of these the maps need |
| Screen-space reflections | `feature_ssr_enabled` | off | the engine's own, and it cannot be written at all on most of these maps |
| Bloom | `feature_bloom_enabled` | on | the engine's own |
| Motion blur | `feature_motion_blur_enabled` | off | the engine's own, and the one default here that is an argument about the game |
| Blur strength | `renderer.motion_blur.strength` | 1.0 | `MotionBlur`'s own, which is physical |

**`feature_ssao_enabled` is GTAO**, and the name is the engine's history rather than a mistake in
it: `PostProcess.ssao` is constructed `new GTAO(graphics)`, and what runs is the horizon search and
bent-normal integration in `postprocess/gtao/`. It is first in the list because it is the one a Q3
arena actually needs. A converted map's static shading is in its lightmaps, at luxel resolution,
and — the part that matters more than the resolution — it is a property of the *level*. A player, a
weapon model, an item turning on its pedestal and a rocket in flight are all outside the bake
entirely. GTAO is the only thing in this renderer that shades where those meet the floor. Turning
it off also moves more than the creases: the pass produces the bent normals the indirect term is
sampled along, and without it the renderer falls back to the shading normals.

**Bloom's row is honest about what it saves, which is less than it looks.** `Renderer` runs the
bloom chain under `feature_bloom_enabled || feature_automatic_exposure_enabled`, and automatic
exposure is on: it meters off `bloom.downsampled`. So the downsample chain runs either way and the
row is the composite. The note under the label says so.

**Reflections is the interesting one, and it is a row that refuses to be written.** SSR and Brick4
are alternatives in this renderer rather than a stack — REPORT.md recorded that under GAP-024 when
the two were planned as successive improvements and turned out not to be — and this port is in
Brick4 on every map that has a baked light volume (D-107), which is the common case and not the
corner. Two lines in `Renderer` decide it:

```js
if (this.feature_ssr_enabled && mode !== ShadeIndirectLightingMode.Brick4) { /* the SSR pass */ }

const use_fused_indirect = this.fused_indirect
    && this.indirect_lighting_mode === ShadeIndirectLightingMode.Brick4
    && !this.feature_ssr_enabled;
```

Read together they say that the flag is **worse than inert** in Brick4: the first skips the
reflections, and the second charges for them anyway — the fused Brick4 path is given up for the
split one, which is an extra pair of rgba16float targets and a separate resolve. A setting that
does nothing is a disappointment; a setting that does nothing and costs a millisecond is a bug
report about the port's frame rate.

So the row greys out **and** the write is guarded, and the second is not redundant on the first.
`enabled` is a question the screen asks: it dims the row and disables the control, and the control
is not the only way in. `applyAll` runs at startup before anything is drawn, and a value out of
IndexedDB — saved by a `?gi=ibl` session on the same map — arrives there without passing a control
at all. `apply` writes `v && reflectionsReachable()`, which is the same shape as the render scale's
`pinRenderScale` one section up: the menu holds the value, saves it, shows it, and declines to push
it at an engine that would be worse for having it.

**The one place the mode moves after startup is the bake, and it clears the flag itself.**
`runLightMapBake` is deliberately not awaited — it is minutes of compute-shader work on a level
that is already playable — and it ends by attaching the volume and putting the renderer into
Brick4. That is the only thing in this application that changes the answer `reflectionsReachable`
gave at `applyAll`, so the flip sets `feature_ssr_enabled = false` on the line below, and the menu
row greys itself out on the next `open()`, which calls `syncAll`. A dev-flag path, and the only
alternative was plumbing the settings object into a function called ninety lines before it exists.

**Motion blur is off, and that is the one default on this page decided by the game rather than by
what it costs.** Q3 is a twitch shooter played by people who come round a corner at 800 units a
second and expect the room to be legible on the frame it appears in. Reconstruction blur is very
good at making a fast turn look like a camera and slightly worse at making it readable, and "turn
off motion blur" is the first line of every competitive config for every shooter since. So it is
here, because someone will want it and it is one flag away, and it is off, because this is Quake.
The engine's default is false as well, so nothing about the shipped picture rests on that argument —
but the argument is why this row does not follow the shadow row's "default to the good-looking one".

**Blur strength is the first quality slider this page has ever had, and the reason it exists is the
most hopeful thing in GAP-024.** `MotionBlur` is a newer subsystem than GTAO and SSR and was built
the other way round. The renderer owns one and hands it out — `get motion_blur()` — and the getter's
docblock is an instruction rather than a warning:

> The motion-blur subsystem. Configure it via `renderer.motion_blur.*` (currently `strength`);
> toggle the effect with `feature_motion_blur_enabled`.

`dof` has the same shape. The flag and the tuning are deliberately separated, both are public, and a
settings screen is plainly among the callers that was meant. That is exactly the shape GAP-024 asks
for, already in the package, for whatever the engine added most recently — so the gap is less "the
facade refuses" than "the older effects predate the pattern the newer ones use".

The range is the engine's numbers rather than taste. `1.0` is documented as physical, matching the
real per-frame pixel displacement, which at a shooter's frame rates is "deliberately subtle";
`2.0`–`3.0` is "a longer shutter", cinematic 180° on 24 fps source. The ceiling is 3 because that is
where the engine stops vouching for it: `strength` scales velocities inside the reconstruction pass
and does *not* rescale the TileMax/NeighborMax pyramid underneath, so past about 3 "samples beyond
the dilation reach can pick up unrelated velocities at silhouettes". A slider whose top third smears
the wrong pixels onto a moving player is not a quality setting.

The slider writes even while the effect is off, which is the opposite of what the render scale does
one section down, and the difference is who else owns the number. Nothing else writes `strength` —
there is no controller to take it back — so the greyed-out row is simply the one nothing is
currently reading, and the value is already right on the frame the toggle above it moves.

**What did not come through the door.** The quality behind the other three switches, and it is out of
reach twice over. The `GTAO` and `SSR` objects live in `Renderer.#postprocess`, a private field
with no getter — unlike `motion_blur` and `dof`, which have one each — so they cannot be reached
even with the renderer in hand. And their quality is a call argument rather than a property in any
case: `SSR.graph_pass` takes a `mip` ("higher mip = lower resolution trace") and
`graph_postprocess_bloom` takes an `intensity` and a `mips`, and `Renderer` calls all three of them
without. `DEFAULT_SHADOWMAP_LOCAL_RESOLUTION` is the third shape of the same thing: module-private,
as is the atlas size beside it.

So those rows are toggles rather than a Low / Medium / High, because a Low / Medium / High here
would be three labels over one boolean each, which is a worse control than the boolean. GAP-024 is
now specifically about presets for the older effects rather than about effects at all, and the page
footer was rewritten to say that smaller thing.

**What is verified.** In Node, against a fake renderer carrying `Renderer`'s own initialisers: that
`applyAll` pushes all of them rather than agreeing with the engine's defaults by accident, that
each toggles both ways, and that in Brick4 the reflections value is held, returned by `get`, and
still not written to the renderer — from `set` and from `applyAll` both. That the blur strength is
written while the effect is off, greys out with it, and clamps to 0.5–3.0 at both ends. And that the
page applies without a renderer at all, which is the null the `.d.ts` denies and the browser
produces.

End to end in the running application, reading the renderer's flags back on both lighting modes:

| | default map (Brick4) | `?gi=ibl` (IBL) |
|---|---|---|
| Ambient occlusion | writes `feature_ssao_enabled`, both ways | same |
| Bloom | writes `feature_bloom_enabled`, both ways | same |
| Motion blur | writes `feature_motion_blur_enabled`; strength reaches `renderer.motion_blur` | same |
| Reflections | row inert, control disabled, flag stays false | row live, flag follows the toggle |

The real checkboxes drive it, not just `Settings.set`; `ao=false, bloom=false` came back over a
reload out of IndexedDB and reached the renderer; and `reset()` puts all three back.

**What is not.** The picture. The preview browser runs this application in a hidden tab where
`requestAnimationFrame` never fires, so no frame has been drawn and nobody has looked at a room with
the occlusion off — or, for that matter, at a blur, which is the one of these that cannot be judged
from a still frame anyway. Every claim above is about the value of four booleans and a float on a
`Renderer`. The same limitation D-107 and D-108 recorded, and it still bounds this port's rendering
work.

---

## Phase 9 — one clock, and the game as meep systems

Phase 9 ran as two tracks against one worktree. The menu is the section above; this one is
`PLAN.md`'s, and the two share nothing but a number.

### D-110: The priority order inverted — exercise meep first, port Quake III second

Through phase 8 this port was "Quake III, faithfully, on meep". Where the two disagreed Q3 won, and
the engine evaluation came out of whatever that exercise happened to touch. From phase 9 it is
**exercise meep well first, produce a faithful port second**.

The maintainer decided this explicitly. It is recorded here rather than inferred from the diff
because every argument below is downstream of it and none of them can be re-derived from the code:
each one reads as an ordinary engineering choice until you know which way the tie-breaker points.

It was already half true when it was said. D-071 put Q3's motor on `KinematicMover` and retired
`PM_SlideMove`, `PM_StepSlideMove` and `PM_GroundTrace`, so movement departed the C in phase 5. Tick
rate was defending a boundary that had already moved.

**The frame is the engine's now.** The whole game ran on one `engine.ticker.onTick` listener: a
153-line closure holding nine named phases, its own per-phase exception guard, and four hand-rolled
time accumulators. `EntityManager` has every one of those mechanisms — a fixed step with a tick id,
an alpha, a catch-up cap, and per-system error isolation that reports by name — so running outside
it meant running outside the engine's ordering, its error isolation and its step. Simulation is now
six `System` subclasses on `fixedUpdate` (player, combat, pickups, bots, character bodies, movers)
and presentation is one on `update`; `main()` fell from 1045 lines to 573 in the commit that did it,
with no `try`/`catch` left in the frame path, and the match roster moved out to `app/roster.ts`.

Two of the four accumulators stayed, and the plan was wrong to list them for deletion.
`MoverSystem.accumulator` is not frame-rate compensation — it is the whole-millisecond carry that
keeps `level.time` an integer, which a 16.667 ms step needs exactly as much as a variable one did.
`Arena.trailAccumulator` thins the smoke trail; a fixed step removes its docblock's *reason* without
removing the rate control it provides.

**60 Hz, and 125 Hz was the fidelity answer.** `em.fixedUpdateStepSize` keeps the engine's default.
125 Hz was a real candidate: it is Q3's `sv_fps`, it is what `test/match.test.ts` and the phase-6
bench already use, and it would have collapsed the browser, the headless match and the C oracle into
one simulation. It was rejected because chasing `sv_fps` parity is precisely the argument this phase
stands down from, and because the engine's own default is the configuration the rest of the engine's
tuning assumes — which is the property being evaluated. The headless bench keeps its own rate, and
that the two differ is now a property of the bench rather than a divergence anybody has to explain.

**`pmove_fixed` was examined and deliberately NOT set**, which is the clearest case of the new order
deciding something the old one would have decided the other way. Q3's `pmove_fixed 1` with
`pmove_msec 8` chops a command into whole 8 ms sub-steps; at a 16.667 ms step that splits a 17 ms
step into 8 + 8 + 1, and that 1 ms tail is a real sub-step with its own friction and acceleration
pass — raggeder than the single uniform step that leaving it alone produces. It exists in Q3 so that
a client and a server agree on a prediction, and there is no server here. What replaced it is
smaller and better: `PlayerController` carries the sub-millisecond remainder rather than rounding it
away — the arithmetic `MoverSystem` has always used — so a step spends 16 or 17 whole milliseconds
and the sequence sums exactly. The rounding it replaced handed pmove 17 ms for every 16.667 ms step,
so the player's clock ran two percent fast against the movers, permanently, and nothing said so.
`test/fixed-step.test.ts` pins it: the same wall-clock time reaches the same origin and velocity to
the last bit whether it arrives in 45 frames or 180, every step spends 16 or 17 ms and nothing else,
and the mean lands on the engine's step size.

**REPORT.md was checked against this, and one row was stale.** The `trap_SnapVector` row said "part
of movement fidelity, not an optimisation — removing it changes strafe-jump speed", which describes
a thing the shipping game has not done since D-071: `snapVector` is called from
`src/q3/pmove/pmove.ts` and nowhere else, and `pmove.ts` is now the reference path behind
`?trace=clipmap` and the divergence harness. `MeepMove` never snaps. The row was describing the
oracle and calling it fidelity, and phase 9 makes it worse rather than better, because per-frame
rounding at 60 Hz is not the rounding Q3 does at 125. The note now says where `snapVector` lives and
what it is for; the disposition stays `ported`, because it is.

The rest of the document had already absorbed most of the change: the executive summary records the
maintainer reversing the brief's central constraint, and GAP-019 says outright that it is "no longer
load-bearing for this port at all". What phase 9 adds to that is the clock.

**What did not change.** The ported `bg_pmove` and `cm_trace` stay in the tree, bit-exact against the
WASM oracle, and `npm run divergence` still measures the shipping path against them. Fidelity is
still *measured* — it stopped being the thing that decides design questions. The distinction matters
for reading the rest of this file: an entry that says "Q3 does X and so does this" is a measurement,
and an entry that says "Q3 does X therefore this must" is now suspect.

**What it costs, named rather than discovered later.** Strafe-jump feel at 60 Hz is not Q3's at 125,
and `test/meepmove.test.ts` accordingly asserts a property — sustained speed meaningfully above the
320 `ps.speed` base, which can only come from `PM_Accelerate`'s projection — rather than a number
Q3 would produce. Anyone restoring `sv_fps` parity later changes one field, and should read the
paragraph on `pmove_fixed` before assuming the rest follows.

### D-111: Three meep physics bugs, found by this port, fixed in four releases — and the test shape that got the workarounds back out

The strongest engine-evaluation material this project has produced, and it exists because phase 9
stopped reimplementing around the engine and started driving it. Missiles became CCD bodies that
detonate on `PhysicsEvents.ContactBegin` (D-110's frame is what made that possible), which put this
port on the contact path for the first time. Three defects fell out of it inside four releases.

**1. A contact reported across a centimetre of clear air. Fixed in 3.6.0.**

3.4.0 and 3.5.0 dispatched `ContactBegin` between a sphere and a `ConvexHullShape3D` separated by up
to **0.01 m**, and handed the event a *positive* `depth` equal to the gap — where `ManifoldStore`'s
own layout comment says `depth (positive = penetration, negative = speculative gap)`. So neither the
event nor its payload distinguished a hit from a near miss, and in this game every brush of every
level is a `ConvexHullShape3D` while every missile is a sphere: a centimetre of phantom collision
around every surface in the world. It presented as a rocket detonating in mid-air 18 units in front
of the muzzle, down an open corridor on `oa_dm1`.

The tell was that the identical box built as a `BoxShape3D` reported nothing. `sphere_box_contact`
is a closed form that can answer "separated"; a convex hull falls through to GJK + EPA, and EPA run
on a simplex that does not enclose the origin returns a plausible axis and the separation as a
depth. It moved with where the sphere sat over the face, which is what a simplex-quality problem
looks like and is not what a wrong collider looks like — an exact eight-vertex box reproduces it.
The engine's own `convex_convex_manifold` header already records EPA as unreliable for polytopes and
routes hull-versus-hull around it with SAT; sphere-versus-hull had no such route.

The search cost more than the finding, and the negative results are the part worth keeping, because
each one was a plausible accusation against this port's own pipeline: the brush-to-hull conversion
is faithful (every hull vertex of all six shipped maps against its own brush's planes — worst escape
0.089 units, on `am_thornish`); `MAX_MAP_BOUNDS` being 1,048,576 where `cm_polylib.c` uses 65,536
produces no escaped winding points; hull triangle winding is outward on all 43,330 triangles and the
Q3-to-meep axis swap preserves orientation; and speculative contacts are not dispatched as
`ContactBegin` at all — a stationary sphere reports nothing at any positive gap, and one flying
*parallel* to a wall at 2,000 units a second reports nothing either, so the margin does not scale
with speed. Four wrong theories, every one of them about this repository, before the shape class
turned out to be the variable.

**2. `KinematicMover` pinned against geometry, and not grounded either. Fixed in 3.7.0.**

3.6.0's fix regressed the character solver: for one release a body pressed against geometry was
pinned with all velocity zeroed while reporting `grounded === false`, permanently. A strafe-jump
chain peaked at **140 units per second where it had peaked at 386**, and a player could hang in
mid-air indefinitely. Caught by `test/meepmove.test.ts` and, independently, by
`test/physics-wedge.test.ts`, which exists for exactly that failure — two tests written against two
different descriptions of "the player must keep moving", which is why the diagnosis took minutes.

Attributed by A/B against a scratch copy of the previous version rather than by reinstalling,
because `node_modules` is shared with other live sessions in this worktree. Worth remembering as
technique: in a shared tree, bisecting a dependency by installing it is a change to somebody else's
session.

**3. A contact against a corner that was never raised at all. Fixed in 3.8.0.**

Through 3.7.0, a body that CCD stopped against a hull's *corner* raised no contact event. Face-on it
did: the sphere is clamped at 15.5 units — the box's 15-unit half-width plus its own 0.5 — and
`ContactBegin` fires. At 45 degrees the same sphere is clamped on the same step at 21.71 units, the
box's own diagonal half-extent plus the sphere, and nothing is ever dispatched, for as long as you
keep stepping. A game that reacts to impacts never learns about one while the body sits there
blocked: ten of twenty-eight rockets in the 64-direction ring test ground against a player's
shoulder for their full ten seconds, doing nothing.

**The method is worth as much as the bugs.** `test/convex-contact.test.ts` asserts each defect's
*presence* rather than skipping it, and each assertion carries a message naming the code to delete
when it fails. An engine upgrade then breaks exactly one test, and the failure is the instruction.
Both of `src/client/Missiles.ts`'s workarounds came out that way — the file peaked at 522 lines and
is back to 421, with neither the confirming sweep nor the stopped-missile inference in it, and what
is left is the contact listener the design called for in the first place. A workaround should not
outlive what it works around, and the usual reason one does is that nothing is watching.

Two further properties of that file, both deliberate:

- **The regression test asserts both halves.** Separated shapes report nothing *and* overlapping
  ones still report at the right depth, in the same rig, at the same depths. A fix that removed
  every contact from the convex path would have satisfied the first alone and been far worse than
  the bug it replaced. A third case pins the property that identified the cause — that the old
  behaviour moved with where the sphere sat over the face — so the *diagnosis* is regression-tested
  and not only the symptom.
- **The corner case pins why its workaround was sound.** Both approaches were clamped on the same
  step, at their own correct geometric distances, whether or not either said so. The sweep was never
  at fault; the defect was in the reporting. That is what made "a `TR_LINEAR` missile that covered
  less than its own speed in a step has hit something" an inference from the engine's own behaviour
  rather than a guess.

**Neither workaround could have been left in as insurance**, and that is not obvious.

The confirming sweep — re-run the segment the missile just flew, detonate only if it really reached
what the contact named — asks the wrong question of a *grazing* hit. A missile touching a body at
depth zero while moving along its surface has CCD clamp the blocked axis while the rest of the
velocity carries on, so the swept segment never enters the thing it is already resting against. It
rejected **ten of twenty-three real hits**. A check that asks "did it arrive" cannot recognise a hit
that has already arrived. Keeping it as insurance would have traded a bug the engine had fixed for
one only this repository could produce.

The `ColliderFlags.IsSensor` on the missile's collider stays, and is not a workaround: `TR_LINEAR`
means nothing ever pushes a missile off course. That it also made a phantom contact harmless to the
solver was a side effect, and is not why it is there.

**What this says about the evaluation.** REPORT.md's executive summary already argued, from the
`raycast` bug fixed in 3.2.0, that a consumer who reimplements rather than adopts stops being able
to find your bugs — three sessions of building character movement on `shape_cast` found no engine
defect, and half an hour of running the engine's own solver found one. Phase 9 is the same
experiment at a larger size, with the same result: adopting the contact and CCD paths, in a game
that fires several projectiles a second, found three defects inside a single day of using them —
the four commits from "missiles are bodies" to "3.8.0 raises the corner contact" span nine hours. The
repros are BUG-14, BUG-15 and BUG-16, each a bare `EntityManager` with two bodies and no map data.
None of them needed *this port* to find; all of them needed somebody to use the path.

### D-112: Two bugs of this port's own, found by the tests the new facilities needed

Both are the same shape, and it is worth naming: code that was correct under the old arrangement and
silently wrong under the new one, where "silently" means the game still ran and nothing was logged.

**`MoversView` skipped writing a mover whose origin had not changed.** An obvious saving, and it
cannot survive interpolation. Between fixed steps the drawn transform holds a *blended* pose written
by `InterpolationSystem`; skipping the write because *this* code did not change the origin leaves the
blend standing, the pose recorder snapshots the blend as the next truth, and a stopped door walks
away from itself — a quarter of a unit in four steps, measured before the early-out came out. The
saving was never real either: `Vector3.set` compares before it assigns and only dispatches
`onChanged` on a genuine difference, so the skip was the engine's own check written a second time,
with the added effect of hiding a correction the engine would otherwise have made. Found by
`test/interpolation.test.ts` asserting that a resting producer does not drift.

**`PhysicsTrace` passed `undefined` as its query filter.** meep's queries consult the filter callback
and nothing else — `shape_cast` never looks at `layer`, `mask`, or the sensor flag — so `undefined`
means "everything in the broadphase blocks". Harmless for as long as the only bodies in the world
were the level's. The moment characters had colliders it became severe: `PhysicsTrace` answers
`pm->trace`, a bot's line of sight and an item's drop to the floor, and every bot's line of sight now
terminated on the bot's own collider, so no bot ever saw the player again. `PhysicsTrace.ignored` is
the fix, and missiles are in it too.

**The instructive part is that the second one was predicted and shipped anyway.** `PLAN.md` named
both `undefined` filter sites before any of the work started — "the moment a character or a missile
has a body, those two `undefined`s are bugs. This is a prerequisite, not a detail." Step 5 fixed the
`MeepMove` site, by hanging the filter on `MoverHost` so that the game classes never learn what an
entity is. The `PhysicsTrace` site was missed, and stayed missed until `test/match.test.ts` was wired
to run the whole arrangement — character bodies, missiles, and the engine's step inside the match
loop — at which point no bot could see past its own collider. Reading the engine identified the
defect; only running the thing found it, and the cheap protection is the one now in place: the
headless match runs what the browser runs.

Neither would have been found by looking at the running game, which is the same lesson as REPORT.md's
item 16 arriving from a third direction. A quarter of a unit of drift on a resting door is invisible,
and bots that cannot see are bots that look busy.

### D-113: Glass is a transparent interface, and which surfaces are one is a list rather than a rule

`StandardShadeMaterial` carries `transmission_factor` and `ior_factor`, and nothing in this port
had ever set either. Every surface in every map therefore sat on meep's defaults — transmission 0,
IOR 1.5 — which is to say every dielectric in the game reflected exactly as much as plate glass,
and nothing was a transparent interface at all.

**What `am_thornish`'s windows actually were.** `textures/dsi/dsiglass` is one `blendfunc add` pass
of `textures/effects/tinfx` through `tcGen environment`, over a `$lightmap`. Q3 for "a clear pane
with a chrome reflection on it". The projection read that additive pass through D-079 — luminance
becomes coverage, an additive stage over nothing else is a glow map — and produced a black diffuse
at a constant alpha, plus an emissive of the environment map, flattened to its mean colour by the
`environmentMapped` writers, at `UNLIT_LUMINANCE`. So the pane was a uniform luminous grey film
whose brightness did not change with the angle you looked at it from, which is the one thing glass
does. And the film *was* the fake reflection: the port was drawing as paint the thing the renderer
can now compute.

`transmission_factor` is the fix and it is exact. The diffuse base drops out
(`diffuse_weight = (1 - metallic) * (1 - transmission)`) and coverage becomes view-angle Fresnel
instead of the albedo's alpha, so the surface is nearly invisible head-on and a bright reflection at
a glancing one. `ior_factor` sets how bright: `F0 = ((n - 1) / (n + 1))^2`.

**Why the set is hand-listed.** The structural rule is obvious and it does not work. "Blended, and
every drawn stage `tcGen environment`" — a see-through surface whose whole content is a fake
reflection — describes `dsiglass` exactly, and describes 31 shaders in the OA set. Twenty-five of
them are powerup shells: quad, battlesuit, regen, invisibility, the kamikaze sphere, the four
health-cross shells. Zeroing their diffuse and handing their coverage to Fresnel is the correct
treatment of a window and the deletion of a powerup. Narrowing it with `$lightmap` — world geometry
the light compiler lit — cuts 31 to two, of which one is `textures/sfx/proto_zzztblu3`, and it drops
the genuine glass in `textures/pulchr/pulglass`, which is `nolightmap`. Measured, not guessed at:
those are counts over the 1960 unique shaders in the corpus.

So `TRANSMISSIVE` is a table, the same instrument as `tools/material-classification.json` and for the
reason that file already gives — Q3 had no notion of transmission, a name-shaped guess is wrong
often enough to look like a bug, and a table checked against the artwork is not a heuristic. Absence
means transmission 0, which is the legacy alpha-blend path every one of these surfaces was already
on, so an unlisted shader is unchanged rather than wrong. It holds two panes of glass and the eight
`clear_*` pool shaders.

**The IOR is the part that is real data.** `surfaceparm water` is Q3 recording what the liquid *is*,
and the refractive index of water does not depend on whether the mapper drew it clear or brown, so
that one is read off the shader: 1.333, F0 = 0.020, against glass's 0.040. `surfaceparm lava` has to
veto it, because five shaders in `liquid_lavas.shader` — `lavahell` and its three variants, and
`lavalol` — declare `surfaceparm water` beside `surfaceparm lava`. That pairing means "a liquid
volume you can be inside of", not "this liquid is water".

**Roughness had to come with it.** A blended material is owed no generated ORM, so its `roughness`
*is* the number the renderer uses rather than a multiplier over a sampled one, and the 0.85 default
was chosen for concrete and painted metal. On a window it is frosting. It also decides how broadly
the room's lights smear across the pane, and with no screen-space reflections that direct highlight
is most of what sells the surface — at mirror smoothness it is a pinpoint nobody ever stands in line
with. Each entry states its own, in the 0.15–0.2 band: 0.2 for glass, 0.15 for calm water and 0.2
for rippled, the latter carrying what is left of a `deformVertexes wave` this projection drops.

**And the additive pass stays, which took a wrong turn to establish.** The first version of this
dropped it, reasoning that on a window the additive pass is a reflection, a reflection is not a light
source, and keeping it alongside `transmission_factor` would draw the reflection twice — once as
physics and once as paint. The second half of that is false on these maps, and the correction below
is where the reasoning is.

**What is deliberately left alone.** The tinted and murky waters stay on the alpha-blend path, which
is what meep's own note says to do without a per-channel transmission tint: making
`acc_dm5/brwnwater` transmissive would throw its brown away and leave clear water in a mud pit. It
takes the water IOR and nothing else. `acc_dm5/watershore` and `acc_dm5/fx_waterfall` have `water` in
their names, declare no `surfaceparm water`, and are the foam and spray sprites — the one part of
water that genuinely is diffuse rather than an interface. They are the reason the test names its
water instead of matching it.

**The size of it.** Across the shipped six, two materials became transmissive — `dsi/dsiglass` on
`am_thornish` and `liquids/clear_calm1` on `am_thornish` and `oa_dm7` — and three took the water
index. Nothing else in any bundle moved at all. Verified on the running app rather than argued: the
live `StandardShadeMaterial` for the glass reads `transmission_factor: 0.6`, `ior_factor: 1.5`,
`roughness_factor: 0.2` with its emissive intact, while `textures/sfx/beam` beside it is untouched at
0 / 1.5 / 0.85.

#### The correction: transmission 1 is right, and it made the windows disappear

The version first committed set `transmission: 1` for glass and clear water and deleted their
emissive. Loaded, `am_thornish`'s panels were not subtle — they were *gone*, nothing visible at all
where the glass should be. Three facts multiply out to that, and the third is the one that was not
checked:

- `opacity = mix(surface_alpha, F_scalar, transmission)`. At transmission 1 the coverage of a
  dielectric *is* its Fresnel term, and F0 = 0.04 looking straight at it.
- The OIT resolve premultiplies — `color * coverage` in `shader_oit_resolve_moments` — so coverage
  scales everything the surface shows, emissive included. There is no channel that escapes it.
- **There is no reflection for that 4% to show.** Every map with a baked light volume runs in
  Brick4, which is the common case and not the corner (D-107), and D-109 already recorded that SSR
  there is not merely off by default but *cannot be switched on* — the row refuses to be written.
  What is left is the ambient probe's radiance, which in a Q3 interior is dim.

So "the renderer now computes the reflection for real" — the argument for deleting the emissive —
was simply untrue on these maps. Deleting it removed the pane's only colour; transmission 1 removed
its only coverage. Between them the surface had nothing left to draw.

The fix keeps both halves and moderates each. The emissive stays, because it *is* the reflection
here, and transmission stops at 0.6 for glass and 0.5 for water so coverage keeps a floor while
Fresnel still carries the view dependence. `dsiglass`'s albedo is one texel at alpha 0.196, so the
pane now covers 10.2% of the background head-on and 67.8% edge-on, against a flat 19.6% before any
of this. Half as assertive as the original film when you look straight at it, three and a half times
as bright when you look along it — which is the difference between a grey sheet and a pane of glass.

The general lesson is the one D-077 already paid for once: a claim about what the renderer computes
has to be checked against the renderer that is actually running, and the renderer that is actually
running here is Brick4 on every map with a bake. The material was verified end to end and the
*scene* was not, because this app runs in a hidden tab where compositing is dead and screenshots
fail. Reading a material back proves plumbing; it cannot prove a surface is visible.

### D-114: `bg_itemlist` is wider than the weapon table, and the crossing between them is a function

Firing on `am_thornish` could end the frame with `TypeError: Cannot read properties of undefined
(reading 'hitscan')` inside `WeaponSystem.fire`. The weapon in hand was `WP_NAILGUN`, picked up
thirty seconds earlier, and `balance.weapons` has no nailgun.

**Two lists, treated as one.** `WeaponId` is `keyof typeof balance.weapons` — eleven weapons, each
with a fire rate and a damage figure extracted from the OA sources. `balance.items` is
`bg_itemlist`, and it holds *thirteen* `IT_WEAPON` entries: the eleven, plus `weapon_nailgun` and
`weapon_grapplinghook`. Item tags are strings from a map's entity lump, so the two sets met at a
cast — `player.selectWeapon(event.selectWeapon as typeof player.weapon)` in `PickupSystem` — and a
cast is an assertion that nothing checks. `am_thornish` places two nailguns; walking over one
autoswitched to it, `weaponStats` returned `undefined` while promising a `WeaponStats`, and the next
click dereferenced it.

**The two missing weapons are missing on purpose.** `extract-balance.mjs` reads numbers rather than
transcribing them, and there are no numbers to read for either. `fire_nail` draws a fresh random
speed per nail — `scale = 555 + random() * 1800` — and fires fifteen of them, which is neither the
single-projectile shape `projectile()` extracts nor a thing a `speed` field can hold. The grappling
hook has no damage, no splash and no fire rate worth the name; it is a movement device wearing a
weapon's slot. Giving either one invented numbers to keep a table square is the failure mode this
port has avoided everywhere else.

**So the fix is the crossing, not the table.** Three changes, one job each:

- `isWeaponId(tag)` is the only sanctioned way for an outside string to become a `WeaponId`, and it
  asks the same table the type is derived from.
- `PickupEvent.selectWeapon` is now `WeaponId | null` instead of `string | null`, which it can only
  promise because `give` narrows through `isWeaponId`. The cast in `PickupSystem` is gone, and
  nothing replaced it.
- `weaponStats` throws on an id it has no entry for, naming the weapon. It should now be
  unreachable; if some later path gets past the guard, the failure says which weapon has no numbers
  instead of reporting a shot that went wrong three frames later.

**What the player sees.** The nailgun is still picked up, still owned, still counted — `Pickup_Weapon`
runs as it always did, and the HUD is already total over an id it does not know. What it will not do
is end up in your hands. Q3 has no weapon it cannot hold and therefore has no rule to be faithful
to here; between "cannot hold it" and "crashes when fired", the choice makes itself.

The alternative considered and rejected was dropping the entity at spawn, so the map has no nailgun
at all. It is tidier for exactly one frame and worse afterwards: `ItemSystem.spawn` already treats a
missing pickup as a thing a level designer would notice (that is why an item that falls out of the
world is dropped and *logged*), bots would stop routing to a pad that visibly has something on it,
and the port would be editing the map rather than admitting a gap in itself.

Pinned by `test/items.test.ts`: the nailgun specifically, and then the rule over the whole item
table — every `IT_WEAPON` that can be autoswitched to must answer `weaponStats` — so a weapon
arriving in a future extraction fails in the suite rather than mid-match.

### D-115: the muzzle flash belongs on `tag_flash`, and the light has to follow the gun that carries it

The flash light was drawn at the shot's own origin, which is `CalcMuzzlePoint`: the eye plus
fourteen units of `forward`. That is exactly right for a *shot* -- it is why a rocket does not spawn
inside the player's own bounding box -- and it is the wrong point for a *lamp*, because it is on the
view axis by construction. Whichever way the player faced, the light sat 44 cm dead ahead at eye
height, so firing lit the room from the middle of the screen and the gun in your hands threw nothing
at all. The report was "the muzzle flash light seems to be centered on the player", and it was.

**Q3 has the point already, and it is on the model.** `CG_AddPlayerWeapon` builds a flash entity,
puts it on the weapon model's `tag_flash` with `CG_PositionRotatedEntityOnTag`, and adds the dlight
at `flash.origin`. The pipeline already converts every tag on every model -- that is how
`ViewWeapon` finds `tag_weapon` on the hands model -- so the muzzle was in the bundle the whole
time and nothing was reading it. Nine of the eleven weapons carry one; measured from the eye, it
puts the machinegun's flash 0.72 m forward, 0.18 m down and 0.18 m right, and the shotgun's
0.91 m forward. Off the axis, below the crosshair, on the side the gun is drawn on.

Where it sits is measured, not chosen, for the same reason the gun itself is (see the header of
`ViewWeapon.ts`): these are points the people who made the models authored, and the alternative is
a number somebody picks that is wrong per weapon.

**It rides the gun rather than being dropped at it.** The first shape of this fix placed the light
once, at the tag, when the trigger was pulled. That is half a fix: the flash lives 50 ms, and 50 ms
at Q3's run speed is half a metre, so a light nailed to the world is a light the player runs *out
of* -- and a machinegun leaves ten of them a second strung out down the corridor behind a strafing
player. So the light is placed every frame of its life, from whichever `tag_flash` is in your hands,
which is what Q3 does and for the same reason: its flash dlight is re-added on every frame the flash
is up. That put the light in `ViewWeapon` -- the only thing that knows where the gun is this frame
-- rather than in `Effects`.

**Two shooters, two lights, one table.** Only the local player has a weapon model on screen; nothing
draws one for a bot, so there is no tag to hang anything on and their flash stays where it always
was. `WeaponEvents.muzzleFlash` therefore carries the `ownerId` the event always had to hand, and
`Arena` offers every flash to the gun first:

```ts
const onTheGun = ownerId === LOCAL_CLIENT && this.viewWeapon?.flash(weapon) === true;
if (!onTheGun) this.effects.muzzleFlash(originQ3, weapon);
```

Refusal is a real answer and not a formality. A dead player has no gun drawn, a weapon the bundle
has no model for is not on screen, and the gauntlet and OA's prox launcher ship no `tag_flash` --
all three decline, and all three still light something, because a shot with no flash at all is a
worse bug than a flash in the wrong place. Q3 lights the gauntlet from the player's own origin
anyway, which is within a few centimetres of where the fallback puts it.

**The per-weapon settings, and which column is Q3's.** `src/client/muzzleFlash.ts` is one table read
by both paths, so the player's plasma gun and a bot's cannot be different colours.

| column | where it comes from |
| --- | --- |
| `color` | `CG_RegisterWeapon`'s `flashDlightColor`, transcribed. Yellow for the three weapons firing the same round, blue for the plasma and lightning family, two distinct oranges for the launchers, `1, 0.7, 1` for the BFG. |
| `reachQ3` | the radius `trap_R_AddLightToScene` is given: 300 for the impulse flash every weapon gets, 150 for the three Q3 lights *continuously* while firing. |
| `lumens` | **chosen.** Q3's dlight has no brightness -- it is a colour and a radius, so every flash in the game is equally bright -- and this port's lights are photometric. GAP-011 again: "physically plausible" and "reads well" are different questions, and this is the second one. Scaled against the explosion's 12,000 lm, from the gauntlet's 140 to the BFG's 1,050 -- D-160 halved the whole column and D-161 halved it again, so every number D-115 first wrote here is four times the one now in the table. |

Two things are deliberately absent from that table.

**A source radius**, which is the column it would most like to have: a shotgun's blast is a
hand-sized ball of fire and a railgun's is a slit, and that difference is exactly what an area light
is for. meep's ECS `Light` has no field for it (GAP-030), so a value here would be a number nothing
reads. The workaround that exists -- reaching past the component into `Scene.lights.elements`, as
`lightVolume.ts` does for a map's fixtures -- rebuilds the ECS-to-Shade association from *position*,
which is affordable once at load and not for a light that moves every frame and is created per shot.
Recorded rather than faked.

**`MUZZLE_FLASH_TIME`**, which is 20 ms in the C and 50 ms here. 20 ms is one frame at 60 Hz and
none at all if a frame runs long, so the faithful number turns a light that should read as a pop
into one that some shots have and others do not. The divergence is named at the constant rather than
buried at a call site.

Pinned by `test/muzzle-flash.test.ts`: that the light lands off the view axis on the side the gun is
drawn, that it is the weapon's *own* muzzle (a launcher and a shotgun light different points from
the same eye), that it follows the player for the whole life of the flash, that it goes out, that it
is one entity however many shots go through it, and that each of the three refusals falls back to a
world light. `presentation.test.ts` checks the other end: every weapon model in the built bundle
carries a `tag_flash` except the two named above, so a pipeline change that drops the tags fails in
the suite rather than putting the light back in the middle of the screen.

**What still needs eyes.** Everything above is plumbing and arithmetic, which is all this port can
self-verify -- the preview browser runs the app in a hidden tab where nothing composites (D-077,
D-113). Whether 1,260 lumens of yellow at 9.4 m reads as a machinegun is a judgement about a picture,
and the lumens column is the one to turn if it does not.

**And it was turned, once, by 30%.** The first set -- 800 to 6,000 -- was too bright in play, and
uniformly so rather than weapon by weapon, which is the outcome that argues the column was scaled
wrong and not authored wrong. So the whole of it came down by the same factor and the reach did not
move: the ratios between the weapons are the part that was right, and a per-weapon correction would
have thrown them away to fix a single number. This is the entry recording that the dial exists and
where it has been set, which is the only thing a decision record can usefully say about a judgement
made by eye.

### D-116: a projectile leaves the barrel, and gives up flying at the crosshair to do it

Rockets, grenades, plasma and the BFG were all created at `CalcMuzzlePoint` -- fourteen units
straight out from the eye. That point is *inside the player's own bounding box*, which is what it is
for: a projectile born there cannot be born in a wall, and D-115 records the same fact from the other
side. What it is not is the end of the gun. A rocket appeared out of thin air in the middle of the
screen, half a metre behind and above the launcher that was supposed to have fired it, which is the
same complaint the muzzle flash had and the same tag answers it.

**Where.** `barrelOffset` in `ViewWeapon.ts` adds `tag_flash` to `tag_weapon` -- the gun hangs off
the hands model, the muzzle hangs off the gun -- and states the sum in **Q3's own axes**, forward /
right / up, because the consumer is `WeaponSystem` and that class must not learn about the camera's
frame or the model's. Three frames meet in one line and only the arithmetic says so; that line has
its own test.

| weapon | forward | right | up | miss |
| --- | --- | --- | --- | --- |
| grenade launcher | 21.5 | 5.8 | -4.9 | 7.6 |
| rocket launcher | 26.7 | 5.7 | -8.0 | 9.9 |
| plasma gun | 22.2 | 5.8 | -3.6 | 6.8 |
| BFG | 24.2 | 7.1 | -9.2 | 11.6 |
| prox launcher | -- | -- | -- | -- |

**The trade, which is real and was accepted deliberately.** The projectile still flies along
`forward`, and it now starts off the aim ray, so its path is *parallel* to that ray rather than on
it. It no longer goes where the crosshair is.

The saving grace is in the last column: because the paths are parallel, **the miss is a constant and
not an angle**. It is the same 9.9 units for a rocket at ten feet as at a thousand, where a
convergence error would grow without bound. Against a rocket's 120-unit splash radius that is 8% of
the blast, and against a player's 30-unit width it is a third of a body. Where it will be felt is the
plasma gun at long range -- 6.8 units of miss against a 20-unit splash -- and shooting through a gap
the crosshair clears and the barrel does not.

**Aiming at the crosshair instead was considered and rejected.** Spawning at the barrel and
converging on whatever the aim ray hits fixes the miss and buys three worse problems: the shot's
direction becomes a function of the *geometry behind the crosshair*, so the same click fires
differently at a near wall and at open sky; the convergence angle grows without bound as the target
gets closer, so a rocket fired at something a metre away leaves the gun visibly sideways; and it
costs a world trace per shot to decide any of it. Q3 does not converge and neither does this.

**Hitscan is not moved, and that is the point of putting the offset on `fire` rather than on the
muzzle.** A railgun shot from the barrel would land 5.7 units right and 8 low at every range, and a
hitscan weapon is the one place in this game where the shot has to go exactly where the dot is.
`CalcMuzzlePoint` therefore remains the origin of every traced shot and the point the muzzle flash
event reports; only the projectile branch reads the barrel.

**The sway is not in it either.** `barrelOffset` is the gun *at rest* -- a pure function of the
bundle, not of the pose `ViewWeapon` drew this frame. A spawn point that read the live pose would
make a projectile's flight a function of `weaponSway`, which runs on a render-rate clock, and that is
a rendering flourish reaching into the simulation. The drawn barrel and the fired one differ by up to
about five centimetres during a run, which is a distance nothing in this game can measure.

**And the barrel has to be reachable.** This is the one piece of machinery the fix needed:
`CalcMuzzlePoint` is inside the player's hull and open by construction, and a rocket launcher's
`tag_flash` is twelve units past the front face of that hull, where a wall can be. A missile born in
solid detonates on nothing and puts its blast through the surface. So `projectileOrigin` traces from
the safe point to the barrel and uses the safe point if the world is in the way -- binary rather than
a lerp and an epsilon, because the correction only fires when you are jammed against geometry and
what it gives up is thirteen units of a shot that is about to hit that wall anyway.

**Who gets one is the caller's decision**, which is how "only the shooter with a model on screen"
is expressed without `WeaponSystem` learning who the local player is. `main.ts` passes an offset;
`roster.ts` fires the bots and passes nothing; every headless test passes nothing and gets Q3's
behaviour unchanged. The prox launcher passes nothing too, for the reason D-115 already named -- OA's
model ships no tags at all.

Pinned in two places, because the change is in two: `first-person.test.ts` owns the offset's
arithmetic -- the sum, the three frames, the constant miss, and that every projectile weapon but the
prox launcher has one -- and `missiles.test.ts` owns what the simulation does with it: the spawn
point, the unchanged spawn when nothing is passed, the fallback when the barrel is in a wall (set up
by measuring where the wall is rather than by a hand-picked coordinate), and a railgun that still
hits what it points at when handed an offset it must ignore.

### D-117: an impact mark is chosen by the weapon, and two of the four this port ships had never been drawn

Every hitscan shot left the machinegun's pockmark and every detonation left the rocket's burn,
whatever fired them. A railgun slug scarred a wall like a bullet, a plasma bolt scorched it like a
rocket, and the lightning gun's hole and the plasma scorch — `hole_lg_mrk` and `plasma_mrk`, both
converted by `convert-fx.ts`, both in the shipped bundle — were never once put on a wall.

**Q3 has a table and this port had a habit.** `CG_MissileHitWall` is one function for a bullet and
for a rocket alike, and the first thing it does is `switch (weapon)` over a `mark`/`radius` pair:
bullet at 8 for the machinegun and the chaingun, 4 for a shotgun pellet, burn at 64 for the three
launchers and 32 for the BFG, `plasma_mrk` at 24 for the railgun and 16 for the plasma gun,
`hole_lg_mrk` at 12 for the lightning gun and the nailgun — and for `default:`, which falls straight
into `case WP_NAILGUN` with no `break` in between. That table is now `MISSILE_MARKS` in `Effects`,
transcribed, and `first-person.test.ts` states it a second time from the C so that a table checked
against itself cannot pass however it is edited.

**Which meant the weapon had to reach the presentation.** `WeaponEvents.bulletImpact` and
`.explosion` did not carry it — the mark was inferred from which of the two events fired, which is
exactly the two-way split that produced two marks. Both now take a `WeaponId`, which is the same
argument `CG_MissileHitWall` takes and for the same reason.

**And the mark came out of the explosion.** `Effects.explosion` used to draw one itself, which is
why it needed a surface normal it had no other use for and defaulted that normal to straight up.
Q3's shape is: build the fireball, then call `CG_ImpactMark` as a separate act. So
`Effects.impactMark` is that second act, `Effects.explosion` is the first, and `Arena` is where they
are put back together, because it is the only layer that knows both the weapon and the surface.

Two consequences worth stating, both of them Q3's answer rather than a simplification:

- **No surface, no mark.** A missile that stopped on a player carries no normal, and
  `CG_MissileHitPlayer` draws blood and a spark and calls no `CG_ImpactMark` — Q3 marks walls and
  never marks people. The old up-vector fallback stamped a scorch on whatever floor was under the
  body.
- **A death detonation is not an impact.** It is this port's own invention (nothing struck
  anything), so it is `Arena.deathExplosion` rather than a call to `explosion` with a made-up
  weapon. Unifying it also removed an `impact/rocket` that played on the *player's* death and on
  nobody else's, because the two death sites reached the same explosion through different doors.

The alphas are this port's and not Q3's, and `ImpactMark.alpha` says so where it is declared: the C
stamps at full strength and fades the mark out over its ten-second life, while these decals are
retired oldest-first at a cap of 2048 and never fade, so the alpha is standing in for the fade.

### D-118: a rocket, a grenade, a plasma bolt and a BFG shot were the same orange box

`Arena.projectileSpawned` put one `BoxGeometry(1, 1, 1)` on every missile the game fires, scaled to
eight units and tinted with an orange emissive. Five projectile weapons, one cube. The report was
"many projectiles appear as a box, no proper geometry", and there was nothing more to it than that.

**The models were in the pk3s the whole time.** `CG_RegisterWeapon` names one per weapon —
`models/ammo/rocket/rocket.md3`, `models/ammo/grenade1.md3`, `models/weaphits/bfg.md3`,
`models/weaphits/nail.md3`, `models/weaphits/proxmine.md3`, `models/ammo/hook/hook.md3` — and the
asset pipeline had simply never been told to convert them, because the only list it read was
`bg_itemlist`, which names the gun on the floor and the box of ammunition and says nothing about
what comes *out* of the gun.

So `extract-balance.mjs` now reads `cgame/cg_weapons.c` as well, scoped to each `case WP_*:` block
the way every other regex in that tool is scoped to a named function, and emits `missileModels`
keyed over the whole of `weapon_t` (also extracted, from `bg_public.h`). One table, from the C, that
both `convert-models.ts` and the runtime read — a path is exactly the kind of string this project
does not retype, because a typo in either half is a projectile that silently does not draw.

**Absence is a real answer and is recorded as one.** Six of thirteen weapons come back `null` because
they are hitscan. The seventh is the plasma gun, whose `missileModel` line is *commented out* in the
C: `CG_Missile` returns early for it with `reType = RT_SPRITE`, `radius = 16` and
`plasmaBallShader`. The extractor's regex is deliberately not multiline-anchored past a `//` so that
it reads the comment as the absence it is, and `MissileView` gives that one weapon a `Sprite` — on
the missile's own entity, which already has the `Transform` a sprite needs, so the sprite path is
the cheaper of the two rather than a special case that costs something.

> **Superseded in part by D-130.** The extraction above is unchanged and is what still routes the
> plasma gun away from the model path; what that route now builds is an emissive sphere with a point
> light in it rather than a `Sprite`, and `SpriteSystemPE` is no longer registered.

**Why a missile needs more than one entity.** An ECS entity holds one `ShadedGeometry`, and these
models are not one surface: `rocket.md3` is a body, a thrust flare and a rocket flare, and
`bfg.md3` is *entirely* two additive surfaces with no solid part at all. Drawing only the first
mesh would have drawn a four-vertex flare and called it a BFG shot. So each surface is its own
entity, attached to the body by `TransformAttachment`, and `TransformAttachmentSystem` is registered
for it.

That system rather than a loop in the game's own tick, for one reason: it *subscribes* to the
parent's `Transform` instead of polling it. A missile carries `Interpolated`, so its transform is
rewritten between fixed steps by `InterpolationSystem`; a child updated once per fixed step would
snap along behind a parent that glides. Subscribing inherits the smoothing for nothing.

The attachment is spatial and **not** a lifetime relation — meep is explicit about it — so when the
body is retired the component is dropped and the child stands still, which is a rocket model left
hanging in the air at the site of every explosion. `MissileView.despawn` is what stops that, called
from `projectileGone`, which fires however a missile leaves. `missile-view.test.ts` pins the engine's
behaviour here as well as this port's, because a registration is the kind of change that is either
completely right or completely absent and the absent version has no symptom in this port's own code:
the entities are built either way and the models simply never move.

Orientation is ported and the spin is not. `CG_Missile` writes the normalized velocity straight into
`ent.axis[0]` — a converted model points +X down its own length, which is the same fact `ViewWeapon`
turns a gun by, so `MODEL_TO_VIEW` is now exported and shared rather than written twice.
`RotateAroundDirection(ent.axis, cg.time / 4)` is left out: it is a rotation per missile per frame
written into the transform `InterpolationSystem` rewrites between steps, and what it buys is a barrel
roll on a shape that is very nearly a surface of revolution. A `TR_LINEAR` missile never changes
direction, so the orientation is read once at the launch and is right for the whole flight.

Two new materials came with the models and are classified in `material-classification.json`:
`models/ammo/` and `models/weaphits/`, both metal. A third, `models/weaphits/proxlite`, joins
`bfgtube` in `OPAQUE_BY_DESIGN`: its stage is `blendfunc gl_dst_color gl_src_color`, a multiply
against what is already there that takes no alpha from anywhere at all, so there is nothing the image
could have been authored with. It draws as a solid emissive patch on the mine's casing, which is
close enough to the lit panel the multiply was for.

### D-119: the nailgun's numbers were in the C all along, in a shape the extractor could not read

D-114 recorded that `bg_itemlist` has thirteen `IT_WEAPON` entries and `balance.weapons` has eleven,
and chose "cannot hold it" over "crashes when fired" for the two that were missing. That was the
right call for the bug in front of it and it left a weapon on the floor of `am_thornish` that could
be walked over, counted in the inventory, and never once held — which is what "the nailgun does not
draw in first person" is, from the player's side.

**The claim that there were no numbers to read was wrong about the nailgun.** Every one of them is
in the sources:

| | | |
|---|---|---|
| damage 20 | `bolt->damage = 20` | `fire_nail` |
| 15 per shot | `NUM_NAILSHOTS` | `g_weapon.c` |
| spread 500 | `NAILGUN_SPREAD` | `g_missile.c` |
| speed 555 + random()×1800 | `scale = 555 + random() * 1800` | `fire_nail` |
| 1000 ms | `addTime` | `PM_Weapon` |

What was true is that `projectile()` — the helper that lifts a missile weapon's four numbers — could
not read them. Three of its regexes look for `bolt->splashDamage` and `bolt->splashRadius`, and a
nail is a dart that does not explode, so it *throws* rather than returning a wrong answer. The
fourth looks for a literal in `VectorScale(dir, N, ...)`, and the nailgun's is a variable holding a
fresh draw. So the honest statement is not "there are no numbers", it is "this helper cannot read
this weapon", and the fix is a per-weapon extraction beside the helper rather than a helper that
guesses.

**Two things in `WeaponSystem.fire` had to stop being hitscan-only.** The pellet count and the
spread cone were read inside the `if (stats.hitscan)` arm, because the only weapon that fired more
than one of anything was the shotgun. `Weapon_Nailgun_Fire` is a `for` loop of fifteen `fire_nail`
calls, each a *projectile* with its own draw from the cone, so both moved out and the loop now
covers both paths. `stats.speedRandom` is the nailgun's alone and is zero elsewhere, so the
per-projectile speed draw collapses to the constant and no other weapon changes.

The speed draw is inside the loop rather than outside it, and that is the point of the weapon: the
nailgun is the only thing in Q3 whose projectiles travel at different speeds, and it is what turns a
burst into a spray that stretches out along its own axis instead of a rigid wall. `SnapVector` is
kept for the same reason it exists — a nail travelling at a speed the C would never have produced is
a difference nothing downstream can put back.

**And the wheel could not reach three weapons, which is the same symptom from a different cause.**
`WEAPON_ORDER` in `PlayerController` was nine names written out by hand, stopping at `WP_BFG` —
where the *original* Quake III's list stops. `weapon_t` has four more, and `am_thornish` places three
of them: the nailgun, the prox launcher and the chaingun. Picking one up autoswitched to it, as
`Pickup_Weapon` does, and then nothing could switch back to it — so the second time you held a
chaingun was never. It is now `weaponOrder` (extracted from `bg_public.h`) filtered by `isWeaponId`,
which leaves out exactly the grappling hook: not a damage weapon, no numbers in `g_weapon.c` to read,
and nothing here to fire. The number row still stops at nine, because Team Arena added
`weapon 10`..`weapon 13` as console commands and bound none of them; inventing a key would be
inventing a binding rather than porting one.

`items.test.ts`'s "never autoswitches to a weapon outside the balance table" now uses the grappling
hook, which is the only remaining instance of the rule D-114 wrote — a guard with no live example is
not a test.

### D-120: a contact normal has a side, and reading it without one threw away every missile scorch mark

Rockets, grenades, plasma and the BFG left no mark on the wall they hit. Bullets did, explosions
lit the room, the smoke and the fireball were there, and the decal — the one thing that outlives
the effect — was silently absent.

**The normal arrived pointing the wrong way.** meep canonicalises a contact pair as `(min, max)` by
entity id and documents the payload's normal as pointing *from `entityB` toward `entityA`*.
`Missiles.impact` already reads the side to work out what was hit — `payload.entityA ===
flight.entity ? entityB : entityA` — and then passed `payload.normal` on untouched, as though it
were side-independent. It is not. A missile is built mid-match and the level's bodies are built at
load, so the missile is the higher id and therefore `entityB` essentially always, and the normal it
carried pointed *along the flight*, into the surface. Against the ported `cm_trace`'s own answer for
a rocket fired down +x on `oa_dm1`: the clipmap says `[-1, 0, 0]`, and this reported `[+1, 0, 0]`.

**Why nothing said so.** `Effects.mark` builds a decal that projects along its own +Z and takes its
outward direction as the opposite, and `chunk_decal_surface_frame` fades the result by
`smoothstep(0.35, 0.6, dot(face_normal, outward))`. For a mark projected from *inside* the wall it
is drawn on that dot is -1, the fade is zero, and the composite discards the fragment. There is no
error and no warning, because a fade reaching zero is also how a decal grazing a wall at a shallow
angle is skipped — the same trap D-093 fell into from the other direction, and the one the docblock
in that chunk is written to warn about.

The fix is one sign, derived from the side rather than assumed: `+1` when the missile is `entityA`
and the normal already points away from the surface, `-1` when it is `entityB`. Reading the side is
the point. The id ordering that makes a missile `entityB` is an allocation accident, and a rule that
merely happens to hold is a rule that stops holding the first time a body is created in a different
order.

Pinned in `test/missiles.test.ts`, which already fired a rocket at a wall and asserted the normal
was *not null* — true of the wrong vector as much as the right one. It now dots the reported normal
against the ported `cm_trace`'s plane normal for the same shot and requires better than 0.9.

Numbered 120 rather than 116, which is where it was written: two sessions took the same next
number on the same afternoon and D-116 went to the barrel offset, which six code comments now
name. Renumbering the one nothing points at is the cheaper of the two corrections.

### D-121: OpenArena's `vulcan_hand.md3` holds the chaingun behind your eye, and a hands model that cannot be used is one that did not load

The chaingun was picked up, selected, built, linked and reported by `drawnWeapon`, and there was
nothing on screen. D-119 had just made two other weapons reachable and this one came back anyway,
which is what made it worth measuring rather than guessing at.

**The tag is the whole of it.** `CG_AddViewWeapon` draws a hands model at the view origin and hangs
the weapon off its `tag_weapon`, so that tag *is* where a first-person weapon sits. Measured across
all thirteen, from the bundle:

| weapon | forward | right | down |
|---|---|---|---|
| machinegun, shotgun and the seven that fall back to it | 6.16 | 5.83 | 7.80 |
| rocket launcher, prox launcher | 11.92 | 5.78 | 11.78 |
| BFG | 5.70 | 7.09 | 13.22 |
| **chaingun** | **-4.68** | **0.66** | **9.23** |

Twelve of thirteen are 5.7 to 11.9 units in front of the eye and 5.8 to 7.1 to the right of it. The
chaingun is 4.7 units *behind* it and barely off centre, and it is the same on all eleven frames of
`vulcan_hand.md3` — so this is not a frame-selection artefact, it is what OpenArena shipped. The
vulcan mesh is 19 units long about a centre 1.6 units behind its own origin, which puts the whole
gun behind the near plane and 9 units below a frustum whose half-extent at that range is about 2.
It was drawn correctly, at a place no camera can see.

**`CG_RegisterWeapon` has the right rule and asks the wrong question.** It falls back to
`shotgun_hand.md3` when `trap_R_RegisterModel` returns nothing — which covers a hands model that is
*missing* and not one that is *wrong*, and OpenArena ships this file, so the C uses it and Team
Arena's chaingun presumably looks like this in OpenArena too. `handOffset` now asks the question the
fallback was written for: a hands model whose `tag_weapon` is not in front of the eye is one this
cannot use, and it is skipped exactly as an absent one is.

The test is `forward > 0` and deliberately not a tolerance. It is not a judgement about how far
forward a gun should be — a weapon held behind your own eye is not a pose at all, every plausible
authoring mistake that produces one lands on the wrong side of zero, and the twelve that pass are
nowhere near it. `first-person.test.ts` pins both halves: the vulcan tag is still the broken one
(so the case has not silently stopped existing), and every weapon comes out in front of the eye and
in the right hand.

### D-122: the missile spin is not decoration, and skipping it was wrong for exactly the two models it was wrong for

D-118 ported `CG_Missile`'s aim — `VectorNormalize2(s1->pos.trDelta, ent.axis[0])` — and left out
its second line, `RotateAroundDirection(ent.axis, cg.time / 4)`, on this reasoning: it "buys a
barrel roll on a rocket that is very nearly a surface of revolution". The grenade launcher and the
prox launcher came back reported as launching "sort of sideways".

The reasoning was true of the two missiles it was written about and false of the two it was not.
`rocket.md3` and `nail.md3` are long and near enough axially symmetric, so a fixed roll is
invisible on them. `grenade1.md3` is a 14.6 x 10.9 x 5.9 slab and `proxmine.md3` is a 23.8-wide drum
on a vertical axis: held at one roll for a whole flight, both present a flat face to you and read as
an object turned side-on rather than one thrown at you. Q3 spins them because the artwork needs it,
and the two weapons that came back are precisely the two the argument for skipping it did not cover.

What was measured before changing anything, because "sideways" has more than one cause and the aim
was the obvious suspect: fired down Q3 +x, a grenade's velocity is `(700, 0, 0)` exactly, and its
drawn model's world frame is the identity — model +X on the flight, +Y on world up, +Z on world
right. The aim was already exact for every projectile weapon; the roll was the only part of
`CG_Missile` missing.

The roll is applied to each mesh's *local* rotation, composed on the right of the aim, about the
model's own +X — which is by construction the axis the aim put on the flight direction, so it cannot
move where the missile points. Composing it on the left would, and that is a mistake that looks
correct for one frame; `missile-view.test.ts` runs ten seconds of it at 60 Hz and requires the aim
to hold to six places. The rate is Q3's `cg.time / 4` degrees, which is 250 a second.

### D-123: a mark stamped at a third of full strength over four metres of wall is a mark nobody sees

Rocket and grenade hits were reported as leaving no decal, after D-117 and D-120 had between them
made every mark reach the wall correctly oriented. They did reach it. In a live match on `oa_dm1`
the dataset held 114 bullet marks, 40 plasma marks and 8 burn marks, every one of them positioned on
the surface with its outward normal pointing off it and its texture loaded.

**The burn mark was 27% grey spread over four metres.** `CG_ImpactMark`'s radius for a rocket is 64,
which this port turns into a decal box 128 units — four metres — across. `mark_burn`'s own peak
coverage is 197/255, and D-117 stamped it at alpha 0.35. The product is a barely-there smudge the
size of a doorway, which is exactly what "I still cannot see it" describes.

The 0.35 was not arbitrary and its docblock said so: `CG_MissileHitWall` passes `1,1,1,1` and lets
`CG_AddMarks` fade the mark out over its life, and this port had no fade — decals were retired
oldest-first at a cap of 2048, so every mark sat at full strength until it vanished, and a wall that
had taken a magazine at alpha 1 would be black. The fraction was standing in for a fade that had not
been ported, and it stood in badly.

So the fade is ported and the fraction is gone. `MARK_TOTAL_TIME` is 10 seconds and `MARK_FADE_TIME`
is the last 1 of them; the energy mark — `alphaFade`, which is the railgun's and the plasma gun's —
gets `CG_AddMarks`' own second ramp, `450 - 450 * (age / 3000)` clamped at 255, so it holds full
strength for 1.13 seconds and is off the wall at 3. Measured in the running game: stamped at 1.0,
plasma at 0.47 at 2.2 s while the burn beside it is still 1.0, both burn and bullet at 0.4 at 9.6 s,
and nothing at 10.2.

Two deliberate differences from the C, both recorded rather than hidden:

- **Everything fades its alpha; Q3 fades most marks' colour.** `CG_AddMarks` only alpha-fades the
  energy mark and drives every other mark's RGB toward black — which, under the
  `blendfunc GL_ZERO GL_ONE_MINUS_SRC_COLOR` those marks are drawn with, *is* fading out.
  `convert-fx.ts` already converts them to black-with-coverage, so one alpha ramp is the same
  picture and the only thing left to vary is how long it takes.
- **A mark is freed when it reaches zero, not when its ten seconds are up.** The C frees on the
  timer alone and lets an energy mark sit at zero alpha for the seven seconds between its own curve
  and the common one, which costs nothing there because a mark poly that draws nothing is skipped.
  Here it is a decal box the composite still walks, and invisible and gone are the same picture.

The 2048 cap stays, as a backstop rather than as the mechanism: what retires a mark is now its life,
and the cap is what stops a pathological second — fifteen nails and eleven shotgun pellets at once —
from running the count away before that life expires.

### D-124: one shot trail where Q3 has three unrelated effects, and the ray it is drawn along is not the ray that was traced

A hitscan weapon left nothing behind it. The ask was a line from the barrel to the hit that fades,
configured per weapon, with a short life — and the useful thing to say first is that **Q3 has no such
thing to port**, so what follows is which parts are the C's and which are this port's.

**What the C actually draws.** Three effects that have nothing to do with each other:

- `CG_Tracer`, for bullets. A **100-unit dash** starting at least 50 units out along the path,
  drawn for one frame, at `cg_tracerChance` 0.4, and skipped entirely for shots under 100 units.
  It is not a line from the shot's start to its end and it does not fade — it flickers.
- `CG_RailTrail`, for the railgun. A `LE_FADE_RGB` local entity from start to end over
  `cg_railTrailTime` 600 ms, in the shooter's own `color1`. This one *is* the thing asked for.
- `RT_LIGHTNING`, for the lightning gun: a beam re-added every frame for as long as the trigger is
  down. There is no lifetime in it to port, because the bolt exists exactly while it is being fired.
- And nothing at all for the shotgun or the gauntlet. `CG_ShotgunPellet` never calls `CG_Bullet`, so
  a pellet never reaches `CG_Tracer`; eleven lines out of one barrel is a cage rather than a shot,
  and Q3 evidently thought so too.

So the mechanism is one `Trail3D` stroke for all of them, and `HITSCAN_TRAILS` is the table that
makes them differ. Every number in it that the C has is the C's: `cg_railTrailTime`'s 600 ms, and
widths taken as diameters because the renderer's rail cvars are half-extents — `DoRailCore` extrudes
`±spanWidth`, so `r_railCoreWidth` 6 is a 12-unit beam, `RB_SurfaceLightningBolt`'s hard-coded 8 is
a 16-unit one, and `cg_tracerWidth` 1 is a 2-unit dash. What is this port's is stated where it is
written: the bullet's 60 ms life and the lightning gun's 50, the railgun's colour (Q3 takes it from
the shooter's `ci->color1` and this port has no player colours), and the decision to draw the whole
line for a bullet where Q3 draws a dash four times in ten. That last one buys a shot you can follow
back to whoever fired it, and costs a machinegun reading as a stream rather than an occasional
spark; the 60 ms is what keeps that a flicker.

**A stroke, not a wake.** `Trail3D` offers both and they are different components of the same
mechanism: `seed_trail_tube` collapses the knots onto a head and lets the entity's travel draw the
shape, while `seed_trail_stroke` gives the tube its whole shape at birth and only ages it. A beam
has no travel to lay itself down with — it arrives in the frame it left — so `make_gradient_stroke`
is the constructor, and `Trail3DFlags.Spawning` has to be off or the per-frame update drags the head
onto the entity and grows a tail towards it.

The gradient is the per-weapon shape and is the reason `ageFrom`/`ageTo` are in the table rather than
being one constant: an end seeded older fades first, so a bullet's source end starts three quarters
of the way through its life and the line retracts towards the target, which reads as a shot going
away from you. A rail beam is seeded new at both ends and fades as one, which is what `LE_FADE_RGB`
does to a whole local entity at once.

**The trail is drawn from the barrel; the ray was traced from the muzzle.** D-116 fixed hitscan at
`CalcMuzzlePoint` on the grounds that "a hitscan weapon is the one place in this game where the shot
has to go exactly where the dot is", and that stands — nothing here moves a ray. But a line drawn
from that point starts fourteen units in front of your eye, in mid-air, which is precisely the
complaint D-116 fixed for projectiles and is worse for a line than for a point. So `fire` now
computes the barrel for both paths: a projectile is *born* there, and a trail is *drawn* from there
while its ray keeps starting at the muzzle. Q3 takes the same liberty in the other direction —
`CG_RailTrail` opens with `start[2] -= 4` to move the beam off the ray because it reads better.

**Why a new event rather than an argument on `bulletImpact`.** A trail has to exist for rays that
raise no impact: one that stopped on a player leaves no mark (Q3 marks walls and never marks people,
D-117), and one that hit nothing at all never reaches an impact of any kind. A trail hung off the
impact event would vanish exactly when you shoot someone. `hitscanTrail` is therefore raised for
every ray, which also meant `hitscanShot` had to compute where the shot stopped in all three cases
rather than only in the one that leaves a mark — one lerp along `bestFraction`, which was already
the nearest of the three by construction.

One per pellet, so a shotgun raises eleven and the presentation drops all of them. That split is
deliberate: the simulation reports every ray it traced and has no opinion about what is drawn.

Bots get trails too, from `CalcMuzzlePoint`, because `roster.ts` passes no barrel offset — a bot has
no weapon model to read one off. Their shots therefore leave their eyes rather than a gun, which is
the same trade D-116 already recorded for their projectiles.

### D-125: a patch becomes many convex facets, because the query layer collides against convex hulls

Reported: `am_thornish`'s round columns are not colliders. They are not brushes — they are 520
`MST_PATCH` surfaces, and D-017 left those out of the collision entirely. Measured before the
fix: of the map's 18 round columns, a player box swept along the axis passed straight through
14, and `pointContents` at the centre of one returned `BOTCLIP|TRANSLUCENT` — a bot-navigation
hint the mapper wrapped around the column, in a 6-sided box, with no player-solid brush anywhere
near it. Nothing was broken in the brush path: all 756 of the map's player-solid brushes convert
to hulls with zero skipped. The columns were simply never offered to it.

**The obvious fix is wrong, and fails silently.** meep has `MeshShape3D`, which takes an
arbitrary triangle mesh, so the cheap answer is one mesh per tessellated patch. Two things in
meep's own source rule it out:

- `shape_cast` — the query behind `pm->trace` — runs GJK against the shape's support function,
  and `MeshShape3D.support` returns the deepest *tet-mesh vertex*, which is the **convex hull**
  of the mesh. Its docblock says so. A column's hull is a cylinder, which is right by accident;
  an arch's hull is the archway filled in, which turns a corridor into a wall on a map that
  loads without a warning.
- `MeshShape3D.prototype.is_convex === false`, and `shape_cast` routes non-convex targets off
  its tangency path onto the unconditional "solid, blocked at `t = 0`" one. Its comment for that
  path describes the failure it produces: a character flush against a wall falls through the
  floor.

So the pieces have to be convex, which is what `cm_patch.c` does as well. `patchHull.ts`
tessellates the patch at its own subdivision level (4, against the renderer's 8, and against
Q3's own adaptive grid which is coarser than either), then keeps a rectangular block of the grid
whole for as long as it is convex *as seen from the drawn side* and splits it when it is not.
One facet per tessellated quad is the obvious decomposition and is unaffordable: `am_thornish`
would go from 756 static bodies to about 23,000. Block merging gives 5,937, built in 92 ms with
a further 131 ms to make bodies, and 1,000 traces against the result take 20 ms against 14 ms on
a patch-free map.

**A facet is a plane set, and that is what makes it fit.** Each block contributes its cell
planes, a border plane per boundary edge, and one closing plane behind, and `hullFromPlanes` —
`brushToHull`'s winding clipper, extracted — turns those into a hull. So a facet satisfies
`ConvexHullShape3D.from`'s outward-CCW contract by construction rather than by a parallel
argument, and it arrives at `PhysicsTrace` carrying the plane set Q3's contact rule is defined
over. Every candidate plane's distance is the block's *support* in that direction, so a block
that is convex only to within the tolerance yields a facet a hair too big rather than one a
player falls through.

**The contact rule had to grow a second case.** `CM_TraceThroughBrush` is reached by brush
index, and a facet has none. Leaving facets out of it is not "slightly less accurate": a player
resting against a column would have the contact answered by the floor they are also touching,
the floor does not block a horizontal move, and pmove would be told the move is clear — into the
column. So `traceThroughPlanes` transcribes the same arithmetic over a supplied plane set,
`traceHullList` runs brushes and facets through one comparison, and `PhysicsTrace` gathers hulls
rather than indices. That also fixed `alreadyRuledOn`, which compared brush numbers and would
have called every facet on the map the same volume.

What is *not* covered, deliberately:

- **`boxTrace` still passes through patches.** The clipmap path is the differential test's
  control and is a transcription of `cm_trace.c`; teaching it patches means porting
  `cm_patch.c`, not extending this. `PmoveHost` uses the physics backend whenever it has one.
- **Sound still passes through them.** `Acoustics.buildOccluderScene` is an offline bake whose
  output is committed per map, so including facets is a re-bake rather than a code change.
- **The inside of a column is not solid**, and should not be: Q3's `CM_PointContents` consults
  brushes only, and what stops a player there is the surface.

### D-126: the menu grows a gameplay page, because "graphics" had become the name for "settings"

The menu shipped with one page called Graphics and every setting on it. That was honest while it
was true — the first settings the port could offer were the ones the engine would let it reach,
and reaching them was the work — but three of the rows on it were never graphics settings, and
one page called Graphics with a field of view and a crosshair on it is a menu organised by *what
was implementable* rather than by *what a player is looking for*.

Q3's own menu is the test, and it agrees. `cg_fov`, `cg_drawCrosshair` and `cg_crosshairHealth`
are `cg_` cvars — client **game** — and id put the crosshair rows under "Game Options", one
screen away from the "System" screen that held the renderer. So:

| page | sections | rows |
|---|---|---|
| Gameplay | View, Reticle | field of view, crosshair, colour crosshair by health |
| Graphics | Lighting, Effects, Performance | shadows, ambient occlusion, reflections, bloom, adaptive resolution, render scale, frame-rate target, frame-rate counter |
| Audio | Volume | master, effects, music |

**The dividing line is not cost, it is whether there is a right answer.** Every row on the
graphics page has one for a given machine — more of it looks better and costs more, and the
player is buying frames. None of the three gameplay rows does: 90 degrees is not worse than 110,
crosshair D is not worse than crosshair G, and neither costs a measurable microsecond. A menu
that mixes the two kinds makes the player read every row to find out which kind it is.

**Nothing in the shell changed**, which is what D-097 built it for: a page is a `SettingsPage`
value, `Menu` renders the list it is given, and the storage path is flat *precisely* so that
moving a setting between pages does not forget its value (`Settings.group` is one flat
`OptionGroup`, and the docblock there says so). The three rows kept their ids, so a player who
had set a field of view before this change still has it.

`graphicsPage` lost its `camera` and `hud` hosts along with the rows, which is the visible half
of the argument: the graphics page had been given two objects it needed for three rows that were
not about graphics.

### D-127: motion blur is not a setting, it is an argument, and this port has taken the side it takes

The graphics page shipped a motion-blur toggle and a blur-strength slider (D-109). Both are
gone. Not defaulted off — removed.

The toggle was already off, and the reason given for that default was: Q3 is a twitch shooter
played by people who come round a corner at 800 units a second and expect the room to be legible
on the frame it appears in. Reconstruction blur is very good at making a fast turn look like a
camera and slightly worse at making it *readable*, and "turn off motion blur" is the first line
of every competitive config for every shooter since.

That argument does not stop at the default. A setting whose right answer is the same for every
player of this particular game is not a setting; it is a decision with a control in front of it,
and the control costs two rows on the page a player is reading to find the one that will get
their frame rate up. The strength slider was worse: it was the *only* quality knob on the page
and it tuned the one effect that should not be on.

**What stays off is the engine's own field initialiser.** `Renderer.feature_motion_blur_enabled
= false`, so nothing has to hold it down — and `RendererFeatures` no longer declares the property
at all, which means a stale `motion-blur: true` in someone's IndexedDB from a build that had the
row reaches a `Settings` with no such id and is dropped by `coerce`. The removal is complete in
the direction that matters.

**The finding it produced is kept**, in `graphics.ts`'s header and in D-109 above: `MotionBlur`
is the one post-process in this renderer whose flag and whose tuning are both public
(`get motion_blur()`, "Configure it via `renderer.motion_blur.*`"), where `GTAO` and `SSR` live
in a private `#postprocess` and take their quality as call arguments the renderer hardcodes.
That is the shape GAP-024 asks for, and it is the most hopeful thing in that entry. It is worth
recording whether or not this port ships a row that exercises it.

### D-128: shadows default to the sun, because a Q3 arena has dozens of lights and one of them throws a shadow anyone reads

`SHADOW_MODE_DEFAULT` was `all` and is now `sun`. D-108 chose the expensive one deliberately and
gave a good reason: a converted map's lights are reconstructed fixtures standing where the
level's own lamps are, and having them throw shadows is the difference between a room lit by a
renderer and a room lit by its light fittings.

What decides it the other way is arithmetic that was not done at the time. **A Q3 arena is lit
by dozens of local fixtures per room.** All of them are shadow-casting spot and point lights, all
of them are shadow maps in one atlas whose size is a module-private constant in the renderer
(GAP-024, again), and the shadows they throw are short, overlapping, and mostly land on the
geometry that was already occluding them. The picture they buy is real and it is *diffuse* — the
room reads as slightly contactier.

The sun is the other case entirely. It is **one** light, its shadow is long, it crosses open
space, and it is the shadow a player actually reads as a shape: the edge of a building across a
courtyard, the shaft through a grate. One light's worth of cost for the shadow that does the
work.

So the default is the mode that keeps the shadow worth having and drops the several dozen that
mostly cost, and `All lights` is one click away on the page for anyone with the frames to spend
on it. D-108's argument is not wrong; it is an argument for the mode being *offered*, which it
still is, rather than for it being what the game starts as on an unknown machine.

The frame-rate counter moved the same way and for a smaller reason: it defaulted to on wherever
there was a panel to show, because the panel had been this port's own instrumentation before it
was a setting. `cg_drawFPS` is 0 in Q3, the arena is what the player came to look at, and the
row is still there for anyone tuning the two rows above it.

### D-129: the crosshair defaults to D, which is the one place this port disagrees with `cg_drawCrosshair`

`cg_drawCrosshair` defaults to 4 in both Q3 and OpenArena, and
`crosshairShader[i] = RegisterShader(va("gfx/2d/crosshair%c", 'a' + i))` makes 4 `crosshaire` —
a dot. `CROSSHAIR_DEFAULT` is now 3, `crosshaird`, a cross with the centre left open.

A dot is the most honest reticle there is: it marks the point of aim and occludes nothing. It is
also the one that depends most on the background staying quiet, and **the background did not stay
quiet.** Q3 drew flat lightmapped walls at 640x480. This port draws the same walls through
GTAO, a bloom composite, automatic exposure and a volumetric lightmap, and the whole point of
the exercise was to make that picture busier and brighter than id's. A three-pixel dot on a
blown-out wall is a three-pixel dot nobody can find.

The cross with a gap solves it the way crosses do — four strokes in the periphery of where you
are looking, and the centre still empty, so it is found at a glance without covering what it is
aimed at.

This is a **default and not a restriction**, which is the whole of why it is defensible under
"faithful in simulation, meep-native in presentation": all ten of `gfx/2d/crosshair[a-j]` are
converted, all ten are on the gameplay page, and `?crosshair=4` puts id's back in one query
parameter. Fidelity here is offering the choice id offered; which of the ten a player who has
not chosen gets is presentation, and presentation follows the picture this port draws rather
than the one it was ported from.

### D-130: the plasma bolt is an emissive sphere with a light in it, and `SpriteSystemPE` is gone

`CG_Missile` draws one weapon's projectile by hand. The plasma gun's `missileModel` line is
commented out in `cg_weapons.c`, so the branch sets `reType = RT_SPRITE`, `radius = 16` and
`plasmaBallShader` and returns — a camera-facing quad with `sprites/plasmaa.tga` on it, drawn
twice, additively. D-118 ported that literally, onto meep's `Sprite`, and `main.ts` registered
`SpriteSystemPE` for the one component in the port that ever used it.

**It is now a 128-triangle sphere a quarter of a metre across, emissive at 300, with a 400 lm point
light inside it.** Both are components of the missile's own entity, so a plasma bolt still costs no
entity of its own and still leaves with the body.

**Why the sprite was the wrong shape here, and not merely an old one.** A Q3 sprite is a bright core
and its painted falloff baked into one image, because the renderer it was drawn by had neither bloom
nor local lights and the artist had to supply both by hand. This port has both. Painting a glow into
a texture and then running it through a bloom chain is drawing the same falloff twice, and — the
part that actually matters in play — a sprite lights nothing. Q3's plasma gun is a torch you cannot
see by. Ten bolts down a corridor here throw ten travelling lights on the walls, which is the single
biggest difference this change makes and the one the sprite could not have been talked into.

Two departures from the C, both deliberate:

- **The ball is half Q3's size.** `ent.radius = 16` is a half-extent, so id's bolt is 32 units
  across; the sphere is 16. The missing half is the bloom chain's, and that chain is thresholdless —
  `downsample_karis` weights each pixel by its own luminance rather than testing it against a cutoff
  — so a bright small ball spreads in proportion to how bright it is and arrives back at roughly the
  sprite's footprint without being asked to.
- **Q3 gives this weapon no `missileDlight` at all.** Only the rocket (200) and the BFG light their
  own flight; `case WP_PLASMAGUN` has no such line. So the light is an addition, not a transcription,
  and the numbers are chosen against the port's own scale rather than invented:

  | quantity | value | where it comes from |
  |---|---|---|
  | colour | `0.6, 0.6, 1.0` | `MAKERGB( weaponInfo->flashDlightColor, … )`, the one colour the C states for this weapon — and the same three numbers `muzzleFlash.ts` already holds, read rather than retyped |
  | reach | 150 Q3 units | `muzzleFlash.ts`'s reach for the gauntlet, lightning gun and grapple: the three `CG_AddPlayerWeapon` lights *continuously* rather than pulsing at 300. A bolt in flight is the continuous case |
  | flux | 400 lm | below the gauntlet's 560, the dimmest continuous flash in that table at the time, because `fireRateMs` 100 and `speed` 2000 put ten or more bolts down a long sightline at once where only ever one gauntlet glow exists. **D-160 and D-161 took the flash table to a quarter and left this number alone**, so neither comparison holds any more: the gauntlet's flash is 140 and the plasma gun's own is **385**, which is *below* the 400 a bolt carries. The bolt is now the brighter of the two, which is not a thing anybody chose -- see D-161, which records it rather than fixing it, because the reports that moved the column were about muzzle flashes |
  | emissive | 300 | the same quantity as a map material's `emissiveLuminance`, whose top value on `am_thornish` is **295.7** for `base_light/light5_15k`. A bolt is level with the brightest fitting in the level, and not an order of magnitude past it |

  The emissive is applied *through* the colour, so blue carries the 300 and the other two carry 180
  — the bundle's own convention for a coloured emitter, and why the ball reads blue rather than
  white with a blue halo. `diffuse_color` is black: a bolt is a light source, and a ball with a
  diffuse response takes the colour of whatever corridor it flies down.

  Exposure is automatic, which is the argument against reaching for a bigger number. A bolt authored
  ten times brighter does not look ten times brighter; it darkens the room around it.

The light asks `Shadows.casts('effect')` rather than answering for itself, because that module exists
so that four files cannot each decide this in a comment. Worth stating what the answer costs under
`all`: a muzzle flash is one static light for 50 ms, and this is ten moving omni casters for a second
each, every one re-rendering six faces per frame because it moved. That is the mode's bill and not
this effect's — the reading `muzzleFlash.ts` already takes — and the default mode is `sun`, so out of
the box a bolt lights the corridor without shadowing it.

**`SpriteSystemPE` is no longer registered, and could not have stayed.** It was the port's only
sprite consumer, and it is unusable as shipped: REPORT.md BUG-17. `AbstractContextSystem` pools its
per-entity contexts, `SpriteSystemPE.Context.link` rebuilds an emitter only when it is not flagged
`Built`, and `ParticleEmitter.dispose` empties the particle pool while leaving that flag set — so the
second sprite to recycle a context writes into an emptied pool and throws, from inside a `Signal`
that catches and logs. In play that was every other plasma bolt invisible and a `console.error` per
physics step for the rest of its flight.

**The bug is why this was done when it was and not why it was done.** The sphere is a better picture
and would have been the right answer against a fixed engine; a workaround that restored the sprite
would have restored a worse one. What the bug did was settle a question that would otherwise have
been a preference. Recorded that way round on purpose — the port has form for finding an engine
defect and then dressing the workaround up as a design choice, and this is the opposite case.

What is left behind is `assets/built/fx/plasma_ball.png` and its line in `convert-fx.ts`, now
referenced by nothing. Kept rather than deleted: it is a converted Q3 sprite, it is cheap, and
`CG_PlasmaTrail` is a thing this port has not ported yet.

### D-131: the broadphase is re-shaped once after the level's statics are in, and the sweep answers move by 1e-5

meep 3.10.0 adds `PhysicsSystem.optimize()`: a treelet re-shape of both broadphase trees, meant to
be called once after a level's statics are linked. `main.ts` calls it after `addStaticModel` has
built the brush entities Q3 makes solid without simulating, and `headless-physics.ts` calls it after
its own body loop, so the harness walks the tree the browser walks.

**What it buys, measured rather than quoted.** The engine's docblock says ~12% fewer nodes visited.
On this port's maps the static tree's SAH traversal cost — the sum of internal-node surface areas
over the root's, which is the expected node count for a random ray up to constants — falls by:

| map | leaves | SAH cost | `optimize` cost |
|---|---|---|---|
| `oa_dm1` | 529 | 25.89 → 23.85 (**-7.9%**) | 7 ms |
| `aggressor` | 820 | 18.90 → 17.79 (**-5.9%**) | 3 ms |
| `am_thornish` | 6,693 | 30.86 → 28.54 (**-7.5%**) | 16 ms |

Positive on every map and short of the headline, which is what a 500-to-6,700-leaf tree should give:
these trees are 11 to 16 levels deep and there is less to win than in the 4,000-body scene the
figure was quoted from.

**Wall clock, honestly: not separable from noise on the machine this was measured on.** 100,000
player-sized sweeps and 200,000 raycasts, best-of-nine alternating rounds, came out between 10%
faster and 10% slower depending on map and run, with round-to-round spread wider than the effect.
The SAH number is the one to trust, because it is deterministic and the timing is not. And for the
sweeps there is a reason the tree matters less than it might: a body here is a `ConvexHullShape3D`
with a dozen planes, so the cost is dominated by narrowphase against the candidates rather than by
finding them.

**What it changes that is not free.** `optimize` is documented as leaving stepping bit-identical,
and does — but *queries are not bit-identical*, and this port is a query workload. Over 200,000
sweeps, optimized tree against un-optimized:

| map | sweeps whose fraction differs | largest difference |
|---|---|---|
| `oa_dm1` | 138 of 200,000 (0.07%) | 7.4e-5 of a ≤48-unit sweep — about 0.003 Q3 units |
| `aggressor` | 480 of 200,000 (0.24%) | 8.4e-5 |

Contact normals and entity ids never differ across those 400,000 sweeps, and 200,000 raycasts per map
return the same number of hits either way. So
the shape of the answer is stable and its last digits are not: a re-shaped tree finds candidates in
a different order, and the cast's conservative advancement converges from a different bound.

That is enough to move `npm run divergence`, and it does — 240 frames of strafe jumping amplify a
1e-5 fraction into tens of units of position, in both directions: `oa_dm1` strafe-jump p90 16.73 →
22.24, `aggressor` bunny-hop p90 1.20 → 3.01, against `aggressor` strafe-jump ≤1u 83% → 84% and
`walk-into-walls` 80% → 81%. The 20,000-sweep agreement table above it — hit/miss agreement, median
and p90 fraction error, normals — is unchanged to every digit it prints.

**Read that as the table's own caption asks to be read.** Those maxima are chaos, not error: two
runs that separate at frame 100 explore different parts of a level. The medians are still exactly
zero and the hit/miss predicate is still 100%, which is what says the backend agrees with Q3 on the
typical frame. A change that moves the p90 of a chaotic metric by a few units in both directions has
not made the port more or less faithful; it has made it a different member of the same family.

**The alternative was to optimize in the browser and not in the harness**, which would have hidden
the movement rather than removed it — the browser's trajectories would be the ones nobody measures.
That is D-036 and D-061's failure, and it is worth more than the tidiness of an unchanged table.

## Phase 10 — the camera, the lens, and the pads that did nothing

Five things were reported together and four of them turned out to be one thing seen from
different angles: the port had never ported `cg_view.c`. The camera sat where the feet were,
looked down the raw mouse angles, through a lens set to the wrong axis, and only moved sixty
times a second. The fifth — jump pads — was two unrelated defects that happened to land on the
same map.

### D-132: the camera is written once per rendered frame, and `ViewSystem` asks the scheduler to go first

Reported as *"projectiles appear to move with jerks"*, and the projectile was the messenger
rather than the message.

A missile is a physics body carrying `Interpolated`, so `InterpolationSystem` blends it between
fixed steps and it glides. The camera was written from `PlayerSystem.fixedUpdate` and did not.
Measured on `am_thornish` at 165 Hz against a 60 Hz simulation, the rendered camera's `x` went:

```
0  0.16666  0  0.16667  0  0  0.16667  0  0  0.16667 ...
```

Two or three frames of nothing and then a jump, forever. Everything drawn through that camera —
walls, floors, items, bots — stepped at 60 Hz. The one object on screen that did *not* was the
rocket you were watching, and a smooth object against a stepping world is the most visible form
of judder there is. Ask anybody to describe it and they describe the rocket.

**The fix is not to stop interpolating the missile.** It is to interpolate the camera, which
needs two things this port did not have.

**One: the pose has to be recorded, not recomputed.** `PlayerController` keeps the last two
fixed-step eye poses and `writeCamera(transform, alpha)` blends them. Position and the view
kicks are blended; **the view angles are read live** from the same accumulator the mouse writes.
That split is the whole design: a step of positional lag is 16 ms nobody can see, and a step of
lag on *aim* is the one thing an arena shooter must not have. Q3 does not blend either — it
re-runs the entire prediction every rendered frame — and this is the half of that which is
affordable.

**Two: it has to be written before `CameraSystem3` reads it**, or it is a frame late and the
gun swings across the screen behind the view, which is D-081's first half. Registration order
cannot settle that: `updateExecutionOrder` sorts by declared component access. So `ViewSystem`
declares `Camera` and `Transform` for **write**, `CameraSystem3` declares both for read, and a
writer outranks a reader.

The declaration is honest — the system writes the camera entity's `Transform` and writes
`Camera.fov` through `CameraLens` — and it also has to be *both*, which took a failing test to
discover. `computeSystemComponentDependencyGraph` draws an edge from each component a system
writes to each one it reads, and `scoreSystem` weighs a component by its **incoming** edges.
Declare `Transform` write and `Camera` read and the only edge runs `Transform → Camera`: the
component being written ends up with an in-degree of zero, `Write` scores twice zero, and the
tie falls back to registration order. Writing both puts an edge in each direction and the
weighting bites. In the shipping application it happened to work anyway, because `PhysicsSystem`
writes `RigidBody` and reads `Transform` and so lends `Transform` an incoming edge — which is a
correct arrangement resting on an unrelated system's declaration, and exactly the kind of thing
that is silent when it stops being true. `test/interpolation.test.ts` builds the two-system rig
where it does not.

After the change, the same 165 Hz run gives nineteen consecutive frames of `-0.060606`.

**Also fixed here: a missile's first two steps.** A body created by `CombatSystem` is created
*after* `PhysicsSystem`'s record pass for that step, so the physics timeline had one snapshot
where a blend needs two, `log.interpolate` fell back to the newer for every alpha, and the
missile jumped a whole step's travel and then held still for another. Four frames of a rocket
parked at the muzzle at 165 Hz, and a plasma stream doing it ten times a second. Missiles now
carry `interpolatedPose()` rather than `interpolatedBody()`: `PoseRecorderSystem` is registered
last among the simulation systems, so it snapshots the missile on the step it was born on.
`PhysicsSystem.__interp_restore` does not filter by `sourceId`, so the solver still integrates
from the authoritative pose rather than from a blend — asserted, because it is the property that
would rot silently.

### D-133: `G_PickTarget` is a name lookup, and half of `am_thornish`'s jump pads were aimed at a class the port did not know

Reported as *"a few that are supposed to boost the character forward to clear certain gaps ...
don't seem to work at all, player just walks on them with no effect"*, which is an unusually
precise bug report: the pad was found, it was touched, and nothing happened.

`am_thornish` has eight `trigger_push` entities. Four target a `target_position`; four target an
`info_notnull`. The port accepted `misc_teleporter_dest` and `target_position` and nothing else,
so `aimAtTarget` was handed `null` for half the pads on the map and `pushVelocity` stayed null.
`MoverSystem` then found the trigger, fired it, and pushed the player by nothing.

Q3 does not have a class list here. `AimAtTarget` calls `G_PickTarget( self->target )`, which
walks every entity whose `targetname` matches and picks one at random, then reads `s.origin` off
whatever it got. `info_notnull` exists *for this* — id's own description is "used as a positional
target for in-game calculation" — and it is what a mapper reaches for when they do not want the
marker to do anything else. So the test is now Q3's: a point entity with a `targetname` is a
destination. Brush entities are excluded by the branch above it, because a brush entity's origin
is the world's rather than its own.

**The corner pads were a different bug with the same symptom, and one that is only half fixed.**
Three of the four had the right velocity and never fired at all, because the player was standing
0.12 units above the trigger's top face. Two errors stack under the feet: meep's solver holds a
character a contact skin clear of what it rests on (Q3 does the same with `SURFACE_CLIP_EPSILON`,
and it does not matter there because the pad's trigger brush sits *above* the pad rather than
flush with it), and — the big one — where the floor is a curved surface it is a patch facet, and
`patchHull.ts` gives a facet `FACET_THICKNESS` of volume on the side its *winding* calls the
back. `am_thornish`'s pads are capped by a `SURF_NODRAW` collision patch wound to face
downwards, so the four units of thickness went **up**, and the player stands on the back of the
slab: four units above the surface the map draws, and above the trigger volume entirely.

**That half is fixed in the facet rather than here, and this entry originally was not.** What was
written first was a workaround: test a push trigger — and only a push trigger — against a player
box extended four units downwards, on the reasoning that the collision layer can put the feet up to
`FACET_THICKNESS` above the authored floor and a jump pad is the one trigger you touch by standing
on it. It worked, and it was insurance against a number rather than a fix for the thing producing
it, so the facet was filed as the real problem instead of guessed at.

It was then fixed, in D-139, before either had been committed: the facet is centred on its surface,
the player rests 0.625 units above the pad instead of four, and that is 3.4 units *inside* the
trigger. The standoff became inert — measured across all 295 `trigger_push` entities in the map
set, extending the box down by four units, by one, or not at all changes no answer anywhere — and
an inert workaround that reaches four units past the player's feet is worth deleting rather than
keeping. So the only thing this decision ships is `G_PickTarget`, and the corner pads are D-139's.

The sequence is left in rather than tidied away because it is the useful part: the workaround was
reachable in an afternoon and the fix was not obviously reachable at all, and the argument for
filing it — Q3's patch facets are zero-thickness and collide from *both* faces, so a mapper has
never had a reason to wind a collision patch one way rather than the other, and no rule over the
winding can recover what was never encoded — turned out to be an argument for not using the winding
at all rather than for leaving it alone.

### D-134: `PM_GroundTrace`'s kickoff test, without which a jump pad delivers 84% of its velocity

Reported as *"the boosters in the corners ... don't boost the player high enough to clear the
edge of the geometry that the pads are clearly intended for"* — which is the fourth corner pad,
the one whose trigger is authored a unit higher and which had been firing correctly all along.

`AimAtTarget` solves for a 234-unit rise and hands the player 612 units/s straight up plus 63
sideways. The player reached 161.

Three lines of `PM_GroundTrace` were missing from `MeepMove` (D-071's path):

```c
	// check if getting thrown off the ground
	if ( pm->ps->velocity[2] > 0 && DotProduct( pm->ps->velocity, trace.plane.normal ) > 10 ) {
		pm->ps->groundEntityNum = ENTITYNUM_NONE;
		pml.groundPlane = qfalse;
		pml.walking = qfalse;
		return;
	}
```

`BG_TouchJumpPad` overwrites `ps->velocity` and returns; the player is still flagged as standing
on the floor. Q3 clears that inside `PM_GroundTrace`, which runs before `PM_WalkMove` and
therefore before `PM_Friction`; this path went straight into friction as a *walking* player.
Q3's friction computes its speed from the horizontal pair and then scales **all three**
components by the result, so 612 came out as 514 — and the apex goes as the square of that.
0.84² is 0.70, and 234 × 0.70 is 164.

**Nobody noticed for two phases because `PM_CheckJump` clears the ground itself**, so an ordinary
jump was never affected. Everything that launches a player from *outside* pmove was: jump pads,
and `G_Damage`'s knockback. The horizontal component is what makes it bite — a purely vertical
launch takes `PM_Friction`'s `speed < 1` early-out and survives the missing test by accident,
which is why the regression case in `meepmove.test.ts` carries `am_thornish`'s own 62.8 and not
a tidy zero.

After the fix the corner pads rise 229 units against the 234 they solve for, the remainder being
the discrete step and the four units of D-133's slab.

### D-135: `cg_fov` is horizontal, `Camera.fov` is vertical, and the weapon was not what was wrong

Reported as *"the weapons appear too far on screen at the stated default 90 FOV compared to the
source OpenArena implementation"*.

`main.ts` did `camera.fov.set(90)`. meep documents that field as the vertical angle —
`PerspectiveCamera`'s own comment is "Vertical FOV angle (Y)", and `projection_infinite_reverse_z`
divides its cotangent by the aspect ratio — and Q3's `cg_fov` is the horizontal one:

```c
	x = cg.refdef.width / tan( fov_x / 360 * M_PI );
	fov_y = atan2( cg.refdef.height, x );
```

So on a 16:9 window the port drew **121.7 degrees across where Q3 draws 90**, and everything in
the frame at 60% of its proper size. That is not a subtle difference and it went unreported for
nine phases, because a level you have never seen at the right size looks like a level. The one
object whose distance the player *knows* is the gun in their hands: a rocket launcher held twelve
units from your face is a large object at Q3's lens and a thumbnail in the corner at this one.
The report was accurate and the weapon was innocent.

`CameraLens` holds the cvar in Q3's units and converts once a frame, because the conversion needs
the aspect ratio of the surface being drawn to and only the renderer knows that —
`GraphicsEngine3.render` sets `camera.aspect = renderer.aspect_ratio` on the way past. A window
that is resized therefore corrects itself with nothing told about it. `gameplayPage` is handed
the lens instead of the `Camera`, so the menu still offers `cg_fov` and nothing else has to learn
that meep measures the other axis.

At 4:3 with `cg_fov 90` this is 73.74 degrees, which is Q3's own number.

### D-136: `CG_OffsetFirstPersonView`, which is the difference between a camera and a head

Reported as *"the moment has no camera bob and lean of the source material; camera dynamics are
an important part of the game feel"*.

The port implemented `CG_CalcViewValues` and none of the seventy lines after it. The eye sat at
`origin + viewheight` looking down `ps.viewangles`, which is numerically correct movement seen
through a camera on rails.

Ported whole, from OpenArena's `cg_view.c`: the velocity lean (`cg_runpitch` 0.002, `cg_runroll`
0.005), the per-stride bob (`cg_bobpitch` and `cg_bobroll` 0.002, tripled while crouched, the
roll inverting on alternate feet; `cg_bobup` 0.005 clamped to six units), the crouch settle over
`DUCK_TIME`, the landing dip on `EV_FALL_*`'s own thresholds, the stair catch-up over
`STEP_TIME`, the damage kick, and the dead view's fixed 40 degrees of roll. `cg.kick_angles` and
`cg.kick_origin` are **not** ported: they are added by the C and never written anywhere in
OpenArena's cgame, so they are always zero.

`cg_runroll` is the one a player feels. At Q3's 320 unit/s strafe it is 1.6 degrees of roll, held
for as long as the key is held. It is the difference between turning and leaning into a turn.

**The reference the report offered was meep's own `FirstPersonPlayerController`, and it was not
used as one.** That controller is a much larger and better model of the same idea — lean springs
with half-lives, yaw-rate banking, breath, exertion, stride phase, footfall impact springs — and
it is a model of a *different game*. Q3's whole camera is five cvars and a sine, and the thing
being asked for was Q3's feel. What was worth taking from the engine's controller was its
*shape*: it keeps the pose out of the solver and composes offsets onto it, which is what the
split between `ViewKick` (state that outlives its frame) and `firstPersonView` (a pure function
of the player state) is.

Two things had to change around it, and both were latent bugs rather than new work.

**`orientToQ3Angles` threw the roll away.** It built its basis from the forward vector and world
up, which is correct at roll zero and silently discards every degree of the lean, the sway and
the corpse's 40. It uses `AngleVectors`' own up now. The tests that assert where the gun points
passed either way, which is the shape of the problem: a rotation with the right forward and the
wrong up is not observable through anything that only asks about forward.

**Two of Q3's events do not exist on the shipping movement path.** `MeepMove` reports
`landingSpeed`, so the fall events are reconstructed from `PM_CrashLand`'s own
`delta = speed² × 0.0001` thresholds. `KinematicMover` reports nothing at all about a step-up —
`MoveResult` is `hit`, `landed` and `landingSpeed` — so the stair event is inferred from the
pose: a rise over two units in one step that is steeper than the steepest walkable slope could
have produced was a step and not a ramp. Q3 does not need the heuristic, because
`PM_StepSlideMove` only raises `EV_STEP_*` when the plain slide was blocked and the step-up
rescued it. This is filed as a gap: a mover that performs an explicit step-up and does not say so
forces every consumer of "did I just climb a stair" to guess.

### D-137: the weapon rack goes over the ammo, and leaves on Q3's own timer

Asked for: *"when switching weapons, show the available weapon list near to where the ammo is
currently shown; the UI should disappear after a short while when not in use."*

That is `CG_DrawWeaponSelect` and `WEAPON_SELECT_TIME`, so both are Q3's: the rack appears on any
successful weapon change and comes down 1400 ms after the last one. Selecting the weapon already
in hand counts, which is what lets a player tap a key to *look* at the rack — Q3 does the same.

**Q3 draws it centred across the bottom and this does not**, because the reason Q3 centred it is
gone. Q3's status bar is three numbers along the bottom edge and the middle was free; this port's
readouts are two wrapped corners (D-118) and the middle already carries the pickup name and the
match line. Putting the rack directly over the ammo answers "what am I holding, how much is left,
and what else could I hold" in one place, which is the question a weapon switch is asking. It
sits *outside* the corner's wrap: the clusters are turned under a shared perspective, and a
readout you are actively reading should face you square on.

Three states per entry, all three Q3's. The held weapon is boxed in the ammo colour. One you own
with rounds left is available. One you own with an empty magazine is dimmed and desaturated,
because `CG_WeaponSelectable` refuses to switch to it — showing it as reachable is a lie the
player finds out about mid-fight. The gauntlet's ammo is Q3's `-1` and is never empty.

The order is imposed rather than inherited: slots are created as weapons are picked up, so a
shotgun found after a railgun would sit to the right of it. `PlayerController.ownedWeapons`
returns `WEAPON_ORDER`'s own sequence and the rack orders its flex children by the index in it.

### D-138: the damage kick is told, not inferred, because health falls for reasons that are not damage

Reported the session it shipped, as *"cyclic jerking of the aim"* on entering a map and sometimes
after respawning, that stopped by itself after a few seconds and once did so with no input at all.

D-136 wired `CG_DamageFeedback` by watching `inventory.health` between two fixed steps and calling
any drop damage. `ClientTimerActions` bleeds one point a second off health above `maxHealth`, and
`ClientSpawn` hands out `MAX_HEALTH * 1.25` -- so the first twenty-five seconds of every life are a
health value falling once a second for reasons that have nothing to do with being shot.

**And each of those was a full five-degree throw**, which is the part that made it loud rather than
subtle. `CG_DamageFeedback` clamps its kick to 5..10 degrees:

```c
	kick = damage * scale;
	if (kick < 5) kick = 5;
	if (kick > 10) kick = 10;
```

One point of bleed at 124 health is `1 * (40/124)` = 0.32, so the *floor* applies and the view got
the same throw a 12-point hit would produce. Once a second, twenty-five times, every spawn.

Measured before the fix, idling with no input from the moment the map loaded: a `-5` degree pitch
offset reached every second and decayed to zero over 500 ms, on repeat. After: zero non-zero frames
across ten seconds of the same idle, and across a respawn.

**Q3 does not infer it either, and that is the actual lesson.** `CG_DamageFeedback` runs off
`ps->damageEvent`, which `G_Damage` raises and `ClientTimerActions` does not -- the C distinguishes
"was damaged" from "has less health than it did" because they are different things. So
`PlayerController.damaged` is now called by the two things that actually damage the player:
`Arena.hit` for a shot that lands on the local client, and `WorldEffectSystem` for a `trigger_hurt`.
It is presentation only, exactly as the C is -- `CG_DamageFeedback` does not apply the damage
because the server already did.

The tempting middle option was to keep the diff and move it onto `roster.ts`'s `playerTarget`
health accessor, which `WeaponSystem.damage` writes and the bleed does not. That would work today
and it would work by accident: it depends on which of several writers happens to go through the
accessor, and `Bots.ts`'s health pickups and `PickupSystem`'s bleed both write `inventory.health`
directly. It is the same shape of fragility as GAP-037 -- correct because of somebody else's code
-- and it was declined for the same reason.

**One thing is lost and is worth stating.** Q3's `EV_DAMAGE` carries `damage_blood + damage_armor`,
so a hit entirely absorbed by armour still kicks. This port's hit event carries the health damage
only, and `WeaponSystem.damage` raises it with zero for a fully-absorbed hit -- so armour now eats
the kick along with the damage. Recorded rather than papered over; the fix is a second field on the
event.

### D-139: a patch facet has no front, so the shell straddles the sheet instead of hanging behind it

D-133 fixed half of `am_thornish`'s jump pads and filed the other half. The filed half was that a
player stands **four units above** the pads: the pads are capped by a `SURF_NODRAW` collision
patch, `patchHull.ts` gives a facet `FACET_THICKNESS` of volume on the side its winding calls the
back, and that patch is wound facing down — so the four units went up and the player stood on the
back of the slab. Measured: a point trace down the pad's axis stopped at **z = -615.88** where the
map's own surface is **-620** and the brush floor beneath it is **-624**. The pad's `trigger_push`
volume is -620..-616, entirely below the feet, so the pad could not fire; D-133 worked that around
by testing push triggers against a box extended down by the same four units.

D-133 said no rule over the winding can recover what was never encoded, and that was right. What it
did not say is that **nothing needs to be recovered**, because the question is the wrong one.

**The winding is not a signal, and the shipped maps say so out loud.** `CM_TraceThroughPatchCollide`
walks a facet's planes without asking which way it points: Q3's patch facets are zero-thickness and
solid from both faces. So a collision patch's winding is unread by the engine and unchecked by the
compiler, and a `SURF_NODRAW` one is not even checked by the mapper's eyes. On `am_thornish`,
**6,208 of 11,584 near-horizontal patch cells — 54% — put their solid above the drawn surface**
rather than below it. That is not a map full of mistakes. It is a field with no right answer, being
read as if it had one, and coming out at a coin flip because that is what it is.

A shell hung behind the "front" face is therefore exact on one side of the sheet and four units out
on the other, and which side gets the error is decided by noise. So the shell is centred on the
sheet: `FACET_STANDOFF` in front, the same behind, and the winding decides nothing about it. The
thickness comes down from 4 to 1 at the same time, because the two numbers only make sense together
— straddling at 4 would put every correctly-wound floor two units in the air.

`FACET_THICKNESS` is now a floor, not a tuning knob. Two things set it and both are lower bounds.
`hullFromPlanes` clips windings with a `CHOP_EPSILON` of 0.1, so front and back have to be far
enough apart not to be taken for one plane; and half of it has to exceed `SURFACE_CLIP_EPSILON`, so
the eighth of a unit Q3 holds a resting player clear by does not reach through the shell. One unit
is ten times the first and four times the second.

**The four units bought nothing.** Their stated reason was that "the swept query cannot step over
the facet in one frame", and that is not a risk this port runs: `pm->trace` is `shape_cast` over the
whole segment and a missile carries `RigidBodyFlags.CCD`. Nothing meets the level with a discrete
narrowphase, and a swept query does not step over anything however thin it is. What the extra three
units bought was error.

Against a facet chord that already sits **1.2 units inside** a 128-unit column at `COLLISION_LEVEL`,
half a unit of standoff is well inside a disagreement between the collision surface and the drawn
one that this file has had since it shipped. After the change the same trace down the pad stops at
**-619.38** — the standoff plus Q3's own clip epsilon — against -615.88 before.

**Deciding the side from the geometry was tried and declined, and the measurement is why.** The
obvious alternative is to read the side off something other than the winding: probe the brush lump
either side of a planar patch and put the solid where a player cannot be. It works on the pads —
four units of air below, a room above. Run over every map in the set it flips **511 of 2,280 planar
patches, and 195 of those are on drawn surfaces**, whose windings *are* verified, because Q3 culls
backfaces and a patch wound inside-out is not drawn. A heuristic that overrules 195 checked windings
to fix a class where nothing was ever checked trades a known error for an unknown one, and it would
have to keep being right on every map this port has not seen. Straddling has no such failure mode:
it does not read the winding at all. The winding still decides the *decomposition* — `isConvex`
reads concavity from the drawn side, which is what keeps an archway open — and that is a shape
question with no second source, which is exactly why it is worth keeping the two apart.

**One coupling had to be cut on the way.** `ESCAPE_MARGIN`, the safety net that catches a plane set
which failed to bound a volume and came back as a map-sized box, was written as
`4 * FACET_THICKNESS + 1`. The two are unrelated: a facet overshoots its block by the standoff and
`CONVEX_EPSILON`, under a unit, while the margin exists to tell a facet from a million-unit box.
Tying it to the thickness meant thinning the shell tightened the net to five units, which rejected
**650 blocks that were in no trouble at all and left 65 single cells dropped** — holes in the
collision surface, produced by a change that made every facet smaller. It is a flat 17 now, the
figure it has always had. With that fixed the decomposition is unchanged across the whole map set:
**59,657 facets against 59,675, the same 4 dropped cells, no hull that fails to build.**

**D-133's workaround is gone.** With the facet centred, a player rests 0.625 units above the pad,
which is 3.4 units *inside* its trigger. Measured over every `trigger_push` with a floor under it on
every map in the set — 295 of them — extending the player's box down by four units, by one, or not
at all **changes no answer anywhere**. The standoff is inert, and an inert workaround that reaches
four units past the player's feet is worth deleting rather than keeping as insurance; `MoverSystem`
tests every trigger with an exact box overlap again. (`kaos` and `kaos2` have four pads whose
trigger brushes are buried 4.12 units under a *brush* floor and which fire on neither setting. That
is a different bug, it predates all of this, and it is not touched here.)

**What this costs is real and it is half a unit.** Every patch surface in the game is now 0.5 units
proud of where it is drawn — a curved floor stands you that much high, a column is that much fatter,
a patch wall that much closer. Where the winding happened to be right, that is a regression from
zero. It is the price of not reading the winding at all, it is an eighth of what the wrong side cost,
and it is under half the sagitta the same facets already carry. D-134's residual, which it records
as "the discrete step and the four units of D-133's slab", loses that second term down to 0.5.

**The tests changed, and one of them changed sides.** `patch-collision.test.ts` used to assert that a
flat patch is solid behind its drawn side and open in front — pinning the very thing that was wrong.
It now asserts the shell straddles, and that the *same nine control points wound both ways produce
the same solid*, which is the property the bug violated. The dome and the bowl are untouched and
still pin that a bowl stays open, because the winding still decides that. Two new cases measure the
corner pads end to end: where the collision layer leaves a player standing, and that where it leaves
them is inside the trigger by more than a unit.

---

### D-140: the nailgun's normals do not describe the nailgun, and the bundle average could not see it

Reported: the nailgun looks wrong, as if its normals were bad. They are. It is the worst-shaded
model in the pack and the source file is why.

The check is D-060's, which needs no oracle: a triangle's edge cross product must point the way the
normals at its corners point. D-060 pointed it at whole bundles to catch a converter that reversed
nothing. Pointed at one model at a time, the same arithmetic ranks the 82 models in the prop bundle
and puts the nailgun at the bottom by a distance:

| model | mean dot | triangles disagreeing |
|---|---|---|
| `weapons/nailgun/nailgun.md3` | 0.253 | 198 / 775 (25.5%) |
| `ammo/hook/hook.md3` | 0.274 | 31 / 112 |
| `weapons2/grapple/grapple.md3` | 0.315 | 49 / 256 |
| *median model* | 0.891 | — |
| `weapons2/rocketl/rocketl.md3` | 0.878 | 0 / 204 |

**It is not the converter.** Re-read with an independent MD3 decoder and compared against the built
bundle: positions match to **0.0**, normals under `(x, y, z) -> (x, z, -y)` to **2.9e-08**, and all
775 triangles come out reversed as `(a, c, b)`. The obvious alternative story -- that some exporters
swap the lat/lng bytes in MD3's packed normal, and this file is one of them -- is measurably wrong:
the swapped decode scores *worse* on the nailgun (0.174 against 0.168 on one surface, 0.078 against
0.431 on the other) and wrecks `rocketl` and `shotgun`, which are clean. The standard decode is
right. The bytes are bad.

**Two different defects, one per surface, which is why the repair does two things.**

- `nailgun.002` (525 triangles) is **not consistently orientable**: 122 edges have both their
  triangles walking them the same way round. No assignment of front and back satisfies that mesh,
  so it is broken *winding*. Flood-filling the best available orientation does not rescue the
  normals either -- 199 of 525 still face into the surface afterwards.
- `nailgun` (250 triangles) winds cleanly -- zero minority triangles, zero non-orientable edges --
  and still has 33 triangles whose normals face inward, every one of them in a single flat cap at
  x in [8.34, 8.45]. Broken *normals*, and turning triangles would only move the problem.

So `tools/pipeline/mesh-normals.ts` orients first and re-derives second, and it does neither on
faith. A surface is measured, repaired only below 0.95 agreement, and the repair is **kept only if
it scores better than the source**. 118 of the bundle's 123 surfaces are not touched at all, and
84 of 88 models come out of the rebuild byte-identical to the previous bundle.

| surface | agreeing before | after | turned | normals rewritten |
|---|---|---|---|---|
| `nailgun.md3` [`nailgun.002`] | 68.6% | 100.0% | 57 | 681 |
| `nailgun.md3` [`nailgun`] | 86.8% | 100.0% | 0 | 346 |
| `grapple.md3` [`hookgun`] | 80.9% | 100.0% | 0 | 247 |
| `hook.md3` [`hook`] | 72.3% | 100.0% | 0 | 128 |
| `machinegun.md3` [`Cube.002`] | 50.0% | 100.0% | 0 | 12 |

The bundle goes from 0.9755 to 0.9905 agreeing; the nailgun alone from 0.746 to 0.997.

**Turning a component the right way round needs its evidence ranked, and I got the order wrong
first.** The flood fill makes a component self-consistent but its absolute sign depends on which
triangle it started from, so something has to decide which way is out. The first version voted with
the source normals every time, which is defensible on the nailgun -- where the winding contradicts
itself and the normals are all there is -- and wrong the moment the winding is coherent.
`machinegun.md3`'s `Cube.002` is the case that showed it: two flat hexagonal barrel caps, and on the
rear one the *winding* is right and the *normals* are uniformly backwards. Voting with the normals
turned a correct cap around to face into the gun. Nothing was measurably worse -- the surface still
scored 100% agreeing, because flipping both together satisfies the metric perfectly -- which is
precisely why it is worth writing down. So the evidence is now ranked: a **closed** component is
settled by its signed volume, which no authoring can argue with; an **open but self-consistent** one
keeps the source winding, because that is the artist's own answer; only a component whose fill hit
**conflicts** falls back to the normals vote. The rear cap now keeps its winding and has its normals
rewritten to match, going from 0.06 to 0.998 on how much its normals point away from the barrel.

**One model is exempted by name rather than repaired.** `teleporter.md3`'s `t_center` is a
four-pointed star of zero-thickness fins: 16 distinct positions, 36 triangles, and 12 edges carrying
three or four faces each where the spikes meet the middle. A fin has no outward side, so there is no
orientation to find and no normal for a shared vertex that agrees with every face on it. 8 of its 36
triangles disagree in the source and would disagree under any repair. The first version of the
tiebreak "fixed" it to 100% by picking a side arbitrarily; the corrected one declines the surface,
which is the honest answer. `teleport_center` is not `cull none`, so Q3 draws it single-sided and
shows the same artefact -- content, the same call D-060 made for `skelebot`. It is named in
`winding.test.ts` and still pinned at its actual 0.84, because an exemption that tolerates any number
is not an assertion.

**What it does not do is invent smoothing.** MD3 carries smoothing groups as *vertex splits* -- one
position under several indices, each with its own normal -- and that authorship is the one thing in
these files worth keeping. A vertex is seeded from the faces that name it, and only then merged with
faces that share its position across a 60-degree crease, which re-joins a UV seam without softening
a chamfer. 60 degrees because these are chamfered boxes and 8- to 12-sided cylinders: a cylinder
that coarse turns 30 to 45 degrees a facet and must stay smooth, and the chamfers that read as edges
are all past 60.

**The test could not have caught this, and that is the more useful half.** `winding.test.ts` summed
the whole prop bundle into one ratio: **0.9755**, against a 0.95 threshold, green. The nailgun alone
was 0.746. Eighty-seven well-made models outvoted it, and a weapon you hold in first person shaded
inside-out survived every run. An average over a bundle is the wrong denominator for a defect that
lives in one asset. The file now asserts **per model** as well, at 0.90 -- lower than the bundle's
bar, because a 22-triangle gib has no room to absorb the slivers the threshold exists for, where one
bad triangle is already 4.5% of it. Run against the pre-fix bundle the new assertion fails and names
four models; the old one still passes beside it, which is the whole point. It also caught the
teleporter regression above, which is the first thing it did after being written.

Two things this deliberately leaves alone. The per-model bar does not catch `machinegun.md3`, whose
one bad surface is 12 triangles out of 259 -- the converter's per-surface gate does, and that is the
right division of labour: the gate is fine-grained because it can afford to be, the test is
per-model because that is the unit a defect is reported in. And characters still go through
`convert-characters.ts` untouched, because D-060 already decided that question for them: `skelebot`'s
mixed winding is content Q3 renders with the same artefacts, and the character test asserts the
converter's invariant rather than the content's. Moving them is a separate argument with a separate
measurement, and nobody has reported a character looking wrong.

### D-141: five of the guns are two models, and the item table only names one of them

Reported with a screenshot beside OpenArena's: the machinegun in your hands has no barrel. The tube
that runs between its two sights is simply absent, and the rest of the gun is fine. "I'm guessing
other assets have been affected as well" -- four of them are.

**It is not damage in transit.** Read back with an independent decode, the built bundle's copy of
every machinegun surface matches the source to **0.0** on positions and normals, and all 286
triangles come out reversed exactly as the converter says it reverses them. Nothing was lost. The
barrel is a *different file*, and the pipeline was never asked for it.

`CG_RegisterWeapon` registers three models per weapon off one path, by swapping the extension:

```c
strcpy( path, item->world_model[0] );
COM_StripExtension( path, path );
strcat( path, "_flash.md3" );   weaponInfo->flashModel  = trap_R_RegisterModel( path );
strcat( path, "_barrel.md3" );  weaponInfo->barrelModel = trap_R_RegisterModel( path );
strcat( path, "_hand.md3" );    weaponInfo->handsModel  = trap_R_RegisterModel( path );
```

`convert-models.ts` reads `bg_itemlist`, and `bg_itemlist` names `machinegun.md3`. It had already
grown a special case for `_hand.md3` -- D-121's, because the hands model carries the `tag_weapon`
this port measures the gun's position from -- and that case is the reason the omission survived: the
file that knows weapons are more than one model knew about exactly one of the two extras. A model
nothing asks for cannot be reported missing, so the load log was clean, the `missing` list was the
same four entries it has always been, and every test passed.

How much of each gun was gone:

| weapon | body | barrel | share of the gun missing |
|---|---|---|---|
| `vulcan.md3` (chaingun) | 259 tris | 618 tris | **70.5%** |
| `gauntlet.md3` | 80 | 68 | **45.9%** |
| `grapple.md3` | 256 | 112 | 30.4% |
| `machinegun.md3` | 286 | 56 | 16.4% |
| `bfg.md3` | 582 | 96 | 14.2% |

The machinegun is the one that got reported and it is the *least* affected of the five. The chaingun
was two thirds absent and nobody had said so, which is what a defect with no assertion behind it
looks like.

**Every tag needed to put them back was already in the bundle.** `machinegun.md3` ships a
`tag_barrel` at (5.76, 0, 1.99); the barrel model runs from 0 to 10.2 along its own x, so its far end
lands at 15.96 -- flush with the muzzle, `tag_flash` being at 16.74. The five weapons that ship a
`_barrel.md3` are exactly the five whose world model carries a `tag_barrel`, so the invariant is
stated in `first-person.test.ts` in **both** directions: a tag with no model behind it is the defect
that shipped, and a model with no tag to hang it on would draw the barrel at the weapon's origin.

**The half of `md3Tag_t` the bundle was throwing away.** A tag is a pose, not a point: it carries
three basis vectors beside its origin, and `CG_PositionRotatedEntityOnTag` multiplies them into the
attached model's axis. `BundleTag` had only `origin`. Three of the five bases are the model's own and
would have survived being dropped; the gauntlet's and the chaingun's are quarter turns, and those are
the two barrels you would notice -- the blade and the rotor. So the tag basis is now converted
alongside the origin, as a quaternion in meep model axes: `M A M⁻¹`, whose columns work out as
`M·forward`, `M·up` and `-M·left`, which is the x-forward y-up z-right frame `MODEL_TO_VIEW` already
documents the converted models in.

Both of those two bases are **scaled by 1.8444**, left in by whatever exported them. `R_LerpTag`
normalises each row before it multiplies, so Q3 never sees it; carrying it through would have drawn
the gauntlet's blade at nearly twice the size of the gauntlet. The rows are normalised here for the
same reason, and the test checks the stored quaternion against the source rows rather than against a
recorded number, so it is the arithmetic that is pinned and not its output.

**Two places draw a weapon, and Q3 hangs the barrel in both.** `CG_AddPlayerWeapon` for the gun in
your hands and `CG_Item` for the one lying on the floor, each doing it themselves. So `ViewWeapon`
and `ItemsView` both do, through one `barrel.ts` -- a shared `barrelAttachment` and a `placeOnTag`
that is `CG_PositionRotatedEntityOnTag` with the parent's pose already in world space. The barrel is
a per-piece attachment on the existing lists rather than a second set of lists, because everything
else about it -- built once, shown and hidden with the weapon, counted in `pieceCount` -- is what the
body already does, and the only thing that differs is the pose written each frame. Measured on
`am_thornish`, which places a BFG and two chainguns: 176 item pieces before, 179 after.

**The spin is not ported, and that is a separate thing from the barrel being absent.**
`CG_MachinegunSpinAngle` rolls the barrel about its own length while `EF_FIRING` is set and coasts it
down over a second afterwards. Nothing carries "is firing" to the view weapon -- `flash()` is told
about a shot, not about a trigger being held -- and plumbing it is a change to the state the renderer
is given rather than to what it draws. All five barrels are therefore drawn at rest, which is the
pose they are authored in and where Q3 draws them whenever you are not shooting.

**A correct new model failed the winding test, and the ruler was what was wrong.** Adding the five
barrels dropped `gauntlet_barrel.md3` onto `winding.test.ts` at 0.853, under the 0.9 per-model bar
D-140 added. The mesh is not the problem: it is manifold, all 102 of its edges carry exactly two
faces, the converter copies it through unaltered, and `windingAgreement` -- the measurement
`convert-models.ts` uses to *decide* whether a surface needs repairing -- scores it **68 of 68**.

The two disagreed because they were measuring different things. `mesh-normals.ts` compares the face
against the **average of the three corner normals**; `winding.test.ts` compared it against corner `a`
alone. On this surface corners `b` and `c` agree on all 68 triangles and corner `a` disagrees on 10,
with dot products between **-0.002 and -0.078** -- 90.1 to 94.5 degrees off faces it is very nearly
edge-on to. MD3 quantises normals to a 16-bit lat/long pair, about **1.4 degrees**, so on a surface
that smooth the sign of that dot product is noise. A converter measuring one way and a test asserting
another is how a model with nothing wrong with it reads as 85%.

So the test now averages, which costs nothing as a guard: reversing every shipped map's winding back
-- the defect this file exists for -- scores **0.000 to 0.013** under the averaged criterion, against
0.000 to 0.021 under the old one. It catches the thing it was written to catch just as hard, and
stops reporting smooth geometry as backwards.

That **retires D-140's teleporter exemption**. `teleporter.md3` reads 0.920 averaged and clears the
ordinary 0.9 per-model bar on its own, so its named exemption at 0.8 was holding it to a *looser*
standard than every other model -- which is the opposite of what an exemption is for. The entry is
gone and the argument for it is kept in the comment: the star is still zero-thickness fins with 12
edges carrying three or four faces, Q3 still draws it single-sided and shows the same artefact, and
if it ever falls below 0.9 the general assertion now catches it, which is what the exemption was for.

### D-142: the barrel spins on a latch, and a zero-based clock is what makes the C's formula wrong

D-141 put the barrel back on the five guns that have one. This turns it, which is the reason Q3
models it separately in the first place.

`CG_MachinegunSpinAngle` is twenty lines and none of them integrate. It records **when** the trigger
last changed state and what the angle was at that moment, and derives the current angle from the
elapsed time on every frame:

```c
delta = cg.time - cent->pe.barrelTime;
if ( cent->pe.barrelSpinning ) {
    angle = cent->pe.barrelAngle + delta * SPIN_SPEED;
} else {
    if ( delta > COAST_TIME ) delta = COAST_TIME;
    speed = 0.5 * ( SPIN_SPEED + (float)( COAST_TIME - delta ) / COAST_TIME );
    angle = cent->pe.barrelAngle + delta * speed;
}
```

So the barrel's position is a pure function of the clock: a frame that takes 200 ms turns it exactly
as far as twelve frames of 16 ms would, and the spin cannot drift with the frame rate. `SPIN_SPEED`
is 0.9 **degrees per millisecond** -- two and a half turns a second -- and the port keeps that unit
rather than converting it, because every other number in the function is scaled against it.

The coast arm is worth reading twice. `speed` is the *average* rate over the whole interval since
release rather than the instantaneous one, so the angle is quadratic in `delta` and the barrel eases
to a stop. Its derivative is `0.95 - delta/1000`, which crosses zero at 950 ms and is very slightly
negative for the last fiftieth of a second -- a quarter of a degree of backwards creep. That is the
C's and it is left in.

**What is ported and what is not.** `angles[ROLL]` multiplies on the *right* of the tag basis, because
`CG_PositionRotatedEntityOnTag` composes `entity->axis * lerped.axis * parent->axis` and the roll is
already sitting in the entity's own axis when it gets there: the barrel turns in its own frame, the
tag places that frame on the gun, the gun goes where the gun goes. Composing it on the left instead
swings the barrel *around* the gun, which is a mistake that draws perfectly. The floor pickup does
**not** spin -- `CG_Item` builds the same barrel with `angles[ROLL] = 0` -- so the roll is an
argument to `placeOnTag` rather than something it reads.

**The port needed a flag it did not have, and it is not "a shot was fired".** `EF_FIRING` is set in
`g_active.c` every frame the attack button is down on a weapon with ammunition, so it is up for the
*whole* time the trigger is held. `ViewWeapon` was only ever told about shots -- `flash()` is called
per round -- and a barrel driven off that would tick round once per shot instead of winding up.
`PlayerController` already polled the button into `attacking`; `firing` is that plus Q3's ammo test,
which is `!== 0` rather than `> 0` because the C's is a plain truth test and the gauntlet's ammo is
**-1**. That is how a weapon with no ammunition at all still spins its blade.

**The latch belongs to the player, not to the weapon.** `cent->pe` is the entity holding the gun, so
Q3 keeps spinning it while you are holding one of the eight guns that has no barrel at all. Spin up
the chaingun, switch to the gauntlet and switch back, and the rotor is where it would have been. One
`BarrelSpin` on `ViewWeapon`, advanced every frame a weapon is drawn whether that weapon reads it or
not.

**And the one thing that had to diverge to match.** `centity_t` is memset on map load, so Q3 reaches
this function with `barrelTime == 0` and `cg.time` at the server's -- a delta of minutes, which the
coast arm clamps. A Q3 barrel nobody has fired therefore sits at a constant `0 + 1000 * 0.45 = 450`
degrees from its first frame onwards. Starting a *zero-based* clock at `barrelTime = 0` reproduces
the formula and not the behaviour: the delta is small and climbing, so the barrel winds itself
through those 450 degrees over the first second of the map with nobody touching the trigger.
Measured, before the fix: 15.1 degrees at 16 ms, 90 at 100 ms, 350 at 500 ms, 450 from one second on.

`newBarrelSpin` therefore starts `time` a whole `COAST_TIME` in the past, which lands the first frame
in the same clamped steady state Q3's first frame lands in. The constant 450-degree offset that
remains is the C's, and it is invisible on all five barrels for the same reason the spin is cheap to
draw: every one of them is a body of revolution about the axis it turns on.

**Tested against the drawn transform, not against the state machine.** A spin the renderer never
applies is not a spin, so `view-weapon.test.ts` recovers the roll from the two entities' poses --
`(body * tag)^-1 * barrel` -- and asserts that it is a turn about the barrel's own length before
reading its size. Nine mutations were run against the pair of features in this commit and all nine
were caught; the four that matter here are the roll being dropped on the way to the renderer, the
roll composed on the wrong side, `EF_FIRING` ignored, and the latch started at `t = 0`.

### D-143: the muzzle flash is a light and a burst, and three weapons get neither

D-115 gave the muzzle flash a dlight and stopped there. That lights the room and shows the shooter
nothing: Q3 also hangs `weaponInfo->flashModel` -- a small additive model -- on `tag_flash` for the
same twenty milliseconds, and none of it was ported.

It is particles here rather than a sprite model, on the emitter path `Effects` already uses for
sparks, smoke and fireballs. A second one-quad pipeline for one effect would be a pipeline to
maintain, and the emitter path is what this renderer has. Two layers, in the proportion Q3's own
flash models have: a bright core on a 30-45 ms life that opens fast and shuts faster, and five
sparks thrown down the barrel that outlive it slightly.

**Colour is not chosen.** It is `muzzleFlashLight`'s per-weapon `flashDlightColor`, the same table
the light reads, so a plasma gun's flash and a plasma gun's light cannot end up different colours.
That is the one-table rule D-115 set, applied to the half of the effect D-115 did not write.

**Two muzzles, the same as the light.** `Arena` already picks between the gun on screen and the
world; both halves now follow that choice together. A shot the gun took draws its burst from
`ViewWeapon` at `tag_flash` in world space, pointing down the barrel; every other shot draws it in
`Effects` at `CalcMuzzlePoint`, along the shooter's own forward. The direction is new on the event --
`AngleVectors`' forward, already computed one line above the call -- because a flash is oriented and
a burst that is not is a puff.

**The burst is raised from the frame, not from the shot.** `flash()` is called by the *simulation*,
where the only muzzle available is the one the last frame drew -- one frame is 16 ms of a 50 ms
effect and half a metre at running speed, and half a metre is the whole reason this rides the gun
rather than being left at the shot's origin. So a shot sets a flag and `update` spends it at the
muzzle it has just placed the light on. A flag rather than a count: two shots between two rendered
frames raise one burst, which is what Q3 does too -- `muzzleFlashTime` is a timestamp, not a queue --
and the chaingun at 30 ms between rounds is the only weapon that can manage it.

**Three weapons show nothing, and finding that out corrected a comment.** `CG_AddPlayerWeapon`
builds the flash entity and then bails:

```c
flash.hModel = weapon->flashModel;
if (!flash.hModel) {
    return;
}
```

That `return` is **above** the dlight and above `CG_LightningBolt`. OpenArena ships no `_flash.md3`
for the gauntlet, the grapple or the prox launcher, so Q3 gives those three no flash, no muzzle light
and no beam. `ViewWeapon` has said since D-115 that the fallback light for a weapon with no
`tag_flash` is "roughly where Q3 puts the gauntlet's anyway"; it is not, because Q3 puts the
gauntlet's nowhere. The comment is corrected.

The *light* still fires for all thirteen, and that stays D-115's call rather than becoming this
one's: a shot with no light at all reads as a shot that did not happen. What is gated on the C's own
test is the visible half, because a burst of sparks out of a melee weapon is not a divergence anybody
asked for. The list of three lives in `muzzleFlash.ts` beside the colours, and a test reads
`assets/extracted` and fails if the list and the pk3s disagree -- a hand-written table with nothing
checking it is a table that goes stale, which is the same failure D-066 had.

### D-144: both baked volumes are sampled against the player, and one of them had never entered a tunnel

A baked volume -- the acoustic probe field, the volumetric lightmap -- exists for exactly one reason:
to make a place answer differently from the place beside it. So the question either of them has to
survive is not "how big is the file" but "how small a space can it tell apart", and the ruler for
that is not the map, it is the player. A Q3 player stands 56 units, which is 1.75 m at
`WORLD_SCALE`, and a volume sampled coarser than half of that cannot separate the inside of a tunnel
from the hall it opens onto. That number is now written once, as `CHARACTER_HEIGHT` in
`CharacterBody.ts`, because it is the ruler both bakes are cut against and a length written out
twice is a length that comes to disagree with the box it describes.

Measured against it, one of the two was fine and the other was not measuring some rooms at all.

**Four metres of acoustic spacing was not a coarse setting, it was an exclusive one.**
`bakeProbeField`'s `minSpacing` looks like a spacing and is three thresholds, of which the spacing
is the least interesting:

- **the claim radius floor.** `probe_place_sdf_cover` gives each probe the empty sphere it stands
  in, clamped to *at least* `minSpacing`. At four metres a probe in a 1.2 m alcove claimed four
  metres regardless, swallowing the alcove, its doorway and the corner beyond into one measurement
  taken at the open end.
- **the candidate floor.** A voxel counts as air only above `minSpacing / 4` of clearance. At four
  metres that is a full metre, so **nothing narrower than 64 Q3 units was a candidate at all** -- a
  duct, a vent and a low crawl did not sound dead, they were never measured, and took the
  reverberation of whichever open probe happened to be nearest.
- **the SDF grid**, sampled at `minSpacing / 2` and capped at 256 voxels per axis.

The committed fields showed it. Nearest-neighbour spacing across the six maps ran a **minimum of
1.47-4.01 m, a mean of 5.74-6.51 and a maximum of 16.60-17.25** -- the minimum sitting exactly on
the hint on four of the six, which is what a floor looks like from underneath.

One metre is 32 units, 0.57 of a player, and the field it produces is a different object:

| map | probes | file | bake | nearest-neighbour min / mean / max |
|---|---:|---:|---:|---|
| `oa_dm5` | 6,258 (was 373) | 366.7 KB (21.9) | 413 s (141) | 1.00 / 1.56 / 4.27 m |
| `aggressor` | 7,318 (339) | 428.8 KB (19.9) | 254 s (204) | 1.00 / 1.56 / 4.27 |
| `oa_dm4` | 7,479 (351) | 438.2 KB (20.6) | 262 s (233) | 1.00 / 1.63 / 4.27 |
| `oa_dm1` | 7,602 (364) | 445.4 KB (21.3) | 377 s (84) | 1.00 / 1.41 / 4.27 |
| `oa_dm7` | 13,702 (652) | 802.9 KB (38.2) | 419 s (103) | 1.00 / 1.44 / 4.30 |
| `am_thornish` | 47,410 (2,206) | 2,777.9 KB (129.3) | 766 s (66) | 1.00 / 1.81 / 4.29 |

**What that costs, and what it does not.** The tree of probe files goes from 251 KB to 5.14 MB and
the full bake from about 14 minutes to about 41. The *runtime* cost is close to nothing:
`AcousticProbeField` answers the listener through a BVH, so the per-frame nearest-probe query is
O(log n) and 47,410 probes cost it two more levels of descent than 2,206 did; what grows is the
load-time BVH build and 2.8 MB of resident field on the largest map.

**Sparseness was left alone, and that was measured rather than assumed.** Dropping `minSpacing` also
drops the ceiling the cover opens out to, from 16 m to 4. Raising `sparsenessRatio` from meep's 4 to
16 to hold the old open-air ceiling recovers **6% of the probes on `oa_dm1` -- 7,634 to 7,160** --
and nothing worth having, because a Q3 arena rarely offers more than a few metres of clearance for
the sparse case to exploit. So there is no second knob here.

**Half a metre is the floor, and the SDF grid is why.** `build_sdf_grid` caps at 256 voxels per axis
at `minSpacing / 2`. One metre touches that cap on `am_thornish` alone and on its long axis alone --
256 where 265 were wanted, so 0.518 m samples instead of 0.5, while the largest of the other five
reaches 137. At half a metre `am_thornish` would want 433 x 264 x 521, get 256 of each, and sample
two axes at half the resolution asked for without saying so.

**The 3 s ceiling now reshapes a third to a half of every map, and that is the number to watch.**
D-106 clamps every band to `PROBE_MAX_RT60` and reports how many probes it caught; at four metres
that was 17-52% of them. At one metre it is **34% (`oa_dm4`), 38% (`aggressor`), 40% (`oa_dm5`), 43%
(`oa_dm1`), 45% (`am_thornish`), 57% (`oa_dm7`)**, and the longest band on every map went *up* --
`oa_dm5` from 3.86 s to 6.31, `am_thornish` from 8.06 to 11.14. That is not a regression and it is
not a surprise: the probes the change added are the ones in confined, hard-surfaced places, which
are exactly the places that ring longest. It is left at 3 s, because D-106's two reasons for the
ceiling -- the main-thread IR synthesis and the legibility of Q3's positional audio -- are unchanged
by there being more probes under it. But half of `oa_dm7` is now being held down by it, and if any
map ever sounds flat this is the first place to look, with `Q3_SURFACE`'s absorption as the knob
that changes the shape rather than the stopping point.

**The lightmap's cell size is not its probe spacing, and reading it as one is wrong by up to three
times.** `LIGHTMAP_CELL_SIZE = 0.5` looks like "probes half a metre apart" and its docblock said as
much. `brick4_generate_tree_from_scene` puts one cube over the scene, divides it **three ways per
axis per level** -- `BRICK4_BRANCH_FACTOR` is 3, not the 4 the "brick4" name suggests, which names
the 4x4x4 probe grid inside each node -- and refuses a level once its children's probe pitch would
fall below the cell size. So a node of side S carries probes S/3 apart, the result is quantised to
`E / 3^n` for the root cube's side E, and it lands anywhere in `[cellSize, 3 x cellSize)`. Derived
from each map's built geometry, at the 0.5 that D-107 says was never tuned:

| map | root cube | depth | probe spacing |
|---|---:|---:|---:|
| `aggressor` | 62.0 m | 3 | 0.77 m (24 units) |
| `oa_dm7` | 69.5 m | 3 | 0.86 m (27 units) |
| `oa_dm1` | 77.5 m | 3 | 0.96 m (31 units) |
| `oa_dm4` | 79.0 m | 3 | 0.98 m (31 units) |
| `oa_dm5` | 81.0 m | 3 | 1.00 m (32 units) |
| `am_thornish` | 149.5 m | 3 | **1.85 m (59 units)** |

Five of the six are inside a character and at or under a metre, which is the grade this was supposed
to be at and a better outcome than an untuned constant deserved. `am_thornish` is a whole character,
and the cell size is not why.

**Ten megabytes is the ceiling this asset is held to, and it changes no map's output.**
`LIGHTMAP_MEMORY_BUDGET` moves from 8 MB to 10, and the honest thing to record is that nothing comes
out different. The reason is `purge_partial_depths`: a depth the budget cannot *finish* is deleted
whole, because a patchy level breaks the shader's C0 interpolation. So the money only ever buys a
complete level, and a ceiling that funds 90% of the next one buys exactly nothing while paying the
tree-building time anyway. Five maps never reach the budget at all -- `oa_dm1` reports `Unexpanded
nodes: 0` at 1.12 MB. `am_thornish` reaches it, purges its fourth level and lands back at 1.85 m,
under 8 MB and under 10 alike. The level it wants is 601,000 probes, which is 16 MB of payload
before a single node, so the ceiling that would buy it is somewhere between about 20 MB and the 32
that produced it -- twice over the limit either way. Within 10 MB there is no arrangement of the two
constants that improves any map: lowering the cell size to buy the other five a finer grade needs
about 10 MB for `oa_dm1` alone and about 25 for `oa_dm7`.

**So the bake now says what grade it reached, instead of implying one.** `brick4ProbeSpacing` walks
the built tree to its deepest surviving node and reports that node's probe pitch, `main.ts` prints
it, and it warns when the result is coarser than half a character. That is the one line that would
have made all of the above visible the first time: a lightmap three times coarser than its cell size
produces a valid file, a lit level and no complaint, and nothing downstream can tell it from a map
whose rooms really are lit that flatly. `bake-resolution.test.ts` holds the measurement down --
including that it finds the *deepest* branch rather than the first, since a purge leaves the tree
lopsided rather than uniform.

**What is not claimed.** The acoustic numbers are measured; every one of them came out of a bake run
for this entry. The lightmap numbers are **derived** -- from each map's built geometry and the
engine's own subdivision rule -- and not from a re-bake, because that bake needs a WebGPU device and
minutes a map. They are consistent with what D-107 measured (`am_thornish` at 49,924 probes and
1.73 MB is a depth-3 field; the 601,000 it reached at 32 MB is the depth-4 one, and 12x is what one
level of a surface-following hierarchy costs), and `brick4ProbeSpacing` is now in the path that
would confirm or refute them the next time a map is baked. And nothing here has been listened to or
looked at: this is about probe positions, spacings and file sizes, not about how the arenas sound or
how they look.

### D-145: the profiler is a leaf, so the port is the thing that has to reach for it

meep 3.11.0 ships a GPU profiler under `shade/device/timing/profile/` -- a recorder, an `.sgpt`
container and the codecs for it -- and ships it **deliberately unreachable**. `Renderer` holds a
nullable `profile_session` field and calls methods on it; it does not import the recorder, and
neither does anything else in the engine. So the whole profiler -- the write stream, the format
codecs, the topology extractor -- drops out of any bundle that never mentions it, without a build
flag, a strip plugin or a dead branch anyone has to keep honest. Two leaf helpers are linked
unconditionally because `ShadeGPUCommandContext` needs them while encoding, and neither of them
knows what a capture is.

That is an arrangement, not an accident, and it decides where the wiring goes: **`main.ts` is the
only file in this port that names `GPUProfileSession`**, because `main.ts` is the composition root
and importing it there is the deliberate act of pulling the feature in.

**`GpuProfile.ts` imports no meep at all.** The session, the renderer field, the device and the
download are injected, exactly as `PlayerController` writes meep's input devices out structurally
rather than importing them, and for the same stated reason. What that buys is `gpu-profile.test.ts`:
the toggle, the repeat guard, the chord guard, the metadata, the file name, the badge and the
session lifecycle are all reachable in node, with no GPU and no engine, in a suite whose environment
is `node` and has to stay that way. The cost is one cast at the seam -- `Renderer.profile_session`
is declared `GPUProfileSession|null` and that class carries a `#private` field, so it is nominally
typed and a structural stand-in is not assignable to it. The cast is annotated where it sits.

**One key for both ends.** A recording is a state, and a state with a start key and a stop key is a
state you can get out of step with -- the failure being a capture nobody stopped, growing at 20 MB a
minute behind a badge that says so and is not being looked at. T toggles. Two guards on it, and they
are not symmetric:

- **Key repeat is ignored.** Holding T fires about thirty times a second. Without the guard, holding
  it starts a capture, stops it on the next repeat, and writes a file to disk on every repeat after
  that.
- **Ctrl, Alt and Meta are ignored; Shift is not.** Ctrl+T is a new tab and Cmd+T is the same, and a
  chord the browser already acts on must not also act here. Shift is Q3's *walk* modifier, held for
  seconds at a time -- a player who is walking should still be able to start a capture of what they
  are walking through, and no browser claims Shift+T.

Both the physical key and the letter are accepted (`KeyT` or `t`), because those disagree on a
layout that is not QWERTY and either reading of "bind it to T" is defensible.

**`WORKLOAD` by default, `?profile=` to change it.** The levels cost about 2 KB a frame at `TIMING`,
the same again amortised at `STRUCTURE`, ~6 KB at `WORKLOAD` and ~40 KB at `VERBOSE`. `WORKLOAD` is
where "is this dispatch the right size" becomes an answerable question, which is the question a GPU
capture is usually taken to answer, and 6 KB a frame is ~20 MB a minute -- affordable for a
recording somebody is standing over. `VERBOSE` is an order of magnitude past that and is reachable
rather than default. An unknown value falls back rather than throwing: this is a debug handle on a
query string, and refusing to boot over a typo in one is a worse failure than recording slightly
less than was asked for.

**A capture is uncapped, and that is the point.** `frame_limit` defaults to `Infinity`, so the
interaction is "T on, do the thing, T off" rather than "arm N frames and hope the hitch lands inside
them". The session warns on its own once it passes its byte budget, and the badge carries the
running total for the other half of the same problem: a recording nobody can see the size of is a
recording somebody leaves on.

**The last few frames of every capture are lost, by construction.** `Renderer` commits a frame when
its *timing readback* lands, which is two or three frames after that frame was submitted, and
`record_frame` drops anything arriving after `stop()`. The alternative is a `stop()` that does not
return until the GPU has caught up, which is not what the engine offers and not what a key press
should do. What this adds is the explanation: stopping within a few frames of starting yields a
capture with nothing in it, so that case is detected and says so in the console rather than leaving
somebody to wonder about a 300-byte file. The file is still written -- pressing the key asked for
one.

**The metadata is this port's job, and it is populated before the stream opens.** `GPUProfileMeta`
carries the adapter, the device features and the engine version, and the engine populates none of
it: a pass taking 0.4 ms means nothing until you know which GPU ran it. `start()` writes the
metadata into the stream and never reads it again, so every field has to be set first -- which is
the one ordering constraint in this feature, and is asserted directly, against what the session saw
at `start`, rather than against the object afterwards.

The engine version needed a `define`. meep exports no version constant, and its `exports` map has no
`./package.json` entry, so nothing in the browser can read one at runtime. `vite.config.ts` resolves
it the way it already resolves the worker bundles -- through a path the `exports` map does publish,
then up out of `build/` -- and hands it over as `__MEEP_VERSION__`. `main.ts` reads it through a
`typeof` guard so the module stays evaluable under `vitest.config.ts`, which carries no defines.

**`timestamp-query` is stated in the capture, not only in the console.** Browsers withhold the
feature on hardware that is otherwise fine, and Chrome quantizes what it does report to 100 µs
unless `chrome://flags/#enable-webgpu-developer-features` is set. meep degrades correctly -- the
query set is never created and the timers go quiet rather than throwing -- so a capture recorded
without it is a real capture of the frame graph with every span at zero duration. That reads as a
broken renderer to anyone who was not at the keyboard, and the capture is the artefact that gets
sent to other people, so the note it carries says which case it is. A device that has not been
created yet is *not* treated as one that cannot time: warning about missing timings on a machine
nobody has asked would be a guess presented as a fact.

**The badge is not in `HudState`, and that is the substantive UI decision here.** `Hud`'s own header
says the status bar is health, armour and ammo and that resisting the urge to add more is part of
the point. A GPU capture is a thing the *application* is doing, not a thing the player's character
has; it has to show in fly mode as well as in play, and `HudState` is built in two places. So the
badge is a separate element under the same root, written directly by `setRecording`, and the
three-numbers rule is left alone. Top right because it is the one corner this port draws nothing in
-- the status bar owns both bottom corners and `stats.js` pins itself to the top left and is not
ours to move. It pulses rather than blinks, because a badge that disappears once a second reads as a
rendering fault on a screen that is already full of movement, and `role="status"` announces the
start once while the counter beside it is `aria-hidden` so that the sixty announcements a second
that would otherwise follow do not happen.

**What was measured.** The full suite passes on 3.11.0 unchanged -- 797 tests across 36 files, plus
the trap, balance and material matrices -- so the upgrade moved nothing this port depends on.
`gpu-profile.test.ts` adds 24. End to end in the browser on `oa_dm1`: T starts a running
`GPUProfileSession` at level 2 bound to `renderer.profile_session`, with the note
`queep-3-arena · oa_dm1 · WORKLOAD`, `engine_version` 3.11.0, the adapter read back as
nvidia/lovelace and all seven device features recorded including `timestamp-query`; the badge
appears at 24px from the top and right of a 1280x720 stack; T again clears the field, hides the
badge and hands over a 29,922-byte blob typed `application/octet-stream`, beginning `SGPT`, named
`queep-oa_dm1-20260829-063556.sgpt`, holding 3 frames.

**What is not claimed.** Nobody has opened one of these captures in an inspector -- the inspector
the format was designed for is a separate application that does not exist in this repository -- so
what is verified is that a well-formed container with the right header, the right metadata and a
plausible frame count comes out of the key. Whether the timings inside it are *good* timings is a
question for the tool that reads them. And the badge's look has not been seen by anyone: the preview
pane composites nothing, so its geometry and colours are measured from computed styles and its
appearance still wants a human's eyes.

### D-146: Two constants where the C has a table, and a falloff that was not Q3's

Reported from play: the rocket launcher's and the grenade launcher's projectiles made no sound when
they landed, and the chaingun made no sound when it fired. Two separate faults, and the second one
is the smaller.

**The chaingun, the nailgun and the prox launcher fired in silence.** `Arena.muzzleFlash` plays
`weapon/<id>` for whatever `WeaponSystem` fired; `balance.generated.json` carries twelve weapons and
`convert-sounds.ts`'s table named nine. The three missing are the mission pack's, and OpenArena
ships every file for them -- `vulcanf1b`..`4b`, `wnalfire`, `wstbfire` -- so this was a list that had
not been extended rather than a sound that could not be found. `presentation.test.ts` had a check
for exactly this and it passed, because it too named nine weapons, by hand, in a literal. It now
reads `Object.keys(balance.weapons)`: the thing that decides what can fire is the thing that decides
what must be audible.

**The impact sounds were two constants where `CG_MissileHitWall` has a table.** `Effects` has read
that switch's `mark`/`radius` columns per weapon since phase 3. The `sfx` column was
`impact/bullet` for anything hitscan and `impact/rocket` for anything that exploded. So a railgun
hit a wall with a machinegun's ricochet, a plasma bolt detonated with a rocket's blast, the shotgun
fired eleven ricochets per trigger pull where the C fires none at all (`case WP_SHOTGUN` sets
`sfx = 0`), and `impact/plasma` sat in the bank with nothing in the port naming it. It is one switch
in the C and it is one table here now, in `client/impactSound.ts` -- a module rather than a constant
inside `Arena`, for the reason `muzzleFlash.ts` is one: two callers, and a test that wants to check
it against the sound bank without constructing an arena.

Two rows are substitutions and say so at the row. OpenArena ships no `wvulimpd` for the chaingun, so
it takes the machinegun's ricochet, which is the ammunition it fires; and no `wnalimpd` for the
nailgun, though it ships that sound's metal and flesh siblings, so `wnalimpm` stands in for every
surface. `impact/grenade` left the manifest entirely: it was `weapons/grenade/hgrenb1a.wav`, which
is `cgs.media.hgrenb1aSound` and belongs to `EV_GRENADE_BOUNCE` -- a grenade's *bounce*, not its
detonation, which is `sfx_rockexp` like the rocket's. Nothing had ever played it, and a row that
reads like an impact and is not is worse than no row.

**And the rocket impacts, which were the actual report, were none of the above.** The event was
raised, the emitter was built, the instance played and its gain was 1. What was wrong was the
distance curve every positioned sound in the game goes through. `S_SpatializeOrigin` is four lines:

```c
dist -= SOUND_FULLVOLUME;       // 80
if (dist < 0) dist = 0;
dist *= SOUND_ATTENUATE;        // 0.0008
scale = (1.0 - dist) * rscale;
```

That is a straight line from 80 units to 80 + 1/0.0008 = 1330. `Audio.ts` cited those two constants
and then built a Smith irradiance curve from them, on the written grounds that Smith is "much closer
to Q3's own 1/r-ish falloff than a straight line". Q3's falloff is not 1/r; the C is quoted above and
there is no reciprocal in it. It also read `SOUND_RANGE_DEFAULT` as the far bound rather than as the
length of the ramp, so the range ended 80 units early.

Measured in the browser with D-047's instrument -- an `AnalyserNode` on the master bus, the same
sample played at a series of distances from the listener:

| distance | Q3 `S_Base` | Smith | error |
|---|---|---|---|
| 320 u (10 m) | 0.808 | 0.236 | -10.7 dB |
| 640 u (20 m) | 0.552 | 0.080 | -16.8 dB |
| 960 u (30 m) | 0.296 | 0.026 | -21.1 dB |

A rocket you fire goes *away from you* and detonates twenty metres off, a twentieth of the level the
C gives it, directly behind the launch report in your own ears. It is not that explosions were
special; it is that explosions are the only sounds that are never near you. The curve is
`interpolate_irradiance_linear` over 80..1330 units now, which is `S_SpatializeOrigin`'s distance
term term for term. Re-measured after the change, the port tracks the C's line to a constant factor
across the whole range -- 0.65, 0.66, 0.65, 0.64, 0.62, 0.63 of it at 480 through 1250 units, where
the constant is the reference point's own panning and the *shape* is what was wrong before.

**What is not claimed.** Nobody has listened to any of this. The browser pane composites nothing and
runs no `requestAnimationFrame`, so the game was driven by `entityManager.simulate` on a timer --
D-066's rig -- and every number here is a peak amplitude read off the master bus, not a judgement
about whether a plasma impact now sounds like a plasma impact. The per-weapon routing is verified as
routing: firing each of the twelve weapons at a wall produces exactly the name
`CG_MissileHitWall` chooses for it, and the shotgun and the gauntlet produce none.

### D-147: A right angle that a float cannot hold, and a cone that could not be rotated onto it

Reported from play as "several rockets going off together make `ParticleEmitterSystem3` throw", with
a repro that fires eight of them around a circle and reads five or six of these off the console:

```
Failed during update of system 'ParticleEmitterSystem3': x must be a valid number, instead was NaN
```

It is neither several rockets nor rockets. It is **one shot at one yaw**, and the eight-shot repro
contains exactly one of them -- the third, at ninety degrees. Every other weapon whose flash the
world draws does the same thing at the same angle; the report reproduced with `AudioBank` stubbed
out, which was right, and would also have reproduced with the explosion, the smoke and the impact
mark taken away, which nobody had tried.

**Where the NaN is made.** `Effects.muzzleFlashParticles` throws its sparks in a cone, which meep
represents as a `ConicRay`: an axis and a half-angle. `sampleRandomDirection` samples the spherical
cap around +Z and then rotates the sample onto the axis, and it builds that rotation from

```js
const k = 1 / (1 + dZ);
const tx = -k * dY;
```

which is singular at the south pole. `ConicRay` knows that -- there is an early return for
`(0, 0, -1)` above the division, and another for `(0, 0, 1)`, with a comment naming the singularity.
Both compare **exactly**, and `ConicRay.fromJSON` copies the direction it is given rather than
normalising it, so what reaches the division is the caller's own arithmetic, unrounded and
unrepaired.

**Where the awkward vector comes from.** `angleVectors` is Q3's, which means it is `float`, and it
rounds the angle before it takes the cosine:

```ts
let angle = f32(angles[YAW]! * DEG_TO_RAD);
const cy = f32(Math.cos(angle));
```

`f32(90 * DEG_TO_RAD)` is `1.5707963705062866`, whose cosine is `-4.371138828673793e-8`. So a
shooter facing exactly along Q3's +Y hands out a forward of `(-4.371e-8, 1, 0)`, the axis swap makes
that `(-4.371e-8, 0, -1)`, and that vector is the south pole to eight digits, is a unit vector to
any tolerance anyone would test with -- meep's own `isNormalized` passes it -- and is not the pole
the early return is looking for. `k` comes out `Infinity`, `tx` is `Infinity * 0`, and all three
components of the sample are NaN before `Vector3.set` throws.

**Why it repeats.** The throw happens inside `ParticleEmitter.initialize`, on the way to the flag
that says the emitter has been initialised. So the emitter never sets it, is retried on the next
frame, and throws again -- once per frame until `Effects.expire` retires it 120 ms later. That is
where five or six come from, and it also means the abort is not confined to the bad emitter: the
`EntityManager` catches per *system*, so the explosions, smoke puffs and trail puffs sitting after it
in the emitter list lose that frame's simulation step with it, and the pass that retires dead
particles and repacks the sprite atlas does not run at all.

**The fix is at the call site, in `coneAxis`.** Both of the places this port builds a cone -- the
muzzle burst and `bulletImpact`'s spark spray -- now normalise in double and then snap an axis that is a pole to the
pole exactly. `POLE_EPSILON` is `1e-6`, an order of magnitude above the largest residue Q3's float
trigonometry produces at the four right angles -- `8.742e-8`, at yaw 180 -- and six
hundred-thousandths of a degree of tilt, which is not a visible change to where sparks go. Snapping is also what the fast
paths want: an exact pole takes the early return instead of building a rotation at all.

Fixing it in `ConicRay` -- normalising in `fromJSON`, or widening the pole test to an epsilon --
would be the better place for it and is not this port's file to change. The guard is written so that
a `ConicRay` which one day normalises its own input makes it redundant rather than wrong.

**`bulletImpact` was exposed to the same thing and had never been seen to fail.** Its axis is a
surface normal, and a BSP plane that faces exactly along an axis carries exact integers, which take
the early return. The normals that would have tripped it are the ones off curved surfaces, where
being a hair off an axis is normal; it goes through `coneAxis` for that reason rather than because
anybody caught it.

Pinned in `muzzle-flash.test.ts`, which goes through the real `angleVectors` rather than writing
`-4.371e-8` down -- a literal there would keep passing after somebody changed the arithmetic that
produces it -- and then drives `sampleRandomDirection` on the cone the emitter component actually
holds. `initialize` would be the more faithful entry point and cannot be called headless: the
emitter has no particle pool until the render system hands it one, and the pool was never what was
wrong. Verified in the browser as well, on D-066's rig, with the reporter's own eight-shot repro:
all eight bursts are raised, the third still carries `(-4.371e-8, 0, -1)` into `Effects`, and the
console is clean.

### D-148: One range for a footstep and for a warhead, and the formula that separates them

D-146 gave the port `S_SpatializeOrigin`'s line and left the other half of the problem standing.
Q3 spatializes every sound through one range -- flat inside `SOUND_FULLVOLUME`, gone
1/`SOUND_ATTENUATE` units later -- and that is not a curve shape, it is a **cull**:

```js
this.#audible = distance <= description.distanceMax && gain > dB2Volume(virtualThresholdDb);
```

`LiveEmitterSet` culls loops at the same bound and stops them with a hard cut rather than a fade,
on the documented assumption that "gain is approximately 0 past `distanceMax`". So the bound is a
real edge in the world, and one edge for every sound puts a rocket detonating 1400 units away in
the same bin as a footstep at the same distance: not quiet, absent.

**The propagation is measured and the source level is authored, and the split is the whole design.**
A point source spreading spherically loses amplitude as 1/r and intensity as 1/r^2, so the distance
at which a sound reaches a chosen fraction of its full-volume energy is `r0 / sqrt(fraction)` --
7.071 times the full-volume radius at 2%, which is the middle of the 1-3% band this was specified
from and is -17 dB in amplitude. That relation is `falloff.ts`'s arithmetic and it is not a
judgement. Which sound is loud enough to deserve which radius is entirely a judgement, and the two
honest ways to avoid making it both fail:

- **From the samples.** They do not carry it. Every file in the bank is mastered to about -1 dBFS
  peak, so `impact/rocket` measures *quieter* than `weapon/WP_LIGHTNING` over the loudest 50 ms
  (-3.0 against -1.0) and a footstep sits 14 dB below a detonation that is 120 dB below it in the
  world. Reading a source level out of recording level would rank a zap above a warhead.
- **From real sound pressure.** Ordnance is about 170 dB at a metre and a footfall about 50. Any
  mapping of 120 dB of real spread that puts the explosion where it belongs puts the footstep
  inside a metre of the listener. Game mixes compress that to a couple of dozen dB and always have.

So `SOURCE_LEVEL_DB` is a mix, ordered by the real acoustics and spaced by two facts about the
content: an arena is about 100 m corner to corner, a detonation has to cross it and a ricochet must
not. Everything between is placed by which of those it resembles, in 6 dB steps, because +6 dB is a
doubling of radius and that makes the table readable as distances.

**The straight line did not survive being given a per-sound range, and that is not a reversal of
D-146 so much as its limit.** A line's shape is set by where it reaches zero, so stretching one to
carry an explosion 113 m flattens everything nearer it: a detonation 80 m away would arrive at half
amplitude rather than the -12 dB spherical spreading gives it, and every explosion anywhere in the
map would sit near the top of the mix. The line is only Q3's answer because Q3 gives everything the
same range. What replaces it is the same relation the radii were solved from, which is the property
worth having -- a range derived from the irradiance law and a curve that was not it would disagree
about where the sound had gone.

`NOMINAL_FULL_VOLUME_Q3` is then chosen so that this is not a rewrite of what anyone hears. At 256
units a sound with nothing authored about it tracks `S_SpatializeOrigin` to within 3 dB from 320 to
960 units -- 0.800 against 0.808, 0.400 against 0.552, 0.267 against 0.296 -- and differs only at
the far end, where Q3's line reaches exactly zero and a real one does not. `falloff.test.ts` holds
that to 3 dB rather than describing it.

The last fifth of each range is faded into the cull with a smoothstep. Spherical spreading arrives
at the cull radius at 14.1% of amplitude by construction, and `LiveEmitterSet` cutting a loop dead
there would be a click rather than a disappearance; the taper makes the engine's own assumption true
instead of working around it, and costs the tail about 1 dB at four fifths of the range.

**What the radii came out as**, and the two ends are the design:

| sound | level | full volume | cull | |
|---|---|---|---|---|
| `impact/rocket`, `impact/prox` | +6 dB | 511 u | 3612 u | 113 m |
| `weapon/WP_ROCKET_LAUNCHER`, `mover/*`, `missile/*` | +3 dB | 362 u | 2557 u | 80 m |
| nominal -- most weapons, `player/*`, `world/*` | 0 dB | 256 u | 1810 u | 57 m |
| `impact/bullet`, `firing/*`, `weapon/WP_GAUNTLET` | -6 dB | 128 u | 907 u | 28 m |
| `item/hover` | -12 dB | 64 u | 455 u | 14 m |

**Measured in the browser** on `oa_dm1`, driving `entityManager.simulate` on a timer and reading
peak amplitude off an `AnalyserNode` on the master bus. `impact/rocket` played at a series of
distances is audible at 3200 units and gone by 3800, against a cull computed at 3612; `impact/bullet`
is gone by 1000, against 907. End to end, a rocket fired by a bot at the far spawn and detonating
1687 to 1864 units from the player reads 0.18 to 0.21 at the master bus -- where before this it was
not attenuated, it was culled, and the number was zero. The descriptions the bank builds were read
back out of the running engine and carry exactly the radii above.

**What is not claimed.** Nobody has listened to it. The table is a mix and a mix is a judgement made
with ears; what is verified here is that the arithmetic is the irradiance relation, that the radii
follow from it, that the engine holds them, and that a sound which used to be culled is now audible
at the level the formula predicts. Whether +6 dB is the right amount of rocket is the question this
cannot answer.

### D-149: The falloff function was never the port's to choose, and twice it was chosen anyway

Reported, and correctly: the attenuation curve had gone wrong, and the default should be Smith's
approximation. It should, and this entry exists because two commits in a row moved it away from
Smith for reasons that do not survive being stated plainly.

**The mistake was picking Q3 as the reference at all.** D-146 replaced
`interpolate_irradiance_smith` with `interpolate_irradiance_linear` on the grounds that
`S_SpatializeOrigin` is a straight line and the port's curve should therefore be one. That premise
is true about the C and irrelevant here: this port does not run Q3's mixer. It runs meep's, over a
baked acoustic field of 7602 probes on `oa_dm1` alone, with per-source occlusion, transmission and
a three-band crossover per voice. A port that has gone to that much trouble to be *more* physical
than 1996 does not then reach for 1996's straight line, which was a straight line because it was
cheap. D-148 compounded it: having stretched the line per sound and found -- correctly -- that a
line does not survive that, it replaced the line with a hand-rolled 1/r and a hand-rolled taper,
which is `interpolate_irradiance_smith` reinvented and done worse, since Smith already reaches zero
at its bound and needs no taper at all.

Both detours are reverted. The curve is the engine's again and this port has no opinion about it.

**What D-148 got right and keeps** is that the *range* is the game's business: `distanceMax` is a
hard cull rather than a fade, `LiveEmitterSet` cuts a loop dead at the same bound, and one bound for
every sound in the game is why a rocket detonating 1400 units away was absent rather than quiet. The
source levels, the irradiance relation and the derived radii are unchanged.

**What the correction actually changed, beyond restoring Smith.** Handing Smith the radius where
spherical spreading reaches 2% energy does not produce a sound that is at 2% energy there -- it
produces silence there, because Smith reaches zero at its bound and passes 2% a third of the way
along. So the two are no longer the same number:

- `audibleRadiusQ3` is `fullVolume / sqrt(0.02)` = 7.071 times the full-volume radius. This is the
  physical answer to "how far can this still be heard" and is what `SOURCE_LEVEL_DB` is spaced by.
- `cullRadiusQ3` is 19.60 times it, which is the range Smith has to be *given* in order to be at
  2% energy at the audible radius. The factor is solved by bisection against
  `interpolate_irradiance_smith` itself rather than against a copy of its algebra, so a change to
  meep's `k` recalibrates every radius in the game instead of quietly decalibrating it.

The payoff is that the rendered curve is now an inverse square law over the whole span anyone can
hear, which neither of the two detours managed. Measured against `fullVolume / r` for
`impact/rocket`:

| distance | Smith | 1/r | error |
|---|---|---|---|
| 700 u | -2.0 dB | -2.7 dB | +0.8 |
| 1500 u | -7.8 dB | -9.4 dB | +1.6 |
| 2500 u | -12.7 dB | -13.8 dB | +1.1 |
| 3612 u (audible radius) | -17.0 dB | -17.0 dB | 0.0 |

and past the audible radius it rolls off faster than physics over a tail nobody can hear, which is
the trade a bounded approximation exists to make.

**Delivered levels**, against the single 80..1250 range every sound shared before D-148:

| | 640 u | 1500 u | 3000 u |
|---|---|---|---|
| `impact/rocket` | -1.4 dB | -7.8 dB | -14.7 dB |
| `player/footstep` (nominal) | -6.4 dB | -14.7 dB | -25.1 dB |
| `impact/bullet` | -12.9 dB | -25.1 dB | culled |
| *every sound, before* | -21.9 dB | culled | culled |

**Measured in the browser** on `oa_dm1`, driving `entityManager.simulate` on a timer and reading
peak amplitude off an `AnalyserNode` on the master bus. `impact/rocket` played at 640, 1500, 2500,
3600 and 5000 units reads 1.12, 0.36, 0.32, 0.19 and 0.07; `impact/bullet` reads 0.28 at 640, 0.018
at 1500 and nothing at 2500. End to end, a rocket fired from the far spawn and detonating 1687 units
from the player reads 0.247 at the master bus, against 0.18 under D-148's 1/r and zero before either.

**What is not claimed**, and it is the same caveat D-148 carried: nobody has listened to it. The
`SOURCE_LEVEL_DB` table is a mix, and a mix is made with ears. What is verified is that the falloff
is the engine's own, that the radii follow from the irradiance relation, that the rendered curve is
an inverse square law to within 1.6 dB over the audible span, and that the engine holds the numbers
this file computes.

### D-150: A Q3 emissive surface arrives in meep three times, and the light standing in for it is cut by 30%

Reported: most of the lights are too bright, and probably because Q3's emissive surfaces are fake
and are therefore being counted twice — once in the bake and once in the main render. The fix asked
for is a fixed 30% reduction on a map's local lights, the sun excluded.

**The premise holds, and it is worse than double.** `q3map_surfacelight` is a directive to the
*compiler*. Q3's runtime had no emissive term at all: the fixture's face was an ordinary unlit
texture, and every photon it was supposed to have emitted was already in the lightmaps and the
lightgrid by the time the game started. This port takes that one directive and produces three
things that all reach the picture:

- the point lights reconstructed from the emitting surfaces (D-078, D-105);
- the fixture's own face, as `material.emissive`, which meep adds straight into the shading result
  — `outgoing_light = reflected_light.diffuse + reflected_light.specular + total_emissive_radiance`,
  `chunk_shade_standard_material_direct.js:109` (D-093);
- the brick4 bake, which traces the loaded scene several bounces deep and is the same path tracer:
  `chunk_render_trace_path.js` accumulates `incoming_throughput * shading_material.emissive` at every
  hit *and* samples the scene's lights in the same loop, so the glowing face and the point light in
  front of it both land in the probe. That volume is then the ambient term at every shading point
  (D-107).

And the point lights were fitted against the lightgrid (D-105), which is q3map2's whole solution:
direct and bounced, for a renderer with no emissive term and no runtime GI. So the port matches the
baked field with its point lights and then adds a glowing face and a bounce on top of it. Every
route is defensible on its own and the sum was never checked against anything.

**`LOCAL_LIGHT_SCALE = 0.7`, applied to every local light after the fit.** It is not derived and
this entry will not pretend it is: how much of a fixture's emission comes back through its face and
through the bounce depends on the room, so there is no single correct factor, only a requested one
that is close over six maps. What *is* derived is where it goes, and three of the four available
placements are wrong:

- **Before the fit** it does nothing. `fitGridLights` solves for the output that best matches the
  baked field; hand it lights already cut by 30% and it sizes them back up, or fills the hole with
  lights of its own. The picture is unchanged and the log still says the fit converged.
- **Before the emissive faces are derived** it dims them too, because a material's luminance is its
  lights' flux over its area. That keeps the double count in exactly its current proportion and
  makes every fixture in the game dimmer than the mapper drew it. The face is the leg that was
  *already* being counted; it keeps the whole flux.
- **On the reach as well** — `radius *= sqrt(0.7)`, holding the absolute cutoff lux — moves where
  every light stops in by 16%. `radius` is a cutoff, not a falloff, so leaving it puts the shipped
  field at exactly 0.7 of the fitted one everywhere the fitted one was not zero. A dimming and
  nothing else, which is what was asked for. The discontinuity at the cutoff gets 30% smaller for
  free.

So it is last: after the fit, after the emissive faces, after the sub-lumen fixtures the fit drove
to nothing are dropped on the fit's own numbers.

**The sun is excluded, and would have been anyway.** A directional light is not reconstructed from a
surface and has no face in the scene to be counted twice with — it stands in for q3map2's sky, and
its intensity is read off the lightgrid by a different route entirely (D-105). Verified per map:
`sun.intensity` is bit-identical across the change on all five maps that have one.

The lights fitted to the lightgrid take the cut as well, and for them it is *not* a double-count
correction — they came out of no surface and have no emissive twin. It is the same statement applied
to the same kind of object: they were fitted to the same field against the same targets in the same
least squares, and a solution where half the lights carry a correction and half do not is not one
anyone can reason about later.

**What it does to the six maps.** Illuminance is at spawns and pickups, at eye height, from the
bundle's own lights — the same arithmetic `loadMap` hands the engine.

| map | fit RMS | shipped RMS | median lux, was | now | under 1 lux, was | now |
|---|---:|---:|---:|---:|---:|---:|
| `oa_dm1` | 79% | 83% | 14.4 | 10.1 | 0/39 | 0/39 |
| `oa_dm4` | 67% | 73% | 25.4 | 17.8 | 0/48 | 0/48 |
| `oa_dm5` | 65% | 75% | 11.0 | 7.7 | 0/37 | 2/37 |
| `oa_dm7` | 63% | 69% | 26.1 | 18.3 | 0/80 | 0/80 |
| `aggressor` | 52% | 62% | 12.3 | 8.6 | 0/38 | 0/38 |
| `am_thornish` | 78% | 85% | 7.4 | 5.2 | 1/159 | 1/159 |

Nothing went dark: two pickups on `oa_dm5` cross under a lux, out of 401 player positions across the
set. The rebuild is otherwise byte-for-byte — every texture, every vertex, every material, including
`emissiveLuminance` — so the whole diff of this change to `assets/built/` is `lights[].lumens`
multiplied by 0.7 and two new statistics.

**It costs agreement with the bake, which is now written down.** `lightingResidualAfter` was the one
number saying whether a map's lighting is *right* rather than merely present, and after this it
describes a set of lights no bundle contains. `lightingResidualShipped` is the same function over
the same cells with the lights that actually ship, and it is worse on all six by construction —
that is the price of the correction, stated rather than hidden. `presentation.test.ts` asserts the
shipped number now, and asserts that it is the worse of the two, because a build where the shipped
solution agrees with the bake *better* than the fitted one is a build where something other than
this constant moved the lights after they were measured.

**The pairing D-093 established is now a pairing with a constant in it.** A fixture's face is still
its flux over its area; its point light is that flux times 0.7. `materials.test.ts` checks the two
against each other through `LOCAL_LIGHT_SCALE`, which makes it the one mechanical check that the
de-rating landed where this entry says it does — applied before the fit the factor vanishes, applied
before the faces it cancels out of the ratio.

**The bake was re-run against the new lights, one map at a time.** `?bake=lightmap` per map, 82 s
to 6 min each on a 4090. The tree comes from the geometry and the memory budget rather than from
the lights, so every volume came back the same size with the same probe count and only the payload
moved — which is what makes the payload readable as a measurement. Word 0 of each 7-word probe is
the RGBE9995 L0 term, the direction-independent part of the irradiance
(`chunk_brick4_sh3_color_decode`), and the bake's RNG is `seededRandom(1337 + probe_count)`, so two
bakes of the same scene are a controlled comparison rather than two samples of a noisy one.

| map | probes | summed L0, new volume vs the one it replaced |
|---|---:|---:|
| `oa_dm1` | 32,074 | 0.795 |
| `oa_dm4` | 26,678 | 0.900 |
| `oa_dm5` | 32,286 | 0.791 |
| `oa_dm7` | 83,490 | 0.812 |
| `aggressor` | 50,644 | 0.875 |
| `am_thornish` | 49,924 | 0.981 |

**Those are asset-level numbers and not a decomposition**, which is worth saying because they look
like one. The volumes they replace were baked at D-107 and `scene.json` has moved twice since —
D-113's glass, and this entry — so the column above is "what this commit does to the file", not
"what the de-rating does to the bounce".

**The decomposition needs both bakes on one scene, and that was done for two maps.** Load the map,
bake it, undo the de-rating on the lights the baker reads, bake it again: same tree, same probe
count, same seed, same materials, back to back, nothing different but the intensities. The bounce
is linear in its emitters, so `A / B = 1 - 0.3x` gives `x`, the share of the baked indirect the
map's own point lights are responsible for.

| map | sun | A / B | point lights | everything else |
|---|---|---:|---:|---:|
| `oa_dm1` | none | 0.773 | 76% | 24% |
| `oa_dm4` | 43.1 lux | 0.900 | 33% | 67% |

`oa_dm1` has no sun, so its 24% is the emissive faces alone: **a quarter of that map's indirect
light comes from surfaces that were never lights in Quake III**, and it is the quarter this entry
deliberately does not touch. `oa_dm4`'s remainder is mostly its sun, which is bright and excluded
by design. The other four maps were not measured this way and the range between these two is wide,
so no number is claimed for them.

The practical consequence is that the delivered change is not 30% anywhere: the direct term falls
by exactly that, the indirect by 10% on `oa_dm4` and 23% on `oa_dm1`, and what a surface shows is
whatever mixture of the two it stands in.

**And it has been looked at.** The Browser pane composites now — it did not when
`verifying-in-the-preview-browser` was written, and that stale note is why the first version of
this entry said no one could see the result. `oa_dm1` and `aggressor` were compared at a fixed
camera by swapping the old volume back in and scaling the lights by `1 / 0.7` in the page: the old
state is visibly flatter and paler, walls lifted toward a uniform tone with the recesses filled in,
and the new state holds contrast and reads as rooms with light in them rather than rooms full of
light. That is the improvement that was asked for.

What is *not* fixed is the fixtures themselves. A `q3map_surfacelight` face still blows to white
with a bloom halo around it, because `emissiveLuminance` is the leg that keeps its whole flux. If
"the lights are too bright" turns out to mean those, the lever is D-093's luminance and not this
constant — and cutting both is the thing this entry argues against, so it would want its own
reasoning.

### D-151: The air was vacuum, and the box that fills it is the map's own box rather than a big one

**Superseded in part by D-154**, in both halves of its title. The box is no longer the map's own
box -- it is the map plus 100 m on every face -- and the medium is no longer meep's default fog
droplet. The reasoning below about *why* the box's size is a decision about the sky is what D-154
builds on and is unchanged; what changed is the number that argument lands on, once there was a
density low enough that a larger box did not put a grey ceiling over the level.

meep 3.11.2, and a global `ParticipatingMedia` volume covering the map — "effectively adding
volumetric lighting into the game", as asked.

**There is no switch to find.** `Renderer` asks `scene.volumetrics.source.volumes.length > 0` and
skips the composite pass entirely when the answer is no, so the whole subsystem is gated on a scene
containing a medium. Turning volumetric lighting on is therefore *putting one thing in the world*:
`ParticipatingMediaSystem3` registered beside `LightSystem3`, and one entity carrying a
`ParticipatingMedia` and a `Transform`. Nothing else was reachable to configure and nothing else
needed to be — unlike Brick4 (D-107), where the upload and the mode are two separate half-measures
either of which silently does nothing on its own.

**The box is fitted to the map, and the reason is the sky.** The obvious reading of "a very large
box covering at least the whole map" is a box so big the question stops being asked. It renders
wrong, and it renders wrong on the four maps here that have a sun. What a pixel shows is the
optical depth along its view ray, which is extinction times the distance the ray travels *inside
the box*. A ray that hits a wall stops at the wall and does not care how far the box extends past
it. A ray that hits the sky does not stop; it runs to `camera.clip_far`, which this port sets to
600 m. So the box's size is precisely and only a decision about the skybox:

| box | optical depth on a sky ray | transmittance |
|---|---:|---:|
| the map (~80 m across) | 0.40 | 0.67 |
| 600 m, i.e. "very large" | 3.02 | 0.05 |

The second is a grey ceiling where the sky used to be. Fitting the box costs one lookup —
`SceneBundle.submodels`, model 0, the world's own brushwork in Q3 units — and `worldBoxOf` grows it
by an 8 m margin so that `fade_distance`'s inward taper stays outside anything that is stood in,
and so a `?fly=1` camera through a wall still has fog around it. The margin is required to exceed
the fade for the same reason, and a test asserts it: a taper reaching back inside the map lights
the outermost rooms through thinner air than the middle ones, which is a gradient across the level
that nothing else in the port would explain.

**The axis swap is where this goes wrong silently.** Q3 is `x` forward, `y` left, `z` up; meep is
metres, `y` up, `z` back. For a point that is a sign flip, but for an *interval* the ends swap too:
the meep `z` range runs from `-maxsQ3.y` to `-minsQ3.y`. Getting only the sign gives a box in the
mirrored half of the map; getting the ends the wrong way round gives a negative extent, which Shade
poses its unit cube by without complaint and which renders as no fog at all. Neither raises
anything. `atmosphere.test.ts` builds a box asymmetric on all three axes so that a mistake cannot
pass by landing on the same numbers, and checks the shipped bundles' own bounds land inside the
volume with the margin clear on all six faces.

**0.005 per metre, chosen at the value meep's own default makes and then looked at.** The number is
authored as `target_extinction` rather than as `density`, because density is per-particle — 3.0e7
per cubic metre for the fog spec and some other number entirely for smoke — and the component's
setter does that division. meep calls its default "very dense fog"; that name is about the particle
count, and what it actually comes to is 0.005/m, which is 0.95 transmittance across a room and 0.67
along the diagonal of most of these maps. The upper end is the constraint. Q3 is a game about
seeing someone across a room and shooting them, and a rail sightline down a map's long axis is what
a haze setting is spending.

Three states at one camera in `aggressor`, the large room above the water, in the Browser pane:

| extinction | what it looks like |
|---|---|
| ~0 | the room as it has always rendered: the ceiling fixture is a hot spot with nothing around it |
| 0.005 | light stands in the air under the fixture, and the far wall carries mild aerial perspective — visibly volumetric, fully readable |
| 0.02 | milky: the far wall washes out and the room stops reading as a room |

**The first attempt at that comparison measured nothing, and the reason is worth writing down.**
Setting `density` on the `ParticipatingMediaVolume` in the page appears to work and is undone
within a frame: `ParticipatingMediaSystem3` polls, finds the volume disagrees with its *component*,
and writes the component's value back over it. That is the system working exactly as its docblock
says, and it means the only writable end of this is the ECS component. Four screenshots were taken
before the discrepancy showed up in a readback; they were indistinguishable from each other because
they were all the same picture.

**The frame cost was not measured.** The Browser pane hides itself between calls here, `rAF` stops
with it, and every attempt at a frame-time comparison timed out mid-measurement. The passes are
real work — a froxel grid, a scattering LUT, a TAA resolve and a composite — and `?fog=off` exists
partly so that cost can be taken back on a machine that needs it, and partly because "is the haze
the reason I could not see him" is a question a player is entitled to answer for themselves. What
that switch costs when it is *on* is still an open number.

**Q3's own fog is untouched and unrelated.** The BSP has a `fog` lump and every leaf and brush
carries a `fogNum`; this port has never read either, and this does not start. `CONTENTS_FOG` is a
gameplay-visible volume that changes what a trace hits, and a single global medium is a different
thing that happens to share a word.

### D-152: The weapon rack was landing on the ammo readout, and the corner it shares had quietly stopped being part of the wrap

A screenshot: the row of weapon icons overlapping the top of the AMMO panel. Two faults under it,
one of them the reported overlap and one of them the reason the two corners of the status bar had
stopped being the same shape.

**A transform does not move a layout box, and that is the whole of the first fault.** The rack sits
above the ammo cluster in a flex column (`.queep-hud__corner`), spaced from it by `gap`. Flex spaces
*boxes*. The cluster is then turned and sheared by `hud-wrap`, and `skewY` displaces y by
`x·tan(3°)` about the inner edge — so its outer end is drawn 17px above the box the column measured,
and an 8px gap is 9px of overlap at the end where the readout is highest. Nothing in CSS relates the
two numbers; the only way this is ever right is for someone to have done the arithmetic.

**The second fault is that the right-hand cluster was not being projected at all.** `perspective` is
declared once, on `.queep-hud`, precisely so that both corners turn about one vanishing point —
`hud.scss` opens by saying so. But a `perspective` applies to an element's *children*, and when the
rack arrived the ammo cluster became a grandchild: the corner column in between was a flat wrapper,
which ends the 3D context. The turn still happened; it was just projected by no eye. The four
corners of the right-hand cluster, at 1440x810:

| corner | before | after |
|---|---|---|
| inner top | 1088, 704 | 1050.5, 712.4 |
| outer top | 1380.3, 687.2 | 1377.1, 687.7 |
| outer bottom | 1380.3, 769.2 | 1377.1, 769.3 |
| inner bottom | 1088, 786 | 1050.5, 786 |

That first column is an affine squash — `cos(24°)` of width, sheared, and nothing else. The inner
edge does not recede, because `translateZ(-136px)` had nothing to be depth *in*. So one corner of
the screen was a perspective turn and the other was a flat trapezoid the same width, which is two
shapes claiming to be two ends of one surface.

**`transform-style: preserve-3d` on the column fixes the second, and it makes the first smaller
without fixing it** — the projection pulls the whole cluster toward the vanishing point, so its
outer top corner drops from 687.2 to 687.7 and the overlap goes from 8.8px to 8.3px. The gap is
still short by the shear.

So the gap is `space(2) + $hud-wrap-lift`, and `$hud-wrap-lift` is a new token sized the way
`$hud-wrap-depth` already was: at the widest cluster the port has, which is 320px of ammo gauge and
weapon icon. `320 · tan(3°)` is 16.8, rounded up to 17. The two constants are the same measurement
of the same rectangle through the two halves of the same transform — one is how far it comes
forward, the other how far it rises — and `hud-wrap.test.ts` now derives both from the compiled
stylesheet and fails if the gauge is widened without revisiting them.

Measured clearance between the rack's bottom edge and the highest point of the ammo cluster, over
every width and weapon count the HUD has:

| | 1024 (compact) | 1100 | 1280 | 1440 | 1920 | 2560 | 3440 |
|---|---:|---:|---:|---:|---:|---:|---:|
| before | -4.8 | -8.8 | -8.8 | -8.8 | -8.8 | -8.8 | -8.8 |
| after | 14.5 | 8.7 | 8.7 | 8.7 | 8.7 | 8.7 | 8.7 |

Compact gets more air than it asked for, because a 244px cluster lifts 10.5px once projected and the
token is sized for 320. Holding the gauntlet gets 27px for the same reason: no ammo bar is drawn, so
the cluster is an icon wide and barely leans at all. Both are the conservative direction.

**The other way to fix this was to put the rack inside the wrap, and it does not survive the
arithmetic.** One surface, edges aligned at every width, overlap structurally impossible — coplanar
boxes with a gap between them cannot cross under a projective map. What kills it is that
`$hud-wrap-depth` is 136px because a 320px cluster reaches 130px forward through a 24° turn, and
pushing everything back by that much is what puts the near end at or behind the screen plane where
the projection cannot magnify it. The rack is not 320px. Twelve weapons — every weapon in
`balance.generated.json` — is 492px of rack, which reaches 200px, lands 64px in *front* of the
plane, and is magnified 1.056 about a vanishing point it is already far from. Wrapped and measured
in the page:

| window | outer edge of a wrapped rack | window edge |
|---|---:|---:|
| 1920 | 1895.5 | 1920 |
| 2560 | 2553.5 | 2560 |
| 3440 | 3458.4 | 3440 |

It hangs 18px off a 3440 screen, and that is with the *widest* rack on the *shipped* weapon list; a
thirteenth slot is worse. Raising the depth to cover 492px would shrink both corners — including the
health and armour the player reads far more often than they read a rack — by a sixth rather than a
tenth, to pay for a row that is on screen for `WEAPON_SELECT_TIME` after a switch. D-137 put the rack outside the wrap because "a readout you are
actively reading should face you square on", which is a judgement; this upholds it on arithmetic,
which is not.

**What is not fixed.** The rack's right edge still overhangs the ammo cluster's drawn outer edge, by
31px at 1440 and 36px at 3440, and by 61px when the gauntlet, which draws no ammo bar, leaves an 80px cluster. That
is not the wrap: a rack is wider than a cluster and the two are right-aligned in layout, which is
the only anchor available — the cluster's *drawn* edge moves with the screen width, so no fixed
inset can meet it. Restoring the perspective made it 3px worse, and it is not visible against
a background that is already a gradient fading to nothing. The middle column was the thing to check
after moving a corner inboard: the click-to-play line, which is the longest text the port draws and
wraps to two lines at 1280, keeps 24.6px of clearance at 1280 and 23.8px at 1440 from the right-hand
cluster's projected inner edge -- more, at both, than the 18.1px and 17.3px the left-hand cluster has
always left it.

Verified in the Browser pane, at seven widths and three weapon counts, by projecting each corner of
the two elements through the live transform rather than by reading a bounding box — an axis-aligned
box around a sheared quad is not the quad, and the whole of what is being measured is an outer end
that leaves its own box by 17.

### D-153: The plasma gun was its own glow map, because the mask that says which part of it glows belongs to a slot nothing was carrying it to

Reported as over-exposed textures on the plasma gun, with a guess attached: an emissive that was
too aggressively all-glow. The guess was right, and the reason it was right is a slot mismatch that
this file has now made twice in opposite directions.

OA's `models/weapons2/plasma/skin` is four passes:

```
{ map skin.tga            rgbGen lightingDiffuse }                       diffuse, shaded
{ map d_met.tga           blendfunc gl_dst_color gl_src_color  detail }  detail multiply
{ map skin.tga            blendfunc add  rgbGen wave sin 0 1 0 1
                          alphaFunc LT128 }                              the glow
{ map spots.tga           blendfunc gl_dst_color gl_dst_alpha ... }      1999 fake specular
```

The third pass is a glow over a lit surface, which is a glow map, and the projection took it as
one. What it did not take was the `alphaFunc LT128` sitting on the same pass. That test is the
whole of the artwork's intent: `NameToAFunc` maps it to `GL_LESS 0.5`, the default `alphaGen
identity` puts 255 in the vertex alpha and `GL_MODULATE` leaves the fragment alpha as the image's
own, so the pass draws exactly where `skin.tga`'s alpha channel is under 128. In OA's artwork that
is **1.8% of a 512x512 image** — the coil window and four segment lights, and nothing else.

The port emitted all of it. `emissiveLuminance` is `UNLIT_LUMINANCE`, 16.2 cd/m2, and it was
multiplying a texture whose mean luminance is 0.149 across 82% non-black texels, so the gun added
**2.42 cd/m2 of unshaded light at every pixel of itself**, on top of its diffuse term. This port's
own measured range for an ordinary lit wall is 1 to 6 cd/m2 (D-150). The gun was as bright as the
room, everywhere, and it was that way in a renderer that had otherwise shaded it correctly.

| | texels emitting | mean emitted luminance | over the gun |
|---|---|---|---|
| before | 82.1% | 0.149 | 2.42 cd/m2 |
| after | 1.8% | 0.0027 | 0.04 cd/m2 |

**The mask is not lossy, and that is the point.** D-084's note beside `alphaTested` says `LT128` is
an inverted test that a cutoff cannot express, and records it as a drop. That is true of the
*transparency* slot, where the whole statement has to fit in one number, `alphaCutoff`. It is not
true of the emissive, which is a **texture**: a per-texel binary test restates into one exactly, by
writing the image black where the test fails. Every other entry in `texture-out.ts`'s table trades
something away — luminance for coverage, a whole image for its mean — and this one trades nothing.
So `alphaFunc LT128` stops being counted as a loss in the one place where it is not one.

The two faults were the same mistake with the sign flipped. Reading the test off *any* stage
alpha-tested the whole gun on the strength of a glow pass three stages down; fixing that by reading
it off the albedo stage alone left the glow pass's test dropped entirely. A test belongs to the
pass that carries it, and the pass decides which slot it lands in.

**The key needed a third axis or the fix would have done nothing.** The plasma gun names one image
for both its skin and its glow, so both references key to `models/weapons2/plasma/skin`, and
`textureKey` is what the write memo is keyed on. Before this the two shared a file — and shared it
in the wrong direction, since the albedo is written first and with `mapsRoot` set, so the emissive
was silently getting the *de-lit* albedo, an image that is a statement about diffuse colour and
about nothing else. `#lt128` splits them, and the emissive now gets its own write with no de-lit
applied, which is what the model converter was asking for all along.

**The class, counted rather than asserted.** An `alphaFunc` on an additive pass appears 19 times
across OA 0.8.8's 104 shader scripts. Eighteen are `GE128` on CTF team textures, team icons, the
`proto2` set and two Lei effects, none of which this port builds; the nineteenth is the plasma gun.
So the shipping blast radius is one material, and the fix is in the projection anyway, because the
other eighteen are one converted CTF map away from lighting up the same way.

**What was looked at and left alone.** Three neighbouring shapes turned up in the same sweep and
none of them is this bug:

- **`rgbGen` on a glow pass**, dropped for 8 shipping materials as `wave` and 3 as `const`. That is
  a *scale*, not a mask, and where it is a coloured one a grey `emissive_factor` cannot state it at
  all. Six of the eight are world materials whose luminance `convert-map.ts` refits photometrically
  from flux over area, so a scalar folded in upstream would be discarded. Making the emissive
  factor a colour is the honest fix and it is a change to the photometric fit, not to this.
- **`textures/evil8_lights/evil8_rlight`**, whose emissive is its whole albedo. That is the
  `q3map_lightimage` fallback firing with no lightimage declared, on a shader that names no glow
  image at all — there is no mask in the content to carry. Its brightness is fitted rather than
  assumed, which is the difference.
- **The pulsing.** `rgbGen wave sin 0 1 0 1` means the coils breathe between off and full, and the
  port emits them at full continuously. On 1.8% of the surface that is a coil that does not pulse,
  not an over-exposed gun, and it is the same class as the entry above.

Verified in the Browser pane on `oa_dm1` with the gun in hand: a dark shaded casing with four
bright coil segments, which is a plasma gun. `materials.test.ts` gains the rule tests and a bundle
invariant that reads the written glow map back against Q3's own alpha channel and fails if a texel
Q3 rejects emits anything — the suite was green through the whole of this bug, having asked whether
the gun was transparent and never what it was emitting or over how much of itself.

### D-154: The fog was the particle, not the density, and the box that proved it is 100 m rather than 600

Reported: the volumetric lighting D-151 added reads as a foggy environment, the extinction is too
high, and what is wanted is a per-map preset drawn from meep's `MIE_PARTICLES_STANDARD_PRECOMPUTED`
leaning toward normal city haze -- enough for depth cues at the ranges the maps actually have. Plus
one volume per map, made much larger than the map.

**The diagnosis was wrong for a day and it mattered which half was wrong.** D-151 left the particle
at meep's default and tuned only the density. That default is `FOG_DROPLET_MEDIUM` in all but name
-- 5 um water droplets, `g` 0.853 -- and the phase function does not read the density at all:
`shader_volumetrics_build_participating_media` packs `diameter_micron`, and
`jendersie_deon_get_fog_params` looks the scattering lobe up from *that*. A 10 um droplet carries
the forward diffraction peak that puts a halo round a lamp in fog. No density removes it; it is a
different curve.

So the two were separated before either was touched, at a fixed camera down `am_thornish`'s long
hall, by swapping only the particle at the **original** 0.005/m:

| medium at 0.005/m | what the frame shows |
|---|---|
| `FOG_DROPLET_MEDIUM`, 10 um | every ceiling lamp haloed, the upper half of the frame washed white |
| `CONTINENTAL_HAZE_MEDIUM`, 0.5 um | a hall with air in it; depth builds down the colonnade |

Same optical depth, same lights, same frame. **The particle was most of the complaint.** The
density came down afterwards on its own merits rather than to compensate for it, which is the only
reason it could come down as little as it did.

**The sightlines were measured, and the measurement's main use was to kill the idea it was taken
for.** 256 rays per origin from every spawn, item, weapon and ammo entity on each map's own
collision hull, eye height, azimuth uniform, elevation within 25 degrees of horizontal:

| map | median | p95 | p99 |
|---|---:|---:|---:|
| `oa_dm1` | 3.9 m | 15.3 m | 21.5 m |
| `oa_dm4` | 3.4 m | 13.1 m | 18.2 m |
| `oa_dm5` | 3.8 m | 14.6 m | 21.2 m |
| `oa_dm7` | 6.1 m | 24.9 m | 35.9 m |
| `aggressor` | 3.9 m | 15.7 m | 20.9 m |
| `am_thornish` | 6.3 m | 55.9 m | 94.7 m |

Half of every sightline in this game is under six metres. The obvious use of that is to normalise
each map's extinction so all six carry the same optical depth at the same *rank* of sightline, and
that is wrong, because most of what a player sees is not extinction along a sightline -- it is
in-scattering around the lights, which scales with density and does not care how far away the wall
behind it is. Normalised that way `am_thornish` came out at 0.0008/m and was indistinguishable from
the feature being off, on the one map with room for atmosphere. The shipped numbers therefore sit
within +-20% of a single 0.0020/m, which is the same claim as "the six maps are outdoors on the same
afternoon", and the sightlines only earn that +-20%: `oa_dm4`, the tightest, takes the most per
metre; `am_thornish`, with twice the p95 of the next map, takes the least, which holds the loss
across its 178 m diagonal to 25% rather than 30%.

**The particles come off each map's own sun**, on the reading that a sun's colour is a statement
about what its light travelled through. `oa_dm1` has no sun at all, so it has no weather and gets
`FINE_DUST_SMALL` -- the only entry chosen for its *albedo*, 0.92/0.90/0.88, because a room full of
something with albedo 1.0 can only ever get brighter and that map is meant to be dim. `oa_dm4`'s sun
is 0.64/0.13/0.13, by a distance the reddest of the six, and dust is what reddens a sun, so it gets
the same particle. `oa_dm5`'s is the dimmest and coldest at 7 lux, so `MARITIME_HAZE_MEDIUM`, whose
2.04 blue-to-red extinction ratio is the strongest tilt in the library. The other three get the
default haze.

| map | particle | extinction | visibility | T at its own p95 |
|---|---|---:|---:|---:|
| `oa_dm1` | `FINE_DUST_SMALL` | 0.0022 | 1.8 km | 0.967 |
| `oa_dm4` | `FINE_DUST_SMALL` | 0.0024 | 1.6 km | 0.969 |
| `oa_dm5` | `MARITIME_HAZE_MEDIUM` | 0.0021 | 1.9 km | 0.970 |
| `oa_dm7` | `CONTINENTAL_HAZE_MEDIUM` | 0.0018 | 2.2 km | 0.956 |
| `aggressor` | `CONTINENTAL_HAZE_MEDIUM` | 0.0020 | 2.0 km | 0.969 |
| `am_thornish` | `CONTINENTAL_HAZE_MEDIUM` | 0.0016 | 2.4 km | 0.914 |

Visibility is Koschmieder's `3.912 / extinction`. The band is 1.4 to 3.3 km, which is a hazy city
day at one end and a smoggy one at the other; 0.0039 is where meteorology stops saying haze and
starts saying mist, and D-151's 0.005 was 780 m and was fog by definition.

**"Much larger than the map" turned out to have a ceiling, and it is a long way below the far
plane.** D-151 fitted the box to the map with an 8 m margin and argued that the box's size is a
decision about the sky and nothing else -- a ray that hits a wall cannot tell how far the box
extends past it, and only a ray through a hole where `convert-map` dropped a sky surface can, since
that one runs to `camera.clip_far`. That argument survives; the number it landed on does not.

The tempting size is the far plane itself, 600 m, because then the medium is unbounded as far as any
frame is concerned and the box stops being a tuning variable at all. Looking up out of `oa_dm7`'s
courtyard at 0.0018/m:

| margin | box, on a 55 x 41 x 42 m map | sky |
|---|---|---|
| 600 m | 1255 x 1241 x 1242 | dusty pink; the blue is gone |
| 200 m | 455 x 441 x 442 | washed toward mauve |
| 100 m | 255 x 241 x 242 | the map's own blue, hazing warm toward the horizon |

**The failure is not the renderer's.** The environment map already contains a sky, which is to say
it already contains an atmosphere's worth of scattering, and 600 m of medium in front of it charges
twice for the same air. 100 m is the largest margin that keeps the double-count reading as haze on
the map's own sky rather than as a colour grade over it -- and it is still between 2.6 and 6.4 times
the map on every axis, 20 to 260 times by volume, which is "much larger than the map" by any
reading. `skyOpticalDepthOf` is that budget written down (0.16 to 0.24 across the six, so 15% to 21%
of the skybox replaced), and a test bounds it, so the two constants cannot drift into each other.

**Two things the adversarial pass found, both silent.** `atmosphereFor` was
`MAP_ATMOSPHERE[map] ?? DEFAULT_ATMOSPHERE`, which for a map called `constructor` or `toString`
answers with a *function* off `Object.prototype` -- and TypeScript types that lookup as an
`AtmospherePreset` and says nothing, so the failure would have surfaced two calls later as
"undefined is not in MIE_PARTICLES_STANDARD_PRECOMPUTED". It is `Object.hasOwn` now. And
`mediumFor` has to write the particle *before* the extinction, because `target_extinction` is a
setter that divides by the particle currently held: the other order leaves the fog droplet's
density behind, which against continental haze is a factor of 250 in the direction of a solid white
wall, with nothing raised. A test asserts the resulting density against the cross-section it should
have come from, per preset.

**What is not established.** The frame cost, still, for D-151's reason: the Browser pane hides
itself between calls, `rAF` stops with it, and every attempt at a frame-time comparison timed out
mid-measurement. And the three per-map particles were chosen from the map's sun and then *checked*
in the running game -- each of the six was loaded and looked at -- rather than won against the
alternatives in an A/B. `FINE_DUST_SMALL` on `oa_dm4` looks right; nobody has seen what
`SMOKE_PARTICLE_SMALL` would have looked like there.

### D-155: The eye was blended and the heading was not, so half of the render-rate camera had never been applied

Reported as the camera moving in jerks when the mouse moves. It is the same fault D-081 fixed, in
the same method, on the quantity that fix did not reach.

`writeCamera` runs once per rendered frame and reads two things. The eye is blended between the
last two fixed steps at the sub-step alpha, which is what D-081 added and what stopped the *world*
juddering. The view angles were read off `ps.viewangles` -- and `ps.viewangles` is not a live
quantity. `PM_UpdateViewAngles` is the only thing that writes it, `PmoveSingle` and
`PlayerMovement.step` are the only things that call that, and both run on the fixed step. So the
array is the mouse accumulator *as of the last step that ran*, and orienting a render-rate camera
from it puts the player's heading straight back on the simulation's clock.

The method's own doc comment claimed the opposite -- "the view angles are read live, from the same
accumulator the mouse writes" -- which is why this survived a fix that was otherwise about exactly
this. The sentence describes `this.yaw`; the code read the array `this.yaw` reaches one step later.

**Measured in the running game, at 165 Hz against the 60 Hz step, turning at a steady 3 px of mouse
per rendered frame.** Both quantities recorded on the same run: the camera's actual heading, taken
off the transform's quaternion, and `ps.viewangles[1]`, which is what the old line read.

| | per-frame turn | frames that did not turn |
|---|---|---|
| `ps.viewangles` (before) | 0, 0, -0.593, 0, 0, -0.593, 0, -0.396 ... | 20 of 32 |
| live angles (after) | -0.198, every frame | 0 of 32 |

Two frames of nothing and then three frames' worth of turn arriving at once, for ever. 3 px x 12
short units is 0.198 degrees, and three of those is the 0.593 that was being delivered in one jump
-- the totals match to the last digit, so the turn was never wrong in aggregate and was never
anywhere but in lumps. That is the whole of what a player feels.

**The fix is `PM_PreviewViewAngles`, which is `PM_UpdateViewAngles` with the writes taken out.**
Same 16-bit truncation, same +/-16000 pitch clamp, same two refusals -- an intermission and a corpse
do not turn -- against a scratch `Int16Array` holding the live accumulator. It returns whether it
wrote anything, and false means pmove would have refused, in which case `ps.viewangles` is current
by definition rather than stale and the caller keeps reading it.

Three things it deliberately does not do.

It does not repair `delta_angles` on a clamped pitch. That write is how a server tells a client
where it is now looking; it belongs to the step, and a render-rate reader performing it would be a
second author of simulation state running at an unbounded rate. Nothing is lost -- the controller
clamps its own accumulator to +/-16000 before the array ever sees it, so the branch cannot fire from
this call site.

It does not write into `pmove.cmd.angles`. That array is the step's input, `fireIfReady` and both
solvers read it back, and truncating through a private `Int16Array` costs six bytes and keeps the
presentation out of it.

And it does not touch where the shot goes -- `fireIfReady` still fires along `ps.viewangles`.

**That last one is the obvious objection to the whole change, and measuring it turned it around.**
The worry is that the view and the bullet now come off different clocks. They do. But `fireIfReady`
runs *inside* the step, after `PM_UpdateViewAngles` has already taken the same accumulator, so a
shot always leaves along the freshest angle in the system; the only question worth asking is how far
the last frame the player actually *saw* was from it. Same run as above, as the angle between the
heading drawn on a frame and the heading the next step fires along:

| | mean | worst |
|---|---|---|
| `ps.viewangles` (before) | 0.557 deg | 0.593 deg |
| live angles (after) | 0.377 deg | 0.593 deg |

The gap **shrinks by a third**. The worst case is identical and is the frame that lands on a step,
where the two agree by construction. So the old camera was not only jerky, it was showing an aim up
to a whole step behind the one the trigger was about to use, and the fix closes that as a side
effect of closing the other thing. The first draft of this entry claimed the divergence as an
accepted cost "the same 16 ms Q3 has"; it is not a cost, and Q3 does not have it in that form --
Q3 builds a `usercmd_t` per rendered frame, so its camera and its shot come off one command.

The kicks stay blended, and that is not an oversight either. `previous.pitch` and `latest.pitch` are
`CG_OffsetFirstPersonView`'s *offsets* -- the bob, the landing dip, the damage kick -- and they are
solver outputs that cannot be recomputed without re-running it. Blending them is right for the same
reason blending the eye is. Only the base angle is live, because only the base angle is the mouse.

`test/player-controller.test.ts` pins both halves: a mouse move with no step between it and the
write has to turn the camera, and two writes with no input between them have to produce the same
heading. The second is the one that would catch a "live" reading that drifted with alpha.

### D-156: an effect's width comes from the artwork Q3 painted, not from the quad it was painted on

Reported as *"plasma projectiles spawn way too large"* and *"the lightning gun's tracer is too
wide"*. Both are the same mistake made in two files, and the check for it caught two more.

Four of Q3's weapon effects are a quad with a picture on it, and this port draws all four as
solid geometry: the plasma bolt is an emissive sphere with a light inside it (D-130), and the
lightning, rail and machinegun trails are `Trail3D` tubes. The size each of them was drawn at
came straight out of the C:

| effect | C | what it means |
| --- | --- | --- |
| plasma bolt | `CG_Missile`'s `ent.radius = 16` | `RB_AddQuadStamp` corners at `origin ± left ± up` |
| lightning | `RB_SurfaceLightningBolt`'s `DoRailCore(..., 8)` | `DoRailCore` extrudes `±spanWidth` |
| rail core | `r_railCoreWidth` default `6` | as above |
| tracer | `cg_tracerWidth` default `1` | `CG_Tracer` extrudes `±width` by hand |

Each doubled to a diameter, and the doubling was right. **The quantity was wrong: every one of
those numbers is the size of the image, not the size of the light.**

A Q3 effect shader is a bright filament or core inside a wide dark margin, and the margin is
the falloff the artist painted. Solid geometry has no margin, so drawn at the quad's extent it
paints the whole falloff at core brightness. That is a plasma bolt drawn as a faceted ball the
size of a wall brick, and a lightning beam half a metre thick — wider than the rail slug, and
about a third of a player's width.

**So the width is measured from the texture now.** `tools/extract-effect-widths.ts` reads each
shader out of the game's own scripts, decodes every texture its stages name, and takes the
**equivalent width** of the cross-section — the width of the top-hat carrying the same total
light at the same peak brightness:

```
beam:    W_eq = integral(I dv) / peak(I)
sprite:  R_eq = sqrt( integral(I dA) / (pi * peak(I)) )
```

Threshold-free, which is why it rather than a percentile: "where does a glow end" has no answer
and every cutoff is a different opinion, while this one is an integral. It is also invariant to
how many additive passes a shader stacks — a second copy of an image scales the integral and
the peak together — which matters because `sprites/plasma1` draws its texture twice and
`lightningBoltNew` draws two animated stages over six frames.

| effect | shader | quad | painted core | FWHM |
| --- | --- | --- | --- | --- |
| plasma bolt | `sprites/plasma1` | 32 | **11.17** | 10.13 |
| lightning | `lightningBoltNew` | 16 | **2.16** | 2.04 |
| rail core | `railCore` | 12 | **2.03** | 1.50 |
| tracer | `gfx/misc/tracer` | 2 | **0.98** | 1.00 |

Equivalent width and half-maximum agree to within 15% on all four, which is the check that no
profile has a pathological tail; both are emitted.

**The tracer is the control.** It barely moves, and that is not luck: `gfx/misc/tracer2` is a
16×16 blob that fills its quad, because at two units across there is no room for a margin.
Where Q3 gave the artist room, the artist spent it on falloff; where it did not, there is
nothing to take away. A method that shrank *everything* would be a method that had found the
answer it went looking for.

What is left outside the core is the falloff, and the falloff is the bloom chain's:
`downsample_karis` weights every pixel by its own luminance rather than testing it against a
cutoff, so a bright narrow thing spreads in proportion to how bright it is. Core in geometry,
halo in post. `MissileView` already said that was what it was doing — and then halved Q3's 16
to 8 and called the result a core. It is 5.59.

**Two things this deliberately does not do.**

It does not fatten the rail core to stand in for the spiral. Q3 draws `RT_RAIL_RINGS` at
`r_railWidth` 16 around the core and this port never has; that is an omission worth its own
fix, and a beam widened to cover for a missing one is a number that means nothing and can be
checked against nothing.

It does not extract the four quad extents from the C. They stay written down in the tool with
their citations. They were never the wrong numbers, and lifting a renderer literal and two cvar
defaults out of C by regex is a fragile way to restate four constants that have not moved since
1999.

The output is `src/client/effectWidths.generated.json`, committed for the reasons
`balance.generated.json` is — it derives from GPLv2 content, it is small, and the runtime must
not depend on the asset tree being present. `npm run check` re-measures and fails if it is
stale, so the numbers cannot drift from the textures they came from, and `Effects.ts` holds a
measurement *key* per weapon rather than a width, so a width cannot be edited there at all.

Values are rounded to hundredths of a Q3 unit. `--check` compares bytes, a JPEG decoded by a
different libjpeg build can differ in a channel's last bit, and a tenth of a millimetre of beam
is not worth failing a build over.

**Why matching the *width* is enough to match the light.** "At the same peak brightness" is the
half of the definition the port already satisfies: the bolt's emissive luminance is a fixed 300
— calibrated in D-130 against `base_light/light5_15k`'s 295.7, the brightest fitting in
`am_thornish` — and each trail's colour is a fixed constant. Neither moves here. So holding
brightness and fixing the width at the equivalent width is what makes the *total* light these
four things emit equal to the total light Q3's shaders emitted. The quad extent had the plasma
bolt putting out a little over twice as much and the lightning beam nearly eight times as much,
which is why the room lit up around them.

Trails draw at `FramePhase.AfterTransparency`, which the renderer runs before
`graph_postprocess_bloom`, so "the halo is the bloom chain's" is true of the three beams and not
only of the bolt.

### D-157: the rail spiral is a helix of sprites, and `r_railWidth` belongs to a path Q3 stopped taking in 1.30

Reported as a follow-on to D-156: the railgun draws a bare line where Q3 draws a line inside a
corkscrew. Both halves of that are true. This port has only ever drawn `CG_RailTrail`'s core,
and D-156 took that core from 12 units to the 2.03 its artwork paints — correct, and it made
the missing spiral impossible to ignore.

**The spiral everybody cites is not the spiral the game draws.** `RT_RAIL_RINGS` — the quad
strip `RB_SurfaceRailRings` hands to `DoRailDiscs` at `r_railWidth` 16 and `r_railSegmentLength`
32 — came out of `CG_RailTrail` in Q3 1.30. The OA cgame keeps it, behind `cg_oldRail`, whose
default is `"0"` (`cg_main.c`), and past that branch is an unconditional `return`. What the
shipped default builds instead is a **helix of sprites**:

```c
#define RADIUS   4
#define ROTATION 1
#define SPACING  5

for (i = 0 ; i < 36; i++)
    RotatePointAroundVector(axis[i], vec, temp, i * 10);

VectorMA(move, 20, vec, move);
...
    re->reType     = RT_SPRITE;
    re->radius     = 1.1f;
    re->customShader = cgs.media.railRingsShader;      // "railDisc"
    ...
    VectorMA(move2, RADIUS, axis[j], move2);
    le->pos.trDelta = axis[j] * 6;
    le->endTime     = cg.time + (i >> 1) + 600;
...
    j = (j + ROTATION) % 36;
```

One sprite every five units, four units off the shot line, stepping ten degrees of a
thirty-six-way table each time — a full turn per 180 units. That is a long, gentle winding, not a
tight corkscrew, and it is the thing on screen.

**So `r_railWidth` 16 is the wrong number twice.** It is not on the path that runs; and on the
path it does belong to it is not a quad extent either. `DoRailDiscs` puts its four corners at
`0.25 * spanWidth` on a circle at 45/135/225/315 degrees and maps `0..1` of the texture across
the square they inscribe, so 16 draws a **5.66**-unit quad. Neither reading makes it sixteen.

#### The width, measured the way D-156 measures everything

`railDisc` is one additive `clampmap` of `models/weapons2/railgun/f_railgun3` under `tcMod
rotate 130` — a rotating sprite, which is exactly the case `spriteProfile`'s inscribed disc was
written for. `extract-effect-widths.ts` gains a fifth row and the quad is `re->radius = 1.1`
doubled, because `RB_SurfaceSprite` corners at `origin ± radius`:

| effect | shader | quad | painted core | FWHM |
| --- | --- | --- | --- | --- |
| rail rings | `railDisc` | 2.2 | **0.68** | 0.72 |

Equivalent width and half-maximum agree to 6%, the tightest of the five. A transcription of
`r_railWidth` would have drawn the strand **twenty-three times** too wide — a corkscrew whose
threads are thicker than the beam they are wound around, and thicker than half a player.

#### A `Trail3D` can be a helix; the engine's two seeders cannot

`seed_trail_tube` collapses every knot onto the head and needs something that travels.
`seed_trail_stroke` lays the whole shape down at birth, which is right, and lays it down as
**two knots sharing one frame** — it says why in its own margin: *"the stroke is straight, so
every ring shares one frame and no transport is needed."* Those are the only two assumptions in
the way. `src/client/helixStroke.ts` takes both back out: as many knots as the curve needs, and
`tube_frame_transport` — the engine's own rotation-minimising frame, the one a moving trail's
head uses when it turns a corner — per knot. A wound tube therefore bends by the same code a
dragged one does, and the simulator downstream only ever touches age, alpha and the along-tube
UV, so a seeded curve stays the curve it was seeded as.

Knot spacing is Q3's `SPACING`, so a knot lands where Q3 put a sprite; ten degrees of a
4-unit-radius helix is half a millimetre of chord error, orders below a pixel. **Turn rate and
knot spacing are separate parameters even though the C states them as one thing**, because
folded together the first person to want a smoother curve gets a differently-wound one.

The winding direction ports. `RotatePointAroundVector` conjugates its planar rotation by a basis
whose `vup` is `vr × vf`, and the two sign flips cancel to leave the plain right-hand rule about
the shot; `toMeep`'s axis swap has determinant +1, so the corkscrew turns the way Q3's does. The
*phase* does not port and is not a parameter — Q3 starts at `axis[18]`, half a turn round a
perpendicular `PerpendicularVector` chose, and where a helix starts on its own circle is not
observable.

#### The lifetime gradient falls out exactly

`le->endTime = cg.time + (i >> 1) + 600` gives each ring half a millisecond of extra life per
unit of distance, so a long shot's far end outlives its 600 ms core by seconds. That is linear in
distance, and the stroke seeder's two-ended age is linear in `f`, so the trail's `maxAge` is the
farthest ring's life and the near end is seeded having already lived the difference. Every knot
dies at the millisecond its sprite did — reproduced, not approximated.

#### Four divergences, all deliberate

**The tube is continuous where Q3's spiral is dotted**, and this is the one worth a number.
Q3's rings are 0.68 units of painted core every 5.05 units of arc, so the strand is mostly gap;
a tube has none and puts out about **9.5×** the light. The alternative is a strand thin enough
to carry the same integral once the gaps are closed, and that is 0.07 Q3 units — two
millimetres, a seventh of a pixel at the range a rail shot is read at. Better a spiral you can
see than an integral you cannot; this is the failure D-156's tracer row guards against from the
other side.

That ratio reads worse on paper than it looks in the pane. Photographed in `oa_dm1` against a
550-unit shot, the strand is a fine thread — clearly a corkscrew when the core is beside it, and
close to invisible on its own, because 0.68 units is two centimetres and the tube carries no
falloff of its own to spread. So the 9.5 buys back most of what the gaps took and the result is
subtle rather than hot. If that ever changes, the lever is the strand's *alpha*, which is
nobody's measurement, and not its width, which is one.

**The rings do not drift outward.** Q3 gives each sprite `trDelta = axis[j] * 6`, so the spiral
blooms from 4 units to nearly 8 as it fades. `Trail3D`'s simulator ages and fades knots and never
moves them, and a seeded curve is fixed at birth. Porting it would mean re-seeding positions
every frame for up to sixteen hundred knots to animate an effect that is already fading out.

**It stops at what was hit.** Q3's `move` starts twenty units down the shot and the loop still
runs `ceil(len / SPACING)` times, so the last three or four rings are *inside* whatever stopped
the shot, where the depth buffer eats them. Ending at the impact point draws what Q3 shows rather
than what it submits — and a corkscrew emerging from the far side of a thin wall would be
neither. A shot shorter than twenty units gets no spiral at all, which is the same statement.

**The colour is a constant, as the core's already is.** Q3 draws the core in the shooter's
`ci->color1` and the rings in `ci->color2` — the *other* of a player's two colours, so the two
are always distinguishable — and the stock defaults are `color1` `"4"` and `color2` `"5"`
(`cl_main.c`), which `CG_ColorFromString` turns into red and magenta. There are no player colours
here. What carries across is the relation rather than the pair: the rings are not the core's
colour, and by default they are the broader-spectrum of the two, which against a blue-white core
is a paler blue-white.

#### Cost

`round(length / 5) + 1` knots at nine ring vertices each. A thousand-unit shot is 197 knots and
about 1,800 vertices; the worst case a Q3 map can produce is the railgun's own 8192-unit trace,
1,635 knots and under fifteen thousand — a shot fired down the longest sight line in the game.
There is no cap in `makeHelixStroke` because the caller's range already is one.

### D-158: two weapons never got D-115's fix, and one of them is what every player spawns holding

D-115 moved the muzzle flash light off the view axis and onto `tag_flash`, and the report it fixed
was "the muzzle flash light seems to be centered on the player". It was reported again. The light
still lands on the view axis for the gauntlet and OA's prox launcher -- `CalcMuzzlePoint`, fourteen
units dead ahead of the eye at eye height, 44 cm of nothing -- because those are the two weapons
whose world models ship no `tag_flash`, and D-115's `ViewWeapon.flash` declined them and handed them
back to `Effects`. The gauntlet is one of the two weapons a player spawns with, so the commonest
flash in the game was the one the fix was named after.

**Measured before it was believed.** The eleven weapons that do carry a tag are correct, and were
checked in the running app rather than argued about: the machinegun's light projects *inside the
ring of its own barrel's muzzle*, 0.74 units past where the mesh stops and 0.03 off the axis the
barrel is drawn along. On nine of the eleven the tag sits within 2.6 units of the end of the mesh;
the two that reach further are the grapple, whose hook is 7 units past its own flash tag, and the
shotgun, whose laser sight is 22. Nothing about the placement arithmetic was wrong. What was wrong
was the answer to "and if there is no tag?", which was "put it back in the middle of the screen".

**The muzzle is asked of the model, in three steps.** `ViewWeapon.muzzleOffset`, each step a fact
about *that* mesh rather than a number somebody picked:

| step | what it reads | who reaches it |
| --- | --- | --- |
| 1 | `tag_flash`, the muzzle its author marked | eleven weapons |
| 2 | `tag_barrel`, the mount its author marked for the front of the gun -- for the gauntlet, where the blade goes | the gauntlet |
| 3 | the front of its own bounds, at the centre of that face | OA's prox launcher, whose world model carries no tags at all |

Step 3 is an estimate and is labelled one. What can be said about it is measured: run it on the
weapons it *would* be reached for -- one file, no barrel model -- and compare against the muzzle
their authors did mark, and it is within 0.45 to 4.3 units on all six. Its failure mode is pinned
in the same test rather than left to be discovered: `shotgun.md3` carries a second surface that is
not the gun, an additive laser-sight beam running out to x = 45, which drags the model's bounds
twenty-two units past the barrel. The shotgun marks a `tag_flash` so the estimate never runs on it,
and that is exactly why the estimate is the last step and not the rule.

**`barrelOffset` deliberately did not take the wider answer.** The same three steps would give the
prox launcher a projectile spawn point too, and it keeps `CalcMuzzlePoint`. A lamp wants to be on
the gun and can be estimated onto it; a projectile's birthplace decides what a rocket clears and
what it detonates against, and D-116 already trades ten units of aim to move it there. That trade
is worth making against a point a modeller authored and is not worth making blind.

**What is left of "the gun declines".** Two refusals, both about there being no gun: a dead player,
and a weapon the bundle has no model for. The third -- no tag -- is gone, because a gun that is
drawn has a front whether or not anybody marked it. `Effects.muzzleFlash` keeps every other
shooter, which is every bot, and stays the honest answer there: nothing draws a weapon model for
them, so there is no barrel to hang anything on.

The *visible* half of the flash is untouched and still gated on `hasFlashModel` -- Q3's own
`if (!flash.hModel) return;` -- so the gauntlet lights the room and still throws no sparks. Those
two halves used to disagree about where as well as whether, and now they only disagree about
whether, which is the disagreement D-115 argued for.

Pinned by `muzzle-flash.test.ts`: that all thirteen weapons land further out than `CalcMuzzlePoint`,
on the side the gun is drawn, below the crosshair and more than five units off the view axis; that
the cascade takes step 1 eleven times, step 2 for the gauntlet and step 3 for the prox launcher and
nothing else; and the two claims about the estimate above. The gauntlet's own light was looked at in
the preview browser, on the blade, where the old one was on the crosshair.

### D-159: a bot's line of sight was a swept box, because the seam it was asked through had no way to say "ray"

Reported as an inefficiency in `Bots.perceive`, and it is one — but the interesting part is not
that the query was slow, it is *why nobody could see that it was*. The call read:

```ts
const line = this.world.trace(this.scratch, [0, 0, 0], [0, 0, 0], this.playerEye, MASK_SHOT);
if (line.fraction < 0.99) return;
```

Zero mins, zero maxs: the caller is saying "a ray". Nothing downstream believed it. `BotWorld.trace`
is `pm->trace`'s shape, so on the shipping backend it reaches `PhysicsTrace.trace`, which builds a
`BoxShape3D` out of those zeros — grown by `SURFACE_CLIP_EPSILON`, so not even degenerate — sweeps
it with `shape_cast`, and then, because a *sweep* has to answer questions a line never asks, runs
`overlap_shape` and the ported `CM_TraceThroughBrush` over the result to recover a contact plane and
`startsolid` flags. For an answer whose only reader is `fraction`.

**Measured on `oa_dm1`, over eye-to-eye segments at bot engagement range:**

| | µs per query |
| --- | --- |
| `shape_cast` on a zero-size box (what it was doing) | 19.3 |
| meep `raycast` | 1.37 |
| `CM_BoxTrace` with zero extents (`tw.isPoint`) | 0.55 |

`aggressor` 28.1 → 1.40, `am_thornish` 48.4 → 2.37, `oa_dm7` 10.2 → 0.95. The multiplier climbs with
map size because a sweep's broadphase candidate set is its swept AABB, and this sweep is 2200 units
long — the longest in the game. pmove's own traces are a frame of movement and cost 4.2 µs; the
query nobody was measuring cost five times that, six times a frame.

**What it cost the whole simulation.** A six-bot deathmatch on `oa_dm1`, no renderer, 30 s at
125 Hz: **221 µs a frame before, 102 µs after.** One query, more than half the simulation. And
`bench-match`'s "traces/frame" figure for the physics backend fell from 6.0 to **0.0**, which is the
part worth keeping: bots run on `KinematicMover`, which sweeps inside meep rather than through the
`PhysicsTrace` seam, so every physics trace that harness has ever counted in a match *was* the bots'
line of sight. GAP-021's "6.0 queries a frame against the 30.4 this entry was written about" was
counting six zero-size boxes.

**The fix is not a faster trace, it is asking the right question.** `WeaponSystem` already had this
query. `CanDamage` — Q3's "is there anything between the blast and the target" — has been a
`raycast` since phase 9, with the argument written down in `DamageQueries.ts`: *"A ray is cheaper
than a sweep and needs no shape, so a line of sight is a ray."* The bot never got it, because the
bot asked the world through a movement seam instead of asking the weapon system.

So `canDamage` is now the public `WeaponSystem.visible(from, to)`, and `BotWorld.trace` is gone,
replaced by `BotWorld.visible(from, to): boolean`. `BotEntityVisible` and `CanDamage` are the same
question and are now the same method — with the two implementations that question deserves, a
`raycast` where there is a broadphase and `CM_BoxTrace`'s `isPoint` path where there is not.

**A boolean, not a trace.** The seam went from five arguments and a `TraceResult` to two arguments
and a `bool`. That is what made the old shape unfixable in place: `trace(start, mins, maxs, end,
mask)` *can* be handed a ray and has no way to be told it was, so every implementation behind it has
to assume the general case. A signature that cannot express "line" gets a box.

**Three behaviour changes, all deliberate.**

- **`fraction < 0.99` is now `fraction === 1`.** The 1% was slop for a box: a swept hull one
  epsilon fat clips geometry near a target pressed against a wall, and the tolerance hid it. A line
  has no width and needs no allowance, and `CanDamage` has tested `=== 1.0` all along. Measured over
  490 spawn-to-spawn and fan segments on `oa_dm1`, 648 on `aggressor` and 268 on `oa_dm7`: the new
  answer agrees with the old on **every one**.
- **On `am_thornish`, the ray disagrees with the old box twice in 1856** — grazing contacts where
  the epsilon-fattened box caught a surface the line misses. That is the box being wrong, not the
  ray.
- **On the `?move=q3` backend, bots now see through curved surfaces.** That backend has no
  `DamageQuery`, so `visible` takes the clipmap, and the clipmap does not collide patches (D-017).
  Accepted rather than worked around, because on that backend the bot's *bullets* already pass
  through those columns — `hitscanShot` traces the same clipmap — and so does `CanDamage`. The old
  arrangement had a bot refusing to fire at a player behind cover its own shots ignored. Sight and
  shot now agree, which is the property worth having when they cannot both be right.

**Pinned by `damage-queries.test.ts`**: 714 segments on `oa_dm1` — spawn eye to spawn eye, plus a
seeded fan of short and long rays — must get the same answer from both implementations, and the
sample must contain both answers (78 clear, 636 blocked). A query stuck on either one fails it;
both mutants were run.

**`visible` got its own scratch `TraceResult`** rather than sharing the module's `trace`. The other
users are private and each reads its result before returning; a public method called once a frame
from outside any shot is a different lifetime, and the trap it sets — overwriting the trace whose
`surfaceFlags` decides whether a bullet leaves a mark — is the kind that surfaces as a cosmetic bug
months later.

### D-160: the muzzle flash column comes down by half, and the light is the only half of the flash that moves

Reported the same way the last cut was: the flashes are too bright, and too bright everywhere rather
than on one weapon. So the answer has the same shape — one factor over the whole of
`muzzleFlash.ts`'s `lumens` column, 0.5, applied to the twelve weapons `balance.weapons` names and
to the `default:` arm a thirteenth would reach. The gauntlet goes 560 → 280 and the BFG 4,200 →
2,100; every value between them halves with them, and all thirteen land on integers.

**Why a factor and not thirteen judgements.** The `lumens` column is the one column of that table
Q3 does not supply — a Q3 dlight is a colour and a radius, so every flash in the game is equally
bright — and what this port authored was not thirteen brightnesses but a *set of ratios* against the
explosion's 12,000 lm: a shotgun blast is the big one, the machinegun's is small and constant, the
BFG's is the brightest thing a player carries. Those ratios are what was tuned and what the report
did not complain about. A uniform factor is the edit that leaves them intact, which is why the 30%
cut before this one was also a single number.

**What deliberately did not move:**

- **`reachQ3`.** 300 and 150 are `trap_R_AddLightToScene`'s own radii, straight out of
  `CG_AddPlayerWeapon` — the one brightness-adjacent column that *is* transcribed. A flash still
  marks the same volume of corridor; it is less hot inside it.
- **`color`.** `flashDlightColor`, also transcribed, and the same three numbers the visible burst
  reads.
- **The visible burst.** `Effects.muzzleFlashParticles` takes `muzzleFlashLight(weapon).color` and
  nothing else from this table, so the core and sparks out of the barrel are exactly what they were.
  The complaint was about a room going white, which is the light's doing and not the sprite's.
- **`MUZZLE_FLASH_SECONDS`**, which is already this port's divergence (50 ms against the C's 20) and
  is about whether a flash is seen at all rather than how hard it lands.
- **The explosion's 12,000 lm**, which is the anchor the column was scaled against and not part of
  the complaint. So the gap widens on purpose: the brightest flash a player carries was a third of a
  rocket going off and is now a sixth of one, which is the shape of "the guns were too hot" and not
  a claim that the explosion was right and everything else wrong.

**Measured against the room rather than argued about.** The pane would not composite this session
— the renderer failed its first compute dispatch and `graphics.frameIndex` never left 0, which is
the hidden-tab boot and not this change — so the flashes were raised in the live app and read back
instead of photographed. `Effects.muzzleFlash` on `oa_dm1` produces exactly the halved flux and the
unchanged reach: 22.28 cd / 150 units for the gauntlet, 125.33 cd / 300 for the shotgun,
167.11 cd / 300 for the BFG. What that is worth is the comparison against the map's own 28 fixtures,
which run 88 to 6,589 lm with a median of 671:

| | before | after | for scale |
| --- | --- | --- | --- |
| a wall 2 m off a shotgun muzzle | 62.7 lux | 31.3 lux | a median fixture 3 m away is 5.9 lux |
| the same wall, machinegun | 25.1 lux | 12.5 lux | " |
| the brightest flash carried | 4,200 lm | 2,100 lm | the map's brightest fixture is 6,589 lm |

Inverse-square off the flux, which is the arithmetic this port authors every light through — the
same `lumens / 4pi / d^2` `loadMap` and the lightgrid use — and not a reading off the shader.

So the flash still lands about five times the room's own light on the surface in front of it, which
is the property D-115 cares about — a shot with no light reads as a shot that did not happen — and
it no longer arrives as the brightest thing in the level. Exposure is automatic (D-130), so half the
flux is not half the picture; the last word on how it reads belongs to whoever is playing.

**The one relationship this inverts.** D-130 chose the plasma bolt's 400 lm as "below the gauntlet's
560, the dimmest continuous flash in that table", and the gauntlet is now 280. The bolt was left
where it is: the report was about muzzle flashes, a bolt in flight is not one, and the load-bearing
half of D-130's argument — one bolt well under the muzzle pop that launched it, ten of them over it
— still holds against the plasma flash's 770. Recorded at both ends rather than quietly allowed to
drift, because that number was chosen *against* this table and a reader arriving at either one
should find out that the other moved. (D-161 halved the column a second time and inverted the pair
outright: the plasma flash is now 385 against the bolt's 400.)

**No expectation had to be edited, which is the property worth having.** Nothing in
`muzzle-flash.test.ts` names a lumen value; it reads the table and checks the arithmetic against
whatever is in it, so a retune moves the expected value with the actual one. The only absolute
comparison anywhere is `missile-view.test.ts`'s "the bolt is dimmer than the muzzle pop it was
launched by", and 400 against 770 still passes it. (It does not survive D-161, which halved the
column again and put the flash under the bolt; that entry says why the line was removed rather than
inverted.) A tuning cut that needed a test edited would have
been a tuning cut that broke something.

One assertion was **added**, and it is the review's own finding rather than the change's. The test
called "writes the same light whichever path builds it" checked `type`, `distance`, `intensity` and
`color` on the gun's flash but only `type`, `distance` and `color` on the world's — so the
brightness of every flash raised for a *bot* was the one field in that table nothing read back, on
the path a player sees more often than their own. Not a hole a shared `applyMuzzleFlash` could fall
through today, which is why it survived: doubling the flux there trips the gun's assertion first.
It is a hole the moment the two paths stop agreeing — a caller that scales the light it was handed,
an `Effects.muzzleFlash` that sets intensity after the table has spoken — and that is the drift the
one table exists to prevent. Verified live rather than assumed: with the gun's line taken out and
the flux doubled, the new line fails on its own.

### D-161: the same cut a second time, and the bolt the flash has now fallen underneath

D-160's halving was not enough — reported the same way and answered the same way, one factor over
the whole `lumens` column and nothing else. The column is now a quarter of what D-115 authored:
the gauntlet 140, the machinegun and chaingun 315, the plasma gun 385, the BFG 1,050. "Just the
intensity" was the instruction and is what the diff is: `reachQ3`, `color`, `MUZZLE_FLASH_SECONDS`
and the particle burst are all where D-160 left them, for the reasons written there.

**Three values now carry a `.5`** — the shotgun's 787.5, the rocket launcher's 612.5 and the
`default:` arm's 437.5 — because the numbers they descend from were not multiples of four. They are
exact quarters rather than rounded ones. Rounding would be tidier and would put drift into the one
property all three cuts have been careful to leave alone, which is the ratios between the weapons;
a light authored in lumens has no more reason to be an integer than a distance has.

**Where this leaves a flash against the room it is fired in.** Same arithmetic as D-160 —
`lumens / 4pi / d^2`, the conversion this port authors every light through — against `oa_dm1`'s own
28 fixtures, which run 88 to 6,589 lm with a median of 671:

| | D-115 | after D-160 | after D-161 |
| --- | --- | --- | --- |
| a wall 2 m off a shotgun muzzle | 62.7 lux | 31.3 lux | 15.7 lux |
| the same wall, machinegun | 25.1 lux | 12.5 lux | 6.3 lux |
| the brightest flash carried | 4,200 lm | 2,100 lm | 1,050 lm |

A median fixture 3 m away delivers 5.9 lux, so a machinegun flash and a wall lamp are now roughly
the same event and a shotgun blast is about two and a half of them. The flash is still the brightest thing
happening in front of the muzzle, which is what D-115 asks of it; it is no longer anywhere near the
brightest thing in the level, and a BFG flash is now an *eleventh* of the explosion it is scaled
against rather than a third.

**The plasma bolt is now brighter than the plasma muzzle flash**, at 400 lm against 385, and that is
this entry's one uncomfortable fact. D-130 chose 400 explicitly as a number *below* the pop that
launches it — ten bolts in the air where the flash is one light for 50 ms — and two halvings of a
table the bolt was measured against have taken the pop underneath it. The bolt was left alone
anyway: both reports were about muzzle flashes, the bolt is not one, and dimming a light nobody
complained about to preserve a comparison is a worse answer than saying the comparison broke.

`missile-view.test.ts` had that comparison as an assertion, and it now says why it does not. The
choice there was between pinning the inversion — which would make a test out of a state nobody
chose — and pinning the old relationship, which fails. Neither is a test; what survives is the
bolt's own two numbers, 400 lm and 150 units, which is what D-130 actually decided. The line comes
back the day the flashes come back up or the bolt follows them down, and that is a decision for
whoever is looking at the screen.

### D-162: the bots had no difficulty setting, which is not the same as having an easy one

Three complaints, reported from playing: the bots have perfect aim; they notice you the instant you
are visible and fire immediately; and once they have lost you they keep shooting at the place where
they last saw you until the ammunition runs out.

All three are the same omission. The port had no concept of *how good a bot is*, and every quantity
that would have carried one was left at whatever costs least to write. Free is not neutral. A bot
with no reaction time reacts on the frame the trace clears; a bot with no aim error puts every round
through one point; and a bot with no continuous guard on its fight branch fights forever. Not having
a difficulty setting is not shipping the middle of the range — it is shipping the top of it, by
default, to everyone.

**`Difficulty.ts` is the whole of the answer's data**, and nothing else in the port is allowed to
hard-code any of it. Five levels named after Q3's own (`g_spSkill` 1..5, "I Can Win" through
"Nightmare!"), because a player who has seen a Quake menu already knows what those mean. The default
is `bring-it-on`, which is Q3's own `g_spSkill` default and the second of five, and every column is
monotonic down the table so that no level is better at one thing and worse at another.

The numbers are not botlib's. Q3 ships `CHARACTERISTIC_AIM_ACCURACY`, `CHARACTERISTIC_AIM_SKILL` and
`CHARACTERISTIC_REACTIONTIME` as five sets of fuzzy weights per bot in character files this port
deliberately does not have (D-055). What it has instead is the shape those characteristics describe,
fixed against measured human numbers:

- **Reaction.** Simple visual reaction time sits near 250 ms, and a *choice* reaction — see it,
  decide it is a target, act — runs 350 to 500 ms; trained players reach 150 to 200 ms. So the top
  level is 180 ms because that is roughly the human floor, and the bottom is 900 ms because a
  distracted human is that slow.
- **Aim error.** *Angular*, and that is the load-bearing choice. A fixed offset at the target keeps a
  bot equally deadly at 2,000 units as at 100; an angle makes hit probability fall with range the way
  a human's does, so distance becomes a thing a player can use. Q3's machinegun cone is ±1.4° for
  comparison, which puts the default level's 4.5° at a hand three times looser than the gun it holds.
- **Tracking.** A *lag*, not a lead. The bot aims where the target was `trackingSeconds` ago, which is
  what a tracking hand does and the exact opposite of the aim prediction D-055 rules out. It is also
  why strafing works: the shots trail behind you instead of following you.

**Aim error is drawn as a correlated wander, not per shot.** Two normal draws — yaw and pitch —
resampled every `aimDriftSeconds` and smoothstepped between. A per-shot draw would have been simpler
and is wrong for a reason worth writing down: an error that resamples every frame is a fair coin, and
a fair coin at ten rounds a second hits about as often as its average and never misses you
*consistently*. Correlated error is what sends a burst wide as a burst, which is the thing a player
can see and move against. The draw is a truncated normal rather than uniform-in-a-disc, because a
disc has most of its area at the rim — a bot drawing from one is reliably *off* target — and it is
truncated at 2.5σ because the one draw in a thousand that comes back at four sigma reads as a bug
rather than as a miss.

The error lands on the bot's *desired view angles* and not on the fired ray. A bot that aimed true
and then perturbed the bullet would be pointed straight at you with shots that mysteriously did not
arrive; this one is visibly pointed slightly wrong, its muzzle flash and its tracer agree with where
it is looking, and a player can read "that one has lost me" off the model.

`AIM_TOLERANCE` came down from 8° of yaw and 16° of pitch to 3° of each, and that is a consequence
rather than a separate tuning. The old gate was doing two jobs — it was the only thing making a bot
miss, and it was what let a bot fire while still swinging — and once the error is modelled the first
job is gone. A loose gate would now add a second, uniformly-distributed error that no difficulty
level could tune. What the tight one also buys, deliberately: a bot cannot fire while it is being
out-turned, so circle-strafing one at close range, where the bearing rate exceeds its `turnSpeed`,
takes it out of the fight.

**Reaction is an accumulating meter, not a countdown.** `Blackboard.awareness` builds while the enemy
is in sight and drains at `forgetRate` while it is not, and the bot has noticed once it passes a
threshold drawn per engagement. A countdown that restarts whenever line of sight breaks is a
countdown a player can hold at zero by stepping in and out of a doorway; a meter that drains more
slowly than it fills cannot be, and it says something true besides — glimpses add up. The threshold
is drawn once per engagement rather than per frame, because a threshold re-rolled every frame is one
whose *minimum* decides when the bot fires, and that minimum is the same for every bot in the match.

Two riders on the meter:

- **Eccentricity.** The rate falls off as the cosine of the angle off the bot's view axis, to a
  quarter directly behind. Detection is slower in the periphery in every study of it. A soft falloff
  rather than a cone, because Q3's own `BotFindEnemy` asks `BotEntityVisible(..., 360, ...)` and a
  hard blind spot is a bot that can be walked up to and shot in the back forever. The reaction times
  in the table are therefore the on-axis figures.
- **Damage skips the queue.** A bot that loses health has been told where the enemy is by the shot
  itself. Without this, eccentricity would have introduced exactly the failure it was written to
  avoid. Read as a health difference between frames rather than plumbed through a damage callback,
  because `Damageable` is deliberately plain data and the difference says the same thing.

**The third complaint was not a tuning problem at all, and no amount of accuracy work would have
touched it.** A bot firing at a wall for thirty rounds was not missing; it was a structural defect in
the tree, and there were two of them, both in the same place.

meep's `SelectorBehavior` is the textbook selector: it remembers the child it settled on and ticks
that one until it fails. So the file header's "three things in strict priority" was a description of
the first frame only. Once `Travel` reported `Running` the fight branch was never reached again — a
bot walked its whole route past a visible enemy — and once `Fight` was entered, the guard in front of
it lived in a `Sequence` whose cursor had already moved past it while `Fight` never returned anything
but `Running`. The guard was a one-shot admission test. The bot fought forever.

`client/ActiveSelector.ts` is the composite the literature already names: "The Behavior Tree Starter
Kit" — which meep's own `Behavior` docblock cites — calls it `ActiveSelector`, and it re-walks its
children from the highest priority every tick, aborting a lower-priority running child when a higher
one is willing to run. The guards moved to meep's `ConditionalBehavior`, which re-asks its condition
on every tick where a sequence asks once. Between them, the tree now means what it was always
documented to mean.

With a live guard, `FightBehavior` splits into the two states it always needed: **engage** what it can
see, and **search** for what it cannot. Searching walks to the last sighting and does not shoot; it
ends early on arrival — after a `MIN_PURSUIT_SECONDS` floor, so that a player who ducks behind a
pillar two metres away does not get a bot with no object permanence — or on being wedged, and at the
latest when `searchSeconds` runs out. `blindFireSeconds` of shooting into the corner somebody just
went round survives on purpose, because a player does that; at the default level it is 0.2 s, which
is the difference between a reflex and a tantrum.

**`match.test.ts` lost its floor of 100 shots, and this is the part worth reading twice.** That floor
was measuring the bug. Against the stationary dummy the file used, bots on `oa_dm1` get *0.4 seconds*
of line of sight in thirty seconds — the hundred shots came from a bot that had entered the fight
branch on one glimpse and could never leave it. A test calibrated against a defect passes when the
defect does.

Its history had already said so twice. D-072 split it 374/110 and 10/420 across the two collision
paths, and the answer at the time was a per-map floor of 5, which turned "bots have stopped fighting
on this map" into a passing test; BUG-7 turned out to be the cause and the floor went back to 100.
Both times the number was fitted to what the build did rather than to what the game should do.

What replaced it is three properties that do not depend on how the run came out, and a scenario that
can honestly produce them:

- **The player walks.** It is a `Bot` — a body that moves through the same solver everything else
  moves through, D-072's whole point — driven along the waypoint graph with `moveToward` and given no
  tree, so it never fights back. The first version of this walker lerped a bare position and dragged
  the collision body after it, and launched a bot through the floor about one run in five: a
  kinematic body pulled in a straight line through a wall arrives inside whatever is on the other
  side. That failure is worth recording because the fix is the same principle the port keeps
  reaching for — if you want something to move like a player, move it the way the player moves.
- **A bot that gets a long enough look engages**, where "long enough" is the worst case the table
  allows: `(reactionSeconds + jitter) / AWARENESS_BEHIND`.
- **A bot that never gets a look never fires.**
- **A bot that has lost its target stops shooting**, measured exactly: the harness records the oldest
  sighting any bot ever pulled a trigger on, and asserts it is inside `blindFireSeconds`. Four
  sixty-second runs put it at 0.168 to 0.192 s against a bound of 0.2. Before this change the same
  number was however long a magazine lasts.

The run went from thirty seconds to sixty, and that is not slack for slower bots: at thirty, a whole
run could pass with the player's random route never crossing a bot's, and "the player took damage"
would have been a coin toss rather than an assertion. Shot counts across four consecutive
sixty-second runs on `oa_dm1` were 139, 29, 143 and 219 — a sevenfold spread that no absolute floor
could sit under honestly, which is the other half of why the floor is gone rather than lowered.

**Two things the adversarial pass found, and both are now cases in `bots.test.ts`.** Damage was
being read as perception only on frames where the bot could already see the player, which left the
one hole `AWARENESS_BEHIND` had opened — a bot shot from behind by somebody it has no trace to banks
nothing and is still slow. It now banks the reaction it owes whether or not the trace clears, and
still needs the trace before there is anything to fight: an ambushed bot comes out of it alert
rather than informed. And `aimAt` was adding pitch error to an angle the swing cannot reach, because
`turn` holds pitch inside ±89 the way Q3 holds a player's; a target almost directly overhead would
have produced a bot that stood there with `aimed` false forever. Both were reachable, neither was
reached by any test that existed, and that is the argument for the second file.

`test/bots.test.ts` is that file. `match.test.ts` answers "did a deathmatch happen" and is the wrong
instrument for "how long after the trace clears": one bot, one target, and `BotWorld.visible` as a
*variable* is what makes the seconds either side of a sighting assertable at all. Twenty-five cases,
including the three complaints stated directly — no shot before the reaction is paid, shots that come
off the true bearing and wander rather than re-roll, and firing that stops inside `blindFireSeconds`
of losing sight.

**What deliberately did not change.** No aim prediction, no leading a target, no fuzzy weapon
weights, no chat, no team play, and still no bot-versus-bot target selection — D-055's cuts stand,
and the test that asserts them still passes. Difficulty does not touch health, damage, item respawn
or movement speed: a bot at "Nightmare!" is the same physical object as a bot at "I Can Win", which
is the property `game/Bot.ts` opens by claiming and the one worth protecting. What difficulty owns is
attention and the hand, and nothing else.

**The menu row leads the gameplay page**, above field of view, which held that slot since D-126. Every
other row on that page changes how the game looks to the player; this one changes whether they can
play it. It is also the row that most needs the menu to leave the game running behind it (D-097),
because the only way to know whether "Hurt Me Plenty" is the right answer is to watch a bot at it.
Changing it mid-match is an assignment and nothing more — every number difficulty owns is read out of
`bot.skill` at the moment it is used — so a bot mid-swing turns at the new rate, and a bot mid-reaction
finishes the reaction it had already drawn.

### D-163: the flash where a shot lands is the weapon's colour, and a plasma bolt used to arrive orange

Reported from the screen: a plasma impact lights the wall much warmer than anything else about
the weapon. It did. Three lights live and die inside one plasma shot -- the muzzle flash, the
bolt's own light in flight, and the flash where it lands -- and the first two are
`0.6, 0.6, 1` because both read `muzzleFlash.ts`'s `flashDlightColor` table, which is
`CG_RegisterWeapon`'s `case WP_PLASMAGUN` transcribed. The bolt's emissive surface reads the same
line through `MissileView`'s `PLASMA_COLOR`. The third was not reading anything:
`Effects.explosion` set `1, 0.72, 0.38` on every detonation in the game, whichever weapon arrived.

`explosion` now takes the weapon and colours the flash from that one table. `Arena.explosion`
already had the weapon in hand -- it has passed it to `impactMark` since the mark table was split
out -- so the change at the call site is one argument.

**The C's own evidence points at that table.** `CG_MissileHitWall` initialises `light = 0` and
`lightColor = 1, 1, 0` above its switch, and exactly one arm assigns either: `WP_ROCKET_LAUNCHER`,
at `light = 300` and `1, 0.75, 0`. That is `FLASHES.WP_ROCKET_LAUNCHER.color` to the digit. So for
the single weapon Q3 has an opinion about the colour of an impact, reading the flash table *is*
transcribing the C -- which is the argument for using it for the five it says nothing about,
rather than authoring a second table of weapon colours beside the first. Two such tables drift;
this line was the drift, and `muzzleFlashParticles` avoids it the same way.

| weapon | `CG_MissileHitWall` | before | after | reach |
| --- | --- | --- | --- | --- |
| rocket launcher | `300`, `1, 0.75, 0` | `1, 0.72, 0.38` | **`1, 0.75, 0`** | 18.75 m |
| grenade launcher | `300`, initialiser `1, 1, 0` | `1, 0.72, 0.38` | **`1, 0.7, 0`** | 23.44 m |
| prox launcher | `300`, initialiser `1, 1, 0` | `1, 0.72, 0.38` | **`1, 0.7, 0`** | 23.44 m |
| plasma gun | `light = 0` | `1, 0.72, 0.38` | **`0.6, 0.6, 1`** | 3.13 m |
| BFG | `light = 0` | `1, 0.72, 0.38` | **`1, 0.7, 1`** | 18.75 m |
| nailgun | `light = 0` | `1, 0.72, 0.38` | **`1, 0.75, 0`** | 15.63 m |
| a death | not in the C at all | `1, 0.72, 0.38` | unchanged | 14.06 m |

Six weapons rather than five: `stats.hitscan === true` is what makes a shot a ray, and the nailgun
carries no `hitscan` field, so nails are missiles and land here with every other projectile. It
also has no `splashRadius`, so `detonate`'s `?? 100` is what sizes its flash -- an oddity that
predates this and is left alone.

**Two of those rows are divergences and not transcriptions**, which is the part worth writing down
rather than leaving to be rediscovered. The grenade and the prox mine *are* lit by the C and simply
never assign a colour, so Q3 shows them the initialiser's `1, 1, 0` -- the same yellow a machinegun
muzzle is, and a fallthrough rather than a decision about grenades. They now get the amber their own
launcher throws. And the plasma gun, the BFG and the nailgun get no impact light at all in the C;
this port lights every impact for the reason D-115 lights every muzzle, and once it does, it needs
a per-weapon colour that Q3 declines to supply.

**A death keeps the old orange.** `Arena.deathExplosion` is the one caller with no weapon to ask --
nothing was fired -- so `DEATH_FLASH_COLOR` holds `1, 0.72, 0.38` and a body coming apart is still
a fireball. That is also why the parameter is optional rather than nullable: it is absent in the
same sense `normalQ3` is absent for a missile that stopped on a player.

**Colour only.** `intensity`, `distance`, the 0.09 s life, the fireball and smoke emitters, the
impact mark and the sound are all where they were. Against the previous fixed value, Rec. 709
luminance of the colour vector moves -0.8% for the rocket, -5.5% for the grenade, +4.0% for the
BFG and **-16.7%** for the plasma gun, which is the only row anyone will see as a brightness
change and is the correct consequence of a blue light being blue.

**What this does not fix, said plainly, because both will be reported eventually:**

- **The fireball is still one warm ramp for all six weapons.** `explosion`'s particle layer runs
  `1, 0.95, 0.7` -> `1, 0.5, 0.15` -> `0.4, 0.1, 0.05`, lives 0.18-0.35 s against the light's 0.09,
  and is about a metre across at a plasma impact -- so it is the larger and longer-lived half of
  what a player actually sees. It was left alone because the report was about the light and because
  that ramp is not a function of `flashDlightColor`: no recipe recovers `1, 0.5, 0.15` from the
  rocket's `1, 0.75, 0`, so tinting it per weapon is art direction across six weapons rather than a
  table lookup, and it would move the rocket. The next report about a warm plasma impact is this.
- **Brightness is per-explosion, not per-weapon.** 12,000 lm whatever detonated, so a plasma pop
  with a 20-unit splash radius throws the same flux as a rocket with 120; only `distance` scales,
  at `splashRadius * 5`. 12,000 lm is 955 cd, which is 955 lux at a metre against the 5.9 lux a
  median `oa_dm1` fixture delivers at three (D-161's arithmetic), so the surface at the impact
  point clips to white whatever the tint and the colour is read off the falloff around it. That is
  why this fixes the complaint without making the flash read as dim, and it is also the number to
  look at if a plasma impact still feels too big for what it did.

**How it was checked, since it could not be looked at.** The preview browser cannot render this
scene at all: its Chrome exposes no WebGPU immediate-data limit, so `ShaderDescriptor
.validate_against_device` refuses every meep compute dispatch and `graphics.frameIndex` never
leaves 0. So the flash was measured instead of photographed -- fire each weapon through
`queep.arena.weapons.fire` in the live app, step `entityManager.simulate` and sample the `Light`
components each frame for the one at 12,000 lm. That returns `0.6, 0.6, 1` at 3.125 m for the
plasma gun, `1, 0.75, 0` at 18.75 m for the rocket, `1, 0.7, 0` at 23.4375 m for the grenade and
`1, 0.7, 1` at 18.75 m for the BFG: the whole table, through the real
`Weapons.detonate` -> `Arena.explosion` -> `Effects.explosion` path rather than a direct call.
`muzzle-flash.test.ts` pins the same thing per weapon, and pins the two rows above that are this
port's choice rather than the C's, so neither can be quietly undone.

### D-164: the beam starts on the gun that is drawn, and five separate things had moved it off

Reported from the screen: firing the lightning gun while moving, the beam does not meet the barrel
-- it sits slightly ahead of the weapon, in the direction of travel. It did, and the offset was not
one mistake. It was every difference between two answers to the same question, accumulated.

**`WeaponSystem` and `ViewWeapon` both compute "where is the muzzle", and they disagree about
five things.** The simulation's answer is `projectileOrigin`: the eye at the *end of the fixed
step*, plus the model's *rest* pose along `ps.viewangles`, behind a reachability trace. The gun on
screen is placed from the pose the *frame* is drawn with. So:

| | the beam's near end | the gun the player sees |
| --- | --- | --- |
| eye | end of the fixed step | blended across the step at `alpha` (D-081) |
| angles | `ps.viewangles`, the step's | the live mouse accumulator (D-155) |
| bob and view kick | not applied | `CG_OffsetFirstPersonView`, applied |
| sway | not applied (deliberately -- `barrelOffset` says why) | `CG_CalculateWeaponPosition`, applied |
| the barrel itself | refused when a trace from `CalcMuzzlePoint` to it is blocked | drawn regardless |

The first one is the report. The camera is deliberately a step behind the simulation -- that is
what `writeCamera` blends for, and it is worth 16 ms of position lag nobody can see *in the world*
-- but a beam seeded at the simulation's eye is not in the world, it is supposed to be touching a
mesh that is a step behind it. At Q3's run speed a step is 5.3 units, and it points exactly the way
you are moving.

The last one is the larger of the two and was invisible because it is intermittent. D-116's
reachability trace exists so a *rocket* is not born inside a wall; a beam collides with nothing, so
all the trace buys it is a jump back to `CalcMuzzlePoint` -- 14 units in front of the eye, in
mid-air -- whenever anything is between the muzzle point and the barrel. Which is most of the time
in a corridor.

**Measured rather than argued.** `oa_dm1`, driven headlessly in the browser at `1/165` s a frame
with the trigger held and the forward key down, comparing the beam's first knot against
`ViewWeapon`'s own `tag_flash` transform on every frame the gun was lit and the player was moving
faster than 250 u/s. Of 291 lightning beams the player fired, **167 used the barrel and 124 -- 43%
-- fell back**. On the frame each beam is born, in Q3 units:

| | before | after |
| --- | --- | --- |
| barrel used: distance from the drawn muzzle | 4.89 mean | **0** |
| barrel used: along the direction of travel | +3.79 mean, +8.04 worst | **0** |
| barrel refused: forward, right, up | -18.57, -5.96, +7.94 | **not reachable** |

Zero is exact and not a rounding: the beam and the flash light are now the same point, computed
once per frame and handed to both.

**The fix is the one D-115 and D-158 already made twice.** `Arena` offers every muzzle flash to the
gun before lighting the world, and the burst of particles is raised from `update` rather than from
the shot for exactly this reason -- `pendingBurst`'s own docblock says "the only muzzle position
available at that moment is the one the last frame drew". The beam is the third thing that comes
out of `tag_flash` and the last one that was still coming out of somewhere else. It is now offered
the same way, refused on the same two conditions -- no gun on screen, or a weapon that is not the
one drawn -- and drawn from the same point in the same frame. Everyone whose gun is *not* drawn
keeps the old path unchanged: every bot, every headless caller, and the player between dying and
respawning.

**The C is on this side of it, which is worth saying because the port is otherwise diverging.**
`CG_LightningBolt` builds its beam from `cg.refdef.vieworg` for the local client and
`cent->lerpOrigin` for everyone else -- the *rendered* eye, bob and kick included, not the
prediction's. Q3 asks the frame where the shooter is; this now does too, and reads a tag off the
mesh where Q3 adds fourteen units of `forward`.

One knock-on, and it is a simplification: `barrelOffset` is passed for every weapon and was read by
both paths. The hitscan side no longer reaches it for anyone who has a gun on screen, and everyone
else passes null, so `fire`'s `barrelQ3` is now what its docblock always claimed -- projectiles
only.

**What this does not fix, stated because the numbers say it plainly.** The beam is a world-space
`Trail3D` stroke and the camera keeps moving for the 50 ms it lives, so its near end slides
backwards over its life: along the direction of travel, averaged in 10 ms buckets, 0, -4.7, -7.5,
-10.3, -13.1 units. Before this change the same series read +3.8, -5.0, -7.8, -10.6, -13.3 -- the
same slide with the lead added on top. So what has been removed is the offset at birth, which is
the frame the beam is brightest and the one the report was about; the slide is unchanged and is
now the whole of the residual.

Removing it as well is a different change and is written down here rather than done. Q3 has no
such residual because `RT_LIGHTNING` has no lifetime -- `CG_LightningBolt` re-adds the beam from
the muzzle on every frame the trigger is held, which is why the `WP_LIGHTNING` row exists at all
(see `HITSCAN_TRAILS`). The port's equivalent would be to rewrite the stroke's first knot each
frame, and the obstacle is ordering rather than difficulty: the drawn muzzle does not exist until
`PresentationSystem`, which the scheduler runs last, and `Trail3DSystem` writes its geometry eight
systems earlier. A per-frame re-anchor would therefore land one rendered frame late -- 1.9 units at
165 Hz, 5.3 at 60 -- which trades a growing error for a constant one and is not obviously a win at
60 Hz. It becomes worth doing if the gun's placement can be moved ahead of the trail system, which
is a scheduling question and not a trail question.

`hitscan-trail.test.ts` is new and pins the routing and the arithmetic: that the near end is the
flash light's point to the float32 the knot buffer stores, that two runs differing only in where
the camera ends up put the beam's near end apart by exactly the camera's own displacement, that a
shot the gun takes leaves exactly one beam and not a second in the world, that a ray raises one
beam each where a flash collapses, and that all three refusals -- a bot, a corpse, an unmodelled
weapon -- still draw from the point the simulation gave. Four of its ten fail against the code this
entry replaces. `first-person.test.ts` keeps what a beam *is* -- width, colour, fade, both ends --
and is untouched.

### D-165: six shaders were filed under the comment above them, and the name was read before the line that decides it

Found while reaching for `rocketExplosion` to measure what colour Q3 paints an explosion (D-166):
`ShaderIndex.entry('rocketExplosion')` is `null`, and so are `grenadeExplosion` and `bfgExplosion`
-- three of the five explosion shaders in the game, in a file whose other entries load.

**They parse. They are filed under the wrong name.** `parseShaderScript` reads line by line and
tokenizes each line on its own, which the note above `directiveLines` explains and defends. The
tokenizer understands block comments, so one that opens and closes on a single line disappears; one
that runs over a line has its closing line tokenized as prose. The reader already coped with that --
"a second bare token before any brace means the previous one was not a shader name after all" -- but
it had already read `name` off the *first* line, at the top of the loop, and never re-read it after
deciding the name was something else.

`weaponhits.shader` writes this above three of its explosions:

```
/* Rocket explosion: inversesawtooth can be glitchy when seen from faraway (especially with 0 baseline value)
   take care when using it */
rocketExplosion
```

The second line tokenizes as `take care when using it` plus a terminator, so all three were filed
as `take`, one overwriting the next. `shells.shader` ends a 40-line commented-out block with the
terminator alone on the line above `powerups/quad` and `powerups/battlesuit`, so both were filed
under the terminator.

**A sixth was lost on the same line for a second reason.** `sawOpen` was answered for the line the
reader threw away and never re-asked of the line it adopted, so a corrected name carrying its own
brace -- `menu/art/skill1 {`, under a three-line banner comment in `iconsprites.shader` -- was
passed over, the reader kept looking, and the entry came out named `botskill` with its only stage
eaten as the shader body.

Both are one line each: ask `sawOpen` of the adopted line, and read `name` after the loop that
decides what the name is rather than before it. Measured across all 104 scripts, the entry count is
unchanged at 2,226 and exactly six names move:

| was | is |
| --- | --- |
| `take` (x3) | `rocketexplosion`, `grenadeexplosion`, `bfgexplosion` |
| the terminator (x2) | `powerups/quad`, `powerups/battlesuit` |
| `botskill`, 0 stages | `menu/art/skill1`, 1 stage |

**What it cost while it was broken.** A shader that is not in the index is not an error anywhere:
`ShaderIndex.material` falls through to its implicit-texture branch, which has no stages, and so no
transparency, no glow, no alpha test and no `tcGen`. Nothing is logged, because a name with no
script is the ordinary case for most of a map. None of the six is a BSP surface on a converted map,
so no map material moved -- `material-matrix --check` and `extract-effect-widths --check` both pass
unchanged -- and the practical cost was the three explosion shaders being unreachable, which is what
surfaced it. The powerup shells are the visual on a player holding Quad or Battle Suit, which this
port does not draw yet; when it does, they are now there.

**The tokenizer was left alone deliberately.** Carrying comment state across lines is the deeper
repair and it is a different change: the line-oriented reader is a documented choice, and a block
comment that *ended* mid-line rather than at the end of one would still arrive at the correction
branch. Reading the name after the loop is right whether or not the tokenizer is ever made stateful.

`materials.test.ts` pins both halves on synthetic sources -- so the failure is legible without the
asset tree -- and then names the six real shaders, because "the parser recovers them" and "the
parser recovers *these*" are different claims and only the second one fails when this regresses.

### D-166: a detonation's colour is measured off Q3's artwork and its brightness goes with the square of its blast

D-163 gave the impact flash the weapon's colour and named two things it did not fix. This is both
of them. `Effects.explosion` answered two questions with one constant each, for every weapon alike:
**12,000 lumens** of light, and **one warm particle ramp**. Both were authored against a rocket and
neither said so, so a plasma bolt -- whose blast is a sixth of a rocket's across and whose every
other colour is blue -- lit the room as hard as a rocket while throwing an orange fireball.

## The fireball: Q3's hue, this port's brightness

`CG_MissileHitWall` names a *different* explosion shader per weapon and the artwork is in the pk3s,
so this is D-156's argument again -- the number is in the picture rather than in the C.
`tools/extract-explosion-colors.ts` reads the **additive** stages of each shader, pools every lit
texel, sorts by luminance and takes three bands as a chromaticity ramp. Additive-only is the
like-for-like measurement (the port's fireball is one additive emitter) and it is also what keeps
the rocket honest: `rocketExplosion`'s eight-frame `rlboom` `animmap` runs under
`GL_ONE GL_SRC_ALPHA` and its last three frames are *smoke*, which this port draws separately and
which would otherwise wash the measurement white.

| weapon | shader | core | body | tail |
| --- | --- | --- | --- | --- |
| rocket launcher | `rocketExplosion` | 1, 0.60, 0.17 | 1, 0.41, 0.05 | 1, 0.20, 0.03 |
| grenade launcher | `grenadeExplosion` | 1, 0.90, 0.48 | 1, 0.48, 0.24 | 1, 0.24, 0.08 |
| prox launcher | `grenadeExplosion` | 1, 0.90, 0.48 | 1, 0.48, 0.24 | 1, 0.24, 0.08 |
| plasma gun | `plasmaExplosion` | 0.62, 0.88, 1 | 0.39, 0.77, 1 | 0.29, 0.70, 1 |
| BFG | `bfgExplosion` | 0.64, 1, 0.35 | 0.48, 1, 0.16 | 0.37, 1, 0.07 |

**Only the hue is measured.** How bright a fireball is over its life stays the port's, for GAP-011's
reason: photometric plausibility and reading well are different questions, and a ramp tuned against
the screen is an answer to the second. So `Effects.fireballTrack` carries each measured
chromaticity to the **luminance** the tuned ramp had at that stop -- scaling it down when it is
already brighter, and adding white when it is not, because a chromaticity normalised to a top
channel of 1 cannot be scaled up and because adding white is what stacking additive passes
physically does. Q3 lays four over `rocketExplosion` and its centre clips white while no single
texture in it is.

Going through luminance rather than top channel is the part that matters: it makes a blue fireball
and an orange one *equally bright*, which is what the tuned ramp was tuned to be. Matching top
channels would have made the plasma gun's blue -- which carries almost no luminance -- far the
brightest thing in the room.

**The calibration is the rocket.** Nothing forces a measured ramp to agree with a hand-tuned one,
and that it does for the weapon the hand-tuned one was authored against is the whole evidence that
the measurement picks up what an eye picked up:

| stop | tuned by eye | measured, at the tuned luminance |
| --- | --- | --- |
| core | 1, 0.95, 0.70 | 1, 0.934, 0.862 |
| body | 1, 0.50, 0.15 | 1, 0.496, 0.189 |
| tail | 0.40, 0.10, 0.05 | 0.448, 0.090, 0.013 |

Body and tail land within 0.05 of a channel. The core disagrees by 0.16 of blue and both are a
near-white hot centre, so that is not a colour anyone can name. `explosion.test.ts` pins all of it,
which is what a later change to the band cuts has to face -- **and the band cuts are a choice, not
a canon.** The brightest 1% and the brightest 5% of a glow are genuinely different colours; across
that range the rocket's core moves 0.09 in blue and the grenade's 0.16 in green. What makes these
three cuts defensible is that they are the same three for every weapon and that they reproduce the
rocket. Claiming they were insensitive would have been easy and was checked and false.

**Two detonations keep the tuned ramp whole**, because Q3 painted no picture for them: a nail, whose
arm leaves `mod` at zero so the C draws it no explosion at all, and a death, which is not in the C
anywhere. Borrowing another weapon's colours for them would be the same guess this replaces.

**The BFG is now green where it detonates and magenta where it flashes**, and that is id's doing
rather than a loose end: `bfgfiar` is a green burst and `CG_RegisterWeapon` gives the weapon
`MAKERGB( flashDlightColor, 1, 0.7f, 1 )`. Each number is used where id used it. Anyone who wants
them agreeing now has both written down next to each other.

## The flash: flux goes with the square of the radius

12,000 lm was the flux of *every* detonation, so a plasma bolt with a 20-unit splash radius threw as
much light as a rocket with 120 -- 955 lux a metre out, against the 5.9 lux a median `oa_dm1`
fixture delivers at three (D-161's arithmetic). It clipped every nearby surface to white whatever
colour it was, which is why D-163 could correct that flash's hue and still leave it reading as a hot
orange blowout.

`explosionLumens` is `12,000 * (radius / 120)^2`. Two ways of seeing why the square:

- a fireball radiates from its surface, and a sphere's area goes with the square of its radius, so
  holding exitance fixed and growing the ball gives exactly this;
- the reach is `radius * 5`, so illuminance at the edge of a flash is `flux / (4 pi (5 r)^2)` --
  **constant under this rule and under no other.** Every explosion is then as bright as every other
  *at its own scale*, and what the weapon changes is how much of the room it fills. That invariant
  is the assertion in `explosion.test.ts`, not the six numbers.

| weapon | blast | was | now | reach |
| --- | --- | --- | --- | --- |
| grenade / prox launcher | 150 | 12,000 lm | 18,750 lm | 23.44 m |
| rocket launcher | 120 | 12,000 lm | **12,000 lm** | 18.75 m |
| BFG | 120 | 12,000 lm | 12,000 lm | 18.75 m |
| a death | 90 | 12,000 lm | 6,750 lm | 14.06 m |
| plasma gun | 20 | 12,000 lm | 333 lm | 3.13 m |
| nailgun | 12 | 12,000 lm | 120 lm | 1.88 m |

**The rocket does not move, by construction**, and that is deliberate rather than lucky:
`muzzleFlash.ts` scales its entire lumens column against "the explosion's 12,000 lm" and D-160 and
D-161 each halved that column against the same reference. Moving the rocket would have silently
moved the meaning of twelve muzzle flashes. Both of those files now say the 12,000 is a rocket's.

**A plasma impact lands at 333 lm**, beside the 385 lm muzzle flash that launched it and the 400 lm
the bolt carries in flight. Three lights in one shot's life, within a fifth of each other rather
than a factor of thirty -- and, since D-163, all three the same colour.

## The nailgun's blast radius was a fiction, and the rule made it matter

`Weapons.detonate` sized every detonation by `stats.splashRadius ?? 100`, and `WP_NAILGUN` is the
one projectile in the game with no splash radius -- a nail is a dart. So every nail striking a wall
raised a 100-unit detonation: a three-metre fireball, its smoke, and a light reaching as far. That
was merely oversized while the flash was a flat 12,000 lm. Under a rule that reads brightness off
the radius, a made-up radius is a made-up brightness, and 100 would have made a nail the
second-brightest impact in the game.

The fallback is now 12, which is `CG_MissileHitWall`'s own number for this weapon -- `case
WP_NAILGUN` sets `radius = 12` for the mark and leaves `mod` at zero. Damage is untouched and was
never read from here: the splash arithmetic falls back to 0 separately, so a weapon with no blast
still does no blast damage. This is the presentation's number alone, and `missiles.test.ts` fires a
burst into a wall and asserts it.

## What was checked, and what still needs eyes

The preview browser cannot render this scene -- its Chrome exposes no WebGPU immediate-data limit,
so `ShaderDescriptor.validate_against_device` refuses every meep compute dispatch and
`graphics.frameIndex` never leaves 0. So this was measured rather than photographed, through the
real `Weapons.detonate` -> `Arena.explosion` -> `Effects.explosion` path in the live app: fire each
weapon, step `entityManager.simulate`, and read the `Light` and the fireball emitter's own colour
track back off the components. Every row of both tables above came back as written, including the
nail at 120 lm and 1.875 m and the death explosion at 6,750 lm in its unchanged `1, 0.72, 0.38`.

What that does not settle is whether it *looks* right, and two things are worth a look before they
are trusted. The plasma fireball's top channel is 0.82 rather than 1.0, because equal luminance in a
blue costs peak; and the smoke emitter is still achromatic grey for all six weapons, which is
defensible for anything that leaves a scorch mark but was never argued.

## Phase 11 — multiplayer

### D-167: networking is in scope, the brief's anti-goal is reversed, and the model is Q3's expressed in meep's primitives

**The maintainer reversed it.** `INITIAL_INSTRUCTIONS.md` section 2 says *"Networking -- delete
entirely. Single process. Do not port snapshots, delta compression, or client prediction"*, and
section 10 lists "port netcode" among the anti-goals. That is now withdrawn: multiplayer is in
scope. It is recorded here for the reason D-110 recorded the other reversal -- every argument in
`NETWORK_PLAN.md` is downstream of this one and none of them can be re-derived from the code, so
without this entry the whole of `src/net/` reads as somebody ignoring the brief.

**The priority order from D-110 still holds**, and it decides the shape rather than merely
permitting the work: *exercise meep well first, produce a faithful port second*. meep ships a
complete netcode package (`engine/network`: transports, a seq/ack channel, an action log with
rewind, a replicator, both orchestrators of a server-authoritative predict/reconcile loop, and a
`NetworkSession` facade over all of it) and this port had never imported one line of it. So the
work uses that package wherever it reaches, **even where a hand-rolled protocol over a WebSocket
would be fewer lines**, and files every place it does not fit as a GAP in `REPORT.md`. The friction
is the evidence; producing it is the point.

**The model: Q3's, in meep's primitives.** A dedicated Node host is the authority. Each human's
*inputs* are a `SimAction` the client predicts and the host executes; the local player is the only
predicted entity. Everything the host owns -- bots, missiles, items, movers, scores -- is *state*,
published every tick as the session's own `ReplaceComponent` actions and played out on clients
through its interpolation log behind an adaptive render delay. Transient happenings -- flashes,
impacts, explosions, hits, pickups, deaths -- are event-shaped `SimAction`s with no affected
components, which the replicator always sends and the rewind never touches.

Two alternatives were considered and are rejected here so nobody re-derives them:

- **Full deterministic input replication**, where every client simulates bots, missiles and movers
  from the same inputs. This is the engine's own textbook model and it is the wrong one for this
  game: the simulation's state is not in replicated components -- behaviour-tree blackboards,
  `MoveState`, physics contact state, projectile records -- so `RewindEngine` cannot restore it and
  a rollback tears the world; the contact events that detonate missiles are not replayable; every
  client would run the whole match at the pace of the slowest peer; and it asks bots to be
  bit-identical across machines, a property this port has never needed and has no oracle for.
- **A bespoke snapshot protocol over `Channel`** -- Q3's own `entityState_t` deltas. Rejected
  because it exercises one layer of the package where the plan can exercise all of them, and
  because it would re-implement INITIAL_SYNC, AUTH_STATE, the interpolation log and time dilation
  by hand, which is a worse use of the same effort and a worse report.

**Topology for v1:** one Node process hosts (`npm run host`), browsers join over a WebSocket. Bots
live on the host. There is no listen server, because a browser cannot accept a socket; that and
WebRTC are follow-ups.

**What does not change.** The single-player path stays exactly as it is and keeps its tests: `?map=`
with no `?join=` is the same game, `?move=q3` and `?trace=clipmap` stay single-player-only (the
networked step is the shipping `MeepMove` path and nothing else), the ported `bg_pmove` and
`cm_trace` stay in the tree as the oracle, and `npm run divergence` still measures against them.
`ws` enters as a devDependency imported only by `src/server/` and `tools/`; nothing of it reaches a
browser bundle, and meep stays external and unvendored (D-002).

**What v1 deliberately does not do**, stated now rather than discovered later: no lag compensation
(a hitscan resolves against where the host has everyone *now*, which is Q3 vanilla's own answer),
no prediction of jump pads or teleporters, no reconnect, no chat, no server browser, and no delta
compression beyond the engine's own format.

**One file the plan did not name.** `src/net/session.ts` is a four-line factory over
`new NetworkSession(...)`, and it exists because the generated declaration destructures
`frame_capacity` without listing it in the parameter's type, so the option this port raises to 64
does not typecheck while the runtime honours it. The cast lives there once with its reason
attached rather than at every construction site, and it goes away when the `.d.ts` gains the line.
Filed under REPORT section 4.

**The scaffold's own finding: the session's clock is not the engine's clock, and the difference is
six hundred picoseconds.** `NetworkSession.tick(dt)` keeps a private fixed-step accumulator; it
never calls `EntityManager.update` and never reads `fixedUpdateStepSize`. The obvious argument to
hand it is the step the surrounding `fixedUpdate` was called with, and that argument is wrong:

    em.fixedUpdateStepSize * 1000 = 16.666666666
    session.tick_period_ms        = 16.666666666666666

The engine's default is *short* of the period, so `while (accum >= period)` fails on the first call,
that step never happens, and the session runs one frame behind its caller for the rest of the match.
Measured: 600 calls at `fixedUpdateStepSize` leave the host at frame 598; 600 calls at
`1 / TICK_HZ` leave it at 599, and the second sequence is right from the first call. The deficit is
6.7e-10 ms a step, so it never recovers the frame and never loses a second one -- that would take
about 2.5e10 further steps, thirteen years at 60 Hz. A permanent, silent, one-frame offset is the
worst available failure: a client one frame behind its own reckoning tags every input with the wrong
frame and the host applies each to the state *before* the one the client predicted against, which
presents as constant small corrections, i.e. as a bad network rather than as a bad constant.
`SESSION_TICK_SECONDS` in `src/net/protocol.ts` is the constant, and `test/net-clock.test.ts`
asserts both halves -- the right argument stepping once per call, and the wrong one measurably
behind and staying behind.

**Q3's millisecond comes off the frame number, not off an accumulator.** `frameMsec(n)` is
`floor((n + 1) * 50 / 3) - floor(n * 50 / 3)`: the 16/17 pattern `MoverSystem` and
`PlayerController` have always carried, derived from the frame *number* instead of from a running
total. Networking is what forces the change. An accumulator answers "how much time has passed
here", which is a local fact; a host at frame 6000 and a client that has just fast-forwarded to
frame 6000 have to agree about what frame 6000 is worth without having agreed about anything before
it, and only a closed form can do that. Sixty consecutive frames still sum to exactly 1000, at any
starting frame, a million frames in -- asserted, because that is the property the whole timer layer
rests on.

### D-168: seven components, four actions, and one file that decides the order all three of them are in

The protocol, and the four choices inside it that are not obvious.

**Everything the shared step carries between frames is in `NetPlayerState`, including the four
fields that are not in `playerState_t`.** `MoveState` -- `MeepMove`'s own record -- holds
`groundNormal`, `jumpHeld`, `ducked` and `viewheight` outside `ps`, and `PlayerMovement` copies
`ps` in, steps, and copies `ps` out around them. A rewind restores replicated components and
nothing else, so any of those four left off the wire would survive a rollback *unchanged* while
everything around it went back four frames, and the replay would run from a mixture of two
different frames. That failure has no symptom except drift, which is the most expensive kind, so
the component is defined by what the step reads and writes rather than by what Q3 puts in
`playerState_t`.

**Twelve weapons, not the plan's thirteen.** `balance.weaponOrder` has thirteen entries and
`balance.weapons` has twelve: the odd one is `WP_GRAPPLING_HOOK`, which has no damage numbers,
which `isWeaponId` therefore rejects, and which `PlayerController` has filtered out of the wheel
since D-114 for exactly that reason. A wire slot for it would be two bytes of ammunition for a gun
that cannot be held or fired. `NET_WEAPONS` is `WEAPON_ORDER.filter(isWeaponId)` -- derived, not
retyped, so a weapon that gains numbers gains a wire slot without anyone editing a constant, which
is the same rule the rest of the port applies to the balance tables.

**The inventory is flattened, and that is what a `Set` and a `Map` cost on a wire.**
`Inventory.ammo` is a `Record`, `weapons` a `Set` and `powerups` a `Map`: three iteration orders
that are properties of pickup history rather than of the game. Two peers that picked the same items
up in a different order would serialize the same inventory into different bytes. So ammunition is
an array indexed by `NET_WEAPONS` and ownership is a `uint16` bitmask over the same list, and the
`equals` that decides whether to republish compares numbers rather than collections.

**An angle blend hands back a normalised angle, and the second wrap is the interesting half.**
Shortest-path is the obvious part: without it a character walking past south spins a full circle,
once, every time. The part worth writing down is that `BinaryInterpolationAdapter`'s docblock
promises `t = 1` returns snapshot B, and a shortest-path lerp from 179.75 to -170 returns **190** --
the same heading, a different number, not B. So the result is wrapped back into `[-180, 180)`,
which costs two comparisons and makes the endpoint exact for any normalised input; and this port's
input is always normalised, because an angle only reaches a component through
`PM_UpdateViewAngles`, whose `SHORT2ANGLE` is in that range by construction. Found by asserting
the contract rather than by reasoning about it: the first draft of the test failed on `t = 1` and
was right to.

**Discrete fields come from the newer snapshot, continuous ones lerp.** A death, a weapon change
or a landing therefore arrives on the frame it happened rather than a frame late, at the cost of
the opposite error -- the state changes at the *start* of the blend rather than the end. For a
boolean at 60 Hz that is the better of the two, and there is no third option: the log holds two
snapshots and a byte is one or the other.

**Every action class is built per session by a factory, not shared.**
`SimActionRegistry.register` writes `static type_id` onto the class object, so a class shared
between two sessions in one process -- which is every test in `test/net/`, and both ends of the
loopback rig -- has its id overwritten by whichever session started last, and the first session
then decodes every packet as the wrong class. The engine does the same thing for its own
`ReplaceComponentAction` and for the same reason. The factory pays for itself twice: it is also how
`apply` reaches this peer's game objects without a module-level global.

**`registerProtocol` is the only place any of the three orders is written.** Component wire order,
action wire order and the dataset's component-type registration all happen in one function that
both roles call, because nothing at runtime checks a peer's ordering against its own: a host that
replicates `NetInventory` before `NetPlayerState` and a client that does the reverse exchange
packets of exactly the right length and produce a player standing at coordinates made of health and
armour. `test/net-protocol.test.ts` asserts that two independently constructed sessions come out
with identical type ids, which is the only cheap check available -- the expensive one is a match
that desyncs.

Sizes, measured rather than estimated: `NetPlayerState` 70 B, `NetInventory` 33 B, `NetPlayerInfo`
14 B with a five-character name, `NetMissile` 28 B, `NetItem` 3 B, `NetMover` 15 B, `NetMatch`
10 B. AUTH_STATE concatenates all seven plus `NetworkIdentity` into the session's one 1024-byte
scratch buffer, so the sum is the number that matters and it is 173 -- six times under. A name is
truncated to 32 bytes at a **code-point** boundary rather than a code-unit one, because a lone
surrogate half encodes as U+FFFD and a name cut mid-emoji would come back different on every peer,
so `NetPlayerInfo.equals` would never settle and the component would republish for ever.

### D-169: the per-frame player step is one function three machines run, and the clock is an argument rather than an accumulator

`PlayerController` was three things wearing one coat: it sampled the keyboard and the mouse, it
advanced the simulation, and it kept the two-step pose history the camera is blended from. A
networked game needs the middle third to run in three places -- on the host for every slot, on a
client for its own slot as a prediction, and on that same client again for every frame of a
reconciliation replay -- and two of those three have no keyboard and no camera. So the middle third
is `src/game/PlayerSlot.ts`, ECS-free and renderer-free, and the controller keeps the other two.

**What the split had to preserve, and how it was checked.** `test/player-slot.test.ts` transcribes
the pre-extraction `update()` -- the same statements in the same order, reading the same fields --
and runs both it and `PlayerSlot.step` through 600 frames of `meepmove.test.ts`'s strafe-jump chain
on real `oa_dm1` collision, comparing origin, velocity, view angles, bob cycle, cooldown, ammunition,
ground entity, `pm_flags` and view height **every frame**. They agree to the last bit, and the run
is worth running: peak 275, 337, 320 and 342 u/s from spawns 0..3 against a 320 base, 10 to 12
landings, 50 shots. The control is a transcription rather than a call on purpose -- an equivalence
test that imports the thing it is checking proves nothing -- and the 69-case
`player-controller.test.ts` is what protects the behaviour once the copy goes stale. The whole
existing suite passes unchanged: 1066 tests, up from 1061 by exactly the five added here.

**The clock is an argument, and `NETWORK_PLAN.md` §3.4 said it would not be.** The plan has `step`
compute `msec = frameMsec(frame)` itself. It cannot, and the reason is a measurement rather than a
preference: single-player carries a sub-millisecond remainder over `deltaSeconds` and spends
16, 17, 16, 17, 17, 16; `frameMsec` spends 16, 17, 17, 16, 17, 17. Both only ever spend 16 or 17 and
neither is wrong, but they are **not the same sequence**, and `player-controller.test.ts` drives the
controller at 125 Hz -- where the carry spends 8 ms a frame and `frameMsec` would spend 16 or 17, so
every timed quantity in 69 tests would double. So `StepClock` carries four numbers the caller
decides: the frame, the millisecond, the solver's `dt` in seconds, and `usercmd_t.serverTime`. The
networked path passes `frameMsec(frame)` and the closed-form running total; single-player passes its
carry; neither has to know about the other.

**And the two clocks do not sum to the same second.** Measured over 60 frames: the closed form spends
exactly 1000 ms, and the carry spends **999**. The carry is fed `em.fixedUpdateStepSize`, and
`0.016666666666 * 1000` is short of `50 / 3`, so the single-player Q3 clock runs one millisecond per
second slow against the movers' own integer arithmetic. That is a twentieth of the two percent D-110
removed by replacing rounding with the carry, and it is in the *other* direction. It is the same
constant that makes `session.tick(em.fixedUpdateStepSize)` skip its first step (D-167) showing up a
second time, in a second subsystem, from the same six hundred picoseconds. Recorded and not fixed:
fixing it changes single-player movement, which this step is required to leave alone.

**`SetClientViewAngle` did not replace `setYaw`, yet.** The plan calls for it here. `setYaw` writes
`PlayerController.yaw`, the mouse accumulator, which is exactly why it cannot run on a host -- but
nothing on the networked path calls it until the host has teleporters to send people through, which
is step 6. `ps.delta_angles` is already on the wire (`NetPlayerState.deltaAngles`) and already
carried through `load`/`store`, so the field the fix needs is in place and the function arrives with
its first caller. Deferring it kept this step to one behaviour-preserving change.

**Two things moved onto the command, because the step now runs on a machine with no input devices.**
`BUTTON_ATTACK` is Q3's own bit and this port had simply never set it -- the fire decision and the
mouse lived in one class, so `fireIfReady` read a field instead. Setting it also writes `EF_FIRING`
on the ported `bg_pmove` path, which nothing in this port reads, and can hold `PMF_RESPAWNED`, which
nothing in this port sets. `BUTTON_CROUCH` is bit 32 and is **not Q3's**: Q3 reads the crouch off
`upmove < 0` and this port has taken it as a separate held key since `MoveCommand.crouch` was
written, which was fine while the only caller was the machine the key was pressed on. Bit 32 is free
-- Q3 uses 1, 2, 4, 8 and 16, and the ported `bg_pmove` tests only 1, 2, 4 and 16 -- so the crouch
travels as a button with no behaviour change at all, including the jump-and-crouch case this port
answers "ducked" and Q3 answers "not ducked".

**`ItemSystem` and `MoverSystem` gained an `advance`/`touch` split, and the reason is arithmetic
rather than tidiness.** Both had one `update` that advanced a shared clock *and* tested one player.
A host calling that once per player would advance `level.time` sixteen times a frame on a full
server: every door on the map opening sixteen times too fast, every item respawning sixteen times
too fast. So `advance(dt)` runs once and `touch(player)` runs per slot, with the old `update`
signature kept as exactly those two calls in that order -- which is what it always was -- so
`match.test.ts`, `bench-match.ts` and the mover and item suites read as they always have.

**One citation went stale and the generator caught it**, which is the trap matrix doing the job D-066
built it for: `trap_Milliseconds` cited `src/client/PlayerController.ts::serverTime`, and
`serverTime` had moved. It now cites `PlayerSlot.ts::timeMs` and `protocol.ts::frameMsec`, and the
note says what the command time is now and why a replayed frame gets the millisecond it got the
first time.

### D-170: the host frame, and the four bugs between "it compiles" and 600 frames bit-exact

A dedicated host (`src/server/Host.ts`) is `test/match.test.ts`'s arrangement -- collision, items,
waypoints, bots, weapons, missiles, damage queries, headless on the shipping backend -- plus a
`NetworkSession` in host role. A client (`src/client/net/NetClient.ts`) is a session, one
`PlayerSlot` predicted forward, and a pool for the host's world. `test/net/rig.ts` runs both in one
process over `LoopbackTransport`, which queues bytes and delivers them only when told to, so a
whole netcode is a unit test with no timers and no sockets.

**The result, measured: 600 of 600 frames bit-exact, worst position divergence 0.000000 units.**
The comparison is the plan's own -- the host's authoritative state for frame F against what the
client predicted *for frame F* -- over ten seconds of scripted circling, jumping and firing on real
`oa_dm1` collision. The AUTH_STATE short-circuit hits 603 of 620, and both halves of the miss are
accounted for below. `D-131`'s 1e-5 never appeared: the two peers build their broadphases in the
same order and get the same answers, and the fallback gate the plan named ("≤ 1e-3 units, ≤ 5%
rewinds") was not needed.

**Three rules the engine forces, each of which is now a GAP.**

*The world step runs only on the newest frame* (GAP-039). `onLocalSim` is the only place the action
log is open, so the whole world step and the whole publish pass live in it -- and it re-runs for
every frame in a rollback window, with a docblock asking for idempotence that a step where bots
think and missiles fly cannot provide. A high-water mark is the whole defence, and the cost is
named: a late input resolves against a world that has moved on, at most 67 ms of it.

*Nothing is spawned* (GAP-038). Sixteen player slots, sixty-four missile slots, one entity per item
and one match entity, all built before the first connect. A rocket is a pool slot whose `active`
byte goes to 1, with a `generation` counter beside it so a client blending two ticks can tell a
reused slot from a rocket that teleported across the room.

*Ownership does not travel* (GAP-040). A client has to assign it before attaching, and needs
`OwnerAwareScope` on its own replicator, which the engine documents only for the server.

**Four bugs found by measuring, and every one of them presented as something else.**

1. **The client echoed the host's world back at it.** The replicator logs every action it *applies*
   into the local action log -- correctly, the client's own rewind needs those records -- and
   `flush_outbound` then packs that log for every peer. With no scope filter the client returned the
   host's entire state stream to the host, a few frames stale, and the host applied it. The host's
   slot teleported 64 units down at the first echo and fell out of the level with the *client's*
   numbers arriving as the host's authority. It reads as a physics bug for as long as you let it.

2. **The client predicted four frames before the host had told it anything.** A session starts with
   every component at its constructed default, and INITIAL_SYNC only goes out on the host tick after
   `connect` -- which never came, because the host was still inside `simulation_delay_ticks` of
   warmup, where `tick` returns early and `onTickComplete` does not fire. So the client stepped a
   player at (0, 0, 0) and sent the host commands for frames it had simulated against nothing. Fixed
   twice over: the client will not predict before INITIAL_SYNC lands, and the rig warms the host
   past its input buffer before anyone joins, which is what a real host looks like anyway.

3. **Sixteen slots on nine spawn points.** Every slot has a character body from the first frame,
   because the pool must exist before anyone connects -- and a body is solid, so `MAX_CLIENTS` of 16
   against `oa_dm1`'s nine spawns put two players' worth of collision on seven of them. A joining
   player was depenetrated 30 units sideways out of an *empty slot's* body. Unconnected slots are
   now parked a kilometre below the map, each at its own spot so they do not depenetrate each other.

4. **`G_SelectSpawnPoint`'s nine-unit lift, missing from one of the three places that respawn.**
   `createPmoveHost` applies it and `Bot.respawn` applies it; the host's own `spawnSlot` wrote the
   raw point, putting the player nine units into the floor. The solver answered by shoving it 63
   units *downward* on its first step -- out through the world, falling for ever with
   `groundEntityNum` still reporting `ENTITYNUM_WORLD`, because on the way past it really was
   standing on something. Three implementations of one rule is two too many, and the third one was
   wrong.

**Every reconcile is explained, and the explanation is not the netcode.** 17 misses over 620
AUTH_STATEs: six frames the client never predicted (the join, before the first sync) and eleven
genuine hash disagreements. Those eleven are `ClientTimerActions` -- Q3 bleeds one point a second
off health above `maxHealth`, a player spawns with 125 against a max of 100, and that is 25 points
of **host-only state a client has no way to predict**. Each tick costs exactly one AUTH_STATE that
does not short-circuit and one rewind that corrects it. Measured across three run lengths: 11
disagreements at 10 s, 23 at 20 s, 31 at 40 s, rising one per second while the bleed runs and
stopping dead when health reaches 100. That is what says it is the bleed and not a drift, and it is
why the counter is split into "never predicted" and "disagreed" rather than reported as one number
-- a single hit rate would have looked like 97% of a mystery.

**The hash is over bytes, not over a position**, and that is the difference between a short-circuit
that works and one that lies. `onComputeExpected` peeks at the host's AUTH_STATE payload, skips
`NetworkIdentity` (identical on both sides by construction), and hashes `NetPlayerState` plus
`NetInventory` -- exactly what the prediction owns. A position comparison would have passed a client
whose ammunition, cooldown, ground normal or jump latch had drifted, and those are precisely the
fields that drift without showing.

**The seed is the host's, and `Math.random` is out of the simulation.** Not because a
server-authoritative game needs determinism -- clients are told what happened -- but because a test
has to be able to run the same match twice, and with `Math.random` in the loop every measurement in
this entry would be an anecdote. `mulberry32` in `src/server/random.ts` seeds weapon spread, respawn
points and bot goals; `Q_crandom` is untouched and still owns the spread itself (D-026).

**What a bot is on the wire, and the asymmetry that keeps.** A bot drives its own `pmove_t` through
`Bot`, not a `PlayerSlot`, and the host copies its pose into `NetPlayerState` rather than calling
`store`. Rebuilding `Bot` on `PlayerSlot` would be a rewrite of the thing `match.test.ts` measures,
for no gain: what the wire needs is the pose, and a bot's pose is on `bot.pmove.ps` exactly as a
slot's is on `slot.ps`. The cost is that a bot's `groundNormal` and jump latch go out as constants,
which no client reads -- a remote character is drawn, not simulated.

### D-171: joining a match in progress, and the loop that stands in for a number the packet already carries

A client's session frame counter starts at 0. The host's is wherever the match has got to. Nothing
in `engine/network` closes that gap, and the host is unforgiving about it: pending actions older
than `sim_frame - frame_capacity + 1` are trimmed, so a client joining a host at frame 6,000 and
tagging its inputs 0, 1, 2 has every one discarded -- **silently**. It moves on its own screen, it
never moves on the host's, and no signal fires anywhere.

The frustrating part is that the packet has the answer in it. INITIAL_SYNC carries the host's
`frame_number`, `onInitialSync` is dispatched with it, and `NetworkSession`'s handler names the
parameter `_frame_number` and ignores it. `#local_frame` is `#`-private with no accessor, so an
application cannot set it either. GAP-042.

**The workaround is the only lever a private field leaves:** tick the session forward with the input
sampler silenced until its own counter catches up. No peer is connected yet, so the empty ack packet
each step produces goes nowhere.

**What it costs, measured rather than estimated**, because a loop that might run 28,801 times is
worth a table:

| host age | frames | calls | wall clock |
|---|---:|---:|---:|
| fresh | 0 | 1 | 0.1 ms |
| 10 s | 600 | 81 | 0.3 ms |
| 100 s | 6,000 | 801 | 3.0 ms |
| 10 min | 36,000 | 4,801 | 12.3 ms |
| 1 hour | 216,000 | 28,801 | 62.5 ms |

`NETWORK_PLAN.md` §4.4 set 250 ms as the point at which the host should restart its frame count per
match to cap the distance. An hour-old host costs a quarter of that, so **the host keeps one counter
for its whole life** and the workaround stays a loop. A twelve-hour server would cost three quarters
of a second, which is a real number and is the point at which this decision should be revisited
rather than a reason to complicate it now.

**The loop asks for eight frames a call and gets seven and a half**, which is D-167's six hundred
picoseconds turning up a third time in a third subsystem: `8 * (1 / 60) * 1000` is
133.33333333333331 and eight of the session's own periods is 133.33333333333333, so the
accumulator falls one step short on every other call. It is why the call counts above are
`age / 7.5` rather than `age / 8`, and it is asserted as such rather than left as a surprise.

**A join is a burst and then a rate, and both are measured.** The first two seconds after joining a
6,000-frame-old host cost about thirty reconciles; from five seconds on the rate is one per second,
which is exactly the health bleed of D-170 and is the same rate a client that joined at frame zero
pays. The burst has a cause rather than being noise: the client's first predicted frame loads the
state INITIAL_SYNC delivered, which is several frames older than the frame being predicted, so the
two disagree until the AUTH_STATE corrections have walked the client up to the present. Nothing
compounds; the transient is bounded by the prediction lead.

**And two clients joined three thousand frames apart see each other.** Each one's view of the other
is the host's own numbers -- within 64 units, which is one frame of running -- because
`OwnerAwareScope` on the host keeps a client's own slot out of its action stream (it gets AUTH_STATE
instead) while sending it everybody else's, and `normalize_if_dirty` puts every remote component
back to canonical at the end of a step so the comparison is against a value and not a render blend.
The host's slot bookkeeping is asserted in the same file: two clients take slots 0 and 1, releasing
one frees exactly that slot, and the host keeps running with a hole in the middle of its roster.

### D-172: a real socket, and the three `Math.random` calls that made a seeded match unrepeatable

`src/server/wsHost.ts` is a `ws` server, the hello of `NETWORK_PLAN.md` §4.3, and a loop;
`tools/host.ts` is `npm run host`. `ws` satisfies `WebSocketTransport`'s duck-typed interface with
no adapter -- `binaryType`, `addEventListener` for message/close/error/open, `send`, `close`,
`readyState` -- and the one thing to watch is that a server-side binary frame arrives as a Node
`Buffer` rather than an `ArrayBuffer`, which the adapter drops **silently**; setting
`socket.binaryType = 'arraybuffer'` on the accepted socket, which `ws` honours, is the whole fix.

**The hello is one text frame, sent before the transport exists**, and the ordering is forced from
both ends. The host has to pick a slot and write `owner_peer_id` before it calls `session.connect`,
because INITIAL_SYNC goes out on the host tick after that and ownership is decided at attach time
(GAP-040) -- a join message arriving later is too late. And the client cannot tag an input until it
knows what frame it is (GAP-042), and the only place to tell it is a message it reads *before*
handing the socket to `WebSocketTransport`, because once the transport is listening every frame is a
packet and a JSON one is a `MalformedPacketError` on the first byte of a session.

**The loop is `setTimeout(1)` and an accumulator, not `setInterval`.** An interval that cannot keep
up queues its callbacks and then runs them back to back, turning a hitch into a burst; a timeout
plus an accumulator degrades by *dropping* time instead, and says so in the log. The catch-up budget
is twelve steps, which is a fifth of a second -- `PmoveSingle`'s own 200 ms ceiling and the same
number `PlayerController` clamps a step to.

**`test/net-websocket.test.ts` drives the host by hand rather than starting its timer**, yielding to
the event loop between steps, so it asserts an outcome -- the bytes arrived and meant the right
thing -- rather than a frame count that depends on how busy the machine is. Measured over a real
socket: INITIAL_SYNC lands, the client predicts 352 of 360 frames, the host walks 1,902 units on the
client's input, and the short-circuit holds 343 of 360 against the loopback's 603 of 620. The socket
costs a little more reconciliation than a loopback and it is a *little*, not a class change.

**And then the flake, which was worth more than the feature.** Running the whole suite in parallel
turned up an assertion -- "a bot fired a rocket in forty seconds" -- that passed about two runs in
three. The host had a seeded PRNG from the start and used it for weapon seeds and respawn points,
and a match still was not repeatable, because a bot makes **three** draws and only one of them was
mine:

- `BotRuntime`'s goal choice, `Bots.ts:622` -- which corridor a bot walks down;
- `BotRuntime`'s respawn point, `Bots.ts:673`;
- `Bot.random`, the aim error's correlated wander and the per-engagement awareness threshold
  (D-162), which defaults to `Math.random` and which the host never overrode.

All three are injected now and the match is bit-repeatable: three consecutive runs of the loopback
suite give identical shot, projectile, damage and effect counts. `Q_crandom` is untouched and still
lays the shotgun pellets out (D-026); this is what seeds it.

**And the generator itself was a re-invention, which is the more useful half of this entry.** The
first version of `src/server/random.ts` was a hand-written mulberry32. meep ships
`core/math/random/seededRandom.js`, which is `seededRandom_Mulberry32`, which is **the same
algorithm to the line** -- the same `0x6D2B79F5` increment, the same three `Math.imul` rounds, the
same `>>> 14`, the same divisor. Nineteen lines re-derived from memory instead of listing a
directory called `random`. The port's stated priority order is "exercise meep well first" (D-110),
and a hand-rolled PRNG exercises nothing; it is the exact failure this repository exists to
surface, committed by the person writing the report about it. Swapped, and the seeded outcomes are
unchanged to the last count -- 270 shots, 48 projectiles, 1057 damage on seed 23 before and after --
because the two implementations agree for any `_seed` short of 2^53.

The engine's is also better in a way that will matter later: `setCurrentSeed` / `getCurrentSeed`
make the generator's position readable and restorable, which is what a draw inside a *replayed*
frame would need. Nothing needs it yet, because the newest-frame gate (GAP-039) means no draw is
ever replayed -- but the state to save is one number and it is already exposed.

**There is a reason the wrong path was the easy one, and it is worth separating from the excuse.**
`seededRandom`'s JSDoc `@returns` writes a union where it means an intersection, so the generated
declaration is not callable and `const r = seededRandom(seed); r();` is a compile error
(`TS2349`). A consumer whose first attempt at the supported API does not typecheck reaches for
`Math.random` or writes their own; that is a one-character bug in a docblock with an outsized
consequence, and it is filed in REPORT section 4. It explains the mistake. It does not excuse it:
the file was never opened.

**One re-invention is a slip; four is a habit, so the rest of this work was swept for them.** What
came back:

| I wrote | meep already had |
|---|---|
| `mulberry32` in `src/server/random.ts` | `core/math/random/seededRandom.js` -- the same algorithm |
| `fnv1a` in `NetClient.ts` | `core/collection/array/typed/uint8_array_hash.js` |
| `mixInt` / `mixInts` / `mixFloats` in `components.ts` | `hash_mix2`, `computeIntegerArrayHash`, `computeHashFloatArray` |
| `vec3Equals` in `components.ts` | `core/geom/vec3/v3_equals_array.js` |
| `clampInt16`'s bounds check in `PlayerSlot.ts` | `core/math/clamp.js` |
| `truncateUtf8`'s byte counting in `adapters.ts` | `core/binary/utf8/utf8_encoded_length.js` |

All six are replaced and every measurement in D-170, D-171 and D-172 is unchanged -- 600 of 600
frames bit-exact, 270 shots and 48 projectiles on seed 23 before and after -- because these were
re-derivations rather than different answers. The UTF-8 one is a small improvement as well as a
deduplication: the version it replaced encoded the whole string to measure it and then encoded
every code point again to measure *that*, two allocations per character to count bytes nobody
keeps, where the engine's counts them arithmetically.

**And one of them found an engine bug.** `uint8_array_hash(array, offset, length)` bounds its main
loop by `length` where it means `offset + length`, so the `offset` parameter is only correct when it
is zero: the same eight bytes hash to 134678269 through `offset = 4` and 82109100 through a
`subarray`. Nothing in the engine passes a non-zero offset, so nothing is wrong today -- but the
failure shape is the worst one a hash has, two different inputs agreeing, and this port hashes
AUTH_STATE payloads to decide whether to reconcile. BUG-18.

**What was checked and is *not* a duplicate:** `Difficulty.gaussian` against meep's
`randomGaussian`. They are different distributions -- the engine's is a sum of six uniforms
returning `[0, 1]` centred on 0.5, and D-162's is Box-Muller rejected at 2.5σ returning a truncated
standard normal, chosen so a bot's burst goes wide as a burst rather than as one absurd shot. So is
`lerpAngle`, which has no engine equivalent for degrees (`quat3_nlerp` is the quaternion case). Both
stay.

**The method that would have caught all six, written down because it is the cheap one:** before
writing a utility, `ls` the directory in `core/` whose name is the noun -- `random`, `hash`, `utf8`,
`vec3`, `math`. Every one of these was one listing away. The port's own report has a section called
"what worked well" about meep's class-per-file, filename-is-the-export convention making the source
navigable; not navigating it is a poor use of that.

**Determinism here is not a netcode requirement and that is worth being clear about.** The game is
server-authoritative: clients are told what happened and never have to re-derive it, so a bot that
chose differently would not desync anything. It is a *test* requirement -- with `Math.random` in the
loop, every number in D-170 and D-171 would be an anecdote rather than a measurement, and an
assertion about a rocket would be a coin toss. The seed is now load-bearing in one visible way:
measured across seven seeds at forty seconds with four bots, six produce a rocket and one (seed 7)
produces sixteen shots and no projectile at all, because no bot happens to walk over a launcher.
The fight cases name their seed and say why.

### D-173: the transport was the wrong question, and 40 milliseconds of clean delay is where this netcode stops working

The maintainer asked whether meep's UDP transports would beat the WebSocket v1 ships on. They would,
and the engine says so itself -- `WebSocketTransport`'s docblock opens *"**Not** the right choice for
game state -- WebSocket runs over TCP, which means head-of-line blocking under packet loss"*. So the
answer was going to be "yes, switch". Measuring first turned it into something more useful.

**What is actually available**, since "UDP on both ends" is not quite what ships:

| adapter | reach | what it needs that meep does not provide |
|---|---|---|
| `NodeUDPTransport` | **Node to Node only** (`node:dgram`) | a browser cannot open a UDP socket; one adapter per peer, demultiplexed by source `address:port` |
| `WebRTCDataChannelTransport` | browser, `{ordered:false, maxRetransmits:0}` | signalling, ICE and the `RTCPeerConnection` are "the application's responsibility"; a Node WebRTC stack on the host |
| `WebTransportTransport` | browser, QUIC datagrams, `reliable=false` | an HTTP/3 server, which its own docblock calls "out of scope for the engine" |

So there is no single transport spanning both ends, and each browser option needs server machinery
the engine does not ship. `NodeUDP` is also the only one with **no congestion control at all** --
`CONGESTION_CONTROL.md` says the other three are masked by TCP, SCTP and QUIC respectively.

**And the signalling does not need a bespoke side-channel.** `NetworkPeer.send_reliable_command` /
`onReliableCommand` is at-least-once with sender retransmit and receiver dedup, and its own docblock
names "lobby/room state" as the use. Three caveats that decide how it can be used: delivery is
**not ordered** ("key payloads with a counter and reorder in the application handler"), the payload
cap is `MAX_CHANNEL_PAYLOAD_BYTES - 11` (~1189 B) with **no fragmentation at that layer** -- so ICE
candidates fit comfortably and a whole SDP offer does not -- and loss detection rides the channel's
seq window, which needs traffic to advance. The one thing it cannot carry is the peer id, because
`local_peer_id` is a `NetworkSession` constructor argument and `send_reliable_command` needs a
connected peer: that has to come from whatever establishes the transport. The *frame* number does
not need the hello either -- `peer.onInitialSync` is dispatched with it as its third argument, and
only `NetworkSession`'s own handler discards it (GAP-042).

**Then the measurement, which is why none of the above is the next thing to do.**
`test/net-latency.test.ts` runs the same 30-second match over `SimulatedTransport` with the clock
injected from the rig's own step counter, so a link is the same link on every machine:

| link | client short-circuit | host rewinds | mean depth | inputs aged out |
|---|---:|---:|---:|---:|
| loopback | 93.1% | 1 / 1800 | 2.0 | 0 |
| 10 ms, 1 ms jitter, 0.1% | 93.1% | 5 / 1800 | 3.4 | 0 |
| 40 ms, 8 ms, 1% | 7.4% | 1640 / 1800 | 3.7 | 0 |
| 80 ms, 20 ms, 2% | 21.2% | 1270 / 1800 | 7.8 | 0 |
| 150 ms, 40 ms, 5% | 13.7% | 1162 / 1800 | 15.7 | 0 |

**The load-bearing row is not in that table**, because it has no loss and no jitter in it: at
**40 ms of clean, in-order, lossless delay** the short-circuit is **0.1%** and the host rewinds on
893 of 900 frames. Loss and reordering are not involved at all. The netcode does not degrade on a
bad link; it stops working somewhere between 10 and 40 ms of *any* link.

The cause is GAP-043: `flush_outbound` re-sends every unacked frame each tick, the deferral hook
files each retransmission in `#pending_referenced_frames`, and `tick()` picks its rollback window
from those refs **before** `#replay_frame`'s dedup discards them. So the host rewinds by the ack
round trip every single tick, for input it has already applied. §7's prescribed remedy -- raise
`simulation_delay_ticks` -- was tried at 4, 8, 12 and 16 and moves the depth by less than 0.3
frames, because the depth is the *ack* RTT and not the input buffer. That paragraph in the plan is
now wrong and says so.

The second half of GAP-043 came out of the same run: event actions are lost under **reordering**,
not loss -- `Replicator`'s per-peer `#applied_through` watermark discards a whole late-arriving frame
group, and an event has no second chance where state has one every tick. 928 of 945 delivered at
150 ms/5%, 593 of 596 at 40 ms/1%.

**So the order of work changes.** A transport that removes head-of-line blocking is worth having and
is still the right destination; it is not worth having *first*, because at 40 ms the limit is a
rollback loop that no transport touches. What the measurement bought:

1. The rig now takes a `link`, and `SimulatedTransport` is wired with an injected clock so latency
   runs reproduce. That is step 7's instrument, built early and useful immediately.
2. Two unmet targets are written down as measurements with named goals rather than as assertions on
   the wrong value -- `test/net-latency.test.ts` asserts what is deterministic (every event arrives
   with no link; nothing ever ages out of the ring; the client never stops predicting; the host's
   state never goes non-finite on any link) and *prints* the two shortfalls against their targets.
   The rollback case additionally asserts the **shape** of the defect, so a fix breaks the test
   rather than leaving it quietly true.
3. `Host` takes `simulationDelayTicks`, because the sweep needed it and step 7 will again.

**What is not yet known**, stated so it is not mistaken for settled: whether the 0.1% is *only* the
wasted rollback, or whether the rollback also produces a different answer. The host's state runs
**ahead** of the client's for the same frame -- 1.6 units at frame 11 growing to 4 -- and
`weaponTime` differs on 890 of 891 frames, which is the signature of the slot being stepped a
different number of times on the two sides rather than of a small numeric drift. That is the next
thing to find, and it is a correctness question rather than a performance one.

### D-174: D-019 is struck, the vector library is meep's, and what that costs is measured rather than argued

The priority order set in D-110 -- exercise meep first, port Quake III second -- had one place it had
never been applied, and it was the most expensive place in the tree. D-019 made the port reproduce
`float` rounding step for step so the differential suites could demand bit-exactness against the C.
That is a fine goal for a *port*. It is the wrong goal for a showcase, and it was buying its
exactness with:

- 226 `Math.fround` calls across `cm/trace.ts` and `pmove/pmove.ts`, one around every multiply,
  add, subtract and divide, in the two files a reader most needs to be able to follow;
- a 263-line float32 vec3 library in `src/q3/math.ts`, reimplementing dot, cross, scale, length,
  normalise, copy and `VectorMA` -- every one of which meep ships in `core/geom/vec3/`;
- three constants written `F(1.001)` so the port multiplied by 1.0010000467300415.

JavaScript's float64 is a guaranteed, consistently-rounded type across every engine the port will
ever run on. That is good enough. Where relying on meep gives different arithmetic from Q3, the
departure is accepted.

**What changed.** `f32` is gone from `math.ts`, `trace.ts`, `pmove.ts` and `constants.ts`.
`math.ts` is 199 lines and contains no vector arithmetic at all: `dot`, `copy`, `scale`, `cross`,
`length`, `add`, `subtract` and `vectorMA` are deleted and the ~100 call sites go straight to
`v3_dot_array`, `v3_copy_array`, `v3_scale_array`, `v3_cross`, `v3_length`, `v3_add_array`,
`v3_subtract` and `v3_displace_in_direction_array`. `trace.ts`'s local `dot3` had exactly
`v3_dot`'s signature and is now that function. `clear` became `Float32Array.fill(0)`; `vec3()` is
meep's bucketed `v3_allocate`.

What stayed, and why it is not an inconsistency:

- **`Vec3` is still a `Float32Array`.** That is `vec3_t`'s width in the C, the width the network
  protocol writes, and the width meep's own buffers use. D-019 was about arithmetic, and this is
  storage. It also turns out to be load-bearing -- see the measurements.
- **`AngleVectors`, `SHORT2ANGLE`, `AngleNormalize*`.** Q3's angle convention in Q3's frame; meep
  has no opinion about pitch/yaw/roll degrees in an x-forward z-up world. The `-1*sr*sp*cy` form
  is folded to `-sr*sp*cy` now: the `-1`s were kept verbatim because in float32 each was another
  rounding step, and in float64 they are exact sign flips.
- **`SnapVector`.** A gameplay rule, not a rounding choice: Q3 truncates velocity to whole units
  every frame and strafe-jump speed depends on it.
- **`VectorNormalize`**, only because Q3's returns the length it divided by -- half its uses are
  `wishspeed = VectorNormalize( wishdir )` -- and `v3_normalize_array` returns nothing. Both halves
  of the two-line body are `v3_length` and `v3_scale_array`.

**How the cost was measured, given no emcc on this machine.** The tree before the change was
bit-exact against the C, so `divergence(after, C) == divergence(after, before)`, and the second is
measurable with no oracle at all. The pre-change `src/q3` was snapshotted and both trees were run
side by side over the differential suites' own maps, seeds, box sizes and input patterns. As a
control, the same measurement was run first against a copy whose `f32` was simply the identity
function; the hand-rewritten tree reproduces that copy's output figure for figure on all five maps,
which is what says the ~100 call-site rewrites are faithful and not merely plausible.

**Sweeps -- 100,000 randomised player-box sweeps, five maps:**

| quantity | result |
|---|---|
| hit vs miss disagreeing | **0** |
| `allsolid` / `startsolid` disagreeing | **0** |
| `contents` disagreeing | **0** |
| plane normal off by more than 1e-4 | **0** |
| `fraction` | median 3e-9, worst 1.0e-5 |
| `endpos`, any component | median 2e-5, worst 1.6e-2 units |
| position tests (`start == end`), 100,000 | **0 disagreements** |

Every *discrete* answer a trace gives is unchanged. What moved is the fifth decimal place of where
along the sweep it stopped. `endpos` moves further than `fraction` because it is
`start + fraction * (end - start)` and `islanddm` is 20,000 units across.

**Movement -- 172,800 single `Pmove` steps, three maps, six input patterns:**

| map | steps differing by > 1e-3 units | steps disagreeing on a whole-number field |
|---|---|---|
| `oa_dm1` | 0.0052% | 0.0000% |
| `aggressor` | 0.0990% | 0.0017% |
| `oa_dm2` | 0.3385% | 0.0104% |

**`SnapVector` is why those numbers are that small**, and it was a surprise. Velocity is truncated
to whole units at the end of every frame, so a one-ULP disagreement in the middle of a frame cannot
survive into the next one -- across every free-running episode on four of the five maps, the two
velocities never differed at all. Q3's own bandwidth-era hack is what keeps a float64 `bg_pmove`
walking next to a float32 one.

**What was genuinely lost, stated plainly.** A free-running 240-frame episode no longer stays in
lockstep: measured, the two part company at frame 22 on `islanddm`, and 4 of 32 episodes there
end up more than a tenth of a unit apart. That is not drift, it is bifurcation -- a tie in
`d1 > 0 && d2 >= d1` breaking the other way, a ground trace catching on one side and not the other
-- and no tolerance absorbs it, because the two players genuinely did different things. The port
is no longer the same *game* as the C over a long enough run. That is the departure D-110's
priority order accepts.

**So the suites changed shape rather than loosening.**

- `cm-trace.diff` keeps every discrete comparison exact and adds an explicit hit/miss check that
  the old zero tolerance made implicit -- "stopped at 0.99999" and "went all the way" are different
  answers, and a `fraction` tolerance alone would read them as agreement. `fraction` and `endpos`
  get 1e-4 and 0.1, ten and six times the measured worst.
- `pmove.diff` is **step-locked**: the C drives, and after every frame the port's `playerState_t` is
  overwritten with the oracle's, so each frame is an independent single-step comparison from a
  shared state. This compares 57,600 steps per map instead of abandoning an episode at its first
  bifurcation, and it still walks the trajectory the C actually takes. The gate is a *rate* --
  at most 1% of steps beyond 1e-3 units, at most 0.1% disagreeing on an integer field -- roughly
  three and ten times the measured worst.

The resync has to be exhaustive or it is worse than useless: a field left out keeps the port's own
value across the frame boundary, which is the accumulation the step-lock exists to remove,
reintroduced silently and for that field only. It is written as the whole `playerState_t`, driven
off `oracle.ts`'s own `PS_FIELDS`, rather than as the fields somebody thought `Pmove` writes.

**Both suites were checked to still fail on real bugs**, because a differential test that has been
given a tolerance is exactly the kind that quietly stops testing. With no emcc, they were run
against a stand-in oracle backed by the snapshotted float32 tree -- which was bit-exact against the
C, so it is a faithful stand-in for the suites' own logic even though it is not a substitute for
running them against the real thing:

- `OVERCLIP` changed from `1.001` to `1.002` -- a plausible transcription slip, and the smallest
  one D-023 records -- fails **all 18** pmove cases, with 247 to 4,505 divergent steps per case
  against a ceiling of 96.
- D-020's own bug, the missing `SURFACE_CLIP_EPSILON` in `CM_BoundsIntersect`, still fails
  `cm-trace.diff` on every map. That one produced 1 divergence in 4,000 sweeps when it was found,
  and it is the hardest thing either suite has ever had to catch; the loosened tolerances still
  catch it.

**What did not change.** 1,045 tests pass, unchanged in count from before. `MeepMove` is still the
shipping movement path and never went through any of this. The oracle, the WASM build and both
suites stay: D-032's four reasons for keeping `cm_trace` were reference, `CONTENTS_*` queries,
contact-plane derivation and a shipping A/B, and only the first was ever phrased in terms of
bit-exactness.

**One thing this does not fix, and one type-quality note.** `Effects.coneAxis` still has to snap a
near-axial cone direction to the pole (D-147); the residue `AngleVectors` leaves at ninety degrees
shrinks from 4.4e-8 to 6.1e-17, which is smaller but still not zero, and `POLE_EPSILON` of 1e-6
covers both. Separately, meep's `core/geom/vec3` declarations type their read-only source
parameters as writable arrays rather than as something read-only, so `ArrayLike<number>` is not an
acceptable argument; the port introduced `Vec3Like` and widened five signatures rather than
casting. Written up as an ergonomics note in the report rather than as a gap -- the functions work,
they just make a consumer give up a read-only type.

### D-175: the sound bank is Ogg Vorbis, and the browser's decoder is not the file's decoder

The bank was 85 PCM WAVs, 7.6 MB, copied byte for byte out of OpenArena's pk3. D-049 recorded the
reason for not transcoding them as a quality loss traded against "a saving on assets that are not
committed anyway", and the second half of that was simply false: `assets/` *is* committed -- only
`ml/` and `download/` are not -- so the 7.6 MB was 7.6 MB in the repository and 7.6 MB down the
wire on every load. It is now 1.2 MB.

**Vorbis rather than Opus, and not for the reason you would expect.** Opus is the better codec at
low bitrates, and here it is not better. Measured over the whole bank:

| | total | of WAV |
|---|---|---|
| source WAV | 7,768 KB | |
| Vorbis `-q:a 4` | 1,136 KB | 14.6% |
| Vorbis `-q:a 5` | 1,260 KB | 16.2% |
| Opus 64 kbps VBR | 1,116 KB | 14.4% |

Vorbis q4 and Opus at 64 kbps land within 2% of each other, so Opus's bitrate advantage buys
nothing on this material: 85 short mono files at 11 to 44.1 kHz, most of them under a second. What
separates the two is how close each stays to the source. Decoded back at the 48 kHz an
`AudioContext` actually runs at, and compared with the WAV sample for sample:

| | mean | median | worst |
|---|---|---|---|
| Vorbis q4 | 22.7 dB | 22.1 dB | 10.1 dB |
| Vorbis q5 | 24.3 dB | 23.9 dB | 11.4 dB |
| Opus 64 kbps | 15.4 dB | 16.6 dB | 0.2 dB |

Signal-to-noise is a poor stand-in for what a listener hears, and Opus spends its bits on things
this measurement does not reward, so the gap is smaller than it looks. The 0.2 dB is still worth
looking at: it is `weapons/bfg/bfg_hum.wav`, an 11 kHz sustained tone that plays as a *loop*, and
Opus resamples every input to 48 kHz whether the input wants it or not. At identical size, a codec
that keeps the sample rate it was handed and stays measurably nearer the waveform is the better
fit for a port whose whole argument is faithfulness. `-q:a 5` over q4 costs 124 KB and returns a
uniform 1.6 dB on a bank that is 1.2 MB either way, so it is bought; q6 costs another 156 KB for
1.4 dB and is not.

Vorbis has one real weakness here and it should be named: its codebook setup header is about 4 KB,
which across 85 short files is roughly a third of the output. Three of them come out *larger* than
the WAV they replaced, all footsteps and all under 100 ms -- `player/footsteps/step1` is 4,713
bytes against 4,152. Opus's headers are a few dozen bytes and would have saved that ~300 KB. Paid,
for the fidelity. What actually shipped: 7,768 KB of WAV became 1,259 KB of Ogg, 16.2%.

**It is not a new format dependency either.** The bank already carried a Vorbis file before any of
this: `music/OA14.ogg` is OpenArena's own music, copied out of the pk3 and played through the same
`decodeAudioData` as everything else. A source that is already Ogg is still copied rather than
re-encoded, because lossy to lossy is a second generation of loss bought for nothing.

**The finding: two decoders, two lengths, and neither of them is the file's.** The converter was
written to verify each transcode by decoding it back, the way `bake-audio.ts` reads its own output
back. The first version compared lengths and failed thirteen files, reporting up to 256 samples
lost at -6 dBFS -- audible content chopped off the end of a pickup. It was wrong, and the way it
was wrong is the interesting part:

- **ffmpeg's decoder stops short.** Over the 85 files it returns up to 256 samples fewer than the
  file holds. `items/holdable` decodes to 14,041 samples where the source had 14,169.
- **The file is right.** That same file's last Ogg packet sits at granule 14,144 with a duration of
  25, which ends at exactly 14,169; `ffprobe` reads the duration back as 0.321293 s, which at
  44.1 kHz is 14,169 samples. Every one of the 85 declares its source's length exactly.
- **Chrome's decoder overshoots.** It hands back whole blocks and ignores the end trim entirely:
  between 14 and 1,111 samples *more* than declared, on every file in the bank. Nothing is lost --
  the worst lost peak across all 85 is 0.0000 -- and nothing is shifted, because all 85 correlate
  best at offset zero.

So a length check against a decoder is a check on the decoder. What the encoder is answerable for
is the file, and the file says how long it is: `convert-sounds.ts` now checks the declared length
against the source's sample count, to within the sample that reading a duration back as seconds
can round away, and uses the decode only to check that the signal still correlates with the one
that went in -- a wiring check with a floor at 3 dB, far below the 11.4 dB worst case, because its
job is to catch the wrong file or a dropped channel and not to grade the encoder.

Both gates were checked to fail on real faults rather than assumed to work, the way D-174's
suites were. Truncating every encode to 50 ms (`-af atrim=end=0.05`) fails the length gate on all
85. Reversing every encode (`-af areverse`), which keeps the length exactly and destroys nothing
else, fails the correlation gate on 81 of 85 at -3.0 dB -- the -3 dB two uncorrelated signals of
equal power give. The four it lets through are short enough to be nearly symmetric, which is the
honest limit of the gate: it catches a file wired to the wrong sound, not every way audio can be
wrong.

**What Chrome's overshoot costs, and what it cost to fix.** For a one-shot it is a decoder tail
nobody notices. For a loop it plays every cycle. Measured on `world/waterfall`, a 1.36-second map
ambience: the decoded buffer runs 10.87 ms past the audio, and an `AudioBufferSourceNode` looping
at the end of its buffer renders six windows below a quarter of the median RMS across five
seconds -- at 1360, 1365, 2730, 2735, 4100 and 4105 ms. A hole at the seam, every 1.4 seconds, in
a sound whose entire job is to be continuous. WAV never had this, because PCM has no blocks.

The fix is meep's, which is the priority order D-110 set: `SampleAudioClip` already takes
`loopStart`/`loopEnd` and hands them to the source node, so the converter writes the true duration
of every file into the manifest and `Audio.ts` spends it on `loopEnd` for looping routings only.
Re-rendered with it, the same five seconds has zero quiet windows. One-shots keep `loopEnd` at 0
-- meep's "end of buffer" -- because for them the tail is the codec ringing out and is worth
hearing.

Worth noting how narrowly this was nearly missed: the loops were the *good* news in the first
round of measurements. Every looping ambience round-tripped through ffmpeg sample-exact, which
read as "the case where a length change would be audible is the case that does not change". It was
true of ffmpeg and false of the browser, and the only way to find that out was to ask the browser.

**A committed tree has to rebuild to the same bytes.** ffmpeg gives each Ogg stream a random
serial number, so the first working version of this produced 85 files with fresh checksums on
every run -- identical audio, 24 different bytes each: the serial, and the page CRCs that follow
from it. In a repository where `assets/` is committed and the README tells you to re-run this
after converting a map, that is 85 binary files of churn for no change. `-fflags +bitexact` and
`-flags:a +bitexact` fix it, and drop the encoder's vendor string from the comment header as
well -- the other thing in the file that was a property of the tool rather than of the sound.
Checked: two consecutive runs now produce byte-identical output, manifest included. This is the
same concern `.gitattributes` states for the extracted tree, arriving at the built one.

**Where it sits in the pipeline.** `tools/convert-sounds.ts`, which is already what `npm run
assets` runs and already what has to run again after a new map is converted, so new Q3 data
arrives through the encoder by default rather than by anyone remembering. It needs `ffmpeg` on
PATH with libvorbis, checked for by name at startup with a message that says why, and recorded in
the manifest alongside the quality setting -- a Vorbis file is a function of its encoder, and a
rebuild under a different one will produce different bytes for the same audio. Two tests hold the
line: one that every name in the manifest is `.ogg` and that nothing else is left under
`built/sound`, and one that every file has a duration for `loopEnd` to use.

### D-176: meep 3.14.4 fixes the rollback loop, and the event loss I reported alongside it was mostly my own measurement

The maintainer reported 3.14.4 as fixing GAP-043. It fixes half of it, completely, and the other
half is untouched -- and re-measuring turned up that the number I had published for that other half
was wrong in both directions.

**The rollback loop is fixed, and the fix is the one the gap asked for.**
`ServerAuthoritativeServer.tick` no longer takes `refs[0]` verbatim; it walks the pending references
and takes the oldest frame that `#frame_has_unapplied_input(f)` says carries something the action log
does not already hold. The engine's new comment states the reasoning in the same terms the gap did:
*"`__replay_frame`'s dedup would then discard the very entries that caused the rewind, leaving the
world exactly as it was. So run the same comparison here, before the window is chosen."*

Verified on the rig that found it, with **bots removed** -- a bot shooting the client inflicts damage
no client can predict, so every hit is a legitimate short-circuit miss and the rate stops measuring
latency:

| link | short-circuit 3.14.3 | 3.14.4 | host rewinds 3.14.3 | 3.14.4 |
|---|---:|---:|---:|---:|
| loopback | 97.6% | 97.6% | 0 | 0 |
| 10 ms clean | 92.5% | 97.5% | 6 / 1200 | **0** |
| 40 ms clean | **0.1%** | **97.3%** | **1190 / 1200** | **0** |
| 80 ms clean | 21.7% | 97.2% | 865 / 1200 | **0** |

Coherence no longer depends on latency at all: 80 ms is within 0.4 points of a loopback, and the
residual 2.4% is Q3's one-second health bleed (D-170). `test/net-latency.test.ts`'s first suite is
now the regression test and asserts the **flatness** as well as the level, so a return of the
latency dependence fails it rather than merely making it slower.

**The event loss is not fixed, and my number for it was wrong.** `Replicator`'s `#applied_through`
skip is unchanged, so a late-arriving older frame group is still discarded wholesale with every
event action in it. But GAP-043 originally reported "1.8% of events lost at 150 ms/5%", and that
figure came from comparing the host's dispatched total against the client's received total *at an
arbitrary stop*. The host keeps dispatching for as long as it runs and the client is permanently a
link's-worth of frames behind, so that comparison counts the in-flight window as loss -- on a
**lossless** link it reported 8.6% of muzzle flashes missing, which cannot be true.

Draining is not the fix either, and the reason is worth keeping: `flush_outbound` only sends when
the host ticks, so a drain that stops the host strands the tail permanently and the gap never
closes. The sound method is a **cutoff frame** -- record what the host dispatched by frame C, keep
*both* peers running until the client has applied a frame at or past C, and only then compare.
Under it:

| link | packets lost | events delivered |
|---|---:|---:|
| loopback | 0 | 474 / 474 |
| 10 ms, 1 ms jitter, 0.1% | 2 | 474 / 474 |
| 40 ms, 8 ms jitter, 1% | 44 | **516 / 516** |
| 80 ms, 20 ms jitter, 2% | 121 | 403 / 474 (15% lost) |
| 150 ms, 40 ms jitter, 5% | 331 | 305 / 516 (41% lost) |

So the original entry was wrong twice: it under-reported the bad link by a factor of twenty, and it
attributed loss to links that lose nothing. The third row is the one that identifies the mechanism
-- 44 packets lost and **not one event lost with them**. Packet loss alone never costs an event,
because the action stream re-sends every unacked frame; only *reordering* does, and reordering needs
jitter. That is a sharper statement of the defect than the first version managed, and it came out of
correcting the instrument rather than out of reading more source.

**What this changes about the transport question (D-173).** The blocking item is gone, so "measure
first, then WebRTC or WebTransport on the client with NodeUDP where both ends are Node" is now a
live plan rather than something waiting behind a defect. One caveat moves to the front: a UDP-style
transport *reorders by nature*, and reordering is precisely what the remaining half of GAP-043 eats
events on. Switching transports without that fix trades head-of-line blocking for missing muzzle
flashes. The 40 ms / 8 ms / 1% row says the current stack already tolerates real loss perfectly, so
the honest order is: fix or work around `#applied_through`, then switch.

### D-177: meep 3.14.5 closes the event loss, and the mechanism was three things where the report named one

`NETWORK_PLAN.md`'s remaining blocker is gone. Both halves of GAP-043 are fixed and a third defect
was found and fixed in the same release, by meep, while reproducing the second.

**What the report got right and what it missed.** It named the watermark (H1) and the ring (H3) and
could not join them, and its standalone reproduction passed — which is what got filed, honestly, as
"this may not be an engine defect at all". Both hypotheses were right and neither was sufficient:

1. **A throughput ceiling.** `flush_outbound` packed a tick's whole owed range,
   `[last_acked + 1, current]`, into **one** MTU-bounded packet and re-sent that same range every
   tick until its ack came back. The baseline therefore advanced by at most one packet of frames per
   round trip while the simulation produced one frame per tick: with `K` frames to a packet and a
   round trip of `R` ticks, the owed range grows by `R - K` per round trip whenever `K < R`. At
   60 Hz and 150 ms, `R = 10` and any frame over about **118 bytes of actions** crosses it.
2. **Pinning.** The pack start is `max(last_acked + 1, current - frame_capacity + 1)`; once the owed
   range is a ring wide the floor wins and each frame rides only `K` consecutive packets — one, when
   a frame is more than half a packet.
3. **The swap**, which is H1: the older of two reordered packets falls below the client's watermark
   and is skipped for good, while its channel-level ack still credits the frames as delivered.

So the ring was the *trigger* and the watermark the *drop*, and the thing joining them — the
one-packet-a-tick ceiling — was in neither hypothesis. It is also why the standalone reproduction
passed: it never left the regime where every packet still carried every owed frame, so its reversed
burst was a burst of duplicates and the newest packet applied them all.

**The fix** is the action stream sending a tick's owed range as several slices, applied and credited
in order (`max_packets_per_tick`, default 8). The ceiling rises eightfold, to about 940 bytes of
actions per frame at 150 ms, and a frame rides eight consecutive ticks' packets once pinned.

**Verified here rather than taken on trust**, same rig, same seed, 20 s, one client, four bots:

| link | events, 3.14.4 | events, 3.14.5 | short-circuit 3.14.4 → 3.14.5 |
|---|---:|---:|---:|
| 40 ms, 8 ms jitter, 1% | 516 / 516 | 516 / 516 | 4.4% → 91.1% |
| 80 ms, 20 ms jitter, 2% | 403 / 474 | **474 / 474** | 59.2% → 92.1% |
| 150 ms, 40 ms jitter, 5% | 305 / 516 | **506 / 516** | 71.2% → 19.8% |

The prediction-coherence suite is unchanged at 97.6 / 97.5 / 97.3 / 97.2 per cent across 0, 10, 40
and 80 ms of clean delay with zero host rewinds, so 3.14.4's fix is intact.

**The number this port now tracks, because it is what the ceiling is on.** meep's one request was
the bytes of actions a frame costs per client, which the report never stated. Measured on a loopback
— where the ack returns inside the same step, so an ACTION_STREAM packet carries exactly one frame:

| bots | mean | p99 | max |
|---|---:|---:|---:|
| 0 | 62 B | 377 | 377 |
| 4 | **523 B** | 691 | 1005 |
| 8 | **776 B** | 939 | 1159 |

Against 3.14.4's ~118 B threshold at 150 ms this port was four and a half times over with four bots,
which is exactly why it saw 41% and meep's own one-action-per-frame reproduction had to be built to
700 B to see it at all. Against 3.14.5's ~940 B it is under the ceiling on average and a burst of
explosions still crosses it — which is the whole of the residual 10 of 516 on the worst link.
`test/net-latency.test.ts` censuses it every run and fails if the mean approaches the ceiling, so the
next time this port's per-frame cost grows it presents as a bandwidth number rather than as missing
gunshots. **Eight bots at 150 ms sits at the ceiling**; that is a real constraint on how this port
can be configured for high-latency play, and it is now written down rather than waiting to be
rediscovered.

**The standalone reproduction is now a real regression test, and it took a second mistake to get
there.** It is rewritten around a fixed-delay link with 700-byte actions and a 32-frame ring, so the
back-fill pins early, and it swaps two queued **action-stream** packets deliberately — the first
version swapped whichever two packets were at the front of the queue, which were usually AUTH_STATE
and TIME_DILATION, and so it passed even with the send path forced back to one packet a tick. With
the swap aimed properly: `max_packets_per_tick: 1` loses exactly three frames to three swaps
(265, 285, 305), and the 3.14.5 default of 8 loses none. That is meep's own result reproduced
locally, and it means a future engine bump that regresses this is caught here.

**What stays open**, and it is worth keeping in view because a setting still exposes it: the skip is
silent and the credit is channel-level, so `max_packets_per_tick: 1` restores the old loss exactly.
A frame skipped unapplied, and a frame retired from the ring unsent, are still counted nowhere a
game can read them.

**And the answer to the question the report actually asked.** Event actions are *not* best-effort by
design and the docblocks are right that the stream always sends them; what it does not promise is
delivery under sustained overload. Muzzle flashes and impacts belong on the action stream. Anything
that must arrive regardless — round state, a kill that scores — belongs on
`ReliableCommandPipeline`, which this port has not needed yet and which step 6 should revisit when
scores go on the wire.

### D-178: the browser branch of step 5, and the unbounded weapon cooldown only a real host could show

`?join=ws://host:port` in `src/app/main.ts` takes the networked branch: the same map, `PhysicsWorld`,
movers and items as single-player, no waypoint graph and no bot roster, `NetClient` in place of
`PlayerSystem`/`CombatSystem`/`PickupSystem`/`BotSystem`/`WorldEffectSystem`, and the systems of
section 3.3 -- `NetClientSystem`, `NetWorldSystem`, `NetRenderSystem` -- in `src/app/netSystems.ts`.
`src/client/net/join.ts` is the handshake, out of band on the socket before `WebSocketTransport`
exists, and turns every refusal into a sentence rather than a `SyntaxError` out of `WebSocket`'s
constructor.

Three seams were needed and each is worth naming.

**`PlayerController` takes a `PlayerSlot` instead of always building one.** The simulation is the
slot; who owns it depends on who is simulating. On the networked branch `NetClient` builds it and the
session steps it, and the controller becomes input and presentation over it -- which is what makes
the HUD, the view weapon and the camera work on a predicted player without any of them knowing there
is a network. `update` split into `advanceClock` + `sampleCommand` + `slot.step` + `presentationTick`,
and `updatePresentation` is the same minus the step.

**The hello carries the item count.** `ItemSystem.spawn` rejects an item whose drop trace starts in a
solid, so the count is a function of the collision backend as well as of the map, and the two ends
need not be running the same one. Both peers build replicated pools from it and match them *by
position*, so a disagreement is not a missing shard -- it is every item after the first difference
reading as the wrong one, silently. The client checks it and refuses the join.

**`NetClient.bodies` is public and shared.** The client builds a `CharacterSlot` for every slot in the
host's order; a second `CharacterBodies` on the same physics world would put two boxes on every
player.

**And then the finding, which is why this entry is long.** Measured against a real `npm run host`
over a real socket, standing still: **300 reconciles in 300 frames**, every one of them a genuine
hash disagreement rather than a missing ring entry. `origin`, `velocity`, `viewangles`,
`deltaAngles`, `groundNormal`, `bobCycle`, `pmFlags`, `viewheight` and the rest were identical to the
last bit. **`weaponTime` alone drifted**, about one frame of milliseconds at a time, and had reached
-1917 on the host against -1867 on the client.

`PM_Weapon` guards the decrement and this port did not:

    if ( pm->ps->weaponTime > 0 ) {
        pm->ps->weaponTime -= pml.msec;
    }

-- `bg_pmove.c:1575`. Unguarded it fires identically, because the gate that decides whether a shot
comes out is `> 0` either way. What it costs is the floor. Two things followed. `clampInt16`
saturated the wire value at -32768 after about thirty-three seconds of not shooting. And, far worse,
the counter acquired infinite memory: a host and a client that ever ran a different number of frames
could never agree about it again, because nothing in the arithmetic ever returned to a common value.
So the client rewound and replayed its whole lead sixty times a second for a simulation that agreed
about everything a player can see.

**No existing test could have caught it**, and that is the part worth keeping. `NetRig` steps host and
client in lockstep inside one process, so their frame counts never diverge and the unbounded counter
stayed in step; `test/net-loopback.test.ts` reported 97.3% short-circuited before the fix and 97.3%
after. It takes a real host on a real clock, where `TimeDilation` makes the client run two simulation
steps in about 5% of its calls, for the two counts to come apart. The measurement that found it was a
field-by-field diff of the client's own ring entry against the host's authority for the same frame,
which is worth reaching for the moment a hash disagrees and nothing visible does.

`test/player-slot.test.ts` gains two tests for it, both confirmed to fail without the guard: the
counter stays inside int16 over a minute of not firing (-60000 without), and two slots that have been
idle for different lengths of time hold the same cooldown after the same shot (-1666 against -1000
without). `ReferenceController` -- the transcription that is the control for the extraction -- takes
the guard too, with a note saying why it is a correction to the control rather than a hole in it:
a control that encodes the defect would hold the port to it for ever.

### D-179: the client gave a body to slots nobody was playing, and stood 30 units off the host for ever

**GAP-044, closed.** A browser client standing still short-circuited its prediction **0 times in
3,808** -- measured by the user in a real browser, which is what turned this from "possibly my
measurement rig" into a defect. Every AUTH_STATE disagreed, so the client rewound and replayed its
whole lead sixty times a second, for a match that looked completely correct on screen.

The cause is one rule the host has carried since step 3 and the client never got. `Host.buildPools`
parks an unconnected slot's body a million units below the map, and its comment says why: a body is
solid, `MAX_CLIENTS` is 16, and sixteen bodies left at whatever origin they happen to hold put
collision where no player is. `NetClient.buildPools` builds the same pool of sixteen, tracked every
one of them to its replicated origin, and parked none.

So the local player's own sweep hit a box the host does not have, and the solver depenetrated it
**30.16 units in x -- one whole player box**. Its position then disagreed with the host's on every
frame, for ever. The fix is four lines: park a slot whose replicated `connected` is zero, at the
host's own spot and spacing.

| `oa_dm1`, one idle client, two bots, 600 frames | short-circuit | reconciles | drift from the host |
|---|---:|---:|---:|
| before | 0 / 600 | 600 | 30.160 units |
| after | 590 / 600 | 10 | 0.000 units |

In a real browser against a real `npm run host`, standing still: **0 of 3,808 before, 323 of 329
after** -- and the ten and the six are the once-a-second health bleed (D-170), which is host-only
state no client can predict.

**Why no existing test caught it, which is the part worth keeping.** Every other client in the suite
*walks*. A walking player leaves the parked body behind within a second and agrees from then on, so
the whole rig reported 97-98% throughout. The failing case is a player standing still -- the cheapest
case there is, and the one anybody in a menu or reading a scoreboard is actually in.
`test/net-loopback.test.ts` now has it, asserting the drift is **zero** rather than small, and
confirmed to fail at 30.160 without the fix.

**And two measurement traps cost most of an afternoon between them. Both are worth writing down,
because both produced confident, empty, wrong answers.**

*Comparing the wrong frame.* The obvious diff -- the client's `predictionTrace` for frame F against
the slot's live component -- is nonsense, because `onReconcileComplete` fires **after** the replay,
so the component holds the client's *current* frame, not F. While standing still every frame looks
identical, so the diff came back empty on all 600 and read as "the data agrees, so the hash function
must be broken". It is not: snapshotting at `onComputeExpected` and decoding the host's state out of
the AUTH_STATE payload named `origin[0]` immediately.

*Tracing half the hash.* `hashOwned` covers `NetPlayerState` **and** `NetInventory`, and
`predictionTrace` held only the first, so an inventory difference would have been invisible in the
same way. `inventoryTrace` is now beside it for exactly that reason.

Two things were ruled out along the way and are worth not re-suspecting. `HeadlessPhysics` and
`PhysicsWorld` -- the host's collision world and the browser's -- agree exactly: same fraction, same
startsolid, same floor height at every spawn point on `oa_dm1`, over 35 probes. And meep's
`uint8_array_hash` is deterministic over identical bytes at these lengths; it returns values outside
the 32-bit range, which is startling to read in a debugger, but it is consistent, and both sides of
the comparison were correct for their own data all along.

### D-180: bots shoot at everybody, kills belong to somebody, and a refactor's own regression

Step 6's host half. Three changes and one mistake worth keeping.

**`BotWorld.targets()` replaces `playerOrigin()`/`playerAlive()`.** A pair of methods that can only
describe one human made a second client furniture: visible, collidable, and never shot at.
`targets()` returns every connected, alive, non-bot slot, and `sighted` takes the nearest one it can
actually see -- candidates in ascending distance, first visible wins, so a bot between two players
engages the one it can hit rather than the one four units closer through a wall. The visibility
trace stays the last thing tried and still runs once per bot per frame with a single opponent.

**D-055 is now expressed by the list rather than by a test inside the AI.** `BotRuntime` has no
notion of what a bot is and cannot grow one by accident; `Host.humanTargets` is the one place the
policy lives, and `match.test.ts`'s "never targets another bot" passes an empty list and stays
green.

**Kills belong to whoever fired.** `WeaponEvents.hit` carries an `attackerId` -- `NO_ATTACKER` for
the world -- threaded from the three `damage()` call sites that all knew it already, and `HitEvent`
carries it on the wire instead of a hard-coded `0xff`. `Host.score` then does `player_die`'s
arithmetic rather than a naive increment: a frag to the attacker, **minus one to the attacker** for
killing itself, and **minus one to the victim** when nobody did it. That last rule is why
`NetPlayerInfo.kills` is an `int16` and not a count -- a score in this game can be negative, and the
wire format was already right about it.

**And the mistake.** The `sighted` rewrite dropped one thing the old code did unconditionally:
write the player's position into `playerEye` whether or not it was in range. `attention()` reads
that field on frames when nothing is sighted, so it began reading whichever target the *previous*
bot had looked at. Nothing failed obviously. What happened instead was that
`match.test.ts`'s "keeps their state finite" started failing about **one run in five**, with a bot
at |z| = 831,167 -- fallen through the floor and still going. Restoring the unconditional write took
it to **eighteen consecutive clean runs**.

Two things about that are worth more than the fix. It was caught by the *single-player* suite, not
by any of the eight networked tests, because the networked clients all walk and this needed a bot's
awareness to go wrong. And the first diagnosis was wrong: the flake was blamed on unseeded
`Math.random` in the fixture, a seeded generator was added, and it **did not help** -- a run-to-run
failure is evidence of non-determinism but says nothing about which non-determinism. The seeding is
kept, because a fixture in the `npm run check` gate should be deterministic whether or not anything
is currently wrong with it, but the entry it was originally credited with does not exist.

**`test/net-match.test.ts`** is step 6's exit: two clients, four bots, 45 seconds over the loopback,
both clients aiming at the nearest bot from replicated state. Measured: client 0 dealt 903 and took
581, client 1 dealt 147 and took 653 -- both ends of "everybody shoots at everybody", and the second
number is the one that was zero before `targets()`. No host input was dropped, every slot stayed
finite on the host and on both clients, and both clients received effect events.

Two of its assertions were wrong before they were right, in ways worth naming. Damage counted from
`Host.weaponEvents.hits` read zero in a match with seven frags in it, because that array is a
per-frame queue cleared at the top of every world step -- counting from a *client's* event log is
both correct and a better test, since it proves the events crossed the wire. And asking a client's
scoreboard to equal the host's *at an instant* is asking the wrong question: a client is a few
frames behind by design and the host awards a frag every second or two, so "step until they agree"
never returns. What is left of that assertion is GAP-045.

### D-181: what one player sees of another, and how to test a picture without a renderer

`NetPresentationSystem` places every other player in the match from replicated state:
`place(origin, viewangles[1])`, `Character.legsFor` from the velocity, the ground contact and the
sign of the velocity along the view, and a torso that attacks while the cooldown runs.

**On `update`, not `fixedUpdate`, and that is the arrangement rather than a detail.**
`NetRenderSystem` has just run `session.tick(0)`, which writes *blended* values into every remote
component from the interpolation log behind `AdaptiveRenderDelay`; reading them on the fixed step
instead would draw the raw 60 Hz snapshots and stutter. Both systems declare no components, so the
registration order in `main.ts` is the execution order.

**`weaponTime > 0` stands in for `EF_FIRING`.** Q3 sets that flag on the server for the torso
animation `CG_AddPlayerWeapon` draws; this port has no field for it, and the weapon cooldown is
already on the wire and is non-zero for exactly the interval the flag would be. A proxy, and the
honest one available -- the alternative is a bit that means the same thing.

**An empty slot's model is parked a million units down**, for the same reason its body is
(GAP-044) and a different one: an unoccupied slot's `NetPlayerState` is whatever the host last
said, and drawing a character there puts a motionless stranger in the middle of the level.

**The interface is three methods, and that is the interesting decision.** The system is typed
against `RemoteCharacter` -- `place`, `setLegs`, `setTorso` -- rather than against `Character`,
because the browser this port is developed in cannot get a WebGPU adapter and therefore cannot run
a renderer at all. A system typed against the concrete class could only ever have been read. Typed
against three methods, `test/net-presentation.test.ts` puts a recorder behind it and asks what a
real match over a real replication path told it to draw.

That turns the step-5 exit criterion this plan could not meet -- "a screenshot of tab A shows tab
B's character where tab B's HUD says it is" -- into a number, and a better one than the screenshot
would have been. Over 600 frames with three bots, the drawn position sits a mean of **2.75 units
behind the host's own, which is 0.6 frames of that bot's motion** at 4.68 units a frame; the worst
sample is 133 units and is a respawn teleport. All five leg animations appear
(`LEGS_IDLE`, `LEGS_WALK`, `LEGS_RUN`, `LEGS_BACK`, `LEGS_JUMP`), which is the assertion that the
velocity and ground contact are really arriving rather than defaulting: if either were zero the
choice would collapse onto one animation.

**Zero lag would be a failure, not a pass**, and the test says so: it would mean the client was
drawing the newest snapshot it had rather than sampling the log behind the render delay, and the
motion would stutter between snapshots. The bound is expressed in frames of the bot's own motion
rather than in units, because units would be an assertion about how fast bots run.

**One measurement mistake, which is the same one as D-179's and worth the second telling.** The
first version compared the drawn position against `host.slots[i].slot.ps.origin` and reported 746
units of lag. A bot has no `PlayerSlot` -- it drives its own `pmove_t` and `storeBot` copies it out
-- so that array is one nothing ever writes, and the "lag" was the distance from a stationary zero.
The published component is the ground truth. Both times the lesson is the same: when a measurement
produces a number that large, suspect the measurement before the code.

**Missiles are drawn too, through a second pool** -- one render entity per slot, holding a bare
`Transform` this system writes the replicated origin into. That indirection is the whole of GAP-046:
`MissileView` attaches its models to a parent that already has a transform somebody else moves, and
on this branch nobody does. A model is replaced when `generation` changes as well as when `active`
does, because the host reuses a pool slot the moment its missile dies; and it is *placed before it is
spawned*, which is the plan's "hide it for a frame" without the missing frame. Measured over 600
frames: 2 rockets spawned, 2 despawned, none left hanging, and a worst single-frame move of 30 units
-- two frames of a rocket's flight, which is the render delay breathing rather than a slot changing
hands unseen.

**And one thing this branch had to route around.** `Arena.update` is where single-player gets
`CG_Missile`'s roll, and it cannot be called here: the first thing it does is step the weapons, and
the weapons are the host's. `MissilePresenter.advance` carries the one presentation call inside it
that a client still wants.

**A correction to this entry as first written.** The networked characters were given
`interpolatedPose()`, copying what `roster.ts` does for bots. That is wrong here and §3.3 already
said so: on this branch the session *is* the interpolation, sampling the replication log behind
`AdaptiveRenderDelay` and handing this system blended values once per rendered frame. A second
smoothing stage on top would be `PoseRecorderSystem` snapshotting, on the fixed step, what the render
step had just written -- a frame of delay and a jitter, bought for nothing. Removed.

### D-182: a weapon change rides the command, because the step runs on a machine with no keyboard

Single-player switches weapons by writing `slot.weapon` from `PlayerController.selectWeapon`, and
is right to: it is the only machine running the simulation. A networked client doing the same would
be telling itself and nothing else. The host's copy of that slot would go on firing the machinegun
while the player's screen showed a gauntlet -- and because the weapon is a byte of
`NetPlayerState`, the two ends would disagree on every frame, so the prediction short-circuit would
miss every time and the client would rewind and replay its whole lead sixty times a second until a
reconcile pulled it back onto the host's choice. Exactly D-178's failure, from a different cause.

So `usercmd_t.weapon` carries it, which is where Q3 puts it, and `PlayerSlot.selectFromCommand`
applies it -- the same move `BUTTON_ATTACK` made in step 2 and for the same reason.

**Zero means "no change", so the value is the index plus one.** Q3's own convention (`WP_NONE` is 0,
weapons start at 1), and load-bearing rather than cosmetic: `NET_WEAPONS[0]` is a real weapon, so a
raw index would make "I am not asking for anything" -- which is what every command in this port sent
until today, and what every test fixture still sends -- indistinguishable from "give me the
gauntlet".

**`canSelect` on the host as well as the client**, which is the interesting half. Q3 ignores a
select of a weapon you do not have rather than beeping or picking the nearest, and that is the
behaviour; but the command is also the one thing in this protocol a *client* authors, so it is the
one thing a client could lie with. A slot that is asked for a rocket launcher it does not own keeps
what it had, on both ends, and `test/net-loopback.test.ts` holds it.

Single-player round-trips through the new field without noticing: `selectWeapon` has already set the
slot's weapon by the time `sampleCommand` runs, so the step reads back what it is already holding.
Measured unchanged across `player-slot`, `player-controller` and `match`.

Switching twice a second -- faster than anybody plays -- short-circuits **590 of 600**, which is the
same rate as standing still, so the change costs the prediction nothing.

### D-183: what a match costs, and the two tables that say a sixteen-player server is not reachable from here

Step 7's remaining half: `test/net-bandwidth.test.ts` and `tools/bench-net.ts`, both on the rig,
both without a renderer, and both reported into REPORT section 5.

**Bandwidth, per client, six clients and four bots all moving and shooting.** 88.7 KB/s downstream
and 2.9 up on a loopback; 540 KB/s downstream and 9.5 up over 80 ms with 1% loss. Measured with
meep's own `BandwidthMeter` on the host side of each link, which is deliberate -- how much a meep
session costs is one of the questions this evaluation exists to answer, so the instrument is the
engine's rather than a byte counter of this port's.

**The 48 KB/s budget is not met, at 1.85 times over, and the cause is structural.** Q3
delta-compresses each client's snapshot against the last one *that client acknowledged*; meep sends
every component that changed since the last tick, to everybody, with no per-client baseline and no
relevance filtering. Ten moving slots is ten players' worth of state to each of six clients every
tick, whether or not any two can see each other -- and `NetPlayerState` is 70 bytes of `float32`
where Q3 sent quantised 16-bit positions. The three levers are all this port's: relevance culling,
a lower publish rate for remote slots than for the local prediction, and quantisation. None was in
scope for step 7 and the first is worth more than the other two together.

**540 KB/s at 80 ms is the redundancy working as designed**, not a defect: `flush_outbound` packs
every frame from the last ack to now, so a ten-tick round trip sends each frame about ten times.
That is what makes the action stream survive loss -- GAP-043 is what happens when it cannot -- and
it is measured rather than asserted, because the arithmetic is the engine's.

**Host CPU, `Host.step` alone**: 0.334 ms with no clients, 0.561 at two, 0.931 at four, 1.993 at
six. The clients' own simulation is not charged to the host, which matters -- the rig runs it in
the same process and counting it would make a dedicated server look six times more expensive.

**The 2 ms budget is met and the trend is the finding, not the figure.** The marginal cost of a
client is not constant: about 114 microseconds each for the first two, 185 for the next two, and
**531** for the last two. That is an `O(n^2)` signature, and there are two candidates in the same
place -- every slot's state replicated to every other client, and every character body a broadphase
pair with every other. At six clients meep also starts printing `EntityManager.simulate:
fixedUpdate is falling behind the clock`, which is the host saying it in its own words.

So the honest reading is not "2 ms, met" but that **sixteen slots -- which the protocol already
sizes for -- will not fit a 16.6 ms frame without the relevance culling the bandwidth table asks
for independently**. Two tables, arrived at separately, pointing at one fix.

**On the sample size.** Six clients rather than the plan's eight: `oa_dm1` has seven spawn points
and the host gives one to every bot as well, so eight humans and four bots do not fit the map. The
figures are per client and the trend is what both tables are for, so the missing two rows change
neither conclusion.

### D-184: 30 Hz, which met the bandwidth budget and cost 4.5% of a strafe jump

`TICK_HZ` is 30. `frameMsec` and `frameTimeMs` are now written in terms of it rather than with
`1000 / 60` pre-divided into `50 / 3` -- a constant that silently means "and the rate is 60" is
exactly the sort of thing that survives a rate change and leaves a clock two per cent wrong.

**What it bought.** Downstream per client on a clean link went from 88.7 KB/s to **45.8**, which is
inside `NETWORK_PLAN.md` §7's 48 KB/s budget for the first time; over 80 ms with 1% loss it went from
540 to **201**, a bigger cut than half because the action stream's owed range is counted in frames.
Host CPU per second of match went from about 120 ms to 29-65. And event delivery under loss became
**exact** at every link -- 224/224, 144/144, 97/97, where 60 Hz left ten of 516 behind (D-177): fewer
frames between acknowledgements means the stream stops running out of packet before it runs out of
frames.

**What it cost, measured rather than assumed.** `bg_pmove` is stepped at the session rate on the
networked path and `PmoveSingle` is not linear in its step. The same strafe-jump chain tops out at
**466 units a second at 16 ms steps and 445 at 33 -- 4.5% slower** -- and the same commands land the
player about forty units apart after five seconds. Single-player still steps on the engine's 60 Hz
fixed update, so **the two halves of this port no longer run the same movement**, and a Q3 player
would feel it in the one skill the game is built around. `test/player-slot.test.ts`'s "the two clocks"
holds that split as an assertion so it cannot quietly become permanent.

The structural bandwidth problem is untouched: meep replicates every changed component to everybody
with no per-client baseline and no relevance filtering, and the superlinear host cost has the same
exponent it had. Halving the rate halved a constant.

**And it found a real bug, which the user predicted before the measurement did.** `NetClientSystem`
called `client.step()` once per engine `fixedUpdate`, and `NetClient.step` advances the session by
exactly one *session* period. That silently asserted the engine's rate and the session's were equal.
They were, at 60. At 30 the browser client would have run its simulation at **twice real time** --
permanently ahead of the host, every AUTH_STATE arriving for a frame it had already predicted past,
and `TimeDilation` fighting a clock it cannot slow that far: constant mis-prediction and
resimulation, from a one-line assumption. `WsHost` has paced itself against its own period since step
5; `NetClientSystem` now runs the same accumulator.

**`NetRig` cannot catch that class of bug at all**, and that is worth writing down. It drives the host
and each client one call apiece, so both advance one frame per iteration whatever either rate is --
right for measuring a protocol, blind to how it is driven. The pacing lives in
`test/net-clock.test.ts` instead, where three tests hold it: the session runs at the session rate and
not the caller's, it does not drift over an hour of frames, and it throws arrears away after a stall
rather than simulating a backgrounded minute in one frame.

The accumulator needs a microsecond of slack on its comparison and that is not superstition:
`EntityManager.fixedUpdateStepSize` is `0.016666666666`, *less* than `1 / 60`, so two engine steps
come to 0.033333333332 against a 30 Hz period of 0.0333333333... An exact `>=` falls short by 3.4e-10
seconds every time and runs the session at nothing at all. Measured: 299 ticks per 600 engine steps
without the slack, 300 with.

**Six test failures the rate change exposed, and none of them was a test being wrong about the code.**
Five were tests that counted frames where they meant seconds -- `rig.step(120)` for "two seconds",
`FRAMES / 60` for "how long was that" in the bandwidth census, which quietly halved every figure it
printed until it was caught. The sixth was `net-presentation`'s fixture walking a path on which the
bots never once got line of sight, so the host fired **zero** shots in eighty seconds and the missile
assertions were about a pool that had never held anything: a test that passes by never exercising its
subject. It now runs the same circling walk as the rest of the suite, and 72 rockets fly.

### D-185: what a misbehaving client can do, and the leaver nobody was told about

Step 8. `test/net-robustness.test.ts` assumes the clients are neither honest nor present, which no
other networked test in this suite does.

**The authorization gate holds.** In a server-authoritative game the command stream is the one thing
a client authors, so it is the one thing a client can lie with -- and the lie that matters is not "I
moved further than I should", which the host's own simulation ignores by construction, but *"here is
a command for somebody else's player"*. Nothing in this repository checks that. The whole defence is
`SimActionExecutor.authorize`, wired by `NetworkSession` to `make_owner_authorization` and driven off
`UserCmdAction.affected_components` naming the slot entity: three engine pieces that have to line up,
none of them this port's. Measured: 66 forged commands rejected, and the victim moved **0.00 units**.

Two ways of forging did not work and are recorded because both look right. `session.send` from
outside a frame throws `ActionLog.current_buffer: no frame is open` -- an action can only be raised
from inside the sampler, so a forger uses the same door as everybody else. Overwriting the local
slot's `NetworkIdentity.network_id` is reverted, because that component is replicated and the session
owns it. What works is patching the client's own `UserCmdAction.prototype.set`, which is safe to do
to one client because `makeActions` builds a fresh class per session -- and is also exactly where a
real cheat would live.

**And it found a leaver nobody was told about.** `Host.publish` mutated `NetPlayerState` only
`if (record.connected)`, which is right for a connected slot and silently wrong for one that has just
stopped being connected: the component's `connected` flag went to zero locally and **the change was
never sent**. Every client in the match kept the leaver's last position, its last pose and a
`connected` of one, for ever -- a character standing where somebody logged off, with a body still in
the broadphase. `publishPresence` now sends a parting update, repeated for the same window
`publishInfo` uses and for the same reason (GAP-045): it is a single edge, there is no second chance
at it, and a lost one is permanent.

**What v1 deliberately does not do**, so that none of it reads as an oversight:

- **No reconnect** (D-167). A second join from the same browser is a stranger who happens to get the
  same slot; the score starts at zero and the test says so, because somebody will otherwise assume it
  carried over.
- **No kick and no ban.** A client caught forging is refused that action and served normally on the
  next one. Punishment needs an operator, an appeal and a persistent identity, and v1 has none of the
  three; the gate makes cheating *ineffective*, which is the part that matters.
- **No idle reaping.** `Host` passes `connection_timeout_ms: 0`, so a client whose socket dies without
  closing holds its slot until the transport notices -- over a WebSocket, the TCP timeout. The plan
  asked for reaping and this is a deliberate refusal: a reap is indistinguishable from a bad thirty
  seconds on a train, losing your slot mid-match is worse than a stale slot on a sixteen-slot server
  nobody is queueing for, and `WsHost` frees the slot on `close` and `error`, which covers every case
  a browser actually produces.
- **No anti-cheat beyond ownership.** A client may send any command it likes *for its own slot*, and
  aim-assist or a movement script is indistinguishable from a good player at this layer. Q3 was the
  same; the answer there was server-side plausibility checks, and they belong with the relevance
  culling in the follow-ups.

### D-186: the documentation step, and six syscalls that stopped being "not needed"

Step 9. Three artefacts, and one thing worth arguing about in each.

**The trap matrix.** Six networking syscalls were classified `not-needed` on the strength of "no
netcode", and five of them are now `mapped` or `hybrid` with cited evidence: `trap_GetSnapshot`
(meep pushes replicated components where Q3 pulled snapshots, so there is no snapshot object to
ask for), `trap_GetCurrentSnapshotNumber` (`session.current_frame`), `trap_GetServerCommand` (split
in two -- gameplay events ride the action stream, text commands are not shipped),
`trap_SendClientCommand` (`UserCmdAction`, with the one command that mattered for gameplay now on
`usercmd_t.weapon`), and `trap_DropClient` (`session.drop_peer` beside `Host.release`). That moves
the matrix from 31 `mapped` and 5 `hybrid` to 34 and 7.

**`trap_SendConsoleCommand` stays `not-needed`, against the plan.** The plan expected it to become
`mapped` because the networked build gained a host that takes `--map` and `--bots` on argv. It is
not the same thing: that is a process argument, not a command a running game sends itself, and
citing `tools/host.ts` there would be evidence for a claim the code does not make. Written into the
note rather than left as a silent deviation.

**Regenerating the matrix nearly reverted somebody else's prose.** `npm run trap-matrix` splices
`tools/trap-classification.json` into REPORT section 2, and three entries -- `trap_CM_LoadMap`,
`trap_SnapVector`, `trap_Trace` -- had richer text in REPORT than in the JSON, because a previous
session had improved the prose without updating the source it is generated from. A regeneration
would have thrown all three away, including a `bit-exact against the C oracle` that somebody had
deliberately softened to `measured against`. They were pulled back into the JSON first. **The
generator makes REPORT section 2 read-only and nothing says so**; that is worth a line in the tool.

**README** gains the `?join=` row, a Multiplayer section with `npm run host` and the two URLs, and
-- more usefully -- a plain list of what v1 does not do, so that no reconnect, no kick and no idle
reaping read as decisions rather than as things somebody forgot. It also states the 30 Hz trade in
the terms a player would care about: a networked strafe jump is 4.5% slower than a local one.

**REPORT section 7** gains the networking "what worked". The honest shape of it is that the hard
part composed and the boring part did not: Q3's prediction loop -- command ring, snapshot ring,
`CL_PredictPlayerState`, error decay -- came out as `SimAction` plus `RewindEngine` plus
`AUTH_STATE` in about seven hundred lines, and `SimulatedTransport`'s injected clock and seed make a
netcode a *unit test*, which is the single most valuable thing in the stack. What did not compose is
per-client delta compression against an acknowledged baseline, and relevance filtering, and their
absence shows up not as a bug but as section 5's bandwidth and CPU tables.

**On the suite.** Two full-suite runs today failed intermittently, both during runs where the whole
suite took sixty-four seconds instead of nineteen -- a heavily contended machine -- and neither
failure was captured. Six clean full runs before and after, and the two socket-based files are
stable across four runs in isolation. Recorded rather than dismissed: it is most likely a timing
tolerance somewhere in the socket tests, and the next person to see a red run on a busy machine
should capture the name before re-running.

### D-187: meep 3.14.6 closes GAP-042, hands us the instrument GAP-043 needed, and the instrument disagrees with the engine

Upgraded from 3.14.5. Only two files under `engine/network` changed -- `NetworkSession.js` and
`replication/Replicator.js` -- and between them they close one gap, make a second one visible, and
open a third.

**GAP-042 is closed.** `onInitialSync` had a `_frame_number` parameter it discarded; it now takes it
and calls `seek_to_frame(frame_number + 1 + target_buffer_depth)`, and `seek_to_frame` is public and
documented. A joining client aligns itself. `NetClient.fastForward` -- the workaround that ticked the
session forward with the sampler silenced, at a cost proportional to the age of the match -- is now
redundant and should come out; it is left in place for the moment because the join-time behaviour
below is what the new measurements characterise and removing it deserves its own re-measurement.

**The join is tighter than our guess was, and that is a visible change.** `target_buffer_depth`
starts at `TimeDilation`'s initial target rather than at the generous `SIMULATION_DELAY_TICKS + 2`
the workaround used, so a client joining over a delayed link converges for about a second and the
host rolls back while it does: 42 rewinds at 40 ms clean, **all between frames 5 and 44**, and 80 at
80 ms, all inside the first 84. After that, **not one**. Steady state is strictly better than before
-- zero rewinds at every latency, where the old arrangement produced about one a run, and coherence
at 80 ms rose from 91.2% to **96.6%**. `test/net-latency.test.ts` now counts join and steady state
separately, because a single counter answered neither question well.

**GAP-040's symptom is visible.** `remote_entity_count` exposes `#remote_entities.size`, and its
docblock names the exact failure this port hit: zero on a connected client that has a snapshot means
nothing will be interpolated and the client is about to send the host its own state back. The
defaulting rule is unchanged so the workaround stays, but the failure is now catchable.

**And the new instrument disagrees with its own documentation.** `delivery_stats(peer)` returns
`{skipped_unapplied, skipped_duplicate}` -- exactly the counter GAP-043's residual needed, and a
genuinely excellent addition, because the whole difficulty of that bug was that a skipped frame and
a duplicate look identical from outside. Its docblock says `skipped_unapplied` "should stay at zero"
on the default `max_packets_per_tick`. Measured on the default: **8 frames at 40 ms, 27 at 80, 80 at
150**, while the event counts stay at 302/302, 297/300 and 288/300. Most frames carry no event, so
most skipped frames cost nothing visible -- which is precisely why the counter is the better thing
to watch, and precisely why the two columns disagreeing matters. Filed as **GAP-047**, and
deliberately not asserted at zero: whether these are genuinely lost frames or an artefact of the
ring-indexed `applied` test answering "no" for frames older than its window is not established here.

**Two test fixtures had to stop depending on luck.** The changed join alignment moves where a client
walks, which moves whether bots ever meet it, which collapsed the event sample in
`net-latency.test.ts` from 224 to **five** and emptied the missile pool in `net-presentation.test.ts`
entirely. Neither was a delivery problem and both would have been read as one. Both now generate
their own subject -- the client holds the trigger, and for the missiles it is handed a rocket
launcher and selects it through `usercmd_t.weapon` -- so the samples are 302 events and 100 rockets
rather than whatever the pathfinding produced. **A test whose sample size is decided by AI luck
cannot measure a rate**, and this is the third time in this plan that lesson has cost an hour.

**One ergonomics gap closed outside the network.** `NavigationMesh.build`'s generated `.d.ts` used to
type its *options object* as `BinaryTopology`, because the JSDoc put `@param {BinaryTopology} source`
on a destructured parameter and the generator hoisted it -- GAP-001's family. 3.14.6 emits the real
object type, and the cast this port carried to work around it became the only compile error in the
upgrade. A workaround outliving its bug is a good failure mode.

### D-188: the frame-alignment workaround comes out, and the join burst does not move

D-187 closed GAP-042 and left `NetClient.fastForward` in place, on the grounds that removing it
deserved its own re-measurement. This is that removal and that measurement.

**What came out.** `NetClient.fastForward(target)`, which ticked the session `8 * period` at a time
with the input sampler silenced until its counter reached the host's, plus the `aligning` flag that
silenced the sampler, plus its three callers: the `?join=` branch of `src/app/main.ts`,
`NetRig.join`, and `test/net-websocket.test.ts`. Every one of them ran immediately **before**
`session.connect`, and the engine's own seek happens inside `onInitialSync`, which is the host tick
**after** the connect. So the loop was aligning a counter that was about to be assigned.

**`synced` is now the only gate on prediction**, and it is the same dispatch as the alignment.
`onPredict` had two early returns -- `aligning` and `!synced` -- and the second subsumes the first
exactly: the engine seeks on the dispatch that sets `synced`, so the frames the sampler stays quiet
for are precisely the frames before the snapshot lands, and not one of them is tagged with a number
the host has already trimmed.

**The re-measurement, which is the point of doing this as its own piece of work.** The join burst on
a delayed link is a real cost and it is what characterises the new alignment, so the question was
whether removing the workaround moved it. It did not:

| link | rewinds before | rewinds after | after settling |
|---|---:|---:|---:|
| loopback | 0 | 0 | 0 |
| 10 ms clean | 0 | 0 | 0 |
| 40 ms clean | 42 | **42** | 0 |
| 80 ms clean | 80 | **80** | 0 |

Prediction coherence is 96.6% at 40 and 80 ms on both sides of the removal, and `skipped_unapplied`
is 8/27/80 at 40/80/150 ms on both sides -- so GAP-047 is not an artefact of the workaround either.
Identical counts are the evidence that the loop was doing nothing: had it been contributing to the
alignment, taking it away would have changed where the client landed and therefore how hard the host
had to work to catch up.

**What replaced the cost table.** `net-join-late.test.ts` had a test whose subject was the
workaround -- "costs a loop whose length is the age of the match", 801 calls for a 6,000-frame host
and 4,801 for 36,000. There is no loop to measure now, so it measures the property the loop existed
to produce, over the same four match ages: the client lands on the host's clock, and **the cost does
not have the match's age in it**. Measured at 0, 600, 6,000 and 36,000 frames: 0.06-0.23 ms, **one**
host tick, and a lead of **four** frames past the host's simulation frame -- identical at every age,
where the workaround needed 4,801 iterations for the last row and one for the first. The test asserts
the flatness (one distinct tick count, one distinct lead across all four ages) rather than a
duration, because a duration would be asserting this machine.

**And the burst window is now measured rather than described.** The claim "all between frames 5 and
44" was prose in a comment. `onRewind` now records the first and last rewind as frames since the
join, the clean-link suite prints them, and it asserts the two properties that make the burst a join
transient rather than a rate: it **starts** within a quarter-second of the join, and it **ends**
before the four-second settle window that `steadyRewinds` is counted after -- which is strictly
stronger than the old `steadyRewinds < 20`, and stops the settle window being a number chosen to
make the measurement pass. Measured: frames 5-48 at 40 ms and 7-89 at 80 ms, both scaling with
latency as a `TimeDilation` walking to a deeper target should. The window has no pre-removal reading,
because the instrument is new; the counts above are what carry the comparison.

**The one thing that had to change shape in the tests.** The alignment used to have happened by the
time `rig.join()` returned, so `net-join-late.test.ts` could assert the client's frame immediately.
It now happens a host tick later, so the test steps until `synced` and counts the steps -- and
asserts, first, that the client is at frame -1 and unsynced on the way in. That negative is worth
having: it is the difference between "the client is aligned" and "the client is aligned *by the
engine, on the snapshot*", and only the second is what GAP-042 closing actually means.
`net-websocket.test.ts` gained the same check over a real socket, where the seek was previously
untested because the workaround had already done it.

### D-189: GAP-047 settled — the counter is 214 where the loss is 10, and the honest 10 is mostly a join

D-187 filed GAP-047 with two candidate explanations and deliberately did not choose between them:
either the frames `delivery_stats(peer).skipped_unapplied` names are genuinely never applied, or
the ring-indexed `applied` test reports a false positive for frames older than the window it
indexes. Neither was right, and the answer needed a measurement rather than the argument.

**What was measured, and how, since the whole difficulty of this bug is that nothing reports it.**
`Replicator.onFrameApplied` fires once per frame group applied, so the set of host frames a client
ever ran is exactly knowable. Every inbound packet declares the frame range it covers in its slice
header, so the union of those ranges is what the host actually put on the wire for that client. A
frame in the union and absent from the applied set was **delivered and dropped**, which is the thing
the counter claims to count. `unpack_from_peer` is wrapped in the test to capture the headers; it
reads and changes nothing. `test/net-delivery.test.ts` holds it.

| link | frames delivered and never applied | `skipped_unapplied` | of which head slices | non-head | events |
|---|---:|---:|---:|---:|---:|
| 150 ms clean, lossless | **0** | **0** | 0 | 0 | 318/318 |
| 40 ms, 8 ms jitter, 1% | **0** | 10 | 0 | 10 | 315/315 |
| 80 ms, 20 ms jitter, 2% | **0** | 29 | 0 | 29 | 600/603 |
| 150 ms, 40 ms jitter, lossless | **10** | 214 | 11 | 203 | 770/788 |
| 150 ms, 40 ms jitter, 5% | **13** | 225 | 12 | 213 | 840/864 |

**1. The counter is not a loss count.** It reports 10 and 29 frames lost at 40 and 80 ms where
nothing at all was lost, and 214 where 10 were. It is also not a rate: on the same link, a ten-second
run reports 185 and a twenty-second run 214, while the honest count is **ten in both** — so the
number grows with how long the peers talk to each other, which is the signature of counting traffic
rather than loss.

**2. The mechanism, and it is one line.** `#hold_slice` validates a slice it is about to keep by
calling `#apply_groups(peer, buf, end, Infinity, ...)`. `Infinity` means "skip every frame", which is
the right instruction for a validation walk — but the skip branch is where the delivery accounting
lives, so **every frame of every held slice is booked `skipped_unapplied` on the way in**, and then
applied when the gap before it fills. Reordering is what creates held slices, which is why the
counter is zero at 150 ms *clean* and 214 at the same latency with 40 ms of jitter: same delay, same
redundancy window, same everything except whether slices can arrive early. Every packet that
incremented the counter applied nothing during its own call — 152 of 152 at the worst link — which is
what a hold looks like from outside.

**3. And the part that works is the part that matters.** Only a head slice can lose a frame for
good: `#apply_held_before` runs first and raises the watermark, and nothing before a head is ever
re-sent. Split by slice kind, the head component is **11, 12, 0, 0, 0** against an honest loss of
**10, 13, 0, 0, 0** — within one at every link. So `skipped_unapplied` restricted to heads is exactly
the instrument GAP-043 needed; unrestricted it is that number plus the receiver's own held slices.
The ring window is not implicated at all: the re-sends that reach the skip branch are a median of 6
frames behind the applied top against a 64-deep ring, so `applied[frame % 64]` cannot have been
overwritten.

**4. There is a real residual, it is small, and it is mostly a join.** Ten frames out of ~540 on a
*lossless* 150 ms link with 40 ms of jitter — lossless being the interesting column, because no
packet was dropped by the link, so those ten were delivered and discarded by the receiver. **Nine of
the ten are inside the first six seconds after the join**, alongside the rewind burst and the
coherence dip, in the window where `TimeDilation` is still walking to its buffer depth. At 40 ms and
80 ms it is zero everywhere. So GAP-043's residual does survive on the default
`max_packets_per_tick`, at 1.9% of frames on the worst link this port is measured over and nothing
below it — and the events this port "happens not to lose" are not luck after all, they are a
consequence of the loss being 0 at the two links a player would actually use.

**Two traps, both of which produced a wrong answer first.** The slice header object is **reused
across receives**, so recording the reference rather than a copy gives every packet the last packet's
range — which read as "all 150 counting packets were non-heads" at one link and "all 9 were heads" at
another, and the second reading is what nearly sent this to the wrong conclusion. And the join leaves
a **legitimate hole**: a joining client's watermark starts at 0 and INITIAL_SYNC lands it near the
host's frame, so frames 8..47 are never sent and never applied. Forty frames of that block looked
like the loss the counter was pointing at. The census starts three seconds past the client's first
applied frame.

**And a standalone reproduction, because the last report from this port taught that lesson.**
GAP-043 was filed with a script that *passed*, and was a real defect in three parts. So
`tools/repro/meep-delivery-counter.mjs` depends on the engine and nothing else, and it **fails**:
two sessions over a seeded, **lossless** `SimulatedTransport` pair with 40 ms of jitter, and
`skipped_unapplied` reads 234 with zero event actions never applied. `JITTER_MS=0` is the control
and reads zero at the same latency, which is what pins the mechanism on reordering rather than
delay. The sweep is 30 / 101 / 234 / 309 at 10 / 20 / 40 / 80 ms of jitter with the loss at zero
throughout.

**The script took two attempts and the failure is the useful part.** The first version forced
reordering the way `meep-event-reorder.mjs` does -- swapping two neighbouring action-stream packets
in the client's inbound queue -- and reported a clean zero. The reason: the action stream re-sends
`[last_acked + 1, current]` every tick, so consecutive ticks' packets overlap almost entirely. With
eight slices a tick the frontier advances by *one* frame per tick and the other seven slices are
copies of frames already applied, so a swap inside one tick trades the single new frame against a
duplicate and no gap can open. A hold needs `frame_start > next_frame` strictly, so **every copy of
a frame has to be late** -- which takes reordering across ticks, which is jitter. The delivery order
was logged to find that out rather than reasoned about, after the swap version had already produced
a confident zero.

**Filed upstream** at https://claude.ai/code/artifact/48a396e5-fa3b-4f59-9919-5e144f66b7fc, in the
same shape as the GAP-043 report: the script and the control before the argument, and three
outcomes listed as equally useful -- it is intended and the docblock is wrong, it is a defect and
the fix is the one argument, or the measurement is wrong. The third names its own weakest
assumption: "on the wire" is taken as the union of inbound slice headers' declared ranges, and if a
declared range can cover a frame that carries no group then the measured loss is an upper bound and
the real residual is smaller still.

**What this changes in the port.** Nothing in `src/`. `test/net-latency.test.ts` keeps printing the
counter and stops claiming it proves anything — its comment previously said "the engine's counter
above is what says nothing was actually lost", which is the one sentence this work disproves.
`test/net-delivery.test.ts` is the new home of the question, and it asserts the property we want
(nothing delivered is dropped) rather than the value this build produces: zero at the links that
achieve it, the residual bounded against a target of zero at the ones that do not, and the
head-filtered counter asserted to agree with the honest count, so the diagnosis above is a thing a
maintainer can re-run rather than a thing they have to take on faith.

### D-190: the scoreboard, other people's footsteps, and a field that had been publishing zero since step 3

Two of step 6's three missing pieces of presentation. Both are read-only consumers of state that was
already on the wire, and one of them found that the state was not actually there.

**The scoreboard is two files because the arithmetic is the part that can be wrong.**
`src/client/scoreboard.ts` is `CalculateRanks` as a function over sixteen slots' worth of
`NetPlayerInfo`; `src/client/ScoreboardView.ts` is the table. The split is `statusBar.ts`'s, for
`statusBar.ts`'s reason -- the preview browser cannot start a renderer, so a ranking inside a DOM
view can only be looked at. What the ranking gets right and would have been easy to get wrong:

- **The sort key is frags alone**, because `SortRanks` compares `PERS_SCORE` and nothing else. 10
  frags and 9 deaths beats 9 and none. Every instinct says to break the tie on deaths and doing so
  is a different game's scoreboard.
- **Ranks are shared, not sequential.** Three players on four frags are all 1st and the next is 4th,
  which is what `CalculateRanks` does as it walks the sorted list. A view numbering its own rows
  1, 2, 3, 4 is wrong every time there is a tie, and in a deathmatch that is most of the match.
- **Ties keep slot order, and that is this port's choice.** `SortRanks` returns 0 for equal scores
  and `G_SortScores` hands that to `qsort`, which is not stable in C -- so Q3's tie order is
  undefined and two clients can legitimately disagree. Slot order is stable, reproduces, and is the
  same on every peer, which is what a networked board wants and the only thing a test can hold.
- **Presence comes from `NetPlayerState.connected`, not from a non-empty name.** `NetPlayerInfo` is
  published on change and a single mutation is not reliably delivered (GAP-045), so a name can be
  late; a roster that waits for one is short a player for the first frames of every join. The test
  log shows this happening -- the local slot draws as `player 0` -- and `displayName` is what makes
  it read as an introduction in progress rather than a broken row.

**Three columns, not four.** `NetPlayerInfo.pingMs` is on the wire and has always been zero: meep's
`NetworkPeer` exposes no round-trip estimate, so a number needs a ping/pong over
`send_reliable_command`, which D-173 assessed and v1 does not do. The column is **absent rather than
zero**, because a board reading "0 ms" for every player on a 150 ms link is worse than one that does
not claim to know, and a zero is indistinguishable from an answer. `PING_HAS_NO_SOURCE` exists so
that the day there is a number, the thing to delete is findable by grep.

**Remote footsteps, and the field that was dead.** `NetPresentationSystem` grew a `RemoteAudio`
interface of two methods and one `Footsteps` per slot -- per slot, because `Footsteps` holds the
previous cycle and the previous ground contact, so one instance driven by sixteen slots in turn would
compare slot 3's cycle against slot 2's and fire on the difference, which is a footstep every frame
for every pair of players not in step.

It measured **zero footsteps**. `bobCycle` was 0 on the wire for every bot -- and 0 on the host, in
the bot's own `playerState_t`. The counter lived in `PlayerSlot.updateBobCycle`, a bot is not a
`PlayerSlot` (D-050: `Bot` is its own `usercmd_t` producer and consumer), and nothing else advanced
it. So `storeBot` has published `bobCycle` since step 3 with **zero in it every frame**, and bots
have been silent in single-player too, for as long as there have been bots. A dead field on the wire
is invisible until something reads it. Extracted to `src/game/bobCycle.ts` and advanced for bots in
`Host.worldStep`, right after `bots.update` has consumed each command, so the command that produced
this frame's motion is the one the cycle advances by -- which is what `PM_Footsteps` does inside a
`pmove`.

**And then the walk bit, which took a wrong turn worth recording.** `PM_Footsteps` plays no footstep
from its walk branch, because a walking player is sneaking, and it decides run from walk by
`cmd.buttons & BUTTON_WALKING` -- which is not replicated. The first attempt inferred it from the
replicated velocity: `PmoveSingle` clears `BUTTON_WALKING` above a move axis of 64 and `PM_CmdScale`
therefore caps a walking player at `320 * 64 / 127` = 161 u/s, so anyone faster is certainly running.
Sound reasoning, and useless: measured over a four-bot match on `oa_dm1`, **only 31% of grounded bot
frames are above the ceiling**, because a bot turning, pathing or scraping a wall spends most of its
time slower than a walk while running flat out. The inference suppressed about two thirds of every
bot's footsteps -- 7 to 42 steps per bot over eighty seconds where there should be a hundred and
twenty. **A player cannot be told apart from a sneak by their speed.**

The fix is `NET_PMF_WALKING`, a bit in `pmFlags` **bit 2, which Q3 leaves empty** -- Q3 and OpenArena
between them use bits 0, 1, 3, 4, 5, 6 and 8 through 15. `pmFlags` is already a `uint16` on the wire,
so this costs **no additional bytes**, against a new `uint8` field at 480 B/s per client on a
downstream measured at 45.8 of a 48 KB/s budget. Three consequences, all of them written down where
they bite:

- `PlayerSlot.load` masks it off before the value reaches a live `pm_flags`, so a solver that later
  grows a flag on bit 2 does not find it already set.
- Both `PlayerSlot.store` and `Host.storeBot` write it, from the command, after the step -- so the
  bit is the one `PM_Footsteps` would have tested, and the two peers agree. That agreement is not
  optional: `pmFlags` is inside `NetPlayerState.equals`, so a bit the host set and the client did not
  would disagree on every AUTH_STATE and break the prediction short-circuit, which is GAP-044's
  failure mode exactly. `net-loopback.test.ts`'s short-circuit tests are what confirm it does not.
- `isWalking` applies `PmoveSingle`'s own veto -- the bit is ignored above a move axis of 64 -- so
  both movement backends give Q3's answer, where before the meep backend would have honoured a bit
  the ported solver clears.

**Measured after the fix:** 121, 120, 135 and 121 footsteps per bot over 2,400 frames, at a mean gap
of 19.3 frames. Flat-out running is a step every ten frames at 30 Hz; twice that is the bots rather
than the mechanism, since `advanceBobCycle` holds the cycle still while a slot is airborne or
pressing nothing and a bot on `oa_dm1` is grounded 69% of the time.

**Read at render rate, and that is correct rather than a compromise.** `bobCycle`,
`groundEntityNum` and `pmFlags` are in `NetPlayerStateAdapter.interpolate`'s discrete block -- taken
from the newer sample verbatim, never blended -- so repeated reads inside one interpolation interval
see one value and produce no spurious crossing. Blending a `& 255` counter would produce a value
between 255 and 0 and a crossing that never happened; the adapter is why that cannot occur.

**What is still missing from step 6:** teleporters and jump pads, which is D-191.

### D-191: teleporters, pads and lava on the host, and GAP-041 was never blocking them

> **The "no sound" shortfall below is closed by D-197**, which presents every transient on the
> joined branch and adds `EffectKind.Teleport` and `EffectKind.JumpPad` alongside the five weapon
> effects. The rest of the entry stands, including the two shortfalls that do not close with it:
> triggers are still unpredicted, and bots still use no trigger on either path.

Step 6's last missing piece, and the finding is that it was not blocked. The tracking table said
"teleport/pad handling not built; GAP-045 open upstream" and §6 said movers were the host's "in
principle, and are simulated locally for now because a headless host has no kinematic brush entities
to replicate -- GAP-041". That is true of movers and false of triggers, and the distinction is the
whole of this entry:

**A mover has to be solid; a trigger does not.** GAP-041 is about `HeadlessPhysics` building BSP
model 0 and nothing else, so the host has no kinematic body for a `func_door`: a door there blocks
nobody and a plat carries nobody. But `MoverSystem.touch` is a box-overlap test against bounds the
BSP submodel table already carries, and a `trigger_teleport` never moves and is never solid. The
trigger half needed no physics world at all and had been reachable since step 3. GAP-041 is
narrowed rather than closed -- it now says what it actually blocks.

**What runs.** `Host.create` builds a `MoverSystem` from `scene.entities` and `scene.submodels`, the
same two arguments `main.ts` hands it. `worldStep` advances the clock **once** and then runs one
trigger pass per live human slot -- the same `advance`/`touch` split the items use, for the same
reason: `advance` per player would run `level.time` sixteen times a frame and open every door on the
map sixteen times too fast.

**Three things had to be built rather than wired.**

1. **`WorldEffects.applyTouch`.** `apply` was one method doing box, `movers.update`, carry and
   settle; it is now box + settle shared between `apply` (unchanged for single-player) and a
   touch-only path. **`applyTouch` deliberately does not carry.** `carryDisplacement` moves a player
   standing on a mover that moved, and a host with no solid movers has nobody standing on a plat to
   carry -- applying the displacement anyway would move a player who had fallen *through* the plat,
   which is motion the host invents and no client predicts.

2. **`HostMoverEvents`.** `MoverEvents` is one set of callbacks and a host has sixteen players. The
   events fire synchronously from inside `MoverSystem.fire`, which is inside `touch`, which is called
   once per slot -- so "the current slot" is well defined for exactly the length of one call, and the
   recorder is pointed at it immediately before. One `MoverSystem` with N recorders rather than N
   mover systems, because `nextFire` is per trigger and shared: a pad two players cross together is
   one trigger, and sixteen copies of it would be sixteen independent cooldowns.

3. **`SlotEffectTarget`, and `delta_angles` finally being written.** `PlayerController` satisfies
   `EffectTarget` in single-player; a host has none. The box comes from `pmove.mins`/`maxs` because
   `PM_CheckDuck` shortens `maxs[2]` while crouched (D-075). The turn is the interesting half:
   **a host cannot turn a client by writing `viewangles`**, because the client owns its aim and
   overwrites it on the next command. Q3's `SetClientViewAngle` writes the *difference* into
   `delta_angles` -- `ANGLE2SHORT(target) - cmd.angles[i]` -- and `PM_UpdateViewAngles` adds that to
   everything after, so the player's own mouse keeps working from the new facing. `NetPlayerState`
   has carried `deltaAngles` since step 1 with its docblock calling it "the host's only way to turn a
   client", and **nothing had ever written it**. Measured: 0 to 16,384, which is the destination's
   90 degrees.

**Measured.** `test/net-triggers.test.ts`. The teleporter on `oa_dm1`: 620 units to the mark,
velocity zeroed, `delta_angles[1]` 0 to 16,384, and the client's own replicated origin follows within
96 units. All **eight** jump pads on `am_thornish`: the published velocity is the vector
`AimAtTarget` solved for, exactly -- 612, 611, 612, 612, 470, 470, 470, 470 in z against the same
eight numbers -- which is also the regression test for D-139, since four of the eight target an
`info_notnull` and had `pushVelocity` null before that fix. The hurt volume on `oa_dm1`: 100 health
over twelve frames at `dmg` 10, and **ten `HitEvent`s reaching the client**, so a player burning to
death gets the view kick `EV_DAMAGE` gives them in Q3 rather than watching the health bar move in
silence.

**Two measurement traps, both of which produced a confident wrong answer.**

- **Write the component, not `ps`.** A host frame is `stepSlot` -- which is `load` from the
  replicated components, step, `store` back -- then `worldStep`, then `publish`. So a test that
  writes `record.slot.ps.origin` before the frame has it discarded by the `load` at the top of it.
  `record.state` is the authority between frames and `ps` is scratch inside one. The mistake read as
  a teleporter landing 176 units off, pads that did not fire, and a hurt volume that **healed 24** --
  the last being the replicated inventory restored over the test's own write. (It also proves the
  ordering the feature depends on: mutations `worldStep` makes to `ps` are captured by the `publish`
  that follows it, which is why a teleport survives at all.)
- **The centre of a trigger is not a place you can stand.** Where inside a brush a player can stand
  is a fact about the map's geometry: at the centre of a pad's volume the feet are 24 units lower and
  often inside the world, and the solver ejects them -- 59 to 64 units of drop and 30 sideways, every
  frame, so the trigger pass never saw them inside anything. Two candidates cover the set and are
  complementary: feet just above the volume's floor fires the four thin pads and both `oa_dm1`
  volumes, head near its ceiling fires the four thick pads whose floor is below the level's.

**What is deliberately not built, and named rather than left to be discovered.**

- **No prediction.** The pad's velocity write happens on the host and arrives in an AUTH_STATE, so
  using one costs a correction -- the same path the once-a-second health bleed already takes (D-170).
  Q3 predicts pads client-side, which is why `BG_TouchJumpPad` is in `bg_` code, and the trigger set
  is static map data both peers could build. What stops it being a wiring job is `nextFire`: it is
  per trigger and shared across all sixteen slots on the host, and single-player state on a client,
  so a bot crossing a pad 200 ms before a human would make the two peers disagree about whether the
  human's crossing fires. That is a design question, not a gap.
- **No sound.** A teleport and a jump pad both make a noise in Q3 and both are presentation. The
  joined client's `effect` hook still counts and drops every `EffectEvent` (`main.ts` says so), so a
  teleport sound would be the first transient this port presented over the wire; it belongs with the
  rest of them rather than ahead of them.
- **No bots.** A bot is not a `PlayerSlot`: no `pmove.mins`, and its aim is a private accumulator
  rather than `delta_angles`, so `SlotEffectTarget` does not fit one. Single-player has the same hole
  from the other side -- `WorldEffectSystem` is handed the player and nothing else -- so **bots have
  never ridden a jump pad or been teleported in this port at all**. Left symmetric on purpose: a host
  whose bots take the pads and a single-player game whose bots do not would be two different games,
  and the fix belongs in one place for both. `linkMapPortals` means the *pathing* already knows the
  routes exist, which is why this reads as bots ignoring a shortcut rather than bots stuck.
- **Doors and plats are spawned and advanced anyway**, because their state machine is what a
  `NetMover` producer will publish from, and a `func_door` whose clock has been running since the
  match started is in the right place on the day the host grows bodies. They change nothing
  observable meanwhile: nothing reads their origins and nothing collides with them.

### D-192: relevance culling halves the downstream on one map and does nothing on another, and meep had the hook all along

> **Superseded by D-195: the filter is removed.** The measurements below are correct and are kept;
> the conclusion drawn from them was not. A visibility filter withholds an opponent until they are
> already shooting, loses the entity rather than precision, and buys nothing on the rendering side of
> a GPU-driven engine. The three findings in this entry that read as caveats -- the entity freezes,
> the value is a property of the map, `am_thornish` gets nothing -- were the design showing through.


The thing REPORT §5's two tables both point at. The plan's instruction was to check whether meep
offers a scope or relevance hook beyond `OwnerAwareScope` before building one here, and the answer
turns two of the plan's own premises over.

**It does, and it is fully wired.** `NetworkSession` takes a `scope_filter` constructor option.
`Replicator.pack_for_peer` consults `is_entity_in_scope(peer_id, network_id)` for every record in
the owed range, packs only what passes, and **writes no packet at all** for a peer with nothing in
scope. `ScopeFilter.js` ships `AlwaysRelevantScope` and `OwnerAwareScope` and its own docblock names
PVS culling and area-of-interest as what a game is expected to supply.

**And "no filtering" was wrong for a second reason: component mutations are actions.**
`net_mutate_component` becomes a `ReplaceComponentAction` in the action log, so the filter covers
the whole of the replication traffic rather than only the game's own events. The half of the plan's
premise that *was* right is the baseline: there is no delta compression against each client's
acknowledged snapshot, so an in-scope component costs its full bytes every time it changes. Culling
removes entities; it does not make the ones that stay cheaper.

**One thing the engine has and does not use.**
`network/state/PriorityAccumulator.js` is a complete starvation-resistant per-action-type priority
scheduler -- and its own docblock says "wiring it into `Replicator.pack_for_peer` is the
orchestrator's concern; the prototype's tiny action volumes make integration unnecessary". So
`Replicator` never consults it. It is the right thing for the *other* half of the problem (which
action gets the last 200 bytes of an MTU-bound packet) and it is inert. Recorded as an observation
rather than a gap: an unwired data structure with a docblock saying it is unwired is honest.

**What was built.** `src/q3/cm/pvs.ts` is `CM_PointLeafnum_r` plus `CM_ClusterPVS` --
`clusterAt(cm, x, y, z)` and `clusterVisible(vis, from, to)` -- and `BspFile.visibility` hands over
the lump. **The lump is in this port's collision BSP**, which is what made this a measurement rather
than an estimate: `tools/convert-map.ts` keeps the whole lump table rather than the lumps somebody
thought collision needed, so `oa_dm1` carries 23,640 bytes of it. `src/server/PvsScope.ts` is the
filter, behind `HostOptions.pvsCulling`.

**Measured, 6 clients and 4 bots for 20 s, which is REPORT §5's own configuration:**

| map | clusters | pairs mutually visible | KB/s per client, off -> on | bytes saved | packets |
|---|---:|---:|---:|---:|---:|
| `oa_dm1` | 422 | 22% | **42.9 -> 19.3** | **55.0%** | 14,400 -> 10,800 |
| `am_thornish` | 72 | 76% | 41.0 -> 41.0 | 0.1% | 14,400 -> 14,374 |

On `oa_dm1`, 65,935 of 112,974 relevance questions are answered "not visible", against 14,410 the
owner rule catches on its own. **On `am_thornish`, visibility answers "no" fifty-two times.** Same
netcode, same six paths, same seed; both runs bit-for-bit reproducible.

**So the conclusion is about maps rather than about netcode**, and that is the finding. `oa_dm1` is
422 clusters and a player can see about a fifth of them; `am_thornish` is four alcoves around one
hall, compiles to 72 clusters, and 76% of its cluster pairs are mutually visible, so there is nothing
to remove. A port that ships both needs this measured per map rather than quoted as a number -- which
is why `test/net-relevance.test.ts` prints the table on every run rather than asserting a value.

The packet *count* falling by a quarter on `oa_dm1` is the other table's currency: a peer with
nothing in scope for a frame gets no packet, so there is a quarter less to pack as well as half as
much to send. That is the direction REPORT §5's superlinear host cost needed, though this entry does
not claim a CPU figure -- the rig's clock is its own step counter and a wall-clock measurement
belongs with the bench that took the original.

**The bug this measurement caught, which is the reason to measure rather than reason.** The first
version of `PvsScope` answered the visibility question alone. `NetworkSession` installs
`scope_filter || new OwnerAwareScope(...)`, so **supplying a filter replaces the default rather than
adding to it** -- and the default is load-bearing: its docblock says the host must not echo a
client-owned entity's actions back to that client, "otherwise the executor would re-apply them on
top of the client's prediction". With it gone, `am_thornish` traffic went **up 10.2%** while culling
0.1% of it, at an unchanged packet count. That is the shape of an echo, not of a filter. The fix is
the conjunction -- not the recipient's own, **and** visible -- and the two are counted separately so
the visibility figure is the visibility figure. `net-relevance.test.ts` asserts the owner rule is
still running (14,400 culls, one per client per frame) precisely because losing it is silent.

**Why it is off by default, and this is the honest shortfall.** When a slot leaves a client's PVS its
`NetPlayerState` stops arriving, and `NetPresentationSystem` draws any slot whose replicated
`connected` is set -- so a culled player **freezes mid-stride instead of disappearing**. Q3 does not
have this problem: an entity absent from a snapshot is absent from `cg_entities` and is not drawn.
Fixing it means the client knowing a slot's state is stale, and `NetPlayerState` carries no way to
say so -- nor can the client infer it, because a slot standing still and a slot being culled produce
the same unchanged component. The candidates are a per-slot last-seen frame the client tracks off
`onFrameApplied` (which reports frames, not entities), or a `stale` bit the host cannot set because
staleness is per recipient and the component is shared. That is the next piece of work, and it is
presentation rather than netcode.

Two smaller decisions inside the filter, both recorded where they are made:

- **Items and the match are always in scope.** An item publishes only when its `present` flag
  flips -- a handful of times a minute -- so culling it saves nothing measurable and would put a
  *single mutation* behind a visibility test, which is exactly what GAP-045 says is not reliably
  delivered; a lost `NetItem.present` is an item invisible to one client and solid to the host. The
  reason is delivery, not bandwidth.
- **A peer's cluster is found once per frame, not once per question.** `pack_for_peer` asks about
  every record for a peer in one pass and `clusterAt` is a BSP descent. Getting that backwards would
  spend the host CPU the bandwidth was being saved for, which is the table this was meant to help.
- **No area portals.** Q3 refines the PVS with `areaportal` state so a closed door hides a room; that
  needs solid movers on the host (GAP-041) and it only ever *removes* entities, so leaving it out is
  conservative in the direction that keeps the game correct.

### D-193: meep 3.15.0 closes GAP-045, and the number it fixes was being read as a render delay

Upgraded from 3.14.6. **One file under `engine/network` changed** --
`orchestrator/ServerAuthoritativeClient.js` -- and it closes the port's oldest open upstream gap.
Everything else in the release is `shade/`, which this port cannot exercise in the preview browser.

**GAP-045 is fixed, and the fix is the other half of a rule `SimAction` already stated.** A record's
`sender_id` says whether it arrived from a peer, was authored locally, or was derived, and a replay
is supposed to reapply the first two and recompute the third.
`ServerAuthoritativeServer.#read_historical` did that on the host; the client did not. `onReplay`
covers the authored half -- this client's own input -- and nothing covered the arrived half, so a
rewind about one entity discarded every **other** entity's published state for the whole window,
permanently for anything published on change, because nothing re-sends it and nothing else restores
it. 3.15.0 harvests the arrived records out of each frame before reopening it (copied out, because
`begin_frame` rewinds the buffer over the bytes being read) and re-executes them through the
executor, so the reopened frame describes what is now live and the next rewind can undo it.

**Measured here, and the residual is gone.** `test/net-match.test.ts` reported one slot in
thirty-two stale over 45 seconds with two clients and four bots; it now reports **zero**, and the
assertion is exact rather than the `<= 2` bound that let "nearly right" sit for three releases.
Across four configurations, with the in-flight window drained so the number is loss rather than lag:
zero stale on a loopback with two clients, zero with six, zero at 80 ms with four, and zero at
150 ms with 40 ms jitter and 5% loss with six. `replayed_arrived_count` -- the engine's counter for
the fix doing work -- runs to **36,489** records over 45 seconds with six clients on a loopback,
which is the scale of what used to be thrown away.

**And it corrects a number this port has been misreading.** `test/net-presentation.test.ts` measured
how far a drawn remote player sat from the host's own position and called it the render delay, with
a comment saying zero "would be wrong here, not right: it would mean the client was drawing the
newest snapshot it had and stuttering between them." It was neither. `NetClient.step` ends with
`normalize_if_dirty()`, which puts every remote component back to canonical precisely so simulation
does not read a blend, and the test harness has no `NetRenderSystem` -- so `system.update()` runs
after the normalize and reads canonical values. **The quantity was replication fidelity, not render
delay**, and 0.04 units mean with a **23.05** worst was GAP-045 in a file that never mentioned it.
On 3.15.0 it is 0.00 and 0.00 over 2,400 frames and four bots, and the assertion is now exact on
both the mean and the maximum -- the maximum because an average of zero with one 23-unit spike in it
is precisely the old failure. The render delay is real and still applies in the browser, where
`NetRenderSystem` blends immediately before this system reads; it is simply not what this file can
see. The missile census moved the same way: worst single-frame move 60.0 units to **30.0**.

**A second new signal, and it is a loss rather than a fix.** `onReconcileAbandoned` and
`reconcile_abandoned_count`: `ServerAuthoritativeClient` rewinds to `server_frame - 1` before
applying an AUTH_STATE, and when the action log has already rolled past that frame the rewind throws
and the reconciliation is skipped -- taking the window's records for every entity other than the one
the AUTH_STATE names. 3.14.6 and earlier caught the throw and returned; the comment said "for now
skip this reconciliation". It is now counted and announced. `NetClient` subscribes and
`net-delivery.test.ts` reports it against a target of zero: **2 over 45 s on a loopback, 34 with six
clients at 150 ms and 5% loss**. Nothing acts on it, because the repair the engine names is a
`RECOVERY_REQUEST`/`STATE_BURST` round trip that D-167 has on the follow-up list. What it buys today
is that the failure is visible, which is the thing GAP-045 spent three releases not being.

**`INFO_RESEND_FRAMES` stays, and what it covers has changed.** GAP-045's entry said the ten-frame
republish "becomes a tuning knob rather than a workaround on the day it lands", so it was tested for
removal rather than assumed. At 1 -- publish once, no redundancy -- the loopback and 80 ms cases are
still zero stale, and the worst link is not: **five slots of ninety-six**, alongside **2,874**
abandoned reconciliations against 34 with the republish in place. So it is still doing work at
150 ms and 5% loss, and what it is covering there is the abandonment above rather than the rewind
discard. Kept, with the reason rewritten to say which failure it is for. Removing it on the strength
of the loopback case would have been the same mistake as reading the presentation number as a render
delay: the right measurement at the wrong link.

**GAP-047 is unchanged and the upstream report still stands.** `Replicator.js` is byte-identical
between 3.14.6 and 3.15.0, so `skipped_unapplied` still reads 185 and 214 over ten and twenty
seconds where ten frames are lost, and `#hold_slice` still validates with `min_frame = Infinity`.
D-189's measurement and `tools/repro/meep-delivery-counter.mjs` need no re-running, and did not
change when re-run.

### D-194: players are created when they arrive, and the network stops having slots

A direction from the brief rather than a defect: *"a new peer/agent is just an extra entry, never a
slot. We cap how many can join... If we have capacity of, say, 16, it's just a variable somewhere,
not an actual array of 16 entries."* The pool was never a design preference -- GAP-038 forced it --
so the first job was to find out how much of it the wire actually requires. Measured on 3.15.0
rather than taken from the register:

| the host does this, to a client already connected | result |
|---|---|
| creates an entity and publishes it for ninety frames | **never arrives** -- `entity_for` stays -1, silently |
| creates an entity and pushes a fresh INITIAL_SYNC | **arrives**, with its data |
| destroys the entity and pushes a fresh INITIAL_SYNC | **the client keeps it** |

So growth is reachable and shrinkage is not. `NetworkPeer.send_initial_sync` is public and
`NetworkSession.#apply_initial_sync` walks the wire format by hand *specifically* so a slot that is
already allocated does not throw -- re-sync is a case the engine anticipated. There is no CREATE or
DESTROY among the thirteen `NetworkPacketType`s, and a snapshot only creates entities the receiver
does not know, so removal has to be the application's.

**What is built.** `Host.players` is dense: one entry per player present, nothing for an id nobody
is using. `Host.capacity` is a number compared against `players.length`, and `HostOptions.capacity`
lowers it without allocating or freeing anything. `addPlayer` is the only door and returns null when
the match is full; `removePlayer` destroys the entity and the character body and queues a
`PlayerLeft`. Bots go through the same door, because a bot is a player.

**The two directions cost different things and both are in the code where they happen.**

- **Arrival: one whole-world snapshot to each peer already here.** Pushed on the next tick rather
  than inside `addPlayer`, because a snapshot has to be emitted where the action log is open, and
  because one push covers any number of arrivals in a frame. Only to peers who were here *before*
  the arrival -- the joiner gets the engine's own, and sending a second cost real delivery when it
  was tried: frames lost at 80 ms went 0 to 1 and at 150 ms 10 to 15, because `onInitialSync` calls
  `seek_to_frame` and a redundant snapshot re-seeks the clock of a client that is already running.
- **Departure: a `PlayerLeft` action.** The host names the `network_id` and the client destroys its
  own copy, which it is entitled to do because it is its own entity. Appended to the action list so
  every existing type id keeps its number.

**Two costs stated rather than buried.** The snapshot push is a spike proportional to the
population, on every join, and a server churning players would feel it. And it **overwrites the
peer's session token**: `#peer_session_tokens` is `#`-private, so there is no way to read the one
the engine issued, and a later RESUME_HELLO would present a token the host does not recognise and be
answered with RESUME_REJECT -- degrading to a fresh sync rather than failing. Harmless today because
this port does not enable the reconnect ladder (D-167 has resume on the follow-up list); one
fabricated token per peer is cached and reused so the client's copy is at least stable.

**The client no longer builds a pool of players and no longer needs to.** It builds the match
entity, the missile pool and the item pool -- fixed populations, same count on both peers, same
order, so their network ids line up by construction, which is what GAP-038 actually requires. Players
arrive in snapshots with their ids carried rather than derived. An `EntityObserver` on
`[NetPlayerState, NetInventory, NetPlayerInfo]` is how it notices: the tuple completing *is* the
event "a player exists", it fires for the snapshot that creates them, and the dataset has no entity
iterator anyway.

**Which player is this client's is now decided by ownership rather than by position.**
`Host.admit` writes `owner_peer_id` before the snapshot goes out, so the entity whose identity names
this peer is the one the local `PlayerSlot` drives. That replaced an array index that both peers had
to agree on by building the same pool in the same order -- the answer is on the wire now instead of
being reconstructed from a convention.

**One field had to go on the wire.** `NetPlayerInfo.playerId`, a byte. It is Q3's `clientNum` -- what
`EffectEvent.owner` and `HitEvent.attacker` already carry -- and while every player had a pre-created
entity the client could read it off the array position, because the pool was built in id order on
both peers and position *was* identity. There is no position now. It costs nothing at rest: the
component is published on change and this never changes for a player who exists.

**GAP-044's parking is gone rather than moved.** Sixteen character bodies existed from the first
frame, an unoccupied one was solid, and the fix was to park it a million units down; the local
player's own sweep had hit one and been depenetrated 30.16 units off the host's position for ever.
There are no unoccupied ones. `test/net-loopback.test.ts`'s parking test now asserts that the two
ends agree about the population, which is the property the parking was protecting.

**What this does not buy, said plainly because the obvious claim is wrong.** It is not bandwidth.
`publishPresence` gated on `connected`, so an unoccupied slot published nothing after its parting
window -- downstream is **42.9 KB/s per client before and 43.2 after**, unchanged. What goes away is
a class of failure: a solid body where no player is, a `connected` byte standing in for existence,
sixteen entities in every join snapshot, and an id space that had to be agreed by convention.

**A bug this found, and it is the kind only a refactor finds.** `wireReconciliation` captured
`const owned = this.ownPlayer` at construction time. That was fine while every player had an entity
from the first frame and became permanently `undefined` the moment discovery moved to INITIAL_SYNC.
Every `onComputeExpected` then threw on `.entity`, `Signal` logged "Failed to dispatch handler" and
carried on, and the prediction short-circuit silently never ran -- the client rewound and replayed
its whole lead on **every** AUTH_STATE, at 1.03 reconciliations per frame against a budget of 0.05.
A swallowed exception in a handler deserves more suspicion than a wrong number, because a wrong
number at least gets asserted on.

**And a measurement that moved for a reason worth recording.** `net-delivery.test.ts` asserted an
exact zero frames lost at 80 ms. Making players dynamic reorders when character bodies are created,
which reorders their physics entity ids, which changes the broadphase pair order and therefore which
bots meet -- so the fixture's match is a different match. Rather than re-baseline on the new single
sample, it was measured across four seeds: **2, 3, 3, 2** at 80 ms and **0, 0, 0** at 40 ms. The old
zero was one match, not a property of the link, and had been hiding there since the file was written.
40 ms keeps its exact zero; 80 ms is now a residual reported against a target of zero like the
150 ms rows beside it.

**What is left.** The naming: a player's game-level id is still called `index` on the record and
`slotIndex` on the client, because it is Q3's `clientNum` and the brief allows the concept at a
higher level -- but the words are the pool's and could be better. And `MAX_CLIENTS` is now only the
default capacity and the width of the id space, which is what it should always have been.

### D-195: the PVS filter comes out — it was the wrong lever, and I measured it instead of questioning it

D-192 built a PVS relevance filter, measured it at 55% of the downstream on `oa_dm1`, and left it
off by default behind a presentation shortfall. It is removed: `src/server/PvsScope.ts`,
`src/q3/cm/pvs.ts`, `BspFile.visibility`, `HostOptions.pvsCulling`, the rig option, the
`scope_filter` plumbing in `SessionOptions` and `test/net-relevance.test.ts`. About 700 lines.

**Why it was wrong, and none of the three reasons is about the implementation.**

1. **It withholds the information you need earliest.** A player rounds a corner and shoots. Under a
   visibility filter they enter your set and leave it again inside a round trip, so the first you
   hear of an opponent is the moment they are already firing at you. Every PVS boundary in a
   deathmatch level is exactly where a fight starts — the filter's error is not spread evenly over
   the map, it is concentrated at the corner of every room. A bandwidth lever whose failure mode
   lines up that precisely with the moments that decide the game is not a bandwidth lever.
2. **It has no graceful degradation.** The other two levers on REPORT §5's list lose *precision*:
   quantisation makes an opponent's position coarser, a lower remote publish rate makes it older.
   Both are knobs, both are tunable, both fail softly. A visibility filter loses the *entity*. That
   is a cliff, and it is why the freeze I recorded in D-192 was not a presentation bug one fix away
   from shipping — it was the design showing through.
3. **And it earns nothing on the rendering side**, which is where PVS pays for itself in engines
   that need it. Shade is GPU-driven with frustum and occlusion culling; a precomputed cluster set
   is a second, coarser, offline answer to a question the renderer already answers per frame and
   better. There was never a rendering win to bank.

**What I actually did wrong, which is the part worth keeping.** REPORT §5 listed three levers and
said the first was "worth more than the other two together". I took that as the specification and
went looking for the number, and the number came out large, and a large number is very good at
ending an argument that should have started. The design question — *what does a shooter do when it
does not tell you about a player* — was never asked, and D-192's own findings were pointing at it
the whole time: the entity freezes, the value is a property of the map rather than of the netcode,
and `am_thornish` gets nothing. Three results that say "this is not a lever" read as three
caveats to a feature.

**What survives, and it is not nothing.**

- **meep has a relevance hook and the plan's premise about that was wrong.** `NetworkSession` takes
  a `scope_filter`, `Replicator.pack_for_peer` consults it per record per peer and writes no packet
  at all for a peer with nothing in scope, and **component mutations are actions**, so it covers the
  whole of the replication traffic. Recorded in REPORT §5. A future filter with a *defensible*
  predicate — a hard distance cap far beyond any sightline, say, or a spectator with no need for
  prediction — has a place to live.
- **`OwnerAwareScope` is load-bearing and supplying any filter replaces it.** Found the hard way:
  the first version of `PvsScope` answered only the visibility question, and the host started
  echoing each client its own predicted entity back — traffic **up 10.2%** while culling 0.1%, at an
  unchanged packet count. That is a trap for anyone who supplies a `scope_filter` for any reason,
  and it is why the finding is in REPORT rather than deleted with the code.
- **The numbers.** 422 clusters on `oa_dm1` with 22% of pairs mutually visible against 72 and 76% on
  `am_thornish`; 42.9 → 19.3 KB/s per client and 41.0 → 41.0. Kept because they are real and because
  somebody will propose this again, and the answer should be "yes, it saves half the bandwidth on one
  of our two maps, and here is why we still do not want it".

**What the bandwidth problem is actually waiting on.** `NetPlayerState` is 70 bytes and 27 of them
are `float32` — position, velocity and ground normal — where Q3 sent quantised 16-bit. That, and
publishing remote slots less often than the local prediction the short-circuit compares against.
Both lose precision rather than entities, both are measurable against the same rig, and neither is
built.

### D-196: 245 KB/s is not a problem, and the budget I measured it against is a modem-era number

D-192's mistake, one layer up. Asked what a sixteen-player match costs a client, I measured it
honestly -- 62.6 KB/s down on a loopback, 245 on an 80 ms link, 1.5 and 9.8 up -- and then reported
it as "1.3× over on a perfect link and 5× over on a realistic one", against the 48 KB/s figure in
`NETWORK_PLAN.md` §7.

**That figure appears exactly once, as "the budget to assert", with no derivation, no target
connection and no date.** 48 KB/s is 384 kbit/s. Q3's own `rate` cvar defaulted to about 25 KB/s
because Q3 was written for modems. Measuring a 2026 port against it and calling the result a
problem is arithmetic dressed as a finding.

**245 KB/s is 1.96 Mbit/s.** It fits inside plain HSPA, is nothing on LTE or anything since, and is
a quarter of the worst home broadband still sold. There is no client-side bandwidth problem at
sixteen players and there never was one at ten.

**What is actually worth caring about, at its real size.** Host egress, and only at scale: ~16
Mbit/s for eight connected humans, unremarkable for one match in a datacentre, awkward for a listen
server on a home upstream, and multiplied by concurrent matches -- a hosting cost line rather than an
engineering blocker. Metered connections, at ~880 MB an hour, which is a product decision about who
the game is for. And **packet rate is not a concern** despite looking like one: ~2,600 packets a
second out of the host for eight clients is not a number a server process notices.

**So quantisation is demoted rather than dropped.** Not a bandwidth lever: a way to get a tick under
the 1,191-byte channel payload and out of the fragment and reassembly path, which would roughly halve
the packet count and simplify the hot path. 27 of `NetPlayerState`'s 70 bytes are `float32` where Q3
sent quantised 16-bit. It is not urgent, and nothing currently measured blames fragmentation for
anything -- the delivery census at 80 ms and 2% loss does not show reassembly failing.

**The pattern, twice in two days.** D-195 was taking "relevance culling is the biggest lever" from
REPORT §5 as a specification and going to find the number. This is taking "the budget to assert is
48 KB/s" from the plan and going to find the number. Both times the measurement was sound and the
question was not asked. A number in a plan is a decision somebody made once, and the useful thing to
know about it is when, and why, and whether it still holds.

### D-197: the transients, and the rule that a replay does not re-fire them

Step 6's largest remaining hole, and it was one line long in two places:

```ts
effect: (): void => { netEvents.effects += 1; },
pickup: (): void => { netEvents.pickups += 1; },
```

Every `EffectEvent` and `PickupEvent` the host dispatched was counted and thrown away, so a joined
client had **no muzzle flash, no bullet impact, no hitscan trail, no explosion, no death effect and
no pickup feedback**. The simulation was correct and none of it was visible or audible; `hit` was
the only transient wired at all, and only for the local slot's view kick. Step 5 put the counters
there on purpose -- "the effect actions are arriving" and "the effect actions are being drawn" are
separate claims and only the first was step 5's to make -- and this is the second one.

**Nothing is reimplemented.** `Arena` already turns each of the five weapon effects into particles,
a light, an impact mark and the sound Q3 plays there, out of one class that knows both the weapon
and the surface; the difference between the two branches is *where the call comes from* and nothing
else. So `RemoteEffects` is `Arena`'s `WeaponEvents` half, one method per `EffectKind` that draws
something, and `main.ts` hands the wire straight to the arena through five one-line delegations.

**Three things do differ, and they are why `NetTransients` is a class rather than a `switch` at the
hook.**

1. **Whose event it is.** `Arena` asks whether the shooter is `LOCAL_CLIENT`, which is Q3 client 0,
   and the wire's `owner` is a *slot index*. Passing one for the other hangs the view weapon's flash
   on whoever holds slot 0 and never on the player holding the gun -- and on a host that put this
   client in slot 0 the two agree by accident, which is the version of the bug that never shows up
   in a test. `RemoteEffects` carries a boolean instead, and the translation is at the wiring site.
2. **What a pickup is.** The wire carries an item *index*; the sound name and the status-bar label
   come off the def both peers loaded from the same map. `PresentationSystem` now takes a
   `PickupLabel` -- two getters -- rather than a `PickupSystem`, because on this branch there is no
   `PickupSystem`: the items are the host's.
3. **Where a sound goes.** Q3 plays your own pad and your own pickup dry and everybody else's from
   where they are standing. Single-player only ever had the first half, because there was nobody
   else, and `main.ts` hard-codes `playLocal` for the jump pad accordingly.

**And the two shortfalls D-191 named are closed with them.** `EffectKind.Teleport` and
`EffectKind.JumpPad` are appended to the byte both peers read off the same frozen table, and
`HostMoverEvents` raises them into the same queue the weapon events use. A teleport carries where
the player left in `origin` and where they arrived in `aux` -- read at the moment the trigger fires,
which is *before* `WorldEffects.settle` moves them -- so `world/telein` and `world/teleout` land at
Q3's two points rather than both at one. A pad carries the vector `AimAtTarget` solved for. The
third thing D-191 left silent, `moverSound`, stays silent and is not the same shortfall: a door's
noise comes from a state machine no client can see (GAP-041), so a client that heard one would hear
a door that never moved on its screen. It follows the bodies.

**And a clock nobody was running, which drawing anything at all revealed.** `Arena.update` cannot be
called on this branch -- the first thing it does is step the weapons, and the weapons are the
host's -- so `CombatSystem` is not registered and the four things inside that call have to be
accounted for one at a time. Three already were: the missile roll comes through
`MissilePresenter.advance` (D-181 wrote that down), the projectile trail follows
`WeaponSystem.liveProjectiles`, which is empty here, and the shootable boxes are single-player's.
The fourth is `Effects.update`, which retires a finished emitter, expires a muzzle flash's light
after 50 ms, and fades an impact mark out over `CG_AddMarks`' ten seconds. Nothing ran it. That cost
nothing while a joined client drew nothing at all and became a few hundred entities a minute the
moment it did -- every flash and every scorch mark of a whole match accumulating in the dataset with
no path out. `NetEffectSystem` is the one line, and the test measures the leak rather than the
registration: a hundred transients make 220 entities and twelve seconds of clock takes all 220 away.

**A fix that came with the wire format.** `HostWeaponEvents.explosion` substituted straight up for a
missing surface normal, so a rocket that stopped on a *body* told every client to stamp a scorch
mark on the floor underneath it. `Arena.explosion` has guarded against exactly that since D-163 by
testing whether it was given a normal at all -- and the wire defeated the guard by always having
one. The zero vector is the sentinel now, which cannot be confused with a normal.

**GAP-048, which the fixture found and which is a regression in a property this port was built on.**
`src/net/actions.ts` has said since step 1 that an action with no affected components "cannot be
un-fired by a rollback, and cannot be fired twice by a retransmission". The first half still holds.
The second stopped being true in meep 3.15.0: `ServerAuthoritativeClient.#execute_harvested` --
GAP-045's fix, and the thing D-193 was glad to get -- re-executes every record in a rewound window
whose `sender_id` is a connected peer, because an arrived record is the only description of the
state it carries. An event action carries none, and the harvest has no way to ask.

It is worst exactly where it is most visible, because **the transients a client cannot predict are
the ones that force the rewind that duplicates them**. Measured: one host-side teleporter crossing,
one event raised, **two** arrivals, two `world/telein`s. In an ordinary firefight it is 53
re-applications over 1,200 frames and 217 reconciliations, against 543 genuine events. The
workaround is a `replaying` flag on `NetClient`, set on `onBeforeReconcile` and cleared on both ways
a reconciliation can end, gating the three presentation hooks. It cannot drop a first delivery,
because the harvest only re-runs records already in the log. `playerLeft` is deliberately not gated:
it is a state change rather than a presentation, so a replay is entitled to re-run it, and the
second call finds no record and returns.

The alternative -- a sequence number on each event and a seen-set -- is robust against a genuine
duplicate too, and costs one to three bytes on every event on a wire that already carries 543 of
them a run. The flag is free and covers the case that exists.

**Measured**, `test/net-effects.test.ts`, ten assertions over three rigs:

- 1,200 frames on `oa_dm1`: **543 effect actions arrived and 543 were presented** -- 191 muzzle
  flashes, 161 hitscan trails, 161 bullet impacts, 30 explosions -- against **543** the host raised.
  Equal in both directions, which is the number GAP-048's gate exists for.
- Every drawn effect names a real `WeaponId`, both guns among them, and `mine` matches the stream's
  own owner field on all 191 flashes.
- 161 trails between two points: shortest 1.0 units, longest 522.3. The short ones are real -- a
  shot taken with the muzzle against a wall stops where it started -- so what is asserted is that
  one of them crosses a room, which cannot be true if the two ends are being read as one field.
- A forced death: **one** death explosion and **one** `impact/flesh`, at the host's own origin.
- A pickup: `item/item_armor_combat` played dry, `"Armor"` on the status bar, and the same shard
  taken by another slot played *positionally*.
- The teleporter on `oa_dm1`: one event, `telein` at [274, 1600, -104] and `teleout` at
  [448, 1024, 40], the far end within 4 units of the mark the host actually used.
- A jump pad on `am_thornish`: one event, played dry for the rider, `aux` z of **612** against the
  612 `AimAtTarget` solved for.
- A hundred transients through a real `Effects` in a headless dataset: **220 entities created and
  220 retired** once the clock has run past the marks' ten seconds.

**One trap this fixture walked into, and it produced a confident wrong answer.** **Take both ends of
a measured window at the same instant.** The first version started the presenter at zero and the
host count at "now", so it presented the warm-up backlog and compared it against a host that had
forgotten it: **660 presented against 543 raised** -- which reads exactly like the duplication the
file is there to rule out, and would have been reported as it.

**And one thing that looked like a trap and is not**, checked rather than assumed because the
opposite claim was nearly written down here. Arming the client through `record.slot.inventory` --
which is what `net-presentation.test.ts` does -- looks like the `ps`-versus-component mistake
`net-triggers.test.ts` names, since a host frame is `load` from the components, step, `store` back.
It survives: the `store` at the end of the frame puts the scratch write into the component, and the
grant is still there eleven frames later with its 400 rounds. This file writes the component anyway,
because that is the version that does not depend on the ordering -- and writes it *every frame*,
which is the part that actually matters, since a client holding the trigger for twenty seconds
empties a magazine and a fixture whose subject stops appearing halfway through is the failure the
paragraph above is about.

**And a fixture fact worth writing down rather than leaving to be rediscovered.** Over the 1,200
measured frames with three bots on seed 23, the bots fire **nothing**. That is the fourth time this
suite has met the same thing (D-187), and it is why every assertion here is produced by the client's
own script or written directly -- including the one about somebody *else's* muzzle flash, which is
two synthesized events with two owners rather than a wait for a bot to shoot.

Also here, because they were in the way and are the same change: `weaponAt` returns a `WeaponId`
rather than a `string` -- `NET_WEAPONS` is `isWeaponId`'s own output, so the tag has already been
through D-114's one crossing and two call sites stop casting it back -- and `net/triggers.ts` holds
the standing-spot geometry `net-triggers.test.ts` paid three runs each for, because this file needs
the same two facts to stand a client on a teleporter and hear it.

### D-198: meep closes GAP-015 by removing the argument, and every character in the game threw

`Animation`'s constructor takes no arguments as of 3.15.0 and asserts if it is given any. This port
had exactly one call site -- `Character`, in `Characters.ts` -- so **every character in the game,
single-player and networked alike, threw on construction**:

```
Failed during update of system 'NetPresentationSystem':
  Error: Animation takes no constructor arguments; use Animation.fromJSON(json) for the
  serialized form, or clips.add(clip) for clips you already hold. 1 !== 0
```

The migration is one line: `Animation.fromJSON({ clips })` where `new Animation({ clips })` was.
The argument's *shape* is unchanged -- it was always the accepted one, which is what GAP-015 was
about -- so nothing else moved.

**The fix upstream is better than the one this port asked for, and worth recording as such.**
GAP-015 and BUG-1 both suggested accepting both forms: pass an `AnimationClip` through rather than
rebuilding it from JSON that does not describe it. 3.15.0 did neither and removed the constructor
argument instead, and its new docblock says why: "The ambiguity is removed rather than widened:
there is now one way in per representation, and neither is the constructor." That is the right call.
Accepting both would have left two ways to be right and one of them still subtly wrong, and this
port's own workaround -- build from JSON, then read the constructed clips back out to hold them --
is exactly what the `clips.add(clip)` path is for. The docblock also cites the report by number and
by cost, which is the first time this repository's output has come back as an upstream comment.

**The expensive part is not the migration. It is that `npm run check` was green through all of it.**

- **`tsc` had nothing to say**, because the emitted declaration is `constructor(...args: any[])`.
  That is BUG-5's family -- the `.d.ts` files do not describe what the JavaScript does -- and here
  it turned a hard, deliberate, loudly-asserted breaking change into a runtime error for a
  TypeScript consumer. A removal that is loud at runtime and silent at compile time is louder than
  no removal and quieter than it looks.
- **No test had ever built a `Character`.** `characters.test.ts` is 34 assertions about the
  character pipeline and every one of them stops at the glTF on disk: it parses the MD3, evaluates
  the emitted skinning by hand, and compares. The component that *plays* the result was outside it,
  so the file that is named after this class could not catch a class that no longer constructs.
- **So it surfaced in the browser**, out of `NetPresentationSystem.characterFor`, which is the first
  thing on the networked branch to build one -- and it would have surfaced identically in
  single-player, from `buildRoster`.

**The test that closes it is cheap and should have existed since phase 4.** `SGMesh.fromURL` stores
a URL and fetches nothing, so a whole `Character` goes together against a bare
`EntityComponentDataset` in a Node test. It asserts the two clips exist, that their names are
`LEGS_IDLE` and `TORSO_STAND` rather than the empty strings GAP-015 produced, that `setLegs` and
`setTorso` reach the same clips, and that `repeatCount` is -1 for a run and 1 for an attack. Reverted
against the old call it fails with the browser's exact message, and against the old *engine* it
would have failed on the names -- one test for both sides of one seam, which is what a seam that has
now broken this port twice deserves.

Also here, because they were two lines and both were false: `README.md` said the port has no
scoreboard UI (D-190 shipped one, on tab) and that sixteen slots "is not reachable without relevance
culling neither the engine nor this port has" -- which D-192 and D-196 between them retract twice
over. meep does have the hook (`scope_filter`, fully wired), and 245 KB/s at sixteen players is 1.96
Mbit/s and not a problem; what is left is a hosting cost line, and that is what the README now says.

### D-199: the scoreboard key cost the pointer lock, because a poll is not a subscription

Holding tab opened the board and then ended the game: focus left the document, the pointer lock went
with it, and the next press started cycling the browser's own UI.

**The mechanism is a good engine rule meeting a deliberate decision of this port's, and neither is
wrong.** `KeyboardDevice.#handlerKeyDown` calls `preventDefault` for a key whose own `down` signal
has a handler -- a key somebody subscribed to is a key the application owns, which is exactly the
right default and means no consumer has to keep a list of browser-reserved keys. This port *polls*
tab instead: `held: () => keys['tab']?.is_down`, and D-190 has the reason, which is still good --
a key released while the window was unfocused cannot get stuck down, and for a board you hold that
is the difference between a board and a board that will not close. A poll registers no handler, so
the engine's rule does not fire, so tab kept its default action.

Space was already in the same position and already named in `PlayerController.onKeyDown`. Tab joined
it there, which looked like one line rather than a design -- and **was wrong, in a way that took a
second bug report to see**.

**The first fix worked for about a second and then failed for as long as the key was held**, which
is auto-repeat. `#handlerKeyDown` returns early on `event.repeat`, and it does so *before* both the
signal and its own `preventDefault`. That early return is correct: a repeat is not a new press, and
a device that reported one would make every edge-driven binding in the engine fire sixty times a
second. What it means is that a **held** key produces exactly one cancellable event and then a
stream of uncancelled ones. So tab was suppressed for the length of the operating system's repeat
delay and then began traversing the focus ring once per repeat, still held -- the board opened, and
then the game ended anyway, slightly later.

So the suppression is a DOM `keydown` listener of its own, on `this.element`, which is the element
the device itself listens on (`viewStack.el`) and in the same bubble phase -- so `Menu`, which stops
`keydown` on its own root, keeps shielding both of them identically. Weapon select stays on the
device's signal, where dropping repeats is exactly right: holding `3` should select the shotgun once.
The two halves want opposite things from the same event, which is the argument for two listeners.

**And the first test passed while the bug was still there**, which is the part worth keeping. It
emitted through `devices.keyDown` -- the signal -- and the signal is precisely where a repeat never
arrives, so the fixture could not express a held key at all. A test that cannot represent the
failure is a test that will pass whatever the code does. The suite now dispatches at the element,
and the case that matters presses tab once and then thirty times with `repeat: true`; with the
device's own repeat filter copied into the listener it fails on `repeat 0`, which is the bug as
reported.

**It is gated on the pointer lock and space is not, and that is a difference rather than an
oversight.** Space scrolls a page and this page is a canvas with nowhere to scroll, so taking it
always costs nothing. Tab moves the focus ring, which is the browser's to move whenever the player is
not in the game -- a page that cannot be tabbed through at all would be a worse bug than the one
being fixed, and an accessibility one. Inside the lock there is no focus ring to move and the default
action is purely destructive. `PlayerController.active` is already exactly "the pointer lock is
held", so the gate is a field that existed.

The menu needs no special case: `Menu` swallows `keydown` on its own root, so a tab pressed inside a
settings page never reaches the device and still moves between the controls there.

**Tested at the seam that broke.** `player-controller.test.ts` already had an `activate`/`deactivate`
pair for the lock; what it did not have was an element that could receive a listener, because
nothing had ever put one there. `dom.element()` now carries `addEventListener` and a `press(code,
repeat)` that dispatches to whatever registered -- five cases: tab cancelled while locked, cancelled
through thirty repeats, *not* cancelled once unlocked (repeats included, so the gate cannot be
outrun), space cancelled either way, and both released on `detach`.

### D-200: four things a joined client was not doing, and one clock that made it look like a fifth

Five defects reported from a real browser against a real host. Four of them are one mistake, and it
is a mistake about a *shape* rather than about any of the four:

```ts
if (netClient === null) {
    await em.addSystem(new CombatSystem(arena));
    await em.addSystem(pickups);
    await em.addSystem(new BotSystem(...));
    await em.addSystem(new WorldEffectSystem(...));
} else {
    ...the net systems...
}
```

**Each of those five single-player systems is a simulation pass with a presentation pass welded to
it**, and the branch drops them whole. Everything the host owns goes -- correctly -- and everything
that is merely *drawing what the host owns* goes with it, silently, because nothing names the
difference. This is the third time: GAP-046 was the missile models, D-197 was `Effects.update`, and
this is the remaining three at once.

- **Doors, plats and buttons did nothing.** `WorldEffectSystem` is what runs `MoverSystem` and
  `MoversView`, and it also applies teleports, pushes and damage to the player -- which are the
  host's. So the pass was dropped rather than split, and `main.ts`'s own comment saying movers are
  "simulated locally for now" described something that was not happening. `WorldEffects` gains
  `applyPresentation`: box, `movers.update`, `touchButtons`, and **nothing applied to the player** --
  no carry (the host does not carry either, and a client that did would invent motion the host never
  made) and no settle. Both peers then run the same movers from the same map a frame or so apart,
  which is enough for a door to open when the host's does, because the button that starts it is
  pressed on both sides by the same player standing in the same place.
- **Every pickup on the map was invisible.** `ItemsView.update` is not only the bob and the spin: it
  writes each piece's transform and adds and removes the `ShadedGeometry` as `present` moves. Nothing
  called it -- `PickupSystem` does, in single-player -- so the models were never placed and never
  shown, while the *sound* played, because that had just been fixed (D-197). "I hear pickups and see
  none" is exactly what those two facts predict.
- **The player heard everybody's footsteps except their own.** The only footstep call sites were
  `PlayerSystem`, which is single-player's, and `NetPresentationSystem`, which is remote players'.
  A joined client therefore had the set exactly inverted. `BodySounds` is the shared half --
  footsteps, landing, weapon click, all edge detectors over `ps.bobCycle` -- and both branches drive
  it. It reads as a spatialisation fault because four bots' strides with none of your own is what
  spatialisation failing sounds like.
- **Hitscan tracers bent away from the direction of travel** to reach a decal behind the player.
  `Arena.hitscanTrail` offers the local player's beam to `ViewWeapon`, which anchors the near end at
  the barrel *being drawn this frame* -- blended eye, live angles, bob, kick, sway. That is strictly
  the better answer in single-player, where the shot happened on the frame being drawn (D-164), and
  it is the wrong one for an event that is a round trip old: the far end is where the shot landed
  100 ms ago and the near end is where the gun is now, so the line hinges. Both ends now come from
  the same host frame. It sits slightly behind the gun, which is the honest picture of a shot
  resolved somewhere else.

**And the fifth was not a prediction fault, which is what it looked like.** A player walking in a
straight line jittered. `NetClientSystem` called `player.updatePresentation` once per *engine* fixed
update, outside the session loop, and the docblock argued for it: the view kick and the weapon rack
are wall-clock things no rollback may undo. That argument is about rollback and is still satisfied --
the call sits after `client.step()` returns. What it got wrong is the rate.

`updatePresentation` ends in `recordView`, which maintains the **two-entry** eye-pose history the
camera is blended between: copy `latest` down to `previous`, recompute `latest` from `ps`. The pair
means something only if exactly one simulation step separates them, which is what single-player gets
for free from `update()` -- advance clock, step, present, in one call. At a 30 Hz session on a 60 Hz
fixed step the old placement recorded **two poses per step**: one spanning a real 33 ms of motion and
one spanning nothing at all, because `ps` had not moved. The camera blended half its frames across a
doubled interval and half across a frozen one. That is a 30 Hz stutter, and a stutter that scales
with speed is indistinguishable from rubber-banding by eye.

One tick per step now, with the **session's** period rather than the engine's -- the clock inside is
integer Q3 milliseconds, and handing it 16.67 ms while stepping at 33.3 would run the view kick, the
stair detector and the rack countdown at half speed, which is the failure this would otherwise trade
for the one it fixes.

**A test had to be un-pinned to do it**, which is the entry's other half. `net-clock.test.ts`
asserted `presented === calls` -- once per engine frame -- because that is what the code did and what
the design intended when it was written. It is now `presented === steps` plus a check that the
elapsed presentation seconds match real seconds, so the two ways of getting the rate wrong are both
covered. A test that pins the intent of the day is a test that will argue with the fix.

**One landmine closed on the way past.** `applyPresentation` runs the trigger tests, so a caller that
wired `MoverEvents` normally would queue a teleport, a push and a damage on every frame and never
settle -- leaving a pending teleport for whatever settles next and growing `hurtPending` without
bound. It drops them itself rather than trusting how it was wired. `main.ts` also drops them, at the
callback, and for a different reason: a teleport and a pad make a *noise*, and that noise arrives
from the host as an `EffectEvent` (D-197), so playing the local copy would play it twice.

Measured: `movers.test.ts` gains three cases -- both trigger tests run in `G_RunFrame`'s order
against the player's own posture-dependent box, none of the three writes reaches the player, and a
later settle finds an empty queue. `npm run check` is green at 1,171 tests.

**What is still open, and named rather than left to be found.** The local player's own muzzle flash
and trail still arrive from the host rather than being predicted, so both are a round trip late;
`ClientHooks.predictedFire` is the seam and nothing subscribes to it. That is what Q3 predicts with
`CG_FireWeapon`, and it is the next piece of step 6 rather than part of this one.

### D-201: the muzzle flash is predicted, which is the half of a shot a client can know

D-200 left one thing named: the local player's own flash arrived from the host and was therefore a
round trip late. `ClientHooks.predictedFire` had been the seam for it since step 3 and nothing had
ever subscribed.

**Q3 draws the line in exactly one place and this follows it.** `EV_FIRE_WEAPON` is a *predictable*
event -- the flash, the fire sound and the gun's animation are the client's, on the frame the trigger
was pulled -- and everything about where the shot *landed* is a server event: `EV_BULLET_HIT_WALL`,
`EV_RAILTRAIL`, the damage. That is not a stylistic choice on Q3's part and it is not one here
either: a hitscan is resolved against where the host has everyone **now**, and a client that traced
it locally would be answering a different question with the same weapon. So the flash is predicted
and the trail, the impact and the damage stay events.

**One copy of `CalcMuzzlePoint`.** The flash has a place -- fourteen units forward of the eye along
the shooter's forward -- and until now that sentence lived inside `WeaponSystem.fire`. Two peers
computing it separately is two chances to disagree, and the symptom of disagreeing is a flash that
*jumps* at the moment the authoritative one would have landed, which is a worse artefact than the
lateness being fixed. It is `calcMuzzlePoint` now, exported, and both callers use it.

**And the host's copy of the same shot is dropped rather than drawn on top.** `NetTransients` takes
`predictsOwnFlash`, false by default: a client that has not subscribed to `predictedFire` has drawn
nothing and must still present the wire's flash, and one that has must not present it twice. The
dropped arrivals are *counted* (`ownFlashesPredicted`) rather than silently skipped, because the
arrival ledger in `net-effects.test.ts` is an equality and a silent drop would break it -- and
because "arrived, and was already on screen" is a number worth being able to read.

**Measured, and the measurement had to be re-stated once.** Over 1,200 frames of a client holding the
trigger: **230 of the host's 230 muzzle flashes are at a muzzle this client had already computed, to
0.000 units.** Exact rather than close, which is what sharing the rule buys.

The first version of that test paired the two lists *by index* and reported a median gap of 32 units
with one pair in 230 exact. Thirty-two units is one shot's worth of running at 320 u/s, which is the
shape of an off-by-one rather than of a disagreement -- and it was: the client predicts one shot at
the join that the host never raises, so everything after it is paired with its neighbour. Fixed by
matching on *position* rather than on index, which is also the honest form of the claim ("the host's
flash is at a muzzle I predicted") and cannot be broken by that offset changing. The unconfirmed
prediction is bounded and reported rather than hidden: a predicted event that turns out not to have
happened is what every predicting shooter pays, and Q3 pays it too.

**What is still late, and deliberately.** The hitscan trail and the impact mark are the host's and
arrive a round trip after the flash. That is Q3's arrangement and it no longer looks wrong, because
D-200 stopped the trail hinging off the drawn barrel: both of its ends now come from the same host
frame, so it is a straight line slightly behind the gun rather than one that bends away from the
direction of travel.

### D-202: the camera's other clock, the host's missing collision, and the tracer's second end

Three more from the same browser session, and the first two are both **my own previous fix, half
applied**.

**The camera still juddered, and D-200 had made it worse rather than better.** That entry moved the
eye-pose recording from once per engine frame to once per session step, which is right: the pair
`recordView` keeps only means something if exactly one simulation step separates them. What it did
not move is the *blend*. `ViewSystem` interpolates the pair with
`EntityManager.getFixedStepAlpha()`, which sweeps 0 to 1 over one **engine** step -- half a session
period at the shipping rates. So the camera ran the whole move in the first half of the interval and
then ran it again in the second. Before D-200 it was the mirror image: poses at the engine's rate,
half of them identical, so the camera moved for one step and froze for the next. Both are a 30 Hz
judder and both look like being rubber-banded a frame.

`NetClientSystem.alpha` is the fraction the poses actually span: whole unspent periods from the
accumulator, plus the part-step the engine is currently inside, over the session period. The second
term is not a refinement -- without it the alpha changes 60 times a second on a 144 Hz display and
the camera is a slideshow between engine steps. `ViewSystem` takes it as an option and falls back to
the engine's own on the single-player branch, where the two clocks are the same clock.

**Walking onto the platform on `oa_dm1` dropped the player into the lava**, and that is GAP-041
reaching the point where it hurts. The host has run the movers since D-191 and built no *bodies* for
them, because `HeadlessPhysics` builds BSP model 0 alone; a `func_door` there stops nobody. That was
invisible for as long as the mover did not move on a client's screen either -- and D-200 made it
move, so the platform extended, invited a player on and the authority dropped them through itself.

The comment that kept model 0 alone said why: models 1..n "are brush entities whose positions are
owned by a mover simulation the harness has never had". **True when it was written and retired by
D-191.** `HeadlessPhysics.addMover` now builds them, through the same `hullShape` and as the same
`KinematicVelocity` bodies `PhysicsWorld.addMover` does, and `Host.worldStep` writes each mover's
origin into them every frame -- which is `MoversView.update` minus the half that draws. It is
**opt-in**, because the divergence harness still has no movers and brush entities at their authored
positions there is exactly the D-036 failure the old comment warns about.

**And the tracer, which the last attempt did not fix and made honest instead.** A beam has two
visible ends, and over a wire they cannot both be right: offered to the view weapon the near end is
the barrel drawn *this* frame and the far end is a round trip old, so the line hinges away from the
direction of travel; drawn in the world both ends agree and the line floats fourteen units in front
of the eye attached to nothing, because `CalcMuzzlePoint` is not where the gun is drawn (D-164). The
second is what D-200 shipped and what was reported back as "they don't even attempt to attach to the
muzzle now". There is no third answer that keeps a stale far end.

So the local tracer is predicted, alongside the flash D-201 predicts, and the host's copy is dropped
with it. `WeaponSystem.traceShot` is the "where does it stop" half of `hitscanShot`, extracted and
made public: the same clipmap trace and the same broadphase query, against this client's own world --
which holds every other player's replicated body, so a predicted shot stops on the person it hit
rather than the wall behind them. **Down the aim rather than into the spread cone**, because the
host draws each pellet from a seeded generator this client does not have: a predicted spread would
be a *different* random cone, and the one thing a player can check a tracer against is the
crosshair. Q3's tracers are drawn from the predicted state and do not match the server's dispersion
either. It costs the machinegun and the chaingun a few units between where the line stops and where
the host's impact mark lands, at the far end of a room.

**Three fixtures had to be thrown away before one of them measured anything**, all on the plat, and
the pattern is worth the space because it is the same one four times over now:

1. *Stand a player on the top face and assert they do not fall.* Passed **without the fix** -- what
   caught them was the world floor underneath, which is solid either way.
2. *Sweep down onto the top face.* The face is recessed **below** that floor, so the sweep began
   inside the level and reported a hit at fraction zero from the wrong thing entirely.
3. *Lift the mover by hand and sweep at its new face.* `worldStep` advances the mover state machine
   before it writes the bodies, so the hand-set origin was overwritten in the same frame. This one
   at least failed loudly.

What works is a **control**: move the body somewhere the test first proves is empty, then ask again.
The second sweep can only be answered by the thing that was moved. It also caught a property worth
knowing -- the collision follows on the *next step*, because `setOffset` writes a `Transform` and the
broadphase learns about it when the simulation next runs. The browser and the host have the same
one-step relationship.

Reverted, the host wiring fails on `moverBodyCount`, which is zero for the host that shipped
yesterday and six on `oa_dm1` today.

### D-203: `?trace=clipmap` comes out, and two of the three reasons for the ported trace do not survive review

The maintainer, on reading `HeadlessPhysics`: *"why is it using BSP? We have a perfectly serviceable
physics engine that's 100% capable of running on node.js"*. Three things came out of answering that,
and only one of them was a defence.

**The premise about `HeadlessPhysics` was wrong and the question underneath it was not.** That class
*is* meep's physics -- `PhysicsSystem` and `ColliderObserverSystem` on an `EntityManager`, bodies
with `Collider` and `ConvexHullShape3D`, queries through `shape_cast` -- and "headless" means no
renderer. The BSP is where the collision *geometry* comes from, because that is where a Quake III
level keeps it: convex brushes in a lump, with the render meshes being triangle soup that is neither
solid nor closed. `buildHulls` is a loader.

**What the question did find** is that `PhysicsWorld` and `HeadlessPhysics` are two classes doing one
job -- `create`, `trace`, `traceIgnores`, `addMover`, plus `addStaticModel` on one and `step` and
`pointContents` on the other -- and that D-202 widened the duplication rather than closing it by
writing `addMover` twice. They already share `buildHulls`, `buildPatchHulls`, `hullShape`,
`PhysicsTrace` and `layerForContents`; `HeadlessPhysics`' own docblock says what is left is "which
brushes each is handed... a property of the caller rather than of the conversion", and that is now a
parameter on both. The only thing that looked like an obstacle, `addAcousticBody`, returns false when
`AcousticBody` is not a registered component type -- which its own comment names as the headless case.

**`?trace=clipmap` is deleted**, and the maintainer's objection is the right one: a query parameter
that swaps the collision backend of the *shipping build* is a third code path nobody shipping ever
selects. Everything it was for is a test. `pmove.diff.test.ts` runs the ported movement against the C
oracle and `physics-divergence.test.ts` runs the two backends against each other, both without a
browser; what the flag added was the ability to look at the difference through a window, at the price
of `usePortedPmove` having two meanings, `clipmapOnly` threading through to the HUD's backend string,
and a patch-count warning that had to explain which trace you were on. All four are gone. `?move=q3`
stays: it selects the *reference implementation* the port is judged against, which is a different
thing from a second collision backend, and it runs on meep's trace like everything else.

**On the two technical objections, one lands and one does not**, and the distinction is worth keeping
because it decides what the remaining work is.

*"Contents queries via hulls -- there's the `Collider`, run checks off it."* **Right.** The hitscan
path calls the ported `boxTrace` to read `SURF_NOIMPACT`, and the justification written in
`traceShot` -- "a broadphase has no opinion about it" -- is too glib. `layerForContents` already puts
a brush's contents on the body as a layer, and `PhysicsTrace.register` already keeps the `BrushHull`
beside each body id, so a `shape_cast` hit can be resolved to its brush today. The real obstacle is
narrower and is about *sides*: `SURF_NOIMPACT` is per brush **side**, read from
`cm.sideSurfaceFlags[leadside]`, and `BrushHull.surfaceFlags` is deliberately zero for a brush hull
because "a single per-hull value would be the wrong answer for five of a box's six faces". A cast
returns a body and a normal, so the missing step is matching that normal against the hull's own
`planes` to pick the side -- which is a thing this port already does elsewhere, in
`traceBrushList`. So it is one lookup away rather than blocked, and the comment claiming otherwise is
now wrong in the file.

*"`shape_cast` does have a filter -- if you need a hull list the design is flawed."* **The filter is
real and does not reach this.** It chooses which bodies are candidates; GAP-019 is a disagreement
about the *answer for a candidate both agree on*. Its worked example is one brush, seven thousandths
of a unit from the swept box and moving into it: `shape_cast` reports a hit, and
`CM_TraceThroughBrush`'s signed-interval test with its ±1/8 unit epsilon reports `enterFrac(0) <
leaveFrac(-0.078)`, false, "does not block". No predicate over candidates can change a narrowphase
fraction.

**But the conclusion lands anyway, and GAP-019 had already conceded it**: that entry says the rule is
"a constraint this port chose to honour", that it is "no longer load-bearing for this port at all"
since D-071 put the shipping player on `KinematicMover`, and that the machinery "survives only for
`?trace=clipmap` and the divergence harness". One of those two is now gone. What is left of the
hull cross-check is a reference path and its test, which is exactly where a bit-for-bit
reimplementation of somebody else's arithmetic belongs.

### D-204: the surface flags go on the body, and the shape_cast filter was being thrown away

The maintainer, on D-203's defence of the ported trace: *"If what you want is not to spawn surface
impacts on some things -- just don't do it. SURF_NOIMPACT is a solution to the fact that Q3 had no
proper modern physics engine, meep does. Have a component per RigidBody entity that carries all the
flags you need."* Correct, and the shape of the mistake is worth naming: I had taken Q3's *mechanism*
as the requirement. The requirement is "a bullet does not mark the sky". Q3 answers it inside the
collision trace because its trace is a brush walk; a port whose bodies are entities can answer it off
the entity, and this one had been reading the fact back out of the source format instead of
attaching it to the thing it built.

**`SurfaceMetadata` is that component.** It rides beside `RigidBody` and `Collider` on every body
built from level geometry, in both worlds, and carries the brush's contents, its planes, and its
flags **per face**. Anything holding a cast result can ask it; nothing downstream has to know a BSP
was involved.

**Per face, because that was free and I had claimed it was impossible.** `brushHull.ts` shipped
`surfaceFlags: 0` for every brush hull under a comment saying the flags "cannot be carried here"
since they are per side. The loop that would carry them was three lines above the comment: it already
walks the brush's sides in `firstSide` order, which is exactly how `cm.sideSurfaceFlags` is indexed.
Measured on `oa_dm1`: 575 brush hulls, **360 faces carrying flags, 66 brushes whose faces disagree
with each other, 12 distinct values**. All of it was being discarded.

`PhysicsTrace` now fills `TraceResult.surfaceFlags` from the face the sweep entered -- the plane it
has already chosen -- so every meep trace in the port reports what Q3's does. Measured: **74 of 74**
sweeps onto a flagged face report identical flags to the ported `cm_trace`, where before the physics
trace reported a flat zero for every surface in the game.

**And the filter objection from D-203 turned out to be load-bearing after all.** That entry said
`shape_cast`'s predicate "chooses which bodies are candidates" and could not fix GAP-019's fraction
disagreement -- true, and it stopped there. `PhysicsTrace.trace` took a `_contentMask` and **dropped
it**: the bodies are pre-filtered to `MASK_PLAYERSOLID` at load, so every caller got that mask
whatever it asked for. Harmless while the only callers were movement, which asks for exactly that,
and a real bug for anything else -- an item dropping with `CONTENTS_SOLID` landed on
`CONTENTS_PLAYERCLIP` brushes it should have fallen through. The predicate is where that belongs and
is now where it is.

**Found by a test disagreeing on one case in seventy-four**, which is the part worth keeping. The
sweep comparison came back 73/74; the instinct was to widen the tolerance until it passed, and
excluding contacts that land on a *seam* between two faces -- a real ambiguity, since Q3 picks the
plane with the largest entering fraction and this picks the most aligned -- removed fourteen cases
and not that one. Printing it showed a brush whose six faces all carry 19632
(`NONSOLID|NODRAW|NOLIGHTMAP|POINTLIGHT|NOMARKS|NOIMPACT`), which the two traces disagreed about
*hitting* rather than about naming. That is the dropped mask, and a tolerance would have buried it.

**What is not done, and why it is now a different argument.** The shot path still traces the ported
ray. Routing it through the physics world was written and reverted in the same session: it changes
hitscan contact fractions and puts the bots' line of sight back on `shape_cast`, which D-159
deliberately moved off it (a six-bot match went 185 µs a frame to 113, and the shipping path to zero
`PhysicsTrace` calls). GAP-019 puts one ported ray at 0.29 µs against 3.72 µs. That is a measured
performance trade to make deliberately, not a capability claim -- and the capability claim, which is
what D-203 was still leaning on, is gone.

**Two fixtures moved because the game did, and neither was tuned.**

- `net-latency`'s worst link lost **fifteen events before and fifteen after**; the match produced 300
  where it had produced 302, and the ratio went from 4.97% to exactly 5.00% against a `< 0.05` bound.
  A bound a two-event denominator change can cross is not measuring what its comment says ("here to
  catch a regression to 41%, not to bless the residual"), so it is stated against that: a tenth.
- `net-match` compared each client's board against the host's *at the instant the window ended*, and
  leaned on a second assertion that the host passed through exactly one board in that window. With
  six fighters scoring every second or two that is luck, and it ran out. Its failure message says
  "lengthen it", which is backwards -- a longer tail catches *more* frags. The file's own prose two
  paragraphs above already described the property that is actually true: a client holds a board the
  host **really had**. That is what it asserts now, the window supplies the set, and where the host
  does hold still it is exactly the old assertion.
