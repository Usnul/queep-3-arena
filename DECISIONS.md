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

`cm_patch.c` is 1,763 lines that turn `MST_PATCH` surfaces into collision hulls. It is deferred,
and the deferral is contained rather than hidden:

- `ClipMap` counts `numPatches` for every map it loads, so a caller can tell whether a given
  level is affected.
- The differential test runs only on maps with **zero** patches — 25 of the 72 in the OA set —
  so the gap cannot mask a divergence in what *is* ported. `oa_dm1`, `aggressor`, `oa_dm2`,
  `q3dm6ish` and `islanddm` are the five it uses, spanning 449 to 9,384 brushes.

Consequence while it is missing: on a patch-bearing map, curved surfaces are not solid. That is
a real gap and it is why the deferral is recorded here rather than treated as done.

### D-018: Capsule tracing is not ported

`CM_BoxTrace`'s `capsule` parameter and the `CM_Trace*Capsule*` family are unported. Every call
in OpenArena's movement path passes `qfalse`; capsules exist for player-vs-player clipping in
ioquake3, which is server-side entity code this port replaces with meep's BVH anyway
(`trap_EntitiesInBox` in the matrix). Porting ~400 lines of dead code to have it agree with an
oracle that never exercises it is not worth the reading burden on `trace.ts`.

### D-019: The port reproduces the C's float32 rounding, rather than tolerating divergence

`cm_trace.c` computes in `float`. JavaScript computes in `float64`, which is *more* precise —
and that is a problem, not a benefit, because the trace's decisions are exact comparisons on
near-cancelling quantities (`d1 > 0 && d2 >= d1`, `enterFrac < leaveFrac`, `t1 >= offset + 1`).
Being more precise than the oracle produces a *different* answer, not a better one.

Measured: 4,000 randomised player-sized sweeps against `oa_dm1` in double precision produced 2
divergences — one a 1.4e-5 fraction difference, one a grazing contact the port missed entirely
because a tie broke the other way.

So `src/q3/cm/trace.ts` wraps every arithmetic step in `Math.fround`, and `dot3` reproduces
`DotProduct`'s left-to-right association exactly. `Math.fround` compiles to a single machine
instruction under V8, so the runtime cost is negligible; the cost is readability, paid down with
a block comment explaining why.

The payoff is that the differential test can demand **exact** equality. A tolerance would have
hidden precisely the class of bug this exercise exists to catch — and did: see D-020.

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
meep physics - and reports how far the third drifts from the first. Because the second is
bit-exact, any divergence in the third is attributable to the collision backend and nothing
else. The clipmap backend still ships behind `?trace=clipmap` so an A/B is a refresh rather than
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

### D-032: `cm_trace` stays, and stays bit-exact

The ported clipmap is not dead code. It is:

- the **reference** the physics backend is measured against, and the reason any divergence can
  be attributed to the backend rather than to the port;
- the source of **`CONTENTS_*` queries** - water, lava, slime, teleporters. Those are Q3
  semantics, not collision, and a physics engine has no opinion on whether a volume is slime;
- the **contact plane oracle** - `PhysicsWorld` re-derives normals using the same rule, against
  the same brush planes;
- a **shipping A/B**, behind `?trace=clipmap`.

Its differential suites still demand bit-exactness and still pass.

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

Copied rather than transcoded: OA's WAVs are PCM, every browser decodes them through
`decodeAudioData`, and re-encoding would trade a real quality loss against a saving on assets that
are not committed anyway.

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
is a reference it could be calibrated per map. Not done: it would re-light the three maps the
demo presents, which is a larger change than this one and belongs in its own.

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
