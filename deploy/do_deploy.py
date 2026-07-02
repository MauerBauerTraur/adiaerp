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
import os, sys, time, argparse, base64
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
DOMAIN     = cfg.get('DOMAIN', '')          # e.g. adia.uz (bo'sh = IP ishlatiladi)
EMAIL      = cfg.get('EMAIL', '')           # Let's Encrypt uchun
DB_URL     = cfg['DATABASE_URL']
JWT_SEC    = cfg['JWT_SECRET']

# Frontendda ishlatiladigan public URL (domen yoki IP)
PUBLIC_URL = f"https://{DOMAIN}" if DOMAIN else f"http://{SERVER_IP}"

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
            sys.stdout.buffer.write(chan.recv(4096))
            sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    if check and rc != 0:
        sys.stdout.buffer.write(f"\n[ERROR] exit code {rc}\n".encode())
        sys.stdout.buffer.flush()
        sys.exit(rc)
    return rc

def write_file(client: paramiko.SSHClient, path: str, content: str) -> None:
    """Base64 orqali remote faylga yozadi (quoting xatosiz)."""
    b64 = base64.b64encode(content.encode()).decode()
    run(client, f"mkdir -p $(dirname {path}) && echo '{b64}' | base64 -d > {path}")
    print(f"[FILE] {path}")

# ── Generated config strings (values come from .env.deploy) ──────
def backend_env() -> str:
    return f"""NODE_ENV=production
PORT=3001
WEB_ORIGIN={PUBLIC_URL}
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
    return f"VITE_API_BASE_URL={PUBLIC_URL}\n"

def nginx_conf() -> str:
    server_name = f"{DOMAIN} www.{DOMAIN}" if DOMAIN else f"{SERVER_IP} _"
    return f"""server {{
    listen 80;
    server_name {server_name};
    root {APP_DIR}/apps/frontend/dist;
    index index.html;
    location /api/ {{
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 600s;
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
    cwd: '{APP_DIR}/apps/backend',
    instances: 1,
    restart_delay: 3000,
    max_restarts: 10,
    env: {{ NODE_ENV: 'production', PORT: 3001 }}
  }}]
}};
"""

# ── User yaratish ────────────────────────────────────────────────
def create_user(client: paramiko.SSHClient,
                name: str, username: str, password: str, role: str) -> None:
    """Bcrypt hash generatsiya qilib, users jadvaliga qo'shadi (idempotent).
    write_file (base64) ishlatiladi — quoting muammosi yo'q."""
    import urllib.parse
    db_name = urllib.parse.urlparse(DB_URL).path.lstrip('/')

    # Node.js skripti: hash + SQL INSERT barchasini ichida bajaradi
    js = (
        f"const b=require('{APP_DIR}/node_modules/bcryptjs');\n"
        f"const {{execSync,spawnSync}}=require('child_process');\n"
        f"const fs=require('fs');\n"
        f"b.hash('{password}',10).then(h=>{{\n"
        f"  const sql=`INSERT INTO users (name,username,password_hash,role,is_active)`\n"
        f"    +` VALUES ('{name}','{username}','${{h}}','{role}',true)`\n"
        f"    +` ON CONFLICT (username) DO UPDATE`\n"
        f"    +`   SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,`\n"
        f"    +`       role=EXCLUDED.role,is_active=true`\n"
        f"    +` RETURNING id,name,username,role;`;\n"
        f"  fs.writeFileSync('/tmp/_user.sql',sql);\n"
        f"  const r=spawnSync('sudo',['-u','postgres','psql','-d','{db_name}','-f','/tmp/_user.sql'],{{stdio:'inherit'}});\n"
        f"  fs.unlinkSync('/tmp/_user.sql');\n"
        f"  if(r.status!==0)process.exit(r.status||1);\n"
        f"}});\n"
    )
    write_file(client, '/tmp/_create_user.js', js)
    run(client, 'node /tmp/_create_user.js && rm -f /tmp/_create_user.js')
    print(f"[USER] {username} ({role}) tayyor")

