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

# Find product with name containing 'ВОРОЖНЫЙ' or '621' neighbors
# Use octet search to avoid encoding issues
sqls = [
    ("All GP finished products search",
     "SELECT id, name, type, poster_product_id FROM products WHERE name LIKE $q$%/P %$q$ AND type = 'finished' ORDER BY name LIMIT 40"),
    ("Sales report - what product is shown as GP TVOROZHNY in stock",
     "SELECT p.id, p.name FROM products p WHERE p.id IN (SELECT DISTINCT product_id FROM sales) AND p.name LIKE $q$%/P%$q$ ORDER BY p.name"),
]

sftp = c.open_sftp()
for title, sql in sqls:
    print(f"\n=== {title} ===")
    sftp.putfo(io.BytesIO(sql.encode()), "/tmp/diag.sql")
    run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/diag.sql")
sftp.close()
c.close()
