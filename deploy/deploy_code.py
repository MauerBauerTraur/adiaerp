#!/usr/bin/env python3
"""
ADIA ERP — production deploy (code only, no migrations).

    python deploy/deploy_code.py

Needs deploy/.env.deploy (gitignored — see .env.deploy.example) and a local
build: `npm run build -w @adia/backend` and `npm run build -w @adia/frontend`.

Steps: pg_dump + dist backup -> upload both dist folders over SFTP ->
`pm2 restart adia-backend` as the `ubuntu` user -> wait for /health.
Migrations are deliberately NOT run here — see deploy/DEPLOY.md.
"""
import sys, time
from datetime import datetime
from pathlib import Path
import paramiko

ROOT = Path(__file__).resolve().parent.parent  # repo root, wherever it is cloned
STAMP = datetime.now().strftime("%Y%m%d-%H%M")
SEP = chr(92)  # backslash, kept out of literals so heredocs cannot mangle it

cfg = {}
for line in (ROOT / "deploy" / ".env.deploy").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

HOST, USER = cfg['HOST'], cfg.get('USER', 'ubuntu')
APP_DIR = cfg.get('APP_DIR', '/opt/adia-erp')
BACKEND_DIST = ROOT / "apps" / "backend" / "dist"
FRONTEND_DIST = ROOT / "apps" / "frontend" / "dist"
for d in (BACKEND_DIST, FRONTEND_DIST):
    if not d.exists():
        sys.exit("ERROR: " + str(d) + " yo'q. Avval build qiling.")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
# Prefer the key. Password auth opens a new SSH session per deploy step and
# repeated runs trip fail2ban, which then drops ALL traffic from this IP —
# including HTTPS, so you lose both the server and the site from this machine.
key = cfg.get('SSH_KEY', '')
if key and Path(key).expanduser().exists():
    client.connect(HOST, username=USER, key_filename=str(Path(key).expanduser()), timeout=30)
elif cfg.get('PASSWORD'):
    print("[OGOHLANTIRISH] SSH_KEY topilmadi — parol bilan ulanmoqda. "
          "Tez-tez deploy qilsangiz fail2ban IP'ingizni bloklashi mumkin.")
    client.connect(HOST, username=USER, password=cfg['PASSWORD'], timeout=30)
else:
    sys.exit("ERROR: deploy/.env.deploy da SSH_KEY ham, PASSWORD ham yo'q.")
print("[SSH] " + USER + "@" + HOST)
sftp = client.open_sftp()

def put(p, body):
    with sftp.file(p, 'w') as fh: fh.write(body)

def run(p, timeout=900):
    ch = client.get_transport().open_session(); ch.settimeout(timeout); ch.get_pty()
    ch.exec_command("sudo bash " + p)
    t0 = time.time()
    while True:
        if ch.recv_ready():
            sys.stdout.write(ch.recv(65536).decode('utf-8','replace')); sys.stdout.flush()
        if ch.exit_status_ready() and not ch.recv_ready(): break
        if time.time()-t0 > timeout: print("[TIMEOUT]"); break
        time.sleep(0.05)
    return ch.recv_exit_status()

def phase(t): print("\n" + "="*62 + "\n### " + t + "\n" + "="*62)

def mkdir_p(path):
    cur = ''
    for part in path.split('/'):
        if not part: cur = '/'; continue
        cur = cur.rstrip('/') + '/' + part
        try: sftp.stat(cur)
        except FileNotFoundError: sftp.mkdir(cur)

def upload_dir(local_dir, remote_dir, label):
    mkdir_p(remote_dir); n = 0
    for item in sorted(local_dir.rglob('*')):
        if item.is_file():
            rel = str(item.relative_to(local_dir)).replace(SEP, '/')
            rp = remote_dir.rstrip('/') + '/' + rel
            parent = rp.rsplit('/', 1)[0]
            try: sftp.stat(parent)
            except FileNotFoundError: mkdir_p(parent)
            sftp.put(str(item), rp); n += 1
            if n % 25 == 0: print("  " + label + ": " + str(n) + " fayl...")
    print("  " + label + ": jami " + str(n) + " fayl yuklandi.")

