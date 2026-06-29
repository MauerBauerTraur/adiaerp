#!/usr/bin/env python3
"""
ADIA ERP — Deploy script (Tatavtoplast uslubida)

Birinchi marta:
  python deploy/do_deploy.py --first-run

Keyingi deploylar:
  python deploy/do_deploy.py

Nima qiladi:
  1. Serverga SSH ulanadi (kalit yoki parol — .env.deploy dan)
  2. --first-run: .env, nginx, pm2 setup
  3. git pull → npm install → build → migrate → pm2 restart

Barcha credentials deploy/.env.deploy da (git'ga kirmaydi).
"""
import os, sys, time, argparse
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("pip install paramiko")
    sys.exit(1)

# ── Credentials (.env.deploy dan o'qiladi) ───────────────────────
CFG_FILE = Path(__file__).parent / ".env.deploy"
if not CFG_FILE.exists():
    print(f"""
ERROR: {CFG_FILE} topilmadi.
Yaratish uchun:
  cp deploy/.env.deploy.example deploy/.env.deploy
Va to'ldiring.
""")
    sys.exit(1)

cfg: dict[str, str] = {}
for line in CFG_FILE.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('=')
        cfg[k.strip()] = v.strip()

HOST       = cfg['HOST']
USER       = cfg.get('USER', 'ubuntu')
PASSWORD   = cfg.get('PASSWORD', '')
SSH_KEY    = cfg.get('SSH_KEY', '')
APP_DIR    = cfg.get('APP_DIR', '/opt/adia-erp')
SERVER_IP  = cfg.get('SERVER_IP', HOST)
DB_URL     = cfg['DATABASE_URL']
JWT_SEC    = cfg['JWT_SECRET']

# Poster / Telegram — barcha secrets .env.deploy dan
POSTER_ACCOUNT       = cfg.get('POSTER_ACCOUNT', '')
POSTER_APP_ID        = cfg.get('POSTER_APP_ID', '')
POSTER_APP_SECRET    = cfg.get('POSTER_APP_SECRET', '')
POSTER_TOKEN         = cfg.get('POSTER_TOKEN', '')
BOT_TOKEN            = cfg.get('BOT_TOKEN', '')
BOT_USERNAME         = cfg.get('BOT_USERNAME', '')
VERTEX_PROJECT_ID    = cfg.get('VERTEX_PROJECT_ID', '')
VERTEX_REGION        = cfg.get('VERTEX_REGION', 'europe-west1')
VERTEX_MODEL         = cfg.get('VERTEX_MODEL', 'gemini-2.5-flash')
FORECASTER_URL       = cfg.get('FORECASTER_URL', '')
FORECASTER_SECRET    = cfg.get('FORECASTER_SHARED_SECRET', '')

# ── SSH connect ──────────────────────────────────────────────────
def connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if SSH_KEY and Path(SSH_KEY).expanduser().exists():
        client.connect(HOST, username=USER, key_filename=str(Path(SSH_KEY).expanduser()), timeout=30)
        print(f"[SSH] {USER}@{HOST} (kalit)")
    else:
        client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
        print(f"[SSH] {USER}@{HOST} (parol)")
    return client

def run(client: paramiko.SSHClient, cmd: str, timeout: int = 600, check: bool = True) -> int:
    chan = client.get_transport().open_session()  # type: ignore[union-attr]
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    while True:
        if chan.recv_ready():
            print(chan.recv(4096).decode('utf-8', errors='replace'), end='', flush=True)
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    if check and rc != 0:
        print(f"\n[ERROR] exit code {rc}")
        sys.exit(rc)
    return rc

