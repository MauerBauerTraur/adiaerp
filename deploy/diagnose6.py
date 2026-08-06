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
    # Find GP TVOROZHNY TSELYJ - search by partial name with ILIKE on server
    ("GP TVOROZHNY search",
     "SELECT id, name, type, poster_product_id FROM products WHERE name ILIKE $name$ %/P%CEL%$name$ OR name ILIKE $name$G/P%$name$ OR name ILIKE $name$%ЦЕЛЫЙ%$name$ LIMIT 20"),
    # All products with no poster_product_id (might find GP TVOROZHNY there)
    ("Products with stock but no poster link",
     "SELECT p.id, p.name, p.type FROM products p JOIN stock s ON s.product_id = p.id WHERE p.poster_product_id IS NULL AND p.type = 'finished' AND s.qty > 0 ORDER BY p.name LIMIT 20"),
    # Sales report - what shows in stock report as TVOROZHNY lines
    ("Stock for products near id 620-625",
     "SELECT p.id, p.name, s.qty FROM products p LEFT JOIN stock s ON s.product_id=p.id WHERE p.id BETWEEN 618 AND 630 ORDER BY p.id"),
]

sftp = c.open_sftp()
for title, sql in sqls:
    print(f"\n=== {title} ===")
    sftp.putfo(io.BytesIO(sql.encode()), "/tmp/diag.sql")
    run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/diag.sql")
sftp.close()
c.close()
