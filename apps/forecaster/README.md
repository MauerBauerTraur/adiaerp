# ADIA forecaster — Prophet sidecar

A small FastAPI service that wraps [Meta Prophet](https://facebook.github.io/prophet/)
for the ADIA ERP forecasting pipeline (Faza-3 Sprint 4, F3.4). Decision and
rationale: [`docs/architecture/adr-0010-forecasting-approach.md`](../../docs/architecture/adr-0010-forecasting-approach.md).

## What it does

The Node backend cron (`apps/backend/src/workers/forecastRefreshCron.ts`)
calls `POST /predict` once a day with a batch of `(location_id, product_id,
sales_daily[])` items. The sidecar fits one Prophet model per item and
returns:

- `daily_predictions[]` — `yhat`, `yhat_lower`, `yhat_upper` for the next
  N days (default 14, max 30);
- `expected_stockout_date` — when the supplied `current_qty` is expected
  to run out (≈ `current_qty / mean(yhat[next 14])`).

Items with `< 30` days of history are skipped with
`{"insufficient_data": true}`; Prophet fit failures land as
`{"failed": true, "error": ...}` so a bad item never poisons a batch.

## Endpoints

| Method | Path        | Auth                                | Notes                                                       |
| ------ | ----------- | ----------------------------------- | ----------------------------------------------------------- |
| GET    | `/healthz`  | none                                | Returns `{status: "ok", prophet_version: "..."}`            |
| POST   | `/predict`  | `secret` field in body (shared key) | Batch ≤ 100 items per call; `horizon_days` 1..30 (def. 14). |

`POST /predict` body:

```json
{
  "secret": "<FORECASTER_SHARED_SECRET>",
  "items": [
    {
      "location_id": 1,
      "product_id": 5,
      "current_qty": 100,
      "sales_daily": [
        {"date": "2026-04-01", "qty": 3.5},
        {"date": "2026-04-02", "qty": 4.0}
      ]
    }
  ],
  "horizon_days": 14
}
```

Response:

```json
{
  "forecasts": [
    {
      "location_id": 1,
      "product_id": 5,
      "daily_predictions": [
        {"date": "2026-05-24", "yhat": 3.2, "yhat_lower": 2.0, "yhat_upper": 4.5}
      ],
      "expected_stockout_date": "2026-06-15"
    }
  ]
}
```

## Run locally

```bash
# from the repo root
export FORECASTER_SHARED_SECRET="$(openssl rand -hex 16)"
cd apps/forecaster
docker compose up --build forecaster
```

Smoke test the live container:

```bash
curl -s http://127.0.0.1:8000/healthz

curl -s -X POST http://127.0.0.1:8000/predict \
  -H 'content-type: application/json' \
  -d "{
    \"secret\": \"$FORECASTER_SHARED_SECRET\",
    \"horizon_days\": 7,
    \"items\": [{
      \"location_id\": 1, \"product_id\": 1, \"current_qty\": 50,
      \"sales_daily\": $(python -c '
import json, datetime as dt
today = dt.date.today()
print(json.dumps([{
  "date": (today - dt.timedelta(days=i)).isoformat(),
  "qty": 10 if (today - dt.timedelta(days=i)).weekday() < 5 else 25
} for i in range(30, 0, -1)]))
')
    }]
  }"
```

## Run without Docker (dev)

```bash
cd apps/forecaster
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export FORECASTER_SHARED_SECRET=dev-secret
uvicorn app.main:app --reload --port 8000
```

## Tests

```bash
cd apps/forecaster
pip install pytest httpx
PYTHONPATH=. pytest tests/ -v
```

The pytest suite covers:

- shared-secret auth (401 on wrong / missing secret);
- `/predict` happy path (30 days of constant sales → ~constant `yhat`);
- `< 30` days history → `insufficient_data: true`;
- `current_qty=0` → `expected_stockout_date = today`;
- `/healthz` returns Prophet version.

## Deploy notes

ADR-0010 §"Narx va mavjudlik":

- **Single instance.** Prophet fits are CPU-bound; horizontal scaling does
  not help a once-a-day batch. One container, `restart: unless-stopped`.
- **Memory.** ~512 MB RSS during a 50-item batch; ~50 MB idle.
- **Image size.** ~800 MB (Python 3.11 slim + Prophet + cmdstanpy).
- **Network.** Bound to `127.0.0.1:8000` in compose — the Node backend
  reaches it over the loopback. Never expose publicly: the only auth is a
  shared secret.

## Env vars

| Name                        | Required | Notes                                            |
| --------------------------- | -------- | ------------------------------------------------ |
| `FORECASTER_SHARED_SECRET`  | yes      | Constant-time compared against `secret` in body. |
