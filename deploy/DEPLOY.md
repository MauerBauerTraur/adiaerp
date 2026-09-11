# ADIA ERP — Deploy runbook

Read this before touching production. It is written for whoever (person or
agent) picks the work up on a new machine.

Everything here was verified against the live server during the 2026-08/09
sessions. Where a number is quoted, it came from the server, not from memory.

---

## 1. What production is

| | |
|---|---|
| Host | `82.115.50.28` — domain `adia.uz` (HTTPS, nginx) |
| SSH user | `ubuntu` (sudo, passwordless) |
| App directory | `/opt/adia-erp` |
| Backend | Node + Express on `:3001`, PM2 app **`adia-backend`** |
| Frontend | static files served by nginx from `/opt/adia-erp/apps/frontend/dist` |
| Database | PostgreSQL **14.23**, connection string in `/opt/adia-erp/apps/backend/.env` |
| Backups | `/var/backups/adia/adia_erp_<STAMP>.sql.gz` |

**The app runs under `pm2-ubuntu.service` — the PM2 daemon owned by the
`ubuntu` user, not root.** `sudo pm2 …` talks to root's PM2, which is an empty
leftover from an earlier setup; using it created a second registration that
fought for `:3001` and crash-looped with `EADDRINUSE`. Always:

```bash
sudo -u ubuntu pm2 list
sudo -u ubuntu pm2 restart adia-backend
sudo -u ubuntu pm2 logs adia-backend
```

`/root/.pm2/dump.pm2` still lists `adia-backend`. If root's PM2 is ever
restarted it will resurrect that duplicate and the port fight returns. Clearing
it is pending work.

---

## 2. What you need on the new machine

1. **The repo** — `git clone https://github.com/MauerBauerTraur/adiaerp.git`
2. **Node 20+** and `npm install` at the repo root (npm workspaces).
3. **Python 3** with `paramiko` — `pip install paramiko` (the deploy scripts use it).
4. **`deploy/.env.deploy`** — *not in git*. Copy `deploy/.env.deploy.example`
   and fill it from the project owner. Keys it must contain:

   ```
   HOST  USER  SERVER_IP  DOMAIN  EMAIL  PASSWORD  SSH_KEY  APP_DIR
   DATABASE_URL  JWT_SECRET
   POSTER_ACCOUNT  POSTER_APP_ID  POSTER_APP_SECRET  POSTER_TOKEN
   BOT_TOKEN  BOT_USERNAME
   VERTEX_PROJECT_ID  VERTEX_REGION  VERTEX_MODEL
   FORECASTER_URL  FORECASTER_SHARED_SECRET
   ```

   `SSH_KEY` should point at a private key file. **Prefer the key over
   `PASSWORD`** — see §7.

5. **`apps/frontend/.env.production.local`** with
   `VITE_API_BASE_URL=https://adia.uz`. Without it the production bundle can be
   built against `localhost:3001` and the deployed site talks to nothing.
6. **GitHub push rights** — the `MauerBauerTraur/adiaerp` repo. `gh auth status`
   must show an account with `push: true` as *active*; the active account has
   silently changed mid-session before. Check with:
   `gh api repos/MauerBauerTraur/adiaerp --jq .permissions`

---

## 3. The normal deploy

```bash
# 1. build (the server does NOT build — 957 MB RAM, it OOMs)
npm run build -w @adia/backend
npm run build -w @adia/frontend

# 2. sanity-check the bundle points at production, not localhost
grep -c "localhost:3001" apps/frontend/dist/assets/index-*.js   # must be 0

# 3. deploy
python deploy/deploy_code.py
```

`deploy_code.py` does, in order:

1. `pg_dump | gzip` into `/var/backups/adia/`, and `cp -a` both `dist`
   folders to `dist.bak-<STAMP>`. **If the backup fails the deploy aborts.**
2. SFTP-uploads `apps/backend/dist` and `apps/frontend/dist`.
3. `chown -R ubuntu:ubuntu` both, then `sudo -u ubuntu pm2 restart adia-backend`.
4. Polls `http://localhost:3001/health` for up to 40 s and prints the PM2 row.

It prints the rollback stamp at the end. To roll back:

