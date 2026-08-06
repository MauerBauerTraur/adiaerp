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
print(f"SSH OK")

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

print("=== TVOROZHNY products ===")
q("SELECT id, name, type, poster_product_id FROM products WHERE name ILIKE '%OROJ%'")

print("=== poster_webhook_events count (recent) ===")
q("SELECT COUNT(*) FROM poster_webhook_events WHERE created_at > now() - interval '35 days'")

print("=== poster_webhook_events sample ===")
q("SELECT id, event_type, processed, created_at FROM poster_webhook_events ORDER BY created_at DESC LIMIT 5")

print("=== mods pointing to each product ===")
q("SELECT ppm.product_id, p.name, COUNT(*) as mod_count FROM poster_product_modifications ppm JOIN products p ON p.id=ppm.product_id GROUP BY ppm.product_id, p.name ORDER BY mod_count DESC LIMIT 10")

print("=== sales by product (top 10) ===")
q("SELECT s.product_id, p.name, COUNT(*) FROM sales s JOIN products p ON p.id=s.product_id GROUP BY s.product_id, p.name ORDER BY COUNT(*) DESC LIMIT 10")

c.close()
