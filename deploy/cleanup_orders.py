#!/usr/bin/env python3
"""
Ishlab chiqarish zayavkalari va ombordan berish yozuvlarini tozalash.
Usage: python deploy/cleanup_orders.py
"""
import sys, time
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("pip install paramiko")
    sys.exit(1)

CFG_FILE = Path(__file__).parent / ".env.deploy"
if not CFG_FILE.exists():
    print(f"ERROR: {CFG_FILE} topilmadi.")
    sys.exit(1)

cfg: dict[str, str] = {}
for line in CFG_FILE.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('=')
        cfg[k.strip()] = v.strip()

HOST     = cfg['HOST']
USER     = cfg.get('USER', 'ubuntu')
PASSWORD = cfg.get('PASSWORD', '')
SSH_KEY  = cfg.get('SSH_KEY', '')
APP_DIR  = cfg.get('APP_DIR', '/opt/adia-erp')

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if SSH_KEY and Path(SSH_KEY).expanduser().exists():
        client.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
        print(f"[SSH] {USER}@{HOST} (kalit)")
    else:
        client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
        print(f"[SSH] {USER}@{HOST} (parol)")
    return client

def run_cmd(client, cmd: str, timeout: int = 60):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors='replace')
    err = stderr.read().decode(errors='replace')
    rc = stdout.channel.recv_exit_status()
    if out:
        print(out, end='')
    if err:
        print(err, end='', file=sys.stderr)
    return rc

client = connect()

# Count before delete
print("\n-- Hozirgi holat --")
run_cmd(client, "sudo -u postgres psql -d adia_erp -c \"SELECT COUNT(*) AS production_orders_soni FROM production_orders; SELECT COUNT(*) AS dispatches_soni FROM production_dispatches;\"")

# Delete dispatches first (foreign key ref to production_orders), then orders
print("\n-- O'chirilmoqda --")
rc = run_cmd(client, (
    'sudo -u postgres psql -d adia_erp -c "'
    'DELETE FROM production_dispatches; '
    'DELETE FROM production_orders; '
    'SELECT COUNT(*) AS qolgan_orders FROM production_orders; '
    'SELECT COUNT(*) AS qolgan_dispatches FROM production_dispatches;'
    '"'
))

if rc == 0:
    print("\n[OK] Zayavkalar va ombordan berish yozuvlari o'chirildi.")
else:
    print(f"\n[ERROR] O'chirish muvaffaqiyatsiz (rc={rc}).")

client.close()
