#!/usr/bin/env python3
import sys, time, io
from pathlib import Path
try:
    import paramiko
except ImportError:
    sys.exit(1)

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

def run(client, cmd):
    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    while True:
        if chan.recv_ready(): chunk=chan.recv(8192); out+=chunk; sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return out.decode(errors='replace')

sqls = [
    # Search all products that have TVOROZHNY in name (any encoding/case)
    ("All products name search",
     "SELECT id, name, type, poster_product_id FROM products WHERE LOWER(name) LIKE '%voroj%' OR LOWER(name) LIKE '%tvoro%' OR id BETWEEN 619 AND 625 ORDER BY id"),
    # Check if 2135 has mods
    ("2135 in modifications",
     "SELECT COUNT(*), poster_product_id FROM poster_product_modifications WHERE poster_product_id = 2135 GROUP BY poster_product_id"),
    # Sales stats for product 621
    ("Sales 621 detail",
     "SELECT product_id, COUNT(*) total, SUM(CASE WHEN poster_transaction_id IS NOT NULL THEN 1 ELSE 0 END) from_poster, SUM(CASE WHEN modification_id IS NOT NULL THEN 1 ELSE 0 END) has_modid FROM sales WHERE product_id = 621 GROUP BY product_id"),
]

sftp = c.open_sftp()
for title, sql in sqls:
    print(f"\n=== {title} ===")
    sftp.putfo(io.BytesIO(sql.encode()), "/tmp/diag.sql")
    run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/diag.sql")
sftp.close()
c.close()
