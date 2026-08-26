"""See `transformer_engine/pytorch/module/__init__.py`.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.

Unlike its neighbours this one is real, because it is the same normalisation the
diffusion path uses and there is no reason to have two of it.
"""

from .. import RMSNorm

_RMSNorm = RMSNorm

__all__ = ["RMSNorm", "_RMSNorm"]
