"""`transformer_engine.pytorch` -- the RMSNorm Cosmos normalises its Q, K and V with.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

import torch
from torch import nn

from . import attention  # noqa: F401
from .attention import DotProductAttention, apply_rotary_pos_emb  # noqa: F401


class RMSNorm(nn.Module):
    """Root-mean-square layer normalisation, with Transformer Engine's parameter shape.

    `y = weight * x / sqrt(mean(x^2) + eps)`, over the last axis.

    Two details are load-bearing rather than stylistic:

    - **The parameter is called `weight`.** Cosmos builds these inside
      `nn.Sequential`s and then loads a 7B checkpoint over the result by name, so
      a parameter called anything else does not fail -- it arrives as a missing
      key, keeps its initialised value of all-ones, and the model runs with its
      QK normalisation silently disabled.
    - **The mean square is accumulated in fp32.** The module runs at bf16, where
      the running sum over a 128-wide head loses enough precision to shift the
      norm by a visible fraction of a percent. Transformer Engine's kernel
      upcasts for the same reason.

    `zero_centered_gamma` is not implemented because Cosmos does not ask for it;
    it defaults off upstream, where it would make the stored weight an offset
    from one rather than a multiplier.
    """

    def __init__(
        self,
        hidden_size: int,
        eps: float = 1e-5,
        sequence_parallel: bool = False,
        params_dtype: torch.dtype = None,
        zero_centered_gamma: bool = False,
        device: str = "cuda",
        **kwargs,
    ) -> None:
        super().__init__()

        if zero_centered_gamma:
            raise NotImplementedError("zero_centered_gamma is not implemented")

        self.eps = eps
        self.zero_centered_gamma = zero_centered_gamma
        self.weight = nn.Parameter(
            torch.ones(hidden_size, dtype=params_dtype, device=device)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        f = x.float()
        normed = f * torch.rsqrt(f.pow(2).mean(-1, keepdim=True) + self.eps)
        return (normed * self.weight.float()).to(x.dtype)


class LayerNorm(nn.LayerNorm):
    """Present so an incidental import resolves; Cosmos's diffusion path never builds one."""


class TransformerLayer(nn.Module):
    """Import-time only -- `autoregressive.training.networks.transformer` subclasses it.

    Subclassing happens at import; construction does not. See
    `transformer_engine/pytorch/module/__init__.py` for why that whole tree is
    imported by a pipeline that never uses it.
    """

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            "transformer_engine.pytorch.TransformerLayer is a stub "
            "(tools/cosmos/te_shim); the autoregressive path needs the real "
            "Transformer Engine"
        )


__all__ = ["RMSNorm", "LayerNorm", "DotProductAttention", "apply_rotary_pos_emb", "attention"]


def __getattr__(name):
    """Anything not listed above is reported as *absent*, not as broken.

    `megatron.core` is on this path too, and it reaches for a much larger slice
    of Transformer Engine than Cosmos does -- `te.pytorch.Linear`,
    `TENorm`, the fused RoPE entry points. Every one of those reaches is wrapped
    in `try: ... except ImportError`, because the case it is written for is a
    Megatron install with no Transformer Engine at all.

    So that is the answer to give. An `AttributeError` -- what a module raises by
    default -- escapes those guards and takes the whole import down; an
    `ImportError` is caught, the feature is marked unavailable, and Megatron
    falls back to the pure-PyTorch path it keeps for exactly this. The shim is
    not pretending to be complete; it is saying which parts it is not.
    """
    raise ImportError(
        f"transformer_engine.pytorch.{name} is not provided by this shim "
        f"(tools/cosmos/te_shim); it covers only what Cosmos inference calls"
    )
