#!/usr/bin/env python3
"""Diagnostic + fix: check current state of poster_product_modifications and restore if needed."""
import sys, time, io
# Force UTF-8 stdout to handle Cyrillic in psql output
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
    sftp.putfo(io.BytesIO(sql.encode('utf-8')), "/tmp/mod_fix.sql")
    sftp.close()
    chan = client.get_transport().open_session()
    chan.exec_command(f"sudo -u postgres psql -d {db_name} -f /tmp/mod_fix.sql 2>&1")
    out = b""
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.recv_stderr_ready(): out += chan.recv_stderr(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return out.decode('utf-8', errors='replace')

# 1. Show what's currently in poster_product_modifications for ids 1550/1551/1552/2534
print("=== Current state of modification_ids 1550/1551/1552/2534 ===")
print(run_sql(c, r"""
SELECT modification_id,
       poster_product_id,
       product_id,
       weight_g,
       REPLACE(REPLACE(name, chr(1062), 'C'), chr(1050), 'K') AS name_ascii
FROM poster_product_modifications
WHERE modification_id IN (1550, 1551, 1552, 2534)
ORDER BY modification_id;
"""))

# 2. Show all rows for poster_product_id=2135 with factor
print("=== All rows for poster_product_id=2135 ===")
print(run_sql(c, r"""
SELECT modification_id,
       weight_g,
       ROUND(weight_g / NULLIF((SELECT MAX(weight_g) FROM poster_product_modifications WHERE poster_product_id=2135), 0), 4) AS factor
FROM poster_product_modifications
WHERE poster_product_id = 2135
ORDER BY weight_g DESC;
"""))

# 3. Fix: ensure rows 1550/1551/1552 have correct poster_product_id=2135 and weights
# This is idempotent - safe to run even if already correct
print("=== Restoring/ensuring rows 1550/1551/1552 for poster_product_id=2135 ===")
print(run_sql(c, r"""
INSERT INTO poster_product_modifications
  (modification_id, poster_product_id, product_id, name, weight_g, synced_at)
VALUES
  (1550, 2135, 1063, 'CELIY',    1000.0,  now()),
  (1551, 2135, 1063, 'POLOVINA',  500.0,  now()),
  (1552, 2135, 1063, 'KUSOK',     55.55,  now())
ON CONFLICT (modification_id) DO UPDATE
  SET poster_product_id = 2135,
      product_id        = 1063,
      name              = EXCLUDED.name,
      weight_g          = EXCLUDED.weight_g,
      synced_at         = EXCLUDED.synced_at;
"""))

# 4. Verify final state for poster_product_id=2135
print("=== FINAL: all rows for poster_product_id=2135 with factors ===")
print(run_sql(c, r"""
SELECT modification_id,
       weight_g,
       ROUND(weight_g / NULLIF((SELECT MAX(weight_g) FROM poster_product_modifications WHERE poster_product_id=2135), 0), 4) AS factor,
       name AS name_raw
FROM poster_product_modifications
WHERE poster_product_id = 2135
ORDER BY weight_g DESC;
"""))

# 5. Sales: verify the retroactive fix is correct
print("=== Sales for modification_id=2534 after fix ===")
print(run_sql(c, r"""
SELECT poster_transaction_id, poster_line_id, qty, price, modification_id
FROM sales
WHERE modification_id = 2534;
"""))

# 6. Stock report preview: total sold today for product_id=1063
print("=== Total sold today for product_id=1063 (should be ~0.278) ===")
print(run_sql(c, r"""
SELECT SUM(qty) AS total_sold_today
FROM sales
WHERE product_id = 1063
  AND sold_at >= CURRENT_DATE;
"""))

c.close()
print("Done.")