phase("1/5 — DB backup + dist zaxira")
put('/tmp/adia_backup.sh', """#!/bin/bash
set -euo pipefail
set -a; . APPDIR/apps/backend/.env; set +a
mkdir -p /var/backups/adia
pg_dump "$DATABASE_URL" | gzip > /var/backups/adia/adia_erp_STAMP.sql.gz
ls -lh /var/backups/adia/adia_erp_STAMP.sql.gz
cp -a APPDIR/apps/backend/dist  APPDIR/apps/backend/dist.bak-STAMP
cp -a APPDIR/apps/frontend/dist APPDIR/apps/frontend/dist.bak-STAMP
echo "dist zaxiralandi: dist.bak-STAMP"

# The SFTP upload runs as `ubuntu`, so a single root-owned leftover aborts it
# with EACCES partway through, leaving half the bundle replaced. That happened
# on 2026-09-11: dist/lib/navPaths.* had been written by a root-run build, and
# the upload died on it after 111 files. Take ownership BEFORE uploading — the
# restart phase already does it afterwards, which is too late to help.
chown -R ubuntu:ubuntu APPDIR/apps/backend/dist APPDIR/apps/frontend/dist
echo "egalik ubuntu:ubuntu ga o'tkazildi (yuklashdan oldin)"
""".replace("APPDIR", APP_DIR).replace("STAMP", STAMP))
if run('/tmp/adia_backup.sh') != 0:
    client.close(); sys.exit("ERROR: backup muvaffaqiyatsiz — deploy to'xtatildi.")

phase("2/5 — Backend dist yuklash")
upload_dir(BACKEND_DIST, APP_DIR + "/apps/backend/dist", "backend")
phase("3/5 — Frontend dist yuklash")
upload_dir(FRONTEND_DIST, APP_DIR + "/apps/frontend/dist", "frontend")

phase("4/5 — Toza restart")
put('/tmp/adia_restart.sh', """#!/bin/bash
set -uo pipefail
chown -R ubuntu:ubuntu APPDIR/apps/backend/dist APPDIR/apps/frontend/dist

# The app is owned by pm2-ubuntu.service (PM2 daemon running as `ubuntu`).
# root's PM2 is an empty leftover from an earlier setup — talking to it used to
# leave a duplicate registration fighting for :3001 with EADDRINUSE.
echo "--- oldin ---"
sudo -u ubuntu pm2 list --no-color 2>&1 | sed -n '3,6p'

sudo -u ubuntu pm2 restart adia-backend --update-env --no-color 2>&1 | tail -4
sudo -u ubuntu pm2 reset adia-backend >/dev/null 2>&1 || true
sleep 3
echo "--- keyin ---"
ss -lptnH 'sport = :3001' || echo "(port bosh!)"
""".replace("APPDIR", APP_DIR))
run('/tmp/adia_restart.sh', timeout=300)

phase("5/5 — Tekshiruv")
put('/tmp/adia_verify.sh', """#!/bin/bash
set -uo pipefail
ok=0
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3001/health || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
echo "--- health ---"; curl -s -m 10 http://localhost:3001/health; echo
echo "--- pm2 ---"; sudo -u ubuntu pm2 list --no-color 2>&1 | head -8
if [ "$ok" != "1" ]; then echo "OGOHLANTIRISH: health 200 bermadi"; exit 1; fi
""")
rc = run('/tmp/adia_verify.sh', timeout=180)
sftp.close(); client.close()
print("\n" + "="*62)
print("[TUGADI] Deploy muvaffaqiyatli." if rc == 0 else "[DIQQAT] health tekshiruvi o'tmadi.")
print("[ROLLBACK] dist.bak-" + STAMP + " · DB: /var/backups/adia/adia_erp_" + STAMP + ".sql.gz")
