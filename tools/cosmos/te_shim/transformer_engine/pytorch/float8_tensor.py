"""See `transformer_engine/pytorch/module/__init__.py` -- import-time only.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""

import torch


class Float8Tensor(torch.Tensor):
    """Marker type. Nothing on this pipeline's path is quantised to FP8.

    Left as a bare `torch.Tensor` subclass rather than a raising stub because the
    autoregressive tree uses it in `isinstance` checks at import time, and an
    `isinstance` against a class that refuses to be constructed is fine -- it
    simply never matches.
    """
