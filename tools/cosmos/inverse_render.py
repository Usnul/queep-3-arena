"""Run Cosmos DiffusionRenderer's inverse pass over Q3 textures.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

    python tools/cosmos/inverse_render.py --manifest tools/cosmos/pilot.json \
        --out assets/generated/pilot

The model is `nvidia/Diffusion_Renderer_Inverse_Cosmos_7B` under the NVIDIA Open
Model License, which permits commercial use and permits the outputs to be used
and distributed. `ASSETS.md` records the licence and the pinned revision. Nothing
it produces is committed.

# 1280x704 is not a suggestion

The model card says the input resolution is 704x1280 and the DiT will accept
anything up to 1920 on a side, so the obvious first try is to hand it a square
texture at whatever size is convenient. That produces garbage, and it produces it
*quietly*: a 512 stone wall at 704x704 comes back as a black image with faint
mortar lines, and the same wall tiled to 1536x1536 comes back as a saturated
orange blur. The tell is the roughness pass, which is a scalar quantity and must
be achromatic -- at 1536 square it came back (234, 109, 39).

Measured on `gothic_block/blocks10`, basecolor and roughness, 15 steps, seed 1000:

| framing        | basecolor mean      | roughness mean       | verdict          |
|----------------|---------------------|----------------------|------------------|
| 704x704        | (5, 6, 6)           | (0.3, 0.2, 0.3)      | black            |
| 1280x1280      | (188, 127, 52)      | (115, 66, 33)        | orange, coloured |
| 1536x1536 (3x3)| (231, 91, 7)        | (234, 109, 39)       | orange, coloured |
| **1280x704**   | (79, 78, 73)        | (82.5, 83.4, 83.7)   | structured, grey |

The same checkpoint on the repo's own 1280x704 example photographs is entirely
well behaved, so this is the aspect ratio and not the environment. Everything
below therefore presents every texture inside one 1280x704 frame, and the only
question is how the texture is laid out in it.

# Three framings, because which one is right is a measurement

- **`wrap`** -- tile the texture across the frame at its own pixel scale and keep
  one interior copy. No resampling and no distortion at all: the network sees the
  artwork exactly as painted, just more of it. It also happens to be the answer to
  the tiling risk, because every texel of the kept copy has real neighbourhood on
  all four sides.
- **`mirror`** -- the same, with alternate copies flipped. For a weapon or a
  character skin, which does not wrap: mirroring gives continuous context without
  the hard seams a plain repeat would invent.
- **`fit`** -- resample the texture to fill the frame, anisotropically. One copy,
  maximum apparent resolution, at the cost of stretching it by 2.5 to 1.

`wrap` and `mirror` are the same code with one flag; `fit` is kept as the control
so the choice between them is made by `roundtrip.py` rather than asserted here.

# One more thing this does that the upstream CLI does not

It writes PNG. `inference_inverse_renderer.py` saves each G-buffer frame as JPEG
at quality 5. For a preview that is fine; for a normal map that is going to be
sampled per texel it is not, and the whole point of the round trip is to find out
what the *network* got wrong rather than what the encoder did to it.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
COSMOS = REPO / ".refs" / "cosmos-diffusion-renderer"
sys.path.insert(0, str(REPO / "tools" / "cosmos" / "te_shim"))
sys.path.insert(0, str(COSMOS))

from cosmos_predict1.diffusion.inference.diffusion_renderer_pipeline import (  # noqa: E402
    DiffusionRendererPipeline,
)
from cosmos_predict1.diffusion.inference.diffusion_renderer_utils.rendering_utils import (  # noqa: E402
    GBUFFER_INDEX_MAPPING,
)

#: The resolution the model was trained at, and -- see the header -- the only one
#: it behaves at. (width, height).
FRAME = (1280, 704)


def load_rgb(path: Path) -> Image.Image:
    """Read a Q3 texture as RGB.

    Alpha is dropped rather than composited. Every alpha-tested Q3 texture paints
    a full colour underneath its cutout -- the cutout is what the *renderer* does
    with the image, not a hole in the artwork -- so compositing over a background
    would push an invented colour into the network and get it back as albedo.
    """
    image = Image.open(path)
    return image.convert("RGB")


def lay_out(image: Image.Image, mirror: bool) -> Image.Image:
    """Repeat the texture across a canvas comfortably larger than the frame.

    Five copies each way is more than any frame-and-offset needs and costs
    nothing; the caller crops what it wants out of the middle of it.

    With `mirror`, every other copy is flipped, so adjacent copies meet at a
    reflection rather than at a jump. That is what makes this usable on a weapon
    skin: the texture does not wrap, so a plain repeat would invent a hard edge
    down the middle of the frame and the network would read it as geometry.
    """
    w, h = image.size
    flips = {
        (0, 0): image,
        (1, 0): image.transpose(Image.FLIP_LEFT_RIGHT) if mirror else image,
        (0, 1): image.transpose(Image.FLIP_TOP_BOTTOM) if mirror else image,
        (1, 1): image.transpose(Image.ROTATE_180) if mirror else image,
    }

    canvas = Image.new("RGB", (w * 5, h * 5))
    for y in range(5):
        for x in range(5):
            canvas.paste(flips[(x % 2, y % 2)], (x * w, y * h))
    return canvas


def to_batch(image: Image.Image, context_index: int) -> dict:
    """The data_batch that generate_samples_from_batch expects, for one image.

    Built here rather than through `VideoFramesDataset` because that class reads
    a directory, centre-crops to a fixed resolution and carries a chunking scheme
    for video; one texture at its own size is none of those things.

    The T5 fields are zeros with one live mask entry. The renderer is configured
    `has_text_input=False` and its `_load_text_encoder_model` is a no-op, but the
    conditioner still reads the keys, and a mask that is entirely zero divides by
    zero inside the attention.
    """
    array = np.asarray(image, dtype=np.float32) / 255.0
    rgb = torch.from_numpy(array).permute(2, 0, 1)  # [C, H, W]
    rgb = rgb * 2.0 - 1.0
    rgb = rgb.unsqueeze(1)  # [C, T=1, H, W]

    height, width = image.height, image.width

    mask = torch.zeros(512)
    mask[0] = 1

    return {
        "rgb": rgb.unsqueeze(0),
        "context_index": torch.LongTensor([[context_index]]),
        "t5_text_embeddings": torch.zeros(512, 1024).unsqueeze(0),
        "t5_text_mask": mask.unsqueeze(0),
        "padding_mask": torch.zeros(1, height, width).unsqueeze(0),
        "fps": torch.tensor([24.0]),
        "num_frames": torch.tensor([1.0]),
        "image_size": torch.from_numpy(np.asarray([height, width])).unsqueeze(0),
        "is_preprocessed": True,
    }


def infer(pipeline, image: Image.Image, gbuffer: str, seed: int) -> Image.Image:
    batch = to_batch(image, GBUFFER_INDEX_MAPPING[gbuffer])
    frames = pipeline.generate_video(
        data_batch=batch,
        # Only for normals, and only because the model emits a vector whose
        # length carries its own confidence: the post-process rescales to unit
        # length where it is confident and leaves the short ones alone.
        normalize_normal=(gbuffer == "normal"),
        seed=seed,
    )
    return Image.fromarray(frames[0])


def frame_texture(original: Image.Image, variant: str):
    """Lay one texture into the model frame, and say how to read the result back.

    Returns the framed image and a function that takes the model output and
    returns it at the texture's own size.
    """
    fw, fh = FRAME

    if variant == "fit":
        framed = original.resize(FRAME, Image.LANCZOS)
        return framed, lambda out: out.resize(original.size, Image.LANCZOS)

    if variant not in ("wrap", "mirror"):
        raise SystemExit(f"unknown variant '{variant}'")

    # At its own pixel scale, or shrunk if one copy does not fit in the frame.
    # Nothing in the OA set is over 512, so the shrink is a guard rather than a
    # path anything currently takes.
    scale = min(1.0, fw / original.width, fh / original.height)
    scaled = (
        original
        if scale == 1.0
        else original.resize(
            (max(1, int(original.width * scale)), max(1, int(original.height * scale))),
            Image.LANCZOS,
        )
    )
    w, h = scaled.size

    canvas = lay_out(scaled, mirror=(variant == "mirror"))

    # Put one whole copy in the middle of the frame, so it has as much context on
    # every side as the frame has room for. The copy at canvas (2w, 2h) is an
    # unflipped original in both layouts -- 2 is even -- so the window is placed
    # to bring that copy to (inset_x, inset_y) in the frame.
    inset_x, inset_y = (fw - w) // 2, (fh - h) // 2
    window = (2 * w - inset_x, 2 * h - inset_y)
    framed = canvas.crop((window[0], window[1], window[0] + fw, window[1] + fh))

    def recover(out: Image.Image) -> Image.Image:
        kept = out.crop((inset_x, inset_y, inset_x + w, inset_y + h))
        return kept if scale == 1.0 else kept.resize(original.size, Image.LANCZOS)

    return framed, recover


def read_manifest(path: Path) -> list[dict]:
    """Accept either manifest shape.

    `tools/cosmos/pilot.json` is hand-written and names eight textures twice each
    to compare framings; `assets/generated/manifest.json` is emitted by
    `tools/material-maps.ts` and names every image once. The second is the shape
    that matters and the first is kept because it is what D-090 and D-092 were
    measured with, and a measurement whose input cannot be re-run is an anecdote.
    """
    doc = json.loads(path.read_text(encoding="utf-8"))

    if "jobs" in doc:
        return [
            {
                "name": job["image"],
                "stem": job["stem"],
                "source": job["source"],
                "variant": job["framing"],
                # A surface the table refuses a normal map does not need one
                # inferred. Twelve of 183, all of them effect artwork.
                "skip": ["normal"] if job.get("normal") == "drop" else [],
            }
            for job in doc["jobs"]
        ]

    return [
        {
            "name": t["name"],
            "stem": t["name"].replace("/", "_"),
            "source": t["source"],
            "variant": t.get("variant", "wrap"),
            "skip": [],
        }
        for t in doc["textures"]
    ]


def run_texture(pipeline, spec: dict, out_dir: Path, passes, seed: int, resume: bool) -> int:
    source = REPO / spec["source"]
    name = spec["stem"]
    variant = spec["variant"]
    wanted = [p for p in passes if p not in spec["skip"]]

    out_dir.mkdir(parents=True, exist_ok=True)
    todo = [
        p for p in wanted if not (resume and (out_dir / f"{name}.{variant}.{p}.png").exists())
    ]
    if not todo:
        return 0

    original = load_rgb(source)
    framed, recover = frame_texture(original, variant)

    original.save(out_dir / f"{name}.source.png")

    for gbuffer in todo:
        result = recover(infer(pipeline, framed, gbuffer, seed))
        result.save(out_dir / f"{name}.{variant}.{gbuffer}.png")

    print(f"  {spec['name']} [{variant}] {' '.join(todo)}", flush=True)
    return len(todo)


def main() -> None:
    parser = argparse.ArgumentParser(description="Cosmos inverse rendering over Q3 textures")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--checkpoint-dir", type=Path, default=REPO / "assets" / "ml" / "checkpoints"
    )
    parser.add_argument("--num-steps", type=int, default=15)
    parser.add_argument("--seed", type=int, default=1000)
    parser.add_argument("--only", type=str, default=None, help="Run manifest entries whose name contains this")
    parser.add_argument("--variant", type=str, default=None, help="Run only this framing")
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Re-infer passes whose output is already on disk (default is to skip them)",
    )
    parser.add_argument(
        "--passes",
        nargs="+",
        default=["basecolor", "normal", "roughness", "metallic"],
        help="Depth is omitted by default: this port has geometry already",
    )
    args = parser.parse_args()

    entries = read_manifest(args.manifest)
    if args.only is not None:
        entries = [e for e in entries if args.only in e["name"]]
    if args.variant is not None:
        entries = [e for e in entries if e["variant"] == args.variant]
    if not entries:
        raise SystemExit("no manifest entry matched")

    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    # `load_model_by_config` resolves the experiment config by a path relative to
    # the working directory, so Cosmos only loads from its own root. Every path
    # this script holds is already absolute, so the move costs nothing.
    args.out = args.out.resolve()
    args.checkpoint_dir = args.checkpoint_dir.resolve()
    os.chdir(COSMOS)

    pipeline = DiffusionRendererPipeline(
        checkpoint_dir=str(args.checkpoint_dir),
        checkpoint_name="Diffusion_Renderer_Inverse_Cosmos_7B",
        guidance=0.0,
        num_steps=args.num_steps,
        height=FRAME[1],
        width=FRAME[0],
        fps=24,
        num_video_frames=1,
        seed=args.seed,
    )

    done = 0
    for i, spec in enumerate(entries):
        n = run_texture(pipeline, spec, args.out, args.passes, args.seed, not args.no_resume)
        done += n
        if n:
            print(f"    [{i + 1}/{len(entries)}] {done} passes run", flush=True)
        torch.cuda.empty_cache()

    print(f"{done} passes over {len(entries)} images", flush=True)


if __name__ == "__main__":
    main()
