# Plan: networking — a server-authoritative deathmatch on meep's netcode

Forward-looking, and written to be executed by an AI agent. `DECISIONS.md` records what was
decided, `REPORT.md` what was measured, `PLAN.md` is the finished phase-9 plan; this is what is
intended and has not happened yet. Every step names its exit criterion, because a step that cannot
be checked is a wish.

**Status: not started.** Nothing in `src/` speaks to a network. The engine ships a complete
netcode package; this port has never imported it.

---

## 0. Read this first

### 0.1 What is being asked, and why it contradicts the brief

`INITIAL_INSTRUCTIONS.md` section 2 says *"Networking — delete entirely. Single process. Do not port
snapshots, delta compression, or client prediction"*, and section 10 lists "port netcode" as an
anti-goal. That constraint is now reversed by the maintainer: multiplayer is in scope. Record the
reversal as the first DECISIONS entry of this work (see §9), exactly as D-110 recorded the earlier
inversion of the fidelity priority — every argument below is downstream of it and none can be
re-derived from the code.

The priority order from D-110 still holds: **exercise meep well first, produce a faithful port
second.** So this plan uses `engine/network` wherever it can — even where a hand-rolled protocol
over a WebSocket would be fewer lines — and files every place it does not fit as a GAP in
`REPORT.md`. The friction is the data; that is the point of the whole repository.

### 0.2 Documents to read before touching code

- `README.md` (index), `PLAN.md` (the phase-9 shape: fixed step, systems, interpolation).
- `DECISIONS.md`: D-025 (simulation raises events, presentation decides), D-050 (a bot is a
  `usercmd_t`), D-071 (movement on `KinematicMover`), D-110 (priority inversion, 60 Hz, no
  `pmove_fixed`), D-131 (BVH shape moves sweep answers by 1e-5), D-132 and D-155 (render-rate
  camera), D-162 (bot difficulty and the `BotWorld` seam).
- `REPORT.md` §2 (trap matrix and how `--check` works), GAP-014, GAP-036, GAP-037.
- `src/app/systems.ts` header (the two load-bearing properties of `EntityManager.update`).
- The engine's own docs on the package: `node_modules/@woosh/meep-engine/src/engine/network/README.md`
  and `CONGESTION_CONTROL.md`, then the docblocks in `NetworkSession.js`, `ServerAuthoritativeServer.js`,
  `ServerAuthoritativeClient.js`, `NetworkPeer.js`, `replication/Replicator.js`. §3.2 and §3.3
  below summarise what was found there against meep **3.14.2**; re-verify against whatever
  version `package.json` pins when you start, because this port has watched the engine move
  under it mid-session before (`vite.config.ts` `MEEP_PATCHES`).

### 0.3 Working rules in this worktree

These are conventions other sessions have already paid for; they are not optional.

- **Other sessions edit this worktree at the same time.** `git status` at any moment shows their
  half-finished work, and shows *phantom deletions* (`D` plus `??` for the same path) because the
  shared index goes stale — nobody deleted your files. Never `git stash`, never `git checkout --`
  or `git restore` a path, never run a recursive delete anywhere near `assets/` (it contains
  junctions; one cleanup step destroyed the tree once, D-104).
- **Commit through a private index**: `GIT_INDEX_FILE=<scratch>/index git add <your files>` then
  `GIT_INDEX_FILE=... git commit`, so the shared index being reset under you mid-commit cannot
  take your staging with it. Commit to the current branch (`main`) unless told otherwise; never
  branch unsolicited. Rebuilt bundles under `assets/` are committed, not ignored.
- **DECISIONS numbering collides.** Two sessions take the same `D-nnn`. Take `max + 1` at the
  moment you write, and if you find a collision later, renumber the one no code or commit names.
  Same for `GAP-`/`BUG-` numbers in `REPORT.md`.
- **Do not pin broken behaviour in a test.** A test asserting that the engine drops a late
  joiner's inputs would pass on the wrong value; write the test for the behaviour you want and make
  it pass with the workaround. A failing test beats one that passes on the wrong value.
- **Heredocs mangle backslashes** in this shell. Write patch scripts to a file and run the file.
- **Verification is `npm run check`** (typecheck, trap matrix `--check`, balance/material/effect
  extractors `--check`, then the whole vitest suite). The suites need `assets/built/oa_dm1` and
  `assets/built/aggressor` (see `README.md` Setup). Run it before every commit. The browser is
  verified through the preview pane's dev server (`.claude/launch.json` → port 5199), with the
  engine reachable as `window.queep` (see `expose()` in `src/app/main.ts`).
- **Every step ends with** a DECISIONS entry for what was decided, REPORT entries for what the
  engine made hard, and `npm run check` green.

---

## 1. What is already built, and what the design has to respect

### 1.1 The game, as it stands

The simulation is a set of ECS-free classes advanced on `EntityManager`'s 60 Hz fixed step by thin
`System` subclasses (`src/app/systems.ts`), with presentation on `update`:

| class | file | role | networking relevance |
|---|---|---|---|
| `PlayerController` | `src/client/PlayerController.ts` | input → `usercmd_t`, movement step, weapon cooldown/fire, bob cycle, view-pose history, camera | has to split into *input sampling*, a *shared per-frame step*, and *presentation* (§4.4) |
| `createPmoveHost` | `src/game/PmoveHost.ts` | one `pmove_t` per character; the trace seam | reused verbatim, server and client |
| `PlayerMovement` / `MeepMove` | `src/client/MeepMove.ts` | Q3's motor on `KinematicMover`; copies `ps` → `MoveState` → `ps` per step | `MoveState` keeps `grounded`, `groundNormal`, `jumpHeld`, `ducked`, `viewheight` *outside* `ps` — replay after a rewind needs them (§5.1) |
| `Bot`, `BotRuntime`, `BotWorld` | `src/game/Bot.ts`, `src/client/Bots.ts` | a bot fills a `usercmd_t` and runs the same movement; perception through `BotWorld.playerOrigin()/playerAlive()` | server-only; `BotWorld` must learn about *several* humans (§6, step 6) |
| `WeaponSystem` | `src/game/Weapons.ts` | fire, hitscan, splash, damage; raises `WeaponEvents`; `DamageQuery`, `MissileWorld` seams; `targets: Damageable[]` keyed by client id | server-only; the events become network events; `fire()` already takes a `seed` |
| `Missiles`, `CharacterBodies`, `DamageQueries` | `src/client/*.ts` | physics bodies for missiles and characters, contact → impact, broadphase damage queries | server-side as in `test/match.test.ts`; the client keeps character bodies only (for prediction) |
| `ItemSystem` | `src/game/Items.ts` | spawn/drop, touch, give, respawn; `update(dt, origin, inventory, alive)` advances the clock **and** tests one player | needs `advance(dt)` split from `touch(player)` so N players do not advance time N times |
| `MoverSystem`, `WorldEffects` | `src/game/Movers.ts`, `src/game/WorldEffects.ts` | doors/plats/buttons/triggers on an integer-ms clock; `update(dt, mins, maxs, alive)` advances the clock and tests one player | same split; `WorldEffects.apply` becomes per-player |
| `Arena` | `src/client/Arena.ts` | `WeaponEvents` → particles, decals, sounds, HUD counters; `LOCAL_CLIENT = 0` | becomes the client's *event sink* for events that arrive over the wire; `LOCAL_CLIENT` becomes "my slot" |
| `roster.ts` | `src/app/roster.ts` | one bot per spawn beyond the player's; the player as a `Damageable` with accessors into the inventory | the server's roster; the `Damageable`-with-accessors shape is what every human slot needs |
| `systems.ts` | `src/app/systems.ts` | `PlayerSystem`, `ViewSystem`, `CombatSystem`, `PickupSystem`, `BotSystem`, `WorldEffectSystem`, `CharacterBodySystem`, `PoseRecorderSystem`, `PresentationSystem` | server gets its own registration; client gets `NetClientSystem`/`NetRenderSystem` (§4.3) |
| `HeadlessPhysics` | `tools/pipeline/headless-physics.ts` | a real `EntityManager` + `PhysicsSystem` under Node; **model 0 only, no mover bodies** | the server's physics; needs mover bodies (`PhysicsWorld.addMover`) |
| `test/match.test.ts` | | a six-bot deathmatch headless on the shipping backend, no renderer | **the server is this arrangement plus movers plus a `NetworkSession`** |

