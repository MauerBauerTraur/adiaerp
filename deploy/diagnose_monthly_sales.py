#!/usr/bin/env python3
"""Diagnose why monthly Sotildi is wrong for product_id=1063 (GP TVOROZHNY CELIY)."""
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
    sftp.putfo(io.BytesIO(sql.encode('utf-8')), "/tmp/diag.sql")
    sftp.close()
    chan = client.get_transport().open_session()
    chan.exec_command(f"sudo -u postgres psql -d {db_name} -f /tmp/diag.sql 2>&1")
    out = b""
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.recv_stderr_ready(): out += chan.recv_stderr(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return out.decode('utf-8', errors='replace')

print("=== 1. July sales for product_id=1063, grouped by modification_id ===")
print(run_sql(c, r"""
SELECT
  s.modification_id,
  ppm.name AS mod_name,
  ppm.weight_g,
  ppm.poster_product_id,
  COUNT(*) AS rows,
  SUM(s.qty) AS total_qty,
  MIN(s.sold_at)::date AS first_sale,
  MAX(s.sold_at)::date AS last_sale
FROM sales s
LEFT JOIN poster_product_modifications ppm
       ON ppm.modification_id = s.modification_id
WHERE s.product_id = 1063
  AND s.sold_at >= '2026-07-01'
GROUP BY s.modification_id, ppm.name, ppm.weight_g, ppm.poster_product_id
ORDER BY total_qty DESC;
"""))

print("=== 2. All distinct modification_ids in sales for product_id=1063 (all time) ===")
print(run_sql(c, r"""
SELECT
  s.modification_id,
  ppm.name AS mod_name,
  ppm.weight_g,
  COUNT(*) AS rows,
  SUM(s.qty) AS total_qty
FROM sales s
LEFT JOIN poster_product_modifications ppm
       ON ppm.modification_id = s.modification_id
WHERE s.product_id = 1063
GROUP BY s.modification_id, ppm.name, ppm.weight_g
ORDER BY COUNT(*) DESC
LIMIT 20;
"""))

print("=== 3. Total sales sum for product_id=1063 in July ===")
print(run_sql(c, r"""
SELECT SUM(qty) AS july_total FROM sales
WHERE product_id = 1063 AND sold_at >= '2026-07-01';
"""))

print("=== 4. Sample of 10 rows from sales for product_id=1063 in July (oldest first) ===")
print(run_sql(c, r"""
SELECT id, modification_id, qty, price, sold_at::date, poster_transaction_id
FROM sales
WHERE product_id = 1063 AND sold_at >= '2026-07-01'
ORDER BY sold_at ASC
LIMIT 10;
"""))

print("=== 5. Is product_id=1063 mapped to multiple poster_product_ids? ===")
print(run_sql(c, r"""
SELECT poster_product_id, id, name, type
FROM products
WHERE id = 1063;
"""))

print("=== 6. Are there other ERP products with same poster_product_id? ===")
print(run_sql(c, r"""
SELECT id, name, type, poster_product_id
FROM products
WHERE poster_product_id = (SELECT poster_product_id FROM products WHERE id = 1063 LIMIT 1)
ORDER BY id;
"""))

c.close()
print("Done.")
