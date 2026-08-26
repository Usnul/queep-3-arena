"""Import-time stubs for the Transformer Engine surface Cosmos's *autoregressive* tree names.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

---

Nothing here is ever called. It exists because one unguarded import chain runs
through code this pipeline has no use for:

    world_generation_pipeline
      -> text2world_prompt_upsampler_inference   (a Pixtral VLM, never built)
        -> autoregressive.configs.base.model_config
          -> autoregressive.training.networks.transformer
            -> transformer_engine.pytorch.module.linear / .rmsnorm

`DiffusionRendererPipeline` subclasses `DiffusionText2WorldGenerationPipeline`,
so importing it drags the whole chain in even with the prompt upsampler
disabled. Rather than patch the fetched Cosmos tree -- which would have to be
re-applied every time it is fetched -- the names it reaches for are made to
exist and to fail loudly if anything ever actually constructs one.

That distinction matters: a stub that silently behaves like a linear layer would
turn "this path is not supported" into "this path produces wrong numbers".
"""

from .base import TransformerEngineBaseModule  # noqa: F401
from .linear import Linear  # noqa: F401
from .rmsnorm import RMSNorm, _RMSNorm  # noqa: F401
