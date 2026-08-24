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

> Ranked, most consequential first. Populated as evidence accumulates; a rank with no gap
> entries behind it is not yet earned. Current state: end of phase 0.

1. **`/samples` does not contain a single sample of the engine rendering anything.** The
   published package ships `samples/generation/**` and nothing else — 30-odd files, all of
   them procedural-map-generation fixtures. There is no sample that boots the engine, loads a
   model, lights it, or draws a frame. The brief for this port said "read the source, the
   `/samples` folder, and the docs"; two of those three do not exist inside the package. See
   GAP-002.
2. **Getting from `npm install` to a rendered frame took about 2.5 hours, and none of it was
   spent on graphics.** The engine itself came up cleanly and rendered at 230 FPS on the first
   frame it drew. The time went to three integration defects that a consumer hits in a fixed
   order and cannot skip: an optional peer dependency that is a mandatory top-level import
   (GAP-003), worker bundles addressed at a web-root path that no application has (GAP-004),
   and a missing `./package.json` export that breaks the standard way of locating a package
   root. Each is individually small. Together they are the entire first-run experience.
3. **Generated `.d.ts` files do not typecheck standalone.** Ten distinct unresolved type names
   leak out of JSDoc into the published declarations. Consumers are forced into
   `skipLibCheck: true`, which also disables checking of every *other* dependency they have.
   See GAP-001.
4. **Clustered lighting is as good as advertised, and the port depends on it existing.** 147
   dynamic point lights on a 198k-triangle level cost 7.28 ms of CPU per frame — light count
   did not register against geometry count. This matters more than a benchmark: q3map2 strips
   every `light` entity from a compiled BSP (measured: zero across six maps) and meep cannot
   import Q3's baked lightmaps, so reconstructing the lighting as dynamic lights was not a
   showcase choice, it was the only remaining route to a lit level. It worked with no tuning.
5. **Baked lightmaps cannot be imported, only baked.** The vertex channel exists, the attribute
   is literally named "used for light map", and there is a whole lightmap subsystem — but it is
   a baker, and no material has a lightmap slot. Every level format that predates real-time GI
   ships baked lighting; none of it can come in. See GAP-006.
6. **Meshlet construction is synchronous and is 92% of level load time.** 1,246 ms of unbroken
   main-thread work for a 198k-triangle level, in an engine that has an asset streamer, a
   concurrent executor and a worker pool. See GAP-008.
7. **Two-thirds of Q3's engine surface is netcode, bot AI and 1999-era platform plumbing that
   meep correctly does not have.** Of 309 distinct `trap_*` syscalls, 205 belong to subsystems
   this port deletes outright. Of the 104 that remain, 75 map onto an existing meep facility.
   Worth stating plainly before the gap register makes things look worse than they are.
8. *(further items land as phases complete)*

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
| `mapped` | 75 | a meep facility does the job |
| `ported` | 19 | reimplemented faithfully in TypeScript; deliberately *not* mapped onto meep |
| `workaround` | 9 | meep has no direct facility; solved outside the engine |
| `GAP` | 1 | no reasonable answer; see gap register |
| `not needed` | 205 | the whole subsystem is out of scope (netcode, botlib, CD keys, cinematics) |