# ── SSL (Let's Encrypt) setup ─────────────────────────────────────
def setup_ssl(client: paramiko.SSHClient) -> None:
    """certbot orqali HTTPS sertifikat oladi va nginx ni yangilaydi."""
    if not DOMAIN:
        print("[SSL] DOMAIN .env.deploy da ko'rsatilmagan — o'tkazib yuborildi")
        return

    print(f"\n=== SSL sozlamoqda: {DOMAIN} ===\n")

    # Nginx ni domen bilan yangilash (certbot HTTP challenge uchun)
    write_file(client, "/etc/nginx/sites-available/adia-erp", nginx_conf())
    run(client,
        "ln -sf /etc/nginx/sites-available/adia-erp /etc/nginx/sites-enabled/adia-erp && "
        "rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx")

    # certbot o'rnatish
    run(client, "apt-get install -y certbot python3-certbot-nginx", timeout=120)

    # Sertifikat olish + nginx avtomatik HTTPS redirect
    run(client,
        f"certbot --nginx -d {DOMAIN} -d www.{DOMAIN} "
        f"--non-interactive --agree-tos -m {EMAIL} --redirect",
        timeout=120)

    # Avtomatik yangilanish crond
    run(client, "systemctl enable certbot.timer 2>/dev/null || "
                "(crontab -l 2>/dev/null; echo '0 3 * * * certbot renew --quiet') | crontab -",
        check=False)

    print(f"\n=== SSL tayyor! https://{DOMAIN} ===\n")

# ── PostgreSQL DB setup ──────────────────────────────────────────
def setup_db(client: paramiko.SSHClient) -> None:
    """Create/reset PostgreSQL user and database (idempotent)."""
    import urllib.parse
    parsed = urllib.parse.urlparse(DB_URL)
    db_name = parsed.path.lstrip('/')
    db_user = parsed.username or ''
    db_pass = parsed.password or ''

    sql = f"""
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{db_user}') THEN
    CREATE USER {db_user} WITH PASSWORD '{db_pass}';
  ELSE
    ALTER USER {db_user} WITH PASSWORD '{db_pass}';
  END IF;
END
$$;
"""
    write_file(client, '/tmp/adia_setup_db.sql', sql)
    run(client, f"sudo -u postgres createdb {db_name} 2>/dev/null || true")
    run(client, f"sudo -u postgres psql -f /tmp/adia_setup_db.sql")
    run(client, f"sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE {db_name} TO {db_user};\"")
    run(client, f"sudo -u postgres psql -c \"ALTER DATABASE {db_name} OWNER TO {db_user};\"")
    run(client, "rm -f /tmp/adia_setup_db.sql")
    print(f"[DB] {db_name} user={db_user} tayyor")

# ── First-run setup ──────────────────────────────────────────────
def first_run(client: paramiko.SSHClient) -> None:
    print("\n=== FIRST RUN: server sozlamoqda ===\n")

    # DB user + database
    setup_db(client)

    # Clone repo
    run(client, f"test -d {APP_DIR}/.git || git clone https://github.com/MauerBauerTraur/adiaerp.git {APP_DIR}")

    # Write config files via base64
    write_file(client, f"{APP_DIR}/apps/backend/.env",  backend_env())
    write_file(client, f"{APP_DIR}/apps/frontend/.env", frontend_env())
    write_file(client, f"{APP_DIR}/ecosystem.config.js", pm2_ecosystem())

    # Nginx config
    write_file(client, "/etc/nginx/sites-available/adia-erp", nginx_conf())
    run(client,
        f"ln -sf /etc/nginx/sites-available/adia-erp /etc/nginx/sites-enabled/adia-erp && "
        f"rm -f /etc/nginx/sites-enabled/default && nginx -t && "
        f"systemctl restart nginx && systemctl enable nginx")

    print("\n=== First-run sozlash tugadi ===\n")

