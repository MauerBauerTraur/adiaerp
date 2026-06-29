"""Shared pytest fixtures.

Sets a deterministic shared secret BEFORE importing the app so the
`get_shared_secret` lru_cache picks it up. The cache is module-scope; once
`config.py` is imported the env var is frozen, so we set it in conftest.
"""
from __future__ import annotations

import os

os.environ.setdefault("FORECASTER_SHARED_SECRET", "test-shared-secret-do-not-use")
