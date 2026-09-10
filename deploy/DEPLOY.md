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

Production was migrated by hand for a stretch, so `schema_migrations` has gaps.
The built-in runner applies **every** unapplied file, and two of them are
destructive if replayed:

| File | What it does | Why replaying it is destructive |
|---|---|---|
| `0053_fix_sales_price_som.sql` | `UPDATE sales SET price = price / 100 WHERE price > 100` | Prices are already in so'm (median 16 000). It would turn 48 000 so'm into 480 — about 26 000 rows. |
| `0054_fix_cost_sell_price_som.sql` | divides `cost_price` / `sell_price` by 100 | `sell_price` is in a mixed state; ~100 products would be divided wrongly. |

Also unapplied and *deliberately* left that way: `0052`, `0056`, `0057` — their
schema changes were already made by hand, so the DB already matches them.

**Apply exactly one migration at a time:**

```bash
python deploy/apply_migration.py 0061_your_migration.sql
```

It runs that one file plus its `schema_migrations` row in a single
transaction, refuses if it is already recorded, prints the schema before and
after, and re-checks that `0053`/`0054` are still unapplied.

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

## 7. Access gotcha — fail2ban

The deploy scripts open a fresh SSH session per step. With **password** auth,
repeated deploys trip fail2ban, which then drops *all* TCP from that IP —
including 443, so you lose the site and SSH from that machine at once. The
symptom is confusing: ICMP still answers (`ping` works) while `curl` and `ssh`
time out.

If that happens: deploy from another network, or ask someone with access to run

```bash
sudo fail2ban-client status sshd
sudo fail2ban-client set sshd unbanip <YOUR_IP>
```

Use `SSH_KEY` rather than `PASSWORD` and this does not arise.

---

## 8. Known open items

- `/root/.pm2/dump.pm2` still holds a duplicate `adia-backend` (see §1).
- PM2's error log `/root/.pm2/logs/adia-backend-error-0.log` grew past 9 million
  lines; `pm2-logrotate` does not appear to be rotating it.
- `recipes.stage` carries two vocabularies. `services/nakladnoy.ts` maps them
  all onto three sections (`base`/`dough`/`other` → hamir, `decoration`/`cream`
  → krem, `assembly` → bezak) so nothing is dropped, but the underlying
  duplication is unresolved.
