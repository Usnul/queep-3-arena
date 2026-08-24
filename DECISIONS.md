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
