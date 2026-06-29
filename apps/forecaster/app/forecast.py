"""Prophet forecasting core (ADR-0010 §4).

Takes a list of `(location_id, product_id, daily_qty_series)` items and
returns the next-N-day forecast for each one, plus an `expected_stockout_date`
when a `current_qty` was supplied.

Decisions worth knowing:

  * **Minimum history = 30 days.** Prophet *can* fit on less, but the
    confidence intervals blow up and the seasonality components become
    noise. Spec §2.4 says "< 30 kun bo'lsa skip"; we return
    `{"insufficient_data": true}` for those items so the caller can record
    a clean skip instead of caching garbage.
  * **No Uzbek holidays in Faza-3.** ADR-0010 explicitly defers them to
    Faza-4; weekly seasonality (busy weekends) is enough for MVP.
  * **Stockout estimate uses the next-14-day mean.** A naive divide
    `current_qty / mean(yhat[next 14])` keeps the formula explainable to
    PM — Prophet's `yhat_lower` could be used for a "worst case" stockout
    in a later iteration.
  * **Per-item failure is isolated.** A NaN / divergent fit on one item
    must not poison the whole batch — we catch and return
    `{"failed": true, "error": ...}` so the cron can count it as one row's
    error and keep going.
"""
from __future__ import annotations

import logging
import math
import warnings
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from prophet import Prophet

logger = logging.getLogger(__name__)

# Prophet noisily warns about cmdstanpy version + plotly missing. We don't
# need them and they spam the log.
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

# Hide cmdstanpy's INFO logger — one line per fit is enough noise for the
# 1500-item batch.
logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
logging.getLogger("prophet").setLevel(logging.WARNING)

MIN_HISTORY_DAYS = 30
DEFAULT_HORIZON_DAYS = 14
STOCKOUT_LOOKAHEAD_DAYS = 14
EPSILON = 1e-6


@dataclass(frozen=True)
class DailyPoint:
    """One row of daily aggregated sales."""

    ds: date
    y: float


@dataclass(frozen=True)
class ForecastItem:
    """Input contract — see `app/main.py:PredictRequest`."""

    location_id: int
    product_id: int
    sales_daily: list[DailyPoint]
    current_qty: float | None


def _coerce_points(raw: list[dict[str, Any]]) -> list[DailyPoint]:
    """Parse `[{date, qty}, ...]` into typed `DailyPoint`s. Invalid rows are
    dropped (rather than raising) so a single garbage row from the cron does
    not poison a 1500-item batch."""
    out: list[DailyPoint] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        d_raw = row.get("date")
        q_raw = row.get("qty")
        if not isinstance(d_raw, str) or q_raw is None:
            continue
        try:
            parsed_date = datetime.fromisoformat(d_raw).date()
            qty = float(q_raw)
        except (TypeError, ValueError):
            continue
        if math.isnan(qty) or qty < 0:
            continue
        out.append(DailyPoint(ds=parsed_date, y=qty))
    # Prophet wants chronologically ordered, deduped by date.
    by_date: dict[date, float] = {}
    for p in out:
        by_date[p.ds] = p.y
    return [DailyPoint(ds=d, y=q) for d, q in sorted(by_date.items())]


def _fit_and_predict(points: list[DailyPoint], horizon_days: int) -> pd.DataFrame:
    """Fit Prophet on `points` and return the forecast frame for the next
    `horizon_days` days only (the historical fit rows are dropped)."""
    df = pd.DataFrame({"ds": [p.ds for p in points], "y": [p.y for p in points]})
    # Force ds to a real pandas Timestamp — Prophet rejects python date objects
    # in some versions.
    df["ds"] = pd.to_datetime(df["ds"])

    model = Prophet(
        # Weekly seasonality on (do'kon savdosi haftalik tsiklga ega).
        weekly_seasonality=True,
        # Yearly needs ~2y of history to be meaningful; we cap at 1y so a
        # 30-day series doesn't get a bogus annual component.
        yearly_seasonality=len(points) >= 365,
        daily_seasonality=False,
        # Uncertainty interval — 80% so `yhat_lower`/`yhat_upper` is wide
        # enough to be informative without being absurd.
        interval_width=0.8,
    )
    model.fit(df)

    future = model.make_future_dataframe(periods=horizon_days, freq="D")
    forecast = model.predict(future)

    # Return only future rows (drop historical fit).
    last_history = df["ds"].max()
    fut = forecast[forecast["ds"] > last_history].copy()
    return fut[["ds", "yhat", "yhat_lower", "yhat_upper"]]


