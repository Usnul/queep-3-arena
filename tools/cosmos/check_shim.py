"""Check the Transformer Engine shim against independent restatements of the same maths.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

The real Transformer Engine cannot be installed here, so there is nothing to
differential-test against and this is the next best thing: each of the three
shimmed pieces is checked against a *property* of what it is supposed to be,
written a different way from the implementation.

    python tools/cosmos/check_shim.py
"""

import math
import sys

import torch

sys.path.insert(0, "tools/cosmos/te_shim")

import transformer_engine as te  # noqa: E402
from transformer_engine.pytorch.attention import (  # noqa: E402
    DotProductAttention,
    apply_rotary_pos_emb,
)

torch.manual_seed(20260826)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# ---- RMSNorm ----------------------------------------------------------------

norm = te.pytorch.RMSNorm(64, eps=1e-6, device="cpu")
with torch.no_grad():
    norm.weight.copy_(torch.rand(64) * 2)

x = torch.randn(7, 3, 64)
got = norm(x)

# Restated from the definition, elementwise, with no tensor tricks.
want = torch.empty_like(x)
for i in range(x.shape[0]):
    for j in range(x.shape[1]):
        row = x[i, j]
        rms = math.sqrt(float((row * row).mean()) + 1e-6)
        want[i, j] = row / rms * norm.weight
check("RMSNorm matches its definition", torch.allclose(got, want, atol=1e-5),
      f"max |d| = {(got - want).abs().max():.2e}")

# A row scaled by k normalises to the same thing: that is the whole point of RMS.
check("RMSNorm is scale invariant",
      torch.allclose(norm(x * 5.0), got, atol=1e-4))
check("RMSNorm parameter is named 'weight'",
      [n for n, _ in norm.named_parameters()] == ["weight"])

# ---- apply_rotary_pos_emb ---------------------------------------------------

S, B, H, D = 11, 2, 3, 16
t = torch.randn(S, B, H, D)
angles = torch.randn(S, 1, 1, D // 2).repeat(1, 1, 1, 2)  # the [block, block] layout Cosmos uses

out = apply_rotary_pos_emb(t, angles, tensor_format="sbhd")

# A rotation is norm preserving, per (i, i + D/2) pair and therefore overall.
check("rotary embedding preserves vector norm",
      torch.allclose(t.norm(dim=-1), out.norm(dim=-1), atol=1e-5),
      f"max |d| = {(t.norm(dim=-1) - out.norm(dim=-1)).abs().max():.2e}")

# Zero angle is the identity.
check("rotary embedding at angle 0 is the identity",
      torch.allclose(apply_rotary_pos_emb(t, torch.zeros(S, 1, 1, D)), t, atol=1e-6))

# Composition: rotating by a then by b is rotating by a + b.
a = torch.randn(S, 1, 1, D // 2).repeat(1, 1, 1, 2)
b = torch.randn(S, 1, 1, D // 2).repeat(1, 1, 1, 2)
check("rotary embedding composes additively",
      torch.allclose(
          apply_rotary_pos_emb(apply_rotary_pos_emb(t, a), b),
          apply_rotary_pos_emb(t, a + b),
          atol=1e-5,
      ))

# Pair (i, i + D/2) rotates as a 2-vector by that channel's angle.
i, s, bb, h = 3, 4, 1, 2
th = float(angles[s, 0, 0, i])
x0, x1 = float(t[s, bb, h, i]), float(t[s, bb, h, i + D // 2])
check("rotary embedding rotates the contiguous half-split pair",
      abs(float(out[s, bb, h, i]) - (x0 * math.cos(th) - x1 * math.sin(th))) < 1e-5
      and abs(float(out[s, bb, h, i + D // 2]) - (x1 * math.cos(th) + x0 * math.sin(th))) < 1e-5)

# bshd is sbhd with the first two axes swapped, and must agree.
check("rotary embedding agrees between sbhd and bshd",
      torch.allclose(apply_rotary_pos_emb(t.transpose(0, 1), angles, tensor_format="bshd"),
                     out.transpose(0, 1), atol=1e-6))

# Partial rotation leaves the tail alone.
half = torch.randn(S, 1, 1, D // 2)
check("rotary embedding passes untouched channels through",
      torch.allclose(apply_rotary_pos_emb(t, half)[..., D // 2:], t[..., D // 2:], atol=0))

# ---- DotProductAttention ----------------------------------------------------

attn = DotProductAttention(H, D, qkv_format="sbhd")
q, k, v = (torch.randn(S, B, H, D) for _ in range(3))
got = attn(q, k, v)

# Restated as an explicit softmax over scores, per batch and head.
want = torch.empty(S, B, H * D)
for bi in range(B):
    for hi in range(H):
        qs, ks, vs = q[:, bi, hi], k[:, bi, hi], v[:, bi, hi]
        scores = (qs @ ks.T) / math.sqrt(D)
        want[:, bi, hi * D:(hi + 1) * D] = torch.softmax(scores, dim=-1) @ vs
check("attention matches an explicit softmax", torch.allclose(got, want, atol=1e-5),
      f"max |d| = {(got - want).abs().max():.2e}")
check("attention returns merged heads", tuple(got.shape) == (S, B, H * D), str(tuple(got.shape)))

attn_b = DotProductAttention(H, D, qkv_format="bshd")
check("attention agrees between sbhd and bshd",
      torch.allclose(attn_b(q.transpose(0, 1), k.transpose(0, 1), v.transpose(0, 1)),
                     got.transpose(0, 1), atol=1e-5))

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all shim checks passed")
