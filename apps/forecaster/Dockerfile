# =============================================================================
# Prophet forecaster sidecar (ADR-0010, Faza-3 Sprint 4 F3.4).
#
# A small FastAPI service that wraps Meta's Prophet library. The Node backend
# `forecastRefreshCron.ts` calls `/predict` once a day with a batch of daily
# sales series; this container fits one Prophet model per (location, product)
# series and returns the next-N-day forecast plus an expected stockout date.
#
# Single-instance, internal-network only. Auth = shared secret in the request
# body (see app/config.py). Restart policy `unless-stopped` in compose.
# =============================================================================
FROM python:3.11-slim

# Prophet (cmdstanpy) pulls in compiled deps; we need a working compiler chain
# during install but drop apt cache to keep the image lean. ~800 MB final.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

# Single uvicorn worker — Prophet model fits are CPU heavy and we batch by
# request, not by concurrency. `--workers > 1` would just multiply memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