```bash
sudo -u ubuntu pm2 stop adia-backend
sudo rm -rf /opt/adia-erp/apps/backend/dist
sudo mv /opt/adia-erp/apps/backend/dist.bak-<STAMP> /opt/adia-erp/apps/backend/dist
sudo -u ubuntu pm2 start adia-backend
```

Frontend rollback is the same with `apps/frontend`.

### Verifying from outside

```bash
curl -sk https://adia.uz/ | grep -oE 'src="[^"]*\.js"'      # bundle hash changed?
curl -skI https://adia.uz/ | grep -i last-modified          # timestamp is now?
```

---

## 4. Migrations — DO NOT run `npm run migrate`

Production was migrated by hand for a stretch, so `schema_migrations` had gaps.
The built-in runner applies **every** unapplied file, and two of them rewrite
data:

| File | What it does | Why replaying it would be destructive |
|---|---|---|
| `0053_fix_sales_price_som.sql` | `UPDATE sales SET price = price / 100 WHERE price > 100` | Prices are already in so'm. It would turn 48 000 so'm into 480 — about 26 000 rows. |
| `0054_fix_cost_sell_price_som.sql` | divides `cost_price` / `sell_price` by 100 | `sell_price` is in a mixed state; ~100 products would be divided wrongly. |

**Update — 2026-09-11.** Those two, plus `0052`, `0056` and `0057`, are now
**recorded** in `schema_migrations`, all five stamped `2026-09-10 17:53:53`.
They were recorded, not executed: the data was checked afterwards and is
intact — `sales` median **17 000 so'm over 39 508 rows**, `products.sell_price`
median 340 000, zero rows under 100. A real run of `0053` would have left the
median near 170. Five identical timestamps is the signature of rows inserted
as "already applied" markers, which is what stops the runner replaying them.

So the specific replay hazard is closed. The one-at-a-time discipline below
still stands: it is what makes each change reviewable and reversible.

**Apply exactly one migration at a time:**

```bash
python deploy/apply_migration.py 0061_your_migration.sql
```

It runs that one file plus its `schema_migrations` row in a single
transaction, refuses if it is already recorded, and prints the schema before
and after. Its closing line still reports whether `0053`/`0054` are recorded —
since 2026-09-10 they are, so that line now prints both filenames. Read it as
"these are marked applied and will not replay", not as an alarm.

Order matters: **apply the migration before deploying code that reads the new
column.** `0060` added `production_orders.actual_qty`, which
`PRODUCTION_ORDER_COLUMNS` selects — deploying that code first would break every
production-order query.

---

## 5. Tests before you deploy

```bash
npm test -w @adia/backend       # integration tests, need a local PostgreSQL
npm test -w @adia/frontend
```

Baseline as of 2026-09-10: **1 failed / 797 passed** in the backend suite. The
one failure is `routes.sales.receipts.test.ts > store_manager sees only its own
store` and predates the current work.

**Frontend baseline, measured 2026-09-11 on `55d01c0`, Node 24.14.1:
43 failed / 367 passed of 410 tests (39 of 169 files red).** Twice-run,
identical both times. The suite is *not* green, so judge a frontend change the
same way — by whether it adds failures. Recognisable clusters:

| Count | Cluster |
|---|---|
| 8 | `RBAC matrix — PM …` expects a button to be absent for the PM role; it renders |
| 4 | Uzbek apostrophe mismatch — code writes ASCII `'` (`Tovar ko'chirish`, `Maqsad bo'g'in`), tests expect U+2018 `‘` |
| 3 | `ViewToggle` — no element with role `tab` |
| 2 | `ProductionOrdersPage` — no button matching `Ya…` |

The apostrophe cluster is a one-character fix; the RBAC cluster needs a
decision on which side is right, the component or the test.

The backend suite needs a local PostgreSQL on the URL in
`apps/backend/.env` (`localhost:5434` on the dev machines). Without it the
whole suite errors out — that is a missing database, not a regression.

Judge a change by whether it *adds* failures, not by whether the suite is
green. To get a clean baseline, stash your source changes (keep migrations) and
re-run.

If the whole suite goes red at once with `тип "<name>" не существует`, the
cause is a migration whose `CREATE TYPE` guard queries `pg_type` without
qualifying the schema: the type is found in `public`, creation is skipped, and
the isolated test schema is left without it. `0029` and `0035` were fixed this
way — scope the check with `AND n.nspname = current_schema()`.

