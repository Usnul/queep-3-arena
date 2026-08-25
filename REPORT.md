# Engineering report: porting Quake III / OpenArena onto meep

**Audience:** meep's maintainer. Everything here is meant to become a backlog item or be
consciously rejected.

**Method:** this document is appended to as the work happens, not reconstructed afterwards.
Entries carry the commit they were written at, so a claim that has since been fixed can be
dated. Where something cost real time, the time is stated.

**Engine under test:** `@woosh/meep-engine@3.0.2`, consumed from npm as a peer dependency,
unmodified. No patching, no forking, no monkey-patching — where the engine did not do what
the port needed, the port worked around it and the workaround is written down here.

---

## 1. Executive summary

Ranked by how much they would cost the next person, not by how much they cost me.

1. **Getting from `npm install` to a rendered frame took about 2.5 hours, and none of it was
   spent on graphics.** The engine itself came up cleanly and rendered at 230 FPS on the first
   frame it drew. The time went to integration defects a consumer hits in a fixed order and
   cannot skip: an optional peer dependency that is a mandatory top-level import (GAP-003),
   worker bundles addressed at a web-root path no application has (GAP-004), and a missing
   `./package.json` export that breaks the standard way of locating a package root. Each is
   individually trivial. Together they are the entire first-run experience, and they are the
   cheapest thing on this list to fix.

2. **Photometric lighting has no guidance, and world scale is silently load-bearing.**
   `PointLight.intensity` is candela and falloff is inverse-square in scene units, which is the
   right design. The consequence is undocumented: content authored in any unit other than
   metres renders black, with no diagnostic. Diagnosing it cost about 90 minutes and was
   actively misleading — raising every light's intensity by 10,000x moved mean frame luminance
   from 14.7 to 25.7, which reads as "lights are disconnected", not "your distances are 32x too
   large" (GAP-005). It then cost a further ten minutes at the other end of the scale when a
   physically-plausible 60,000-lumen explosion whited out a corridor (GAP-011). A short table
   of reference values in the lighting docs would have prevented both.

3. **Swapping Q3's collision for meep's physics cost three specific behaviours, and one of them
   is a general finding about character control.** The maintainer directed that movement run on
   meep's physics rather than the ported `cm_trace`, so it does, measured against the ported
   code as a bit-exact control (D-029). Two of the three restorations are Q3 quirks nobody else
   needs. The third is not: **`shape_cast` reports the minimum-penetration axis as its contact
   normal, and for character control the *latest entering plane* is the useful answer.** They
   agree on a flat wall and disagree in a corner, where meep returned `[0, 1, 0]` — the floor —
   for a box wedged against a wall. Any slide-move controller clips velocity against that
   normal, and clipping against the wrong plane in a corner is how characters get stuck in
   corners. Re-deriving the plane from the source geometry took the error from 56 units to 0.12
   (GAP-012). This is worth an engine-side option because every character controller built on
   `shape_cast` will need it and most will diagnose it as their own bug.

4. **A navmesh needs a surface and a Quake III map is a pile of interpenetrating solids — and the
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

5. **The application rendered at 160 FPS and could not be played, and finding out why took a walk
   up the computed styles.** meep builds its pointer and keyboard devices on `viewStack.el` and
   starts them — but that element and everything under it, including the render canvas, are
   `pointer-events: none`, so no pointer event ever reaches the device; and although it carries
   `tabindex="0"`, nothing focuses it, so key events go to `<body>` instead. Both halves fail
   silently and look exactly like an application with no input code at all, which is the wrong
   place to start looking. The fix is four lines of app-level CSS and a `focus()` call, and after
   it the device layer is genuinely nicer than the DOM — `keyboard.keys.w.is_down` needs no
   held-key bookkeeping, and `pointer.on.move` hands over the pointer-lock delta as its third
   argument already extracted. Worth a warning from `PointerDevice.start()` when its element
   computes to `pointer-events: none`: two lines, for a failure that is otherwise invisible
   (GAP-017).

6. **Two APIs silently accept a wrong-but-plausible call and do nothing, and both cost an hour
   each.** `PhysicsSystem` links `(RigidBody, Transform)`; attaching the *collider* is a separate
   `ColliderObserverSystem` the consumer must also register. Register only the first and every
   body is real, present in the broadphase, and completely intangible -- 537 static bodies and
   `fraction === 1` for a sweep from a metre above a floor to 128 m below it, with nothing in the
   console (GAP-014). Separately, `new Animation({ clips })` documents its parameter as
   `List<AnimationClip>` and in fact forwards to `fromJSON`, so passing the documented type builds
   clips whose names are the empty string: the model loads, both skins are there, the list is the
   right length, and nothing ever plays (GAP-015). Neither is a hard problem to fix -- a `@see`, a
   first-use warning, or accepting both forms -- and both are the kind of failure where every
   diagnostic you reach for reports success.

7. **Baked lightmaps cannot be imported, only baked.** The vertex channel exists, the attribute
   is literally named "used for light map", and there is a whole `shade/renderer/lightmap/`
   subsystem — but it is a *baker*, and no material has a lightmap slot. Every level format
   that predates real-time GI ships baked lighting and none of it can come in. Large flat
   surfaces therefore read as uniformly lit, which is a real quality gap — though smaller than
   the first version of this report claimed, because I attributed "the floors are flat grey" to
   it when the floors were not rendering at all (GAP-018).

8. **Clustered lighting is as good as advertised, and this port depends on it existing.** 147
   dynamic point lights on a 198k-triangle level cost 7.28 ms of CPU per frame; light count did
   not register against geometry count. That matters more than a benchmark: q3map2 strips every
   `light` entity from a compiled BSP (measured: zero across six maps), so with lightmaps
   unavailable, reconstructing the lighting as dynamic lights was not a showcase choice — it
   was the only remaining route to a lit level. It worked with no tuning.

9. **Meshlet construction is synchronous and is 92% of level load time.** 1,246 ms of unbroken
   main-thread work for a 198k-triangle level, in an engine that has an asset streamer, a
   concurrent executor and a worker pool. A real level is several times that size (GAP-008).

10. **Generated `.d.ts` files do not typecheck standalone**, and the failures are not cosmetic:
   `LabelView` rejects a call its own implementation explicitly supports, `Engine`'s constructor
   options are typed as one of their own fields' types, and `entityManager` is `any`. Consumers
   are forced into `skipLibCheck: true`, which disables checking of every *other* dependency
   they have (GAP-001).