def _estimate_stockout(
    current_qty: float | None,
    daily_predictions: list[dict[str, Any]],
) -> str | None:
    """Estimate the date stock runs out.

    Formula (ADR-0010 §4): `current_qty / mean(yhat[next 14])` rounded up to
    a whole day, then added to today. Returns None when:
      * current_qty is missing (cron didn't supply it),
      * mean predicted demand is essentially zero (item never sells),
      * the stockout is more than 30 days away (out of forecast horizon).
    """
    if current_qty is None or current_qty <= 0:
        # Already empty — flag today as the stockout date so the dashboard
        # surfaces it. ADR-0010 §5 — "foydali signal".
        if current_qty is not None and current_qty <= 0:
            return date.today().isoformat()
        return None
    if not daily_predictions:
        return None

    window = daily_predictions[:STOCKOUT_LOOKAHEAD_DAYS]
    yhats = [max(0.0, float(d["yhat"])) for d in window if "yhat" in d]
    if not yhats:
        return None
    mean_demand = sum(yhats) / len(yhats)
    if mean_demand < EPSILON:
        return None

    days_left = math.ceil(current_qty / mean_demand)
    # Forecast horizon is 30 days — beyond that the estimate is unreliable.
    if days_left > 30:
        return None
    stockout = date.today() + timedelta(days=days_left)
    return stockout.isoformat()


def forecast_one(
    item: ForecastItem,
    horizon_days: int,
) -> dict[str, Any]:
    """Run one Prophet fit + horizon prediction. Returns a JSON-clean dict
    matching the `forecasts[]` array shape from `app/main.py:PredictResponse`.

    Per-item failures are caught and surfaced as `{"failed": true, ...}` so
    one bad item never aborts a batch."""
    base = {
        "location_id": item.location_id,
        "product_id": item.product_id,
    }

    if len(item.sales_daily) < MIN_HISTORY_DAYS:
        return {
            **base,
            "insufficient_data": True,
            "daily_predictions": [],
            "expected_stockout_date": None,
        }

    try:
        forecast_df = _fit_and_predict(item.sales_daily, horizon_days)
    except Exception as exc:  # noqa: BLE001 — Prophet exceptions are non-uniform.
        logger.warning(
            "prophet fit failed for loc=%s prod=%s: %s",
            item.location_id,
            item.product_id,
            exc,
        )
        return {
            **base,
            "failed": True,
            "error": str(exc)[:200],
            "daily_predictions": [],
            "expected_stockout_date": None,
        }

    daily_predictions: list[dict[str, Any]] = []
    for _, row in forecast_df.iterrows():
        yhat = float(row["yhat"])
        yhat_lower = float(row["yhat_lower"])
        yhat_upper = float(row["yhat_upper"])
        # Negative demand is nonsense for retail; clamp at 0 before storing.
        daily_predictions.append(
            {
                "date": row["ds"].date().isoformat(),
                "yhat": round(max(0.0, yhat), 4),
                "yhat_lower": round(max(0.0, yhat_lower), 4),
                "yhat_upper": round(max(0.0, yhat_upper), 4),
            }
        )

    return {
        **base,
        "daily_predictions": daily_predictions,
        "expected_stockout_date": _estimate_stockout(
            item.current_qty, daily_predictions
        ),
    }


def forecast_batch(
    items: list[ForecastItem],
    horizon_days: int = DEFAULT_HORIZON_DAYS,
) -> list[dict[str, Any]]:
    """Top-level entry point — fan out to `forecast_one` over `items`.

    No threading: Prophet is CPU-bound and the GIL pins us anyway. The cron
    batches 50 items per HTTP call, so ~50 * 0.5s = 25s per request is fine.
    """
    horizon = max(1, min(int(horizon_days), 30))
    return [forecast_one(item, horizon) for item in items]
