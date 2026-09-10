#!/usr/bin/env python3
"""
ADIA ERP — apply ONE migration to production, safely.

    python deploy/apply_migration.py 0061_something.sql

Why this exists instead of `npm run migrate`: the production database was
migrated by hand for a while and its schema_migrations table has gaps. The
built-in runner would apply every unapplied file in order, which includes
0053_fix_sales_price_som.sql and 0054_fix_cost_sell_price_som.sql — two
UPDATEs that divide prices by 100. Those were already applied to the data by
other means, so running them would divide correct prices AGAIN. See
deploy/DEPLOY.md.

This script applies exactly the file you name, inside ONE transaction, and
records it in schema_migrations so it cannot run twice. It prints the schema
before and after so the change is visible, and refuses if the file is already
recorded.
"""
import sys, time, re
from pathlib import Path
import paramiko

ROOT = Path(__file__).resolve().parent.parent

if len(sys.argv) != 2:
    sys.exit("Usage: python deploy/apply_migration.py <NNNN_name.sql>")
MIG = sys.argv[1]
mig_path = ROOT / "apps" / "backend" / "migrations" / MIG
if not mig_path.exists():
    sys.exit("ERROR: " + str(mig_path) + " topilmadi.")
mig_sql = mig_path.read_text(encoding="utf-8")

cfg = {}
for line in (ROOT / "deploy" / ".env.deploy").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
key = cfg.get('SSH_KEY', '')
if key and Path(key).expanduser().exists():
    client.connect(cfg['HOST'], username=cfg.get('USER', 'ubuntu'),
                   key_filename=str(Path(key).expanduser()), timeout=30)
elif cfg.get('PASSWORD'):
    client.connect(cfg['HOST'], username=cfg.get('USER', 'ubuntu'),
                   password=cfg['PASSWORD'], timeout=30)
else:
    sys.exit("ERROR: deploy/.env.deploy da SSH_KEY ham, PASSWORD ham yo'q.")
print("[SSH] " + cfg['HOST'] + "  ·  migratsiya: " + MIG)

# All or nothing: the schema change and its schema_migrations row commit together.
tx = ("BEGIN;\n" + mig_sql
      + "\nINSERT INTO schema_migrations (filename) VALUES ('" + MIG + "');\n"
        "COMMIT;\n")

runner = """#!/bin/bash
set -a; . /opt/adia-erp/apps/backend/.env; set +a
export PAGER=cat PSQL_PAGER=cat
Q() { psql -P pager=off -tAc "$1" "$DATABASE_URL"; }

if [ "$(Q "SELECT count(*) FROM schema_migrations WHERE filename = 'MIGNAME';")" != "0" ]; then
  echo "TO'XTATILDI: MIGNAME allaqachon qo'llangan."
  exit 2
fi

echo "--- OLDIN: jadvallar / ustunlar soni ---"
Q "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') || ' jadval, ' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='public') || ' ustun';"

echo "--- qo'llanmoqda (bitta tranzaksiya) ---"
psql -v ON_ERROR_STOP=1 -P pager=off "$DATABASE_URL" -f /tmp/adia_mig.sql
rc=$?
echo "psql exit: $rc"

echo "--- KEYIN ---"
Q "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') || ' jadval, ' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='public') || ' ustun';"
Q "SELECT filename || '  ' || applied_at::timestamp(0) FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;"

echo "--- xavfli 0053/0054 hamon qo'llanmaganini tasdiqlash ---"
Q "SELECT coalesce(string_agg(filename, ', '), '(yo-q — yaxshi)') FROM schema_migrations WHERE filename LIKE '0053%' OR filename LIKE '0054%';"

if [ $rc -eq 0 ]; then
  cp /tmp/MIGNAME /opt/adia-erp/apps/backend/migrations/
  chown ubuntu:ubuntu /opt/adia-erp/apps/backend/migrations/MIGNAME
  echo "serverdagi migrations/ papkasiga ham nusxalandi"
fi
exit $rc
""".replace("MIGNAME", MIG)

sftp = client.open_sftp()
with sftp.file('/tmp/adia_mig.sql', 'w') as f: f.write(tx)
with sftp.file('/tmp/' + MIG, 'w') as f: f.write(mig_sql)
with sftp.file('/tmp/adia_mig.sh', 'w') as f: f.write(runner)
sftp.close()

ch = client.get_transport().open_session(); ch.settimeout(300); ch.get_pty()
ch.exec_command("sudo bash /tmp/adia_mig.sh")
buf = b""; t0 = time.time()
while True:
    if ch.recv_ready(): buf += ch.recv(65536)
    if ch.exit_status_ready() and not ch.recv_ready(): break
    if time.time() - t0 > 300: break
    time.sleep(0.05)
print(re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', buf.decode('utf-8', 'replace').replace('\r', '')))
rc = ch.recv_exit_status()
client.close()
print("[OK] Migratsiya qo'llandi." if rc == 0 else "[XATO] rc=" + str(rc) + " — hech narsa o'zgarmadi (tranzaksiya).")
sys.exit(rc)
