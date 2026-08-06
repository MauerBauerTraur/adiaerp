#!/usr/bin/env python3
"""Upload local stock.ts (with closing_qty double-count fix) to server and rebuild."""
import io, sys, time
from pathlib import Path
try:
    import paramiko
except ImportError:
    print("pip install paramiko"); sys.exit(1)

LOCAL  = Path(__file__).parent.parent / 'apps/backend/src/routes/stock.ts'
CFG    = Path(__file__).parent / '.env.deploy'

cfg = {}
for line in CFG.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

HOST    = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', '')
APP_DIR = cfg.get('APP_DIR', '/opt/adia-erp')
REMOTE  = f'{APP_DIR}/apps/backend/src/routes/stock.ts'

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='ubuntu', password=PASSWORD, timeout=30)
print("SSH OK")

def run(cmd, timeout=300, check=True):
    chan = c.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f'sudo bash -c {repr(cmd)}')
    out = b''
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    txt = out.decode('utf-8', errors='replace')
    if txt.strip(): sys.stdout.buffer.write(txt.encode(sys.stdout.encoding or 'utf-8', errors='replace') + b'\n')
    if check and rc != 0:
        print(f'[ERROR] exit={rc}'); sys.exit(rc)
    return rc

# 1. Upload to /tmp (ubuntu can write there), then sudo cp
content = LOCAL.read_bytes()
TMP = '/tmp/_stock_ts_upload.ts'
print(f'Uploading stock.ts ({len(content)} bytes) to /tmp...')
sftp = c.open_sftp()
sftp.putfo(io.BytesIO(content), TMP)
sftp.close()
run(f'cp {TMP} {REMOTE} && rm -f {TMP}')

# 2. Verify closing_qty line
run(f'grep -n "closing_qty" {REMOTE} | head -8')

# 3. Build
print('\n=== npm run build ===')
run(f'cd {APP_DIR} && npm run build -w @adia/backend', timeout=180)

# 4. Restart
print('\n=== pm2 restart ===')
run('pm2 restart adia-backend', check=False)
time.sleep(2)
run('pm2 list', check=False)

c.close()
print('\nDone. Monthly Qoldiq double-count fix deployed.')
