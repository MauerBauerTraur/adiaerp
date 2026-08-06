#!/usr/bin/env python3
"""
poster_product_modifications sync'ni kutib, keyin sales fix ishlatadi.
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

HOST = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', ''); db_name = 'adia_erp'

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='ubuntu', password=PASSWORD, timeout=30)
print(f"[SSH] ubuntu@{HOST}")

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

# Wait for syncModifications to populate the table (up to 2 minutes)
for attempt in range(8):
    rc, out = run(c, f"sudo -u postgres psql -d {db_name} -tAc 'SELECT COUNT(*) FROM poster_product_modifications'")
    lines = [l.strip() for l in out.strip().split('\n') if l.strip().isdigit()]
    count = int(lines[-1]) if lines else 0
    print(f"Attempt {attempt+1}: poster_product_modifications rows = {count}")
    if count > 0:
        break
    print("Sync kutilmoqda (15 soniya)...")
    time.sleep(15)
else:
    print("poster_product_modifications hali ham bo'sh. Manual sync kerak.")
    c.close(); sys.exit(1)

# Run sales fix
fix_sql = """
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

sftp = c.open_sftp()
sftp.putfo(io.BytesIO(fix_sql.encode()), "/tmp/sales_fix.sql")
sftp.close()

print("\nSales fix ishlanmoqda...")
rc, out = run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/sales_fix.sql && rm -f /tmp/sales_fix.sql")
if rc == 0:
    print("\n=== SALES FIX MUVAFFAQIYATLI ===")
else:
    print(f"\n=== XATO (rc={rc}) ===")
    sys.exit(1)

c.close()
