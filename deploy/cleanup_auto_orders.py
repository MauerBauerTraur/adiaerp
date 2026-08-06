#!/usr/bin/env python3
"""
Avtomatik yaratilgan production orderlarni o'chirish.
Faqat note LIKE 'Avtomat%' bo'lgan orderlar o'chiriladi.
"""
import sys
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

HOST    = cfg['HOST']
USER    = cfg.get('USER', 'ubuntu')
PASSWORD = cfg.get('PASSWORD', '')
SSH_KEY  = cfg.get('SSH_KEY', '')

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if SSH_KEY and Path(SSH_KEY).expanduser().exists():
        client.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
    else:
        client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    print(f"[SSH] {USER}@{HOST}")
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

print("\n-- Avtomatik orderlar soni (o'chirishdan oldin) --")
run_cmd(client, """sudo -u postgres psql -d adia_erp -c "
SELECT COUNT(*) AS avto_top_orders
  FROM production_orders
 WHERE note LIKE 'Avtomat%' AND parent_production_order_id IS NULL;
SELECT COUNT(*) AS avto_sub_orders
  FROM production_orders
 WHERE note LIKE 'Avtomat%' AND parent_production_order_id IS NOT NULL;
SELECT COUNT(*) AS avto_dispatches
  FROM production_dispatches pd
  JOIN production_orders po ON po.id = pd.production_order_id
 WHERE po.note LIKE 'Avtomat%'
    OR po.parent_production_order_id IN (
         SELECT id FROM production_orders WHERE note LIKE 'Avtomat%'
       );
" """)

print("\n-- O'chirilmoqda --")
rc = run_cmd(client, r"""sudo -u postgres psql -d adia_erp -c "
-- 1. Dispatches for auto orders and their children
DELETE FROM production_dispatches
 WHERE production_order_id IN (
   SELECT id FROM production_orders WHERE note LIKE 'Avtomat%'
   UNION
   SELECT id FROM production_orders
    WHERE parent_production_order_id IN (
      SELECT id FROM production_orders WHERE note LIKE 'Avtomat%' AND parent_production_order_id IS NULL
    )
 );

-- 2. Sub-orders of auto orders
DELETE FROM production_orders
 WHERE parent_production_order_id IN (
   SELECT id FROM production_orders WHERE note LIKE 'Avtomat%' AND parent_production_order_id IS NULL
 );

-- 3. Top-level auto orders
DELETE FROM production_orders WHERE note LIKE 'Avtomat%';

-- Check
SELECT COUNT(*) AS qolgan_auto FROM production_orders WHERE note LIKE 'Avtomat%';
" """)

if rc == 0:
    print("\n[OK] Avtomatik orderlar o'chirildi.")
else:
    print(f"\n[ERROR] O'chirish muvaffaqiyatsiz (rc={rc}).")

client.close()
