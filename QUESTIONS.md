# Questions

Accumulated between phase boundaries and surfaced in one batch. Nothing here blocks work — each
has a default already chosen and recorded in `DECISIONS.md`, and the work proceeded on that
default. Answers override; silence is consent.

Format: **Q-nnn** — the question, the default in use, and what changes if the answer differs.

---

## Still open

### Q-001 — Is the licence flip to GPLv2 what you intended?

The repo shipped an MIT `LICENSE` with your copyright on it, and the brief says the repo is
GPLv2. Since the port derives from GPL-2.0-only id/OpenArena code, MIT was not available, so
`LICENSE` is now GPLv2 (D-001).

**Default in use:** GPLv2; `package.json` says `GPL-2.0-or-later`.
**If different:** the only alternative that changes anything is dual-licensing the
original-to-this-port files (asset pipeline, meep integration layer) separately from the ported
ones. Say so and I will split the headers — mechanical and cheap now, less cheap later.

### Q-003 — How much of the OA character roster is worth converting?

`pak2-players.pk3` is 74 MB of MD3 characters. Each needs converting to glTF with a skeleton,
because meep animates skeletally and MD3 is vertex-morph. Per-character work with a
per-character failure mode.

**Default in use:** not yet started — phase 4 deferred player models in favour of finishing the
oracle work. When it starts: convert **three** characters sharing one skeleton and one animation
set. Enough for a deathmatch to read as one, and it caps the risk of an animation pipeline
becoming a phase in its own right.
**If different:** more characters is linear extra time, not extra risk, once the first works.

### Q-005 — Should the demo prioritise breadth or depth from here?

Phase 2 is finished to a standard the rest is not: movement and collision are bit-exact against
a compiled-from-source oracle across 100,000 traces and ~50,000 simulated frames. Phases 3–5 are
partial.

The remaining work splits into two shapes and I would rather you chose than guess:

- **Breadth** — items and pickups, doors and platforms (BSP submodels), player models and
  animation, positional audio, bots on meep's behaviour trees. Makes the demo look and play more
  like Quake; each piece is shallow.
- **Depth** — patch collision (`cm_patch.c`, D-017, currently the reason curved surfaces are not
  solid and why the differential suite runs on 25 of 72 maps), and extending the oracle to cover
  the weapon and item code the same way movement is covered.

**Default in use:** breadth, on the reasoning that the demo half of the brief is the half that
is behind. Depth is the more defensible engineering answer and I would switch to it on a word.

---

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

No answer needed, but flagging the visible cost: without baked lighting, large flat surfaces
read as uniform. It is the most noticeable quality gap in the demo.

### Q-004 — Q3-faithful HUD, or a meep-native one? — **settled, provisionally**

The HUD is currently a speedometer and a status line, not a Q3 HUD, because until there is
health/armour/ammo state behind it a faithful layout would be showing placeholder numbers. It is
built on meep's `View` hierarchy as the brief requires.

**Default in use:** faithful layout when the state exists — same information in the same screen
positions, same numbers, rendered with meep UI primitives and modern typography rather than Q3's
bitmap font.
**If different:** cheap to change at any point; it is presentation only.
