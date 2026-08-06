#!/usr/bin/env python3
"""
Fix: sales rows with modification_id=NULL for product_id=1063 (GP TVOROZHNY)
have qty stored as integer piece counts but should be fractional whole-cake units.

The price column contains the LINE TOTAL in sum.
The CELIY (whole cake) costs X sum → correct_qty = price / X.

We derive X from products.sell_price (if set) or from known KУСОК sales.
"""
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
    sftp.putfo(io.BytesIO(sql.encode('utf-8')), "/tmp/fix_null.sql")
    sftp.close()
    chan = client.get_transport().open_session()
    chan.exec_command(f"sudo -u postgres psql -d {db_name} -f /tmp/fix_null.sql 2>&1")
    out = b""
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.recv_stderr_ready(): out += chan.recv_stderr(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return out.decode('utf-8', errors='replace')

print("=== 1. Check products.sell_price for product_id=1063 ===")
print(run_sql(c, r"""
SELECT id, name, sell_price, unit FROM products WHERE id = 1063;
"""))

print("=== 2. Derive CELIY price from known KУСОК (mod=2534) sales ===")
print(run_sql(c, r"""
-- KУСОК factor = 55.55/1000 = 0.05555
-- KУСОК unit price = price / original_count_before_factor_fix
-- But since qty is now fractional, original count = qty / factor = qty / 0.05555
-- unit_price_kусок = price / (qty / 0.05555)
-- celiy_price = unit_price_kусок / 0.05555 = price / qty
SELECT
  price,
  qty,
  ROUND(price / qty, 0) AS celiy_price_inferred
FROM sales
WHERE modification_id = 2534 AND product_id = 1063;
"""))

print("=== 3. BEFORE: distribution of NULL-modification sales for product_id=1063 ===")
print(run_sql(c, r"""
SELECT
  qty, price,
  ROUND(price / 306000.0, 6) AS corrected_qty,
  COUNT(*) as row_count
FROM sales
WHERE product_id = 1063 AND modification_id IS NULL
GROUP BY qty, price
ORDER BY COUNT(*) DESC
LIMIT 20;
"""))

print("=== 4. BEFORE: total July sold_qty for product_id=1063 ===")
print(run_sql(c, r"""
SELECT SUM(qty) AS before_fix FROM sales WHERE product_id = 1063 AND sold_at >= '2026-07-01';
"""))

print("=== 5. Apply fix: qty = price / 306000 for NULL modification_id rows ===")
print(run_sql(c, r"""
UPDATE sales
SET qty = ROUND(price / 306000.0, 6)
WHERE product_id = 1063
  AND modification_id IS NULL
  AND price > 0;
"""))

print("=== 6. AFTER: total July sold_qty for product_id=1063 ===")
print(run_sql(c, r"""
SELECT SUM(qty) AS after_fix FROM sales WHERE product_id = 1063 AND sold_at >= '2026-07-01';
"""))

print("=== 7. AFTER: verify all sales rows for product_id=1063 in July ===")
print(run_sql(c, r"""
SELECT
  s.modification_id,
  ppm.name AS mod_name,
  COUNT(*) AS rows,
  SUM(s.qty) AS total_qty
FROM sales s
LEFT JOIN poster_product_modifications ppm ON ppm.modification_id = s.modification_id
WHERE s.product_id = 1063 AND s.sold_at >= '2026-07-01'
GROUP BY s.modification_id, ppm.name
ORDER BY total_qty DESC;
"""))

c.close()
print("Done.")
