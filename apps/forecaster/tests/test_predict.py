"""Sidecar `/predict` + `/healthz` integration test.

Uses FastAPI's TestClient (httpx under the hood). Each test seeds its own
synthetic series; Prophet runs for real (no mocking the model — the whole
point of the sidecar is to verify the fit behaves).
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.main import app

SECRET = "test-shared-secret-do-not-use"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _series(days: int, daily_qty: float) -> list[dict[str, object]]:
    """Build a `sales_daily` payload — `days` days back, constant `daily_qty`."""
    today = dt.date.today()
    return [
        {
            "date": (today - dt.timedelta(days=i)).isoformat(),
            "qty": daily_qty,
        }
        for i in range(days, 0, -1)
    ]


def test_healthz(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "prophet_version" in body
    # Prophet must be importable inside the container.
    assert body["prophet_version"] != "unavailable"


def test_predict_rejects_bad_secret(client: TestClient) -> None:
    r = client.post(
        "/predict",
        json={
            "secret": "wrong",
            "items": [],
            "horizon_days": 7,
        },
    )
    assert r.status_code == 401


def test_predict_rejects_missing_secret(client: TestClient) -> None:
    r = client.post(
        "/predict",
        json={
            "secret": "",
            "items": [],
            "horizon_days": 7,
        },
    )
    assert r.status_code == 401


def test_predict_constant_series(client: TestClient) -> None:
    """30 days of constant 10/day → yhat ≈ 10 each day; stockout ≈ today+10
    when current_qty=100."""
    r = client.post(
        "/predict",
        json={
            "secret": SECRET,
            "horizon_days": 7,
            "items": [
                {
                    "location_id": 1,
                    "product_id": 1,
                    "current_qty": 100,
                    "sales_daily": _series(40, 10.0),
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    forecasts = r.json()["forecasts"]
    assert len(forecasts) == 1
    f = forecasts[0]
    assert f["location_id"] == 1
    assert f["product_id"] == 1
    assert len(f["daily_predictions"]) == 7
    # Prophet on a flat series shouldn't drift far from 10/day. Allow a
    # generous 30% band — the point is "not 0, not 1000".
    yhats = [d["yhat"] for d in f["daily_predictions"]]
    assert all(7.0 < y < 13.0 for y in yhats), yhats
    # Stockout: 100 / ~10 = ~10 days from today.
    assert f["expected_stockout_date"] is not None
    stockout = dt.date.fromisoformat(f["expected_stockout_date"])
    days_out = (stockout - dt.date.today()).days
    assert 7 <= days_out <= 14, days_out


def test_predict_insufficient_history(client: TestClient) -> None:
    r = client.post(
        "/predict",
        json={
            "secret": SECRET,
            "horizon_days": 7,
            "items": [
                {
                    "location_id": 1,
                    "product_id": 2,
                    "current_qty": 50,
                    # Only 10 days — under the 30 minimum.
                    "sales_daily": _series(10, 5.0),
                }
            ],
        },
    )
    assert r.status_code == 200
    forecasts = r.json()["forecasts"]
    assert forecasts[0]["insufficient_data"] is True
    assert forecasts[0]["daily_predictions"] == []
    assert forecasts[0]["expected_stockout_date"] is None


def test_predict_current_qty_zero(client: TestClient) -> None:
    """current_qty=0 must signal an already-empty shelf — stockout = today."""
    r = client.post(
        "/predict",
        json={
            "secret": SECRET,
            "horizon_days": 7,
            "items": [
                {
                    "location_id": 1,
                    "product_id": 3,
                    "current_qty": 0,
                    "sales_daily": _series(35, 5.0),
                }
            ],
        },
    )
    assert r.status_code == 200
    f = r.json()["forecasts"][0]
    assert f["expected_stockout_date"] == dt.date.today().isoformat()


def test_predict_horizon_cap(client: TestClient) -> None:
    """horizon_days > 30 must be rejected by validation (or clamped)."""
    r = client.post(
        "/predict",
        json={
            "secret": SECRET,
            "horizon_days": 999,
            "items": [
                {
                    "location_id": 1,
                    "product_id": 4,
                    "current_qty": 10,
                    "sales_daily": _series(35, 1.0),
                }
            ],
        },
    )
    # pydantic rejects >30 with 422.
    assert r.status_code == 422