Facts to keep in view:

- **Clock.** `em.fixedUpdateStepSize` is the engine default `0.016666666666` (not exactly 1/60).
  Timers run on whole milliseconds carried across steps (16, 17, 17, 16 …); the solver gets the
  exact step. `pmove_fixed` is deliberately not set (D-110).
- **Nondeterminism today:** `Math.random` in `systems.ts:149` (respawn point), `roster.ts:108` and
  `main.ts:1352` (weapon seed), `Bots.ts:622,673` (goal choice, bot respawn), `Bot.random` (aim
  error, injectable), `Effects.ts`/`Audio.ts` (presentation only). Weapon spread already takes an
  explicit seed and reproduces `Q_crandom` (D-026).
- **Client ids:** 0 is the person at the keyboard, `1000+` shootable boxes, `2000+` bots. `Arena`
  and `roster.ts` both hard-code the zero.
- **Presentation reads simulation objects directly**: `Character.place(ps.origin, yaw)` per bot per
  step, `ItemsView` reads `ItemInstance.present`, `MoversView` reads `Mover.origin`, HUD reads
  `PlayerController.inventory`, `MissileView` is driven from `Arena.projectileSpawned/Gone`.
- **Interpolation:** physics bodies blend on the engine's timeline; poses the application writes
  (bots, doors, missiles) blend on the app timeline through `PoseRecorderSystem` (registered last).
  The camera is written at render rate from the last two predicted eye poses (`writeCamera`).
- **The menu** is a list of page values with `slider | toggle | choice` settings only
  (`src/client/ui/Settings.ts`); there is no text field, so "server address" cannot be a menu row
  without adding a kind. Query parameters are this port's established switchboard (`README.md`).

### 1.2 What the engine ships: `engine/network` in meep 3.14.2

Read, not assumed. Paths are under `node_modules/@woosh/meep-engine/src/engine/network/`.

| layer | pieces | what it does |
|---|---|---|
| transport | `transport/Transport.js` base; adapters `LoopbackTransport`, `SimulatedTransport` (latency/jitter/loss, clock-driven), `WebSocketTransport` (duck-typed over any `WebSocket`, `reliable = ordered = true`), `WebRTCDataChannelTransport`, `WebTransportTransport`, `NodeUDPTransport` | opaque byte buffers; `onReceive`, `onDisconnect`, `send(bytes, length)`, `connect()` |
| channel | `transport/Channel.js`, `ReliableCommandPipeline.js`, `fragments/*` | seq + ack bitfield (9-byte header), MTU 1200 fragmentation with NACK, at-least-once commands (≤ ~1180 B payload) |
| sim core | `sim/SimAction.js` (+ `SimAction.extend` codegen), `SimActionExecutor.js` (the only legal mutator of replicated state; captures prior bytes per affected component into the `ActionLog`), `RewindEngine.js`, `Snapshotter.js`, registries | record / apply / rewind replicated mutations |
| replication | `replication/Replicator.js` (packs `[last_acked+1 .. current]` per peer, scope-filtered; unpacks execute-on-arrival or defers), `ScopeFilter.js` (`AlwaysRelevantScope`, `OwnerAwareScope`) | per-peer action stream |
| orchestrators | `orchestrator/NetworkPeer.js` (per-peer channels, packet dispatch, AUTH_STATE / INITIAL_SYNC / RESUME / DISCONNECT / TIME_DILATION packets), `ServerAuthoritativeServer.js` (deferred inputs, `simulation_delay_ticks`, rollback + replay, `onLocalSim`, `onTickComplete`), `ServerAuthoritativeClient.js` (`onPredict`, `onReplay`, `onApplyAuthState`, scalar no-op short-circuit, `InputRing`) | the predict/reconcile and rollback algorithms |
| facade | `NetworkSession.js` | one object: `replicate(Class, interp?)`, `defineAction(Class)`, `defineInputSampler(fn)`, `start()`, `connect(peer, transport)`, `tick(dt)`, `send(action)`, `drop_peer`, `disconnect`; auto-wires `NetworkSystem`, `NetworkIdentity`, the synthetic `ReplaceComponentAction` behind `dataset.sendEvent(e, "net_mutate_component", {component_type, new_state?})`, INITIAL_SYNC on connect, AUTH_STATE per owned entity per tick, `OwnerAwareScope` on the host, time dilation, an `InterpolationLog` + `AdaptiveRenderDelay` render pass for remote-owned entities, grace window + reconnect ladder |
| opt-in | `time/TimeSync.js`, `time/JitterBuffer.js`, `sim/SmoothingState.js`, `state/PriorityAccumulator.js`, `diagnostics/BandwidthMeter.js`, `diagnostics/ReplayLog.js`, `diagnostics/SyncTest.js` (`fingerprint_world`) | deliberately unwired library surface |

The engine's documented model (docs site, `docs/platform/networking/`): *replicate inputs, not
state* — every peer runs the same deterministic simulation from the same actions, the server sends
AUTH_STATE for client-owned entities, and the client rewinds + replays its own inputs on
divergence. The physics page promises bit-exact `PhysicsSystem` results across V8 runtimes for the
same inputs in the same order.

### 1.3 Facts that shape the design (verified in 3.14.2; re-check on upgrade)

1. **`session.tick(dt)` has its own fixed-step accumulator and never calls `EntityManager.update`.**
   Host: one step = `server.tick(local_frame++)`. Client: one step = up to three `client.tick()`
   calls under time dilation, each followed by an empty ack packet. The engine's step and the
   session's frame are two clocks; this plan ties them by calling `session.tick()` once per
   `fixedUpdate` (§4.3). `tick()` also ends with the render-interpolation write, so it is also
   called with `dt = 0` once per rendered frame.
2. **A late-joining client's frame counter is never aligned to the host's.** The client's
   `#local_frame` starts at 0 at `start()`, the `onInitialSync` handler ignores the packet's
   `frame_number`, and the field is `#private`. The server trims pending actions older than
   `current_sim_frame - frame_capacity + 1` (32 frames), so a client joining a host at frame 6000
   has every input dropped and its predictions overwritten with no replay. **Workaround:** the
   hello handshake carries the host's frame and the client fast-forwards its session before
   `connect()` (§5.4). File as a GAP; this is the first thing to test.
3. **No entity creation or destruction is replicated after INITIAL_SYNC.** `ReplaceComponentAction.apply`
   returns silently when `slot_table.entity_for(network_id) < 0`; `STATE_BURST` updates existing
   entities only. **Design consequence:** every networked thing is a fixed pool of entities created
   before the first client connects (§5.2). A joining client gets all of them in one INITIAL_SYNC.
4. **The action log is open only inside a tick.** `SimActionExecutor.execute` writes into
   `ActionLog.current_buffer()` unconditionally, and that throws `no frame is open` between
   ticks; on the host a frame is open only inside `ServerAuthoritativeServer.#replay_frame`, i.e.
   during `onLocalSim(f)`. Server-originated mutations (`net_mutate_component`) therefore have to
   be issued from `onLocalSim`, and `onLocalSim` **re-runs for every frame in a rollback window**.
   The world step cannot be idempotent, so it runs only when `f` is the newest frame (§4.2).
5. **Every mutation of a replicated component must go through an action** or rewind restores a
   value nobody re-applies. Concretely: the world step writes game objects (inventories, bots,
   projectiles); a *publish pass* turns changed state into `ReplaceComponent` actions every frame.
6. **The action stream ignores `transport.reliable`.** `NetworkPeer.flush_outbound` packs every
   frame in `[last_acked + 1, current]` for every peer every tick, so each frame is sent about
   (RTT in frames + 1) times even over a WebSocket. Bandwidth is state-per-tick × redundancy; it
   has to be measured (`BandwidthMeter`) and reported, and `frame_capacity` (default 32 frames,
   0.53 s) bounds the RTT the ring tolerates — raise it to 64 for the host.
