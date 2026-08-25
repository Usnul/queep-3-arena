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

This produces between 13 and 147 dynamic lights per map from real map data. It is a deviation
from Q3's appearance and it is the deviation the brief asks for: it is the version that shows
what the engine does. The performance answer is in the report — light count did not register.

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
modes this port does not have. `convert-sounds.ts` copies the 58 files something in the port
actually triggers -- 3.3 MB -- and the manifest records anything named by the code and absent from
disk, because that is a bug, while a file on disk that nothing names is not.

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
