"""Judge inferred material maps by relighting them and comparing to the original.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

    python tools/cosmos/roundtrip.py --dir assets/generated/pilot \
        --manifest tools/cosmos/pilot.json --out assets/generated/pilot/roundtrip.json

# Why a round trip rather than an eye

An inferred material has no ground truth. Nobody knows what `blocks10` "really"
looks like unlit, because it was painted, not photographed, and the painting is
the only artefact that ever existed. So there is nothing to compute an error
against -- except the texture itself.

The texture is the appearance its artist intended. If the network has genuinely
separated it into base colour, surface and roughness, then putting those three
back under a light should give the texture back. If it has invented detail, or
hallucinated a material, or simply moved the brightness into the albedo and
called it a day, the relight will not match and the mismatch is measurable.

That is the whole argument. It is not a proof that the decomposition is *the*
right one -- several decompositions can relight to the same image -- but it is a
loud, cheap detector of the failure modes that actually matter here.

# What is compared against what, and why the obvious version of it is useless

The first arrangement of this measured every variant against what the port ships
today -- the texture as its own albedo, flat normal, roughness 0.85, metalness 0
-- and that baseline scored an RMSE of exactly **zero** on every texture.

It has to. On a flat quad with one light, a material whose albedo *is* the
texture reproduces the texture: the fit sets the light to nothing and the ambient
to one, and the render is the albedo unchanged. The port's placeholder material
is a perfect round trip, and it is a perfect round trip precisely because it has
not decomposed anything. So "does it reproduce the original" cannot separate a
good decomposition from no decomposition at all, and any number derived from that
comparison is measuring the lighting search rather than the maps.

What does separate them is the shape of the error across the ablation:

    baseline                 texture as albedo, flat normal, 0.85, 0   -- always 0
    albedo                   network albedo, everything else baseline
    albedo+normal            ...and the network normal
    albedo+normal+roughness  ...and the network roughness
    full                     ...and the network metalness

`albedo` is the interesting one. The network's albedo has had the painted shading
taken out of it, so on its own it *cannot* reproduce the source -- and how badly
it fails is a direct measure of how much shading was removed. Then every channel
added after it has to put that shading back, out of geometry and surface rather
than out of paint.

So the headline number is **recovery**:

    recovery = (rmse[albedo] - rmse[full]) / rmse[albedo]

the fraction of the de-lighting that the other three channels explain. Recovery
near 1 means the decomposition is self-consistent: what came out of the albedo
went into the normal and the roughness, and it comes back under a light. Recovery
near 0 means the network removed the shading and put it nowhere -- which is
exactly the failure that would ship a flat, dead-looking wall while every
individual map looked plausible in a viewer.

It also catches invented detail, which is the other thing worth catching, and
catches it from the same side: detail the network made up has no counterpart in
the source, so it cannot reduce the residual, and recovery falls.

# The light is fitted, not assumed

"Relight it under a light matching the implied one" is the only fair test: the
implied light is exactly what the de-lighting removed, and it is not recorded
anywhere. So for every variant the light is fitted -- direction, colour, and an
ambient term -- to give that variant its best possible showing. The fit is linear
in intensity and ambient once the direction is fixed, so this is a grid over two
angles with a two-unknown least squares inside it, refined by Nelder-Mead.

Fitting per variant rather than once is deliberate. It is the conservative
choice: it hands the baseline the same freedom it hands the network, so a win is
a win about the maps and not about the lighting search.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.optimize import minimize
from skimage.metrics import structural_similarity

#: Cook-Torrance F0 for a dielectric -- the usual 4% normal-incidence reflectance.
DIELECTRIC_F0 = 0.04

#: What `shader-to-pbr.ts` assigns every material today.
BASELINE_ROUGHNESS = 0.85
BASELINE_METALLIC = 0.0


# --------------------------------------------------------------------------- #
# Colour
# --------------------------------------------------------------------------- #


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def read(path: Path) -> np.ndarray:
    """An 8-bit image as float in [0, 1], RGB."""
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0


# --------------------------------------------------------------------------- #
# Shading -- one flat quad, one directional light, one ambient term
# --------------------------------------------------------------------------- #


def decode_normal(rgb: np.ndarray) -> np.ndarray:
    """Tangent-space normal from a normal-map image, unit length, +Z out of the surface.

    A map that is entirely flat decodes to (0, 0, 1) everywhere, which is what
    the baseline uses and what meep samples when no normal texture is bound.
    """
    n = rgb * 2.0 - 1.0
    length = np.linalg.norm(n, axis=-1, keepdims=True)
    # A near-zero vector means the network had nothing to say there; call it flat
    # rather than dividing by it.
    flat = np.zeros_like(n)
    flat[..., 2] = 1.0
    return np.where(length > 1e-3, n / np.maximum(length, 1e-9), flat)


def shade(albedo, normal, roughness, metallic, light_dir, light_rgb, ambient_rgb):
    """Cook-Torrance GGX plus Lambert, viewed head-on.

    Head-on because the comparison target is a texture, and a texture is what the
    surface looks like face-on. Grazing angles would exercise the Fresnel term
    harder but there is nothing to compare the result against.
    """
    view = np.array([0.0, 0.0, 1.0])
    half = light_dir + view
    half = half / np.linalg.norm(half)

    n_dot_l = np.clip(np.einsum("hwc,c->hw", normal, light_dir), 0.0, 1.0)[..., None]
    n_dot_v = np.clip(np.einsum("hwc,c->hw", normal, view), 1e-4, 1.0)[..., None]
    n_dot_h = np.clip(np.einsum("hwc,c->hw", normal, half), 0.0, 1.0)[..., None]
    v_dot_h = np.clip(float(np.dot(view, half)), 1e-4, 1.0)

    alpha = np.clip(roughness, 0.03, 1.0) ** 2
    a2 = alpha**2

    denom = n_dot_h**2 * (a2 - 1.0) + 1.0
    d_ggx = a2 / (np.pi * denom**2)

    # Height-correlated Smith visibility, which already carries the 1/(4 NdotL NdotV).
    lambda_v = n_dot_l * np.sqrt(n_dot_v**2 * (1 - a2) + a2)
    lambda_l = n_dot_v * np.sqrt(n_dot_l**2 * (1 - a2) + a2)
    visibility = 0.5 / np.maximum(lambda_v + lambda_l, 1e-6)

    f0 = DIELECTRIC_F0 * (1.0 - metallic) + albedo * metallic
    fresnel = f0 + (1.0 - f0) * (1.0 - v_dot_h) ** 5

    diffuse = albedo * (1.0 - metallic) / np.pi
    specular = d_ggx * visibility * fresnel

    direct = (diffuse + specular) * n_dot_l * light_rgb
    indirect = albedo * (1.0 - metallic) * ambient_rgb
    return direct + indirect


def direction(theta: float, phi: float) -> np.ndarray:
    """Unit vector at elevation `theta` from the surface plane, azimuth `phi`."""
    return np.array(
        [np.cos(theta) * np.cos(phi), np.cos(theta) * np.sin(phi), np.sin(theta)]
    )


def solve_light(target, albedo, normal, roughness, metallic, light_dir):
    """Best light colour and ambient for a fixed direction, per channel.

    With the direction fixed the render is `A * light + B * ambient` for images A
    and B that do not depend on either, so each channel is a two-unknown least
    squares. Solving it exactly rather than searching it is what makes the outer
    search over two angles cheap enough to be exhaustive.
    """
    one = np.ones(3)
    zero = np.zeros(3)
    lit = shade(albedo, normal, roughness, metallic, light_dir, one, zero)
    amb = shade(albedo, normal, roughness, metallic, light_dir, zero, one)

    light_rgb = np.zeros(3)
    ambient_rgb = np.zeros(3)
    for c in range(3):
        design = np.stack([lit[..., c].ravel(), amb[..., c].ravel()], axis=1)
        coef, *_ = np.linalg.lstsq(design, target[..., c].ravel(), rcond=None)
        light_rgb[c], ambient_rgb[c] = np.maximum(coef, 0.0)

    return light_rgb, ambient_rgb


#: Long side of the images the light search runs on. A light is four numbers per
#: channel over the whole image, so the search does not need every texel -- and
#: at full resolution the eighty-point grid plus Nelder-Mead is about forty
#: minutes for the pilot instead of about two.
SEARCH_LONG_SIDE = 128


def downsample(image: np.ndarray) -> np.ndarray:
    """Block-mean to at most `SEARCH_LONG_SIDE`, by an integer factor.

    Integer so the blocks are uniform, and a mean rather than a subsample so a
    normal map with fine detail is not reduced to whichever texels the stride
    happened to land on. A mean does shorten normals slightly; the search only
    needs the light direction, and the *reported* error is always computed at
    full resolution afterwards.
    """
    step = max(1, int(np.ceil(max(image.shape[:2]) / SEARCH_LONG_SIDE)))
    if step == 1:
        return image
    h = (image.shape[0] // step) * step
    w = (image.shape[1] // step) * step
    trimmed = image[:h, :w]
    return trimmed.reshape(h // step, step, w // step, step, image.shape[2]).mean(axis=(1, 3))


def fit_and_render(target_linear, albedo, normal, roughness, metallic):
    """Fit a light to this material, then render it at full size. Returns (render, fit)."""
    small_target = downsample(target_linear)
    small = (
        downsample(albedo),
        downsample(normal),
        downsample(roughness),
        downsample(metallic),
    )

    def cost(params):
        theta, phi = params
        d = direction(theta, phi)
        light_rgb, ambient_rgb = solve_light(small_target, *small, d)
        render = shade(*small, d, light_rgb, ambient_rgb)
        return float(np.mean((render - small_target) ** 2))

    best = None
    for theta in np.radians([90, 75, 60, 45, 30]):
        for phi in np.radians(range(0, 360, 30)):
            value = cost((theta, phi))
            if best is None or value < best[0]:
                best = (value, theta, phi)

    refined = minimize(
        cost,
        x0=[best[1], best[2]],
        method="Nelder-Mead",
        options={"xatol": 1e-3, "fatol": 1e-8, "maxiter": 120},
    )
    theta, phi = refined.x
    d = direction(theta, phi)
    light_rgb, ambient_rgb = solve_light(
        target_linear, albedo, normal, roughness, metallic, d
    )
    render = shade(albedo, normal, roughness, metallic, d, light_rgb, ambient_rgb)

    fit = {
        "elevation_deg": round(float(np.degrees(theta)) % 360, 2),
        "azimuth_deg": round(float(np.degrees(phi)) % 360, 2),
        "light_rgb": [round(float(v), 4) for v in light_rgb],
        "ambient_rgb": [round(float(v), 4) for v in ambient_rgb],
    }
    return render, fit


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def compare(render_linear, target_srgb):
    """Error of a render against the source texture, in the space it was authored in."""
    render_srgb = linear_to_srgb(render_linear)
    diff = (render_srgb - target_srgb) * 255.0
    rmse = float(np.sqrt(np.mean(diff**2)))
    ssim = float(
        structural_similarity(
            target_srgb, render_srgb, channel_axis=2, data_range=1.0
        )
    )
    return {
        "rmse8": round(rmse, 3),
        "psnr_db": round(float(20 * np.log10(255.0 / max(rmse, 1e-9))), 2),
        "ssim": round(ssim, 4),
    }


def seam(image: np.ndarray) -> float:
    """How discontinuous a wrapping image is across its own edges, in 8-bit units.

    A tiling texture is a torus: column w-1 is column 0's left neighbour. So the
    honest measure of a seam is not "how different are the two edges" -- some
    textures genuinely change across a tile -- but how much *more* different they
    are than the neighbouring interior column pairs, which is what the eye picks
    up as a line.
    """
    def gap(a, b):
        return float(np.mean(np.abs(a - b))) * 255.0

    across_x = gap(image[:, -1, :], image[:, 0, :])
    across_y = gap(image[-1, :, :], image[0, :, :])
    inside_x = gap(image[:, :-1, :], image[:, 1:, :])
    inside_y = gap(image[:-1, :, :], image[1:, :, :])

    return round(
        max(across_x - inside_x, across_y - inside_y),
        3,
    )


def channel_stats(image: np.ndarray) -> dict:
    """Enough to tell a real map from a flat one, or a grey map from a coloured one."""
    mean = image.mean(axis=(0, 1))
    return {
        "mean": [round(float(v), 4) for v in mean],
        "std": round(float(image.std()), 4),
        # A roughness or metalness map is a scalar and must come back grey. Colour
        # in it means the network answered a different question.
        "chroma": round(float(np.mean(np.abs(image - image.mean(axis=2, keepdims=True)))), 4),
    }


def luminance(linear: np.ndarray) -> np.ndarray:
    return (linear * np.array([0.2126, 0.7152, 0.0722])).sum(axis=2, keepdims=True)


def retint(source_linear: np.ndarray, albedo_linear: np.ndarray) -> np.ndarray:
    """The network's de-lighting, applied to the artist's colour.

    Every de-lit albedo in the pilot came back brighter and *greyer* than its
    source: a brown wall at (0.23, 0.15, 0.08) returns at (0.51, 0.49, 0.46) with
    a chroma of 0.019. The model is trained on photographs, where a brown cast
    over a stone wall usually *is* the light, and it removes it. On a hand-painted
    Q3 texture the brown is paint, and removing it throws away the only statement
    anyone ever made about what the wall is made of.

    What the network is nonetheless right about is where the *shading* is: which
    texels are in a painted recess and which are on a lit face. That is carried
    entirely by the ratio of luminances, so this keeps the ratio and discards the
    hue shift -- the source's colour at every texel, scaled by how much darker or
    lighter the network thinks that texel should be.

    It is not a way of getting a better de-lighting out of the model. It is a way
    of using the part of the answer that survives being out of domain.
    """
    ratio = luminance(albedo_linear) / np.maximum(luminance(source_linear), 1e-4)
    # A texel the source paints near-black has no colour to preserve and a wild
    # ratio; clamping keeps one dark corner from blowing out the whole map.
    return source_linear * np.clip(ratio, 0.0, 8.0)


def bimodality(image: np.ndarray) -> float:
    """Fraction of texels within 0.15 of pure 0 or pure 1, on the mean channel.

    Metalness is physically a bit: a texel is metal or it is not, and the values
    in between only exist where a texel straddles a paint boundary. A map that is
    mostly mid-grey has not classified anything, it has hedged.
    """
    v = image.mean(axis=2)
    return round(float(np.mean((v < 0.15) | (v > 0.85))), 4)


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #


def evaluate(name: str, variant: str, folder: Path) -> dict:
    stem = name.replace("/", "_")
    source_srgb = read(folder / f"{stem}.source.png")
    source_linear = srgb_to_linear(source_srgb)

    def load(kind):
        path = folder / f"{stem}.{variant}.{kind}.png"
        return read(path) if path.exists() else None

    net_albedo_srgb = load("basecolor")
    net_normal = load("normal")
    net_roughness = load("roughness")
    net_metallic = load("metallic")

    flat_normal = np.zeros_like(source_srgb)
    flat_normal[..., 2] = 1.0

    shape1 = source_srgb[..., :1].shape

    variants = {
        "baseline": (
            source_linear,
            flat_normal,
            np.full(shape1, BASELINE_ROUGHNESS),
            np.full(shape1, BASELINE_METALLIC),
        )
    }

    if net_albedo_srgb is not None:
        albedo = srgb_to_linear(net_albedo_srgb)
        variants["albedo"] = (
            albedo,
            flat_normal,
            np.full(shape1, BASELINE_ROUGHNESS),
            np.full(shape1, BASELINE_METALLIC),
        )
        corrected = retint(source_linear, albedo)
        if net_normal is not None:
            variants["retinted+normal"] = (
                corrected,
                decode_normal(net_normal),
                np.full(shape1, BASELINE_ROUGHNESS),
                np.full(shape1, BASELINE_METALLIC),
            )
        if net_normal is not None:
            variants["albedo+normal"] = (
                albedo,
                decode_normal(net_normal),
                np.full(shape1, BASELINE_ROUGHNESS),
                np.full(shape1, BASELINE_METALLIC),
            )
        if net_normal is not None and net_roughness is not None:
            variants["albedo+normal+roughness"] = (
                albedo,
                decode_normal(net_normal),
                net_roughness.mean(axis=2, keepdims=True),
                np.full(shape1, BASELINE_METALLIC),
            )
        if net_normal is not None and net_roughness is not None and net_metallic is not None:
            variants["full"] = (
                albedo,
                decode_normal(net_normal),
                net_roughness.mean(axis=2, keepdims=True),
                net_metallic.mean(axis=2, keepdims=True),
            )

    result = {"name": name, "variant": variant, "size": list(source_srgb.shape[:2]), "relight": {}}

    for label, (albedo, normal, roughness, metallic) in variants.items():
        render, fit = fit_and_render(source_linear, albedo, normal, roughness, metallic)
        entry = compare(render, source_srgb)
        entry["light"] = fit
        result["relight"][label] = entry
        Image.fromarray(
            (linear_to_srgb(render) * 255).round().astype(np.uint8)
        ).save(folder / f"{stem}.{variant}.relit-{label.replace('+', '-')}.png")

    #
    # The headline. See the header: the baseline is zero by construction, so what
    # is worth reporting is how much of the de-lighting the other channels put
    # back. Per-channel figures use the same denominator, so they add up to the
    # total and can be read against each other.
    #
    stripped = result["relight"]["albedo"]["rmse8"]
    if stripped > 1e-9:
        def share(before, after):
            a = result["relight"].get(before)
            b = result["relight"].get(after)
            if a is None or b is None:
                return None
            return round((a["rmse8"] - b["rmse8"]) / stripped, 4)

        result["recovery"] = share("albedo", "full") or 0.0
        result["recovery_by_channel"] = {
            "normal": share("albedo", "albedo+normal"),
            "roughness": share("albedo+normal", "albedo+normal+roughness"),
            "metallic": share("albedo+normal+roughness", "full"),
        }
    else:
        result["recovery"] = 0.0
        result["recovery_by_channel"] = {}

    maps = {}
    if net_albedo_srgb is not None:
        maps["basecolor"] = channel_stats(net_albedo_srgb)
        maps["retinted"] = channel_stats(
            linear_to_srgb(retint(source_linear, srgb_to_linear(net_albedo_srgb)))
        )
        # How far the de-lighting moved the hue. A de-lighter that turns a brown
        # wall grey has removed something, and this says how much.
        maps["basecolor"]["source_mean"] = [round(float(v), 4) for v in source_srgb.mean(axis=(0, 1))]
    if net_normal is not None:
        maps["normal"] = channel_stats(net_normal)
        n = decode_normal(net_normal)
        # 0 is a flat map; the units are degrees of average tilt off the surface.
        maps["normal"]["mean_tilt_deg"] = round(
            float(np.degrees(np.mean(np.arccos(np.clip(n[..., 2], -1, 1))))), 3
        )
    if net_roughness is not None:
        maps["roughness"] = channel_stats(net_roughness)
    if net_metallic is not None:
        maps["metallic"] = channel_stats(net_metallic)
        maps["metallic"]["bimodality"] = bimodality(net_metallic)
    result["maps"] = maps

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Round-trip error for inferred material maps")
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seams", action="store_true", help="Also measure edge continuity")
    args = parser.parse_args()

    entries = json.loads(args.manifest.read_text(encoding="utf-8"))["textures"]

    results = []
    for spec in entries:
        variant = spec.get("variant", "wrap")
        stem = spec["name"].replace("/", "_")
        if not (args.dir / f"{stem}.{variant}.basecolor.png").exists():
            print(f"skip {spec['name']} [{variant}] -- nothing generated")
            continue

        result = evaluate(spec["name"], variant, args.dir)
        result["kind"] = spec.get("kind")
        result["wraps"] = spec.get("wraps", False)

        if args.seams and spec.get("wraps"):
            result["seam8"] = {
                "source": seam(read(args.dir / f"{stem}.source.png")),
                **{
                    kind: seam(read(args.dir / f"{stem}.{variant}.{kind}.png"))
                    for kind in ("basecolor", "normal", "roughness", "metallic")
                    if (args.dir / f"{stem}.{variant}.{kind}.png").exists()
                },
            }

        results.append(result)
        r = result["relight"]
        print(
            f"{spec['name']:26s} [{variant:6s}] "
            f"albedo {r['albedo']['rmse8']:7.3f} -> full {r['full']['rmse8']:7.3f}  "
            f"recovery {result['recovery']:+6.1%}  ssim {r['full']['ssim']:.3f}",
            flush=True,
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
