#!/usr/bin/env python3
import sys, time
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

q = lambda sql: run(c, f"sudo -u postgres psql -d {db_name} -c {repr(sql)}")

print("=== poster_product_modifications sample ===")
q("SELECT modification_id, poster_product_id, product_id, name, weight_g FROM poster_product_modifications LIMIT 10")

print("\n=== sales with modification_id ===")
q("SELECT COUNT(*), modification_id IS NOT NULL as has_mod FROM sales GROUP BY has_mod")

print("\n=== sales where modification_id set ===")
q("SELECT s.id, s.product_id, s.modification_id, p.name FROM sales s JOIN products p ON p.id=s.product_id WHERE s.modification_id IS NOT NULL LIMIT 10")

print("\n=== ТВОРОЖНЫЙ product id ===")
q("SELECT id, name, type, poster_product_id FROM products WHERE name ILIKE '%ТВОР%'")

c.close()