11. **`/samples` contains no runnable engine sample.** The published package ships
   `samples/generation/**` and nothing else — procedural-generation fixtures. Nothing boots the
   engine, loads a model, or draws a frame, and `exports` has no `./samples/*` entry so the
   folder cannot be imported even though it is shipped. `EngineHarness` turns out to be the
   real worked example; finding that took reading a directory listing (GAP-002).

12. **A scene with no environment map renders black, silently.** Shade assumes global
   illumination and `make_default_environment` documents this well — but you only read that
   docblock if you already suspect the environment. `EngineHarness.buildBasics` sets one up for
   you, so this bites exactly when you stop using the all-or-nothing helper, which is the moment
   you stop being a beginner. A first-frame warning would remove it entirely.

13. **The camera uses the object convention (+Z forward), not glTF's.** Defensible, and
   documented — inside the docblock of a function consumers never call. A hand-built view
   quaternion assuming -Z points the camera exactly backwards, which in a closed level presents
   as *a dark scene* rather than a reversed one. I diagnosed it as a lighting problem first.

14. **Two thirds of Q3's engine surface is netcode, bot AI and 1999 platform plumbing that meep
    correctly does not have.** Of 309 distinct `trap_*` syscalls, 203 belong to subsystems this
    port deletes outright; of the 106 that remain, 77 map onto an existing meep facility, 19 are
    deliberately ported, 9 worked around, 1 a genuine gap. Worth stating plainly before the gap
    register below makes things look worse than they are.

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
section 5; the short version is that it works, the remaining divergence is sub-unit at the
median, and getting there surfaced GAP-012. Its own `DESIGN.md`
  states its goals as "feel alive" and "be configurable"; Q3's movement is neither tuned nor
  configurable, it is a fixed set of float operations players spent 25 years learning to
  exploit. See GAP-009 — which is a *positioning* finding, not a defect.

### State of the work

| phase | status |
|---|---|
| 0 — setup | complete; `tsc --noEmit` clean, engine rendering |
| 1 — asset pipeline | complete; 6 maps, 76 props, 15 characters, 58 sounds |
| 2 — collision and movement | complete; ported `cm_trace` **bit-exact**, shipping backend is meep physics tuned against it (D-029) |
| 3 — game simulation | weapons, damage, items, movers, triggers, jump pads, teleporters |
| 4 — presentation | particles, decals, lights, HUD, characters, positional audio |
| 5 — bots | behaviour trees on a floor-sampled navigation graph; they route, fight and pick up |
| 6 — report | this document, written continuously |

What is *not* done is listed per phase in `DECISIONS.md` rather than summarised away: patch
collision (D-017), capsule traces (D-018), the weapon state machine (D-022), mover crush and
shootable doors (D-041), smooth skin weights and character LOD (D-045), and the bots' missing
half — no jumping to reach anything, no aim prediction, no bot-versus-bot target selection
(D-055).

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

**Reading the dispositions:**

- `mapped` — meep has a facility that does the job. This is the column that flatters the
  engine, and it is the largest one.
- `ported` — reimplemented faithfully in TypeScript and *deliberately not* mapped onto meep.
  Almost all of these are `cm_*` collision. This is not a criticism of meep's physics: Q3
  movement is defined by the exact behaviour of its brush-plane sweep, and any other
  narrowphase produces different contact normals and therefore different strafe-jumps.
- `workaround` — no direct facility; solved outside the engine, usually at asset-build time.
- `GAP` — no reasonable answer. See section 3.
- `not needed` — the subsystem is out of scope for this port (netcode, botlib/AAS, CD keys,
  cinematics, server browser). Two thirds of the raw syscall count is this, which is worth
  knowing before anyone reads "309 syscalls" as "309 engine features".

<!-- BEGIN TRAP MATRIX -->

<!-- GENERATED BY tools/trap-matrix.mjs -- DO NOT EDIT BY HAND -->

Mechanically derived from the OpenArena gamecode at `.refs/oa-gamecode`. **309 distinct `trap_*` symbols** appear across `game/`, `cgame/`, `ui/` and `q3_ui/`. Occurrence counts include the prototype and the syscall-stub definition, so a syscall used once shows a count of 3.

| status | count | meaning |
|---|---:|---|
| `mapped` | 77 | a meep facility does the job |
| `ported` | 19 | reimplemented faithfully in TypeScript; deliberately *not* mapped onto meep |
| `workaround` | 9 | meep has no direct facility; solved outside the engine |
| `GAP` | 1 | no reasonable answer; see gap register |
| `not needed` | 203 | the whole subsystem is out of scope (netcode, botlib, CD keys, cinematics) |

