#!/usr/bin/env python3
"""Diagnose the 15-unit gap in GP TVOROZHNY stock for July 2026."""
import sys, time, io
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from pathlib import Path
try:
    import paramiko
except ImportError:
    print("pip install paramiko"); sys.exit(1)

CFG_FILE = Path(__file__).parent / ".env.deploy"
cfg = {}
for line in CFG_FILE.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

HOST = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', ''); db_name = 'adia_erp'
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='ubuntu', password=PASSWORD, timeout=30)
print("SSH OK")

def run_sql(client, sql):
    sftp = client.open_sftp()
    sftp.putfo(io.BytesIO(sql.encode('utf-8')), "/tmp/diag_gap.sql")
    sftp.close()
    chan = client.get_transport().open_session()
    chan.exec_command(f"sudo -u postgres psql -d {db_name} -f /tmp/diag_gap.sql 2>&1")
    out = b""
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.recv_stderr_ready(): out += chan.recv_stderr(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return out.decode('utf-8', errors='replace')

print("=== 1. ALL stock_movements for product_id=1063 in July, by reason ===")
print(run_sql(c, r"""
SELECT
  reason,
  COUNT(*) AS rows,
  SUM(qty) AS total_qty,
  MIN(created_at)::date AS first,
  MAX(created_at)::date AS last
FROM stock_movements
WHERE product_id = 1063
  AND created_at >= '2026-07-01'
GROUP BY reason
ORDER BY total_qty DESC;
"""))

print("=== 2. Stock_movements before July (all-time opening balance) ===")
print(run_sql(c, r"""
SELECT
  reason,
  COUNT(*) AS rows,
  SUM(qty) AS total_qty
FROM stock_movements
WHERE product_id = 1063
  AND created_at < '2026-07-01'
GROUP BY reason
ORDER BY total_qty DESC;
"""))

print("=== 3. Per-location current stock for product_id=1063 ===")
print(run_sql(c, r"""
SELECT l.name AS location, l.type, s.qty
FROM stock s
JOIN locations l ON l.id = s.location_id
WHERE s.product_id = 1063 AND s.qty > 0
ORDER BY s.qty DESC;
"""))

print("=== 4. Full stock_movements list for product_id=1063 in July ===")
print(run_sql(c, r"""
SELECT
  sm.id,
  sm.reason,
  sm.qty,
  fl.name AS from_loc,
  tl.name AS to_loc,
  sm.created_at::date,
  sm.poster_transaction_id,
  sm.note
FROM stock_movements sm
LEFT JOIN locations fl ON fl.id = sm.from_location_id
LEFT JOIN locations tl ON tl.id = sm.to_location_id
WHERE sm.product_id = 1063
  AND sm.created_at >= '2026-07-01'
ORDER BY sm.created_at;
"""))

print("=== 5. Balance check: opening + in - used - sold_move = current stock ===")
print(run_sql(c, r"""
WITH all_time AS (
  SELECT
    COALESCE(SUM(CASE WHEN reason IN ('production_output','purchase') THEN qty END), 0) AS total_in,
    COALESCE(SUM(CASE WHEN reason = 'production_input' THEN qty END), 0) AS total_used,
    COALESCE(SUM(CASE WHEN reason = 'sale' THEN qty END), 0) AS total_sold_move,
    COALESCE(SUM(CASE WHEN reason = 'adjust' THEN qty END), 0) AS total_adjust,
    COALESCE(SUM(CASE WHEN reason = 'transfer' THEN qty END), 0) AS total_transfer_out
  FROM stock_movements
  WHERE product_id = 1063
)
SELECT
  total_in,
  total_used,
  total_sold_move,
  total_adjust,
  total_transfer_out,
  (SELECT SUM(qty) FROM stock WHERE product_id = 1063) AS current_stock,
  (SELECT SUM(qty) FROM sales WHERE product_id = 1063) AS total_poster_sold
FROM all_time;
"""))

c.close()
print("Done.")
