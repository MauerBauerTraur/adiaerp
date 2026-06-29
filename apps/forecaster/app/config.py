"""Shared-secret authentication for the Prophet sidecar.

The sidecar runs inside the internal network only (compose / loopback), so the
auth model is intentionally minimal: every `/predict` request body carries a
`secret` field that must match the `FORECASTER_SHARED_SECRET` env value
(constant-time compared via `hmac.compare_digest`, i.e. the Python equivalent
of Node's `crypto.timingSafeEqual`).

If the env var is missing the sidecar refuses every authenticated request —
fail-closed by default.
"""
from __future__ import annotations

import hmac
import os
from functools import lru_cache


@lru_cache(maxsize=1)
def get_shared_secret() -> str:
    """Read the shared secret once. Returns '' when unset."""
    return os.environ.get("FORECASTER_SHARED_SECRET", "").strip()


def verify_secret(provided: str | None) -> bool:
    """Constant-time compare `provided` against the configured secret.

    Returns False when either side is empty — never let an unset env var
    become a wildcard.
    """
    expected = get_shared_secret()
    if expected == "":
        return False
    if not isinstance(provided, str) or provided == "":
        return False
    return hmac.compare_digest(expected.encode("utf-8"), provided.encode("utf-8"))
