# Engineering report: porting Quake III / OpenArena onto meep

**Audience:** meep's maintainer. Everything here is meant to become a backlog item or be
consciously rejected.

**Method:** this document was appended to as the work happened rather than reconstructed
afterwards, and where something cost real time the time is stated. Entries say which phase they
were written in, so a claim that has since been overtaken can be dated — and several have been.
Where a later phase contradicted an earlier entry, the earlier one is kept with the correction
attached rather than quietly edited, because how a wrong conclusion was reached is usually the
part a maintainer can act on. GAP-006, GAP-007 and GAP-016 are the three worth reading for that
reason alone.

Two parts of this report were *not* written continuously and were re-derived from scratch in
phase 6: the executive summary, because two findings arrived late that outranked everything above
them, and the `trap_` coverage matrix, because auditing it against the shipping code showed that
maintaining it by editing notes had let it describe a plan rather than a build. Section 2 lists
what moved and D-067 explains why the check that was supposed to prevent that did not.

**Engine under test:** `@woosh/meep-engine`, consumed from npm as a peer dependency, unmodified.
Phases 0-6 ran against **3.0.2**; the port moved to **3.2.0** when BUG-7 was fixed there, and
every measurement that changed as a result has been re-taken and labelled with its version. No patching, no forking, no monkey-patching — where the engine did not do what
the port needed, the port worked around it and the workaround is written down here.

---

## 1. Executive summary

Ranked by how much they would cost the next person, not by how much they cost me.

**Re-ranked from scratch in phase 6, corrected after review, and then overtaken by a change of
direction.** Both corrections are worth stating before the list rather than after it.

The phase 6 ranking put "building a character controller on `shape_cast`" first, on the strength
of GAP-019 and GAP-020. That was wrong: meep ships `KinematicMover`, a kinematic character solver
with a `skin` standoff, a public `compute_penetration` depenetration step, Quake-lineage crease
handling and a 365-line design document — and I never opened it, because in phase 2 I had
evaluated the *controller* it sits beside, correctly rejected that, and let the rejection cover
the directory. GAP-020 is withdrawn; GAP-019 shrank to a Q3-fidelity constraint. GAP-021 is the
correction.

The maintainer then reversed the brief's central constraint: **port Q3 in spirit, not in body**,
and where Q3's exact movement semantics cannot be had inside the physics engine, change the
semantics to meep's. So the port's movement now runs Q3's *motor* -- `PM_Accelerate` and the
friction and command-scale functions around it, which is where strafe jumping actually lives -- on
`KinematicMover`, and `PM_SlideMove`, `PM_StepSlideMove` and `PM_GroundTrace` are retired
(D-071). GAP-012 and GAP-019 are no longer things this port needs; they are recorded as what it
cost to have believed otherwise. Item 4 below is what that change found in half an hour, and it is
the strongest argument in this report for the maintainer's instinct over mine.

1. **Getting from `npm install` to a rendered frame took about 2.5 hours, and none of it was
   spent on graphics.** The cheapest item on this list to fix and the only one that hits 100% of
   consumers on day one. The engine itself came up cleanly and rendered at 230 FPS on the first frame it drew. The time
   went to integration defects a consumer hits in a fixed order and cannot skip: an optional peer
   dependency that is a mandatory top-level import in the de-facto entry point (BUG-2), worker
   bundles addressed at a web-root path no application has and with no parameter to correct it
   (BUG-4), and a missing `./package.json` export that breaks the standard way of locating a
   package root (BUG-3). Each is individually a one-line fix. Together they are the entire
   first-run experience.

2. **A whole layer can be missed because of a decision about the layer next to it, and the
   package's own naming makes that easy.** This one cost this port about six hours and two wrong
   fixes, and most of the blame is mine — but the part that is not is cheap to fix and would stop
   it happening to the next person. meep ships `KinematicMover`: 635 lines of kinematic character
   solver, controller-agnostic by its own docblock and by its imports, with a `skin` standoff, a
   `compute_penetration` recover step, Quake-lineage crease handling (`MAX_CLIP_PLANES = 5`,
   `numbumps 4`, `MIN_WALK_NORMAL 0.7`), and a 365-line `DESIGN_COLLISION.md` beside it setting
   out the whole recover → slide → stairs → ground → settle sequence with a referenced constants
   table.

   It lives at `engine/control/first-person/collision/`. In phase 2 I evaluated
   `FirstPersonPlayerController`, correctly concluded a feel-first opinionated controller cannot
   host `bg_pmove` (GAP-009), wrote that up — *naming `KinematicMover` in the same paragraph* —
   and treated the directory as decided. Two phases later I filed its capabilities as absent from
   the engine, in what became GAP-019 and GAP-020. GAP-020 is now withdrawn outright; GAP-019 is
   a Q3-fidelity constraint rather than an engine gap.

   The engine-facing ask is one directory move plus a re-export: a solver that depends on nothing
   in the controller should not be namespaced inside it, and the most useful collision document
   in the package should not be filed under the one component a reader may already have ruled
   out. `engine/physics/character/` would have been found. See GAP-021.


3. **Four APIs accept a wrong-but-plausible call, do nothing, and report success at every
   diagnostic you reach for.** Roughly four hours in total, spread so thinly that none of them
   ever looked like the same problem twice — which is exactly why they belong together.

   - `PhysicsSystem` links `(RigidBody, Transform)`; attaching the *collider* is a separate
     `ColliderObserverSystem` the consumer must also register. Register only the first and every
     body is real, present in the broadphase, and completely intangible — 537 static bodies at
     the time it was measured, 529 in the current build — and
     `fraction === 1` for a sweep from a metre above a floor to 128 m below it, with nothing in
     the console (GAP-014).
   - `new Animation({ clips })` documents `List<AnimationClip>`, forwards to `fromJSON`, and
     rebuilds each entry by reading `json.name` only `if (typeof json.name === "string")` — which
     an `ObservedString` is not. The model loads, both skins are there, the list is the right
     length, every clip is an `AnimationClip`, every name is `""`, and nothing ever plays (BUG-1).
   - meep builds its pointer and keyboard devices on `viewStack.el` and starts them — but that
     element and everything under it are `pointer-events: none`, so no pointer event reaches the
     device, and although it carries `tabindex="0"` nothing focuses it, so key events go to
     `<body>`. The application renders at 160 FPS and cannot be played, which looks exactly like
     an application with no input code at all (GAP-017).
   - A scene with no environment map renders black. `make_default_environment` documents this
     well, but you only read that docblock if you already suspect the environment, and
     `EngineHarness.buildBasics` sets one up for you — so it bites at the moment you stop using
     the all-or-nothing helper, which is the moment you stop being a beginner.

   Every one of these is a first-use warning or a `@see`. The pattern is worth naming as a class:
   *the engine is very good at loud, specific failures* (section 7) *and has no story at all for
   silent ones.*

4. **A real engine bug, found by adopting the engine's own solver rather than reimplementing
   around it -- reported, fixed in 3.2.0, and confirmed.** `raycast` reported an immediate hit for
   a ray starting inside a convex hull's bounding box but outside the hull, where `overlap` at the
   same point correctly returned nothing. Twenty lines to reproduce, no map data, in BUG-7.

   `KinematicMover._categorizeGround` decides "am I standing on something walkable" with a centre
   raycast from `stepHeight` above the feet, and treats a steep normal there as a slope to slide
   down. Above any brush that does not fill its bounding box -- in a Quake III level, every wedge,
   ramp and cut corner -- that probe answered "inside, facing down", so the player rested on the
   surface and was never grounded, and jump, animation, footsteps and ground-stick were all wrong
   downstream. On `aggressor` it left bots grounded 51.6% of a match and stuck 23.3% of it, firing
   10 shots against the ported path's 420. On 3.2.0 the same match is 89.4% grounded, 4.4% stuck
   and 220 shots, and the false-hit rate across three levels is 0.0% where it was up to 10.4%.

   It is ranked here because of *how* it was found, which is the most useful methodological point
   in this report. Three sessions of building character movement directly on `shape_cast` and
   `overlap_shape` found no engine bug at all -- the workaround was carefully routing around the
   code path the bug lives in. Half an hour of running the engine's own solver found it. **A
   consumer who reimplements rather than adopts stops being able to find your bugs**, and the
   value of a port as a bug-finding exercise collapses at exactly the moment it decides to do
   things its own way.

   The upgrade also settled a question this report had left open. D-072 recorded the link between
   the probe failure and the bots' behaviour as a *correlation* and explicitly declined to call it
   a cause. One changed line in the engine moved every number in that table, which is the
   experiment that decides it. Worth noting as a method: when a correlation cannot be untangled
   locally, an upstream fix is a controlled trial, and waiting for one beats guessing.

   The finding it displaced -- `shape_cast` returning the minimum-penetration normal where a
   slide-move wants the plane it entered last (GAP-012) -- is still factual and is still in the
   register, but this port no longer depends on it (D-071) and `KinematicMover` approaches the
   corner case from the other end.


5. **Photometric lighting is the right design and has no guidance, and world scale is silently
   load-bearing.** `PointLight.intensity` is candela and falloff is inverse-square in scene units.
   The consequence is undocumented: content authored in any unit other than metres renders black,
   with no diagnostic. Diagnosing it cost about 90 minutes and was actively misleading — raising
   every light's intensity by 10,000× moved mean frame luminance from 14.7 to 25.7, which reads as
   "lights are disconnected", not "your distances are 32× too large" (GAP-005). It then cost a
   further ten minutes at the other end when a physically-plausible 60,000-lumen explosion whited
   out a corridor (GAP-011). A five-row table of reference values — candle, bulb, office ceiling,
   overcast, direct sun — in the lighting docs would have prevented both, and would also be the
   only place that tells a consumer world scale matters.

6. **Generated `.d.ts` files do not typecheck, and it is systematic rather than incidental.**
   664 errors across 152 declaration files on this project's own import surface with
   `skipLibCheck: false`. 533 of them are one mechanical fault — a JSDoc type referenced without
   a matching import in the emitted `.d.ts`, plus JSDoc pseudo-types (`int`, `Class`, bare `T`)
   emitted verbatim as TypeScript identifiers. The consequence is not cosmetic: consumers are
   forced into `skipLibCheck: true`, which is not scoped to one package and disables declaration
   checking for **every** other dependency they have. Two cases go further and reject working
   code: `LabelView` rejects a call its own implementation explicitly supports, and `Collider.shape`
   is typed such that no concrete shape is assignable to it (BUG-5, GAP-001, GAP-013).

7. **Baked lightmaps cannot be imported, only baked — and the workaround succeeds on four of six
   maps and fails on two, unpredictably.** The vertex channel exists, the attribute is literally
   named "used for light map", and there is a whole `shade/renderer/lightmap/` subsystem — but it
   is a *baker*, and no material has a lightmap slot (GAP-006). Every level format that predates
   real-time GI ships baked lighting and none of it can come in. This port's answer was to
   reconstruct the lighting as dynamic lights, which worked well enough that it read as a success
   for five phases. Phase 6 measured it: illuminance at every spawn point and pickup on every
   shipped map, and `oa_dm5` — 107,414 triangles — has **zero** reconstructed lights, while
   `oa_dm7` leaves 70 of 79 player positions under 1 lux. The reconstruction reads
   `q3map_surfacelight` and `q3map_sun`; where a map's lighting came from `light` entities, q3map2
   has already deleted them (measured: zero across all six maps). A gap whose workaround fails
   *unpredictably* is worse than one that fails uniformly, because nothing tells you which content
   it will fail on.

8. **Clustered lighting is as good as advertised, and this port is alive because of it.** 147
   dynamic point lights on a 198k-triangle level cost 7.28 ms of CPU per frame; light count did
   not register against geometry count. That matters more than a benchmark: with lightmaps
   unavailable and every `light` entity stripped at compile time, reconstructing the lighting as
   real dynamic lights was not a showcase choice — it was the only remaining route to a lit level,
   and there was no fallback plan. It worked with no tuning, no batching and no budget management.
   Ranked this high because a maintainer needs to know which properties are load-bearing before
   optimising near them.

9. **The physics engine runs headless, and that property is worth more than any single feature in
   the package.** `PhysicsSystem`, `shape_cast` and `overlap_shape` need no graphics device, no
   `Engine`, no entity manager and no DOM. That is what made a three-way differential harness
   against a WASM oracle possible, and it is why "a real match is playable" is a test — six bots
   for thirty simulated seconds against the shipping collision backend, in Node, in under a second
   — rather than an opinion. Most physics engines cannot be driven this way. Every one of the four
   player-reported bugs in this project's record was, in principle, catchable in CI because of it;
   that they were not is this port's failure and is item 12.

10. **A navmesh needs a surface and a Quake III map is a pile of interpenetrating solids — and the
   engine has more tooling for this than I first credited.** `NavigationMesh` is real and good:
   agent radius, height, step and climb angle in, exact any-angle geodesics out. My first
   conclusion — that nothing in the package could repair arbitrary geometry into something it
   would accept — was **wrong**, and the corrected entry keeps the mistake because it is the
   instructive part. `core/geom/3d/topology` is a full mesh-repair toolkit, and
   `bt_mesh_resolve_t_junctions` documents both this exact failure and the order to call things
   in. What was actually missing was upstream: I was feeding it *volumes*. Extracting the walkable
   *surface* first — using Q3's own `MIN_WALK_NORMAL` and `pointContents`, about forty lines —
   takes spawn-pair routability from 5% to 48% and yields a manifold mesh. The remaining gap is
   real but narrow: welding cannot union overlapping coplanar patches, so the surface stays ~100
   islands, and that needs a boolean union or Recast-style voxelisation, which the package does
   not have. The number worth remembering is the baseline: a waypoint graph built by *tracing*
   routes 100% of the same pairs, because a trace does not care how many surfaces the world is
   made of (GAP-016).

11. **Nothing runnable ships, and no document says which systems you have to register.** The
    published package contains `samples/generation/**` and nothing else — no sample boots the
    engine, loads a model or draws a frame, and `exports` has no `./samples/*` entry so the folder
    cannot be imported even though it is shipped (GAP-002). `EngineHarness` turns out to be the
    real worked example; finding that took reading a directory listing. The higher-value missing
    page is narrower and would fit on one screen: **system → what it needs registered alongside it
    → what breaks silently if you forget.** That table is derivable from the existing constructors
    and would have prevented items 3a and part of 3b outright.

12. **Meshlet construction is synchronous and is 92% of level load time.** 1,246 ms of unbroken
    main-thread work for a 198k-triangle level, in an engine that has an asset streamer, a
    concurrent executor and a worker pool. A real level is several times that size (GAP-008).

13. **Two thirds of Q3's engine surface is netcode, bot AI and 1999 platform plumbing that meep
    correctly does not have — and the honest count of what the engine actually carried is smaller
    than this report used to claim.** Of 309 distinct `trap_*` syscalls, 227 belong to subsystems
    this port deletes outright. Of the rest: **31 map onto a meep facility the port actually
    calls**, 18 map onto one that exists and was never needed (no menus, so no fonts; no 2D HUD
    art, so no image drawing; four settings, so no cvar system), 4 are hybrids where meep does part
    of the job and ported Q3 code does the rest, 7 are ported outright, 22 are worked around, and
    none is left as a bare syscall-level gap.

    Those numbers replace `mapped 77 / ported 19 / workaround 9 / GAP 1 / not needed 203`, and
    every one of the old ones was wrong in the same direction for the same reason: a note is free
    to describe an *intended* design and reads exactly like one describing a shipped one. The
    matrix now requires every disposition claiming shipped code to cite `path::token` in this
    repository, and `--check` fails if the file or the token is gone. Section 2 lists what moved.

14. **Replacing something that maintained state as a side effect drops the bookkeeping, not the
    behaviour -- twice, and the second one was player-reported.** Swapping `PmoveSingle` for a
    meep-native mover took the movement across and left two `playerState_t` fields behind:
    `ps.groundEntityNum`, written with Q3's two sentinels inverted so that everything asking "am I
    on the ground" received the opposite of the truth; and `ps.viewangles`, never written at all,
    because `PM_UpdateViewAngles` is the first thing `PmoveSingle` does and the replacement did
    not do it. The second froze the camera, the aim and the direction of travel at once -- the
    player could not aim with the mouse, and holding forward always walked the same way through
    the world however you turned.

    Neither was caught, for the same reason both times: the tests drove the *solver* and read the
    solver's own state, and the bots read their own yaw rather than the player's, so bots aimed
    correctly while the player could not. The seam between solver and game had no test, and a seam
    is exactly where a replacement drops things.

    The fix in both cases was structural rather than a restored line -- move the responsibility
    into the bridge instead of leaving it split across callers, which is why the two callers had
    diverged and why one of them was wrong -- plus a parity suite comparing the two paths on the
    `playerState_t` **fields** rather than on behaviour, which is deliberately different now. That
    suite is only possible because the ported `bg_pmove` is still in the tree and still bit-exact
    against the C; retiring it entirely would have removed the only oracle for this class of bug.
    Verified to catch it: removing the fix fails three of the five new tests. D-072, D-074.


15. **The measurement was good and the summary statistic was wrong, which is a lesson about
    verification rather than about meep.** The physics backend was signed off at 88% sweep
    agreement with a bit-exact control, and a player was frozen in an open corridor. The
    disagreements were rare and every single one of them was catastrophic rather than small —
    a distribution where the mean and the median tell you nothing useful. Meanwhile phases 4 and 5
    were signed off by *looking at the running application*, which produced two wrong fixes in a
    row from screenshots. Both criteria now run headlessly in Node (`test/presentation.test.ts`,
    `test/match.test.ts`), and writing them immediately found a defect nobody had noticed:
    `am_thornish`, the largest map in the build, has no `info_player_deathmatch` at all, so it had
    been running with zero bots and respawning the player at the world origin.

    The same review that produced this report found the sharper version of the lesson, and it is
    not about measurement at all: **a conclusion about one component was allowed to cover its
    neighbours, three times.** A stale docblock cost double-sided surfaces (GAP-007). A wrong
    reading of `NavigationMesh` cost two rounds of analysis before the corrected entry (GAP-016).
    Rejecting `FirstPersonPlayerController` cost the six hours in item 2, because the directory it
    lives in also contains the solver (GAP-021). Every one of those was a decision to stop reading,
    and none of them was flagged by any test, because they are failures to look rather than
    failures to check.

16. **Smaller things that each cost under an hour and would each cost the next person the same.**
    The camera uses the object convention (+Z forward), documented inside the docblock of a
    function consumers never call — a hand-built view quaternion assuming −Z points the camera
    exactly backwards, which in a closed level presents as *a dark scene* rather than a reversed
    one, and was diagnosed as a lighting problem first. Particle parameter names are string-typed
    and case-trapped (GAP-010), though the error message is excellent. `ShadeMaterial.draw_side`'s
    docblock describes a limitation that no longer exists, and cost this port double-sided
    surfaces for its entire duration because a careful reader believed it (BUG-6). The engine's
    own per-second FPS report goes to `console.warn`, which buried real warnings during the
    diagnosis of item 2.

### What this port did not use, and why

Two meep subsystems were evaluated and not used, for opposite reasons, and a maintainer reading
the gap register should not mistake either for a complaint.

- **`FirstPersonPlayerController`**, for player movement. Its own `DESIGN.md` states its goals as
  "feel alive" and "be configurable"; Q3's movement is neither tuned nor configurable -- it is a
  fixed set of float operations players spent 25 years learning to exploit. This is a
  *positioning* finding, not a defect (GAP-009).
- **`NavigationMesh`**, for bots -- and this one I got wrong twice before getting it right.
  It is the better tool, it is reachable from a Q3 level with a surface-extraction pass the
  engine does not provide, and even then it routes 48% of spawn pairs where a trace-built
  waypoint graph routes 100%, because the extracted surface is still fragmented (GAP-016). The
  decision to ship the waypoint graph stands; the reasoning behind it is now measured rather than
  assumed, and `npm run navmesh-probe` reproduces every number in it.

The physics engine *is* used, for player movement, on the maintainer's instruction and against
an initial recommendation not to. That reversal is documented in D-029 and its results are in
section 5. The short version is that it works -- divergence from the C oracle is zero at the
median on all four input patterns across both measured maps, and the ported control reads
exactly zero in the same run -- and that getting there cost three findings, GAP-012, GAP-019
and GAP-020 — of which GAP-020 has since been withdrawn and GAP-019 substantially reduced, after
review established that the engine ships a kinematic character solver this port never opened
(GAP-021). It also did not let the ported collision code be deleted:
`PhysicsTrace` runs Q3's own per-brush test on the brushes meep finds, so the shipping
configuration is meep's broadphase and sweep in front of Q3's narrowphase rule. That is the
finding, not a footnote to it.

### State of the work

| phase | status | exit criterion, and how it is checked |
|---|---|---|
| 0 — setup | complete | `tsc --noEmit` clean; engine rendering |
| 1 — asset pipeline | complete | 6 maps, 76 props, 15 characters, 97 sound names; `npm run check` |
| 2 — collision and movement | complete | ported `cm_trace` **bit-exact** against a WASM oracle; shipping backend is meep physics measured against it, median divergence now exactly zero (`npm run divergence`) |
| 3 — game simulation | complete | weapons, damage, items, movers, triggers, jump pads, teleporters; 27 unit tests against the OA gamecode's own numbers |
| 4 — presentation | complete, with one measured shortfall | particles, decals, lights, HUD, characters, positional audio; `test/presentation.test.ts` (36 tests) — **the lighting reconstruction fails on 2 of 6 maps**, see item 6 above and GAP-006 |
| 5 — bots | complete, with the cuts in D-055 | behaviour trees on a floor-sampled navigation graph; `test/match.test.ts` runs a 30-second six-bot match headlessly on the shipping backend |
| 6 — report | this document, written continuously; matrix re-derived and exit criteria re-verified in this phase |

**Phases 4 and 5 were re-verified in phase 6**, because both had originally been signed off by
looking at the running application and this project's record with that method is poor (item 13).
Both now have headless tests, both pass, and writing them found two things that were not known:
the lighting shortfall above, and a defect where `am_thornish` — the largest map in the build and
the one every performance number is quoted from — had been running with zero bots, because it is a
Team Arena map with no `info_player_deathmatch` entity for the spawn filter to find.

What is *not* done is listed per phase in `DECISIONS.md` rather than summarised away: patch
collision (D-017), capsule traces (D-018), the weapon state machine (D-022), mover crush and
shootable doors (D-041), smooth skin weights and character LOD (D-045), the bots' missing half —
no jumping to reach anything, no aim prediction, no bot-versus-bot target selection (D-055, now
asserted directly by a test so the claim cannot drift) — and a lightgrid importer that would
close the lighting shortfall (D-069).

The brief said a half-finished demo with an excellent report is a success and the reverse is a
failure. Effort went to the report throughout, and to phase 2, which is the one place the brief
called fidelity non-negotiable.

---

## 2. `trap_` coverage matrix

Q3's gameplay layer reaches the engine only through `trap_*` syscalls, so grepping them
yields a complete, mechanically-derived inventory of what a Q3 port demands from a host
engine. That makes it a decent proxy for "what does a 3D action game actually need".

Regenerate and verify completeness with:

```bash
node tools/trap-matrix.mjs --out REPORT.md
```

