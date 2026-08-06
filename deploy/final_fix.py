#!/usr/bin/env python3
"""
Yakuniy fix:
1. TVOROZHNY (621) barcha Poster saleslarini GP TVOROZHNY TSELYJ (1063) ga ko'chiradi
2. poster_product_id: 1063 <- 2135, 621 <- NULL (faqat 1063 Poster sales oladi)
3. poster_product_modifications.product_id: 621 -> 1063 (future mods uchun)
"""
import sys, time, io
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

HOST = cfg['HOST']; PASSWORD = cfg.get('PASSWORD', ''); db_name = 'adia_erp'
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username='ubuntu', password=PASSWORD, timeout=30)
print("SSH OK")

def run(client, cmd):
    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(f"sudo bash -c {repr(cmd)}")
    out = b""
    while True:
        if chan.recv_ready(): chunk=chan.recv(8192); out+=chunk; sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
        if chan.exit_status_ready() and not chan.recv_ready(): break
        time.sleep(0.05)
    return chan.recv_exit_status(), out.decode(errors='replace')

fix_sql = """
BEGIN;

-- 1. Move all ТВОРОЖНЫЙ (621) Poster sales to G/P ТVOROZHNY (1063)
--    Skip rows that would duplicate (poster_transaction_id, product_id=1063, poster_line_id)
UPDATE sales SET product_id = 1063
WHERE product_id = 621
  AND poster_transaction_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sales s2
    WHERE s2.poster_transaction_id = sales.poster_transaction_id
      AND s2.poster_line_id = sales.poster_line_id
      AND s2.product_id = 1063
      AND s2.id != sales.id
  );

-- 2. Transfer Poster link: clear from 621 FIRST (unique constraint), then set on 1063
UPDATE products SET poster_product_id = NULL WHERE id = 621;
UPDATE products SET poster_product_id = 2135 WHERE id = 1063;

-- 3. Fix any poster_product_modifications pointing to 621 -> 1063
UPDATE poster_product_modifications SET product_id = 1063 WHERE product_id = 621;

COMMIT;
"""

sftp = c.open_sftp()
sftp.putfo(io.BytesIO(fix_sql.encode()), "/tmp/final_fix.sql")
sftp.close()

print("Fix SQL ishlanmoqda...")
rc, out = run(c, f"sudo -u postgres psql -d {db_name} -f /tmp/final_fix.sql && rm -f /tmp/final_fix.sql")

if rc == 0 and 'ROLLBACK' not in out and 'ERROR' not in out:
    print("\n=== BARCHA MUVAFFAQIYATLI ===")
    print("TVOROZHNY (621) Poster sales -> GP TVOROZHNY (1063) ko'chirildi")
    print("poster_product_id 2135 -> 1063 ga o'tdi")
else:
    print(f"\n=== XATO (rc={rc}, ROLLBACK={('ROLLBACK' in out)}) ===")
    sys.exit(1)

c.close()
