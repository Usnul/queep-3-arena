"""See `transformer_engine/pytorch/module/__init__.py` -- import-time only.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

from .base import TransformerEngineBaseModule


class Linear(TransformerEngineBaseModule):
    """Refuses to be built. The autoregressive tree is not on this pipeline's path."""

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            "transformer_engine.pytorch.module.linear.Linear is a stub "
            "(tools/cosmos/te_shim); the autoregressive path needs the real "
            "Transformer Engine"
        )