The generator fails if the gamecode uses a syscall that
`tools/trap-classification.json` does not classify, so the matrix cannot silently drift out
of date.

**This matrix was re-derived from scratch in phase 6, and it moved a lot.** The version that
stood through phases 1–5 said `mapped 77 / ported 19 / workaround 9 / GAP 1 / not needed 203`.
Every one of those numbers was wrong, in the same direction, for the same reason: a note is
free to describe an *intended* design, and reads exactly like one describing a shipped one.
That was caught first in phase 5, when four sound syscalls turned out to be mapped onto a
component the port had never constructed (D-066), and the rule adopted then — a `mapped` note
must name a call site, because a call site can be checked — is now enforced by the generator
rather than by good intentions. Every disposition that claims something was built cites
`path::token` in this repository, and `--check` fails if the file or the token is gone. The
`where it lives` column is those citations.

The corrections were not cosmetic. `trap_Trace` and `trap_CM_BoxTrace` were `ported`, written
before the physics swap and never revisited; they are now `hybrid`, because the shipping
backend is meep's broadphase and sweep with Q3's per-brush rule behind it and *both* halves are
load-bearing (GAP-019; GAP-020 has since been withdrawn). `trap_R_LightForPoint` was the matrix's only `GAP` and pointed
at a gap-register entry that does not exist; it is not a gap at all, and why is worth reading.
`trap_R_RegisterSkin` and `trap_R_RegisterShader` were `mapped` and are `workaround`s — both
are resolved offline, and runtime skin switching is a capability this port simply does not
have. Nine `trap_Cvar_*` entries claimed `engine/options`, which the port never imported.

**Reading the dispositions:**

- `mapped`, split into **exercised** and **not exercised**. The first means a meep facility
  does the job *and this port calls it*. The second means the facility exists, would plainly do
  the job, and nothing here needed it — no menus, so no fonts; no 2D HUD art, so no image
  drawing; four settings, so no cvar system. The split is the honest form of the claim: 31
  facilities carried this port, and another 18 were available and idle. Reporting them as one
  number of 49 would overstate what has actually been exercised, and reporting only the 31
  would understate what the engine has.
- `hybrid` — a meep facility does part of the job and ported Q3 code does the rest. All four
  are collision, and they are the most informative rows in the table.
- `ported` — reimplemented faithfully in TypeScript and *deliberately not* mapped onto meep.
  What is left here after the `hybrid` reclassification is clipmap *loading* and
  `pointContents`: contents flags are Q3 semantics that no rigid body has, which is why the
  clipmap is still loaded and still queried even on the physics backend.
- `workaround` — no direct facility, or one that did not fit; solved outside the engine, most
  often at asset-build time.
- `GAP` — no reasonable answer. Now empty: see section 3, which is where the real gaps live.
  A syscall-level gap register was always the wrong shape for them, because the expensive gaps
  are not "meep has no equivalent of call X" but "meep's equivalent answers a subtly different
  question".
- `not needed` — the subsystem is out of scope for this port (netcode, botlib/AAS, CD keys,
  cinematics, server browser, the console, capsule traces). Three quarters of the raw syscall
  count is this, which is worth knowing before anyone reads "309 syscalls" as "309 engine
  features".

<!-- BEGIN TRAP MATRIX -->

<!-- GENERATED BY tools/trap-matrix.mjs -- DO NOT EDIT BY HAND -->

Mechanically derived from the OpenArena gamecode at `.refs/oa-gamecode`. **309 distinct `trap_*` symbols** appear across `game/`, `cgame/`, `ui/` and `q3_ui/`. Occurrence counts include the prototype and the syscall-stub definition, so a syscall used once shows a count of 3.

| status | count | meaning |
|---|---:|---|
| `mapped`, exercised | 31 | a meep facility does the job, and this port calls it |
| `mapped`, not exercised | 18 | the facility exists and would do the job; this port never needed it |
| `hybrid` | 4 | a meep facility does part of the job and ported Q3 code does the rest |
| `ported` | 7 | reimplemented faithfully in TypeScript; deliberately *not* mapped onto meep |
| `workaround` | 22 | meep has no direct facility; solved outside the engine |
| `GAP` | 0 | no reasonable answer; see gap register |
| `not needed` | 227 | the whole subsystem is out of scope (netcode, botlib, CD keys, cinematics) |

