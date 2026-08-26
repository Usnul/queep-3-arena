"""`apply_rotary_pos_emb` and `DotProductAttention`, restated in plain PyTorch.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

from typing import Optional

import torch
import torch.nn.functional as F
from torch import nn


def _rotate_half(x: torch.Tensor) -> torch.Tensor:
    """The GPT-NeoX half-split rotation: (x1, x2) -> (-x2, x1).

    Which half-split is meant is not a free choice -- it has to match the layout
    the *frequencies* were built in, or every rotation pairs the wrong two
    channels and the position signal turns into noise that still trains-looking
    output out of the model.

    Cosmos builds its frequencies in `VideoRopePosition3DEmb.generate_embeddings`
    as `cat([t, h, w] * 2, dim=-1)` -- three axis blocks, then the same three
    again. That is the contiguous-halves convention: channel `i` pairs with
    channel `i + d/2`, and both carry the same angle. So the rotation splits the
    tensor in half and swaps, rather than pairing adjacent channels.
    """
    x1, x2 = torch.chunk(x, 2, dim=-1)
    return torch.cat((-x2, x1), dim=-1)


def apply_rotary_pos_emb(
    t: torch.Tensor,
    freqs: torch.Tensor,
    tensor_format: str = "sbhd",
    fused: bool = False,
    cu_seqlens: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    """Rotate the leading `freqs.shape[-1]` channels of `t` by the angles in `freqs`.

    `t` is `[s, b, h, d]` for `sbhd` or `[b, s, h, d]` for `bshd`; `freqs` is
    `[s, 1, 1, d2]` with `d2 <= d` and holds *angles*, not their cosines. The
    channels past `d2` pass through untouched, which is what makes a partial
    rotary embedding possible -- Cosmos happens to rotate all of them.

    `fused` is accepted and ignored: it selects a CUDA kernel upstream and says
    nothing about the result. `cu_seqlens` belongs to the `thd` ragged-batch
    format, which nothing on this path uses.

    The rotation is computed in fp32 and cast back, because `freqs` arrives as
    fp32 while `t` is bf16, and taking cosines at bf16 would quantise the angle
    to about three significant digits.
    """
    if tensor_format not in ("sbhd", "bshd"):
        raise ValueError(f"Unsupported tensor format '{tensor_format}'")
    if cu_seqlens is not None:
        raise NotImplementedError("ragged 'thd' batches are not used by this pipeline")

    # Work in sbhd so `freqs` broadcasts against the sequence axis either way.
    x = t.transpose(0, 1) if tensor_format == "bshd" else t

    rot = freqs.shape[-1]
    if rot > x.shape[-1]:
        raise ValueError(f"rotary width {rot} exceeds head dimension {x.shape[-1]}")

    x_rot = x[..., :rot].float()
    x_pass = x[..., rot:]

    angles = freqs[: x.shape[0]].float()
    cos = torch.cos(angles)
    sin = torch.sin(angles)

    rotated = (x_rot * cos + _rotate_half(x_rot) * sin).to(t.dtype)
    out = rotated if x_pass.shape[-1] == 0 else torch.cat((rotated, x_pass), dim=-1)

    return out.transpose(0, 1) if tensor_format == "bshd" else out


class DotProductAttention(nn.Module):
    """Unmasked, unbiased scaled dot-product attention with Transformer Engine's shape contract.

    Two things about the contract are worth stating, because both are silent if
    they are wrong. The heads are *not* the second axis -- `sbhd` and `bshd` both
    put them third -- and the return value has the heads already merged, so it is
    `[s, b, h*d]` rather than `[s, b, h, d]`. Cosmos feeds the result straight
    into a `Linear(inner_dim, query_dim)`, which would accept the unmerged shape
    and produce nonsense from it.

    The scale is left to `F.scaled_dot_product_attention`, whose default is
    `1/sqrt(head_dim)` -- the same as Transformer Engine's default
    `softmax_scale`. `attention_dropout` is stored and applied so the signature
    is honest, though inference passes zero.
    """

    def __init__(
        self,
        num_attention_heads: int,
        kv_channels: int,
        num_gqa_groups: Optional[int] = None,
        attention_dropout: float = 0.0,
        qkv_format: str = "sbhd",
        attn_mask_type: str = "no_mask",
        tp_size: int = 1,
        tp_group=None,
        sequence_parallel: bool = False,
        **kwargs,
    ) -> None:
        super().__init__()

        if attn_mask_type != "no_mask":
            raise NotImplementedError(f"attn_mask_type '{attn_mask_type}' is not implemented")
        if qkv_format not in ("sbhd", "bshd"):
            raise ValueError(f"Unsupported qkv format '{qkv_format}'")
        if tp_size != 1:
            raise NotImplementedError("tensor parallelism is not implemented")
        if num_gqa_groups not in (None, num_attention_heads):
            raise NotImplementedError("grouped-query attention is not implemented")

        self.qkv_format = qkv_format
        self.num_attention_heads = num_attention_heads
        self.kv_channels = kv_channels
        self.attention_dropout = attention_dropout

        # Read by `GeneralDIT.disable_context_parallel`, which runs whether or
        # not context parallelism was ever enabled.
        self.cp_group = None
        self.cp_ranks = None

    def set_context_parallel_group(self, *args, **kwargs):
        raise NotImplementedError("context parallelism needs the real Transformer Engine")

    def forward(
        self,
        query_layer: torch.Tensor,
        key_layer: torch.Tensor,
        value_layer: torch.Tensor,
        core_attention_bias_type: str = "no_bias",
        core_attention_bias: Optional[torch.Tensor] = None,
        **kwargs,
    ) -> torch.Tensor:
        if core_attention_bias_type != "no_bias" or core_attention_bias is not None:
            raise NotImplementedError("attention bias is not implemented")

        # -> [b, h, s, d], which is what `scaled_dot_product_attention` wants.
        if self.qkv_format == "sbhd":
            q, k, v = (x.permute(1, 2, 0, 3) for x in (query_layer, key_layer, value_layer))
        else:
            q, k, v = (x.permute(0, 2, 1, 3) for x in (query_layer, key_layer, value_layer))

        out = F.scaled_dot_product_attention(
            q, k, v, dropout_p=self.attention_dropout if self.training else 0.0
        )

        b, h, s, d = out.shape
        if self.qkv_format == "sbhd":
            return out.permute(2, 0, 1, 3).reshape(s, b, h * d)
        return out.permute(0, 2, 1, 3).reshape(b, s, h * d)


# ---------------------------------------------------------------------------
# Import-time only. See `module/__init__.py` for why the autoregressive tree is
# imported at all. Each of these refuses to run rather than approximating.
# ---------------------------------------------------------------------------


class _SplitAlongDim:
    """Upstream: a fused autograd split of a packed QKV tensor."""

    def __init__(self, *args, **kwargs):
        raise NotImplementedError("_SplitAlongDim is a stub (tools/cosmos/te_shim)")

    @staticmethod
    def apply(*args, **kwargs):
        raise NotImplementedError("_SplitAlongDim is a stub (tools/cosmos/te_shim)")


def check_set_window_size(*args, **kwargs):
    """Upstream: validates a sliding-window attention span."""
    raise NotImplementedError("check_set_window_size is a stub (tools/cosmos/te_shim)")
