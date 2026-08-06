#!/usr/bin/env python3
"""
Deploy: Ostatka hisoboti -> Omborlar qoldig'i view.

Backend: stock.ts + new GET /api/stock/finished-by-location endpoint
Frontend: StockReportPage.tsx -> viewMode toggle + new table
No SQL migration needed (uses existing stock/products/locations tables).
"""
import io, sys, time, subprocess
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("pip install paramiko"); sys.exit(1)

ROOT = Path(__file__).parent.parent
CFG  = Path(__file__).parent / '.env.deploy'
cfg: dict[str, str] = {}
for line in CFG.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('=')
        cfg[k.strip()] = v.strip()

HOST     = cfg['HOST']
USER     = cfg.get('USER', 'ubuntu')
PASSWORD = cfg.get('PASSWORD', '')
SSH_KEY  = cfg.get('SSH_KEY', '')
APP_DIR  = cfg.get('APP_DIR', '/opt/adia-erp')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
if SSH_KEY and Path(SSH_KEY).expanduser().exists():
    c.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
    print(f"[SSH] {USER}@{HOST} (kalit)")
else:
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    print(f"[SSH] {USER}@{HOST} (parol)")

def run(cmd: str, timeout: int = 300, check: bool = True) -> int:
    chan = c.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f'sudo bash -c {repr(cmd)}')
    out = b''
    while True:
        if chan.recv_ready():
            out += chan.recv(8192)
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    txt = out.decode('utf-8', errors='replace')
    if txt.strip():
        sys.stdout.buffer.write(txt.encode(sys.stdout.encoding or 'utf-8', errors='replace') + b'\n')
        sys.stdout.buffer.flush()
    if check and rc != 0:
        print(f'[ERROR] exit={rc}')
        sys.exit(rc)
    return rc

def upload_file(local: Path, remote: str) -> None:
    tmp = '/tmp/_adia_upload_tmp'
    sftp = c.open_sftp()
    sftp.putfo(io.BytesIO(local.read_bytes()), tmp)
    sftp.close()
    run(f'cp {tmp} {remote} && rm -f {tmp}')
    print(f'  Uploaded: {local.name} -> {remote}')

# 1. Backend
print('\n=== 1. Upload backend: stock.ts ===')
upload_file(
    ROOT / 'apps/backend/src/routes/stock.ts',
    f'{APP_DIR}/apps/backend/src/routes/stock.ts',
)

print('\n=== 2. Build backend ===')
run(f'cd {APP_DIR} && npm run build -w @adia/backend', timeout=180)

print('\n=== 3. PM2 restart ===')
run('pm2 restart adia-backend', check=False)
time.sleep(4)
run('pm2 list', check=False)

c.close()
print('\n[backend] OK')

# 2. Frontend
print('\n=== 4. Frontend mahalliy build ===')
frontend_dir = ROOT / 'apps' / 'frontend'
result = subprocess.run(
    ['npm', 'run', 'build'],
    cwd=str(frontend_dir),
    shell=True,
)
if result.returncode != 0:
    print('[ERROR] Frontend build muvaffaqiyatsiz.')
    sys.exit(1)

local_dist = frontend_dir / 'dist'
if not local_dist.exists():
    print(f'[ERROR] {local_dist} topilmadi.')
    sys.exit(1)

print('\n=== 5. Frontend dist -> SFTP upload ===')
c2 = paramiko.SSHClient()
c2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
if SSH_KEY and Path(SSH_KEY).expanduser().exists():
    c2.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
else:
    c2.connect(HOST, username=USER, password=PASSWORD, timeout=30)

remote_dist = f'{APP_DIR}/apps/frontend/dist'
stdin, stdout, stderr = c2.exec_command(f'sudo rm -rf {remote_dist} && sudo mkdir -p {remote_dist}')
stdout.channel.recv_exit_status()

sftp2 = c2.open_sftp()

def sftp_mkdir_p(sftp: paramiko.SFTPClient, path: str) -> None:
    parts = path.split('/')
    cur = ''
    for part in parts:
        if not part:
            cur = '/'
            continue
        cur = cur.rstrip('/') + '/' + part
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)

def upload_dir(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    sftp_mkdir_p(sftp, remote)
    for item in sorted(local.iterdir()):
        rdest = remote.rstrip('/') + '/' + item.name
        if item.is_dir():
            upload_dir(sftp, item, rdest)
        else:
            sftp.put(str(item), rdest)
            print(f'  {item.relative_to(local_dist)}')

upload_dir(sftp2, local_dist, remote_dist)
sftp2.close()
c2.exec_command(f'sudo chmod -R 755 {remote_dist}')
c2.close()

total = sum(1 for f in local_dist.rglob('*') if f.is_file())
print(f'\n[frontend] OK {total} fayl yuklandi')
print('\n=== Deploy muvaffaqiyatli tugadi! ===')
