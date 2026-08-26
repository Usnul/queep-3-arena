"""A stand-in for NVIDIA Transformer Engine, big enough for Cosmos inference.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

Cosmos-Predict1 states that it runs on Linux only, and the reason is almost
entirely this package: `transformer-engine[pytorch]==1.12.0` builds against CUDA
with a toolchain that has no Windows equivalent. The machine this port is
developed on is Windows with an RTX 4090, so either the pilot moves to a VM or
the dependency is met some other way.

It is a *small* dependency, which is what makes the other way reasonable. Across
`cosmos_predict1/diffusion` -- the whole of the inference path the diffusion
renderer takes -- Transformer Engine is reached for exactly three times:

    cosmos_predict1/diffusion/module/attention.py:20   import transformer_engine as te
    cosmos_predict1/diffusion/module/attention.py:24   DotProductAttention, apply_rotary_pos_emb
    cosmos_predict1/diffusion/module/attention.py:131  te.pytorch.RMSNorm(channels, eps=1e-6)

Nothing else in that tree names it. So this package supplies those three, each
written from its mathematical definition rather than copied -- Transformer
Engine is Apache-2.0, which does not travel into a GPLv2 tree -- and the Cosmos
source is used exactly as it was fetched, with no patch of any kind.

**What is given up.** The fused CUDA kernels, and with them some speed and the
FP8 paths this pilot does not use. What is not given up is numerics: all three
are exact restatements up to floating-point association, and where there is a
choice this file takes the more accurate one (fp32 accumulation) rather than the
faster. A pilot that is 30% slower and correct is the useful one; a pilot that is
quietly wrong is worse than no pilot.

Put this directory on `PYTHONPATH` ahead of anything else and `import
transformer_engine` finds it.
"""

from . import pytorch  # noqa: F401  -- `te.pytorch.RMSNorm` needs the attribute

__version__ = "1.12.0+queep-shim"