# ── Main deploy ──────────────────────────────────────────────────
def deploy(client: paramiko.SSHClient) -> None:
    print("\n=== Deploy boshlandi ===\n")

    # 1. Pull latest code
    run(client, f"cd {APP_DIR} && git pull origin master")
    run(client, f"cd {APP_DIR} && npm install --workspaces --if-present", timeout=300)

    # 2. Build backend on server (fast, ~5s)
    run(client, f"cd {APP_DIR} && npm run build -w @adia/backend", timeout=180)

    # 3. Frontend: build LOCALLY then SFTP-upload dist to avoid OOM on server.
    #    Server RAM (~1GB) is too small for vite build. We call upload_frontend()
    #    after the SSH session so the connection isn't held open during upload.
    print("[deploy] Frontend mahalliy build qilinadi va SFTP orqali yuklanadi...")

    # 4. Migrate + restart PM2
    run(client, f"cd {APP_DIR}/apps/backend && npm run migrate")
    run(client,
        f"cd {APP_DIR} && pm2 stop adia-backend 2>/dev/null; "
        f"pm2 delete adia-backend 2>/dev/null; "
        f"pm2 start ecosystem.config.js && pm2 save",
        check=False)

    print(f"\n=== Backend deploy MUVAFFAQIYATLI! URL: http://{SERVER_IP} ===")
    run(client, "pm2 list", check=False)
    print("\n[deploy] Endi frontend dist yuklanadi (SFTP)...")

# ── Entry point ──────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="ADIA ERP deploy")
    parser.add_argument('--first-run', action='store_true',
                        help='Birinchi marta: repo clone, .env, nginx, pm2 setup')
    parser.add_argument('--setup-db', action='store_true',
                        help='PostgreSQL user/DB sozla (parol tiklash uchun)')
    parser.add_argument('--setup-ssl', action='store_true',
                        help="Let's Encrypt SSL sertifikat olish + nginx HTTPS")
    parser.add_argument('--list-users', action='store_true',
                        help='DB dagi barcha userlarni ko\'rsatish')
    parser.add_argument('--fix-pm2', action='store_true',
                        help='ecosystem.config.js cwd tuzat + PM2 restart')
    parser.add_argument('--create-user', nargs=4,
                        metavar=('NAME', 'USERNAME', 'PASSWORD', 'ROLE'),
                        help='Foydalanuvchi yaratish: NAME USERNAME PASSWORD ROLE')
    args = parser.parse_args()

    client = connect()
    try:
        if args.first_run:
            first_run(client)
        elif args.setup_db:
            setup_db(client)
            return
        elif args.setup_ssl:
            setup_ssl(client)
            deploy(client)
            return
        elif args.list_users:
            import urllib.parse
            db_name = urllib.parse.urlparse(DB_URL).path.lstrip('/')
            run(client,
                f"sudo -u postgres psql -d {db_name} -c "
                f"'SELECT id, name, username, role, is_active FROM users ORDER BY id;'",
                check=False)
            return
        elif args.fix_pm2:
            write_file(client, f"{APP_DIR}/ecosystem.config.js", pm2_ecosystem())
            run(client,
                f"pm2 stop adia-backend 2>/dev/null; pm2 delete adia-backend 2>/dev/null; "
                f"cd {APP_DIR} && pm2 start ecosystem.config.js && pm2 save",
                check=False)
            run(client, "pm2 list", check=False)
            return
        elif args.create_user:
            name, username, password, role = args.create_user
            create_user(client, name, username, password, role)
            return
        deploy(client)
    finally:
        client.close()

    # Frontend dist upload — runs AFTER SSH session closes to avoid OOM on server.
    # Builds locally (vite) then SFTPs the dist folder.
    import subprocess, sys as _sys
    upload_script = Path(__file__).parent / "upload_frontend.py"
    if upload_script.exists():
        print("\n[deploy] Frontend dist yuklanmoqda (SFTP)...")
        result = subprocess.run(
            [_sys.executable, str(upload_script)],
            capture_output=False,
        )
        if result.returncode != 0:
            print("[deploy] WARN: frontend upload muvaffaqiyatsiz bo'ldi.")
    print(f"\n=== Deploy tugadi! ===")

if __name__ == '__main__':
    main()
