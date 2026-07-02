#!/usr/bin/env python3
"""
Upload locally-built frontend dist to server via SFTP.
Reads credentials from deploy/.env.deploy (same as do_deploy.py).
Usage: python deploy/upload_frontend.py
"""
import os, sys, stat
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

LOCAL_DIST  = Path(__file__).parent.parent / "apps" / "frontend" / "dist"
REMOTE_DIST = f"{APP_DIR}/apps/frontend/dist"

def connect_sftp():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if SSH_KEY and Path(SSH_KEY).expanduser().exists():
        client.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
        print(f"[SSH] {USER}@{HOST} (kalit)")
    else:
        client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
        print(f"[SSH] {USER}@{HOST} (parol)")
    return client, client.open_sftp()

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

def upload_dir(sftp, local_dir: Path, remote_dir: str):
    sftp_mkdir_p(sftp, remote_dir)
    for item in sorted(local_dir.iterdir()):
        remote_item = remote_dir.rstrip('/') + '/' + item.name
        if item.is_dir():
            upload_dir(sftp, item, remote_item)
        else:
            sftp.put(str(item), remote_item)
            print(f"  {item.name}")

def main():
    # Build frontend locally first
    import subprocess
    frontend_dir = LOCAL_DIST.parent
    print(f"Frontend build boshlandi: {frontend_dir}")
    result = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(frontend_dir),
        shell=True,
    )
    if result.returncode != 0:
        print("ERROR: Frontend build muvaffaqiyatsiz bo'ldi.")
        sys.exit(1)

    if not LOCAL_DIST.exists():
        print(f"ERROR: {LOCAL_DIST} topilmadi.")
        sys.exit(1)

    print(f"Ulanmoqda {HOST}...")
    ssh, sftp = connect_sftp()
    try:
        print(f"\nYuklanyapti: {LOCAL_DIST} -> {REMOTE_DIST}")
        # Delete remote dist and re-upload to avoid stale files
        stdin, stdout, stderr = ssh.exec_command(f"rm -rf {REMOTE_DIST} && mkdir -p {REMOTE_DIST}")
        stdout.channel.recv_exit_status()
        upload_dir(sftp, LOCAL_DIST, REMOTE_DIST)
        # Fix permissions so nginx can read
        ssh.exec_command(f"chmod -R 755 {REMOTE_DIST}")
        print(f"\nMuvaffaqiyatli yuklandi! Jami: {sum(1 for _ in LOCAL_DIST.rglob('*') if _.is_file())} fayl")
    finally:
        sftp.close()
        ssh.close()

if __name__ == '__main__':
    main()