7. **Render interpolation needs a record every tick.** `InterpolationLog.interpolate` blends
   `tick_a`/`tick_b`; a component absent from one of them snaps. Moving server-owned state is
   published every tick, not every Nth.
8. **Scratch limits:** one component's serialized form must fit `SCRATCH_BUFFER_BYTES = 1024`;
   a reliable command payload ≤ `MAX_RELIABLE_COMMAND_PAYLOAD_BYTES` (~1180).
9. **Peer ids are `0..254`** (`SENDER_LOCAL = 0xFF`); the host defaults to 0, a client to 1;
   every client needs a unique id the host hands out.
10. **`replicate()` order is wire-format order** and must be identical on every peer; one shared
    `registerProtocol(session)` function is the only place it is written.
11. **Ownership is decided at attach time.** `#on_identity_attached` sets a negative
    `owner_peer_id` to the local peer (so server-spawned entities arrive at clients owned by peer 0)
    and puts non-owned entities into the render-interpolation set once. A client's own slot must
    be owned by its peer id *before* INITIAL_SYNC is sent — which is the host tick after
    `connect()` — so ownership is assigned when the socket is accepted, not when a join message
    arrives later.
12. **AUTH_STATE reconciles every tick** unless `onComputeExpected`/`onMeasureCurrent` both have
    handlers and their scalars agree within `reconcile_epsilon`. Without that short-circuit the
    client rewinds and replays its whole lead every tick. §5.5 wires it with a hash.
13. **Inbound server frames reopen the client's log slot for that frame number**
    (`Replicator.unpack_from_peer` → `begin_frame`), discarding the client's own prediction record
    for it. Under an ordered transport only the AUTH_STATE frame overlaps, and its prior state is
    superseded by the auth bytes, so nothing is lost. Document it; do not rely on it under an
    unordered transport without re-checking.
14. **`WebSocketTransport` is duck-typed** (`binaryType`, `addEventListener('message'|'close'|'error'|'open')`,
    `send`, `close`, `readyState`); Node's `ws` package satisfies it. The engine's own docblock says
    a WebSocket is "not for game state" because of TCP head-of-line blocking; v1 accepts that on a
    LAN and records it, WebRTC is a follow-up (§7).
15. **The client's own entity is never interpolated** (not in `#remote_entities`); everything else
    is written with blended bytes by `tick()` and restored to canonical by `normalize_if_dirty()`,
    which the executor also calls before any action. Presentation reads remote state *after* the
    render write; simulation reads it *after* a normalize (§4.3).
16. **Determinism of the movement step is achievable but not free.** Both sides run `MeepMove` on
    a `PhysicsSystem`; D-131 measured that a differently shaped BVH moves one sweep in a thousand
    by 1e-5. Bodies must be created in the same order on both sides and `optimize()` called at the
    same point, or the prediction short-circuit misses and the client replays every tick. The
    zero-latency loopback test asserts bit-exactness and records whether it holds.

---

## 2. The decision

**Q3's model, expressed in meep's primitives.** A dedicated Node host is the simulation authority.
Each human's *inputs* are a `SimAction` that the client predicts and the host executes; the local
player is the only predicted entity. Everything the host owns — bots, missiles, items, movers,
scores — is *state*, published every tick as `ReplaceComponent` actions and played out on clients
through the session's interpolation log behind an adaptive render delay. Transient happenings —
muzzle flashes, impacts, explosions, hits, pickups, deaths — are event-style `SimAction`s with no
affected components, which the replicator always sends and never rewinds.

Two alternatives were considered and are rejected here so nobody re-derives them:

