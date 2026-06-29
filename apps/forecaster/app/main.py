"""FastAPI entry point for the Prophet sidecar.

Two endpoints:

  * `GET /healthz` — liveness + Prophet version. No auth.
  * `POST /predict` — batch forecast. Authenticated via the `secret` field
    in the body (NOT a header — the cron passes it as JSON so it shows up
    in audit logs only if a request body is logged, never in URL access
    logs).

The body schema is the source of truth for the Node side; mirror any change
in `apps/backend/src/workers/forecastRefreshCron.ts`.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from .config import verify_secret
from .forecast import DailyPoint, ForecastItem, forecast_batch

logger = logging.getLogger("forecaster")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="ADIA forecaster", version="0.1.0")


class DailyRow(BaseModel):
    date: str = Field(..., description="ISO date YYYY-MM-DD")
    qty: float = Field(..., ge=0)


class ForecastInputItem(BaseModel):
    location_id: int = Field(..., gt=0)
    product_id: int = Field(..., gt=0)
    sales_daily: list[DailyRow]
    current_qty: float | None = Field(default=None)


class PredictRequest(BaseModel):
    secret: str
    items: list[ForecastInputItem]
    horizon_days: int = Field(default=14, ge=1, le=30)

    @field_validator("items")
    @classmethod
    def cap_batch_size(cls, v: list[ForecastInputItem]) -> list[ForecastInputItem]:
        # Match the cron's 50-per-request batch contract; reject pathological
        # 10k-item requests that would hold the sidecar for 30 minutes.
        if len(v) > 100:
            raise ValueError("items: batch size must be <= 100")
        return v


class PredictResponse(BaseModel):
    forecasts: list[dict[str, Any]]


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    """Liveness probe — no auth. Returns Prophet version for diagnostics."""
    try:
        import prophet  # type: ignore[import-untyped]

        prophet_version = getattr(prophet, "__version__", "unknown")
    except Exception:  # noqa: BLE001
        prophet_version = "unavailable"
    return {"status": "ok", "prophet_version": prophet_version}


@app.post("/predict", response_model=PredictResponse)
def predict(payload: PredictRequest) -> PredictResponse:
    """Authenticated batch forecast.

    Auth: `payload.secret` must match `FORECASTER_SHARED_SECRET`. Failure is
    a flat 401 with no body detail (don't leak whether the secret was wrong
    vs. missing).
    """
    if not verify_secret(payload.secret):
        # Log the rejection but never log the supplied secret.
        logger.warning("predict: rejected — invalid shared secret")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="unauthorized",
        )

    items: list[ForecastItem] = []
    for raw in payload.items:
        points = [
            DailyPoint(ds=date.fromisoformat(d.date), y=float(d.qty))
            for d in raw.sales_daily
        ]
        items.append(
            ForecastItem(
                location_id=raw.location_id,
                product_id=raw.product_id,
                sales_daily=points,
                current_qty=raw.current_qty,
            )
        )

    logger.info("predict: batch_size=%d horizon=%d", len(items), payload.horizon_days)
    results = forecast_batch(items, horizon_days=payload.horizon_days)
    return PredictResponse(forecasts=results)
