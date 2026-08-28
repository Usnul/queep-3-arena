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

**What is not claimed.** `LIGHTMAP_MEMORY_BUDGET` is 8 MB rather than the engine's 16 because of one
map: `am_thornish` does not converge, and at the 32 MB this was first set to it reached 601,000
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