---

## 6. Frontend/print gotchas

- The production bundle is built from `.env.production.local`. Vite precedence:
  `.env.production.local` > `.env.local` > `.env`. `apps/frontend/.env` points
  at `https://adia.uz` and `.env.local` at `localhost:3001`, so the check in §3
  step 2 is not optional.
- The server never builds. It has 957 MB RAM and the Vite build OOMs there.

---

## 7. Access gotcha — IP blocking under password auth

A machine deploying repeatedly with **password** auth has been cut off from the
server entirely — including 443, so the site and SSH both vanish from that
machine at once. The symptom is confusing: ICMP still answers (`ping` works)
while `curl` and `ssh` time out.

**Correction — 2026-09-11.** This section used to name fail2ban as the cause
and gave `fail2ban-client` commands to clear the ban. **fail2ban is not
installed on this server** — `sudo fail2ban-client status sshd` returns
`command not found`. So the blocking comes from somewhere else (upstream
provider filtering or sshd's own throttling); the mechanism is not yet
identified, and those two commands do nothing. Do not rely on them.

**Use key auth and the problem does not arise.** A deploy key is set up:

```
deploy/.env.deploy → SSH_KEY=~/.ssh/adia_erp_deploy
```

To set one up on a new machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/adia_erp_deploy -N "" -C "adia-erp-deploy-$(whoami)"
ssh-copy-id -i ~/.ssh/adia_erp_deploy.pub ubuntu@82.115.50.28   # asks for the password once
ssh -i ~/.ssh/adia_erp_deploy -o PasswordAuthentication=no ubuntu@82.115.50.28 'echo ok'
```

Then point `SSH_KEY` at it. `deploy_code.py` and `apply_migration.py` both
prefer the key and fall back to `PASSWORD` only when `SSH_KEY` is empty or the
file is missing — so leaving a stale path in `SSH_KEY` makes them fail rather
than quietly using the password.

---

## 8. Known open items

- `/root/.pm2/dump.pm2` still holds a duplicate `adia-backend` (see §1).
- PM2's error log `/root/.pm2/logs/adia-backend-error-0.log` grew past 9 million
  lines; `pm2-logrotate` does not appear to be rotating it.
- `recipes.stage` carries two vocabularies. `services/nakladnoy.ts` maps them
  all onto three sections (`base`/`dough`/`other` → hamir, `decoration`/`cream`
  → krem, `assembly` → bezak) so nothing is dropped, but the underlying
  duplication is unresolved.

Added 2026-09-11:

- **Background workers cannot reach the database in bursts.** The error log
  fills with `[action-expire] cycle failed: Connection terminated due to
  connection timeout`, and the same for `[telegram-outbox]`, `[dialog-expire]`
  and `[poster-sales-webhook]`. The HTTP path is healthy throughout, so this
  looks like pool exhaustion or a pool timeout that only the cron cycles hit.
  Unresolved — nobody has tuned the pool.
- **Old frontend bundles are never cleaned.**
  `apps/frontend/dist/assets/` holds 29 `index-*.js` files, one per deploy
  going back months, because the deploy uploads over the directory instead of
  replacing it. Harmless (nginx serves only what `index.html` names) but it
  makes "which bundle is live?" a question you have to ask `index.html`.
- **A deploy can be aborted by a root-owned file.** On 2026-09-11 the SFTP
  upload died at `dist/lib/navPaths.*` with `EACCES` after 111 of 309 files —
  those three had been written by a root-run build. `deploy_code.py` now
  chowns both `dist` trees to `ubuntu:ubuntu` *before* uploading, so a repeat
  is self-healing. If a deploy ever dies partway again, re-running it is safe:
  the upload is idempotent and the restart only happens after both trees land.
- **`/opt/adia-erp` is a git checkout** (currently at `70bf4fc`) with local
  drift: `apps/backend/migrations/0050_poster_supplies.sql` shows as deleted,
  `package-lock.json` as modified, and there is a stray
  `apps/backend/.envngrep` plus old `dist.bak-*` directories. Deploys do not
  use git — they SFTP the built `dist` — so this drift is inert, but it makes
  `git status` on the server useless for telling what is deployed. Read
  `dist/` timestamps instead.