| Q3 syscall | uses | modules | disposition | meep facility | where it lives | notes |
|---|---:|---|---|---|---|---|
| `trap_AAS_AlternativeRouteGoals` | 10 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaInfo` | 5 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaReachability` | 21 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaTravelTimeToGoalArea` | 16 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_BBoxAreas` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EnableRoutingArea` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EntityInfo` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_FloatForBSPEpairKey` | 6 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Initialized` | 10 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_IntForBSPEpairKey` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_NextBSPEntity` | 12 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointAreaNum` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointContents` | 8 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointReachabilityAreaIndex` | 4 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictClientMovement` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictRoute` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PresenceTypeBoundingBox` | 5 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Swimming` | 5 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Time` | 3 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_TraceAreas` | 7 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_ValueForBSPEpairKey` | 16 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_VectorForBSPEpairKey` | 4 | game | not needed | own trace-built waypoint graph | -- | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AddCommand` | 31 | cgame | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_AdjustAreaPortalState` | 4 | game | not needed | - | -- | As above. |
| `trap_AreasConnected` | 2 | game | not needed | - | -- | Areaportal state only mattered for PVS-driven network scope. |
| `trap_Argc` | 34 | cgame, game, q3_ui, ui | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_Args` | 7 | cgame, game | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_Argv` | 51 | cgame, game, q3_ui, ui | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_BotAddAvoidSpot` | 5 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocChatState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocGoalState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocateClient` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChatLength` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseBestFightWeapon` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseLTGItem` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseNBGItem` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpAvoidGoals` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpGoalStack` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEmptyGoalStack` | 6 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEnterChat` | 103 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFindMatch` | 10 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeChatState` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeClient` | 5 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeGoalState` | 6 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeItemWeights` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeWeaponState` | 5 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetChatMessage` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetLevelItemGoal` | 12 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetMapLocationGoal` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetNextCampSpotGoal` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSecondGoal` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetServerCommand` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSnapshotEntity` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetTopGoal` | 16 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetWeaponInfo` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGoalName` | 24 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitLevelItems` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitialChat` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInterbreedGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotItemGoalInVisButNotVisible` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibDefine` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibLoadMap` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibSetup` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibShutdown` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibStartFrame` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibTest` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibUpdateEntity` | 9 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarGet` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarSet` | 26 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadChatFile` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadItemWeights` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadWeaponWeights` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMatchVariable` | 60 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveInDirection` | 10 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveToGoal` | 9 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMovementViewTarget` | 8 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMutateGoalFuzzyLogic` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNextConsoleMessage` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumConsoleMessages` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumInitialChats` | 32 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPopGoal` | 6 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPredictVisiblePosition` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPushGoal` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotQueueConsoleMessage` | 6 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReachabilityArea` | 2 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveConsoleMessage` | 7 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveFromAvoidGoals` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplaceSynonyms` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplyChat` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidGoals` | 6 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidReach` | 20 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetGoalState` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetLastAvoidReach` | 11 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetMoveState` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSaveGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatGender` | 8 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatName` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotTouchingGoal` | 18 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUpdateEntityItems` | 3 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUserCommand` | 4 | game | not needed | meep behaviour trees + blackboard | -- | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_CIN_DrawCinematic` | 7 | cgame, ui | not needed | - | -- | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_PlayCinematic` | 13 | cgame, ui | not needed | - | -- | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_RunCinematic` | 10 | cgame, ui | not needed | - | -- | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_SetExtents` | 7 | cgame, ui | not needed | - | -- | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_StopCinematic` | 14 | cgame, ui | not needed | - | -- | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CL_UI_RankGetLeauges` | 1 | q3_ui | not needed | - | -- | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserCreate` | 1 | q3_ui | not needed | - | -- | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserLogin` | 1 | q3_ui | not needed | - | -- | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserRequestLogout` | 1 | q3_ui | not needed | - | -- | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CM_BoxTrace` | 10 | cgame | hybrid | PhysicsSystem shape_cast + overlap_shape, in front of the ported CM_TraceThroughBrush | `src/client/PhysicsTrace.ts`<br>`src/q3/cm/trace.ts` | Same clipmap, client side; same hybrid as `trap_Trace`. |
| `trap_CM_CapsuleTrace` | 1 | cgame | not needed | - | -- | OpenArena traces the player as a bounding box -- `CM_BoxTrace` is called with `capsule = qfalse` everywhere in the movement path -- so the capsule branches are dead code for this port and were not ported. See D-018. |
| `trap_CM_InlineModel` | 5 | cgame | ported | - | `src/q3/cm/ClipMap.ts` | Submodel index into the clipmap; both `boxTrace` and `pointContents` take one. |
| `trap_CM_LerpTag` | 7 | q3_ui, ui | mapped | glTF node hierarchy + AnimationSystem3 clip player | `tools/convert-characters.ts` | Game-side spelling of the same call. |
| `trap_CM_LoadMap` | 3 | cgame | ported | - | `src/q3/cm/ClipMap.ts`<br>`src/q3/bsp/BspFile.ts` | cm_load.c ported: planes, nodes, leafs, brushes, brushsides, submodels. Read straight out of the BSP rather than from a converted format, so the runtime, the WASM oracle and the divergence harness all read the same bytes. Patch collision is *not* ported (D-017). |
| `trap_CM_MarkFragments` | 3 | cgame | not needed | DecalSystem3 (GPU decals) | -- | Q3 clips world triangles on the CPU to build mark polygons. Replaced by meep GPU decals per brief section 2. |
| `trap_CM_NumInlineModels` | 3 | cgame | ported | - | `src/q3/cm/ClipMap.ts` | As above. |
| `trap_CM_PointContents` | 5 | cgame | ported | - | `src/q3/cm/trace.ts` | Submodel form of the same call; `pointContents` takes the model index. |
| `trap_CM_TempBoxModel` | 3 | cgame | not needed | - | -- | Q3 wraps a bare AABB in a throwaway clip model so one trace path can handle it. The clipmap backend translates the sweep instead; the physics backend already has a body. |
| `trap_CM_TempCapsuleModel` | 1 | cgame | not needed | - | -- | OpenArena traces the player as a bounding box -- `CM_BoxTrace` is called with `capsule = qfalse` everywhere in the movement path -- so the capsule branches are dead code for this port and were not ported. See D-018. |
| `trap_CM_TransformedBoxTrace` | 3 | cgame | hybrid | kinematic RigidBody found by shape_cast; ported translation on the clipmap backend | `src/q3/cm/entityClip.ts`<br>`src/client/PhysicsWorld.ts` | Needed for moving brush models (doors, plats). On the physics backend the mover is a kinematic body and the world trace already finds it -- Q3's whole `SV_ClipMoveToEntities` loop collapses into the one query, which is the clearest single win of the swap. The clipmap backend keeps `entityClip.ts`, `SV_ClipMoveToEntities` reduced to translation, because every OA mover has zero angles. |
| `trap_CM_TransformedCapsuleTrace` | 1 | cgame | not needed | - | -- | OpenArena traces the player as a bounding box -- `CM_BoxTrace` is called with `capsule = qfalse` everywhere in the movement path -- so the capsule branches are dead code for this port and were not ported. See D-018. |
| `trap_CM_TransformedPointContents` | 3 | cgame | not needed | - | -- | Only reached for contents inside a *rotating* brush model. Every mover in the OA maps this port ships has zero angles, so the transform degenerates and the untransformed call answers it. |
| `trap_Characteristic_BFloat` | 50 | game | not needed | behaviour-tree blackboard | -- | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_BInteger` | 2 | game | not needed | behaviour-tree blackboard | -- | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_Float` | 2 | game | not needed | behaviour-tree blackboard | -- | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_Integer` | 2 | game | not needed | behaviour-tree blackboard | -- | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_String` | 8 | game | not needed | behaviour-tree blackboard | -- | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Cmd_ExecuteText` | 146 | cgame, q3_ui, ui | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_Cvar_Create` | 3 | q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_InfoStringBuffer` | 3 | q3_ui, ui | not needed | - | -- | Serialises cvars into the network userinfo string. |
| `trap_Cvar_Register` | 46 | cgame, game, q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_Reset` | 8 | q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_Set` | 357 | cgame, game, q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_SetValue` | 256 | q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_Update` | 33 | cgame, game, q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_VariableIntegerValue` | 27 | game | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_VariableStringBuffer` | 107 | cgame, game, q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_Cvar_VariableValue` | 219 | game, q3_ui, ui | workaround | URL query parameters | `src/app/main.ts` | Q3's entire settings surface, and by call count its most-used syscall family. meep has `engine/options` with reactive values and it was not used: this port has four knobs -- map, collision backend, fly camera, static targets -- and they are URL query parameters, which are shareable, survive a reload and cost nothing. A port that kept Q3's ~400 cvars would need the real thing. |
| `trap_DebugPolygonCreate` | 3 | game | mapped | DebugDrawSystem3 | *not exercised.* AAS is deleted, and the navigation graph was debugged with headless tools (`tools/navmesh-probe.ts`, `tools/trace-compare.ts`) rather than on screen -- a deliberate choice recorded in section 7, not an oversight. | Q3 uses it to visualise AAS areas. |
| `trap_DebugPolygonDelete` | 2 | game | mapped | DebugDrawSystem3 | *not exercised.* As above. | As above. |
| `trap_DropClient` | 12 | game | not needed | - | -- |  |
| `trap_EA_Action` | 12 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Attack` | 8 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Command` | 12 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Crouch` | 4 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_DelayedJump` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_EndRegular` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Gesture` | 5 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_GetInput` | 3 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Jump` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Move` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveBack` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveDown` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveForward` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveLeft` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveRight` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveUp` | 2 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_ResetInput` | 3 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Respawn` | 4 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Say` | 4 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_SayTeam` | 7 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_SelectWeapon` | 5 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Talk` | 4 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Use` | 14 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_View` | 4 | game | not needed | bot writes usercmd_t directly | -- | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EntitiesInBox` | 9 | game | workaround | own AABB list; no broadphase | `src/game/Movers.ts`<br>`src/game/Items.ts` | Q3's areagrid, used for trigger and item touch tests. The port keeps its own arrays of triggers, movers and items and tests AABBs directly: at the entity counts a deathmatch map has -- 31 items and 6 brush entities on `oa_dm1` -- a broadphase costs more than it saves. Recorded as a facility that exists and was correctly not used. |
| `trap_EntityContact` | 3 | game | workaround | own AABB test | `src/game/Movers.ts` | Q3 tests a bounding box against an entity's *brushes*. The port tests the trigger's AABB, which is exact for the axis-aligned trigger brushes OA ships and would be wrong for a rotated or non-convex one. |
| `trap_EntityContactCapsule` | 1 | game | not needed | - | -- | OpenArena traces the player as a bounding box -- `CM_BoxTrace` is called with `capsule = qfalse` everywhere in the movement path -- so the capsule branches are dead code for this port and were not ported. See D-018. |
| `trap_Error` | 24 | cgame, game, q3_ui, ui | mapped | throw + a failure screen | `src/app/main.ts` | Q3's fatal error drops to the console with a message. Here it throws, and the top-level catch replaces the document with the stack -- because a WebGPU application that fails during boot otherwise shows a black canvas and nothing else. |
| `trap_FS_FCloseFile` | 69 | cgame, game, q3_ui, ui | not needed | GC | -- |  |
| `trap_FS_FOpenFile` | 56 | cgame, game, q3_ui, ui | mapped | AssetManager (async) | `src/app/main.ts`<br>`src/client/map/loadModels.ts` | Q3's filesystem is synchronous and returns a length; meep's assets are promises. Nothing in the gameplay code survives that change unaltered, which is why every load in this port is hoisted to startup and awaited together rather than pulled on demand. |
| `trap_FS_GetFileList` | 25 | game, q3_ui, ui | workaround | build-time manifest | `tools/convert-sounds.ts`<br>`src/client/Audio.ts` | There is no directory listing in a browser, and Q3 uses one to discover sounds, models and map lists. The asset pipeline emits a JSON manifest per asset kind, and the runtime treats a name the manifest does not have as a reportable miss rather than as silence -- which is how the two missing Q3-original music tracks are known about. |
| `trap_FS_Read` | 39 | cgame, game, q3_ui, ui | mapped | ArrayBufferLoader | *not exercised.* The port fetches BSP, glTF and audio by URL and hands whole `ArrayBuffer`s to its own readers. `AssetManager` is used for the formats meep itself parses -- glTF, images, sound -- and nothing else needed a loader. | Q3 reads its own formats out of pk3s at runtime. |
| `trap_FS_Seek` | 7 | cgame, game, q3_ui, ui | workaround | DataView offset | `src/q3/bsp/BspFile.ts` | Q3's file handles are streams. A browser has the whole buffer, so seeking is an offset into a `DataView` -- simpler, and the reason the BSP reader is 450 lines rather than a streaming parser. |
| `trap_FS_Write` | 54 | cgame, game, q3_ui, ui | not needed | - | -- | Demo recording, config writing and stat dumps. All cut: no netcode to record, no cvars to persist, no stats beyond the HUD. |
| `trap_GeneticParentsAndChildSelection` | 3 | game | not needed | - | -- | botlib fuzzy-logic genetic algorithm. |
| `trap_GetCDKey` | 5 | q3_ui, ui | not needed | - | -- |  |
| `trap_GetClientState` | 12 | q3_ui, ui | not needed | - | -- | Connection state machine. |
| `trap_GetClipboardData` | 4 | q3_ui, ui | mapped | core/clipboard | *not exercised.* Only Q3's console and chat entry paste; neither is ported. |  |
| `trap_GetConfigString` | 32 | q3_ui, ui | not needed | - | -- | Configstrings are a replication cache. With no replication the port reads the same worldspawn and entity keys directly -- `CS_MUSIC`, for instance, is `MapSound` reading the `music` key off worldspawn. |
| `trap_GetConfigstring` | 24 | game | not needed | - | -- | Configstrings are a replication cache. With no replication the port reads the same worldspawn and entity keys directly -- `CS_MUSIC`, for instance, is `MapSound` reading the `music` key off worldspawn. |
| `trap_GetCurrentCmdNumber` | 5 | cgame | not needed | - | -- |  |
| `trap_GetCurrentSnapshotNumber` | 3 | cgame | not needed | - | -- |  |
| `trap_GetEntityToken` | 7 | cgame, game | ported | - | `src/q3/bsp/Entities.ts` | Walks the BSP entity lump string. Ported as part of the BSP reader; the same parse feeds item spawning, movers, speakers and the navigation graph. |
| `trap_GetGameState` | 4 | cgame | not needed | - | -- |  |
| `trap_GetGlconfig` | 8 | cgame, q3_ui, ui | mapped | graphics device info | *not exercised.* The camera derives its own aspect and the HUD is laid out by CSS, so nothing asks. | Only used for screen dimensions and aspect. |
| `trap_GetServerCommand` | 3 | cgame | not needed | direct call / meep Signal | -- | Server-to-client command stream collapses to a function call. |
| `trap_GetServerinfo` | 7 | game | not needed | - | -- | Userinfo is a string marshalled across a client/server boundary. Single process, no boundary, no string: the player's name, model and rate are ordinary fields. |
| `trap_GetSnapshot` | 4 | cgame | not needed | - | -- | Netcode; brief section 2 says delete entirely. |
| `trap_GetUserCmd` | 7 | cgame | mapped | engine/input devices plus own usercmd_t builder | `src/client/PlayerController.ts` | cgame-side spelling of the same call. |
| `trap_GetUsercmd` | 4 | game | mapped | engine/input devices plus own usercmd_t builder | `src/client/PlayerController.ts`<br>`src/client/PlayerController.ts` | Q3's `usercmd_t` is kept exactly -- 16-bit angles, byte moves, button bits -- because pmove reads it. What meep supplies is the layer beneath: `keyboard.keys.<name>.is_down` is a live switch with no held-key bookkeeping, and `pointer.on.move` hands over the pointer-lock delta already extracted as its third argument. |
| `trap_GetUserinfo` | 21 | game | not needed | - | -- | Userinfo is a string marshalled across a client/server boundary. Single process, no boundary, no string: the player's name, model and rate are ordinary fields. |
| `trap_InPVS` | 13 | game | not needed | renderer culling | -- | PVS gated sound/event delivery per client. Single process, one player. |
| `trap_InPVSIgnorePortals` | 2 | game | not needed | - | -- | As above. |
| `trap_Key_ClearStates` | 11 | q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* Nothing swallows input, so nothing has to clear it. |  |
| `trap_Key_GetBindingBuf` | 6 | cgame, q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* Bindings are fixed WASD; no rebinding UI shipped. | Q3 bindings live in the engine; here they are game data. |
| `trap_Key_GetCatcher` | 17 | cgame, q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* No menus, so nothing competes for the keyboard. |  |
| `trap_Key_GetKey` | 3 | cgame | mapped | engine/input context stack + own binding table | *not exercised.* No binding UI. |  |
| `trap_Key_GetOverstrikeMode` | 12 | cgame, q3_ui, ui | not needed | DOM text input | -- | Console and chat text editing. |
| `trap_Key_IsDown` | 10 | cgame, q3_ui, ui | mapped | KeyboardDevice key state | `src/client/PlayerController.ts` | `keyboard.keys.<name>.is_down` is a live switch polled once a frame, which is exactly the shape Q3's input wants and is nicer than the DOM's event pair. |
| `trap_Key_KeynumToStringBuf` | 7 | cgame, q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* Bindings are fixed WASD; no rebinding UI shipped. |  |
| `trap_Key_SetBinding` | 11 | cgame, q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* Bindings are fixed WASD; no rebinding UI shipped. |  |
| `trap_Key_SetCatcher` | 32 | cgame, q3_ui, ui | mapped | engine/input context stack + own binding table | *not exercised.* No menus, so nothing competes for the keyboard. |  |
| `trap_Key_SetOverstrikeMode` | 6 | cgame, q3_ui, ui | not needed | DOM text input | -- |  |
| `trap_LAN_AddServer` | 5 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ClearPing` | 5 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_CompareServers` | 4 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPing` | 4 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPingInfo` | 4 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPingQueueCount` | 5 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerAddressString` | 9 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerCount` | 11 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerInfo` | 12 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerPing` | 3 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_LoadCachedServers` | 3 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_MarkServerVisible` | 10 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_RemoveServer` | 4 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ResetPings` | 4 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_SaveCachedServers` | 3 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ServerIsVisible` | 3 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ServerStatus` | 7 | q3_ui, ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_UpdateVisiblePings` | 3 | ui | not needed | - | -- | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LinkEntity` | 59 | game | mapped | ECS entity build + index residency | `src/client/ItemsView.ts`<br>`src/client/PhysicsWorld.ts` | Server-side spatial linking becomes ECS residency: building an entity with a `Transform` and a drawable or a body is what puts it into the relevant index, and nothing has to be told twice. |
| `trap_LocateGameData` | 4 | game | not needed | ECS dataset | -- | Shared-memory handshake between QVM and engine. Gone with the QVM. |
| `trap_MemoryRemaining` | 11 | cgame, q3_ui, ui | not needed | - | -- | QVM heap accounting. |
| `trap_Milliseconds` | 18 | cgame, game, q3_ui, ui | mapped | engine ticker + performance.now | `src/app/main.ts`<br>`src/client/PlayerController.ts` | Q3's clock, used both for timing and as `usercmd_t.serverTime`. The ticker supplies the delta; `performance.now` supplies the instrumentation. |
| `trap_PC_AddGlobalDefine` | 3 | cgame, ui | workaround | offline tokenizer in the asset pipeline | `tools/pipeline/shader-script.ts` | Q3's C-preprocessor-flavoured token parser, used for `.menu` files, bot characters and `.shader`-adjacent data. The menus are not ported and botlib is deleted, so what is left is the `.shader` set, parsed offline by the asset pipeline's own tokenizer: 104 scripts, 2,154 entries, 1,924 unique names, 214 cross-file name collisions and 4 parse warnings. |
| `trap_PC_FreeSource` | 7 | cgame, game, ui | workaround | offline tokenizer in the asset pipeline | `tools/pipeline/shader-script.ts` | Q3's C-preprocessor-flavoured token parser, used for `.menu` files, bot characters and `.shader`-adjacent data. The menus are not ported and botlib is deleted, so what is left is the `.shader` set, parsed offline by the asset pipeline's own tokenizer: 104 scripts, 2,154 entries, 1,924 unique names, 214 cross-file name collisions and 4 parse warnings. |
| `trap_PC_LoadSource` | 9 | cgame, game, ui | workaround | offline tokenizer in the asset pipeline | `tools/pipeline/shader-script.ts` | Q3's C-preprocessor-flavoured token parser, used for `.menu` files, bot characters and `.shader`-adjacent data. The menus are not ported and botlib is deleted, so what is left is the `.shader` set, parsed offline by the asset pipeline's own tokenizer: 104 scripts, 2,154 entries, 1,924 unique names, 214 cross-file name collisions and 4 parse warnings. |
| `trap_PC_ReadToken` | 32 | cgame, game, ui | workaround | offline tokenizer in the asset pipeline | `tools/pipeline/shader-script.ts` | Q3's C-preprocessor-flavoured token parser, used for `.menu` files, bot characters and `.shader`-adjacent data. The menus are not ported and botlib is deleted, so what is left is the `.shader` set, parsed offline by the asset pipeline's own tokenizer: 104 scripts, 2,154 entries, 1,924 unique names, 214 cross-file name collisions and 4 parse warnings. |
| `trap_PC_SourceFileAndLine` | 5 | cgame, game, ui | workaround | offline tokenizer in the asset pipeline | `tools/pipeline/shader-script.ts` | Q3's C-preprocessor-flavoured token parser, used for `.menu` files, bot characters and `.shader`-adjacent data. The menus are not ported and botlib is deleted, so what is left is the `.shader` set, parsed offline by the asset pipeline's own tokenizer: 104 scripts, 2,154 entries, 1,924 unique names, 214 cross-file name collisions and 4 parse warnings. |
| `trap_PointContents` | 12 | game | ported | - | `src/q3/cm/trace.ts`<br>`src/game/PmoveHost.ts` | Brush contents lookup, and the one collision call the physics swap did not touch. Contents are Q3 semantics -- lava, slime, water, playerclip, trigger, and the exact bitmask pmove tests -- and a rigid body has no concept of them, so the clipmap is still loaded and still queried on the physics backend. That is why `PhysicsTrace` takes a `ClipMap`. |
| `trap_Print` | 46 | cgame, q3_ui, ui | mapped | console | *not exercised.* The port logs with `console.log` directly. Worth noting the traffic in the other direction: meep's own per-second FPS report goes to `console.warn`, which is section 5's complaint. | Diagnostics. |
| `trap_Printf` | 16 | game | mapped | console | *not exercised.* As `trap_Print`. | As above. |
| `trap_R_AddAdditiveLightToScene` | 1 | cgame | mapped | Light | `src/client/Effects.ts` | The additive-vs-normal dlight distinction is a fixed-function artefact with no PBR analogue; folded into intensity. |
| `trap_R_AddLightToScene` | 40 | cgame, q3_ui, ui | mapped | Light + LightSystem3 (clustered) | `src/client/Effects.ts`<br>`src/client/map/loadMap.ts` | Q3 dlights were a fixed pool of 32 and had to be budgeted. Clustered lighting removes the cap, which this port depends on twice over: once for effects, and once because the level's static lighting had to be reconstructed as dynamic lights (GAP-006). |
| `trap_R_AddPolyToScene` | 15 | cgame, q3_ui, ui | workaround | GPU decals and particles instead of triangle soup | `src/client/Effects.ts`<br>`src/client/Effects.ts` | Immediate-mode triangle soup: bullet marks, blood, sprites, rail ribbons. Marks and blood become `Decal`s, the rest become particles. meep has a `Trail3D` that would do a rail ribbon and it was not needed -- a rocket trail is smoke, not a ribbon. No path in this port rebuilds a `Geometry` per frame. |
| `trap_R_AddPolysToScene` | 2 | cgame | workaround | as above | `src/client/Effects.ts` | As above. |
| `trap_R_AddRefEntityToScene` | 121 | cgame, q3_ui, ui | mapped | ShadedGeometry / SGMesh entities | `src/client/map/loadMap.ts`<br>`src/client/Characters.ts` | Q3's immediate-mode scene list becomes retained ECS entities, which is the biggest structural change on the client side: nothing is re-submitted per frame, and an item that stops existing is an entity that stops existing. |
| `trap_R_ClearScene` | 17 | cgame, q3_ui, ui | not needed | retained scene | -- | Immediate-mode artifact. |
| `trap_R_DrawStretchPic` | 48 | cgame, q3_ui, ui | mapped | meep UI views | `src/client/Hud.ts`<br>`src/client/Hud.ts` | The entire Q3 HUD and menu draw model is this one call, and it becomes retained `View`s that update when their model changes. The port needed only text, so the image half of the call has no counterpart here. |
| `trap_R_GetViewPosition` | 3 | cgame | mapped | camera Transform | `src/app/main.ts`<br>`src/client/PlayerController.ts` | The camera entity's `Transform` is the view position, and the sound listener rides it. |
| `trap_R_LFX_ParticleEffect` | 24 | cgame | mapped | ParticleEmitterSystem3 / Particular | `src/client/Effects.ts` | OA's LFX particle extension, replaced outright per brief section 2. |
| `trap_R_LerpTag` | 6 | cgame | mapped | glTF node hierarchy + AnimationSystem3 clip player | `tools/convert-characters.ts`<br>`src/client/Characters.ts` | MD3 tags become animated nodes in the converted glTF: `tag_torso` is a node the legs clips drive, and the torso skin hangs off it. The lerp is the clip player, and the three-part model survives as a node hierarchy rather than as three models composed per frame (D-043). |
| `trap_R_LightForPoint` | 3 | cgame | mapped | clustered lighting, directly | `src/client/map/loadMap.ts`<br>`src/app/main.ts` | **Corrected during the phase 6 audit**: this was filed as a gap and is not one. Q3 needs `R_LightForPoint` because its models sit *outside* the lighting solution -- the world is lightmapped, so a moving model has to sample a separate lightgrid to be lit at all. meep has one lighting solution and characters, items and level geometry are all in it, so the call has no counterpart because the problem it solves does not exist. The gap it used to point at (GAP-006, baked lightmaps cannot be imported) is real and belongs to `trap_R_LoadWorldMap`. |
| `trap_R_LoadWorldMap` | 3 | cgame | mapped | offline BSP to scene bundle, then a runtime load | `src/client/map/loadMap.ts`<br>`tools/convert-map.ts` | One `ShadedGeometry` entity per material group and one `Light` per reconstructed light source. The lossy part is not the geometry, it is the lighting: q3map2 strips every `light` entity from a compiled BSP and meep cannot import the baked lightmap (GAP-006), so the lighting is reconstructed from the surface-light shaders and the entity lump. |
| `trap_R_ModelBounds` | 11 | cgame, ui | mapped | AABB3 from the scene bundle | *not exercised.* Item placement drops each pickup with a real trace instead, and there are no model previews because there are no menus. | Q3 uses it to size the item bob and the 2D model previews in the menus. |
| `trap_R_RegisterFont` | 10 | cgame, ui | mapped | engine/asset/loaders/font + UI text | *not exercised.* meep's `View` hierarchy renders as DOM, so HUD text is styled with CSS and the engine's font loader is never reached. A HUD that had to live inside the 3D scene would have needed it. | Q3 fonts are pre-rendered glyph atlases. |
| `trap_R_RegisterModel` | 124 | cgame, q3_ui, ui | mapped | AssetManager + GLTFSceneBundleAssetLoader | `src/app/main.ts`<br>`src/client/map/loadModels.ts` | Two paths, because two kinds of model. Characters go through `GLTFSceneBundleAssetLoader` and `load_model_scene_bundle`, after MD3 vertex-morph frames are decomposed into a skeleton offline (D-042) -- meep has no morph-target path. Item and weapon models skip the loader entirely: they are static, so the pipeline emits one packed vertex buffer for all 76 of them and the runtime builds `ShadedGeometry` from slices of it, which is one fetch instead of 76. |
| `trap_R_RegisterShader` | 117 | cgame | workaround | offline .shader to PBR conversion, then StandardShadeMaterial | `tools/pipeline/shader-to-pbr.ts`<br>`src/client/map/bundle.ts` | Per brief section 2, and lossy by design: 1,679 `tcMod`, 982 non-benign `rgbGen`, 911 `tcGen`, 413 `alphaGen`, 93 `animMap` and 2 `deformVertexes` stages are dropped across the OA shader set. Counted rather than estimated -- see section 5. |
| `trap_R_RegisterShaderNoMip` | 464 | cgame, q3_ui, ui | mapped | meep UI image view | *not exercised.* The HUD here is text -- numbers, a speedometer, a pickup line -- built from `LabelView`. No 2D image is drawn anywhere, so the facility was never reached. | 464 call sites, almost all 2D HUD and menu icons. |
| `trap_R_RegisterSkin` | 22 | cgame, q3_ui, ui | workaround | offline .skin resolution into glTF materials | `tools/convert-characters.ts` | Q3's `.skin` maps a surface name to a shader and is chosen at runtime. There is no runtime material table here: `convert-characters.ts` reads the `.skin` file, resolves each surface to a converted PBR material and bakes it into the glTF. Switching skins at runtime is therefore not possible in this port -- a real capability lost, rather than a translation. |
| `trap_R_RemapShader` | 7 | cgame, ui | not needed | swap material reference | -- | Used for team colours and teleport effects; a material swap. |
| `trap_R_RenderScene` | 16 | cgame, q3_ui, ui | mapped | Engine graphics loop | `src/app/main.ts` | The harness owns the loop; the game is a tick handler on it. |
| `trap_R_SetColor` | 183 | cgame, q3_ui, ui | mapped | UI element tint | *not exercised.* HUD colour here is CSS -- a class swap when health drops below 25, a fade on the pickup line. Nothing tints a UI element through the engine. | 183 call sites, all 2D. |
| `trap_R_inPVS` | 1 | cgame | not needed | - | -- | As above. |
| `trap_RankActive` | 1 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankBegin` | 1 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankCheckInit` | 1 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankPoll` | 1 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankReportInt` | 139 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankReportStr` | 5 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankUserReset` | 1 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankUserStatus` | 3 | game | not needed | - | -- | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RealTime` | 16 | cgame, game, ui | not needed | - | -- | Wall-clock date, for the scoreboard timestamp and demo filenames. Neither is ported. |
| `trap_RemoveCommand` | 1 | cgame | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_S_AddLoopingSound` | 9 | cgame | mapped | AudioEmitter, looping 3D | `src/client/Audio.ts`<br>`src/client/ItemsView.ts` | Q3 rebuilds the loop set every frame and keeps the nearest; a looping 3D emitter is registered with AudioEmitterSystem's LiveEmitterSet, which promotes the nearest in range up to LOOP_BUDGET and leaves the rest dormant. Live at: CG_Missile's per-weapon fly sound on rockets, plasma and BFG shots; CG_Item's hover on a weapon lying in the map; CG_AddPlayerWeapon's firingSound/readySound on bots. Not CG_PlayerPowerups' flight loop (no powerup state) and not the gauntlet's firingSound (needs its own firing flag, not a fire-rate cooldown) -- see D-066. |
| `trap_S_AddRealLoopingSound` | 3 | cgame | mapped | AudioEmitter, looping 3D | `src/client/MapSound.ts` | The ET_SPEAKER variant, meaning not merged with other copies of the same sound. Map ambience: MapSound starts one emitter per target_speaker carrying the looped-on spawnflag, named by the entity's own noise key. 22 on oa_dm5, 10 on oa_dm4, 3 on aggressor. |
| `trap_S_ClearLoopingSounds` | 5 | cgame | not needed | retained emitters | -- | Immediate-mode artifact: Q3 clears the set each frame because the set is rebuilt each frame. An emitter persists until something stops it. |
| `trap_S_RegisterSound` | 218 | cgame, q3_ui, ui | mapped | SoundAssetLoader + SampleAudioClip | `src/client/Audio.ts`<br>`src/client/Audio.ts` | One `EventDescription` per Q3 sound name, built once at load. `AudioEmitterSystem` registers the sound asset loader itself, so the consumer does not have to know one exists. |
| `trap_S_Respatialize` | 3 | cgame | mapped | SoundListener on the camera entity | `src/app/main.ts` | AudioEmitterSystem forwards the listener pose from the component each frame. |
| `trap_S_StartBackgroundTrack` | 8 | cgame, ui | mapped | AudioEmitter, looping 2D on the music bus | `src/client/Audio.ts`<br>`src/client/MapSound.ts` | worldspawn's music key, which SP_worldspawn copies into CS_MUSIC and CG_StartMusic hands over as an intro and a loop token. No map this port ships names a second token. oa_dm1 and oa_dm5 ask for Q3-original tracks OA does not ship, so they get none and the manifest says so. |
| `trap_S_StartLocalSound` | 71 | cgame, q3_ui, ui | mapped | AudioEmitter, finite 2D | `src/client/Audio.ts` | Pickups and feedback tones, played dry -- the same emitter with is3D false, which is what makes it dry. |
| `trap_S_StartSound` | 77 | cgame | mapped | AudioEmitter, finite 3D | `src/client/Audio.ts` | Positional one-shot: AudioBank.play builds an emitter entity at the point and removes it on the instance's onEnded. AudioEmitterSystem routes a finite 3D event down its direct path, so this reaches the same sopra playEvent a direct call would, one link later. |
| `trap_S_StopBackgroundTrack` | 6 | cgame, ui | mapped | remove the music emitter | `src/client/Audio.ts` | AudioBank.stopMusic, and implicitly whenever a second track replaces the first. |
| `trap_S_StopLoopingSound` | 3 | cgame | mapped | remove the emitter entity | `src/client/Audio.ts` | SoundLoop.stop. Unlinking is what stops the sound, so the removal is the stop. Called when a missile detonates, when a weapon is picked up, and when a bot switches or dies. |
| `trap_S_UpdateEntityPosition` | 4 | cgame | mapped | Transform on the emitter entity | `src/client/Audio.ts` | SoundLoop.move writes the Transform the emitter was registered with. The spatial index subscribes to that vector's onChanged, so a rocket's fly sound follows the rocket and refits its BVH leaf only when it actually moves. |
| `trap_Send` | 1 | game | not needed | - | -- | OA-specific raw send. |
| `trap_SendClientCommand` | 19 | cgame | not needed | direct call | -- |  |
| `trap_SendConsoleCommand` | 57 | cgame, game | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_SendServerCommand` | 169 | game | not needed | direct call / meep Signal | -- | 169 call sites collapse to direct calls; the ones that matter carry HUD, scoreboard and print payloads. |
| `trap_SetBrushModel` | 13 | game | hybrid | kinematic RigidBody per submodel brush | `src/game/Movers.ts`<br>`src/client/PhysicsWorld.ts`<br>`src/q3/cm/entityClip.ts` | Binds an entity to BSP submodel *N. On the physics backend each of the submodel's brushes becomes a `KinematicVelocity` body whose `Transform` the mover simulation writes, and the broadphase refits without being asked. On the clipmap backend the same submodel is an offset passed to `clipToEntities`. |
| `trap_SetCDKey` | 5 | q3_ui, ui | not needed | - | -- |  |
| `trap_SetConfigstring` | 53 | game | not needed | - | -- | Configstrings are a replication cache. With no replication the port reads the same worldspawn and entity keys directly -- `CS_MUSIC`, for instance, is `MapSound` reading the `music` key off worldspawn. |
| `trap_SetPbClStatus` | 4 | q3_ui, ui | not needed | - | -- | PunkBuster. |
| `trap_SetUserCmdValue` | 3 | cgame | mapped | own usercmd_t builder | `src/client/PlayerController.ts` | Weapon selection, which in Q3 rides on the usercmd rather than being a command of its own. |
| `trap_SetUserinfo` | 9 | game | not needed | - | -- | Userinfo is a string marshalled across a client/server boundary. Single process, no boundary, no string: the player's name, model and rate are ordinary fields. |
| `trap_SnapVector` | 6 | cgame, game | ported | - | `src/q3/pmove/pmove.ts` | Q3 rounds velocity to 1/8 unit per frame. Part of movement fidelity, not an optimisation -- removing it changes strafe-jump speed. |
| `trap_StringContains` | 2 | game | not needed | String.includes | -- | botlib string helper. |
| `trap_Trace` | 29 | game | hybrid | PhysicsSystem shape_cast + overlap_shape, in front of the ported CM_TraceThroughBrush | `src/client/PhysicsTrace.ts`<br>`src/q3/cm/trace.ts`<br>`src/game/PmoveHost.ts` | The shipping backend is meep physics (D-029), and it does not replace the ported code -- it fronts it. `shape_cast` finds the nearest body and `overlap_shape` finds its neighbours; whether those brushes block the sweep, at what fraction, against which plane, and whether the start was solid are all decided by the ported `traceBrushList`, because the meep query cannot express Q3's per-brush interval rule (GAP-019). The standoff is not an engine gap -- meep's own KinematicMover carries one as a `skin` option, which GAP-020 asserted otherwise and is withdrawn for; see GAP-021. `?trace=clipmap` swaps in the pure ported path, which is bit-exact against the C oracle and is what the physics path is measured against. |
| `trap_TraceCapsule` | 1 | game | not needed | - | -- | OpenArena traces the player as a bounding box -- `CM_BoxTrace` is called with `capsule = qfalse` everywhere in the movement path -- so the capsule branches are dead code for this port and were not ported. See D-018. |
| `trap_UnifyWhiteSpaces` | 4 | game | not needed | - | -- | botlib chat helper. |
| `trap_UnlinkEntity` | 17 | game | mapped | ECS entity removal | `src/client/Effects.ts`<br>`src/client/Audio.ts` | Removal is the unlink -- for the renderer, the physics broadphase and the audio emitter set alike -- which is why an expired decal, a finished one-shot and a detonated rocket are all retired the same way, one frame late, out of the owning system's update. |
| `trap_UpdateScreen` | 11 | cgame, q3_ui, ui | not needed | - | -- | Synchronous repaint during long loads; meep streams assets instead. |
| `trap_VerifyCDKey` | 5 | q3_ui, ui | not needed | - | -- |  |
| `trap_argc` | 1 | game | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_argv` | 1 | game | not needed | - | -- | Q3's console is a command table plus a tokenizer, and everything from `give all` to `map oa_dm1` goes through it. Not shipped: no console, no commands, nothing to tokenize. |
| `trap_getCameraInfo` | 2 | cgame | not needed | - | -- |  |
| `trap_loadCamera` | 3 | cgame | not needed | - | -- | Q3 .camera scripted-camera playback; unused in deathmatch. |
| `trap_startCamera` | 3 | cgame | not needed | - | -- |  |

<!-- END TRAP MATRIX -->

---

## 3. Gap register

Twenty-one entries, two withdrawn. Severities were normalised in phase 6 onto the brief's own
vocabulary — three had drifted onto an ad-hoc `high`/`medium`/`low` scale, which makes a register
unsortable and this document is meant to become a backlog — and then two of them were reduced
again after review. Both reductions are visible below rather than edited away.