# ── Generated config strings (values come from .env.deploy) ──────
def backend_env() -> str:
    return f"""NODE_ENV=production
PORT=3001
WEB_ORIGIN=http://{SERVER_IP}
DATABASE_URL={DB_URL}
JWT_SECRET={JWT_SEC}
JWT_ACCESS_TTL_SECONDS=3600
JWT_REFRESH_TTL_DAYS=30
POSTER_ACCOUNT={POSTER_ACCOUNT}
POSTER_APP_ID={POSTER_APP_ID}
POSTER_APP_SECRET={POSTER_APP_SECRET}
POSTER_TOKEN={POSTER_TOKEN}
BOT_TOKEN={BOT_TOKEN}
BOT_USERNAME={BOT_USERNAME}
GOOGLE_APPLICATION_CREDENTIALS=
VERTEX_PROJECT_ID={VERTEX_PROJECT_ID}
VERTEX_REGION={VERTEX_REGION}
VERTEX_MODEL={VERTEX_MODEL}
FORECASTER_URL={FORECASTER_URL}
FORECASTER_SHARED_SECRET={FORECASTER_SECRET}
"""

def frontend_env() -> str:
    return f"VITE_API_BASE_URL=http://{SERVER_IP}\n"

def nginx_conf() -> str:
    return f"""server {{
    listen 80;
    server_name {SERVER_IP} _;
    root {APP_DIR}/apps/frontend/dist;
    index index.html;
    location /api/ {{
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }}
    location / {{ try_files $uri $uri/ /index.html; }}
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}}
"""

def pm2_ecosystem() -> str:
    return f"""module.exports = {{
  apps: [{{
    name: 'adia-backend',
    script: '{APP_DIR}/apps/backend/dist/server.js',
    cwd: '{APP_DIR}',
    instances: 1,
    restart_delay: 3000,
    max_restarts: 10,
    env: {{ NODE_ENV: 'production', PORT: 3001 }}
  }}]
}};
"""

# ── First-run setup ──────────────────────────────────────────────
def first_run(client: paramiko.SSHClient) -> None:
    print("\n=== FIRST RUN: server sozlamoqda ===\n")

    # Clone repo
    run(client, f"test -d {APP_DIR}/.git || git clone https://github.com/MauerBauerTraur/adiaerp.git {APP_DIR}")

    # Write config files
    for content, path in [
        (backend_env(),   f"{APP_DIR}/apps/backend/.env"),
        (frontend_env(),  f"{APP_DIR}/apps/frontend/.env"),
        (pm2_ecosystem(), f"{APP_DIR}/ecosystem.config.js"),
    ]:
        # Use printf to avoid heredoc issues
        escaped = content.replace("'", "'\\''")
        run(client, f"mkdir -p $(dirname {path}) && printf '%s' '{escaped}' > {path}")

    # Nginx
    escaped_nginx = nginx_conf().replace("'", "'\\''")
    run(client, f"printf '%s' '{escaped_nginx}' > /etc/nginx/sites-available/adia-erp && "
                f"ln -sf /etc/nginx/sites-available/adia-erp /etc/nginx/sites-enabled/adia-erp && "
                f"rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl restart nginx && systemctl enable nginx")

    print("\n=== First-run sozlash tugadi ===\n")

# ── Main deploy ──────────────────────────────────────────────────
def deploy(client: paramiko.SSHClient) -> None:
    print("\n=== Deploy boshlandi ===\n")

    run(client, f"cd {APP_DIR} && git pull origin master")
    run(client, f"cd {APP_DIR} && npm install", timeout=300)
    run(client, f"cd {APP_DIR} && npm run build -w @adia/backend", timeout=180)
    run(client, f"cd {APP_DIR} && npm run build -w @adia/frontend", timeout=180)
    run(client, f"cd {APP_DIR}/apps/backend && npm run migrate")
    run(client,
        f"cd {APP_DIR} && pm2 stop adia-backend 2>/dev/null; "
        f"pm2 delete adia-backend 2>/dev/null; "
        f"pm2 start ecosystem.config.js && pm2 save",
        check=False)

    print(f"\n=== Deploy MUVAFFAQIYATLI! URL: http://{SERVER_IP} ===")
    run(client, "pm2 list", check=False)

# ── Entry point ──────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="ADIA ERP deploy")
    parser.add_argument('--first-run', action='store_true',
                        help='Birinchi marta: repo clone, .env, nginx, pm2 setup')
    args = parser.parse_args()

    client = connect()
    try:
        if args.first_run:
            first_run(client)
        deploy(client)
    finally:
        client.close()

if __name__ == '__main__':
    main()
