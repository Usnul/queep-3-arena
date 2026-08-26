"""Turn raw inverse-renderer output into the three maps a material actually binds.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

    python tools/cosmos/build_maps.py

Reads `assets/generated/manifest.json` and the raw passes under
`assets/generated/raw/`, and writes `assets/generated/materials/`:

    <stem>.albedo.png   the artist's colour with the network's de-lighting applied
    <stem>.normal.png   tangent space, unit length, only when it survives the checks
    <stem>.orm.png      R 1.0, G roughness, B metalness

Nothing here trusts the network. Every channel is either corrected, checked, or
replaced outright by the hand table, and which of those it is was decided by
measurement in D-092 rather than by inspection.

# The albedo is re-tinted rather than used

Every de-lit albedo in the pilot came back brighter and greyer than its source: a
brown stone wall at (0.23, 0.15, 0.08) returned at (0.51, 0.49, 0.46) with a
chroma of 0.019. The model is trained on photographs, where a brown cast over
stone usually *is* the light. On a hand-painted Q3 texture the brown is paint,
and it is the only statement anyone ever made about what the wall is made of.

What the network is nonetheless right about is *where* the shading is, and that is
carried by the ratio of luminances. So the shipped albedo is the source's colour
at every texel scaled by that ratio: the painted highlight and the painted recess
flatten out, and the hue stays. It improved the round trip on 16 of 16 pilot runs.

Its overall *level* is discarded as well, for a different reason -- see
`build_albedo`. Kept, it roughly doubles every surface in the game and silently
invalidates a photometric calibration that took two phases to get right.

# The normal is checked, not accepted

Three ways a generated normal map is refused, and all three were observed:

- **Inverted.** `acc_dm3/rivets` came back with a mean tilt of 127.6 degrees --
  normals pointing into the surface, the image visibly green rather than blue.
- **Flat.** Some textures have no relief to find and the model honestly reports
  none. Binding a flat normal map costs a texture fetch to change nothing.
- **Seamed.** A wrapping texture whose generated map does not wrap puts a line
  down every tile boundary in the level. The framing is designed to avoid this
  and mostly does; this is the check that it did.

# The ORM is mostly not the network's

G is the hand table's roughness level plus the network's *variation* around it,
because D-092 measured the absolute value as worthless -- 0.76 and 0.21 for the
same wall depending on framing -- and the relative structure as right. B is the
hand table's metalness bit and contains nothing inferred at all. R is 1.0: meep's
GTAO samples the g-buffer shading normal, so occlusion follows the normal map for
free and a baked channel would fight it.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]

#: Past 90 degrees the average texel faces *into* the surface, which is not a
#: strong normal map, it is a sign-flipped one. Four of 171 came back like this.
INVERTED_TILT_DEG = 90.0

#: And past this, without being inverted, the average texel is at an angle no
#: painted wall or skin has. Kept separate from the number above because
#: "inverted" is a specific claim and a 47-degree map is not inverted, it is
#: implausible -- both are refused, and saying which is which is free.
MAX_MEAN_TILT_DEG = 45.0

#: Below this, there is nothing in it worth a texture fetch.
MIN_MEAN_TILT_DEG = 1.0

#: A wrapping map is refused only when its seam is *both* visible and worse than
#: the source's.
#:
#: The excess alone was the first rule and it was wrong. It refused
#: `textures/sfx/metalfloor_wall_14b` at a seam of -0.1 -- edges *closer* than
#: ordinary interior neighbours, no line to see -- because its source scores -5.5
#: and the difference is 5.4. Comparing only to the source punishes a texture for
#: having been unusually continuous to begin with.
#:
#: The floor is set from the pilot: the framing that works produced 0.06 to 4.75
#: across every channel and the framing that does not produced 17 to 89, so six
#: separates them with room on both sides.
SEAM_VISIBLE = 6.0
MAX_SEAM_EXCESS = 4.0


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def luminance(linear: np.ndarray) -> np.ndarray:
    return (linear * np.array([0.2126, 0.7152, 0.0722])).sum(axis=2, keepdims=True)


def read(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0


def save(path: Path, image: np.ndarray) -> None:
    Image.fromarray((np.clip(image, 0, 1) * 255).round().astype(np.uint8)).save(path)


def seam_excess(image: np.ndarray) -> float:
    """How much more different the wrap edges are than ordinary neighbours, 8-bit units.

    Not "how different are the edges" -- some textures genuinely change across a
    tile, and `acc_dm3/cop` scores 47 on its own *source*. What the eye reads as a
    line is the edge pair being worse than the interior pairs around it.
    """
    def gap(a, b):
        return float(np.mean(np.abs(a - b))) * 255.0

    return max(
        gap(image[:, -1, :], image[:, 0, :]) - gap(image[:, :-1, :], image[:, 1:, :]),
        gap(image[-1, :, :], image[0, :, :]) - gap(image[:-1, :, :], image[1:, :, :]),
    )


def build_albedo(source: np.ndarray, net: np.ndarray | None) -> tuple[np.ndarray, str]:
    """The artist's colour, with the network's *shading* taken out of it.

    Two things are deliberately discarded from the network's answer.

    **Its hue**, because a de-lighter trained on photographs reads a brown cast
    over stone as light and removes it, and on a painted texture the brown is the
    material. Only the ratio of luminances is kept, which is where the shading is.

    **Its level**, because the absolute brightness of a de-lit albedo is not
    recoverable in the first place -- it is degenerate with the intensity of the
    light that was removed -- and the network's guess at it is the part that came
    back grey. Left alone it roughly doubles every surface in the game, and the
    port's photometry is calibrated against the current levels: a lightgrid byte
    is LUX_PER_BYTE lux (D-078) and UNLIT_LUMINANCE is derived from the albedo a
    fully lit wall reflects. Doubling every albedo silently invalidates both.

    So the mean luminance is put back where it was, and what survives is exactly
    the thing this phase wanted: the painted highlight and the painted recess
    flattened out, so that real lights can put them back.
    """
    if net is None:
        return source, "no basecolor pass"

    source_linear = srgb_to_linear(source)
    source_lum = luminance(source_linear)

    # A texel the source paints near-black has no colour to preserve and a wild
    # ratio; the clamp stops one dark corner blowing out the whole map.
    ratio = np.clip(luminance(srgb_to_linear(net)) / np.maximum(source_lum, 1e-4), 0.0, 8.0)

    corrected = source_linear * ratio

    before = float(source_lum.mean())
    after = float(luminance(corrected).mean())
    gain = before / after if after > 1e-6 else 1.0
    corrected *= gain

    return linear_to_srgb(corrected), f"retinted, level held (x{gain:.2f})"


def build_normal(net: np.ndarray | None, wraps: bool, source_seam: float) -> tuple[np.ndarray | None, str]:
    """Decode, check, renormalise, re-encode. `None` means the map is refused."""
    if net is None:
        return None, "no normal pass"

    n = net * 2.0 - 1.0
    length = np.linalg.norm(n, axis=-1, keepdims=True)
    usable = length > 1e-3

    unit = np.where(usable, n / np.maximum(length, 1e-9), np.array([0.0, 0.0, 1.0]))

    #
    # Re-centre the tangent components, and this is a correction rather than a
    # tidy-up.
    #
    # A normal map for a *texture* has to average to the flat normal, because the
    # surface it will be applied to is what carries the slope. A map whose mean is
    # (0, 0.3, ...) is saying the wall leans, and the wall does not lean -- the
    # brush it is painted on decides that, and the brush is flat.
    #
    # Across the 171 maps the network produced, the X means average 0.4945 and the
    # Y means average 0.5417: a systematic lean of about five degrees in +Y, with
    # 49 maps past 0.55 against 16 in X. That is the model's own prior showing
    # through -- it estimates normals for photographs of scenes, where surfaces
    # genuinely do tilt away from the camera, and there is no tangent frame in a
    # photograph for it to have been relative to. `gothic_floor/q1metal7_99stair`
    # came back at 0.813, a forty-degree average lean across a flat stair tread.
    #
    # Removing the DC is done before the tilt test below, not after, because some
    # of what that test would have refused as implausible relief is a plausible
    # map with a large offset on it.
    #
    centred = unit.copy()
    lean = unit[..., :2].mean(axis=(0, 1))
    centred[..., 0] -= lean[0]
    centred[..., 1] -= lean[1]
    length = np.linalg.norm(centred, axis=-1, keepdims=True)
    unit = centred / np.maximum(length, 1e-9)

    tilt = np.degrees(np.arccos(np.clip(unit[..., 2], -1.0, 1.0)))
    mean_tilt = float(tilt.mean())
    lean_deg = float(np.degrees(np.arcsin(np.clip(np.linalg.norm(lean), 0, 1))))

    if mean_tilt > INVERTED_TILT_DEG:
        return None, f"mean tilt {mean_tilt:.1f} deg, inverted"
    if mean_tilt > MAX_MEAN_TILT_DEG:
        return None, f"mean tilt {mean_tilt:.1f} deg, implausible relief"
    if mean_tilt < MIN_MEAN_TILT_DEG:
        return None, f"mean tilt {mean_tilt:.2f} deg, flat"

    encoded = unit * 0.5 + 0.5

    if wraps:
        seam = seam_excess(encoded)
        if seam > SEAM_VISIBLE and seam > source_seam + MAX_SEAM_EXCESS:
            return None, f"seam {seam:.1f} against source {source_seam:.1f}"

    return encoded, f"kept, mean tilt {mean_tilt:.1f} deg, lean removed {lean_deg:.1f} deg"


def build_orm(
    shape: tuple[int, int],
    net_roughness: np.ndarray | None,
    level: float,
    variation: float,
    metalness: int,
) -> tuple[np.ndarray, str]:
    """R 1.0, G the table's level plus the network's shape, B the table's bit."""
    orm = np.ones((shape[0], shape[1], 3), dtype=np.float64)
    orm[..., 2] = float(metalness)

    if net_roughness is None or variation <= 0:
        orm[..., 1] = level
        return orm, f"flat G {level:.2f}"

    #
    # The network's roughness is used only for its *shape*. Centring on its own
    # mean and scaling by `variation` is what turns "this texture is 0.21 rough"
    # -- a number that flips to 0.76 if the input is framed differently -- into
    # "the mortar is smoother than the block face", which is the part that was
    # right. The spread is normalised first so a low-contrast map and a
    # high-contrast one contribute the same amount of variation.
    #
    grey = net_roughness.mean(axis=2)
    spread = float(grey.std())
    shaped = (grey - float(grey.mean())) / spread if spread > 1e-4 else np.zeros_like(grey)

    orm[..., 1] = np.clip(level + variation * shaped, 0.03, 1.0)
    return orm, f"G {level:.2f} +/- {variation:.2f}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Assemble shipped material maps")
    parser.add_argument("--manifest", type=Path, default=REPO / "assets/generated/manifest.json")
    parser.add_argument("--raw", type=Path, default=REPO / "assets/generated/raw")
    parser.add_argument("--out", type=Path, default=REPO / "assets/generated/materials")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    jobs = json.loads(args.manifest.read_text(encoding="utf-8"))["jobs"]
    args.out.mkdir(parents=True, exist_ok=True)

    report = []
    counts = {"albedo": 0, "normal": 0, "orm": 0, "normal_refused": 0, "missing": 0}

    for job in jobs:
        stem, framing = job["stem"], job["framing"]

        source_path = args.raw / f"{stem}.source.png"
        if not source_path.exists():
            counts["missing"] += 1
            report.append({"image": job["image"], "error": "no raw output"})
            continue

        source = read(source_path)

        def load(kind):
            p = args.raw / f"{stem}.{framing}.{kind}.png"
            return read(p) if p.exists() else None

        #
        # An effect image is not artwork of a surface -- a `tcGen environment`
        # fake reflection, a powerup shell, a glyph on black -- so there is no
        # painted shading in it to take out and de-lighting it means nothing. The
        # table already refuses it a normal map for the same reason; refusing it a
        # replacement albedo is the same statement about the same twelve images,
        # and it leaves `writeTexture` binding the artwork unchanged.
        #
        if job["effect"]:
            albedo_why = "left alone, effect artwork"
        else:
            albedo, albedo_why = build_albedo(source, load("basecolor"))
            save(args.out / f"{stem}.albedo.png", albedo)
            counts["albedo"] += 1

        normal_why = "refused by the table"
        if job["normal"] == "keep":
            normal, normal_why = build_normal(
                load("normal"), job["framing"] == "wrap", seam_excess(source)
            )
            if normal is not None:
                save(args.out / f"{stem}.normal.png", normal)
                counts["normal"] += 1
            else:
                counts["normal_refused"] += 1

        orm, orm_why = build_orm(
            source.shape[:2], load("roughness"), job["roughness"], job["variation"], job["metalness"]
        )
        save(args.out / f"{stem}.orm.png", orm)
        counts["orm"] += 1

        report.append(
            {
                "image": job["image"],
                "framing": framing,
                "albedo": albedo_why,
                "normal": normal_why,
                "orm": orm_why,
                "metalness": job["metalness"],
                "roughness": job["roughness"],
            }
        )
        if not args.quiet:
            print(f"{job['image']:52s} normal: {normal_why}", flush=True)

    (args.out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print()
    print(f"{len(jobs)} images")
    print(f"  albedo written:  {counts['albedo']}")
    print(f"  normal written:  {counts['normal']}   refused: {counts['normal_refused']}")
    print(f"  orm written:     {counts['orm']}")
    if counts["missing"]:
        print(f"  no raw output:   {counts['missing']}")


if __name__ == "__main__":
    main()