| severity | entries | what it means here |
|---|---|---|
| **blocker** | GAP-014, GAP-017 | the port could not ship with this unaddressed. Both are silent: the application builds, runs, reports success at every diagnostic, and does not work. |
| **major** | GAP-001, GAP-002, GAP-003, GAP-004, GAP-005, GAP-006, GAP-008, GAP-012, GAP-015, GAP-016 | cost real time, or would cost any consumer real time on adoption. |
| **minor** | GAP-009, GAP-013, GAP-019, GAP-021, GAP-022 | a workaround exists and is cheap; the cost is confidence rather than hours. GAP-009 and GAP-021 are positioning and discoverability findings rather than defects, and GAP-019 is a Q3-fidelity constraint. GAP-022 is minor *here* and major for the solver's own positioning: this port had a parallel mover simulation to read the platform delta from, and a consumer with ordinary animated kinematic platforms would have nothing. |
| **papercut** | GAP-010, GAP-011 | noticed, worked around in minutes, recorded so the pattern is visible. |
| **withdrawn** | GAP-007, GAP-020 | was a gap, is not. Both entries keep the mistake, because how a wrong conclusion was reached is usually the part a maintainer can act on. |
| *(not the engine's)* | GAP-018 | mine: Quake III winds its triangles clockwise and nothing complained. Kept because the silence is the finding. |

**On the two reductions.** GAP-019 and GAP-020 were filed as blockers, in a group described as
something *every* consumer building a character controller would hit. That was overreach, and
GAP-021 sets out why: meep ships `KinematicMover`, a kinematic character solver with the standoff
GAP-020 said was missing and the depenetration step GAP-019 said could not be expressed. A
consumer building a character controller should use it. This port could not, because `move()`
*is* the slide loop and the brief makes `PM_SlideMove` fidelity non-negotiable — which is a
constraint this port chose, not a defect in the engine. Both entries are kept in full: a report
that quietly downgraded its two loudest findings would be less useful than one that shows the
argument.

The two remaining blockers are section 1's item 3. Read together they are one finding: **meep
fails loudly and specifically when it fails at all** (section 7 says so with examples) **and has
no story whatsoever for the case where a plausible call quietly does nothing.**

### GAP-001: Published `.d.ts` files do not typecheck on their own

- **Needed:** consume meep from TypeScript in `strict` mode with library checking on, so that
  breakage in the engine's own types is visible rather than silently absorbed.
- **meep offers:** a `.d.ts` next to every `.js` (5949 declaration files for 5953 sources —
  coverage is essentially total, which is genuinely good). But they are generated from JSDoc
  without the imports the JSDoc names depend on, so a number of type names resolve to nothing.
  Reachable from a *two-import* program (`EngineHarness`, `Vector3`), `tsc --skipLibCheck false`
  reports 23 errors across 7 declaration files:

  | missing name | occurrences | files |
  |---|---:|---|
  | `BinaryBuffer` | 8 | `core/collection/list/List.d.ts`, `core/color/Color.d.ts` |
  | `int` | 3 | `core/collection/list/List.d.ts`, `core/geom/3d/aabb/AABB3.d.ts` |
  | `Signal` | 3 | `core/events/signal/SignalBinding.d.ts` |
  | `THREE` (namespace) | 2 | `core/geom/3d/aabb/AABB3.d.ts` |
  | `Plane` | 2 | `core/geom/3d/aabb/AABB3.d.ts` |
  | `Frustum` | 1 | `core/geom/3d/aabb/AABB3.d.ts` |
  | `BVH` | 1 | `core/bvh2/bvh3/BvhClient.d.ts` |
  | `AABB3` | 1 | `core/bvh2/bvh3/BVH.d.ts` |
  | `K_1`, `V_1` | 2 | `core/collection/map/ObservedMap.d.ts` |

  Three distinct causes, worth separating because the fixes differ:
  - **Missing imports** (`BinaryBuffer`, `Signal`, `BVH`, `AABB3`, `Plane`, `Frustum`): the
    JSDoc names a type that the emitter did not import. `BVH.d.ts` and `BvhClient.d.ts`
    reference *each other's* main export and neither imports it.
  - **A type that does not exist** (`int`): `@param {int}` is a documentation convention, not
    a TypeScript type. It reaches the declarations verbatim.
  - **A dependency that is no longer there** (`THREE`): `AABB3.d.ts` still refers to the
    `THREE` namespace, but `three` is not a dependency, peer dependency, or optional peer
    dependency of the package. The engine has clearly moved to its own `shade` renderer;
    these are leftovers.
- **Workaround:** `skipLibCheck: true` in `tsconfig.json`. Cost: about 20 minutes to
  diagnose. The real cost is ongoing and invisible — that flag is global, so it also stops
  TypeScript checking every other `.d.ts` in the project.
- **Severity:** major. Not a blocker (the flag exists), but it silently downgrades type
  safety project-wide, and the brief explicitly asked for type quality to be treated as a
  first-class finding rather than papered over.
- **Suggested fix:** run `tsc --noEmit --skipLibCheck false` over the generated declarations
  as a publish gate. Individually: emit the missing imports; replace `{int}` with `{number}`
  throughout the JSDoc (or declare `type int = number` in a shipped ambient file); delete the
  `THREE` references from `AABB3`, or re-add `three` as an optional peer dependency if those
  methods are still meant to work.
- **Evidence:** `tsconfig.json`, and the reproduction is `npx tsc --noEmit --skipLibCheck false`
  against a file whose only imports are `EngineHarness.js` and `Vector3.js`. Recorded at
  phase 0.

### GAP-002: The published `samples/` folder contains no runnable engine sample

- **Needed:** a worked example of booting the engine and drawing something, to calibrate
  against before writing the port's own bootstrap.
- **meep offers:** `samples/` ships in the package (it is in `files`), and contains
  `samples/generation/**` only — procedural generation fixtures: grid configs, noise filters,
  tag matchers, two themes. Nothing that constructs an `Engine`, nothing that renders.
  Compounding it, `package.json`'s `exports` map has no `./samples/*` entry, so the folder
  cannot be imported from a consuming project even though it is shipped — it is reachable
  only by reading it off disk in `node_modules`.
- **Workaround:** `src/engine/EngineHarness.js` turned out to be the de-facto sample —
  `EngineHarness.bootstrap()` plus `buildBasics()` is a complete working setup, and the
  docblocks in it are better than most engines' tutorials. Finding it took reading the
  directory listing of `src/engine/` and guessing from the filename. Cost: ~25 minutes of
  reading source to establish what the intended entry point is.
- **Severity:** major, for adoption rather than for this port. The information is all
  present in the source; the issue is that nothing points at it.
- **Suggested fix:** either ship a handful of runnable samples (boot, load a glTF, light it,
  a particle emitter, a UI panel) and add `"./samples/*": "./samples/*"` to `exports`, or drop
  `samples` from `files` and say in the README that `EngineHarness` is the worked example.
  The current state promises samples and delivers generation fixtures.
- **Evidence:** `node_modules/@woosh/meep-engine/samples/`, `package.json` `exports`.
  Recorded at phase 0.

### GAP-003: `EngineHarness` hard-imports `stats.js`, which is an *optional* peer dependency

- **Needed:** boot the engine.
- **meep offers:** `EngineHarness.js` — the module that is in practice the entry point, given
  GAP-002 — opens with an unconditional top-level `import Stats from "stats.js"`. Meanwhile
  `package.json` declares `stats.js` under `peerDependenciesMeta` as `{ "optional": true }`.
  Those two facts contradict each other: the import is not inside `addFpsCounter()`, it is at
  module scope, so *evaluating* `EngineHarness` requires the optional dependency whether or
  not you ever ask for an FPS counter.

  Second-order problem: `stats.js` publishes a UMD bundle. Under Vite, excluding
  `@woosh/meep-engine` from dependency pre-bundling (which you must, at ~6000 modules) also
  stops Vite's scanner walking into meep to discover meep's *own* CommonJS dependencies. The
  result is a module-evaluation failure:

  ```
  SyntaxError: The requested module '/node_modules/stats.js/build/stats.min.js?v=8ad220e0'
  does not provide an export named 'default'
  ```

  Nothing in that message mentions meep, `EngineHarness`, or an FPS counter. The page renders
  nothing, the console shows one `SyntaxError` about a package the application never
  referenced, and the engine never evaluates.
- **Workaround:** `optimizeDeps.include: ['stats.js', 'dat.gui', 'pako', 'opentype.js']` in
  `vite.config.ts` — four lines, about 45 minutes to find, most of it spent assuming the
  problem was my configuration rather than a transitive import. Diagnosis only came from
  `await import()`-ing the harness by hand in the devtools console, because the failure
  produced no stack trace pointing into meep.
- **Severity:** major. Every new consumer using Vite — the obvious bundler for an ESM-only,
  deep-import package — hits this on their first run, before they have any working mental
  model of the engine to debug it with.
- **Suggested fix:** cheapest is to make the import match the declaration —
  `const { default: Stats } = await import('stats.js')` inside `addFpsCounter()`, so the
  optional dependency is only needed by the optional feature. Failing that, promote `stats.js`
  to a required peer dependency and say so. Separately, documenting the required
  `optimizeDeps` stanza would turn this from a 45-minute dead end into a copy-paste.
- **Evidence:** `vite.config.ts` `optimizeDeps.include`;
  `node_modules/@woosh/meep-engine/src/engine/EngineHarness.js:1`;
  `node_modules/@woosh/meep-engine/package.json` `peerDependenciesMeta`. Recorded at phase 0.

### GAP-004: Worker bundles are loaded from a hardcoded web-root path

- **Needed:** meep's two workers to start — the threaded image decoder in particular, since
  phase 1 decodes several thousand Q3 textures and doing that on the main thread will stall
  the load.
- **meep offers:** both workers are assembled as blob scripts that `importScripts()` a bare
  filename resolved against the *document* origin:

  - `ThreadedImageDecoder` → `'bundle-worker-image-decoder.js'`
  - `makeTerrainWorkerProxy` → `'bundle-worker-terrain.js'`

  Those files ship in `@woosh/meep-engine/build/`, which is not the web root of any
  application. Out of the box, both fail:

  ```
  Worker error: Uncaught NetworkError: Failed to execute 'importScripts' on
  'WorkerGlobalScope': The script at 'http://localhost:5177/bundle-worker-terrain.js'
  failed to load.
  ```

  The two failures are not equally graceful. `ImageRGBADataLoader` accepts a `worker_path`
  and wraps the decoder in `CodecWithFallback(threaded, native)`, so image decoding silently
  drops to the main thread — correct output, no error surfaced to the caller, and the reason
  your loads are slow is invisible. `Terrain.js` calls `makeTerrainWorkerProxy()` with **no
  argument at all**, so the terrain path is not configurable and produces two uncaught promise
  rejections per engine start.
- **Workaround:** a 30-line Vite plugin serving both bundles out of `node_modules` at the
  paths meep expects. Not a `public/` copy: `public/` is inside the repository and meep must
  never enter a committed artefact, so copying engine bundles there would breach the licensing
  constraint this port is under. About 40 minutes including the two follow-on problems below.
- **Severity:** major. It is silent for image decoding (a performance cliff with no signal)
  and unfixable-from-outside for terrain.
- **Suggested fix:** resolve the worker URL relative to the module rather than the document —
  `new URL('../../build/bundle-worker-terrain.js', import.meta.url)` is understood by every
  modern bundler and needs no configuration from the consumer. If the blob+`importScripts`
  construction has to stay, at minimum thread `worker_path` through `Terrain` the way
  `ImageRGBADataLoader` already threads it, and let the image-decoder fallback emit a warning
  instead of failing silently.
- **Evidence:** `vite.config.ts` `meepWorkerBundles()`;
  `src/engine/asset/loaders/image/codec/ThreadedImageDecoder.js:13`;
  `src/engine/ecs/terrain/ecs/makeTerrainWorkerProxy.js:9`;
  `src/engine/ecs/terrain/ecs/Terrain.js:99`. Recorded at phase 0.

Two smaller problems fell out of fixing GAP-004, both worth a line of their own:

- **`exports` has no `./package.json` entry.** The standard way to locate a package root from
  tooling is `require.resolve('pkg/package.json')`. Against meep that throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, which took a Vite config crash to discover. Adding
  `"./package.json": "./package.json"` to the `exports` map costs nothing and is close to
  universal practice.
- **Cross-origin isolation is not accounted for.** A blob worker inherits the page's COEP. If
  the page sets `Cross-Origin-Embedder-Policy: require-corp` — which you want for WebGPU and
  which meep's own worker usage pushes you toward — then `importScripts` of a same-origin
  script is *still* blocked unless that response carries
  `Cross-Origin-Resource-Policy`. Serving the bundles without that header reproduces the exact
  same `NetworkError` as not serving them at all, which cost another 15 minutes of chasing a
  problem I had already fixed.

### GAP-005: Physically-based light units make world scale load-bearing, and nothing says so

- **Needed:** light a converted Q3 level.
- **meep offers:** `PointLight.intensity` is **candela** and `intensity_lumens` is **lumens**,
  with the isotropic conversion `cd = lm / 4π` — genuinely good, and the docblock on
  `PointLight` states it plainly. The consequence is not stated anywhere: because falloff is
  inverse-square *in scene units*, the unit a scene is authored in is now part of its lighting
  setup.

  Q3 authored in its own units, where a ceiling light sits about 300 units above the floor and
  a room is 512 units across. Loading that geometry 1:1 gives a scene that renders essentially
  black. The failure is silent and it does not look like a units problem — it looks like
  materials, or a missing light system registration, or a broken emissive path.

  What made it expensive is that the diagnosis is *counter-intuitive under test*: I raised
  every light's intensity by 100×, then 1000×, then 10000×, and mean frame luminance went
  14.7 → 15.7 → 17.1 → 25.7. A brightness knob that barely responds to a four-order-of-magnitude
  change reads as "lights are not connected", not as "your distances are 32× too large". I went
  looking for a broken link in `LightSystem3` before I thought to read `PointLight`'s units.
- **Workaround:** the asset pipeline now scales all geometry by exactly 1/32 on the way out
  (`WORLD_SCALE` in `tools/convert-map.ts`) and emits light power in lumens, and the runtime
  does the lm → cd conversion. The simulation stays in Q3 units so `bg_pmove` is untouched —
  see D-011. About 90 minutes end to end, of which roughly 60 was diagnosis and 30 was the fix.
- **Severity:** major. Not a defect — the physical units are the right design — but the first
  contact any non-metric content has with the engine is a black screen and no diagnostic.
- **Suggested fix:** a development-mode assertion is enough. The engine already ships ~5000 of
  them: at scene setup, if the camera frustum or scene bounds span more than a few hundred
  units while total scene luminous flux is low, warn that the scene may not be authored in
  metres. Failing that, one paragraph in the lighting docs saying "meep lights are photometric;
  author your scene in metres" would have saved the hour.
- **Evidence:** `tools/convert-map.ts` `WORLD_SCALE`, `src/client/map/loadMap.ts` lm→cd
  conversion, DECISIONS.md D-011. Recorded at phase 1.

### GAP-006: Baked lightmaps cannot be imported, only baked

- **Needed:** Q3 ships every level's lighting as pre-baked 128×128 RGB lightmap pages inside
  the BSP, with per-vertex lightmap UVs already in page space. That is the *entire* static
  lighting of a Q3 map, and reproducing it exactly is the cheapest possible route to a
  correct-looking level.
- **meep offers:** the pieces look like they line up and do not.
  `STANDARD_VERTEX_ATTRIBUTE_STRUCT` has a `uv1` channel, `StandardAttributes` documents
  `TextureCoordinates1` as *"Used for light map"*, and there is a whole
  `shade/renderer/lightmap/` subsystem with an atlas packer, UV rescaling and overlap checks.
  But that subsystem is a **baker**: `GPULightMap` exposes `bake_start` / `bake_update` /
  `bake_end` / `bake`, stores its result as YCoCg plus spherical harmonics, and generates its
  own atlas UVs via `chunk_lightmap_geometry_uv_to_atlas`. There is no path that accepts a
  texture plus a UV set you already have. `StandardShadeMaterial` has albedo, normal, ORM and
  emissive slots — no lightmap slot.
- **Workaround:** none for the lightmaps themselves; they are dropped. Static lighting is
  instead *reconstructed* as real dynamic lights (see DECISIONS.md D-012),
  which is arguably the better demo but is a different picture from Q3's. `uv1` is still
  carried through the pipeline into the geometry so the data is not lost when a slot exists.
  Roughly 40 minutes, most of it spent establishing that the lightmap subsystem was a baker
  rather than an importer — the directory listing strongly suggests otherwise.

  **What it costs, visually — and a correction.** Large flat surfaces read as uniformly lit:
  reconstructed point lights give brightness, and what baked lighting gave was *spatial
  variation* in brightness — the ambient occlusion in a corner, the falloff along a wall. That
  much still stands.

  What does not stand is the first version of this paragraph, which said "the floors look
  untextured" and called this the single most visible quality gap in the demo. The floors were
  not untextured; they were **not being drawn at all**, because I had every triangle in every map
  wound backwards (GAP-018). I had a plausible explanation for a symptom and stopped looking. The
  visible cost of this entry is real but ordinary: a level that looks flatly lit rather than one
  that looks wrong.
  **What it costs, measured — added in phase 6.** The reconstruction is not uniformly good, and
  until phase 6 nobody had checked. `test/presentation.test.ts` computes illuminance at every
  spawn point and pickup on every shipped map, in lux, using the same photometric arithmetic
  `loadMap` hands the engine — `cd = lm / 4π`, inverse-square in scene metres, cut off at the
  light's `distance`:

  | map | triangles | reconstructed point lights | sun | median lux at player positions | positions under 1 lux |
  |---|---:|---:|---|---:|---:|
  | `am_thornish` | 198,740 | 147 | yes | 58.0 | 0 / 95 |
  | `oa_dm4` | 4,089 | 22 | yes | 31.4 | 0 / 47 |
  | `aggressor` | 3,263 | 63 | yes | 22.5 | 0 / 38 |
  | `oa_dm1` | 7,532 | 22 | no | 8.8 | 0 / 38 |
  | `oa_dm7` | 2,947 | 13 | yes | **0.0** | **70 / 79** |
  | `oa_dm5` | 107,414 | **0** | yes | **0.0** | **36 / 36** |

  The reconstruction reads `q3map_surfacelight` off the shader set and `q3map_sun` off
  worldspawn. Where a map's lighting came from `light` *entities* and the lightmap, there is
  nothing left to read: q3map2 strips every `light` entity from a compiled BSP — measured, zero
  across all six maps, and asserted in that test file so it stays measured. `oa_dm5` is 107k
  triangles of level with a single dim blue `q3map_sun` and no fixtures at all.

  So the honest form of this gap's cost is: **the workaround succeeds on four of six maps and
  fails on two, and which two is not predictable from anything except the shader set.** That is
  worse than a uniform quality loss, because it is invisible until someone loads that map.

  There is a route that was scoped out rather than tried: the BSP's lightgrid lump (15) is the
  *other* baked product of q3map2, it survives compilation, and it holds an ambient plus
  directional sample per grid cell. Turning bright cells into point lights offline would give
  `oa_dm5` a lighting solution without any rendering code, any engine change, or any lightmap
  slot. It is asset-pipeline work, roughly half a day, and it is recorded in D-069 as not done
  rather than quietly omitted. It would not close this gap — a lightgrid is a coarse
  approximation of the lightmap, which is the thing that cannot be imported — but it would
  remove the cliff.
- **Severity:** major for anyone bringing in content from another engine. Every level format
  that predates real-time GI — Quake, Source, Unreal up to about 3, and most mobile pipelines
  today — ships baked lighting, and none of it can be brought in.
- **Suggested fix:** a `texture_lightmap` slot on `StandardShadeMaterial` sampled with `uv1`
  and multiplied into diffuse. The vertex channel and the attribute name already exist and
  already say "light map"; what is missing is the consumer.
- **Evidence:** `src/shade/renderer/lightmap/**`, `StandardAttributes.js`,
  `StandardShadeMaterial.d.ts`. Recorded at phase 1; measured in phase 6 by
  `test/presentation.test.ts`.

### GAP-007 (withdrawn): `draw_side` works; its docblock is stale

- **Status: withdrawn.** The original entry said `ShadeMaterial.draw_side` was a settable field
  that did nothing, quoted its docblock approvingly as the right way to document a non-functional
  property, and filed double-sided surfaces as unsupported. The docblock is out of date and I
  took it at face value.
- **What is actually true:** `ShadeDrawSide.Front` and `ShadeDrawSide.Double` both work.
  `Double` is what Q3's `cull none` needs -- grates, railings, banners, flags, beams and flame
  sprites -- and setting it is all that is required. Five materials on `oa_dm1` need it, eight on
  `oa_dm5`, seven on `am_thornish`.
- **`Back` is the one to avoid**, and the engine says so by what it does rather than in prose: the
  glTF loader runs `fix_up_material_sides`, which handles a `Back` material by *flipping the
  geometry* with `geometry_flip_normals` and rewriting the material to `Front`. Nothing does that
  for a hand-built material, so `Back` on one is the only value that will not behave.
- **The remaining finding is small and is about the comment, not the code.** A stale docblock
  that describes a limitation which has since been fixed is worse than no docblock: it is
  believed, and it is believed precisely by the careful reader who checks before using something.
  This one cost a feature -- double-sided surfaces went unimplemented for the whole port on the
  strength of it -- and it also earned meep a compliment in this report's ergonomics section that
  it did not deserve for this particular field, which has been corrected.
- **Now applied:** `src/client/map/bundle.ts` sets `draw_side = Double` for every material the
  shader conversion marked `doubleSided`.
- **Evidence:** `src/shade/renderer/material/ShadeMaterial.js` line 27 (the stale comment),
  `src/shade/renderer/loader/gltf/fix_up_material_sides.js` (what `Back` really does).
  Withdrawn during phase 5.

### GAP-008: Meshlet construction is synchronous, single-threaded, and on the critical path

- **Needed:** load a level's geometry without stalling the frame loop.
- **meep offers:** `meshlet_geometry_build_from_geometry(geometry)` is the only documented
  route from a `Geometry` (attributes you built) to a `MeshletGeometry` (what the renderer
  draws). It runs synchronously on the calling thread.

  Measured, converting one map's meshes:

  | map | triangles | meshes | meshlet build |
  |---|---:|---:|---:|
  | `aggressor` | 3,263 | 23 | 53 ms |
  | `oa_dm1` | 7,460 | 30 | 74 ms |
  | `am_thornish` | 198,740 | 45 | **1,246 ms** |

  1.25 seconds of unbroken main-thread work. The engine has an asset-streaming story, a
  `ConcurrentExecutor` for time-sharing, and a worker infrastructure — and the one step that
  actually costs real time on level load uses none of them.
- **Workaround:** none applied. It is a load-time cost and the demo tolerates it. A real game
  would have to slice it manually, which means calling the builder per mesh and yielding
  between meshes — feasible here only because the port controls the mesh granularity.
- **Severity:** major. A 200k-triangle level is small; this scales linearly and a real level is
  several times that.
- **Suggested fix:** either an async/chunked variant that cooperates with `ConcurrentExecutor`
  the way the terrain builder cooperates with its worker, or a documented offline format so
  meshlet construction can happen at asset-build time and the runtime only uploads. The
  serialization adapter (`MeshletGeometrySerializationAdapter`) suggests the second is close to
  possible already, but nothing documents it as the intended pipeline.
- **Evidence:** `src/client/map/loadMap.ts` timings, reported in `LoadedMap.timings.geometry`.
  Recorded at phase 1.

### GAP-009: `FirstPersonPlayerController` cannot host a fixed-physics shooter, and that is a positioning problem rather than a defect

This entry exists because the engine ships a first-person character controller, a Q3 port is
the most obvious thing anyone would point it at, and the two are structurally incompatible. A
maintainer converting this report into a backlog should know that before someone else finds out
the expensive way.

- **Needed:** run `bg_pmove` — a fixed, non-configurable step function whose exact arithmetic
  *is* the game.
- **meep offers:** 3,690 lines across `engine/control/first-person/**`, and it is clearly good
  work: motion phases, ability composition, a `KinematicMover` with stair and ramp handling, and
  a "mastery" layer that rewards well-timed inputs. Its `DESIGN.md` states two goals — "feel
  alive" and "be configurable" — and cites Mirror's Edge Catalyst, Star Citizen stance/breathing
  and critically-damped spring cameras.

  Those goals are the opposite of what a Q3 port needs. Q3 movement is not tuned for feel; it is
  a specific set of floating-point operations that players spent twenty-five years learning to
  exploit. Strafe jumping exists *because* `PM_Accelerate` caps `addspeed` against a projection
  of current velocity onto the wish direction, which is a bug. Configurability cannot express
  "this bug, exactly". The controller also declares collision resolution a non-goal in
  `DESIGN.md`, assuming a layer that reports `grounded` and `groundNormal` — and which layer
  that is decides ramp jumps.
- **Workaround:** none needed; the port implements `bg_pmove` itself and does not use the
  controller. Recorded because the *absence* of a workaround is the finding.
- **Severity:** minor for this port, potentially major for adoption. Anyone arriving with an
  existing movement model — a Quake-lineage shooter, a physics-driven platformer, a netcode
  rollback design with its own step function — needs to know quickly that this controller is a
  complete opinion about movement rather than a substrate for one.
- **Suggested fix:** documentation, not code. One line in the README or at the top of
  `DESIGN.md` saying what it is *for* ("an opinionated, tunable feel-first controller; bring
  your own if you have a fixed movement model") would set expectations correctly. The engine is
  otherwise unusually good at this — see the `NavigationMeshAgent` and `draw_side` notes.
- **Evidence:** `src/engine/control/first-person/DESIGN.md` §1, `src/q3/pmove/pmove.ts`,
  DECISIONS.md D-007. Recorded at phase 2.
- **What this entry then caused, added after review.** Read the `meep offers` bullet above: it
  names `KinematicMover` in passing and moves on. That was the right conclusion about the
  *controller* and the wrong scope. `KinematicMover` is controller-agnostic, it carries the
  standoff and the depenetration step that GAP-020 and GAP-019 later asserted were missing from
  the engine, and `DESIGN_COLLISION.md` sits beside it. Treating one correct rejection as covering
  a whole directory cost about six hours and two wrong fixes two phases later. GAP-021 is the
  correction, and this entry is where the mistake starts.

### GAP-010: Particle parameter names are string-typed and case-trapped

- **Needed:** animate particle scale and colour over a particle's lifetime.
- **meep offers:** `ParticleLayer.parameterTracks`, keyed by name, with the names in a
  `ParticleParameters` constant. The trap is that the constant's **keys** are `Scale` and
  `Color` while its **values** are `'scale'` and `'color'`. Writing the name out — which is
  the natural thing to do when you are assembling an emitter as a JSON literal, as
  `ParticleEmitter.fromJSON` invites — throws at emitter-construction time:

  ```
  Failed to add track with name 'Scale', no parameter exists with that name
  ```

- **Workaround:** import `ParticleParameters` and use the constants. Five minutes, entirely
  because **the error message is good**: it names the offending track, says exactly what is
  wrong, and is thrown at construction rather than swallowed into a silently empty effect.
  Worth saying explicitly — most engines would have rendered nothing and told you nothing.
- **Severity:** papercut.
- **Suggested fix:** the JSON path is the one that invites string literals, so either accept
  both cases there, or type the field as a union in the generated declarations so TypeScript
  rejects `'Scale'` at compile time. Aligning the constant's keys with its values would also
  do it.
- **Evidence:** `src/client/Effects.ts` `SCALE`/`COLOR`,
  `src/engine/graphics/particles/particular/engine/emitter/ParticleParameters.js`. Recorded at
  phase 3.

### GAP-011: Photometric lighting makes "physically plausible" and "reads well" different questions

- **Needed:** a rocket explosion that lights the room.
- **meep offers:** exactly what it should — a point light in lumens, with correct
  inverse-square falloff. There is no defect here at all.
- **What happened:** the first attempt used 60,000 lumens, on the reasoning that an explosion
  is *very bright*. It is: the result saturated every surface in the corridor to white and
  completely hid the particle effect the light existed to illuminate. 12,000 lumens — about
  eight household bulbs, which sounds far too dim for a rocket — is what actually reads as an
  explosion.
- **Workaround:** tune by eye, which is the normal answer and took about ten minutes across
  the explosion flash and the muzzle flash.
- **Severity:** papercut, and arguably not a gap at all. Recorded because it is the *second*
  time photometric units cost time in this port (GAP-005 was the first, and much more
  expensive), and the pattern is worth naming: physical units remove one class of guesswork
  and introduce another. An engine that ships them benefits from shipping reference values
  alongside — "a torch is ~300 lm, a room light ~1500, a muzzle flash ~2500, an explosion
  ~12000" in the lighting docs would have skipped both incidents.
- **Evidence:** `src/client/Effects.ts` `explosion()`. Recorded at phase 3.

### GAP-012: `shape_cast` returns the minimum-penetration normal; character control needs the latest entering plane

- **Severity:** minor, reduced twice. It was `major` while this port re-derived the plane to keep
  Q3's contact semantics; movement now runs on `KinematicMover` (D-071) and nothing in the
  shipping path asks this question any more. The API observation below is unchanged and still
  factual — it is the *consequence* that shrank.
- **What happened:** With movement on meep's physics, the player wedged permanently on outside
  corners — velocity went to zero about a metre short of the corner and stayed there. Traced to
  the contact normal. A player box overlapping the join between a floor brush and a wall brush
  gets `normal = [0, 1, 0]` from `shape_cast` (up, the floor), because EPA resolves the
  *shallowest* separating axis and at that position the floor is shallower. The controller's
  slide-move clips velocity against up, which does nothing to the horizontal motion into the
  wall, so it re-traces, accumulates a second contradictory plane, hits its five-plane limit and
  zeroes velocity as a last resort. That is `PM_SlideMove`'s failure mode, and it is the shape of
  every plane-accumulating slide-move — meep's own `KinematicMover` accumulates the same five
  (`MAX_CLIP_PLANES`, "matching Quake's") and dead-stops on the third contradictory one.
- **Why it is a gap rather than a Q3 quirk:** the two quirks alongside it *are* Q3 quirks and
  are recorded as such in D-030 — Q3's 1/8-unit surface standoff and its brush-relative
  definition of `startsolid`. This one is not. "Which surface am I actually pressed against"
  is the question every character controller asks, and for a swept convex query the useful
  answer is the plane the sweep entered last, not the axis of least penetration. They coincide
  on a flat wall, which is why this survives casual testing and shows up only at corners — the
  exact geometry players run into constantly.
- **Workaround:** re-derive it. `PhysicsTrace.contactPlane` takes the contact point,
  finds every brush the inflated player box overlaps via `overlap_shape`, and applies
  `CM_TraceThroughBrush`'s rule — the plane the sweep crosses latest — across all of them,
  because a corner is usually two brushes rather than two faces of one. This requires keeping
  the source half-space representation alongside the `ConvexHullShape3D`; an application that
  built its hulls from a mesh would have nothing to re-derive from and would be stuck.
- **Cost:** ~2 hours, most of it spent believing the port had a `PM_SlideMove` bug because the
  symptom is a slide-move symptom. The measured improvement once fixed: bunny-hop position
  divergence p90 fell from 56.0 units to 0.12 units — a 450x reduction, from "visibly a
  different game" to "sub-centimetre".
- **Postscript, and it is the more useful half.** The mitigation described above was, for the
  entire life of the browser build, *not running in it*. The lookup it depends on was declared,
  read, and never populated outside the test harness, so the shipping build took the fallback --
  this gap's own wrong answer -- on every single contact. What a player reported was being wedged
  in open space, unable to move sideways: `PM_SlideMove` clipping a horizontal move against a
  floor normal, twice, and projecting the result onto the line between. If nothing else in this
  report is taken away: **a workaround that only the tests exercise is not a workaround**, and the
  more faithfully a harness reproduces the engine, the more completely it can hide that. See
  D-061.
- **What would fix it:** an optional `ShapeCastResult` field carrying the last-entered
  separating plane, or a `contact_mode` on `shape_cast`.
- **Scope, corrected after review, and it is narrower than this entry first claimed.** The
  original wording said every consumer would otherwise re-implement this "badly and privately".
  That was overreach of the same kind that GAP-021 documents: meep has already implemented a
  character solver once, publicly, in `KinematicMover`, and it approaches the corner case from
  the other end — a `compute_penetration` recover pass before each move plus a `skin` clearance,
  so the sweep does not start from an overlapping pose, which is the condition under which the
  minimum-penetration normal is least informative. I have not measured whether that fully avoids
  the wedge; what I can say is that the engine is not silent on the problem, and a consumer using
  the solver is not obviously exposed to it.

  What survives unaltered is the API observation, which is factual: `shape_cast` returns the
  minimum-penetration normal, there is no option for the last-entered plane, and a consumer
  building directly on the query — as this port must, because `bg_pmove` owns the slide-move — has
  to re-derive it from source geometry the engine does not keep.
- **Evidence:** `src/client/PhysicsTrace.ts` `contactPlane`, `test/physics-divergence.test.ts`.
  Recorded during the physics swap.

### GAP-013: `Collider.shape` is typed such that no concrete shape is assignable to it

- **Severity:** minor — a pure type-level defect, one cast, but it is in the first line of code
  anyone writes against the physics API.
- **What happened:** `attach_collider(body, new BoxShape3D(...))` does not typecheck.
  `AbstractShape3D` declares `equals(other: this): boolean`; `BoxShape3D` narrows it to
  `equals(other: BoxShape3D): boolean`. Method parameters are checked bivariantly so that is
  usually tolerated, but combined with the polymorphic `this` in the base signature the
  subclass is not assignable to `AbstractShape3D` at all, and `Collider.shape` is declared as
  `AbstractShape3D`. Every concrete shape in the package fails the same way, so the API has no
  usable argument.
- **Workaround:** a local `ColliderWithShape` interface re-declaring `shape` as `unknown`, and
  one cast at the call site.
- **What would fix it:** declare `equals(other: AbstractShape3D): boolean` on the base and keep
  the narrowing in the implementation body, or drop the subclass overrides entirely.
- **Cost:** 15 minutes, and it is the kind of thing `skipLibCheck` does *not* hide because it
  surfaces in the consumer's own code rather than in the `.d.ts`. Related to GAP-001.
- **Evidence:** `src/client/PhysicsWorld.ts`. Recorded during the physics swap.

### GAP-014: `PhysicsSystem` needs a second system registered, and without it every body is intangible

- **Severity:** blocker -- the failure is total, silent, and presents as a bug in the consumer's own
  code.
- **What happened:** 537 static bodies, built from a level's collision brushes, and every
  `shape_cast` against them returned a miss. Not a near miss: `fraction === 1` for a sweep
  starting a metre above a floor and ending 128 m below it. The player fell through the world.
  Nothing in the console, no exception, and the same code with the same shapes worked in a
  headless harness -- which is what made it look like an ECS-timing problem rather than a
  missing registration.
- **The cause:** `PhysicsSystem` links `(RigidBody, Transform)`. Attaching the *collider* is a
  different system, `ColliderObserverSystem`, and registering it is the consumer's job. Its
  docblock says so plainly -- "Pairs with `PhysicsSystem`: register both in the EntityManager" --
  in the class docblock of a class you have no reason to look at, because you did not know it
  existed. There is no reference to it from `PhysicsSystem`, from `Collider`, or from
  `attach_collider`.
- **Why it is severe rather than annoying:** a body with no collider is not obviously broken.
  It is in the broadphase, it has a transform, `PhysicsSystem` reports it, and every query
  answers promptly. The only symptom is that the answer is always "nothing there", which is
  indistinguishable from "your level failed to load", "your coordinate conversion is wrong", or
  "your query is malformed" -- I checked all three first. The same observer also silently skips
  an orphan collider, which its docblock justifies (avoiding console spam on authoring
  transients) and which removes the last diagnostic that would have caught it.
- **Workaround:** register both, body system first.

  ```js
  await em.addSystem(physics);
  await em.addSystem(new ColliderObserverSystem(physics));
  ```

- **Cost:** ~90 minutes, all of it after the fact -- the browser build had been running with
  intangible bodies while every measurement in section 5.4 was taken through a headless harness
  that calls `link` and `attach_collider` directly and therefore never needed the observer. The
  numbers are unaffected; the shipping wiring was wrong and is now verified in the browser
  (`groundEntityNum` set, the player at rest, items dropping to `floor + 15 + 1/8`).
- **What would fix it:** any one of three, cheapest first. A `@see ColliderObserverSystem` on
  `PhysicsSystem` and on `Collider`. A one-line warning the first time a `Collider` component is
  built into a dataset that has no `ColliderObserverSystem`. Or a static
  `PhysicsSystem.register(em)` that adds both, which would make the pairing unmissable.
- **Evidence:** `src/client/PhysicsWorld.ts` `PhysicsWorld.create`. Recorded during phase 3b.

### GAP-015: `new Animation({clips})` takes JSON, is documented as taking components, and silently accepts either

- **Severity:** major -- a wrong-but-plausible call that produces no error and no animation.
- **What happened:** `new Animation({ clips: [clip1, clip2] })` with real `AnimationClip`
  instances builds an `Animation` whose list is the right length, whose clips are real
  `AnimationClip`s, and whose every clip name is the **empty string**. Nothing then matches any
  clip in the model, `ClipListPlayer` produces zero playbacks, and the entity stands still.
- **Why the obvious call is the wrong one:** the constructor's own docblock says
  `@property {List.<AnimationClip>} clips`, and the field is declared `@type {List<AnimationClip>}`.
  Both point at the component type. The constructor in fact forwards to `fromJSON`, which calls
  `this.clips.fromJSON(json.clips, AnimationClip)` -- so the argument must be *plain objects*, and
  passing the documented type quietly produces empty names rather than throwing.
- **Measured, not inferred:** constructing both ways in the running app and reading the names back
  gives `''` for the instance form and `'LEGS_RUN'` for the JSON form.
- **What makes it expensive to diagnose:** the engine has a genuinely good diagnostic for the
  general case -- `ClipListPlayer#report_missing` warns once per name and prints the model's real
  clip list beside it, which is the right message. Here it fires for a name that is the empty
  string, so the line reads as noise rather than as the answer, and everything else looks correct:
  the model loads, both skins are there, the clip list has the right length, and every clip in it
  is a real `AnimationClip`.
- **Workaround:** pass JSON and read the constructed clips back out.

  ```js
  const animation = new Animation({ clips: [{ name, weight: 1, repeatCount: -1, timeScale: 1, flags: 0 }] });
  const clip = animation.clips.get(0);
  ```

- **What would fix it:** accept both -- `fromJSON` could pass through anything already an
  `AnimationClip` -- or type the parameter as the JSON it is. Either removes the trap.
- **Cost:** ~40 minutes, most of it spent believing the *model* had not loaded.
- **Evidence:** `src/client/Characters.ts` `clipJson`. Recorded during the character phase.

### GAP-016: A navmesh needs a surface, and brush-based level geometry is a pile of solids

- **Severity:** major for adoption, minor for this port, and narrower than the first version of this entry claimed. **That version
  was wrong and is withdrawn**; what follows replaces it, with the correction kept because how I
  got it wrong is the useful part.
- **What I claimed, and why it was wrong.** I fed the brush solids to `NavigationMesh`, got 5% of
  spawn pairs routable, tried grid-snapping the coordinates to weld them, got 5% again, and wrote
  that nothing in the package could turn arbitrary geometry into a manifold surface. That is
  false. `core/geom/3d/topology` is an extensive mesh-repair toolkit --
  `bt_merge_vertices_by_distance`, `bt_mesh_fuse_duplicate_edges`, `bt_mesh_resolve_t_junctions`,
  `bt_mesh_kill_degenerate_faces`, `bt_mesh_compact`, `bt_mesh_split_pinched_vertices`,
  `bt_mesh_close_boundary_holes`, plus `bt_mesh_validate` and `bt_mesh_is_manifold` to check the
  result -- and `bt_mesh_resolve_t_junctions`'s own docblock states both the problem ("faces of
  differing sizes... touch only at a single vertex, so edge-based neighbour queries treat them as
  DISCONNECTED") and the recipe ("call AFTER an initial vertex-merge/edge-fuse, then FUSE
  again... the mesh must be triangulated"). My hand-rolled grid snap was a worse substitute for a
  better tool that was already there, and `bt_mesh_vertex_merge_distance` even documents why the
  naive version fails: below the float32 step a tolerance silently degenerates into an exact-bits
  match and leaves the surface cracked.
- **Running the real repair on the solids changes nothing**, and that is also not a tool failure.
  `bt_mesh_resolve_t_junctions` reports *zero* splits, because it splits **boundary** edges -- ones
  with exactly one face -- and a soup of closed convex brushes has none. Every edge already has two
  faces. The tool was given the wrong kind of input, by me.
- **The actual missing step is upstream of all of it.** A navmesh wants a *surface*; a Quake III
  map is a set of interpenetrating *volumes*. A floor brush is not a floor -- it is a sealed box
  whose top happens to be one, with the wall brush beside it buried in its side. Extracting the
  surface takes two filters, both of them Q3's own numbers: `MIN_WALK_NORMAL` (0.7) for "is this
  triangle a floor", the same constant `PM_GroundTrace` uses, and `pointContents` for "is the
  space just above it solid". That is about forty lines, and it moves the result from 5% to 48%.
- **What remains genuinely missing**, and is the gap: welding cannot *union* overlapping coplanar
  patches. Two floor brushes that overlap contribute two surfaces occupying the same space; they
  do not abut, so no vertex merge joins them. After extraction and full repair the surface is
  still ~100 islands with the largest at 25%, and while the builder bridges those well, it cannot
  invent connectivity that is not in its input. Closing that needs a boolean union, or the voxel
  rasterisation Recast uses precisely to avoid needing one. `bt_mesh_sample_interior_grid_points`,
  `bt_mesh_surface_ray_parity` and `bt_mesh_segment_penetrates_surface` are the inside/outside
  primitives such a pass would be built from; I did not attempt it.
- **Measured**, by `npm run navmesh-probe`, on `oa_dm1` (spawn-pair routability):

  | input | `oa_dm1` | `aggressor` | after repair |
  |---|---|---|---|
  | solid brushes | 5% | 32% | unchanged — 0 T-junction splits, still non-manifold |
  | render surfaces | 0% | 0% | unchanged — navmesh builds *empty*, in either winding |
  | **walkable faces** | **48%** | **28%** | unchanged — 267 and 185 splits, `manifold: true` |
  | *waypoint graph, same metric* | *100%* | *100%* | |

  Repair does not move the walkable-faces number, but it is what makes the surface manifold, and
  a non-manifold input can make `find_path` read a released vertex and **throw** from four frames
  inside Polyanya rather than report no path — 17 of 72 pairs on `aggressor`'s raw brushes. The
  probe counts those rather than propagating them.
- **One result I could not explain, and am recording rather than dressing up.** On `aggressor`,
  repairing the render surfaces produces a nearly perfect input — 8 islands over 3,301 faces, the
  largest holding 99% of them — and the navmesh still builds **zero faces**. Not a bad navmesh: an
  empty one, with no error, no warning and no diagnostic. It is not winding (reversing changes
  nothing) and it is not connectivity (99% in one island). Render geometry is the wrong input on
  Q3 grounds anyway, so I stopped there, but "this input silently yields an empty navmesh" is
  worth a caller-facing complaint from the builder.
- **The finding worth taking away** is the last row. A waypoint graph built by *tracing* -- asking
  the collision system "can a player-sized box get from here to there" -- routes every spawn pair,
  because a trace does not care whether the world is one surface or a hundred overlapping ones.
  For brush-based level geometry the collision query is a better source of navigation connectivity
  than the geometry is, and it is available to anyone whose engine has a shape cast.
- **Two smaller notes on the same API.** The generated `.d.ts` types `NavigationMesh.build`'s
  *options object* as `BinaryTopology` -- the JSDoc puts `@param {BinaryTopology} source` on a
  destructured parameter and the generator hoists it onto the whole object -- so the documented
  call does not typecheck; `navmesh_build_topology` has it too, and it is GAP-001's family. And
  `find_path` throwing out of Polyanya on unrepaired input would be better as a documented
  precondition or a validation call at build time, since `bt_mesh_validate` already exists.
- **What would help most:** a worked example that says "extract your walkable surface, then repair
  it in this order, then build". Every piece of that is in the package; the order is not written
  down anywhere a consumer will find it before they need it.
- **Cost:** ~2 hours to get it wrong, ~1 hour to get it right after the maintainer pointed at
  `bt_mesh_append` and `bt_merge_verts_by_distance`. The tooling was never the problem.
- **Evidence:** `tools/navmesh-probe.ts`, which reproduces the whole table in one command.

### GAP-017: The element the input devices listen on is `pointer-events: none` and never focused

- **Severity:** blocker. The application renders perfectly at 160 FPS and cannot be played, and
  nothing anywhere says why.
- **What happened:** the game loaded, drew, ran its simulation, updated its HUD — and WASD did
  nothing and the mouse did not turn the view. No error, no warning, no failed assertion.
- **The cause, which is two things that compound.** `Engine`'s constructor builds
  `devices.pointer` and `devices.keyboard` on `viewStack.el` and starts them, so that element is
  where input is expected to arrive. But:
  - **It is not hit-testable.** `.view-stack`, `.game-view` and the render canvas are all
    `pointer-events: none`. `document.elementFromPoint` at the centre of the viewport returns
    `<html>`. No `pointerdown` or `pointermove` ever reaches the element the `PointerDevice` is
    listening on, so the device is live, started, and permanently silent.
  - **It is never focused.** The element carries `tabindex="0"` — it is clearly *meant* to be
    focused — but nothing focuses it, so `document.activeElement` is `<body>` and keyboard events
    go there instead. `KeyboardDevice`'s own constructor docblock insists the element must be
    focusable, which suggests the intent was understood; making it focus*ed* is the step that is
    missing.
- **Why it is worse than it sounds.** Both halves fail *silently and identically to a game with
  no input code at all*, which is the wrong place to start debugging. My first assumption was that
  my own listeners were wrong, then that pointer lock was being refused, then that the ticker was
  not running. The actual diagnosis needed `getComputedStyle` up the parent chain — not a place
  anyone looks when the keyboard does not work.
- **A third trap on the way out.** Once the element is hit-testable, listeners still have to use
  the right event family: the devices listen for **Pointer Events** (`pointermove`, `pointerdown`),
  not `mousemove`/`mousedown`. Synthesising a `MouseEvent` to test the wiring reports "still
  broken" and sends you back to the previous two causes. That one is on me, but it is an easy
  half-hour to lose.
- **Workaround**, and it is small once found — app-level CSS on an element the engine hands you,
  not a change to the engine:

  ```js
  const input = engine.viewStack.el;
  input.style.pointerEvents = 'auto';
  input.focus();
  input.addEventListener('pointerdown', () => input.focus());
  ```

  After that, `keyboard.keys.w.is_down`, `pointer.mouseButtonLeft.is_down` and
  `pointer.on.move`'s **third** argument — the pointer-lock delta, already extracted from
  `movementX`/`movementY` — are everything a first-person controller needs, and they are a nicer
  API than the DOM's. The device layer is good; reaching it is the problem.
- **What would fix it:** have whatever creates the view stack focus it, and either give
  `.view-stack` `pointer-events: auto` with the *children* opting out, or have `PointerDevice`
  warn on `start()` when its element's computed `pointer-events` is `none` — which is a two-line
  check for a failure that is otherwise invisible.
- **Cost:** the first version of this port shipped raw DOM listeners on `graphics.domElement` and
  I recorded that as a deliberate choice. It was not a choice; it was a bug that had not been
  noticed, because I had verified movement through headless harnesses and the browser build was
  only ever checked for *load* errors. Found when the maintainer tried to play it.
- **Evidence:** `src/client/PlayerController.ts`, `src/app/main.ts`. Recorded during phase 5.

### GAP-018 (mine, not the engine's): Quake III winds its triangles clockwise, and nothing complains

- **Status:** not an engine gap. Recorded here because it invalidates two claims made earlier in
  this report, and because the failure mode is worth knowing.
- **What happened:** the maintainer reported that the floor did not render. It did not: every
  world surface in every converted map was wound backwards, so the renderer culled all of them.
  Standing in a room you saw the *far* side of the next room through the near walls, and the floor
  under your feet was simply absent.
- **The cause:** Q3 winds its triangles **clockwise seen from the front**; glTF and meep wind
  counter-clockwise. My converter preserved the source winding on the reasoning that the axis map
  `(x, y, z) -> (x, z, -y)` has determinant +1 and therefore preserves orientation. That reasoning
  is correct and irrelevant: it preserves the winding, and the winding was already the opposite of
  what the target wants.
- **Measured, because "which way does Q3 wind" deserves data rather than recollection.** Comparing
  each triangle's winding-derived normal against its own stored vertex normal:

  | source | agree | disagree |
  |---|---|---|
  | `aggressor` world surfaces | 0 | 3,272 |
  | `oa_dm1` world surfaces | 158 | 7,348 |
  | `oa_dm5` patch tessellation | 6 | 88,378 |
  | `rocketl.md3` | 0 | 204 |

  Uniform across BSP surfaces, patch tessellation and MD3. The handful of agreements are
  degenerate slivers whose normals are ambiguous.
- **The part that stings:** `brushHull.ts` already had this exact fix, with a comment explaining
  that Q3's `BaseWindingForPlane` is clockwise from outside and that Q3 compensates internally by
  computing `CrossProduct(v2, v1)`. I found the convention once, wrote it down, applied it to the
  collision hulls, and never asked whether the render path had the same problem. It did.
- **Why it survived several sessions:** a fully back-facing level does not look like a bug. Walls
  are still walls, geometry is still geometry, and the scene reads as "dim and oddly composed"
  rather than "inside out". I had even written an explanation for it — the withdrawn claim in
  GAP-006 that "the floors read as flat grey" because lightmaps are missing. The floors were not
  grey. They were absent, and I was looking at the background.
- **What would have caught it:** an assertion in the pipeline that a mesh's winding agrees with
  its own vertex normals, which is four lines and is now the first thing I would write in any
  geometry converter. Every format ships normals; they are a free oracle for the winding.
- **What an engine could do:** nothing that would be right in general — a renderer cannot know
  which way a consumer meant to wind. But it is a reminder that "renders something" is a very weak
  signal, and the reason this report leans on measurements rather than screenshots everywhere
  else.
- **Evidence:** `tools/convert-map.ts`, `tools/convert-models.ts`, `tools/convert-characters.ts`.
  Found by the maintainer looking at the screen. Recorded during phase 5.

> Further entries are added as they are hit. Numbering is stable — a withdrawn entry is
> marked withdrawn rather than renumbered.

---

### GAP-019: Q3's per-brush blocking rule cannot be expressed through `shape_cast`

> **Substantially corrected after review.** The first version of this entry was filed as a
> `blocker`, claimed that *every* consumer building a character controller would hit it, and
> claimed that `shape_cast` "silently removes the escape hatch the movement code was written to
> rely on" because `PhysicsSurfacePoint` cannot express `allsolid`. All three claims were wrong,
> and they were wrong because I built a character controller out of the raw query layer while the
> engine ships a kinematic mover for exactly that job — one this report had already *named*, in
> GAP-009, and then never opened. The correction is GAP-021. What is left below is real, and it is
> much smaller than what was here before.

- **Severity:** minor, and as of D-071 **no longer load-bearing for this port at all**. It was a
  Q3-fidelity constraint with a working workaround, never an absence in the engine; the maintainer
  has since reversed the fidelity requirement, so the shipping player runs Q3's motor on
  `KinematicMover` and never asks Q3's contact question. `PhysicsTrace` and the machinery below
  survive only for `?trace=clipmap` and the divergence harness, which measure the ported
  reference rather than the game.
- **What is actually true.** `CM_TraceThroughBrush` is a signed-distance interval test over a
  brush's half-spaces with a ±`SURFACE_CLIP_EPSILON` (1/8 unit) term on both ends, and it returns
  "this brush does not block" for cases where the swept volume demonstrably touches the brush. At
  `oa_dm1` (704.91, 686.92, 24.93), moving one frame at (2.56, 0.58, 0), brush 414 gives:

  | plane | `d1` | `d2` | |
  |---|---|---|---|
  | `(-0.71, 0.71, 0)` | 0.007 | -1.393 | entering: `(0.007 - 0.125) / 1.400 = -0.084` → clamped to 0 |
  | `(0, 1, 0)` | -0.080 | 0.500 | leaving: `(-0.080 + 0.125) / -0.580 = -0.078` |

  `enterFrac < leaveFrac` is `0 < -0.078`, which is false, so the brush **does not block** — with
  the box seven thousandths of a unit from one of its faces and moving into it. `shape_cast` sees
  the swept volume graze that face and reports a hit, correctly, to a different question.

  Taken at face value that stops the player dead: a report of a player stuck in an open corridor
  with velocity climbing to 320 units a second against a position that never changed, and a bot
  apparently standing in mid-air against a wall, which was not what it was doing — it had stopped
  falling.
- **Why this is a Q3 constraint and not a general one.** The brief makes `bg_pmove` fidelity
  non-negotiable, and pmove is written against that exact predicate. Any other narrowphase
  produces different contact fractions, therefore different clip planes, therefore different
  strafe jumps. That is a constraint this port chose to honour; it is not a defect in a query
  that answers a different, reasonable question correctly. **A consumer who does not need Q3's
  arithmetic does not have this problem, and should be using `KinematicMover` (GAP-021).**
- **What I got wrong about `allsolid`, specifically.** The first version said Q3 separates "began
  inside a brush the sweep leaves" from "began inside and never gets out", that pmove's recovery
  path (`PM_CorrectAllSolid`) is gated on the second, and that a backend built on `shape_cast`
  therefore loses the escape hatch. The first two sentences are right. The third is false:
  `compute_penetration` is **public**, is documented at length, returns the minimum translation
  that separates two shapes, and is precisely the depenetration primitive that case needs. The
  engine's own `DESIGN_COLLISION.md` calls it "a **core step** ... because `compute_penetration`
  is public", and names the start-solid case as what it is for. I did not find it, and I asserted
  its absence rather than checking.
- **Workaround (unchanged, and still correct for this port):** run the ported brush test over the
  brushes `overlap_shape` finds, and when `shape_cast` names a body whose brush that trace has
  already cleared, treat the contact as answered rather than as a blocker
  (`PhysicsTrace.alreadyRuledOn`). meep still does the sweep. This needs the source half-spaces
  kept alongside the `ConvexHullShape3D`, which a port from BSP brushes has and an application
  whose hulls came from a mesh does not.
- **What it costs at runtime** (`npm run bench-match`): one trace on the shipping path costs
  4.53 µs against 0.42 µs for the ported clipmap answering the whole question; `shape_cast` alone
  is 3.49 µs of it and `traceBrushList`, which produces the fraction, plane and solidity flags, is
  0.29 µs. A six-bot deathmatch is 356 µs a frame on meep's physics and 31 µs on the clipmap, for
  an identical match.

  That 11× is **the cost of this port's decision to keep Q3's arithmetic while running on meep's
  broadphase**, and it should be read that way rather than as a price the engine imposes. A
  consumer using `KinematicMover` pays for one sweep, not for a sweep plus an overlap plus a
  re-derivation.
- **What would still be worth having**, stated as a small API request rather than as a gap: a
  directional term on the result — the separating-axis distance at `t = 0` signed against the
  sweep direction, which the query already computes and discards. It would let a consumer
  distinguish "resting against" from "moving into" without a second query. That is genuinely
  useful and genuinely minor.
- **Cost:** ~4 hours, in two rounds. Recorded because the shape of it generalises: several
  independent places where a Q3 semantic was approximated rather than reproduced, each
  individually plausible, failing together. But a fair share of those four hours is attributable
  to GAP-021 rather than to the engine.
- **Evidence:** `src/client/PhysicsTrace.ts` (`trace`, `contactPlane`, `alreadyRuledOn`),
  `test/physics-wedge.test.ts` (the `walking` half), `tools/trace-compare.ts`. Measured
  improvement: trace hit/miss agreement 88.7% → 99.9%, strafe-jump p90 121.3 → 34.0,
  walk-into-walls p90 1.77 → 0.22, and zero sweeps where the physics passes through something the
  clipmap blocks. See D-063, and D-070 for the correction.

### GAP-020 (withdrawn): the swept query has no standoff, because the standoff belongs one layer up

> **Withdrawn.** The original entry said there was "no way to ask a swept query to stop short of
> contact", that "every character controller needs a standoff ... what is missing is a way to
> *say* it to the query", and asked for a `standoff` / `skin_width` parameter on `shape_cast`,
> citing PhysX, Bullet and Unity. It was filed as a `blocker`.
>
> The engine has the parameter. It is called `skin`, it defaults to `0.005 m`, and it is a
> constructor option on `KinematicMover` — the kinematic character solver meep ships, which this
> report had already named in GAP-009 before dismissing the directory it lives in. The engine's
> `DESIGN_COLLISION.md` lists it in a constants table with its lineage (`Fauerby
> veryCloseDistance ~0.005`) alongside `MIN_WALK_NORMAL 0.7` from Quake 3 and `numbumps 4` from
> Quake. The same document names the exact symptom I reported — "Band-test + active snap ... is
> what structurally kills the landing **bounce**" — as a solved problem.
>
> So the design decision the entry asked for has been made, deliberately, in the other direction:
> the standoff lives in the mover rather than in the query, which is where PhysX and Unity put it
> too (`CharacterController.skinWidth` is on the controller, not on `Physics.SphereCast`). The
> entry was not describing a gap. It was describing a layer I had chosen not to use and then not
> read. See GAP-021.

**What actually happened, kept because the failure is instructive.** Q3 stops a box
`SURFACE_CLIP_EPSILON` (1/8 unit) short of a surface, so a move ending a twentieth of a unit
above the floor is *blocked* in Q3 and *clear* in `shape_cast`. This port's first implementation
subtracted the epsilon from the returned fraction, which is the same thing whenever the sweep
reaches the surface and silently different when it stops just short. The player overshot the
resting height by a tenth of a unit, bounced back up at landing speed, and repeated forever.
`groundEntityNum` never left `ENTITYNUM_NONE`, so the animation code played the jump clip, so
every bot in the level stood with its legs tucked up. 63 of 64 dropped players never landed.

The fix is to put the epsilon in the *shape*: for a box against a plane, offsetting the plane
outward by `e` is exactly growing the box by `e`, so the sweep uses a box inflated by
`SURFACE_CLIP_EPSILON` and the fraction is `hit.t / length` with nothing subtracted.

**The one part of this that is still worth a maintainer's attention** is not the missing
parameter, it is the failure mode: a rare, systematic, single-signed error is invisible to every
percentile and fatal to a feedback loop. Agreement with the C oracle was already 99.9% and the
fraction error was 1.3e-3 — three hundredths of a millimetre — at the moment nothing could land.
That is an argument for the standoff being solved *somewhere the consumer will find it*, which
is what `KinematicMover` does and what GAP-021 is about.

- **Severity:** withdrawn. Was `blocker`; was not a gap.
- **Evidence:** `src/client/PhysicsTrace.ts` (`boxShape`'s `grow`), `test/physics-wedge.test.ts`
  (the `standing` block), and against it
  `src/engine/control/first-person/collision/KinematicMover.js` (the `skin` option) and
  `src/engine/control/first-person/DESIGN_COLLISION.md` §7. Measured improvement on `oa_dm1`:
  trace hit/miss agreement 99.9% → 100.0%, fraction absolute error p90 1.3e-3 → 5.3e-8, chaos
  divergence p90 0.18 → 0.00. See D-064, and D-070 for the withdrawal.

### GAP-021 (mostly mine, not the engine's): the kinematic character solver is namespaced inside a controller it does not depend on

- **Severity:** minor, and the engine-facing half is one directory move.
- **What happened.** This port spent about six hours, across four player-reported failures,
  building slide-move plumbing on top of `shape_cast` and `overlap_shape`: a standoff, a
  start-solid recovery path, a contact-plane rule, a "did this actually block" predicate. meep
  ships `KinematicMover`, 635 lines, which does the first two of those and is explicit about its
  lineage — `MAX_CLIP_PLANES = 5` "matching Quake's", crease handling "Quake `SV_FlyMove`",
  `minWalkNormal = 0.7` "Matches Quake3 `MIN_WALK_NORMAL`", four slide iterations "Quake
  `numbumps` 4". Beside it is `DESIGN_COLLISION.md`, 365 lines, which sets out the whole
  recover → slide → stairs → ground → settle sequence, with a constants table and reference
  lineage for each value.

  I did not read either. Two things caused that, and only the second is the engine's:

  1. **GAP-009.** I evaluated `FirstPersonPlayerController`, correctly concluded it was a
     feel-first opinionated controller that cannot host `bg_pmove`, and wrote that up. In the
     same entry I *named* `KinematicMover` — "a `KinematicMover` with stair and ramp handling" —
     and then treated the whole `engine/control/first-person/**` tree as decided. Two phases
     later I filed its capabilities as missing from the engine. That is my error, it is the third
     time in this report that a conclusion about one thing was allowed to cover its neighbours
     (see GAP-007 and GAP-016), and it is the most expensive of the three.
  2. **The path.** `KinematicMover`'s own docblock says "The mover is controller-agnostic: it
     knows about a capsule pose, a desired velocity, and the physics world." Its imports confirm
     it: `Vector3`, `Ray3`, `Transform`, `Collider`, `compute_penetration`,
     `PhysicsSurfacePoint` — nothing from the controller. It nonetheless lives at
     `engine/control/first-person/collision/KinematicMover.js`, and the most useful collision
     document in the package lives at `engine/control/first-person/DESIGN_COLLISION.md`. A
     consumer who has decided the first-person controller is not for them has been given a
     path that says those files are not for them either.
- **Would it have been used?** For the slide-move itself, no: `move()` *is* the slide loop, and
  replacing `PM_SlideMove` is precisely what the brief forbids. That is a GAP-009-shaped
  positioning finding and it should have been written up as one. But `compute_penetration` would
  have answered `PM_CorrectAllSolid` directly, the `skin` option would have removed GAP-020 in
  its entirety, and `DESIGN_COLLISION.md`'s constants table would have been the single most
  useful page in the package for this port's hardest phase. Reading 1,000 lines would have saved
  several hours and two wrong fixes.
- **Suggested fix:** move the solver and its design document to
  `engine/physics/character/` (or `engine/control/character/`) and leave a re-export behind. The
  class already has no controller dependency, so this is a path change, not a refactor. Anyone
  searching the package for how to move a character should reach a directory named for that,
  not for one specific controller's implementation detail.
- **Second, smaller ask:** `DESIGN_COLLISION.md` is written as a build plan ("Phase 1 implements
  steps 1-2"), so a reader who does find it has to work out how much of it is shipped.
  `KinematicMover`'s docblock says "Phase 1" too, while implementing step-up and ground
  categorisation that the plan puts in phases 2-3. A one-line status header would resolve that.
- **Evidence:** `src/engine/control/first-person/collision/KinematicMover.js`,
  `src/engine/control/first-person/DESIGN_COLLISION.md`,
  `src/engine/physics/narrowphase/compute_penetration.js`, and REPORT GAP-009 (where I named the
  class and moved on). Recorded in phase 6, after review. See D-070.

### GAP-022: `KinematicMover` has no moving-platform support, and does not return enough for a consumer to add it

- **Needed:** a character standing on a rising lift, a moving walkway or a swinging door goes with
  it. Q3 does this in `G_MoverPush`, which is one of the two halves of `func_plat`, `func_door`
  and `func_train` being usable at all; the other half is that they block you.
- **meep offers:** nothing, in either direction. `DESIGN_COLLISION.md`'s five-step sequence —
  recover → slide → stairs → ground → settle — has no platform step, and neither the shipped
  phases nor the roadmap mentions one. The gap is not just the feature: `move()` returns
  `{hit, grounded, groundNormal}`, so the consumer is told *that* they are on a walkable surface
  and never *what* they are on. Every ingredient for writing the carry yourself — the ground
  body id, its velocity, its delta since last frame — is inside `_categorizeGround` and none of
  it comes back out.
- **Workaround:** `carryDisplacement` in `src/game/Movers.ts`, ~50 lines, about an hour. It runs
  outside the solver, after the movers have moved and before the next solve, and re-derives the
  rider test from Q3's own rule: horizontally inside the mover's box, and feet within a band
  above its top. It works because the port already keeps a full mover simulation of its own for
  Q3's door and plat state machines, so the displacement is known; a consumer whose platforms are
  ordinary kinematic bodies driven by an animation would not have that and would have nothing to
  work from.
- **Severity:** minor for this port, major for the solver's stated positioning. It is minor here
  only because the port had a parallel mover simulation to read from. `DESIGN_COLLISION.md`
  benchmarks the design against Jolt's `CharacterVirtual` and Source's
  `TryPlayerMove`+`CategorizePosition`, and both of those carry the character: Jolt exposes
  `GetGroundBodyID`/`GetGroundVelocity` and Source's `CategorizePosition` records
  `m_hGroundEntity`. A kinematic character solver that cannot stand on a lift is not finished,
  and every 3D game with a lift in it needs this.
- **Suggested fix:** the cheap half first — put the ground body on `MoveResult` (`groundBody`, or
  the id, next to `groundNormal`). `_categorizeGround` already has it and dropping it is the only
  reason a consumer cannot solve this themselves. The full half is a platform step between ground
  and settle: if the ground body moved since last frame, apply its delta to the character before
  the next recover.
- **Evidence:** `src/engine/control/first-person/collision/KinematicMover.js` (`MoveResult`,
  `_categorizeGround`), `src/engine/control/first-person/DESIGN_COLLISION.md` §4 and the phase
  list; workaround at `src/game/Movers.ts::carryDisplacement`, exercised end to end by
  `test/player-controller.test.ts` ("lets a plat carry the player standing on it"). Found in
  phase 7 while writing that test; see D-075.

## 4. Ergonomics

Observations that are not gaps — the facility exists and works — but cost time or attention.

- **`exports` is deep-import-only, and that is the right call, but it is undocumented.**
  `@woosh/meep-engine` has no root export: `exports` maps `./build/*`, `./src/*`, `./editor/*`
  and `./*.md`, so every import is a full path to a source file
  (`@woosh/meep-engine/src/engine/EngineHarness.js`). This is what makes the "molecular
  modularity" claim in the README real, and TypeScript resolved the paired `.d.ts` files
  without any configuration beyond `moduleResolution: "bundler"`. But nothing in the README
  says the package has no main entry, so the first instinct —
  `import { Engine } from '@woosh/meep-engine'` — fails with a bare
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, and recovering means reading `package.json`.
- **Class-per-file with the filename as the export name makes the source navigable.** Finding
  the decal system meant `ls engine/graphics3/ | grep -i decal`. With 5953 modules and no
  index, this convention is doing a lot of work.
- **The docblocks explain *why*, not *what*.** `ShadedGeometrySystem3`'s header explains why
  the component and the renderer row are the same shape and why a model is not one of these;
  `Geometry.version` explains why nothing infers staleness. This is rare and it substituted
  successfully for the missing samples more than once.

### Added during phase 1

- **A scene with no environment map renders black, silently.** `make_default_environment`'s
  docblock is admirably clear — *"Shade assumes global illumination... a scene with no
  environment renders unlit. So the default is something the engine provides"* — but you only
  read it if you already suspect the environment. What you actually see is correct geometry,
  correct materials, correct textures, and a black screen; every instinct says material bug.
  `EngineHarness.buildBasics` sets one up for you, so this only bites the moment you stop
  using the harness's all-or-nothing helper and register systems yourself, which is the moment
  you stop being a beginner. **Cost: ~25 minutes.** A dev-mode warning on the first frame
  rendered with no environment would remove this entirely.

- **The camera uses the object convention (+Z forward), not the glTF/three convention.** This
  is a deliberate, defensible choice and `camera_sync_from_transform` documents it well,
  including that it was *measured* (64 of 64 instances in frustum one way, 0 of 64 the other).
  The problem is placement: that fact lives in the docblock of a function a consumer never
  calls, and nothing on `Camera` or `Transform` mentions it. A hand-built view quaternion that
  assumes -Z forward points the camera exactly backwards, and in a closed level that presents
  as *a dark scene*, not a reversed one — you are outside the geometry looking at culled
  backfaces. I diagnosed it as a lighting problem first. **Cost: ~35 minutes.** One line on
  `Camera` would have prevented it. Using `Quaternion.lookRotation` and letting the engine own
  the convention is the fix, and is what the port now does.

- **`exports` has no `./package.json` entry**, so `require.resolve('@woosh/meep-engine/package.json')`
  — the standard way for tooling to locate a package root — throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Found by crashing a Vite config. One line to fix.

- **The engine's own performance log is `console.warn`.** `FPS: 238.12, RENDER: 1.58ms,
  SIMULATION: 0.06ms` once a second, at warn level, on by default. During the GAP-003/GAP-004
  diagnosis the real errors scrolled out of the console behind it. `console.debug`, or off by
  default, would be better.

- **`EntityManager` has no `update`; the method is `simulate`.** Minor, but the ECS is the
  thing a consumer touches most and the name is not the conventional one. Discovered by
  enumerating the prototype.

### Added during phase 2

- **A design document says "no implementation yet" above 3,690 lines of implementation.**
  `engine/control/first-person/DESIGN.md` opens with *"Status: **Draft** — design doc. No
  implementation yet"*, and then lists the companion files as "(planned)". All of them exist and
  are substantial. This is the one place in the engine where the documentation actively
  misleads: I nearly skipped evaluating the controller entirely on the strength of that header.
  A stale status line is cheap to fix and expensive to leave.

- **~~`ShadeMaterial.draw_side` is the model to copy.~~ Withdrawn — it was the opposite.** I
  praised this field for a docblock that says it has no effect and spells out the workaround. The
  docblock is stale: `Front` and `Double` both work, and believing it cost the port double-sided
  surfaces for its whole life (GAP-007). The two entries above and below this one are about
  documentation that is *right*; this one belongs with the `DESIGN.md` header instead, as
  documentation that is confidently wrong. A stale comment is worse than a missing one, because
  it is believed by exactly the reader who checks first.

### Added during phases 3-5

- **Required registrations are discoverable only by reading the class you did not know to
  open.** Three times now: `ColliderObserverSystem` (GAP-014), the `x-meep/image-bitmap` loader
  that the glTF loader's *own dependencies* need, and `MeshSystem3`'s `load` callback. Each is
  documented where it lives and referenced from nowhere the consumer is already looking. The
  image-loader one is the mildest and the most instructive: the error arrives from inside
  `tiny-gltf`, once per texture, as an unhandled rejection naming a type the application never
  mentioned. Sixteen identical lines that do not name the model, the material or the file.

- **`BodyKind.KinematicPosition`'s docblock is the best thing I read in the package.** It says
  the kind is reserved and not implemented, explains precisely how it misbehaves ("pose-driven
  movers currently present to the solver as stationary walls that teleport"), explains *why* it
  is deferred rather than broken (deriving velocity from transform deltas would make a spawn snap
  read as an enormous velocity), and says what to use instead. That is four things most "TODO"
  comments do not say, and it turned a potential afternoon into a two-minute decision.

- **`ShadedGeometryFlags.DeferredBoundsUpdate` documents a trade rather than a feature.** It
  gives the rule for when to set it (a transform written more than once between reads), the rule
  for when not to (written exactly once), and the measured numbers on both sides -- 20-25% off a
  frame in one direction, 10-20% worse in the other. Bobbing items and moving doors set it on
  that basis rather than on a guess.

- **`ClipListPlayer` warns once per missing clip name and prints the model's real clip list
  beside it.** The right diagnostic, in the right place, at the right frequency. It is worth
  naming because GAP-015 makes it fire with an empty name, which is the one case where a good
  message does not help -- fixing the API would let this message do its job.

- **"clip must have at least one channel" is a good assertion in the wrong place.** It fires
  inside `MeshSystem3` and names neither the model nor the clip, so a fifteen-character roster
  becomes fifteen candidates. The condition it catches is real and worth catching -- the fix on
  this side was three separate defects in the exporter (D-057) -- but the message would be worth
  the model URL. Contrast `ClipListPlayer`'s missing-clip warning, which prints the model's whole
  clip list beside the name it could not find.

- **The engine's own docblocks argue with themselves productively.** `AudioEmitterSystem`'s
  explains why only looping events take the spatially-managed path, which is exactly the fact
  that decided this port plays one-shots through sopra directly. Reading it saved a design
  mistake that would have shown up as entity churn at ten allocations a second.

---

## 5. Performance

### Phase 0 baseline — empty lit scene

Host: Windows 11, Chrome, WebGPU on `nvidia/lovelace`. Scene is `EngineHarness.buildBasics()`
with terrain on, water off, one directional light with a 2048 shadowmap.

| metric | value |
|---|---|
| FPS | 222–238 |
| render | 1.58–1.87 ms |
| simulation | 0.06–0.07 ms |
| geometry build | 0.21 ms |
| BVH update | 0.14 ms |
| Vite dev-server ready | 271 ms warm, 1212 ms after a config change forces re-optimisation |
| ES modules fetched to first frame | 250 |

Two things worth flagging early:

- **250 module requests to first frame is fine in dev and would not be fine unbundled in
  production.** It is the direct cost of the molecular-modularity design and it is the right
  trade, but it means the "no build step" path is a development-only path. Nothing in the docs
  says so.
- **The engine's own performance reporting is on by default and goes to `console.warn`.**
  `FPS: 238.12, RENDER: 1.58ms, SIMULATION: 0.06ms` at warn level, every second, mixed in with
  real warnings. Useful data, wrong channel — this made reading the console for actual errors
  materially harder during the GAP-003/GAP-004 diagnosis, because the genuine failures scrolled
  away behind it.

### Phase 1 — converted Q3 levels

Same host. Frame cost is measured by timing `entityManager.simulate()` + `graphics.render()`
in a tight loop with the camera rotating, so it is **CPU submission cost**, not GPU frame time —
`render()` returns once the frame is submitted. It is the number that bounds how much CPU a
game has left, which is the one this port cares about.

| map | triangles | meshes | point lights | CPU ms/frame | implied FPS |
|---|---:|---:|---:|---:|---:|
| `aggressor` | 3,263 | 23 | 63 | 3.96 | 253 |
| `am_thornish` | 198,740 | 45 | 147 | 7.28 | 137 |

**147 dynamic point lights cost nothing measurable.** `am_thornish` is 60× the triangles of
`aggressor` and 2.3× the lights, for 1.8× the frame cost. The clustered lighting claim in the
README holds up: the cost scaled with geometry, not with light count. Since Q3's static
lighting had to be reconstructed as dynamic lights anyway (GAP-006), this is the difference
between the port being possible and not.

Simulation cost with 53 entities is **0.003 ms/frame** — below the noise floor of
`performance.now()`. The ECS is not going to be the bottleneck.

Load time, cold, from the local dev server:

| map | fetch | materials + textures | meshlet build | lights | total |
|---|---:|---:|---:|---:|---:|
| `aggressor` | 5 ms | 39 ms | 53 ms | 14 ms | 111 ms |
| `oa_dm1` | 4 ms | 25 ms | 74 ms | 1 ms | 104 ms |
| `am_thornish` | 31 ms | 73 ms | **1,246 ms** | 3 ms | 1,353 ms |

Meshlet construction is 92% of load time on the large map and is synchronous — see GAP-008.
It is the only part of this table that would need work in a real title.

### Phase 2 — collision and movement

Not meep's numbers — this is the port's own arithmetic, and it does not use meep's physics
(D-007). Included because the maintainer will reasonably ask what a fixed-physics shooter costs
in pure JavaScript, and because it bears on GAP-009.

Everything runs in `Math.fround`-wrapped float32 to match the C bit-for-bit, which is the
slowest reasonable way to write it:

| suite | work | wall clock |
|---|---|---|
| `CM_BoxTrace` differential | 100,000 randomised player sweeps across 5 maps, each run twice (port + WASM oracle) | 1.47 s |
| Position tests | 100,000 degenerate traces across 5 maps, twice | included above |
| `CM_PointContents` | 100,000 queries across 5 maps, twice | included above |
| `Pmove` differential | 3 maps x 6 patterns x 40 episodes x up to 240 frames, both implementations | 2.17 s |

Reading the trace figure: 200,000 box traces against real BSP geometry in well under a second,
including the WASM half. A movement frame issues roughly ten traces, so the collision budget for
a 125 Hz server tick is not a constraint even at this precision.

Peak horizontal speed reached in the movement suite was **523 units/s against a 320 base**,
which is the number that says strafe jumping is actually working rather than merely not
crashing.

### Phase 2b — meep physics as the collision backend

Same levels, same input, three configurations: the C oracle under Emscripten, the ported
`cm_trace`, and meep's `PhysicsSystem`. The ported clipmap is bit-exact against the oracle
(control divergence reads exactly `0.0e+0`), so every figure below is attributable to the
physics backend. Distances are Q3 units — one unit is about 3 cm, a player is 56 units tall.

**These are the phase 6 numbers, after the standoff and the per-brush rule were corrected**
(GAP-020, GAP-019). The phase 2b figures they replace are kept below them, because the delta is
what those two entries are ultimately about — and it stands whatever the entries are graded at.
Reproduce with `npm run divergence`.

| | `oa_dm1` | `aggressor` |
|---|---|---|
| solid brushes → static bodies | 575 → 529 | 835 → 820 |
| hull generation | 7 ms | 7 ms |
| body + collider construction | 12 ms | 8 ms |
| sweeps sampled | 20,000 | 20,000 |
| agree on hit/miss | **100.0%** | **100.0%** |
| sweeps the physics blocks and the clipmap does not | 5 | 1 |
| sweeps the clipmap blocks and the physics does not | **0** | **0** |
| contact normals agreeing | 99.5% of 1,120 valid-plane hits | 99.9% of 1,319 |
| sweep fraction error, median / p90 | 0.0 / **5.3e-8** | 0.0 / **1.3e-7** |

Against phase 2b's 88.2% / 89.6% hit-miss agreement and 1.5e-3 fraction error, that is three
orders of magnitude on the fraction and a clean sweep on the predicate. The direction matters
more than the size: **zero** sweeps where the physics passes through something Q3 blocks. That
asymmetry is the safety property — a backend that misses a wall puts a player inside geometry,
and a backend that invents one costs a little movement.

Position divergence after 240 frames of identical input, both maps:

| input pattern | `oa_dm1` median / p90 / ≤1u | `aggressor` median / p90 / ≤1u |
|---|---|---|
| strafe-jump | 0.00 / 38.15 / 77% | 0.00 / 9.20 / 88% |
| bunny-hop | 0.00 / 0.09 / 97% | 0.00 / 0.68 / 91% |
| walk-into-walls | 0.00 / 0.11 / 94% | 0.05 / 3.66 / 85% |
| chaos | 0.00 / 0.00 / 100% | 0.00 / 0.00 / 99% |
| *control (ported clipmap), max* | *0.0e+0* | *0.0e+0* |

Read the medians, not the maxima. Two runs that separate at frame 100 and then explore different
parts of a level produce an arbitrarily large number; that is chaos, not error, and the `first>1u`
frame in the tool's own output is the honest way to read it. What the medians say is that the
physics backend and Q3 now agree **exactly** on the typical frame — the median is zero, not
merely small — and that strafe-jumping, the pattern most sensitive to which plane a grazing
contact reports, is still the one that eventually separates. D-031 records what is still
different and why one plausible fix for it was 8× worse.

For the record, phase 2b's table before the two gaps were fixed: strafe-jump 0.17 / 271.0 / 62%,
bunny-hop 0.06 / 0.12 / 98%, walk-into-walls 0.09 / 2.60 / 89%, chaos 0.00 / 1.28 / 90%.

Cost of the swap, for a maintainer estimating similar work: ~14 hours to get it shipping, of
which roughly 2 were `brushHull.ts` (the plane-set-to-polyhedron conversion), 2 were GAP-012, and
the remaining 10 were building the three-way measurement harness — **plus a further ~6 hours in a
later session** for the standoff and the per-brush rule, which is the part worth flagging to
anyone estimating this work — and which GAP-021 argues should have been closer to one hour with
the engine's own solver read rather than assumed absent. The first fourteen hours produced something that measured well and could not be
played; the last six are what made it playable, and they arrived as four separate bug reports
from someone in front of the screen rather than from any number in the table above.

The harness is still why the whole thing was possible — without a bit-exact control, "close
enough" is a matter of opinion — but the harness measured 88% agreement and called it acceptable
while a player was frozen in an open corridor. The lesson is not that measurement failed. It is
that *sweep agreement* was the wrong summary statistic: the disagreements were rare, and every
one of them was catastrophic rather than small.

### Phase 6 — what a match costs, and where the collision time actually goes

Reproduce with `npm run bench-match`. Six bots and one standing player, 30 simulated seconds at
125 Hz (Q3's `sv_fps`), no renderer, no engine boot. Node v24.15.0.

**Re-taken on meep 3.2.0, with movement on `KinematicMover` (D-071, D-072).** The earlier version
of this table measured `bg_pmove` driving `PhysicsTrace`, which is now the `?move=q3` path; both
are here because the difference is the point.

| | `oa_dm1` | | `aggressor` | |
|---|---:|---:|---:|---:|
| movement + collision | Q3 motor on `KinematicMover` | ported `bg_pmove` on the clipmap | Q3 motor on `KinematicMover` | ported `bg_pmove` on the clipmap |
| static body construction | 18 ms | — | 12 ms | — |
| navigation graph build | 154 ms | 31 ms | 109 ms | 23 ms |
| **simulation, per frame** | **178 µs** | 35 µs | **266 µs** | 25 µs |
| traces per frame (6 bots) | **6.0** | same by construction | **6.0** | same by construction |
| distance walked, all bots | 27,727 | 31,073 | 24,391 | 25,003 |
| shots fired | **374** | 110 | **220** | 420 |
| pickups taken | **16** | 10 | **16** | 16 |

The trace count is the number to read: **6.0 a frame against the 30.4 the old arrangement needed**,
because `KinematicMover` resolves a move in one recover-slide-ground sequence where
`PM_SlideMove` through `PhysicsTrace` issued a sweep per bump plus a ground trace plus the
per-brush re-derivation. Frame cost halved on `oa_dm1` (356 µs → 178) even though each remaining
query does more work.

For the record, the arrangement this replaced — `bg_pmove` driving meep's physics through
`PhysicsTrace`, measured on 3.0.2: 356 µs and 30.4 traces a frame on `oa_dm1`, 248 µs and 25.2 on
`aggressor`.

The two backends produce the same match — the bots walk the same distance to within 3%, take the
same pickups, fire the same number of shots — and one costs **eleven times** what the other does.
A whole deathmatch at 356 µs a frame is still nothing next to a 16.7 ms budget, so this is not a
performance problem for this port. It is a *finding*, and it wanted decomposing:

| one trace on `oa_dm1`, meep 3.2.0 | |
|---|---:|
| `PhysicsTrace.trace` — the `?move=q3` path | 3.69 µs |
| `boxTrace` — ported clipmap, answering the entire question | 0.29 µs |
| of that path: `shape_cast` alone | 3.06 µs |
| of that path: `overlap_shape` alone | 1.15 µs |
| of that path: `traceBrushList` over 8 brushes | 0.22 µs |

Mean of 20,000 calls after a 2,000-call warm-up, shapes cached exactly as `PhysicsTrace` caches
them, so this is not measuring allocation.

**The part that decides the answer is the cheapest line in the table.** `traceBrushList` is the
ported `CM_TraceThroughBrush`: it produces the fraction, the contact plane, `startsolid` and
`allsolid`, and it costs 0.22 µs. `shape_cast` costs fourteen times that to find which body is
nearest, and its own fraction and normal are then discarded on every blocking contact (GAP-019,
GAP-012). The complete ported clipmap — BSP tree descent, leaf gather, every brush test — answers
the whole question for less than a tenth of what `shape_cast` costs on its own.

**This table is now about the road not taken.** It measures `?move=q3`, the configuration that
kept Q3's contact semantics on meep's broadphase. The shipping path does not do this any more: it
asks `KinematicMover` for a move and gets one, at 6.0 queries a frame instead of 30.4. The
decomposition is kept because it is the clearest statement of what reproducing another engine's
narrowphase costs, and because the ratio is the evidence behind GAP-021's argument that a consumer
should adopt the solver rather than rebuild around the queries.

Two things follow, and the maintainer should weigh them separately:

- **This is not a criticism of `shape_cast`'s implementation.** It is doing more: a general
  convex-vs-convex sweep against a broadphase that supports arbitrary shapes and moving bodies,
  where the clipmap is a BSP descent over axis-aligned brushes with precomputed planes and a
  fixed contents mask. Special-purpose beats general-purpose; that is what special-purpose is
  for. The number is here because a maintainer sizing "should the engine offer a character
  controller" needs to know the shape of the trade.
- **It is the cost of this port's own constraint, not a price the engine imposes.** An earlier
  version of this paragraph attributed the 11× to two gaps and said closing them would collapse
  three queries into one. That was wrong in a way worth correcting rather than deleting: meep
  ships `KinematicMover`, whose whole job is to be the one query, with the standoff and the
  depenetration built in. A consumer using it pays for a sweep. This port cannot use it, because
  `move()` *is* the slide loop and the brief makes `PM_SlideMove` fidelity non-negotiable — so
  what the 11× measures is **what it costs to keep Quake III's arithmetic while running on meep's
  broadphase**, which is a trade this port chose. See GAP-021.

  The residual engine-side ask is small and stands: a directional term on the sweep result — the
  separating-axis distance at `t = 0` signed against the sweep direction, already computed and
  discarded — would let a consumer distinguish "resting against" from "moving into" without the
  second `overlap_shape` query, which is the 1.18 µs row.

The ratio is also worse in the match (11×) than in the microbenchmark (7×), and the reason is
worth a sentence: the expensive branch of `PhysicsTrace` is the one taken at a *resting* contact,
where `shape_cast` reports `t ≈ 0` and the whole per-brush re-derivation — `overlap_shape`, the
neighbour gather, the per-brush re-derivation — has to run to decide what kind of contact it is.
A player standing on a floor is in that branch on every frame. The microbenchmark's mid-air
sweeps mostly are not.

### Phases 3b-5 — items, movers, characters, audio, bots

Same host. Load-time figures are from `oa_dm1`, which is a small map; `am_thornish` is the large
one and is called out where it differs.

| stage | cost | note |
|---|---|---|
| static bodies from brushes | 8-22 ms | 529 bodies on `oa_dm1` |
| items: place and build | 36-88 ms | 31 pickups, 55 drawn pieces, meshlets built lazily |
| movers | <1 ms | 6 brush entities, 6 kinematic bodies |
| navigation graph | 165 ms | 766 nodes, 1,957 links, 205 drops -- built through the *physics* trace, which is why it is not the 31 ms the clipmap takes |
| characters | ~40 ms each, async | 15 models, 3 to 10 mesh nodes each; fetched and built off the critical path |
| sound bank | one fetch | 97 names over 77 files, 8.0 MB |

Per frame, measured by driving the simulation directly:

| | cost |
|---|---|
| 6 bots: perception, tree, `Pmove`, character placement (browser, with models) | 1.3-1.8 ms |
| 6 bots: the same simulation with no presentation layer (`npm run bench-match`) | 0.36 ms |
| of which planning, when it runs | one BFS plus one A* per bot, at most every 0.25 s |

Those two rows are the same code and differ by a factor of four, which is worth stating plainly:
roughly three quarters of "bot cost" in the browser is `Character.place` writing 30 rigged parts'
worth of `Transform`s and the clip player consuming them, not AI. The headless figure is the
honest cost of the *simulation*; the browser figure is the cost of the simulation plus drawing
six animated characters, and a maintainer reading "bots cost 1.8 ms" should know which one they
are looking at.

The bot cost is worth two further notes. It started at 3.7 ms a frame for *six stationary bots*,
all of it A* failing to route to the same unreachable item every frame -- a reachability pass
before scoring fixed the behaviour and the cost together. And the planning rate limit is not a
tuning knob for performance so much as a correctness one: the planning branch is the tree's
fallback, so it runs on every frame a bot has nothing else to do.

The character pipeline is offline and worth recording for anyone estimating similar work: 15
characters, 30 rigged parts, 5.8 seconds total, including the skinning decomposition (k-means over
vertex trajectories, then Kabsch per cluster per frame, then reassign, six passes).

### Asset pipeline, for scale

Not meep's numbers, but they establish what the engine was fed. 4,370 files flattened from 8
pk3s in Q3 load order; 104 `.shader` scripts yielding 2,154 entries and 1,924 unique shader
names, with 214 name collisions across files and 4 parse warnings. The Q3 → PBR projection
drops, in total across the OA shader set: 1,679 `tcMod`, 982 non-benign `rgbGen`, 911 `tcGen`,
413 `alphaGen`, 93 `animMap`, 2 `deformVertexes`, 1 `videoMap`. That is the measured lossiness
of the material conversion — every one of those is a surface that animated in Q3 and does not
here.

---

## 6. Engine bugs

Behaviour that contradicts the engine's own documentation, its own package manifest, or its own
emitted types. Every reproduction here is the whole reproduction — no engine boot, no graphics
device, no application — and every one was re-run against **3.2.0** after the upgrade.

**Status after 3.2.0:** BUG-6 and BUG-7 are fixed. BUG-1 to BUG-5 still reproduce exactly as
written; the `.d.ts` error count moved from 664 across 152 files to **674 across 154**, which is
drift rather than change.

These are separated from the gap register on purpose. A gap is "the engine does not do this"; a
bug is "the engine says it does this and does something else". The second kind is more expensive
per line of documentation, because the reader who checks first is the one who gets caught.

### BUG-1: `new Animation({ clips })` accepts the documented type and silently discards it

`Animation`'s constructor documents `@property {List.<AnimationClip>} clips` and its field is
`@type {List<AnimationClip>}`. It forwards to `fromJSON`, which rebuilds each entry with
`AnimationClip.fromJSON` — and that reads `json.name` only `if (typeof json.name === "string")`.
On a real `AnimationClip`, `name` is an `ObservedString`, so the branch does not fire.

```js
import { Animation } from '@woosh/meep-engine/src/engine/ecs/animation/Animation.js';
import { AnimationClip } from '@woosh/meep-engine/src/engine/ecs/animation/AnimationClip.js';

const clip = new AnimationClip();
clip.name.set('TORSO_STAND');
clip.repeatCount.set(-1);

const animation = new Animation({ clips: [clip] });
const stored = animation.clips.get(0);

stored instanceof AnimationClip;   // true
stored === clip;                   // false  <- rebuilt
stored.name.getValue();            // ""     <- name gone
stored.repeatCount.getValue();     // 1      <- -1 gone
```

Every diagnostic reports success: the list is the right length, the entry is an `AnimationClip`,
no error is thrown. The model is loaded, both skins are present, and nothing ever plays, because
no clip in the model matches a clip named `""`. Cost: about an hour, all of it spent looking at
the *model* pipeline, since the clip list looked correct.

Fix: accept both forms — `if (c instanceof AnimationClip) use it` before falling through to
`fromJSON` — or make the JSDoc say `Object[]`. Either is a two-line change. Filed at phase 4 as
GAP-015; restated here because it is a contradiction rather than an absence.

### BUG-2: `EngineHarness` hard-imports a peer dependency the package's own manifest marks optional

`@woosh/meep-engine/package.json` declares:

```json
"peerDependencies":     { "dat.gui": ">=0.7.0", "stats.js": ">=0.17.0" },
"peerDependenciesMeta": { "stats.js": { "optional": true } }
```

and `src/engine/EngineHarness.js` line 1 is:

```js
import Stats from "stats.js";
```

Top level, unconditional, in the module that is in practice the entry point. Install the package
without the optional peer and the documented on-ramp fails to resolve. The manifest and the
module disagree, and the manifest is the one a consumer reads.

Fix: dynamic `import()` inside `addFpsCounter`, or drop the `optional: true`. Filed as GAP-003.

### BUG-3: `exports` omits `./package.json`

```js
require.resolve('@woosh/meep-engine/package.json');
// Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './package.json' is not
// defined by "exports"
```

`exports` lists `./build/*`, `./src/*`, `./editor/*` and `./*.md`. Locating a package root by
resolving its `package.json` is what build tooling does; here it throws, and the error arrives
from inside a bundler config rather than from anything the consumer wrote. Node's own
documentation recommends exporting it for exactly this reason. One line. Filed as GAP-003.

### BUG-4: `Terrain` cannot be told where its worker lives

```js
// src/engine/ecs/terrain/ecs/makeTerrainWorkerProxy.js
export function makeTerrainWorkerProxy() {       // <- no parameters
    workerBuilder.importScript('bundle-worker-terrain.js');   // <- resolved against document origin
}

// src/engine/ecs/terrain/ecs/Terrain.js:99
__buildWorker = makeTerrainWorkerProxy();        // <- no argument
```

The file ships in `@woosh/meep-engine/build/`, which is not the web root of any application, and
there is no parameter to say so. The sibling case, `ThreadedImageDecoder`, *does* take a
`worker_path` — so the API shape exists and this one call site did not get it. Two uncaught
promise rejections per terrain, and terrain is on by default in `EngineHarness.buildBasics()`.
Filed as GAP-004.

### BUG-5: the emitted `.d.ts` files do not typecheck, and it is systematic

With this project's own import surface and `skipLibCheck: false`:

```bash
npx tsc --noEmit --skipLibCheck false
```

**674 errors across 154 `.d.ts` files** on 3.2.0 (664 across 152 on 3.0.2). The distribution
says what is wrong:

| errors | code | cause |
|---:|---|---|
| 544 | TS2304 / TS2552 | a name used in the type is never imported into the `.d.ts` |
| 79 | TS2339 | property does not exist on the declared type |
| 33 | TS2416 | an override is incompatible with the base class it declares |
| 8 | TS2425 | a class declares a property the base declares as a method |

The top undefined names are `BinaryBuffer` (58), `Class` (30), `Vector3` (26), `int` (21),
`AssetManager` (17), `View` (15). Two distinct generator faults, both mechanical: a JSDoc type
referenced without a matching `import` produces a declaration referring to a name that is not in
scope, and JSDoc pseudo-types (`int`, `Class`, bare `T`) are emitted verbatim as TypeScript
identifiers.

The consequence is not cosmetic. `skipLibCheck: true` is forced on the consumer, and it is not
scoped to one package — it disables declaration checking for **every** dependency in the project.
A TypeScript consumer of this engine cannot typecheck any of their other libraries.

Two individual cases cost this port real time and are worth naming, because they are the ones
where the emitted type contradicts working code rather than merely failing to resolve:

- **`LabelView`.** Its implementation is `constructor(model, { classList = [], ..., size, css } =
  {})` — the whole bag defaults, so every field is optional at runtime. Its JSDoc brackets four of
  the six and forgets `size` and `css`, so the emitted type declares those two **required**:

  ```ts
  new LabelView(new ObservedString('hi'), { classList: ['x'] });
  // TS2345: ... is missing the following properties: size, css
  ```

  A call the implementation explicitly supports is rejected at compile time.
- **`Collider.shape`** is `AbstractShape3D`, and `AbstractShape3D.equals` is declared
  `<T extends AbstractShape3D>(other: T) => boolean`. Every concrete shape narrows it to
  `(other: BoxShape3D) => boolean`, which is not assignable to the generic form — so *no concrete
  shape is assignable to the field that exists to hold one*. Filed as GAP-013.

Both are corrected in this port with narrow local types rather than `any`, per the brief:
`src/client/Hud.ts` and `src/client/PhysicsWorld.ts`.

### BUG-6 (fixed in 3.2.0): `ShadeMaterial.draw_side`'s docblock described a limitation that no longer existed

On 3.0.2:

```js
// src/shade/renderer/material/ShadeMaterial.js:26
/**
 * Does not affect the actual drawing. Drawing is always done with "Front" mode, with
 * backfaces always being culled.
 * If you want double-sided drawing - you need to clone the geometry and flip normals.
 */
draw_side = ShadeDrawSide.Front;
```

On 3.2.0 the same docblock reads *"Which faces of the geometry are drawn. Faces that are not drawn
are culled, back faces that are drawn are shaded with a flipped normal."* — which is what the code
does. Fixed.

`ShadeDrawSide.Double` works. Setting it is all that is required, and it is what Q3's `cull none`
surfaces need — grates, railings, banners, flags, flame sprites; five materials on `oa_dm1`,
eight on `oa_dm5`, seven on `am_thornish`.

The cost of this one is the clearest argument in the report for treating stale documentation as a
defect: double-sided surfaces went unimplemented for the whole port on the strength of a comment,
by a reader who checked before using the field. It was found only when a later pass questioned
the note. `Back` is the value that genuinely misbehaves on a hand-built material, and the docblock
does not say so. Filed, and withdrawn as a gap, as GAP-007.

### BUG-7 (fixed in 3.2.0): `raycast` reported an immediate hit for a ray starting inside a hull's AABB but outside the hull

**Reported against 3.0.2, fixed in 3.2.0, confirmed here.** Kept in full because the fix is the
end of the story rather than the whole of it, and because the reproduction I first published was
itself defective in a way worth reading.

Found in phase 6 by moving the port onto meep's own `KinematicMover` (D-071), which is the point:
three sessions of building character movement on `shape_cast` and `overlap_shape` found no engine
bug at all, and thirty minutes of using the engine's own solver found this one.

```js
import { PhysicsSystem } from '@woosh/meep-engine/src/engine/physics/ecs/PhysicsSystem.js';
import { RigidBody }    from '@woosh/meep-engine/src/engine/physics/ecs/RigidBody.js';
import { Collider }     from '@woosh/meep-engine/src/engine/physics/ecs/Collider.js';
import { BodyKind }     from '@woosh/meep-engine/src/engine/physics/ecs/BodyKind.js';
import { ConvexHullShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/ConvexHullShape3D.js';
import { SphereShape3D }     from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Ray3 } from '@woosh/meep-engine/src/core/geom/3d/ray/Ray3.js';
import { PhysicsSurfacePoint } from '@woosh/meep-engine/src/engine/physics/queries/PhysicsSurfacePoint.js';

// A right-triangular prism -- a ramp. It fills half of its own AABB.
// Faces wound consistently outward; see the note below on why that matters.
const shape = ConvexHullShape3D.from(
    new Float32Array([-1,-1,-1,  1,-1,-1,  1,1,-1,  -1,-1,1,  1,-1,1,  1,1,1]),
    [0,2,1,  3,4,5,  0,1,4,  0,4,3,  1,2,5,  1,5,4,  0,5,2,  0,3,5]
);

const sys = new PhysicsSystem();
const body = new RigidBody(); body.kind = BodyKind.Static;
const collider = new Collider(); collider.shape = shape;
const transform = new Transform(); transform.position.set(0, 0, 0);
sys.link(body, transform, 1);
sys.attach_collider(1, collider, transform, 1);

// Inside the AABB, plainly outside the wedge (which only fills y <= x).
const p = { x: -0.9, y: 0.9, z: 0 };

sys.overlap(SphereShape3D.from(1e-4), p, {x:0,y:0,z:0,w:1}, new Uint32Array(8), 0);
// -> 0 bodies.  Correct.

const ray = new Ray3();
ray.setOrigin(p.x, p.y, p.z);
ray.setDirection(0, -1, 0);
ray.tMax = 5;
sys.raycast(ray, new PhysicsSurfacePoint());
```

| meep | result | |
|---|---|---|
| 3.0.2 | `t = 0.0000`, normal `(-1.00, 0.00, 0.00)` | wrong: the ray origin is not inside the hull |
| **3.2.0** | `t = 1.8000`, normal `(-0.71, 0.71, 0.00)` | exactly right: the slope, where it should be |


`overlap` and `raycast` disagree about whether the same point is inside the same body, and
`overlap` is the one that agrees with the geometry. The `t = 0` plus a face normal is the
signature of inside-body handling: the ray is being treated as originating within the shape, which
is true of its bounding box and false of the shape.

**Why it matters beyond a wrong number.** `KinematicMover._categorizeGround` decides walkability
with a centre raycast from `stepHeight` above the feet, and its docblock is explicit that a steep
normal there means a genuine slope and therefore *not grounded*. Above any brush that does not
fill its bounding box, that probe returns `t = 0` with a downward normal, so the player rests on
the surface and is never grounded: gravity keeps being applied and cancelled, `grounded` stays
false, and every consumer of it -- jump, animation, footsteps, the ground-stick -- is wrong.

Quake III levels are built from brushes and a large fraction of them are wedges, ramps and cut
corners, so this is not an exotic shape. **Measured across whole levels**, by casting the probe
`KinematicMover` casts at every node of the navigation graph:

| map | `t = 0` inside a body, 3.0.2 | 3.2.0 | real surface, 3.0.2 | 3.2.0 |
|---|---:|---:|---:|---:|
| `oa_dm1` | 1.3% | **0.0%** | 96.0% | 97.1% |
| `oa_dm4` | 4.5% | **0.0%** | 95.2% | 99.2% |
| `aggressor` | **10.4%** | **0.0%** | 84.0% | 92.5% |

The false hits are gone and the real ones went *up*, which is the shape a correct fix has.

**The downstream effect is the part worth quoting**, because it is what a consumer feels. Bots on
`aggressor` -- the map with the worst probe-failure rate -- over a 30-second match:

| | grounded | stuck | shots fired | pickups |
|---|---:|---:|---:|---:|
| 3.0.2 | 51.6% | 23.3% | 10 | 13 |
| **3.2.0** | **89.4%** | **4.4%** | **220** | **16** |
| ported `bg_pmove`, for reference | 92.5% | 2.6% | 420 | 16 |

D-072 recorded the mechanism as a *correlation* -- probe fails, bot is not grounded, accelerates
at `pm_airaccelerate` instead of `pm_accelerate`, crawls, reads as stuck, abandons its route --
and declined to call it a cause. Upgrading is the experiment that settles it: one changed line in
the engine moved every number in that table. The correlation was the cause.

**A defect in this report's own reproduction, which changes nothing and is worth knowing.** The
snippet above originally wound its faces inconsistently. `ConvexHullShape3D.from` accepted it
silently, and so did every query built on the support function -- `overlap` classified interior
and exterior points correctly, `support` returned correct extreme points, and `.volume` returned
the correct 4. Only `raycast`, which uses the face list, is winding-sensitive, and against the
malformed hull on 3.2.0 it returns a clean **miss** -- which reads exactly like a regression and
is not one. Re-running with correct winding is what produced the table above.

Two things follow. The bug was real and is fixed, on evidence that never depended on the bad
hull: the whole-level measurements were taken against `brushHull`'s output, which is correctly
wound. And there is a small live finding underneath: **a convex hull with inconsistent winding is
accepted without complaint and then behaves correctly under every query except `raycast`**, where
it silently reports nothing. `.volume` cannot be used to detect it. A winding check in
`ConvexHullShape3D.from`, or a signed volume, would turn a silent wrong answer into a constructor
error.

**Severity:** was major -- silent, plausible-looking, and in the walkability decision of the
engine's own character solver. **Fixed in 3.2.0**; this port now depends on `^3.2.0` for that
reason.

**Evidence:** the snippet above, run against 3.0.2 and 3.2.0; the whole-level probe over every
navigation-graph node; `test/meepmove.test.ts` ("grounds at every spawn point") and
`test/match.test.ts`, both of which now assert the correct behaviour unconditionally. D-071,
D-072, D-073.

### Not bugs, recorded so nobody re-files them

- **`shape_cast` reporting the minimum-penetration normal** (GAP-012) is a documented, defensible
  choice for a physics query. It is the wrong answer for character control, which is a gap in the
  API surface rather than a defect in the implementation.
- **`shape_cast` reporting contact for a graze** (GAP-019) is likewise correct for the question it
  is asked, and the engine's answer for a character controller that needs a different question is
  `KinematicMover`. The original entry treated this as a defect; it is not one (GAP-021).
- **`shape_cast` having no standoff parameter** was filed as GAP-020 and is withdrawn. The
  standoff exists, as `KinematicMover`'s `skin` option, which is where PhysX and Unity put theirs
  too.
- **The per-second FPS line on `console.warn`** is a design decision, not a bug, but it is the
  wrong channel: `FPS: 238.12, RENDER: 1.58ms, SIMULATION: 0.06ms` every second at warn level
  buries real warnings, and it did during the GAP-003/GAP-004 diagnosis. `console.info`, or off
  by default.

---

## 7. What worked well

Specific things that would be a loss to regress.

- **Type coverage is near-total and correctly paired.** 5949 `.d.ts` for 5953 `.js`, emitted
  next to the sources with `.d.ts.map` alongside, so editor go-to-definition lands in the real
  JavaScript with its docblocks rather than in a synthesised stub. Modulo GAP-001, consuming
  a pure-JavaScript engine from strict TypeScript worked on the first attempt, which is not
  the usual experience.
- **`EngineHarness` is a genuinely good on-ramp.** `bootstrap()` → `buildBasics()` gets a lit
  scene with a camera, a controller, a sound listener and an FPS counter in two calls, and
  each of `buildCamera` / `buildLights` / `buildTerrain` is separately callable when the
  defaults stop fitting. The escape hatch is present at every level.
- **The package is honest about what is not finished.** The README states plainly that
  `NavigationMeshAgent` is a placeholder and that runtime obstacle carving is not implemented.
  `ShadeMaterial.draw_side` says in its own docblock that it does nothing. Discovering these in
  the source rather than three days into the work is worth a great deal; phase 5 is planned
  around the navigation one from the start, and GAP-007 would have been a major finding rather
  than a minor one without the second.

### Added during phase 1

- **Clustered lighting delivers exactly what the README claims.** 147 dynamic point lights on
  a 198k-triangle level cost 7.28 ms of CPU per frame; the 3.2k-triangle level with 63 lights
  cost 3.96 ms. Light count was not a factor in either. This is the single most important thing
  that went right in this port: q3map2 strips every `light` entity from a compiled BSP, and
  meep cannot import Q3's baked lightmaps (GAP-006), so *the only* route to a lit level was to
  reconstruct the lighting as real dynamic lights and hope the engine could take it. It could,
  without tuning, without batching work on my side, and without a fallback plan.

- **Building geometry from raw arrays is four calls and no ceremony.** `new Geometry()`,
  `Attribute.from(array, itemSize, StandardAttributes.X)`, `geometry.index = ...`,
  `meshlet_geometry_build_from_geometry(...)`. `make_box_geometry` in the primitives folder is
  a complete worked example of exactly this. For an engine with no samples, having the
  primitive builders written in terms of the public API — rather than reaching into internals —
  is what made phase 1 possible at all. Whatever else changes, keep the primitives honest.

- **Deep imports resolved into strict TypeScript with zero configuration.** `moduleResolution:
  "bundler"` and nothing else. Every one of the ~30 deep paths this port imports found its
  paired `.d.ts`, and `.d.ts.map` meant go-to-definition landed in the real JavaScript with its
  docblocks — which, given GAP-002, is where all the documentation actually is.

- **Photometric light units.** Filed as GAP-005 for the missing guidance, but the design is
  right and worth defending: `q3map_surfacelight`'s values turned out to map to lumens almost
  1:1 with no per-map tuning, because both are proportional to emitted power. An ad-hoc
  0-to-1 intensity scale would have required hand-tuning every map.

### Added during phase 3

- **`DecalSystem3` registers its own asset loader.** `startup` checks
  `assets.hasLoaderForType(GameAssetType.Image)` and registers an `ImageRGBADataLoader` if one
  is missing, so decals work without the consumer knowing that an image loader is a thing that
  exists. Small, and exactly the right instinct — a system that needs a facility should acquire
  it rather than fail with "no loader for type image".

- **Error messages name the thing that is wrong.** `Failed to add track with name 'Scale', no
  parameter exists with that name` (GAP-010) told me what to fix without reading any engine
  source. `ERR_PACKAGE_PATH_NOT_EXPORTED` at a Vite config crash pointed straight at the
  missing `./package.json` export. `Only URLs with a scheme in: file, data, and node`... came
  from Node rather than meep, but the meep-side ones held up under pressure.

- **Building an effect out of ECS components composes without ceremony.** An explosion here is
  a `Light` entity, two `ParticleEmitter` entities and a `Decal` entity, each with a
  `Transform`, each independently removable on its own timer. No effect system, no particle
  manager, no registration step. That is the ECS claim in the README actually paying off on a
  concrete task.

### Added during phases 3-5

- **The glTF loader took everything a hand-written exporter threw at it.** Two skins, 64 joints,
  25 clips, 3,000 animation channels, `JOINTS_0` as unsigned short, external `.bin` and external
  PNGs -- loaded first time, with no tolerance-tuning and no format quirks to work around. That
  is not a small thing: a loader that accepts the specification rather than a subset of it is
  what made an offline character pipeline possible at all, and it is the single facility this
  port leaned on hardest.

- **Behaviour trees are exactly the size they should be.** `SelectorBehavior`,
  `SequenceBehavior`, `ConditionBehavior`, `ActionBehavior` and a `Behavior` base with
  `initialize` / `tick` / `finalize`. Six imports and two subclasses replaced botlib's
  `ainode_t` function-pointer state machine, and the resulting tree is three lines that read in
  priority order. The one sharp edge is that a finished tree must be restarted by the driver
  (D-052), which is true of every behaviour tree and is not written down here.

- **Clustered lighting, again, at a different scale.** 147 dynamic lights was the phase-1
  headline; adding items, movers, characters and their effects on top changed nothing about the
  frame budget. The thing about a facility that scales is that it stops being interesting, which
  is the compliment.

- **`shape_cast` and `overlap_shape` are the right two primitives.** Between them they answered
  every collision question this port asks -- swept contact, resting contact, "am I inside
  something", "what else is touching me" -- for the player, for bots, for item placement and for
  navigation-graph construction. GAP-012 is about what `shape_cast` *reports*, not about what it
  can do.

- **The physics broadphase tracks kinematic transforms without being asked.** Doors are
  `KinematicVelocity` bodies whose transforms are written directly, and `shape_cast` finds them
  where they are on the frame they are there. That collapsed Q3's entire `SV_ClipMoveToEntities`
  loop -- world trace, then every solid entity by hand -- into one query.

### Added during phase 6

- **The physics engine runs headless, and this turned out to be the single most valuable
  property in the package.** `new PhysicsSystem()`, `link`, `attach_collider`, `shape_cast` and
  `overlap_shape` need no graphics device, no `Engine`, no entity manager and no DOM. That is
  what made the three-way differential harness possible in phase 2, and in phase 6 it is what
  made "a real match is playable" a test rather than an opinion: `test/match.test.ts` runs six
  bots for thirty simulated seconds against the shipping collision backend, in Node, in under a
  second. Most physics engines cannot be driven this way -- they own a world object that owns a
  scene that owns a device -- and the difference between "can be regression-tested in CI" and
  "must be verified by a human looking at it" is the difference between the four player-reported
  bugs in this project's record being caught in CI and being caught by a player.

  Worth stating as a design property to protect, because it is easy to lose by accident: the
  queries take the system, not a world; the shapes are plain data; nothing reaches for a device.

- **The simulation seam is real, and nothing had to be built to prove it.** `WeaponSystem`,
  `ItemSystem`, `MoverSystem` and `BotRuntime` all take plain interfaces -- `WeaponEvents`,
  `DropTrace`, `BotWorld` -- and `BotRuntime.spawn` already accepted a null `Character`. Swapping
  the entire presentation layer for a counter in `test/match.test.ts` needed no change to any
  shipping file. That is partly this port's own design, but it was possible because meep's ECS
  never demanded to own the game state: components are attached to entities the application
  builds, systems are registered by the application, and there is no framework lifecycle to
  inherit from. An engine that required `extends GameObject` would have made the headless match
  a rewrite.

- **`AudioEmitter` routes on exactly the two axes Q3's sound API varies on, so one component
  expresses all four of its sound syscalls.** Q3 has `S_StartSound` (positional one-shot),
  `S_StartLocalSound` (2D one-shot), `S_AddLoopingSound` (positional loop) and
  `S_StartBackgroundTrack` (2D loop on a music bus). `AudioEmitterSystem` picks its routing once,
  at link, on `is3D` and on whether the event is finite — and a looping 3D emitter goes into the
  `LiveEmitterSet` where only the nearest in range are promoted to voices, which is precisely what
  `S_AddLoopSounds` does by rebuilding its set every frame. This port initially kept a second,
  direct code path for one-shots on cost grounds and then deleted it (D-065), because the
  component route arrives at the same `sopra.playEvent` one link later and the second path was
  buying nothing but a second answer to every question. That the four Q3 calls collapse onto one
  component is not luck; it is the component having been designed around the right two axes.

- **The engine turned out to have more than this port needed, and being able to say which parts
  were idle is worth as much as the coverage number.** The phase 6 audit separates 31 facilities
  this port actually exercises from 18 that exist, would plainly have done the job, and were
  never reached: fonts, 2D image drawing, UI tinting, the clipboard, the cvar/options system, the
  console, `DebugDrawSystem3`, `ArrayBufferLoader`, `R_ModelBounds`. A maintainer prioritising
  work should know that a Quake III port never touched any of them — not as a criticism of those
  facilities, but because "what did a real consumer actually lean on" is a different and more
  useful question than "what does the engine have".

---

## 8. Docs and samples gaps

This is the section the maintainer can act on most cheaply, so it is specific about what was
being attempted at the moment each one bit.

**Nothing runnable ships.**

- No runnable engine sample of any kind in the package (GAP-002). `samples/` contains
  procedural-generation fixtures and `exports` has no `./samples/*` entry, so the folder cannot
  even be imported from a consumer project.
- No document names the entry point. `EngineHarness` is the real worked example and is
  discoverable only by reading a directory listing. Half a page saying "start here, call
  `bootstrap()`, then `buildBasics()`, then register the systems you need" would have removed the
  first two hours of this project.
- The README links to `meep.company-named.com/docs` and to a GitLab quick-start template. Neither
  is inside the package, so an engineer working from `node_modules` — which is exactly where you
  end up when the samples are not useful — has neither.
- No stated import convention. That the package is deep-import-only is inferable from `exports`
  and from a failed import, and from nowhere else.

**No document says which systems you must register.** This is the highest-value missing page in
the package. `PhysicsSystem` without `ColliderObserverSystem` gives you bodies that are present
in the broadphase, report sane AABBs, and are completely intangible (GAP-014); `AnimationSystem3`
without `MeshSystem3` by reference cannot drive a clip; a system constructed with a different
`Scene` than the harness draws renders into nothing. Every one of those fails silently and
succeeds at every diagnostic you reach for. A table of "system → what it needs registered
alongside it → what breaks if you forget" would have saved this port perhaps three hours across
four separate incidents, and it can be generated from the existing constructors.

**No reference values for photometric lighting.** `PointLight.intensity` is candela, falloff is
inverse-square in scene units, and the design is right (see section 7). What is missing is a
five-row table: a candle, a 60 W bulb, an office ceiling, overcast daylight, direct sun. Without
it, "my scene is black" and "my scene is white" are both unactionable, and both happened here —
90 minutes on the first (GAP-005) and ten on the second (GAP-011). The absence also makes world
scale silently load-bearing, which nothing says anywhere.

**No document about the semantics of the physics queries**, as opposed to their signatures.
`shape_cast` returns the minimum-penetration normal (GAP-012), reports contact for a graze against
a resting surface, has no standoff, and `skip_initial_overlaps` `continue`s rather than `break`s.
All four are correct, defensible choices, and all four were established by reading the
implementation.

The document that answers most of this **exists** and is good: `DESIGN_COLLISION.md`, 365 lines,
with a constants table citing Quake 3, Source and Fauerby for each value. It is filed at
`engine/control/first-person/DESIGN_COLLISION.md`, under a component I had already ruled out, and
I never opened it (GAP-021). So the ask here is not "write the page" — it is **put the page where
someone looking for it will be**, next to the queries or next to a `character/` directory. That
one move would have saved this port about six hours and two wrong fixes, and it is the single
highest-value item in this section.

**No note that `Animation`, and things like it, take JSON rather than components.** BUG-1 is a
one-line `@see`.

**No worked example of a hand-built (non-glTF) skinned model.** The glTF path is excellent and
took everything thrown at it (section 7). The port needed a *converter* to that path, which meant
establishing offline what meep expects — joint counts, weight normalisation, clip naming, how
tags become nodes. All of that was inferred from the loader source. `make_box_geometry` is the
model for what would help here: a small, honest, public-API-only example of the thing.

**No statement of what is deliberately not finished.** The README is unusually honest about
`NavigationMeshAgent` being a placeholder and runtime obstacle carving being absent, and that
honesty was worth a great deal — phase 5 was planned around it from the start. The same treatment
for the rest of the package would be worth as much: `ShadeMaterial.draw_side`'s docblock (BUG-6)
is the counter-example, and it cost a feature.

---

## Appendix: environment

| | |
|---|---|
| meep | `@woosh/meep-engine@3.2.0` (peer dependency, never vendored). Findings recorded against 3.0.2 are dated as such; BUG-7 was fixed in 3.2.0. |
| Node | v24.15.0 |
| TypeScript | 5.9, `strict: true` |
| Bundler | Vite 6 |
| Test runner | Vitest 3 |
| OA gamecode | `OpenArena/gamecode` @ `5478aad23b12857d265103f6aa2f5258c78799c8` |
| ioquake3 | `ioquake/ioq3` @ `588393618dbc82e7207c21c6ddecca229944a03a` |
| Oracle toolchain | Emscripten 6.0.8 (`aeb67926e7de656da38bc807d83050af93578758`) |
| Host | Windows 11, WebGPU via Chrome |
| Test suite | 183 tests across 11 files; `npm run check` typechecks, verifies the trap matrix and balance tables against their sources, and runs all of them |

Every number in this document has a command that reproduces it:

| claim | command |
|---|---|
| collision and movement divergence from the C oracle | `npm run divergence` |
| match simulation cost, and the per-trace decomposition | `npm run bench-match` |
| `NavigationMesh` routability from a Q3 level, three ways | `npm run navmesh-probe` |
| what the two collision backends say at one point, or along a walk | `node tools/trace-compare.ts <map> point <x,y,z>` |
| the `trap_` matrix, and that every citation in it still resolves | `node tools/trap-matrix.mjs --check` |
| lighting coverage, asset integrity, a played match | `npm test` |
