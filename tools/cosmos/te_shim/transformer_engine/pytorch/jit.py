"""See `transformer_engine/pytorch/module/__init__.py` -- import-time only.

Copyright (C) 2026 queep-3-arena contributors

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. See LICENSE.
"""


def no_torch_dynamo(recursive: bool = True):
    """Upstream this asks Dynamo not to trace into the wrapped function.

    Nothing here is compiled, so the honest stand-in is the identity decorator
    rather than something that pretends to do the marking.
    """

    def decorator(fn):
        return fn

    return decorator
