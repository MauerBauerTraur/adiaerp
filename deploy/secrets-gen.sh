#!/usr/bin/env bash
# Generate fresh production secrets and print them once. Save to .env on
# the server — never commit. Re-run any time you need to rotate.
set -euo pipefail

cat <<EOF
# Append these to /opt/adia-erp/.env on the server, then \`chmod 600 .env\`.
# Existing keys win — only add what is missing.

JWT_SECRET=$(openssl rand -hex 64)
FORECASTER_SHARED_SECRET=$(openssl rand -hex 32)
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16)
EOF
