# Plan: Phase 9 — one clock, and the game as meep systems

Forward-looking. `DECISIONS.md` records what was decided, `REPORT.md` what was measured; this is
what is intended and has not happened yet. Each step names its exit criterion, because a step that
cannot be checked is a wish.

The port currently runs its whole game on one `engine.ticker.onTick` listener: a 153-line closure in
`src/app/main.ts` holding nine named phases, its own per-phase exception guard, and -- counting
them -- four separate hand-rolled time accumulators. meep already owns every one of those
mechanisms. `EntityManager` has a fixed-step loop with a tick id, an alpha, a catch-up cap and
per-system error isolation that reports by name; `InterpolationSystem` bridges the sim rate to the
render rate; `PhysicsSystem` integrates dynamic bodies with CCD and dispatches contact events as ECS
entity events.

## What changes, and the priority behind it

**The goal order has inverted.** Through phase 8 this port was "Quake III, faithfully, on meep", and
the engine evaluation came out of what that exercise touched. From here it is "exercise meep well
first, produce a faithful port second". Movement already departed the C in phase 5 -- D-071 put Q3's
motor on `KinematicMover` and retired `PM_SlideMove` -- so tick-rate parity is defending a boundary
that has already moved.

Concretely: simulation runs on `EntityManager`'s fixed step, presentation runs on `update`,
`InterpolationSystem` bridges them, characters and projectiles become physics bodies, and less of
this repo's own code stands between Q3's rules and meep's facilities.

**Tick rate: 60 Hz**, the engine's own `fixedUpdateStepSize` default. 125 Hz was considered because
it is what `test/match.test.ts` and the phase-6 bench use, and it would have made the browser, the
headless match and the C oracle one simulation. Rejected: chasing `sv_fps` parity is exactly the
fidelity argument this phase is standing down from, and the engine's default is the configuration
its own tuning assumes. The headless bench keeps its own rate; that it differs is now a property of
the bench, not a divergence to explain.

**Characters block each other.** Q3 has `CONTENTS_BODY` and this port never did, because nothing was
in the broadphase to block with. Step 5 puts them there, so the capability arrives for free and is
taken.

---

## What is already established

Verified against `@woosh/meep-engine` 3.4.0 by reading it, not assumed. Several of these are
surprises and each one shapes a step:

- **`InterpolationSystem` is not registered by `EngineHarness`** -- no `addSystem` in it mentions
  the class. But `PhysicsSystem` is already a complete producer: `__interp_restore()` at the top of
  each step undoes the render blend so the solver integrates from truth, `__interp_record()`
  snapshots after (`PhysicsSystem.js:1791`, `:1849`). One registration plus one field assignment
  turns the whole thing on.
- **`BodyKind.KinematicPosition` is reserved and not implemented.** Its own docblock: pose-driven
  bodies "present to the solver as stationary walls that teleport", and it says to prefer
  `KinematicVelocity` until that lands. `PhysicsWorld.addMover` already knows this. Characters
  therefore become sensor bodies driven by `setPose`, which sidesteps the problem rather than
  waiting on it.
- **Queries honour only the user filter callback -- not `layer`/`mask`, and not the sensor flag.**
  `shape_cast.js:213` and `overlap_shape.js:137` call `filter(entity, collider)` and consult nothing
  else. Both of this port's query sites currently pass `undefined`: `MeepMove.ts:500` and
  `PhysicsTrace.ts:430`. The moment a character or a missile has a body, those two `undefined`s are
  bugs. This is a prerequisite, not a detail.
- **CCD sweeps pass through sensors** (`ccd/linear_sweep.js:108,121`). At the 16.7 ms step a 900 ups
  rocket travels 15 units against a 30-unit-wide player box, so the discrete narrowphase covers
  characters with 2x margin -- half the margin 125 Hz would have given, which is why step 6's
  pass-through test is a gate and not a formality.
