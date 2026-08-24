# Questions

Accumulated between phase boundaries and surfaced in one batch. Nothing here blocks work — each
has a default already chosen and recorded in `DECISIONS.md`, and the work proceeded on that
default. Answers override; silence is consent.

Format: **Q-nnn** — the question, the default in use, and what changes if the answer differs.

---

## Still open

*Nothing. Q-001, Q-003 and Q-005 were answered; the rest were settled by doing.*

New questions, if any, would go here. There are none: every open decision at this point has a
default that is cheap to reverse, and they are recorded in `DECISIONS.md` rather than raised as
questions.

---

## Answered

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
