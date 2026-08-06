#!/usr/bin/env python3
"""
ADIA ERP — serverda bitta migration SQL faylini ishga tushirish.
Usage: python deploy/run_migration.py <migration_file.sql>
"""
import os, sys
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("pip install paramiko")
    sys.exit(1)

if len(sys.argv) < 2:
    print("Usage: python deploy/run_migration.py <migrations/0055_fix_modification_sales.sql>")
    sys.exit(1)

SQL_FILE = Path(sys.argv[1])
if not SQL_FILE.is_absolute():
    SQL_FILE = Path(__file__).parent.parent / SQL_FILE
if not SQL_FILE.exists():
    print(f"ERROR: {SQL_FILE} topilmadi.")
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
ENV_PATH = f"{APP_DIR}/apps/backend/.env"

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

def run(client, cmd: str, timeout: int = 60):
    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    import time
    while True:
        if chan.recv_ready():
            chunk = chan.recv(4096)
            out += chunk
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.05)
    return chan.recv_exit_status()

sql = SQL_FILE.read_text(encoding='utf-8')
print(f"Migration: {SQL_FILE.name}")
print(f"SQL uzunligi: {len(sql)} belgi")

migration_name = SQL_FILE.name

# Node.js script reads the SQL file and runs it via the app's own DB pool.
# This uses the same DATABASE_URL and grants as the running backend.
# Using .replace() instead of f-string to avoid conflicts with JS curly braces.
node_script_template = (
    "import { readFileSync } from 'fs';\n"
    "\n"
    "const backendDir = 'BACKEND_DIR_PLACEHOLDER';\n"
    "process.chdir(backendDir);\n"
    "\n"
    "const { getPool, closePool } = await import(backendDir + '/dist/db/pool.js');\n"
    "const pool = getPool();\n"
    "const client = await pool.connect();\n"
    "// Diagnostics first\n"
    "const { rows: who } = await client.query('SELECT current_user, session_user, current_database()');\n"
    "console.log('DB context:', JSON.stringify(who[0]));\n"
    "const { rows: own } = await client.query(\n"
    "  \"SELECT tableowner FROM pg_tables WHERE tablename='poster_product_modifications'\"\n"
    ");\n"
    "console.log('Table owner:', JSON.stringify(own[0]));\n"
    "const { rows: gr } = await client.query(\n"
    "  \"SELECT privilege_type FROM information_schema.role_table_grants\"\n"
    "  \" WHERE table_name='poster_product_modifications' AND grantee=current_user\"\n"
    ");\n"
    "console.log('Grants:', gr.map(r=>r.privilege_type).join(', ') || 'none listed');\n"
    "try {\n"
    "  const sql = readFileSync('/tmp/adia_migration.sql', 'utf8');\n"
    "  await client.query('BEGIN');\n"
    "  const r = await client.query(sql);\n"
    "  const count = Array.isArray(r) ? r.map(x=>x.rowCount).join(',') : r.rowCount;\n"
    "  console.log('SQL OK, rows affected:', count);\n"
    "  await client.query('COMMIT');\n"
    "} catch (e) {\n"
    "  await client.query('ROLLBACK').catch(()=>{});\n"
    "  console.error('SQL ERROR:', e.message);\n"
    "  process.exit(1);\n"
    "} finally {\n"
    "  client.release();\n"
    "  await closePool();\n"
    "}\n"
    "console.log('DONE');\n"
    "process.exit(0);\n"
)
node_script = node_script_template.replace('BACKEND_DIR_PLACEHOLDER', f'{APP_DIR}/apps/backend')

client = connect()
try:
    sftp = client.open_sftp()
    import io
    sftp.putfo(SQL_FILE.open('rb'), "/tmp/adia_migration.sql")
    sftp.putfo(io.BytesIO(node_script.encode()), "/tmp/adia_fix.mjs")
    sftp.close()
    print(f"Skript serverga yuklandi")

    cmd = "node /tmp/adia_fix.mjs && rm -f /tmp/adia_fix.mjs /tmp/adia_migration.sql"
    rc = run(client, cmd, timeout=120)
    if rc == 0:
        print(f"\n[SQL] MUVAFFAQIYATLI: {migration_name}")
    else:
        print(f"\n[SQL] XATO (exit code {rc})")
        sys.exit(1)
finally:
    client.close()
