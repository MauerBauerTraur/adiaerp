#!/usr/bin/env python3
"""Deploy: upload productionOrders.ts backend fix + rebuild frontend + upload dist."""
import io, sys, time, subprocess, shutil
from pathlib import Path
try:
    import paramiko
except ImportError:
    print("pip install paramiko"); sys.exit(1)

ROOT   = Path(__file__).parent.parent
CFG    = Path(__file__).parent / '.env.deploy'

cfg = {}
for line in CFG.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

HOST    = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', '')
APP_DIR = cfg.get('APP_DIR', '/opt/adia-erp')

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
    if txt.strip():
        sys.stdout.buffer.write(txt.encode(sys.stdout.encoding or 'utf-8', errors='replace') + b'\n')
        sys.stdout.buffer.flush()
    if check and rc != 0:
        print(f'[ERROR] exit={rc}'); sys.exit(rc)
    return rc

def upload(local: Path, remote: str):
    tmp = '/tmp/_upload_tmp'
    sftp = c.open_sftp()
    sftp.putfo(io.BytesIO(local.read_bytes()), tmp)
    sftp.close()
    run(f'cp {tmp} {remote} && rm -f {tmp}')
    print(f'  Uploaded: {local.name} -> {remote}')

# 1. Upload changed backend files
print('\n=== 1. Upload backend files ===')
upload(
    ROOT / 'apps/backend/src/routes/productionOrders.ts',
    f'{APP_DIR}/apps/backend/src/routes/productionOrders.ts',
)
upload(
    ROOT / 'apps/backend/src/services/notify.ts',
    f'{APP_DIR}/apps/backend/src/services/notify.ts',
)

# 2. Build backend
print('\n=== 2. Build backend ===')
run(f'cd {APP_DIR} && npm run build -w @adia/backend', timeout=180)

# 3. Restart PM2
print('\n=== 3. Restart PM2 ===')
run('pm2 restart adia-backend', check=False)
time.sleep(2)
run('pm2 list', check=False)

c.close()

# 4. Build frontend locally
print('\n=== 4. Build frontend locally ===')
env_file = ROOT / 'apps/frontend/.env'
vite_api = cfg.get('VITE_API_BASE_URL', f"https://{cfg.get('DOMAIN', cfg.get('HOST', ''))}")
env_file.write_text(f'VITE_API_BASE_URL={vite_api}\n')
result = subprocess.run(
    ['npm', 'run', 'build', '-w', '@adia/frontend'],
    cwd=str(ROOT),
    capture_output=False,
)
if result.returncode != 0:
    print('[ERROR] Frontend build failed'); sys.exit(1)

# 5. Upload frontend dist
print('\n=== 5. Upload frontend dist via SFTP ===')
upload_script = Path(__file__).parent / 'upload_dist.py'
if upload_script.exists():
    result = subprocess.run([sys.executable, str(upload_script)], capture_output=False)
    if result.returncode != 0:
        print('[WARN] Frontend dist upload failed')
else:
    print('[WARN] upload_dist.py not found — upload frontend manually')

print('\nDone! All fixes deployed.')
