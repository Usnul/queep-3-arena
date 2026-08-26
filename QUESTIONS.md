# Questions

Accumulated between phase boundaries and surfaced in one batch. Nothing here blocks work — each
has a default already chosen and recorded in `DECISIONS.md`, and the work proceeded on that
default. Answers override; silence is consent.

Format: **Q-nnn** — the question, the default in use, and what changes if the answer differs.

---

## Still open

### Q-007 — Is a renderer-settings hole in `GraphicsEngine3` something you can get fixed, or do I design around it permanently?

Raised at the phase 8 boundary and the only thing in this document that is not already decided.

`feature_ssr_enabled` and `indirect_lighting_mode` live on `Renderer`, which `GraphicsEngine3`
constructs privately and — deliberately, with a docblock that argues the case well — never hands
out. So this port cannot turn on SSR, cannot switch to Brick4, and cannot call
`brick4_bake_for_scene`, which takes a renderer as an argument. GAP-024 has the evidence and D-094
has what was checked before concluding it.

**Default in use:** the lighting half of phase 8 is cut. The materials half shipped without it —
108 world materials now carry a normal map and an ORM, and the deferred pass reads both under the
IBL mode the port already runs.

**If different:** two forwarded properties on the facade, in the shape `set_environment_map`
already has, would unblock SSR and Brick4 display in an afternoon; a
`graphics.bake_volumetric_lightmap(scene, options)` would unblock the bake. If that is a change you
would make, say so and I will finish step 5 against it. If it is not, the answer is worth having in
writing, because it settles Q-002 and GAP-006 permanently rather than leaving them open — meep's
lightmapper would then be a facility this port structurally cannot reach, rather than one it has
not got to yet.

The other half of the finding needs no answer and is worth flagging anyway: SSR and Brick4 are
alternatives rather than a stack. `Renderer.js:768` runs the SSR pass only when the indirect mode is
not Brick4, with a comment calling it a known limitation.


---

## Answered

### Q-006 — Should the asset pipeline read the BSP lightgrid? — **answered: yes, and done**

Raised at the phase 6 boundary by measuring something that had been assumed, and closed in
phase 7 by building it. The default in use was "not done", on the reasoning that building a
feature during the reporting phase is the wrong trade against leaving the report incomplete. The
report is finished, so the trade changed.

`oa_dm5` goes from **zero** reconstructed point lights over 107,414 triangles to 39, and from all
36 of its measured player positions dark to one of 37. `oa_dm7` goes from 70 of 79 positions under
a lux to none of 80. The three maps the demo presents move by 0.4 lux, by 2%, and not at all —
which is the deficit formulation doing its job rather than a special case for them.

It cost about the half day estimated, and `test/presentation.test.ts` failed on the two pinned
maps exactly as predicted, which was the point of pinning them. The lighting criterion is now
asserted on all six maps instead of three. Two things went wrong on the way and both are worth
reading in D-078: a fixed placement offset that emitted 256 lights on a map needing 11, and a
greedy fit that over-delivered threefold until it was replaced with a least-squares pass.

It does **not** close GAP-006. A lightgrid cell is 64×64×128 units, so what comes back is which
room is lit, how brightly and what colour; the spatial detail is in the lightmap, and the
lightmap is still the thing meep cannot import.

### Q-001 — Is the licence flip to GPLv2 what you intended? — **answered: yes**

The repo shipped an MIT `LICENSE` with your copyright on it, and the brief says the repo is
GPLv2. Since the port derives from GPL-2.0-only id/OpenArena code, MIT was not available, so
`LICENSE` is GPLv2 (D-001) and `package.json` says `GPL-2.0-or-later`.

### Q-003 — How much of the OA character roster is worth converting? — **answered: all of them**

Done: **15 of the 16** characters OA 0.8.8 ships with an `animation.cfg`. The sixteenth,
`angelyss`, ships `lower.md3` and no `upper.md3` or `head.md3`, and is reported rather than
silently skipped.

The proposed default was three characters sharing one skeleton, on the reasoning that
per-character conversion is per-character risk. That reasoning turned out to be wrong in a useful
way: the risk is in the *method*, not in the models. Once the skinning decomposition worked on
`sarge`, the other fourteen cost 5.8 seconds of CPU and no attention at all. Reconstruction error
across the roster runs 0.005 to 0.267 Q3 units -- under a centimetre in the worst case (D-042).

### Q-005 — Breadth or depth from here? — **answered: breadth**

Done, in the order given: items and pickups, movers and triggers, the character roster,
positional audio, and bots. What each does and does not do is in `DECISIONS.md` D-033 through
D-055.

Two things are worth flagging back, because breadth surfaced findings that depth would not have:

- The single most broadly applicable finding in the report came out of the *bots* --
  meep's navmesh is good and there is no path from a Q3 level to its input (GAP-016). It is
  measured and reproducible in one command.
- Two silent-failure API traps (GAP-014, GAP-015) came out of the physics and character work
  respectively. Both are the kind that only appear when you actually wire the subsystem up.

Depth remains the more defensible engineering answer for a *product*; for a report about an
engine, breadth found more.

## Answered by doing

### Q-002 — Baked Q3 lightmaps, or fully dynamic clustered lighting? — **settled**

Settled by measurement rather than preference, and neither option was the one on offer.

meep's lightmap subsystem turned out to be a *baker*, with no path to import an existing
lightmap (GAP-006). Separately, q3map2 **strips every `light` entity** from a compiled BSP after
baking — confirmed empirically at zero across six maps — so meep's baker had nothing to bake
from either.

What remained was the `.shader` scripts, which still carry the light data q3map2 itself used:
679 `q3map_surfacelight` declarations, 66 `q3map_sun`. The pipeline reconstructs lighting from
those as real dynamic lights, 13 to 147 per map (D-012). Clustered lighting absorbed it without
tuning.

No answer needed, but flagging the visible cost, which phase 6 revised twice over. Without baked
lighting, large flat surfaces read as uniform — that part stands. What was not known when this
was written is that the reconstruction does not work *at all* on two of the six maps, because the
`.shader` route only carries light for maps whose authors lit them with surface shaders. See
Q-006, which is the open half of this question.

### Q-004 — Q3-faithful HUD, or a meep-native one? — **settled, provisionally**

The HUD is currently a speedometer and a status line, not a Q3 HUD, because until there is
health/armour/ammo state behind it a faithful layout would be showing placeholder numbers. It is
built on meep's `View` hierarchy as the brief requires.

**Default in use:** faithful layout when the state exists — same information in the same screen
positions, same numbers, rendered with meep UI primitives and modern typography rather than Q3's
bitmap font.
**If different:** cheap to change at any point; it is presentation only.
