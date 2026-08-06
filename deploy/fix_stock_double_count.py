#!/usr/bin/env python3
"""
Fix: stock report closing_qty formula removes slsact.sold_qty subtraction
which caused double-counting with Poster leftover reconcile adjust movements.

Poster leftover sync already reduces stk.closing_qty when Poster sells.
Our formula was also subtracting slsact.sold_qty -> double subtraction.
"""
import sys, time, io
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from pathlib import Path
try:
    import paramiko
except ImportError:
    print("pip install paramiko"); sys.exit(1)

CFG_FILE = Path(__file__).parent / ".env.deploy"
cfg = {}
for line in CFG_FILE.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('='); cfg[k.strip()] = v.strip()

HOST = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', '')
APP_DIR = cfg.get('APP_DIR', '/opt/adia-erp')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='ubuntu', password=PASSWORD, timeout=30)
print("SSH OK")

def run_cmd(cmd, timeout=300, check=True):
    chan = c.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    while True:
        if chan.recv_ready(): out += chan.recv(8192)
        if chan.recv_stderr_ready(): out += chan.recv_stderr(8192)
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    print(out.decode('utf-8', errors='replace'))
    if check and rc != 0:
        print(f"[ERROR] exit code {rc}"); sys.exit(rc)
    return rc

STOCK_TS_PATH = f"{APP_DIR}/apps/backend/src/routes/stock.ts"

# ── 1. Download file via SFTP ─────────────────────────────────────
print("=== 1. Downloading stock.ts from server ===")
sftp = c.open_sftp()
buf = io.BytesIO()
sftp.getfo(STOCK_TS_PATH, buf)
content = buf.getvalue().decode('utf-8')
print(f"   Downloaded: {len(content)} bytes")

# ── 2. Apply fix ──────────────────────────────────────────────────
OLD = ('         ROUND(GREATEST(0, COALESCE(stk.closing_qty, 0) '
       '- COALESCE(slsact.sold_qty, 0) '
       '+ COALESCE(mvmt.movement_sold_qty, 0)), 4) AS closing_qty,')
NEW = '         ROUND(COALESCE(stk.closing_qty, 0), 4) AS closing_qty,'

if OLD not in content:
    # Check if already fixed
    if 'ROUND(COALESCE(stk.closing_qty, 0), 4) AS closing_qty,' in content:
        print("   Already fixed! Continuing to rebuild anyway.")
        fixed = content
    else:
        print("   ERROR: Pattern not found in file. Showing closing_qty context:")
        for i, line in enumerate(content.splitlines()):
            if 'closing_qty' in line:
                print(f"   L{i+1}: {line}")
        sys.exit(1)
else:
    fixed = content.replace(OLD, NEW, 1)
    print("   Pattern replaced successfully.")

# ── 3. Upload fixed file via SFTP ─────────────────────────────────
print("=== 3. Uploading fixed stock.ts to server ===")
sftp.putfo(io.BytesIO(fixed.encode('utf-8')), STOCK_TS_PATH)
sftp.close()
print("   Upload complete.")

# ── 4. Verify on server ───────────────────────────────────────────
print("=== 4. Verify fix on server ===")
run_cmd(f"grep -n 'closing_qty' {STOCK_TS_PATH} | head -12")

# ── 5. Build backend ──────────────────────────────────────────────
print("=== 5. Build backend ===")
run_cmd(f"cd {APP_DIR} && npm run build -w @adia/backend", timeout=180)

# ── 6. Restart PM2 ───────────────────────────────────────────────
print("=== 6. Restart PM2 ===")
run_cmd("pm2 restart adia-backend", check=False)
time.sleep(2)
run_cmd("pm2 list", check=False)

c.close()
print("\nDone! Monthly Qoldiq should now show stk.closing_qty (no double-counting with leftover sync).")
print("Expected: Bu oy Qoldiq = 36 (matching product detail stock).")