- **Full deterministic input replication** (every client simulates bots, missiles and movers from
  the same inputs; the engine's textbook model). Rejected: the simulation's state is not in
  replicated components (behaviour-tree blackboards, `MoveState`, physics contact state, projectile
  records), so `RewindEngine` cannot restore it and a rollback tears the world; the physics contact
  events that detonate missiles are not re-playable; and every client would run the whole match
  with the frame at the mercy of the slowest peer. It also asks bots to be bit-identical across
  machines, which is a property this port never needed and has no oracle for.
- **A bespoke snapshot protocol over `Channel`** (Q3's `entityState_t` deltas). Rejected: it
  exercises one layer of the package where the plan can exercise all of them, and it would
  re-implement INITIAL_SYNC, AUTH_STATE, the interpolation log and time dilation by hand.

**Topology for v1:** one Node process hosts (`node tools/host.ts`), browsers join over a
WebSocket. Bots live on the host. There is no listen server (a browser cannot accept a socket) —
that and WebRTC are follow-ups (§7).

**What v1 does not do**, stated so it is not discovered later: no lag compensation (a hitscan is
resolved against where the host has everyone *now*; Q3 vanilla is the same), no prediction of
jump pads or teleporters (they arrive as a correction; step 6 lists the fix), no reconnect (a
dropped socket is a return to the menu), no chat, no server browser (`trap_LAN_*` stays
`not-needed`), no delta compression beyond what the engine's own format does.

---

## 3. Architecture

### 3.1 Roles, peers, slots

- **Peer ids:** host `0`; clients `1..254`, handed out by the host on socket accept.
- **Slots:** `MAX_CLIENTS = 16` player slots, Q3 client numbers `0..15`. A slot is an entity that
  exists for the whole match (pool). Humans take the lowest free slot, bots the highest. A slot's
  index is its `Damageable.id`, its `CharacterBodies.create(id)` key, and its `ownerId` in every
  `WeaponSystem.fire`. The `LOCAL_CLIENT = 0` constant in `Arena.ts` becomes "my slot".
- **Ownership:** a human slot's `NetworkIdentity.owner_peer_id` is the peer id of the human in it;
  every other networked entity is owned by the host (peer 0). The engine's `OwnerAwareScope` then
  keeps a client's own slot out of its action stream (it gets AUTH_STATE instead) and the executor's
  authorization gate refuses any client action touching an entity it does not own.
- **Pools** (all created on the host before the first `connect()`, all sent in INITIAL_SYNC):
  16 player slots, `MAX_MISSILES = 64` missile slots, one entity per map item, one per mover, one
  match entity.

### 3.2 The host frame

`EntityManager.update(dt)` runs the fixed step; systems in this order (all score zero, so
registration order holds — see `systems.ts` header):

1. `NetHostSystem.fixedUpdate`: `session.tick(session.tick_period_ms / 1000)`. Passing the
   session's own period makes exactly one session step per call (`0 + p ≥ p`, remainder exactly 0);
   passing `em.fixedUpdateStepSize` does not, because `16.666666666 < 1000/60` in floating point
   and the session would skip its first step and drift. Pin that with a test. Inside the step,
   `ServerAuthoritativeServer.tick(wall)` simulates `sim = wall - simulation_delay_ticks`:
   - inbound `UserCmdAction`s for frame `sim` (and any late ones) are executed in sender order;
     each one runs **that slot's shared step** (§4.4) against the host world;
   - `onLocalSim(sim)` fires: **only when `sim` is the newest frame** (`sim === wall - delay`),
     run the world step and then the publish pass; during a rollback replay of older frames, do
     neither (the historical `ReplaceComponent` records in the log restore those frames' state);
   - `flush_outbound`, then `onTickComplete` sends INITIAL_SYNC to fresh peers, AUTH_STATE for each
     owned slot, and time-dilation feedback.
2. Nothing else on the fixed step. The world step is a plain function called from `onLocalSim`,
   not a set of systems, precisely so that it runs inside the open action-log frame.

**The world step**, in `G_RunFrame` order, once per newest frame:

1. bots: `BotRuntime.update(dt, msec, items)` (perception over all live humans, tree, `Bot.think`,
   fire through `WeaponSystem.fire` with a seed from the host's seeded PRNG);
2. `WeaponSystem.update(dt)` (projectile ageing, `Missiles.sync`) — contacts already arrived from
   the physics step, which ran first in the engine's own systems;
3. items: `ItemSystem.advance(dt)` once, then `touch(slot)` per live slot; the one-second bleed per
   slot;
4. movers: `MoverSystem.advance(dt)` once, then per slot `WorldEffects.apply(slot)` (carry,
   teleport with `SetClientViewAngle`, hurt, push); mover bodies' offsets;
5. mortality per slot (death → 2 s → respawn at a PRNG-chosen spawn, `SetClientViewAngle` to the
   spawn yaw); scores;
6. `CharacterBodies.sync()` for every slot — and additionally right after each slot's own step in
   the `UserCmdAction`, so that two humans moving in the same frame see each other at this
   frame's poses (Q3's entity-order semantics);
7. **publish**: for every networked entity whose game state changed, `world.sendEvent(entity,
   "net_mutate_component", { component_type })` after writing the live component from the game
   object. Moving things (slots, active missiles, moving movers) publish every frame; items,
   scores, match state publish on change.

Side effects that must not repeat under rollback (a shot fired inside a replayed
`UserCmdAction`) are keyed by `(slot, frame)`: the shared step decides "fire" deterministically and
updates cooldown and ammo, but the host only calls `WeaponSystem.fire` when `frame >
lastFiredFrame[slot]`. The client keys its predicted muzzle flash the same way.

### 3.3 The client frame

Engine systems (physics, interpolation, camera) run first because they declare components. Then,
in registration order:

1. `NetClientSystem.fixedUpdate`: `session.tick(session.tick_period_ms / 1000)` → the session runs
   0–3 client ticks (time dilation); each tick calls the **input sampler**, which returns one
   `UserCmdAction` for the local slot; the session executes it (predict: the shared step, §4.4),
   records its bytes, and sends it. Then `session.normalize_if_dirty()` so every remote component
   is canonical for the rest of the step; then `player.recordView()` once (the eye pose history for
   `writeCamera`).
2. `NetWorldSystem.fixedUpdate`: copy canonical remote state into the client's game objects —
   `Mover.origin` from `NetMover` (so `MoversView` writes the geometry and `PhysicsWorld.addMover`
   bodies), `ItemInstance.present` from `NetItem`, remote slots' origins into their
   `CharacterBodies.track()` closures — and `CharacterBodies.sync()`. The local player's sweeps thus
   collide with movers and other players where the host last said they were.
3. `ViewSystem` (unchanged; declares components so it precedes `CameraSystem3`).
4. `NetRenderSystem.update` (render rate): `session.tick(0)` — no sim step, but the session's
   render pass writes blended remote state into the live components. Then `NetPresentationSystem`
   places remote characters (`Character.place`, `legsFor`), missiles (`MissileView` on the pool
   entities), mover geometry already handled at fixed step, and feeds the HUD from the owned slot's
   `NetInventory`/`NetPlayerInfo`. `PresentationSystem` (view weapon, audio retirement) follows.

Remote characters, missiles and movers do **not** carry `interpolatedPose()` in the networked
path; the session's log is their interpolation, sampled behind `AdaptiveRenderDelay` (initial 6
frames, clamped 2..30). The single-player path is untouched.

### 3.4 The shared per-frame player step (`PlayerSlot`)

Extracted from `PlayerController.update` into `src/game/PlayerSlot.ts` (simulation side, ECS-free,
importable under Node), one instance per slot on the host and one for the local player on the
client. It owns the `pmove_t` from `createPmoveHost`, the `Inventory`, the `PlayerMovement`, the
weapon cooldown, `weaponSelectMs`, the bob cycle, and:

```
step(cmd: UserCmd, frame: number, sink: StepSink): void
```

- `msec = frameMsec(frame)`: `floor((frame + 1) * 50 / 3) - floor(frame * 50 / 3)` — the 16/17 ms
  pattern derived from the frame number rather than from an accumulator, so host and client
  compute the same integer clock for the same frame. The solver still gets the exact step
  (`1 / 60`), as `PlayerController` does today (D-110).
- `PM_UpdateViewAngles` runs first inside `PlayerMovement.step` as it does now; `ps.delta_angles`
  is how the host turns a client's view (teleporters, respawn): implement `SetClientViewAngle(ps,
  cmd, yaw)` from `g_client.c` (`delta_angles = ANGLE2SHORT(desired) - cmd.angles`) instead of
  `PlayerController.setYaw`, which writes the client's mouse accumulator and therefore cannot run
  on the host.
- The fire decision (`fireIfReady`) moves in here: it updates `weaponTime` and ammo, and reports
  `sink.fired(weapon, eye, angles, frame)`; the host's sink calls `WeaponSystem.fire` (keyed by
  frame, §3.2), the client's sink plays the predicted muzzle flash and sound once per frame.
- `load(state: NetPlayerState, inv: NetInventory)` / `store(...)`: copies every field the step
  reads or writes between the replicated components and `ps` + `MoveState` (`groundNormal`,
  `jumpHeld`, `ducked` included). `UserCmdAction.apply` is `load → step → store`, so a rewind that
  rewrites the components is enough to replay from.
- `PlayerController` keeps: input sampling (`sampleCommand(frame): UserCmd` — keys, mouse
  accumulator, weapon select/cycle, attack), the presentation history (`recordView`, `writeCamera`,
  kicks, `damaged`), and `selectWeapon`. Single-player calls `slot.step(sampleCommand(f), f, sink)`
  from `PlayerSystem`; no session involved.
- `?move=q3` and `?trace=clipmap` stay single-player-only. The networked step is the shipping
  `MeepMove` path.

Exit criterion for the extraction is bit-exactness against the old controller (step 2).

---

## 4. The protocol (`src/net/`)

All of this is shared by host and client and lives in `src/net/` (no meep graphics imports; must
load under Node). `PROTOCOL_VERSION` is a small integer in the hello; mismatch refuses the join.

### 4.1 Replicated components

Plain classes with a static `typeName`, `equals`, `hash`, `copy` (as `NetworkIdentity` and
`Interpolated` have), registered on the dataset (`ecd.registerComponentType`) on both sides before
`session.start()`. One `BinaryClassSerializationAdapter` each (`src/net/adapters.ts`), registered
on `session.binary_registry` under the `typeName`. Wire order = the table order; `registerProtocol`
calls `session.replicate` in exactly this order.

| component | on | fields (wire) | ≈ bytes | interp | published |
|---|---|---|---|---|---|
| `NetPlayerState` | slot | `connected u8`, `alive u8`, `origin f32×3`, `velocity f32×3`, `viewangles f32×3` (for remote rendering), `delta_angles i16×3`, `pm_flags u16`, `pm_time i16`, `groundEntityNum u16`, `viewheight i8`, `bobCycle u8`, `weapon u8` (`WEAPON_ORDER` index), `weaponTime i16`, `groundNormal f32×3`, `jumpHeld u8` | ~70 | Linear: lerp origin/velocity, yaw shortest-path, pitch; discrete fields from the newer snapshot | every frame the slot is connected |
| `NetInventory` | slot | `health i16`, `armor i16`, `maxHealth i16`, `ammo i16 × 13` (one per `WEAPON_ORDER` entry), `weapons u16` bitmask, `holdable u8` | ~36 | none (snap) | every frame (it is in AUTH_STATE anyway) |
| `NetPlayerInfo` | slot | `name` UTF-8 ≤ 32, `character u8`, `isBot u8`, `kills i16`, `deaths i16`, `pingMs u16` | ~44 | none | on change |
| `NetMissile` | missile pool | `active u8`, `generation u8`, `weapon u8`, `owner u8`, `origin f32×3`, `velocity f32×3` | ~28 | Linear on origin; rest from newer | every frame while active; once on deactivate |
| `NetItem` | item | `index u16`, `present u8` | 3 | none | on change |
| `NetMover` | mover | `index u16`, `state u8`, `origin f32×3` | 15 | Linear on origin | every frame while moving; once on rest |
| `NetMatch` | match | `simFrame u32`, `timeMs u32`, `fragLimit u8`, `phase u8` | 10 | none | once a second and on change |

Interpolation adapters extend `BinaryInterpolationAdapter` with `kind = InterpolationKind.Linear`
and write the *same wire layout* (`adapters/TransformInterpolationAdapter.js` is the model).
`NetworkIdentity` is auto-replicated first; never call `replicate` for it.

### 4.2 Actions

| action | direction | affects | payload | notes |
|---|---|---|---|---|
| `UserCmdAction` | client → host (predicted locally) | `[slot, NetPlayerState]`, `[slot, NetInventory]` | `network_id uintVar`, `frame uintVar`, `angles i16×3`, `moves i8×3`, `buttons u8`, `weapon u8` | `apply`: resolve the entity; on a client that does not own it, return (the host relays every client's actions to every other client — those are ignored, not simulated); else `load → PlayerSlot.step → store`. Built per session by `makeUserCmdAction(ctx)` so `apply` reaches the local `PlayerSlot`s and sink without globals (the engine's own `ReplaceComponentAction` is built the same way). Hand-written `serialize/deserialize` — `SimAction.extend` has no array types. |
| `EffectEvent` | host → all | none | `kind u8` (muzzle, hitscanTrail, bulletImpact, explosion, death), `weapon u8`, `owner u8`, `origin f32×3`, `aux f32×3` (direction / normal / end), `radius f32` | mirrors `WeaponEvents`; the client's sink is `Arena` minus damage |
| `HitEvent` | host → all | none | `attacker u8`, `victim u8`, `damage u8` | attacker's client plays `feedback/hit`; victim's client kicks the view (`PlayerController.damaged`) |
| `PickupEvent` | host → all | none | `slot u8`, `item u16` | that slot's client plays the pickup sound and shows the label |
| `JoinCommand` / `ChatCommand` | reliable command pipeline | — | JSON ≤ 1 KB | follow-ups; v1 joins through the hello (§4.4) |

Event actions have no affected components, so `Replicator` always sends them, `RewindEngine` never
touches them, and a client applies each exactly once (`#applied_through`). On the host their `apply`
is a no-op.

### 4.3 Hello and join

Ownership must exist before INITIAL_SYNC (§1.3 item 11) and the client must learn the host frame
before it can tick (item 2), so the join is out of band, on the WebSocket itself, before the
socket is handed to `WebSocketTransport`:

1. Client opens `ws://host:port/?v=<PROTOCOL_VERSION>&name=<utf8>&character=<index>`.
2. Host (on `connection`): validates the version, picks the lowest free slot, sets the slot's
   `owner_peer_id` to a fresh peer id, writes `NetPlayerInfo`, marks `connected`, spawns the slot
   (respawn logic), then sends **one text frame** `{"peer":N,"slot":S,"frame":F,"map":"oa_dm1","bots":k}`
   and only then calls `session.connect(N, new WebSocketTransport({ socket }))`. If no slot is free
   or the version mismatches, it sends `{"refused":"..."}` and closes.
3. Client: awaits that text frame *before* constructing its transport (the transport's message
   listener would otherwise try to parse the JSON as a packet), constructs its `NetworkSession`
   with `local_peer_id: N`, registers the protocol, `start()`s, **fast-forwards to
   `F + lead`** (§4.4), then `connect(0, transport)`.

### 4.4 Frame alignment workaround

`lead = simulation_delay_ticks + ceil(oneWayMs / period) + 2`, with `oneWayMs` estimated from the
hello round trip (or 50 ms if unknown; time dilation corrects the rest at ±5 % per tick). Fast
forwarding is `session.tick(8 * period)` in a loop until `session.current_frame >= target`, with
the input sampler returning `[]` while `aligning` is set. No peer is connected yet, so the empty ack
packets go nowhere. Measure the cost (a one-hour-old host is ~216 k frames ≈ 27 k calls) and record
it; if it exceeds ~250 ms, the alternative is to make the host restart its session frame count
per match, which caps the distance but does not remove the workaround.

### 4.5 Reconciliation

- **Short-circuit:** subscribe `session.client.onComputeExpected` and `onMeasureCurrent`. Keep a
  ring of the owned slot's `NetPlayerState + NetInventory` bytes as they were at the *end of each
  predicted frame* (write it in the sampler after the previous frame closed, or after
  `session.tick` returns). Expected = FNV-1a of the ring entry for `server_frame`; measured = FNV-1a
  of the auth payload bytes (peek at the buffer, restore `position`). Equal hashes → no rewind.
  Record the hit rate; at zero latency on the loopback it should be ~100 %.
- **Correction smoothing:** on `onReconcileComplete`, feed `SmoothingState.apply_position_correction`
  with the eye position before and after; `writeCamera` adds `render_position` and calls `decay`
  per rendered frame. This is the engine's own opt-in for exactly this snap.
- **Metrics for the HUD and tests:** `client.reconcile_count`, `replay_frame_count`, correction
  magnitude (max, p99), `adaptive_render_delay.delay_ms()`, `last_buffer_depth`,
  `BandwidthMeter` rates. Expose them as `window.queep.net`.

### 4.6 Determinism rules for the shared step

- Same body creation order on host and client: level statics (as `PhysicsWorld`/`HeadlessPhysics`
  build them), then `optimize()`, then mover bodies in `MoverSystem.movers` order, then character
  bodies in slot order, then (host only) missile bodies. The client has no missile bodies; that
  difference cannot reach a sweep because missiles are `passThrough` for characters anyway.
- No `Math.random` in the step; the host's PRNG is a seeded `mulberry32` in `Host`, used for
  weapon seeds, respawn points and bot goal choices (`BotRuntime`'s two `Math.random` sites and
  `systems.ts`'s one become injected).
- `dt` for the solver is the constant `1 / 60`; `msec` is `frameMsec(frame)`.
- Iterate slots by index, never by `Map` insertion order.

---

## 5. Steps

Each step: code, tests, DECISIONS entry, REPORT entries, `npm run check` green, commit.

### Step 0 — record the reversal, scaffold

- DECISIONS: "networking is in scope, and the brief's anti-goal is reversed by the maintainer" —
  what changes, what does not (single-player path, `?move=q3`, the oracle), the architecture
  choice in §2 with the two rejected alternatives.
- `package.json`: `ws` and `@types/ws` as devDependencies (Node has a WebSocket client, not a
  server); script `"host": "node tools/host.ts"`.
- `src/net/protocol.ts` with the constants (`PROTOCOL_VERSION`, `MAX_CLIENTS`, `MAX_MISSILES`,
  `TICK_HZ = 60`, `FRAME_CAPACITY = 64`, peer/slot conventions) and `frameMsec`.
- `test/net-clock.test.ts`: (a) `frameMsec` sums to exactly 1000 per 60 frames and only ever
  returns 16 or 17; (b) a host `NetworkSession` on a bare `EntityManager` advances
  `current_frame` by exactly one per `session.tick(session.tick_period_ms / 1000)` and by zero for
  the first call when handed `em.fixedUpdateStepSize` — the float trap, asserted rather than
  remembered.

*Exit:* check green; the decision is written before any protocol code exists.

### Step 1 — the protocol types

`src/net/components.ts`, `src/net/adapters.ts`, `src/net/actions.ts`, `registerProtocol(session)`.

`test/net-protocol.test.ts`: every adapter round-trips bit-exactly (Float32 fields compared after a
`Math.fround`); every component serializes under 1024 bytes; the Linear adapters blend at
`t = 0, 0.5, 1` and shortest-path a yaw across ±180°; `UserCmdAction` round-trips through
`serialize/deserialize` including negative moves and wrapped angles; `registerProtocol` on two
sessions yields identical `component_registry` type ids.

*Exit:* the test above; nothing else in the tree changes.

### Step 2 — `PlayerSlot`, and the single-player path proves it is the same game

Extract per §3.4. `PlayerController` shrinks to input + presentation; `PlayerSystem` calls
`slot.step`. Give `ItemSystem` and `MoverSystem` their `advance/touch` split with the old
signatures kept as thin wrappers so `match.test.ts`, `bench-match.ts` and `player-controller.test.ts`
keep passing unchanged.

`test/player-slot.test.ts`: drive 600 frames of the scripted strafe-jump chain from
`test/meepmove.test.ts` through (a) the pre-extraction controller (kept temporarily in the test as a
copy of `update()`'s ordering, then deleted with the step) and (b) `PlayerSlot.step` with
`frameMsec`; assert `ps.origin`, `ps.velocity`, `bobCycle`, cooldowns identical to the last bit.
Then `load`/`store` through `NetPlayerState`/`NetInventory` mid-run and assert the run continues
bit-identically — this is the property the rewind depends on.

*Exit:* the equivalence test, plus the whole existing suite unchanged. DECISIONS: what
`PlayerSlot` carries and why `SetClientViewAngle` replaced `setYaw`.

### Step 3 — the headless host, and a headless client, over a loopback

`src/server/Host.ts`: builds the match world exactly as `test/match.test.ts` does (map files from
`assets/built/<map>`, `HeadlessPhysics` — or `PhysicsWorld` if it imports cleanly under Node;
`src/client/PhysicsWorld.ts` pulls `Acoustics.ts`, which imports meep's sound simulation modules,
so smoke-test it and, if it fails, lift `addMover`/`addStaticModel`/`addStaticHull` into a shared
module both use), movers (kinematic bodies), items, waypoints, bots via a `BotWorld` that sees all
human slots (step 6 hardens this), `WeaponSystem` + `Missiles` + `DamageQueries`, the pools, the
`NetworkSession` in host role (`simulation_delay_ticks: 4`, `frame_capacity: 64`), the world step
and the publish pass from §3.2, a `Damageable` per slot with accessors into its inventory (the
shape in `roster.ts`).

`src/client/net/NetClient.ts`: the client-side wiring from §3.3 without any renderer dependency
(it takes an `EntityManager`, a `PhysicsWorld`-like host, a `PlayerSlot`, an input source and an
event sink), so the same class runs in the browser and in a test.

`test/net/rig.ts`: `NetRig.create({ map, bots, clients, link: 'loopback' | { latency_ms, jitter_ms,
loss_pct, seed } })` — one host and N headless clients in one process, each with its own
`EntityManager`; `step(n)` advances every clock one fixed step in a fixed order (host, transports
deliver, clients) so runs are reproducible; scripted input per client; counters for events.

`test/net-loopback.test.ts` (zero latency, 1 client, 4 bots, `oa_dm1`):
- after `step(10)` the client holds one entity per pool slot, its slot is owned by its peer and
  `connected`, bots' slots are remote;
- scripted movement for 600 frames: the client's predicted `NetPlayerState` at each frame equals
  the host's authoritative state for that frame **bit for bit** (compare the ring against the
  AUTH_STATE bytes), the short-circuit hit rate is 100 % and `reconcile_count` is 0 — if this
  fails, record the first divergent field and frame in REPORT and fall back to "≤ 1e-3 units,
  ≤ 5 % rewinds" as the gate, because that is D-131's measured 1e-5 showing up;
- a bot fires a rocket: a missile slot activates on the client within `render delay + 2` frames,
  its origin advances, an `explosion` event arrives when it lands, the slot deactivates;
- the client fires (scripted `BUTTON_ATTACK`): the host's `WeaponSystem` fires exactly once per
  cooldown (no double fire under a forced rollback — inject a late input and assert `onRewind`
  fired and the shot count did not change);
- the client takes damage from a bot: `NetInventory.health` falls on the client, a `HitEvent`
  names it, the death → respawn cycle completes;
- `SyncTest.fingerprint_world` over the host's and the client's replicated components agree
  after `step(1)` with all traffic delivered (canonical, post-normalize).

**What step 3 actually built, where it differs from the paragraphs above (D-170).**

- **No movers on the host.** `HeadlessPhysics` builds BSP model 0 only, deliberately (D-036), so
  `MoverSystem` is not wired and `NetMover` ships as a component with an adapter, a wire slot and no
  producer — which keeps the protocol version stable for the day step 5 gives the host
  `PhysicsWorld.addMover`. GAP-041.
- **The bit-exactness comparison is per frame, and had to be.** Comparing the two peers' *current*
  state measures the prediction lead, not the prediction: the client runs six frames ahead by
  construction, which at 320 u/s is 32 units of "divergence" in a simulation that agrees to the last
  bit. `NetClient.predictionTrace` records what was predicted for each frame and the test compares
  that against the host's state for the same frame. The first version of the test read a player
  falling out of the level as a 409-unit desync.
- **The short-circuit hit rate is not 100 % and `reconcile_count` is not 0**, and the plan was wrong
  to expect them to be. Q3's one-second health bleed is host-only state a client cannot predict, so
  each of the 25 ticks between spawning at 125 and settling at `maxHealth` costs exactly one
  reconcile. Measured: 11 disagreements at 10 s, 23 at 20 s, 31 at 40 s, stopping when health
  reaches 100. The counter is split into "never predicted" and "disagreed" for exactly this reason.
  Predicting the bleed is step 6's, and until then the gate is *bounded and explained*, not zero.
- **A stationary client is not a smaller version of this test.** Bots get 0.4 s of line of sight to
  a fixed point at `oa_dm1`'s first spawn over thirty seconds (`match.test.ts` measured it), so a
  client that stands still produces a match in which the fight branch never honestly starts and no
  bot ever fires a rocket. Every scripted client walks.
- **`SyncTest.fingerprint_world` is not used.** The AUTH_STATE hash comparison is the same check
  done continuously and per entity rather than once over the whole world, and it is already wired
  because the reconciliation needs it. Left for step 7, where a fingerprint over a *lossy* link is
  worth more than one over a loopback.
- **Two engine facts the plan did not have** turned up here and are in the register: ownership never
  travels (GAP-040) and a client needs `OwnerAwareScope` on its own replicator, without which it
  echoes the host's world back at the host.

*Exit:* every bullet above. DECISIONS: the host frame, the newest-frame gate on `onLocalSim`,
side-effect keying, pools. REPORT: GAP for "no spawn/despawn replication", GAP for "`onLocalSim`
re-runs under rollback and the docblock asks for idempotence the game cannot give".

### Step 4 — join in progress

Implement §4.3–4.4 in the rig first (the hello is a function, the fast-forward is a method).

`test/net-join-late.test.ts`: host runs alone to frame 6000 (`step(6000)`), then a client joins;
within 60 frames its inputs move its slot on the host (assert the host's `NetPlayerState.origin`
changes and `buffer_depth_for_peer` settles at the delay), its `reconcile_count` stays near zero;
a second client joins at frame 9000 and both see each other's slots move. Assert the fast-forward
cost and print it.

*Exit:* the test. REPORT: GAP "a late joiner's frame is never aligned; `onInitialSync` ignores
`frame_number`; `#local_frame` is private" with the measured cost of the workaround.

### Step 5 — a real socket, a real browser

- `src/server/wsHost.ts`: `ws` `WebSocketServer` on `--port` (default 5300), the hello, peer ids,
  `session.connect`, slot release on `onPeerPermanentlyDropped` (`reconnect` disabled on clients,
  `server_resume_grace_ms` short); the host loop on `setTimeout(1)` + `performance.now()`
  feeding `em.update(dt)` (mind `fixedUpdatePerSystemExecutionTimeLimit` — log when the host
  falls behind); `tools/host.ts` CLI: `--map`, `--bots`, `--port`, `--difficulty`.
- `src/app/main.ts`: `?join=ws://host:port` (with `?name=`, `?character=`) takes the networked
  branch: the same map load, `PhysicsWorld`, movers and items as today, but no bots, no
  `Missiles`, no `DamageQueries`; `NetClient` in place of `PlayerSystem`/`CombatSystem`/
  `PickupSystem`/`BotSystem`/`WorldEffectSystem`; the systems of §3.3. `expose()` adds `net`.
- Refuse cleanly on the console: version mismatch, server full, socket closed.

**Both halves are now built.** The host half -- `src/server/wsHost.ts`, `tools/host.ts`,
`npm run host` -- is exercised end to end over a real socket by `test/net-websocket.test.ts`: the
hello, the refusals, slot release on close, and a Node client driving a `WebSocketTransport` whose
input the host acts on (D-172). The browser half is `?join=ws://host:port` in `src/app/main.ts`,
`src/client/net/join.ts` for the handshake and its refusals, and `src/app/netSystems.ts` for the
§3.3 systems -- `NetClientSystem`, `NetWorldSystem`, `NetRenderSystem` -- in place of
`PlayerSystem`/`CombatSystem`/`PickupSystem`/`BotSystem`/`WorldEffectSystem` (D-178). The hello
gained one field, `items`, because both peers build replicated pools from that count and match them
by position.

**The exit criterion as originally written cannot be met by step 5**, which is a mistake in this plan
rather than in the code. "A screenshot of tab A shows tab B's character where tab B's HUD says it is"
needs remote characters placed from `NetPlayerState`, `legsFor` from replicated velocity, and a HUD
fed from `NetInventory` -- and every one of those is listed under **step 6**, "presentation of remote
state". So the exit is revised to this tab's own player, and the screenshot moves to step 6.

*Exit (revised):* `npm run host -- --map oa_dm1 --bots 2`, then two tabs on
`?map=oa_dm1&join=ws://localhost:5300`: both connect, both report `window.queep.net.synced`, each
tab's `reconcileCount` stays flat while standing still, and the console is clean. The dev-server
plugin needs nothing new (a WebSocket to another port is not subject to COEP). Seeing *each other*
is step 6's exit.

**Met in part, and the shortfall is measured rather than assumed.** The handshake, the join, the
sync, the item replication and the prediction were all verified in a real browser against a real
`npm run host` over a real socket -- `synced` true, the predicted origin equal to the host's
authority to the last bit it prints, items appearing and disappearing as bots take them. The
**renderer** was not: the preview browser's `requestAdapter()` returns null, so `EngineHarness`
throws before `main()` reaches this branch, and the verification drove the same modules on a
`PhysicsWorld` built by hand in the page instead. Two tabs side by side, and the screenshot, need a
browser with a GPU.

**`reconcileCount` is flat now, and getting it there is the most valuable thing this step produced.**
Two real defects stood between the branch and its exit criterion, and neither was visible to any
test in this repository, because every networked client in the suite *walks* and both faults need a
player standing still.

- An unbounded `weaponTime`, against `bg_pmove.c:1575` (D-178). No lockstep test could show it: the
  rig steps host and client in one process, so their frame counts never come apart.
- A body on every slot, including the ones nobody is playing, which shoved the local player 30.16
  units off the host's position for ever (GAP-044, D-179). The host has parked those since step 3;
  the client never did.

Measured in a real browser against a real `npm run host`, standing still: **0 of 3,808 AUTH_STATEs
short-circuited before, 323 of 329 after**, with the predicted origin equal to the host's authority
and the six remaining misses the once-a-second health bleed. The **renderer** is still unverified
here -- the preview browser's `requestAdapter()` returns null, so `EngineHarness` throws before
`main()` reaches this branch -- so two tabs side by side, and the screenshot, still want a machine
with a GPU. Everything below the renderer is verified end to end.

### Step 6 — everything a match does, for every slot

- Presentation of remote state (§3.3): characters with `legsFor` from replicated velocity/ground,
  footsteps through `Footsteps.update(bobCycle, …)` per remote slot, missiles through
  `MissileView` on pool entities (hide for one frame when `generation` changes, so a reused slot
  does not streak), items via `NetItem → ItemInstance.present`, movers via `NetMover`, HUD from
  `NetInventory`/`NetPlayerInfo` plus `pingMs`, render delay and correction count, event sink for
  `EffectEvent`/`HitEvent`/`PickupEvent` (the local slot's `HitEvent` drives `damaged()`).
- `BotWorld`: replace `playerOrigin()/playerAlive()` with `targets()` — every connected, alive
  human slot; `sighted` picks the nearest visible one; D-055's "never another bot" stays true and
  its test in `match.test.ts` stays green. Bots respawn and choose goals from the host PRNG.
- Per-slot mortality, scoring (`kills/deaths` in `NetPlayerInfo`), the one-second bleed, pickups
  and autoswitch, weapon selection on the client (predicted; `weapon` rides the command), dry-fire
  and weapon-change sounds (client-local), teleporters and pads through `SetClientViewAngle` and
  velocity writes on the host.
- Projectile origin on the host: `barrelQ3` is null (no model library under Node), so every
  networked shot leaves `CalcMuzzlePoint` — D-116's fix is presentation-only there; record it and
  list "a generated barrel-offset table" under §7.

`test/net-match.test.ts`: 2 clients + 4 bots, 60 s on `oa_dm1` over the loopback; both clients
take damage and deal damage (scripted aim at the nearest bot), pickups reach the right client,
scores on the clients match the host's, every slot's state stays finite, no `MalformedPacket`, no
`onPendingActionDropped`.

*Exit:* the test, plus a browser check of a full round: pick up a weapon, fire it, die, respawn,
see a bot die. DECISIONS: the `BotWorld` change against D-055; the presentation split.

### Step 7 — latency, loss, bandwidth

- `test/net-latency.test.ts`: `SimulatedTransport` at 80 ± 20 ms, 2 % loss, seeded. Assert:
  corrections after reconcile ≤ 2 units at p99 and ≤ 16 max over 60 s of scripted strafing; the
  host's `onRewind` depth ≤ 6; the client's `last_buffer_depth` converges to the delay; no frame
  older than the ring is ever dropped (`pending_dropped_count() === 0`); remote missiles never
  jump backwards on the client's blended timeline.
- Bandwidth with `BandwidthMeter` on both transports at 0 ms and at 80 ms RTT, 8 humans + 4 bots
  (rig with scripted clients): report bytes/s per client in both directions in REPORT §5. The
  budget to assert is 48 KB/s downstream at 0 RTT; whatever the redundancy factor makes it at 80 ms
  is *measured and written down*, not asserted, because it is the engine's property (§1.3 item 6).
- Host CPU: the world step + session tick for 8 humans + 4 bots ≤ 2 ms mean under the rig
  (`tools/bench-net.ts`, same shape as `bench-match.ts`), numbers into REPORT §5.

*Exit:* the tests and the two tables in REPORT. REPORT: GAP "action stream resends every unacked
frame regardless of `transport.reliable`", GAP "interpolation needs a record per tick, so the send
rate cannot be decoupled from the tick", the `WebSocketTransport` "not for game state" note with
the measured LAN experience.

### Step 8 — robustness

Disconnect frees the slot and the character vanishes on other clients; the host survives a client
that sends garbage (the executor's authorization gate rejects actions on entities the sender does
not own — assert `onActionRejected` fires and nothing moves); a client whose socket dies returns to
the menu with a message; a second join from the same browser gets a new peer id and slot; the host
refuses the 17th player; `connection_timeout_ms` reaps a silent peer; `PROTOCOL_VERSION` mismatch
is refused before any session exists. `test/net-robustness.test.ts` covers the in-process ones.

*Exit:* the test. DECISIONS: what is deliberately not handled (reconnect, kick, anti-cheat).

### Step 9 — documentation and the report

- DECISIONS: one entry per step above (§9 lists the titles).
- REPORT: the GAP entries named in each step, a "what worked" entry for the pieces that composed
  cleanly (expected: `SimAction` + `RewindEngine` + `AUTH_STATE` doing the Q3 prediction loop in a
  few hundred lines; `LoopbackTransport`/`SimulatedTransport` making the whole thing a unit test;
  `SmoothingState`), ergonomics entries (the `frame_capacity` constructor option missing from the
  `.d.ts`; `EntityManager.simulate` exists only as a prototype alias of `update` that the `.d.ts`
  header example uses and the `.d.ts` itself does not declare, so it typechecks nowhere;
  `NetworkSystem`'s docblock describes the bare `NetworkPeer` recipe — `begin_tick`, simulate,
  `end_tick` — which no longer applies once `NetworkSession` drives the orchestrators; the
  `Signal` handler order that `onInitialSync` piggybacks on), and the bandwidth and CPU tables in
  §5.
- `tools/trap-classification.json`: `trap_GetSnapshot`, `trap_GetCurrentSnapshotNumber`,
  `trap_GetServerCommand`, `trap_SendClientCommand`, `trap_DropClient`, `trap_SendConsoleCommand`
  become `mapped`/`hybrid` with `path::token` evidence into `src/net/` and `src/server/`;
  `trap_LAN_*` stays `not-needed` with the note updated ("no server browser; join by address").
  `npm run trap-matrix` regenerates the section; `--check` must pass.
- `README.md`: the `?join=` row, `npm run host`, a "Multiplayer" paragraph under "What works" that
  says what v1 does not do (§2).

*Exit:* `npm run check` green with the regenerated matrix; the tracking table below updated.

---

## 6. Follow-ups, deliberately outside v1

- **WebRTC data channel** (`WebRTCDataChannelTransport`, unordered/unreliable), or
  `WebTransportTransport`'s QUIC datagrams, with **signalling over `NetworkPeer.send_reliable_command`
  rather than a bespoke side-channel** -- at-least-once with dedup, ~1189 B per command, unordered
  (so key them with a counter) and unfragmented (so an SDP offer needs chunking; ICE candidates fit).
  `NodeUDPTransport` covers a Node-to-Node link and cannot reach a browser at all. Removes
  head-of-line blocking; measure before and after with the latency rig. **Both blockers are now
  gone**: the rollback loop in 3.14.4 (D-176) and the event loss under reordering in 3.14.5
  (D-177). A UDP-style transport reorders by nature and the stack now tolerates that -- 474 of 474
  events at 80 ms with 20 ms of jitter and 2% loss, against 403 before. Two things to carry into the
  work: this port costs **523 bytes of actions per frame with four bots and 776 with eight**,
  against a ceiling of about 940 at 150 ms, so eight bots on a long link is already at the limit;
  and `max_packets_per_tick: 1` still restores the old loss, so the setting is a trap rather than a
  tuning knob.
- **Browser listen server** over WebRTC: the host tab owns slot 0 with no prediction.
- **Predict static triggers**: `trigger_push` and `trigger_teleport` boxes are map constants, so the
  shared step can evaluate them on both sides (`BG_TouchJumpPad` is predicted in Q3).
- **Barrel offsets on the host**: a generated `barrelOffsets.generated.json` from the model library
  (an `extract-*` tool with `--check`, like the others) so D-116 holds for networked shots.
- **Send-rate decimation** or trajectory replication for missiles (Q3's `trajectory_t`) if the
  bandwidth table says so.
- **Reconnect** through the session's ladder (`transport_factory` needs a synchronous transport
  whose socket is still connecting; `WebSocketTransport.send` throws before OPEN).
- **Lag compensation**: rewind character bodies to the shooter's view frame for hitscan.
- **Menu**: a `text` setting kind and a Multiplayer page (D-097's shell takes any page).
- Chat over `send_reliable_command`; spectators (a client with no input sampler is one already).

---

## 7. Risks, named rather than discovered later

- **The engine's rollback runs inside the frame the world step needs.** The newest-frame gate
  (§3.2) is the whole defence; a rollback replays player moves against bodies the world step has
  since moved, so late inputs resolve against slightly newer positions. ~~Measure how often
  `onRewind` fires under the latency rig; if it is every tick, raise `simulation_delay_ticks`.~~
  **Measured, and this remedy did not work (D-173, GAP-043).** `onRewind` fired on 893 of 900
  frames at 40 ms of *clean, lossless, in-order* delay, because `flush_outbound` re-sends every
  unacked frame and the rollback window was chosen from those retransmissions before the dedup
  discarded them. Raising `simulation_delay_ticks` across 4, 8, 12 and 16 moved the mean depth by
  less than 0.3 frames: the depth is the ack round trip, not the input buffer. The client's
  short-circuit fell to **0.1%** on that link.
  **Fixed in meep 3.14.4** (D-176): `tick()` now takes the oldest pending frame that carries input
  the action log does not already hold. Re-measured, zero rewinds and 97.3% coherence at 40 ms, and
  the rate no longer depends on latency at all. `test/net-latency.test.ts` is the regression test.
- **Two clocks.** The session step and the engine step are tied by convention, not by the engine.
  A missed `session.tick` on either side is silent. The clock test in step 0 and the
  `current_frame`-per-fixed-step assertion in the rig guard it.
- **Determinism drift** between host and client sweeps (BVH shape, body order) shows as constant
  small corrections. `SmoothingState` hides them and the hash short-circuit fails safe (a rewind
  per tick costs ~10 movement steps). Record the measured hit rate either way.
- **Bandwidth redundancy** grows with RTT (§1.3 item 6); at 8 humans on a 100 ms link the host's
  upstream may reach several hundred KB/s. Measure; do not tune blind.
- **The 1024-byte scratch** rejects any component that grows past it (`NetInventory` with
  powerups is nowhere near, but a chat string on a component would be).
- **`Interpolated` on network-driven entities** double-blends (the session writes the component,
  `PoseRecorderSystem` records a blended transform as truth — the same failure `MoversView`'s
  early-out had, PLAN.md step 3). Keep `interpolatedPose()` off the networked path.
- **System ordering** among zero-score systems is registration order; `NetClientSystem` must
  precede `CharacterBodySystem` and `NetRenderSystem` must precede the presentation. If a
  component declaration is ever added to one of them, re-run `test/interpolation.test.ts`'s
  execution-order cases with the new systems in the rig.
- **Host loop timing** on Node's timers jitters by a few ms; the accumulator absorbs it, but a GC
  pause longer than `fixedUpdatePerSystemExecutionTimeLimit` drops steps and every client sees a
  hitch. Log it; do not hide it.
- **`ws` in the tree**: only a devDependency, only imported by `src/server/` and `tools/`; nothing
  of it reaches a browser bundle. meep stays external and unvendored (D-002).

---

## 8. DECISIONS entries this plan expects to produce

Take the next free numbers at the time of writing; titles are indicative.

1. Networking is in scope: the brief's anti-goal reversed, and the architecture chosen over two
   alternatives (§2).
2. `PlayerSlot`: the per-frame player step is one function the host and the client both run, and
   the frame number is its clock.
3. The host frame: `onLocalSim` runs the world only on the newest frame, side effects are keyed by
   frame, and every server mutation is an action.
4. Pools instead of spawns, because the session does not replicate creation.
5. Join in progress: the hello carries the frame, and the client fast-forwards.
6. Bots see every human, and still never each other (D-055 revisited).
7. What a client renders from the wire, and what it computes for itself (movers, items, trails).
8. What v1 does not do (lag compensation, predicted pads, reconnect, WebRTC), with the reasons.

## 9. Tracking

| step | state |
|---|---|
| 0 — reversal recorded, scaffold, clock test | **done** |
| 1 — protocol types | **done** |
| 2 — `PlayerSlot` extraction, single-player unchanged | **done** |
| 3 — headless host + client over loopback | **done** |
| 4 — join in progress | **done** |
| 5 — WebSocket host, browser client | **done** except the renderer, which the preview browser cannot start. Standing still against a real host: 0/3808 short-circuited before, 323/329 after, two defects fixed (D-178, D-179/GAP-044) |
| 6 — full match for every slot | host half **done** (D-180); remote characters and missiles **done** and measured (D-181). Scoreboard HUD, remote footsteps and client weapon selection not built; one defect open (GAP-045) |
| 7 — latency, loss, bandwidth | rig + `SimulatedTransport` + `test/net-latency.test.ts` **done**; prediction target met on 3.14.4 (D-176), event delivery met on 3.14.5 (D-177); action-bytes-per-frame census in place; bandwidth table still to write |
| 8 — robustness | not started |
| 9 — documentation, report, trap matrix | not started |
