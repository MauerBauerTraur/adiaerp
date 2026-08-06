#!/usr/bin/env python3
"""
1. Postgres superuser orqali poster_product_modifications tablega GRANT beradi
2. Keyin sales ni to'g'ri product_id ga yangilaydi
"""
import sys, time, io
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

HOST = cfg['HOST']; USER = cfg.get('USER','ubuntu'); PASSWORD = cfg.get('PASSWORD','')
APP_DIR = cfg.get('APP_DIR', '/opt/adia-erp')

def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    print(f"[SSH] {USER}@{HOST}")
    return c

def run(client, cmd, timeout=60):
    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    while True:
        if chan.recv_ready():
            chunk = chan.recv(8192); out += chunk
            sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return chan.recv_exit_status(), out.decode(errors='replace')

# Known from previous diagnostic run
app_db_user = 'adia_user'
db_name = 'adia_erp'

client = connect()

# Step 2: Grant via postgres superuser with correct database (already done, idempotent)
print("\n=== Step 2: GRANT UPDATE qilinmoqda ===")
grant_sql = (
    f"GRANT SELECT, INSERT, UPDATE, DELETE ON poster_product_modifications TO {app_db_user}; "
    f"GRANT SELECT, INSERT, UPDATE, DELETE ON sales TO {app_db_user};"
)
rc, _ = run(client, f"sudo -u postgres psql -d {db_name} -c {repr(grant_sql)}")
if rc != 0:
    print("GRANT muvaffaqiyatsiz, davom ettirilmoqda...")

# Step 3: Run sync to populate poster_product_modifications, then fix sales
print("\n=== Step 3: syncModifications va sales fix (postgres superuser) ===")

# Use postgres superuser to run the full fix (bypasses app user permission issues)
fix_sql = f"""
-- Populate poster_product_modifications.product_id (prefer 'finished' type)
UPDATE poster_product_modifications ppm
SET product_id = (
  SELECT p.id FROM products p
  WHERE p.poster_product_id = ppm.poster_product_id
  ORDER BY (p.type = 'finished') DESC, p.id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM products p WHERE p.poster_product_id = ppm.poster_product_id
);

-- Fix existing sales attributed to wrong product via modification
UPDATE sales s
SET product_id = ppm.product_id
FROM poster_product_modifications ppm
WHERE s.modification_id = ppm.modification_id
  AND ppm.product_id IS NOT NULL
  AND s.product_id != ppm.product_id
  AND NOT EXISTS (
    SELECT 1 FROM sales s2
    WHERE s2.poster_transaction_id = s.poster_transaction_id
      AND s2.poster_line_id = s.poster_line_id
      AND s2.product_id = ppm.product_id
      AND s2.id != s.id
  );
"""

sftp = client.open_sftp()
sftp.putfo(io.BytesIO(fix_sql.encode()), "/tmp/adia_fix.sql")
sftp.close()

rc, out = run(client, f"sudo -u postgres psql -d {db_name} -f /tmp/adia_fix.sql && rm -f /tmp/adia_fix.sql")
if rc != 0:
    print("\n=== FIX XATO (superuser) ==="); sys.exit(1)
print("\n=== FIX MUVAFFAQIYATLI ===")

# Step 4: Restart backend so syncModifications runs immediately with new GRANT
print("\n=== Step 4: Backend restart (sync uchun) ===")
run(client, f"pm2 restart adia-backend", timeout=30)

client.close()
