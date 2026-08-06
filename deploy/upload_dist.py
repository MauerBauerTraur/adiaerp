#!/usr/bin/env python3
"""
ADIA ERP — mahalliy build'ni serverga yuklash.
Backend va frontend dist'larini /tmp orqali sudo cp bilan /opt/adia-erp ga joylashtiradi.
Usage: python deploy/upload_dist.py [--backend-only | --frontend-only]
"""
import os, sys, time, argparse
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
APP_DIR  = cfg.get('APP_DIR', '/opt/adia-erp')

ROOT = Path(__file__).parent.parent
BACKEND_DIST  = ROOT / "apps" / "backend" / "dist"
FRONTEND_DIST = ROOT / "apps" / "frontend" / "dist"

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

def run(client, cmd: str, timeout: int = 300):
    """sudo bash -c cmd, PTY bilan."""
    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    while True:
        if chan.recv_ready():
            chunk = chan.recv(4096)
            out += chunk
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    return rc

def sftp_mkdir_p(sftp, remote_path: str):
    parts = remote_path.split('/')
    current = ''
    for part in parts:
        if not part:
            current = '/'
            continue
        current = current.rstrip('/') + '/' + part
        try:
            sftp.stat(current)
        except FileNotFoundError:
            sftp.mkdir(current)

def upload_dir(sftp, local_dir: Path, remote_dir: str, label: str = ""):
    sftp_mkdir_p(sftp, remote_dir)
    count = 0
    for item in sorted(local_dir.rglob('*')):
        if item.is_file():
            rel = item.relative_to(local_dir)
            remote_path = remote_dir.rstrip('/') + '/' + str(rel).replace('\\', '/')
            parent = remote_path.rsplit('/', 1)[0]
            try:
                sftp.stat(parent)
            except FileNotFoundError:
                sftp_mkdir_p(sftp, parent)
            sftp.put(str(item), remote_path)
            count += 1
            if count % 20 == 0:
                print(f"  {label} {count} fayl yuklandi...")
    print(f"  {label} jami {count} fayl yuklandi.")
    return count

def deploy_backend(client, sftp):
    if not BACKEND_DIST.exists():
        print(f"ERROR: {BACKEND_DIST} topilmadi. Avval build qiling.")
        return
    target = f"{APP_DIR}/apps/backend/dist"
    print(f"\n[Backend] {BACKEND_DIST} -> {target}")
    print("  SFTP yuklanyapti...")
    upload_dir(sftp, BACKEND_DIST, target, "backend")
    print("  PM2 restart...")
    run(client, "pm2 restart adia-backend", timeout=30)
    print("[Backend] MUVAFFAQIYATLI!")

def deploy_frontend(client, sftp):
    if not FRONTEND_DIST.exists():
        print(f"ERROR: {FRONTEND_DIST} topilmadi. Avval build qiling.")
        return
    target = f"{APP_DIR}/apps/frontend/dist"
    print(f"\n[Frontend] {FRONTEND_DIST} -> {target}")
    print("  SFTP yuklanyapti...")
    upload_dir(sftp, FRONTEND_DIST, target, "frontend")
    print("[Frontend] MUVAFFAQIYATLI!")

def main():
    parser = argparse.ArgumentParser(description="ADIA ERP dist yuklash")
    parser.add_argument('--backend-only', action='store_true')
    parser.add_argument('--frontend-only', action='store_true')
    args = parser.parse_args()

    client = connect()
    sftp = client.open_sftp()
    try:
        if args.backend_only:
            deploy_backend(client, sftp)
        elif args.frontend_only:
            deploy_frontend(client, sftp)
        else:
            deploy_backend(client, sftp)
            deploy_frontend(client, sftp)
    finally:
        sftp.close()
        client.close()

    print("\n=== Deploy tugadi! ===")

if __name__ == '__main__':
    main()