| Q3 syscall | uses | modules | disposition | meep facility | notes |
|---|---:|---|---|---|---|
| `trap_AAS_AlternativeRouteGoals` | 10 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaInfo` | 5 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaReachability` | 21 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_AreaTravelTimeToGoalArea` | 16 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_BBoxAreas` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EnableRoutingArea` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_EntityInfo` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_FloatForBSPEpairKey` | 6 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Initialized` | 10 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_IntForBSPEpairKey` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_NextBSPEntity` | 12 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointAreaNum` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointContents` | 8 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PointReachabilityAreaIndex` | 4 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictClientMovement` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PredictRoute` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_PresenceTypeBoundingBox` | 5 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Swimming` | 5 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_Time` | 3 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_TraceAreas` | 7 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_ValueForBSPEpairKey` | 16 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AAS_VectorForBSPEpairKey` | 4 | game | not needed | meep navmesh (Polyanya) + BVH | AAS replaced wholesale: bots run on meep behaviour trees + navmesh. Brief section 2. _(classified by prefix `trap_AAS_`)_ |
| `trap_AddCommand` | 31 | cgame | mapped | own console command table |  |
| `trap_AdjustAreaPortalState` | 4 | game | not needed | - | As above. |
| `trap_AreasConnected` | 2 | game | not needed | - | Areaportal state only mattered for PVS-driven network scope. |
| `trap_Argc` | 34 | cgame, game, q3_ui, ui | mapped | own console tokenizer |  |
| `trap_Args` | 7 | cgame, game | mapped | own console tokenizer |  |
| `trap_Argv` | 51 | cgame, game, q3_ui, ui | mapped | own console tokenizer |  |
| `trap_BotAddAvoidSpot` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocChatState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocGoalState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAllocateClient` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChatLength` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseBestFightWeapon` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseLTGItem` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotChooseNBGItem` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpAvoidGoals` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotDumpGoalStack` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEmptyGoalStack` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotEnterChat` | 103 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFindMatch` | 10 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeChatState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeClient` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeGoalState` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeItemWeights` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotFreeWeaponState` | 5 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetChatMessage` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetLevelItemGoal` | 12 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetMapLocationGoal` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetNextCampSpotGoal` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSecondGoal` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetServerCommand` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetSnapshotEntity` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetTopGoal` | 16 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGetWeaponInfo` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotGoalName` | 24 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitLevelItems` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitMoveState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInitialChat` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotInterbreedGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotItemGoalInVisButNotVisible` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibDefine` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibLoadMap` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibSetup` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibShutdown` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibStartFrame` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibTest` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibUpdateEntity` | 9 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarGet` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLibVarSet` | 26 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadCharacter` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadChatFile` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadItemWeights` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotLoadWeaponWeights` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMatchVariable` | 60 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveInDirection` | 10 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMoveToGoal` | 9 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMovementViewTarget` | 8 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotMutateGoalFuzzyLogic` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNextConsoleMessage` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumConsoleMessages` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotNumInitialChats` | 32 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPopGoal` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPredictVisiblePosition` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotPushGoal` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotQueueConsoleMessage` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReachabilityArea` | 2 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveConsoleMessage` | 7 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotRemoveFromAvoidGoals` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplaceSynonyms` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotReplyChat` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidGoals` | 6 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetAvoidReach` | 20 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetGoalState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetLastAvoidReach` | 11 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetMoveState` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotResetWeaponState` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSaveGoalFuzzyLogic` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetAvoidGoalTime` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatGender` | 8 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotSetChatName` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotTouchingGoal` | 18 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUpdateEntityItems` | 3 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
| `trap_BotUserCommand` | 4 | game | not needed | meep behaviour trees + blackboard | botlib deleted; anti-goal in brief section 10. _(classified by prefix `trap_Bot`)_ |
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
| `trap_CM_LerpTag` | 7 | q3_ui, ui | not needed | as above |  |
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
| `trap_R_LerpTag` | 6 | cgame | not needed | skeletal animation + attachment sockets | MD3 tag hierarchy replaced per brief section 2. |
| `trap_R_LightForPoint` | 3 | cgame | GAP | nothing directly | Q3 samples the BSP lightgrid to shade dynamic models. See gap register. |
| `trap_R_LoadWorldMap` | 3 | cgame | mapped | offline BSP to scene bundle plus runtime load |  |
| `trap_R_ModelBounds` | 11 | cgame, ui | mapped | AABB3 from scene bundle |  |
| `trap_R_RegisterFont` | 10 | cgame, ui | mapped | engine/asset/loaders/font + UI text |  |
| `trap_R_RegisterModel` | 124 | cgame, q3_ui, ui | mapped | AssetManager + GLTFSceneBundleAssetLoader | MD3 converted to glTF offline, loaded through meep glTF path. |
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
| `trap_S_AddLoopingSound` | 9 | cgame | mapped | looping sound emitter | Q3 rebuilds the looping-sound set every frame; meep keeps them as entities. |
| `trap_S_AddRealLoopingSound` | 3 | cgame | mapped | looping sound emitter |  |
| `trap_S_ClearLoopingSounds` | 5 | cgame | not needed | retained emitters | Immediate-mode artifact. |
| `trap_S_RegisterSound` | 218 | cgame, q3_ui, ui | mapped | SoundAssetLoader |  |
| `trap_S_Respatialize` | 3 | cgame | mapped | SoundListener component |  |
| `trap_S_StartBackgroundTrack` | 8 | cgame, ui | mapped | music bus / streaming source |  |
| `trap_S_StartLocalSound` | 71 | cgame, q3_ui, ui | mapped | 2D sound event |  |
| `trap_S_StartSound` | 77 | cgame | mapped | sound emitter component | Positional one-shot. |
| `trap_S_StopBackgroundTrack` | 6 | cgame, ui | mapped | music bus |  |
| `trap_S_StopLoopingSound` | 3 | cgame | mapped | stop/remove emitter |  |
| `trap_S_UpdateEntityPosition` | 4 | cgame | mapped | Transform on emitter entity |  |
| `trap_Send` | 1 | game | not needed | - | OA-specific raw send. |
| `trap_SendClientCommand` | 19 | cgame | not needed | direct call |  |
| `trap_SendConsoleCommand` | 57 | cgame, game | mapped | own console |  |
| `trap_SendServerCommand` | 169 | game | not needed | direct call / meep Signal | 169 call sites collapse to direct calls; the ones that matter carry HUD, scoreboard and print payloads. |
| `trap_SetBrushModel` | 13 | game | ported | - | Binds an entity to BSP submodel *N; drives door/plat collision. |
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

  **What it costs, visually, measured on the running demo:** large flat surfaces read as
  uniform. 29 of `oa_dm1`'s 30 materials have their albedo texture loaded and the walls show
  full brick detail, but the floors look untextured. That is not a texturing bug — it is the
  absence of the baked ambient occlusion and light falloff that gave Q3's floors their
  variation. Reconstructed point lights cannot substitute, because what is missing is not
  brightness but *spatial variation* in brightness. This is the single most visible quality gap
  in the demo and it traces directly to this entry.
- **Severity:** major for anyone bringing in content from another engine. Every level format
  that predates real-time GI — Quake, Source, Unreal up to about 3, and most mobile pipelines
  today — ships baked lighting, and none of it can be brought in.
- **Suggested fix:** a `texture_lightmap` slot on `StandardShadeMaterial` sampled with `uv1`
  and multiplied into diffuse. The vertex channel and the attribute name already exist and
  already say "light map"; what is missing is the consumer.
- **Evidence:** `src/shade/renderer/lightmap/**`, `StandardAttributes.js`,
  `StandardShadeMaterial.d.ts`. Recorded at phase 1.

### GAP-007: `draw_side` exists, is documented as having no effect, and there is no double-sided path

- **Needed:** Q3 shaders use `cull none` for grates, railings, foliage, banners and flags —
  surfaces authored as a single sheet of polygons meant to be visible from both sides. They
  are common: they appear in most maps in the OA set.
- **meep offers:** `ShadeMaterial.draw_side` with a `ShadeDrawSide` enum, whose own docblock
  says: *"Does not affect the actual drawing. Drawing is always done with 'Front' mode, with
  backfaces always being culled. If you want double-sided drawing - you need to clone the
  geometry and flip normals."*

  Credit where due — that is exactly the right way to document a non-functional field, and it
  saved me from debugging it. But a settable property that is documented to do nothing is a
  trap with a warning sign on it rather than no trap.
- **Workaround:** duplicate the triangles with reversed winding and flipped normals at asset
  build time, for materials the shader conversion marked `doubleSided`. Straightforward in the
  pipeline (it is the same vertices, reversed indices) and costs a little geometry. Not yet
  applied — currently these surfaces are simply single-sided and disappear when viewed from
  behind, which is visible in a few places and is filed here rather than hidden.
- **Severity:** minor, given the docblock. It would be major without it.
- **Suggested fix:** either implement it — the renderer has the pipeline state, and a
  per-material cull mode is a pipeline key rather than a shader change — or remove the field
  and the enum so it cannot be set at all.
- **Evidence:** `src/shade/renderer/material/ShadeMaterial.d.ts`,
  `tools/pipeline/shader-to-pbr.ts` (`doubleSided`). Recorded at phase 1.

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

> Further entries are added as they are hit. Numbering is stable — a withdrawn entry is
> marked withdrawn rather than renumbered.

---

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

- **`ShadeMaterial.draw_side` is the model to copy.** A settable property documented in its own
  docblock as having no effect, with the workaround spelled out. It cost me nothing because the
  answer was where I looked. Whatever process produced that comment should be applied to the
  `DESIGN.md` header above.

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
