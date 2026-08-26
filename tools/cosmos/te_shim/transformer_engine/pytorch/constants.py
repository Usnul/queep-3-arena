"""See `transformer_engine/pytorch/module/__init__.py` -- import-time only.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

import torch

#: The bias kinds Transformer Engine's attention understands. The diffusion path
#: only ever passes "no_bias"; the list is here so an autoregressive import that
#: reads it at module scope resolves.
AttnBiasTypes = ["no_bias", "pre_scale_bias", "post_scale_bias", "alibi"]

AttnMaskTypes = ["no_mask", "padding", "causal", "padding_causal", "arbitrary"]

AttnTypes = ["self", "cross"]

LayerTypes = ["encoder", "decoder"]

TE_DType = {
    torch.uint8: torch.uint8,
    torch.int32: torch.int32,
    torch.float32: torch.float32,
    torch.half: torch.half,
    torch.bfloat16: torch.bfloat16,
}