- **`PhysicsSystem.raycast` is broadphase-only.** `result.t` is the distance to the leaf's inflated
  AABB and the normal is an AABB face normal, exact only for AABB colliders. World brushes are
  `ConvexHullShape3D`. Everything that needs to be accurate goes through `shapeCast`, which is what
  `PhysicsTrace` already does.
- **`__dispatch_contact_events` returns early when there is no dataset.** `HeadlessPhysics` drives
  `PhysicsSystem.link` with no `EntityManager` at all, so a contact-driven projectile would be
  silently invisible to `test/match.test.ts`. `EntityManager` and `EntityComponentDataset` boot
  clean under Node -- checked -- so the fix is to give the harness a real one.
- **The contact payload is valid only during dispatch.** Every field must be copied out.
- **Execution order is a heuristic.** `updateExecutionOrder` scores systems by declared component
  access; systems declaring none all score 0 and tie, falling back to registration order. Where
  order between our own systems is load-bearing, declare `components_used` rather than rely on it.

---

## Steps

### Step 1 — one clock — **done**

`em.fixedUpdateStepSize` stays at the engine default.

**`pmove_fixed` was the wrong knob and is not set.** The plan called for it, and reading what it
does at a 16.667 ms step says otherwise. `PlayerController` now carries the sub-millisecond
remainder instead of rounding it -- the arithmetic `MoverSystem` has always used -- so a step spends
16 or 17 whole milliseconds and the sequence sums exactly. `pmove_fixed 1` with `pmove_msec 8` would
then split a 17 ms step into 8 + 8 + 1, and that 1 ms tail is a real sub-step with its own friction
and acceleration pass: raggeder than the single uniform step leaving it alone produces. It exists in
Q3 to make a client and a server agree, and there is no server here.

Rounding, which is what this replaced, gave 17 ms for every 16.667 ms step -- so the player's clock
ran two percent fast against the movers, for ever.

*Exit criterion, met:* `test/fixed-step.test.ts` drives ragged frame times through the real
controller and asserts that the same wall-clock time reaches the same origin and velocity to the
last bit whether it arrives in 45 frames or 180, that every step spends 16 or 17 ms and nothing
else, and that the mean lands on the engine's step size.

### Step 2 — nine phases become systems — **done**

Thin `System` subclasses over the plain game classes, which stay ECS-free so `match.test.ts` keeps
its subject: mover, item, combat, bot and player simulation on `fixedUpdate`; a presentation system
on `update` for HUD, view weapon, audio retirement and item spin.

Deleted here: `frameStages()` (41 lines) and `main`'s `secondAccumulator`, which is now a count of
whole steps inside `PickupSystem`. The `Math.round(dt * 1000)` in `PlayerController.update` became
the carry described under step 1.

**Two of the four accumulators stay, and the plan was wrong to list them.**
`MoverSystem.accumulator` is not frame-rate compensation -- it is the whole-millisecond carry that
keeps `level.time` an integer, which a 16.667 ms step needs exactly as much as a variable one did.
`Arena.trailAccumulator` thins the smoke trail to one puff every N projectile steps; on a fixed step
its docblock's reason (a 240 Hz frame makes four times the smoke a 60 Hz frame does) stops applying,
but the rate control it provides is still wanted, and step 6 removes the whole `projectileMoved`
path it hangs off anyway.

Also fixed here, and independent of everything else: `BotRuntime.update` is handed
`deltaSeconds * 1000` by `main` and `TICK * 1000` -- exactly 8 -- by `match.test.ts`, and `Bot.think`
does `this.timeMs += deltaMilliseconds` before `cmd.serverTime = this.timeMs`. So bot command times
are fractional in the browser and integral under test, while `PlayerController` rounds. `Bot`'s own
docblock says the accumulation is in whole milliseconds *specifically so the bot and the player
advance on the same clock*, and in the shipping path they do not. A fixed step makes it
unrepresentable.

