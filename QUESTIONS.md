# Questions

Accumulated between phase boundaries and surfaced in one batch. Nothing here blocks work —
each has a default already chosen and recorded in `DECISIONS.md`, and the work is proceeding
on that default. Answers override; silence is consent.

Format: **Q-nnn** — question, the default being used, and what changes if the answer differs.

---

## Raised at end of phase 0

### Q-001 — Is the licence flip to GPLv2 what you intended?

The repo shipped an MIT `LICENSE` with your copyright on it, and the brief says the repo is
GPLv2. Since the port derives from GPL-2.0-only id/OpenArena code, MIT was not available, so
`LICENSE` is now GPLv2 (D-001).

**Default in use:** GPLv2, `package.json` says `GPL-2.0-or-later`.
**If different:** the only alternative that changes anything is dual-licensing the
original-to-this-port files (asset pipeline, meep integration layer) separately from the
ported ones. Say so and I will split the headers accordingly — it is a mechanical change and
cheap now, less cheap after phase 3.

### Q-002 — Baked Q3 lightmaps, or fully dynamic clustered lighting?

You left this to me, subject to "whatever the engine already supports, nothing new". Both are
supported: `StandardVertex` carries a `uv1` lightmap channel and there is a
`shade/renderer/lightmap/` subsystem, and clustered lighting is meep's headline feature.

**Default in use:** decide empirically at the start of phase 4 — build both, keep the one that
looks better and costs less. Q3 BSP lightmaps are per-face 128×128 atlas pages with UVs
already baked in page space, so feeding them to a system that expects one atlas needs a
repack; that repack is the actual cost of the baked route, and I will know its size once the
BSP reader exists in phase 1.
**If you have a preference:** say which, and I will stop hedging and build one. Clustered-only
is the option that shows the engine off, and is where I would lean.

### Q-003 — How much of the OA character roster is worth converting?

`pak2-players.pk3` is 74 MB of MD3 characters. Each needs converting to glTF with a skeleton
(D-011 forthcoming, phase 1) because meep animates skeletally and MD3 is vertex-morph. The
conversion is per-character work with a per-character failure mode.

**Default in use:** convert **three** characters and share one skeleton and one animation set
between them. That is enough for a deathmatch to read as a deathmatch, and it caps the risk of
an animation pipeline that turns out to be a phase in its own right.
**If different:** more characters is linear extra time, not extra risk, once the first one
works.

### Q-004 — Is a Q3 UI look expected, or a meep-native one?

The brief says HUD and menus use meep's UI system, which settles the *implementation*. It does
not settle the *appearance*: a faithful 1999 HUD versus something that looks like it was
designed this decade.

**Default in use:** faithful layout — same information in the same screen positions, same
numbers — rendered with meep UI primitives and its own typography rather than Q3's bitmap
font. Q3's HUD is genuinely well laid out and reproducing it costs nothing extra, whereas
designing a new one is design work this port has no mandate for.
**If different:** this is a cheap change at any point; it is presentation only.