| Q3 syscall | uses | modules | disposition | meep facility | notes |
|---|---:|---|---|---|---|
| `trap_AAS_AlternativeRouteGoals` | 10 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaInfo` | 5 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaReachability` | 21 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaTravelTimeToGoalArea` | 16 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_BBoxAreas` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EnableRoutingArea` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EntityInfo` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_FloatForBSPEpairKey` | 6 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Initialized` | 10 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_IntForBSPEpairKey` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_NextBSPEntity` | 12 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointAreaNum` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointContents` | 8 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointReachabilityAreaIndex` | 4 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictClientMovement` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictRoute` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PresenceTypeBoundingBox` | 5 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Swimming` | 5 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Time` | 3 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_TraceAreas` | 7 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_ValueForBSPEpairKey` | 16 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_VectorForBSPEpairKey` | 4 | game | not needed | own trace-built waypoint graph | AAS deleted wholesale, per the brief. Navigation is a floor-sampled waypoint graph built by tracing rather than meep NavigationMesh: reaching the navmesh needs a walkable-surface extraction the engine does not provide, and even with one it routes 48% of spawn pairs on oa_dm1 where the trace-built graph routes 100% (GAP-016). None of these individual AAS queries is answered by anything. _(classified by prefix `trap_AAS_`)_ |
| `trap_AddCommand` | 31 | cgame | mapped | own console command table |  |
| `trap_AdjustAreaPortalState` | 4 | game | not needed | - | As above. |
| `trap_AreasConnected` | 2 | game | not needed | - | Areaportal state only mattered for PVS-driven network scope. |
| `trap_Argc` | 34 | cgame, game, q3_ui, ui | mapped | own console tokenizer |  |
| `trap_Args` | 7 | cgame, game | mapped | own console tokenizer |  |
| `trap_Argv` | 51 | cgame, game, q3_ui, ui | mapped | own console tokenizer |  |
| `trap_BotAddAvoidSpot` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocChatState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocGoalState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocateClient` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChatLength` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseBestFightWeapon` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseLTGItem` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseNBGItem` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpAvoidGoals` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpGoalStack` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEmptyGoalStack` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEnterChat` | 103 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFindMatch` | 10 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeChatState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeClient` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeGoalState` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeItemWeights` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeWeaponState` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetChatMessage` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetLevelItemGoal` | 12 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetMapLocationGoal` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetNextCampSpotGoal` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSecondGoal` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetServerCommand` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSnapshotEntity` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetTopGoal` | 16 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetWeaponInfo` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGoalName` | 24 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitLevelItems` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitialChat` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInterbreedGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotItemGoalInVisButNotVisible` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibDefine` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibLoadMap` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibSetup` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibShutdown` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibStartFrame` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibTest` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibUpdateEntity` | 9 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarGet` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarSet` | 26 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadChatFile` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadItemWeights` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadWeaponWeights` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMatchVariable` | 60 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveInDirection` | 10 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveToGoal` | 9 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMovementViewTarget` | 8 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMutateGoalFuzzyLogic` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNextConsoleMessage` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumConsoleMessages` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumInitialChats` | 32 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPopGoal` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPredictVisiblePosition` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPushGoal` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotQueueConsoleMessage` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReachabilityArea` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveConsoleMessage` | 7 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveFromAvoidGoals` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplaceSynonyms` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplyChat` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidGoals` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidReach` | 20 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetGoalState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetLastAvoidReach` | 11 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetMoveState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSaveGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatGender` | 8 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatName` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotTouchingGoal` | 18 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUpdateEntityItems` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUserCommand` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. Bots run meep behaviour trees (SelectorBehavior / SequenceBehavior / ConditionBehavior) over a three-branch tree. _(classified by prefix `trap_Bot`)_ |
| `trap_CIN_DrawCinematic` | 7 | cgame, ui | not needed | - | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_PlayCinematic` | 13 | cgame, ui | not needed | - | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_RunCinematic` | 10 | cgame, ui | not needed | - | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_SetExtents` | 7 | cgame, ui | not needed | - | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CIN_StopCinematic` | 14 | cgame, ui | not needed | - | RoQ cinematic playback. Cut. _(classified by prefix `trap_CIN_`)_ |
| `trap_CL_UI_RankGetLeauges` | 1 | q3_ui | not needed | - | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserCreate` | 1 | q3_ui | not needed | - | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserLogin` | 1 | q3_ui | not needed | - | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CL_UI_RankUserRequestLogout` | 1 | q3_ui | not needed | - | As above. _(classified by prefix `trap_CL_UI_Rank`)_ |
| `trap_CM_BoxTrace` | 10 | cgame | ported | - | Same clipmap, client side. |
| `trap_CM_CapsuleTrace` | 1 | cgame | ported | - |  |
| `trap_CM_InlineModel` | 5 | cgame | ported | - |  |
| `trap_CM_LerpTag` | 7 | q3_ui, ui | mapped | glTF node hierarchy + animation channels | MD3 tags become animated nodes in the converted glTF: tag_torso is a node the legs clips drive, and the torso skin hangs off it. The lerp is the clip player. |
| `trap_CM_LoadMap` | 3 | cgame | ported | - | cm_load.c ported: brushes, leafs, patch collision. Separate from the render-side BSP conversion. |
| `trap_CM_MarkFragments` | 3 | cgame | not needed | DecalSystem3 (GPU decals) | Q3 clips world triangles on the CPU to build mark polygons. Replaced by meep GPU decals per brief section 2. |
| `trap_CM_NumInlineModels` | 3 | cgame | ported | - |  |
| `trap_CM_PointContents` | 5 | cgame | ported | - |  |
| `trap_CM_TempBoxModel` | 3 | cgame | ported | - |  |
| `trap_CM_TempCapsuleModel` | 1 | cgame | ported | - |  |
| `trap_CM_TransformedBoxTrace` | 3 | cgame | ported | - | Needed for moving brush models (doors, plats). |
| `trap_CM_TransformedCapsuleTrace` | 1 | cgame | ported | - |  |
| `trap_CM_TransformedPointContents` | 3 | cgame | ported | - |  |
| `trap_Characteristic_BFloat` | 50 | game | not needed | behaviour-tree blackboard | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_BInteger` | 2 | game | not needed | behaviour-tree blackboard | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_Float` | 2 | game | not needed | behaviour-tree blackboard | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_Integer` | 2 | game | not needed | behaviour-tree blackboard | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Characteristic_String` | 8 | game | not needed | behaviour-tree blackboard | Bot personality files not ported. _(classified by prefix `trap_Characteristic_`)_ |
| `trap_Cmd_ExecuteText` | 146 | cgame, q3_ui, ui | mapped | own console |  |
| `trap_Cvar_Create` | 3 | q3_ui, ui | mapped | engine/options |  |
| `trap_Cvar_InfoStringBuffer` | 3 | q3_ui, ui | not needed | - | Serialises cvars into the network userinfo string. |
| `trap_Cvar_Register` | 46 | cgame, game, q3_ui, ui | mapped | engine/options + reactive values |  |
| `trap_Cvar_Reset` | 8 | q3_ui, ui | mapped | engine/options |  |
| `trap_Cvar_Set` | 357 | cgame, game, q3_ui, ui | mapped | engine/options | 357 call sites: the most-used syscall in the codebase. |
| `trap_Cvar_SetValue` | 256 | q3_ui, ui | mapped | engine/options |  |
| `trap_Cvar_Update` | 33 | cgame, game, q3_ui, ui | mapped | engine/options |  |
| `trap_Cvar_VariableIntegerValue` | 27 | game | mapped | engine/options |  |
| `trap_Cvar_VariableStringBuffer` | 107 | cgame, game, q3_ui, ui | mapped | engine/options |  |
| `trap_Cvar_VariableValue` | 219 | game, q3_ui, ui | mapped | engine/options |  |
| `trap_DebugPolygonCreate` | 3 | game | mapped | DebugDrawSystem3 |  |
| `trap_DebugPolygonDelete` | 2 | game | mapped | DebugDrawSystem3 |  |
| `trap_DropClient` | 12 | game | not needed | - |  |
| `trap_EA_Action` | 12 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Attack` | 8 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Command` | 12 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Crouch` | 4 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_DelayedJump` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_EndRegular` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Gesture` | 5 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_GetInput` | 3 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Jump` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Move` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveBack` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveDown` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveForward` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveLeft` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveRight` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_MoveUp` | 2 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_ResetInput` | 3 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Respawn` | 4 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Say` | 4 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_SayTeam` | 7 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_SelectWeapon` | 5 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Talk` | 4 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_Use` | 14 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EA_View` | 4 | game | not needed | bot writes usercmd_t directly | Elementary Action layer is a botlib IPC shim; an in-process bot just fills a usercmd_t. _(classified by prefix `trap_EA_`)_ |
| `trap_EntitiesInBox` | 9 | game | mapped | core/bvh2 BVH3 box query | Q3 areagrid replaced by meep BVH. Semantics differ (Q3 returns absmin/absmax overlaps), so a thin adapter re-tests AABBs. |
| `trap_EntityContact` | 3 | game | ported | - | Exact contact against the clipmap, not a broadphase test. |
| `trap_EntityContactCapsule` | 1 | game | ported | - |  |
| `trap_Error` | 24 | cgame, game, q3_ui, ui | mapped | throw + engine/logging |  |
| `trap_FS_FCloseFile` | 69 | cgame, game, q3_ui, ui | not needed | GC |  |
| `trap_FS_FOpenFile` | 56 | cgame, game, q3_ui, ui | mapped | AssetManager (async) | Q3 filesystem is synchronous; meep assets are promises. See gap register. |
| `trap_FS_GetFileList` | 25 | game, q3_ui, ui | workaround | build-time manifest | No directory listing in a browser. The asset pipeline emits a JSON manifest. |
| `trap_FS_Read` | 39 | cgame, game, q3_ui, ui | mapped | ArrayBufferLoader |  |
| `trap_FS_Seek` | 7 | cgame, game, q3_ui, ui | mapped | DataView offset |  |
| `trap_FS_Write` | 54 | cgame, game, q3_ui, ui | workaround | engine/save storage | Only used for demo, config and stat writing; mostly cut. |
| `trap_GeneticParentsAndChildSelection` | 3 | game | not needed | - | botlib fuzzy-logic genetic algorithm. |
| `trap_GetCDKey` | 5 | q3_ui, ui | not needed | - |  |
| `trap_GetClientState` | 12 | q3_ui, ui | not needed | - | Connection state machine. |
| `trap_GetClipboardData` | 4 | q3_ui, ui | mapped | core/clipboard |  |
| `trap_GetConfigString` | 32 | q3_ui, ui | mapped | ECS singleton components | UI-side spelling of the same call. |
| `trap_GetConfigstring` | 24 | game | mapped | ECS singleton components |  |
| `trap_GetCurrentCmdNumber` | 5 | cgame | not needed | - |  |
| `trap_GetCurrentSnapshotNumber` | 3 | cgame | not needed | - |  |
| `trap_GetEntityToken` | 7 | cgame, game | ported | - | Walks the BSP entity lump string. Ported as part of the BSP reader. |
| `trap_GetGameState` | 4 | cgame | not needed | - |  |
| `trap_GetGlconfig` | 8 | cgame, q3_ui, ui | mapped | graphics device info | Only used for screen dimensions and aspect. |
| `trap_GetServerCommand` | 3 | cgame | not needed | direct call / meep Signal | Server-to-client command stream collapses to a function call. |
| `trap_GetServerinfo` | 7 | game | mapped | plain config object |  |
| `trap_GetSnapshot` | 4 | cgame | not needed | - | Netcode; brief section 2 says delete entirely. |
| `trap_GetUserCmd` | 7 | cgame | mapped | engine/input plus own usercmd_t builder | cgame-side spelling. |
| `trap_GetUsercmd` | 4 | game | mapped | engine/input plus own usercmd_t builder |  |
| `trap_GetUserinfo` | 21 | game | mapped | plain config object | Userinfo string becomes a typed settings object. |
| `trap_InPVS` | 13 | game | not needed | renderer culling | PVS gated sound/event delivery per client. Single process, one player. |
| `trap_InPVSIgnorePortals` | 2 | game | not needed | - | As above. |
| `trap_Key_ClearStates` | 11 | q3_ui, ui | mapped | input reset |  |
| `trap_Key_GetBindingBuf` | 6 | cgame, q3_ui, ui | mapped | own binding table | Q3 bindings live in the engine; here they are game data. |
| `trap_Key_GetCatcher` | 17 | cgame, q3_ui, ui | mapped | engine/input context stack |  |
| `trap_Key_GetKey` | 3 | cgame | mapped | input query API |  |
| `trap_Key_GetOverstrikeMode` | 12 | cgame, q3_ui, ui | not needed | DOM text input | Console and chat text editing. |
| `trap_Key_IsDown` | 10 | cgame, q3_ui, ui | mapped | input query API |  |
| `trap_Key_KeynumToStringBuf` | 7 | cgame, q3_ui, ui | mapped | own binding table |  |
| `trap_Key_SetBinding` | 11 | cgame, q3_ui, ui | mapped | own binding table |  |
| `trap_Key_SetCatcher` | 32 | cgame, q3_ui, ui | mapped | engine/input context stack |  |
| `trap_Key_SetOverstrikeMode` | 6 | cgame, q3_ui, ui | not needed | DOM text input |  |
| `trap_LAN_AddServer` | 5 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ClearPing` | 5 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_CompareServers` | 4 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPing` | 4 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPingInfo` | 4 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetPingQueueCount` | 5 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerAddressString` | 9 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerCount` | 11 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerInfo` | 12 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_GetServerPing` | 3 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_LoadCachedServers` | 3 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_MarkServerVisible` | 10 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_RemoveServer` | 4 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ResetPings` | 4 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_SaveCachedServers` | 3 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ServerIsVisible` | 3 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_ServerStatus` | 7 | q3_ui, ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LAN_UpdateVisiblePings` | 3 | ui | not needed | - | Server browser. Single process, no netcode. _(classified by prefix `trap_LAN_`)_ |
| `trap_LinkEntity` | 59 | game | mapped | ECS + BVH insert | Server-side spatial linking becomes BVH residency. |
| `trap_LocateGameData` | 4 | game | not needed | ECS dataset | Shared-memory handshake between QVM and engine. Gone with the QVM. |
| `trap_MemoryRemaining` | 11 | cgame, q3_ui, ui | not needed | - | QVM heap accounting. |
| `trap_Milliseconds` | 18 | cgame, game, q3_ui, ui | mapped | engine Clock |  |
| `trap_PC_AddGlobalDefine` | 3 | cgame, ui | workaround | - |  |
| `trap_PC_FreeSource` | 7 | cgame, game, ui | workaround | - |  |
| `trap_PC_LoadSource` | 9 | cgame, game, ui | workaround | offline conversion to JSON | Q3 C-preprocessor-flavoured .menu/.cfg parser. Menu files are not ported; the few data files that use it are converted offline. |
| `trap_PC_ReadToken` | 32 | cgame, game, ui | workaround | - |  |
| `trap_PC_SourceFileAndLine` | 5 | cgame, game, ui | workaround | - |  |
| `trap_PointContents` | 12 | game | ported | - | Brush contents lookup. No meep equivalent - contents are Q3 semantics (lava/slime/water/playerclip/trigger). |
| `trap_Print` | 46 | cgame, q3_ui, ui | mapped | engine/logging |  |
| `trap_Printf` | 16 | game | mapped | engine/logging |  |
| `trap_R_AddAdditiveLightToScene` | 1 | cgame | mapped | Light | Additive-vs-normal dlight distinction has no PBR analogue; folded into intensity. |
| `trap_R_AddLightToScene` | 40 | cgame, q3_ui, ui | mapped | Light + LightSystem3 (clustered) | Q3 dlights were a fixed small pool; clustered lighting removes the cap. |
| `trap_R_AddPolyToScene` | 15 | cgame, q3_ui, ui | workaround | Geometry rebuilt per frame / Trail3D / particles | Immediate-mode triangle soup. Most uses (marks, sprites, trails) map to decals/particles/trails; the rest rebuild a Geometry and set needsUpdate. |
| `trap_R_AddPolysToScene` | 2 | cgame | workaround | as above |  |
| `trap_R_AddRefEntityToScene` | 121 | cgame, q3_ui, ui | mapped | ShadedGeometry + ShadedGeometrySystem3 | Q3 immediate-mode scene list becomes retained ECS entities. Biggest structural change on the client side. |
| `trap_R_ClearScene` | 17 | cgame, q3_ui, ui | not needed | retained scene | Immediate-mode artifact. |
| `trap_R_DrawStretchPic` | 48 | cgame, q3_ui, ui | mapped | meep UI views | The entire Q3 HUD and menu draw model is this one call. Becomes retained UI views. |
| `trap_R_GetViewPosition` | 3 | cgame | mapped | camera Transform |  |
| `trap_R_LFX_ParticleEffect` | 24 | cgame | mapped | ParticleEmitterSystem3 / Particular | OA LFX particle extension, replaced outright. |
| `trap_R_LerpTag` | 6 | cgame | mapped | glTF node hierarchy + animation channels | MD3 tags become animated nodes in the converted glTF: tag_torso is a node the legs clips drive, and the torso skin hangs off it. The lerp is the clip player. |
| `trap_R_LightForPoint` | 3 | cgame | GAP | nothing directly | Q3 samples the BSP lightgrid to shade dynamic models. See gap register. |
| `trap_R_LoadWorldMap` | 3 | cgame | mapped | offline BSP to scene bundle plus runtime load |  |
| `trap_R_ModelBounds` | 11 | cgame, ui | mapped | AABB3 from scene bundle |  |
| `trap_R_RegisterFont` | 10 | cgame, ui | mapped | engine/asset/loaders/font + UI text |  |
| `trap_R_RegisterModel` | 124 | cgame, q3_ui, ui | mapped | AssetManager + GLTFSceneBundleAssetLoader | MD3 converted to glTF offline. Player models need a skeleton inferred from the vertex-morph frames first (D-042); meep has no morph-target path. |
| `trap_R_RegisterShader` | 117 | cgame | mapped | StandardShadeMaterial | Offline .shader to PBR conversion per brief section 2. |
| `trap_R_RegisterShaderNoMip` | 464 | cgame, q3_ui, ui | mapped | meep UI image | 464 call sites, almost all 2D HUD/menu icons. |
| `trap_R_RegisterSkin` | 22 | cgame, q3_ui, ui | mapped | material swap on ShadedGeometry | Q3 .skin maps surface name to shader; becomes a material table applied per primitive entity. |
| `trap_R_RemapShader` | 7 | cgame, ui | not needed | swap material reference | Used for team colours and teleport effects; a material swap. |
| `trap_R_RenderScene` | 16 | cgame, q3_ui, ui | mapped | Engine graphics loop |  |
| `trap_R_SetColor` | 183 | cgame, q3_ui, ui | mapped | UI element tint | 183 call sites, all 2D. |
| `trap_R_inPVS` | 1 | cgame | not needed | - | As above. |
| `trap_RankActive` | 1 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankBegin` | 1 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankCheckInit` | 1 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankPoll` | 1 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankReportInt` | 139 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankReportStr` | 5 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankUserReset` | 1 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RankUserStatus` | 3 | game | not needed | - | Q3 online rankings service, dead since 2002. _(classified by prefix `trap_Rank`)_ |
| `trap_RealTime` | 16 | cgame, game, ui | mapped | Date |  |
| `trap_RemoveCommand` | 1 | cgame | mapped | own console command table |  |
| `trap_S_AddLoopingSound` | 9 | cgame | mapped | AudioEmitter, looping 3D | Q3 rebuilds the loop set every frame and keeps the nearest; a looping 3D emitter is registered with AudioEmitterSystem's LiveEmitterSet, which promotes the nearest in range up to LOOP_BUDGET and leaves the rest dormant. Live at: CG_Missile's per-weapon fly sound on rockets, plasma and BFG shots; CG_Item's hover on a weapon lying in the map; CG_AddPlayerWeapon's firingSound/readySound on bots. Not CG_PlayerPowerups' flight loop (no powerup state) and not the gauntlet's firingSound (needs its own firing flag, not a fire-rate cooldown) -- see D-065. |
| `trap_S_AddRealLoopingSound` | 3 | cgame | mapped | AudioEmitter, looping 3D | The ET_SPEAKER variant, meaning not merged with other copies of the same sound. Map ambience: MapSound starts one emitter per target_speaker carrying the looped-on spawnflag, named by the entity's own noise key. 22 on oa_dm5, 10 on oa_dm4, 3 on aggressor. |
| `trap_S_ClearLoopingSounds` | 5 | cgame | not needed | retained emitters | Immediate-mode artifact: Q3 clears the set each frame because the set is rebuilt each frame. An emitter persists until something stops it. |
| `trap_S_RegisterSound` | 218 | cgame, q3_ui, ui | mapped | SoundAssetLoader |  |
| `trap_S_Respatialize` | 3 | cgame | mapped | SoundListener on the camera entity | AudioEmitterSystem forwards the listener pose from the component each frame. |
| `trap_S_StartBackgroundTrack` | 8 | cgame, ui | mapped | AudioEmitter, looping 2D on the music bus | worldspawn's music key, which SP_worldspawn copies into CS_MUSIC and CG_StartMusic hands over as an intro and a loop token. No map this port ships names a second token. oa_dm1 and oa_dm5 ask for Q3-original tracks OA does not ship, so they get none and the manifest says so. |
| `trap_S_StartLocalSound` | 71 | cgame, q3_ui, ui | mapped | AudioEmitter, finite 2D | Pickups and feedback tones, played dry -- the same emitter with is3D false, which is what makes it dry. |
| `trap_S_StartSound` | 77 | cgame | mapped | AudioEmitter, finite 3D | Positional one-shot: AudioBank.play builds an emitter entity at the point and removes it on the instance's onEnded. AudioEmitterSystem routes a finite 3D event down its direct path, so this reaches the same sopra playEvent a direct call would, one link later. |
| `trap_S_StopBackgroundTrack` | 6 | cgame, ui | mapped | remove the music emitter | AudioBank.stopMusic, and implicitly whenever a second track replaces the first. |
| `trap_S_StopLoopingSound` | 3 | cgame | mapped | remove the emitter entity | SoundLoop.stop. Unlinking is what stops the sound, so the removal is the stop. Called when a missile detonates, when a weapon is picked up, and when a bot switches or dies. |
| `trap_S_UpdateEntityPosition` | 4 | cgame | mapped | Transform on the emitter entity | SoundLoop.move writes the Transform the emitter was registered with. The spatial index subscribes to that vector's onChanged, so a rocket's fly sound follows the rocket and refits its BVH leaf only when it actually moves. |
| `trap_Send` | 1 | game | not needed | - | OA-specific raw send. |
| `trap_SendClientCommand` | 19 | cgame | not needed | direct call |  |
| `trap_SendConsoleCommand` | 57 | cgame, game | mapped | own console |  |
| `trap_SendServerCommand` | 169 | game | not needed | direct call / meep Signal | 169 call sites collapse to direct calls; the ones that matter carry HUD, scoreboard and print payloads. |
| `trap_SetBrushModel` | 13 | game | ported | kinematic RigidBody per submodel brush | Binds an entity to BSP submodel *N. On the physics backend the submodel becomes KinematicVelocity bodies; on the clipmap backend, entityClip.ts is SV_ClipMoveToEntities reduced to translation. |
| `trap_SetCDKey` | 5 | q3_ui, ui | not needed | - |  |
| `trap_SetConfigstring` | 53 | game | mapped | ECS singleton components | Configstrings are a replication cache; locally they are just game state. |
| `trap_SetPbClStatus` | 4 | q3_ui, ui | not needed | - | PunkBuster. |
| `trap_SetUserCmdValue` | 3 | cgame | mapped | own usercmd_t builder |  |
| `trap_SetUserinfo` | 9 | game | mapped | plain config object |  |
| `trap_SnapVector` | 6 | cgame, game | ported | - | Q3 rounds velocity to 1/8 unit per frame. Part of movement fidelity, not an optimisation. |
| `trap_StringContains` | 2 | game | not needed | String.includes | botlib string helper. |
| `trap_Trace` | 29 | game | ported | - | cm_trace.c ported verbatim. pmove fidelity depends on exact brush-plane sweep semantics, start-solid handling and the 1/32 epsilon; meep narrowphase gives different contact normals. |
| `trap_TraceCapsule` | 1 | game | ported | - | Capsule traces are used for player-vs-player in ioq3; OA defaults to bbox. |
| `trap_UnifyWhiteSpaces` | 4 | game | not needed | - | botlib chat helper. |
| `trap_UnlinkEntity` | 17 | game | mapped | ECS + BVH remove |  |
| `trap_UpdateScreen` | 11 | cgame, q3_ui, ui | not needed | - | Synchronous repaint during long loads; meep streams assets instead. |
| `trap_VerifyCDKey` | 5 | q3_ui, ui | not needed | - |  |
| `trap_argc` | 1 | game | mapped | own console tokenizer | Lowercase alias in OA g_local.h. |
| `trap_argv` | 1 | game | mapped | own console tokenizer | Lowercase alias in OA g_local.h. |
| `trap_getCameraInfo` | 2 | cgame | not needed | - |  |
| `trap_loadCamera` | 3 | cgame | not needed | - | Q3 .camera scripted-camera playback; unused in deathmatch. |
| `trap_startCamera` | 3 | cgame | not needed | - |  |

<!-- END TRAP MATRIX -->

---

## 3. Gap register

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
- **Severity:** major for anyone bringing in content from another engine. Every level format
  that predates real-time GI — Quake, Source, Unreal up to about 3, and most mobile pipelines
  today — ships baked lighting, and none of it can be brought in.
- **Suggested fix:** a `texture_lightmap` slot on `StandardShadeMaterial` sampled with `uv1`
  and multiplied into diffuse. The vertex channel and the attribute name already exist and
  already say "light map"; what is missing is the consumer.
- **Evidence:** `src/shade/renderer/lightmap/**`, `StandardAttributes.js`,
  `StandardShadeMaterial.d.ts`. Recorded at phase 1.

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

- **Severity:** medium — a correct answer to a different question, but the one a character
  controller asks is not available and cannot be derived from the result.
- **What happened:** With movement on meep's physics, the player wedged permanently on outside
  corners — velocity went to zero about a metre short of the corner and stayed there. Traced to
  the contact normal. A player box overlapping the join between a floor brush and a wall brush
  gets `normal = [0, 1, 0]` from `shape_cast` (up, the floor), because EPA resolves the
  *shallowest* separating axis and at that position the floor is shallower. The controller's
  slide-move clips velocity against up, which does nothing to the horizontal motion into the
  wall, so it re-traces, accumulates a second contradictory plane, hits its five-plane limit and
  zeroes velocity as a last resort. That is `PM_SlideMove`'s failure mode, but every slide-move
  controller has the same structure.
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
  separating plane, or a `contact_mode` on `shape_cast`. Either is cheap relative to what every
  consumer will otherwise re-implement, badly and privately.
- **Evidence:** `src/client/PhysicsTrace.ts` `contactPlane`, `test/physics-divergence.test.ts`.
  Recorded during the physics swap.

### GAP-013: `Collider.shape` is typed such that no concrete shape is assignable to it

- **Severity:** low — a pure type-level defect, one cast, but it is in the first line of code
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

- **Severity:** high -- the failure is total, silent, and presents as a bug in the consumer's own
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

- **Severity:** medium -- a wrong-but-plausible call that produces no error and no animation.
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

- **Severity:** medium, and narrower than the first version of this entry claimed. **That version
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

- **Severity:** high. The application renders perfectly at 160 FPS and cannot be played, and
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

### GAP-019: `shape_cast` answers "does the swept volume touch this body"; movement code asks "does this brush block this move"

- **Severity:** high — the two predicates disagree systematically at exactly the distances a
  character controller lives at, and the disagreement is not a tolerance to tune. It is
  load-bearing: taken at face value it stops the player dead, permanently.
- **What happened:** two reports in one session. A player stuck in an open corridor with velocity
  climbing to 320 units a second against a position that never changed, and a bot apparently
  standing in mid-air against a wall — which is not what it was doing, it had stopped falling.
  Both were the backend reporting `t = 0` for sweeps the clipmap says are free.
- **The mechanism, measured rather than reasoned.** `CM_TraceThroughBrush` is a signed-distance
  interval test over a brush's half-spaces, with a ±`SURFACE_CLIP_EPSILON` (1/8 unit) term on both
  ends. At `oa_dm1` (704.91, 686.92, 24.93), moving one frame at (2.56, 0.58, 0), brush 414 gives:

  | plane | `d1` | `d2` | |
  |---|---|---|---|
  | `(-0.71, 0.71, 0)` | 0.007 | -1.393 | entering: `(0.007 - 0.125) / 1.400 = -0.084` → clamped to 0 |
  | `(0, 1, 0)` | -0.080 | 0.500 | leaving: `(-0.080 + 0.125) / -0.580 = -0.078` |

  `enterFrac < leaveFrac` is `0 < -0.078`, which is false, so the brush **does not block** — with
  the box seven thousandths of a unit from one of its faces and moving into it. `shape_cast` sees
  the swept volume graze that face and reports a hit, correctly, to a different question.
- **Why it is a gap rather than a Q3 quirk:** the epsilon is a Q3 quirk and is recorded as one
  (D-030). The structural fact underneath is not. *Every* surface a character rests on or slides
  along is sub-epsilon away — that is what resting means — so a query that reports intersection
  without reporting whether the intersection opposes the sweep will fire on every contact, in
  every direction, forever. `skip_initial_overlaps` is the right idea and is not enough: it skips
  candidates already overlapping at `t = 0` (all of them — it `continue`s rather than `break`s,
  which is the correct choice), but a surface you are resting 1/8 unit from is not overlapping. It
  is reached at a very small positive `t`, and clamping that to zero is what wedges the player.
- **The result also cannot express `allsolid`.** Q3 separates "began inside a brush the sweep
  leaves" from "began inside and never gets out", and pmove's recovery path
  (`PM_CorrectAllSolid`) is gated on the second. `PhysicsSurfacePoint` has no field for it, so a
  backend built on `shape_cast` silently removes the escape hatch the movement code was written
  to rely on.
- **Workaround:** run the ported brush test over the brushes `overlap_shape` finds, and when
  `shape_cast` names a body whose brush that trace has already cleared, treat the contact as
  answered rather than as a blocker (`PhysicsTrace.alreadyRuledOn`). meep still does the sweep.
  Like GAP-012 this needs the source half-spaces kept alongside the `ConvexHullShape3D` — an
  application whose hulls came from a mesh has nothing to re-derive from and would have to give
  up or reimplement the broadphase.
- **What it costs to not fix:** the honest alternative is to hand the whole sweep to the ported
  trace over a swept-volume gather, which would make static collision exactly Q3's and reduce
  meep's physics to a broadphase for this use. It would measure better than the workaround. That
  is the real price of the gap: for character control specifically, the engine's own sweep stops
  being the thing you use it for.
- **What would fix it:** a directional predicate on the result — the separating-axis distance at
  `t = 0` signed against the sweep direction would be enough, since it is already computed — plus
  an `initially_overlapping` flag so a consumer can implement `allsolid` semantics. Both are
  information the query already has and discards.
- **Cost:** ~4 hours, and it took two rounds: the first fix (`allsolid`, and the position test)
  was necessary, correct, and moved the failure rather than removing it. Recorded because that is
  the shape of this class of bug — several independent places where a Q3 semantic was approximated
  rather than reproduced, each individually plausible, failing together.
- **Evidence:** `src/client/PhysicsTrace.ts` (`trace`, `contactPlane`, `alreadyRuledOn`),
  `test/physics-wedge.test.ts` (the `walking` half), `tools/trace-compare.ts`. Measured
  improvement: trace hit/miss agreement 88.7% → 99.9%, strafe-jump p90 121.3 → 34.0,
  walk-into-walls p90 1.77 → 0.22, and zero sweeps where the physics passes through something the
  clipmap blocks. See D-063.

### GAP-020: There is no way to ask a swept query to stop short of contact

- **Severity:** medium — a one-line need with no expression in the API, whose absence is invisible
  until something downstream integrates the error.
- **What happened:** characters hovering above the floor, reported by a player. Underneath it, a
  falling player who never landed: Q3 stops a box `SURFACE_CLIP_EPSILON` (1/8 unit) short of a
  surface, so a move ending a twentieth of a unit above the floor is *blocked* in Q3 and *clear*
  in `shape_cast` — which is the correct answer to the question `shape_cast` was asked. The player
  overshot the resting height by a tenth of a unit, bounced back up at landing speed, and repeated
  forever. `groundEntityNum` never left `ENTITYNUM_NONE`, so the animation code played the jump
  clip, so every bot in the level stood with its legs tucked up. 63 of 64 dropped players never
  landed.
- **Why a standoff is not a quirk:** every character controller needs one. Resting a body exactly
  on a surface makes the next frame's query start in contact, and then the controller has to
  distinguish "resting" from "blocked" with no information to do it with. Q3 solved it in 1999 by
  offsetting the planes; every engine solves it somehow. What is missing is a way to *say* it to
  the query.
- **Workaround:** put the epsilon in the shape. For a box against a plane, offsetting the plane
  outward by `e` is exactly growing the box by `e`, so the sweep uses a box inflated by
  `SURFACE_CLIP_EPSILON` and the fraction is `hit.t / length` with nothing subtracted. This is
  correct and it is also *not obviously* correct — the first implementation subtracted the epsilon
  from the resulting fraction, which is the same thing whenever the sweep reaches the surface and
  silently different when it stops just short. That asymmetry is the whole bug.
- **Cost of the workaround:** the inflated box is a second `BoxShape3D` per size, and it makes
  `shape_cast` report `t = 0` for every surface the body rests against, in every direction —
  which is what GAP-019's machinery then has to sort out. The two gaps compound: an engine that
  offered a standoff parameter would remove most of the need for the per-brush re-derivation as
  well.
- **What would fix it:** a `standoff` (or `skin_width`) parameter on `shape_cast` — contact
  reported when the swept shape comes within `standoff` of a body rather than when it touches.
  PhysX, Bullet and Unity all expose some form of this, under various names, because character
  controllers all need it. It is a subtraction on an existing comparison.
- **Evidence:** `src/client/PhysicsTrace.ts` (`boxShape`'s `grow`, and the `trace` docblock),
  `test/physics-wedge.test.ts` (the `standing` block). Measured improvement on `oa_dm1`: trace
  hit/miss agreement 99.9% → 100.0%, fraction absolute error p90 1.3e-3 → 5.3e-8, chaos
  divergence p90 0.18 → 0.00 with every frame inside one unit. See D-064.

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

| | `oa_dm1` | `aggressor` |
|---|---|---|
| solid brushes → static bodies | 575 → 537 | 835 → 824 |
| hull generation | 9 ms | 12 ms |
| body + collider construction | 11 ms | 16 ms |
| sweeps sampled | 20,000 | 20,000 |
| agree on hit/miss | 88.2% | 89.6% |
| contact normals agreeing | 99.6% of 1,076 valid-plane hits | 98.2% of 1,300 |
| sweep fraction error, median / p90 | 0.0 / 1.5e-3 | 0.0 / 1.4e-3 |

Position divergence after 400 frames of identical input, `oa_dm1`:

| input pattern | median | p90 | max | within 1 unit |
|---|---|---|---|---|
| strafe-jump | 0.17 | 271.0 | 762.1 | 62% |
| bunny-hop | 0.06 | 0.12 | 1.3 | 98% |
| walk-into-walls | 0.09 | 2.60 | 299.1 | 89% |
| chaos | 0.00 | 1.28 | 188.0 | 90% |

Read the medians, not the maxima. Two runs that separate at frame 200 and then explore different
parts of a level produce an arbitrarily large number; that is chaos, not error. What the medians
say is that the physics backend and Q3 agree to well under a centimetre on typical frames, and
that strafe-jumping — the input pattern most sensitive to which plane a grazing contact reports
— is the one that eventually separates. D-031 records what is still different and why one
plausible fix for it was 8x worse.

Cost of the swap, for a maintainer estimating similar work: ~14 hours, of which roughly 2 were
`brushHull.ts` (the plane-set-to-polyhedron conversion), 2 were GAP-012, and the remaining 10
were building the three-way measurement harness. The harness is why the other four hours were
enough — without a bit-exact control, "close enough" is a matter of opinion and the corner bug
in particular would have been indistinguishable from a movement-code bug.

### Phases 3b-5 — items, movers, characters, audio, bots

Same host. Load-time figures are from `oa_dm1`, which is a small map; `am_thornish` is the large
one and is called out where it differs.

| stage | cost | note |
|---|---|---|
| static bodies from brushes | 8-22 ms | 529 bodies on `oa_dm1` |
| items: place and build | 36-88 ms | 31 pickups, 55 drawn pieces, meshlets built lazily |
| movers | <1 ms | 6 brush entities, 6 kinematic bodies |
| navigation graph | 214 ms | 766 nodes, 1,957 links, 205 drops -- built through the *physics* trace, which is why it is not the 25 ms the clipmap takes |
| characters | ~40 ms each, async | 15 models, 3 to 10 mesh nodes each; fetched and built off the critical path |
| sound bank | one fetch | 77 names over 58 files, 3.3 MB |

Per frame, measured by driving the simulation directly:

| | cost |
|---|---|
| 6 bots: perception, tree, `Pmove`, character placement | 1.3-1.8 ms |
| of which planning, when it runs | one BFS plus one A* per bot, at most every 0.25 s |

The bot cost is worth two notes. It started at 3.7 ms a frame for *six stationary bots*, all of
it A* failing to route to the same unreachable item every frame -- a reachability pass before
scoring fixed the behaviour and the cost together. And the planning rate limit is not a tuning
knob for performance so much as a correctness one: the planning branch is the tree's fallback, so
it runs on every frame a bot has nothing else to do.

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

> Behaviour that contradicts the engine's own documentation or assertions, each with a minimal
> reproduction. Nothing qualifying recorded yet.

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

---

## 8. Docs and samples gaps

- No runnable engine sample of any kind in the package (GAP-002).
- No document that names the entry point. `EngineHarness` is discoverable only by reading a
  directory listing.
- The README links to `meep.company-named.com/docs` and to a GitLab quick-start template.
  Neither is inside the package, so an engineer working from `node_modules` — which is where
  you end up when the samples are not useful — has neither.
- No stated import convention. That the package is deep-import-only is inferable from
  `exports` and from a failed import, and from nowhere else.

---

## Appendix: environment

| | |
|---|---|
| meep | `@woosh/meep-engine@3.0.2` (peer dependency, never vendored) |
| Node | v24.15.0 |
| TypeScript | 5.9, `strict: true` |
| Bundler | Vite 6 |
| Test runner | Vitest 3 |
| OA gamecode | `OpenArena/gamecode` @ `5478aad23b12857d265103f6aa2f5258c78799c8` |
| ioquake3 | `ioquake/ioq3` @ `588393618dbc82e7207c21c6ddecca229944a03a` |
| Oracle toolchain | Emscripten 6.0.8 (`aeb67926e7de656da38bc807d83050af93578758`) |
| Host | Windows 11, WebGPU via Chrome |
