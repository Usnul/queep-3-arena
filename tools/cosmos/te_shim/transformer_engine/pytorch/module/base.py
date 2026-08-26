"""See `transformer_engine/pytorch/module/__init__.py` -- import-time only.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

from torch import nn


class TransformerEngineBaseModule(nn.Module):
    """Marker base class. `autoregressive/utils/parallel.py` uses it for `isinstance`."""