*Exit criterion, met:* `main()` is 573 lines and has no `try`/`catch` in the frame path;
`test/fixed-step.test.ts` registers a deliberately throwing system and asserts the systems on either
side of it still ran and that the engine's report names `UnhappySystem` and `fixedUpdate`.

The frame moved to `src/app/systems.ts` (six systems) and the match roster to `src/app/roster.ts`,
which is the other 125 lines `main` was carrying that were not wiring.

### Step 3 — interpolation — **done**

`InterpolationSystem` registered, `physicsSystem.interpolationLog` assigned, `Interpolated` carrying
`[POSE_INTERPOLAND]` on mover geometry and bot characters.

**The application needed its own timeline, and the engine has a seam for exactly that.** An
`InterpolationLog` admits one producer per tick -- `begin_tick` throws while a tick is open -- and
`PhysicsSystem` is already that producer for the local timeline. Mover geometry and a bot's drawn
body are not physics-owned (a Q3 player box does not rotate with the model standing in it, so the
collision body cannot share the character's transform), so they go on a second source registered
through `InterpolationSystem.registerSource` -- the same seam the network layer uses for its
render-delayed playout. `PoseRecorderSystem` is ~50 lines and finds its entities with
`dataset.traverseComponents`, which keeps it component-driven *and* keeps it at execution-order
score zero. Declaring `dependencies = [Interpolated]` would have been the obvious way to get the
same set and would have scheduled it to snapshot poses one step before they are written.

**View angles did not move to render rate, and the reason is the scheduler.** `CameraSystem3`
references two components to `InterpolationSystem`'s one, so it scores higher and copies the camera
entity onto Shade's camera *before* anything is blended into it. An `Interpolated` camera would be a
frame late rather than smooth. The camera stays written on the fixed step, where `CameraSystem3`'s
own `update` sees the current cycle -- which is already better than the arrangement it replaces,
where the application's listener ran after `entityManager.update` and the frame was always drawn
from the previous tick's pose.

**One bug found, in `MoversView`.** It skipped writing a mover whose origin had not changed. That
early-out cannot survive interpolation: between steps the transform holds a *blended* pose, so
skipping the write leaves the blend there, the recorder snapshots the blend, and a stationary door
walks away from itself -- a quarter of a unit in four steps, measured. `Vector3.set` already
compares before it assigns and only dispatches `onChanged` on a real difference, so the early-out
was the engine's own check written a second time, with the added effect of hiding a correction. It
is gone, and both halves are pinned.

*Exit criterion, met:* `test/interpolation.test.ts` (6 cases) drives a fixed-step producer at four
frames per step and asserts the drawn pose lands on 1.25, 1.5, 1.75 and 2 while the simulation says
2 throughout; that an entity without the component is untouched; that a resting producer does not
drift and a producer that stops writing does; and both scheduling facts above, read off
`systemsExecutionOrder` rather than assumed.

### Step 4 — headless ECS — **done**

`HeadlessPhysics` is a real `EntityManager` with a real `EntityComponentDataset`, and `step(dt)`
drives `em.update(dt)` rather than the system. `ColliderObserverSystem` attaches the shapes, so a
body is an entity with three components instead of two calls in the right order; the two-method
dataset stand-in `KinematicMover` was being handed is gone; `interpolationLog` stays null, which the
engine documents as skipping producer work entirely.

It is a factory now, for `PhysicsWorld.create`'s reason -- systems must be running before any body
is built or nothing is ever linked -- and `EntityManager.startup` is callback-style and completes on
a microtask, so a constructor could not do it. Thirteen call sites moved to
`await HeadlessPhysics.create(cm)`. The test harnesses that build a world during collection
(`match`, `meepmove`, `player-controller`) warm a module-scope cache with top-level await, which is
what kept all 24 `new Rig(...)` sites and every `it` callback in `player-controller.test.ts`
untouched.

*Exit criterion, met:* the suite passes unchanged, and `test/headless-ecs.test.ts` drops a dynamic
body at rocket speed onto real `oa_dm1` collision and asserts a `PhysicsEvents.ContactBegin` reaches
an entity listener carrying a usable normal -- the thing that would have been silently invisible
before, and which step 6 hangs entirely off.

### Step 5 — character bodies, and the filters they force — **done**

`RigidBody` (`IsSensor`, `KinematicVelocity`, layer `CHARACTER`, mask `MISSILE`) plus `Collider`
carrying the same `footedBox` the mover sweeps with, on every player and bot. `src/client/CharacterBody.ts`.

**The filter went on `MoverHost`, not through the constructors.** `MoverHost` gains an optional
`moveFilter`, and each character is handed its *own* host object carrying a filter that names its own
body -- so `MeepMove`, `PlayerController` and `Bot` never learn what an entity is, and nothing in the
game classes changed. `PlayerController` and `Bot` take `slot.host ?? moverHost`, and that is the
whole diff on either.

**`setPose`, not a transform write, and it is worth a step of latency.** A kinematic body's
broadphase leaf is refitted inside `PhysicsSystem.fixedUpdate`, which the scheduler runs ahead of
every application system -- so a transform written after the movement would not reach the BVH until
the following step, and a player walking into a bot would resolve against where that bot was last
time. `setPose` re-homes the leaves as it goes. It also flags `snap` on an `Interpolated` component,
which the engine documents as a known bug once `InterpolationSystem` is wired (and step 3 wired it);
these bodies carry no `Interpolated`, because what gets drawn is the separate entity `Character`
owns, so the interaction cannot arise.

**One deliberate simplification.** A crouched character keeps its standing box: Q3 shortens
`maxs[2]` from 32 to 16, and swapping a live `Collider.shape` per step is not what the collider
observer is built for. A crouching player is 16 units over-tall to a rocket and to another player;
their own movement is unaffected, because `MeepMove` picks its posture shape itself.

*Exit criterion, met:* `test/character-body.test.ts` (4 cases) asserts a character with a body reaches
the same origin and velocity **bit for bit** as the same walk with no bodies at all -- the filter
leaking would show as drift, not as a stop; that `overlap()` at the character's feet finds its body,
which fails by 28 units if the feet-at-origin lift is missed; that two characters walking into each
other stop with their origins 30 units apart instead of passing through; and that a body marked to
pass through leaves the walk identical to the no-bodies control, which is the hook step 6 hangs
missiles on.

### Step 6 — projectiles as bodies — **done**

`src/client/Missiles.ts`. `BodyKind.Dynamic`, `gravityScale = 0`, `RigidBodyFlags.CCD`, layer
`MISSILE` masked to world and characters, `Interpolated` on the physics timeline. Detonation is a
`PhysicsEvents.ContactBegin` listener; the owner skip is a `setContactFilter`, because
`CalcMuzzlePoint` puts the muzzle 14 units in front of the eye and a Q3 box is 30 wide, so every
missile is created inside the person who fired it.

Deleted: `WeaponSystem`'s integrate-and-trace loop, `rayBoxFraction` (48 lines), and the whole
`projectileMoved` path. `Arena` no longer builds a second entity for the rocket -- the model, the
interpolation and the scale go onto the body the engine is already flying, and the trail and the fly
sound come from a walk over `WeaponSystem.liveProjectiles`.

**Four things this turned up, and three of them are the point of the exercise.**

- **Sensors are invisible to CCD**, so a character body cannot be one. `ccd/linear_sweep.js` says so
  outright, and a plasma bolt covers 33 units in a 16.7 ms step against a 30-unit box. Step 5's
  bodies became solid; it costs nothing, because `layer`/`mask` already say a character pairs with
  missiles and nothing else.
- **`MASK_SHOT` versus `MASK_PLAYERSOLID` has no equivalent in a contact.** The level's bodies are
  built once, to stop players, so a player-clip brush is a body like any other -- and Q3 shoots
  straight through those. Fixed with `src/client/layers.ts`: a brush's layer comes from its contents
  and a missile's mask leaves `LAYER_PLAYERCLIP` out. Found with a rocket detonating on thin air.
- **The contact point is not the impact point.** meep's contacts are speculative, so a pair reported
  at zero depth carries the closest points on the two bodies rather than a touch, and their midpoint
  sat 9 units inside the wall. Q3 detonates at `trace.endpos` and the CCD sweep has already put the
  body exactly there, so the missile's own pose is both simpler and right.
- **Some of meep's convex hulls do not match the brushes they were built from.** A rocket flying
  down an open corridor on `oa_dm1` stops in mid-air on entity 162's hull, at a point where the
  ported `cm_trace` reports `CONTENTS` of zero and a 16-unit box sweep is clear. This is not new and
  is not step 6's -- `PhysicsTrace` hides it by re-deriving the blocking test from the clipmap's own
  brush planes (GAP-019), which is exactly why it exists -- but raw contacts have no such correction,
  so it is now visible and shipping. **It needs its own investigation and a DECISIONS entry**; the
  ring test below routes around it with a control run rather than pretending it is not there.

*Exit criterion, met:* `test/missiles.test.ts` fires from a 120-unit ring in 64 directions and
requires a direct hit in every direction where a control shot -- the identical rocket with the target
removed -- proves the path is clear on the collision the missile actually flies through; asserts the
impact lands within 4 units of the ported `cm_trace`'s own answer for a shot down a corridor; asserts
a rocket never direct-hits its owner while still taking Q3's self-splash; and asserts the ten-second
timer decrements by exactly one fixed step per step and takes the body out of the broadphase with it.

**`match.test.ts` now wires the whole arrangement** -- character bodies, a missile world, and the
engine's step inside the match loop -- so the headless match runs what the browser runs. Doing that
found the second `undefined` filter the plan named: `PhysicsTrace` answers `pm->trace`, a bot's line
of sight and an item's drop, and with character bodies in the world every bot's line of sight
terminated on its own collider, so no bot ever saw the player again. `PhysicsTrace.ignored` is the
fix, and missiles are in it too.

### Step 7 — splash and line of sight through physics — **unblocked, not yet done**

The plan was `PhysicsSystem.overlap` for splash candidates and `PhysicsTrace`'s `shapeCast` for
`CanDamage`'s line of sight, flipping D-067's `trap_EntitiesInBox` row from `workaround` to
`mapped`. It was deferred on the belief that meep's convex hulls did not match the brushes they were
built from, which would have poisoned both halves.

**That belief was wrong, and the investigation that disproved it is the useful part.**

- **The hulls are faithful.** Every hull vertex on all six shipped maps was checked against its own
  brush's planes: the worst escape is **0.089 units**, on `am_thornish`, and no hull anywhere has a
  vertex more than half a unit outside. `buildHulls` is doing its job.
- **Sweeps are trustworthy.** `shape_cast` is what `PhysicsTrace`, `KinematicMover` and now the
  missile confirmation all run on, and the 64-direction rocket test passes using a sweep as its
  arbiter. Nothing in the sweep path is implicated.
- **The defect is a contact-only bug in the engine**, recorded with a minimal repro in
  `test/convex-contact.test.ts`: meep dispatches `ContactBegin` between a sphere and a
  `ConvexHullShape3D` separated by up to **0.01 m** of clear air, and gives the event a *positive*
  `depth` equal to the gap -- where `ManifoldStore`'s own layout comment says a gap is negative. The
  identical box as a `BoxShape3D` reports nothing, because `sphere_box_contact` is a closed form that
  can say "separated"; a convex hull falls through to GJK + EPA. It is the shape class, not the map
  data -- an exact eight-vertex box reproduces it -- and it moves with where the sphere sits over the
  face, which is what a simplex-quality problem looks like. The engine's own
  `convex_convex_manifold` header already records EPA as unreliable for polytopes and routes
  hull-vs-hull around it with SAT; sphere-vs-hull has no such route. **This wants a GAP entry.**

So the port-side fix is local to contacts and is in: `Missiles` confirms every `ContactBegin` with a
sweep of the segment the missile just flew before it detonates anything, and the missile's collider
carries `ColliderFlags.IsSensor` so the same phantom contact cannot shove it off course either. A
missile that has stopped -- CCD clamped it against something -- is taken as a real impact without a
sweep, because a body resting on a surface sweeps nowhere and the first version of the guard left
live rockets parked against people's chests for ten seconds.

**Step 7 itself is therefore unblocked and still worth doing**, with one correction to its
justification: `CanDamage` and hitscan go through *sweeps*, which are sound, so the objection that
sank it does not apply. What remains true is the second reason it was deferred -- `G_RadiusDamage`
needs each target's box distance for the falloff, so `overlap` replaces the candidate scan and
nothing else, and the port's body-less targets (`Arena.addTarget`, behind `?targets=1`) still need
the old loop beside it.

---

## What is left

- **A GAP entry for the sphere-vs-convex-hull contact bug**, with `test/convex-contact.test.ts` as
  its evidence. The port routes around it; the engine should not need routing around.
- **Step 7**, which the above unblocks.
- **A DECISIONS entry for the priority inversion**, which is the first risk below and is now real
  rather than prospective.
- **The fly sound could ride the missile's own entity.** `AudioBank.loop` builds its own entity with
  a `Transform` and an `AudioEmitter`; attaching the emitter to the body instead would delete the
  per-step `move` call. Examined and left: the risk is not the attachment, it is `Loop`'s deferred
  materialisation path -- a browser will not start an `AudioContext` before the first gesture, and
  that queue is where the subtlety lives.
- **A crouched character keeps its standing collision box** (step 5).
- **Grenades still do not arc.** `gravityScale` and `Collider.restitution` are one number each now;
  the balance table has no field for either, and inventing one is a balance change.

## Risks, named rather than discovered later

- **Strafe-jump feel changes.** `pmove_fixed 1` at 60 Hz is not Q3's default client, and the port
  has been deliberately reproducing frame-rate dependence down to `SnapVector`. This needs its own
  DECISIONS entry saying the priority inverted, or REPORT.md keeps claiming a fidelity the code no
  longer pursues.
- **The 2x tunnelling margin.** 15 units of rocket travel against a 30-unit box is comfortable but
  not generous, and CCD explicitly will not help because sensors are not blockers. If the 64-way
  test finds a gap, the answer is a swept `shapeCast` in the missile's own fixed step against the
  character layer only -- not raising the tick rate.
- **Character-vs-character collision changes bot pathing.** `match.test.ts` measures distance walked
  and share of the navigation graph reached; both may move. They are thresholds, not equalities, but
  a bot wedged against another bot is a real failure mode and the wedge test exists for it.
- **Ordering becomes implicit** unless `components_used` is declared. Cheap to declare, invisible
  when wrong.

## Not in scope

Patching the engine; writing shaders or render passes; netcode -- `SmoothingState` and the rest of
`engine/network` are read here as evidence that the interpolation stack is general, not as something
to wire up; and moving item pickup or trigger brushes onto sensor bodies, which is the obvious next
step and is deliberately left for after this lands.

## Tracking

| step | state |
|---|---|
| 1 — one clock | **done** |
| 2 — phases become systems | **done** |
| 3 — interpolation | **done** |
| 4 — headless ECS | **done** |
| 5 — character bodies | **done** |
| 6 — projectiles as bodies | **done** |
| 7 — splash and LOS | **unblocked**, not done — see the step |
