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
    # Find via production orders (Г/П ТВОРОЖНЫЙ (ЦЕЛЫЙ) has 51 produced this month)
    ("Products with production orders this month",
     "SELECT p.id, p.name, p.type, COUNT(po.id) as po_count FROM products p JOIN production_orders po ON po.product_id = p.id WHERE po.created_at > now() - interval '35 days' AND po.status = 'done' GROUP BY p.id, p.name, p.type ORDER BY po_count DESC LIMIT 20"),
    # Products with closing_qty > 0 (those in stock right now)
    ("Products with stock",
     "SELECT p.id, p.name, p.type FROM products p JOIN stock s ON s.product_id=p.id WHERE s.qty > 0 AND p.type = 'finished' ORDER BY p.name LIMIT 30"),
]

sftp = c.open_sftp()
for title, sql in sqls:
    print(f"\n=== {title} ===")
    sftp.putfo(io.BytesIO(sql.encode()), "/tmp/diag.sql")
    run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/diag.sql")
sftp.close()
c.close()
