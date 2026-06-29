# Deploy yo'riqnoma — ADIA ERP (Hetzner VPS)

Faza-3 oxiriga kelib tizim production-ready. Bu hujjat yangi serverga zero-to-running deployni qadamma-qadam tushuntiradi. Mahalliy prod-mode test bilan teng tarkib.

## Talab

- **Server:** Hetzner CX21 yoki katta (Ubuntu 24.04 LTS, 4 GB RAM minimum — Prophet uchun).
- **Domen:** masalan `erp.adia.uz`, A-record server IP'iga.
- **Foydalanuvchi:** `adia` (sudo ruxsati bilan), uy katalogi `/home/adia`.

## 1. Server provision

```bash
# Root sifatida
adduser adia
usermod -aG sudo adia
# (key-based SSH sozlash, parolli loginni o'chirish, ufw allow 22/80/443)
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

## 2. Paketlar

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ca-certificates nginx postgresql-16 docker.io docker-compose-plugin git
sudo usermod -aG docker adia
# Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
pm2 install pm2-logrotate
```

## 3. DB

```bash
sudo -u postgres createuser -P adia       # parol kiritiladi
sudo -u postgres createdb -O adia adia_erp_prod
# DATABASE_URL: postgres://adia:<parol>@localhost:5432/adia_erp_prod
```

## 4. Klon va build

```bash
sudo mkdir -p /opt/adia-erp /var/log/adia-erp
sudo chown adia:adia /opt/adia-erp /var/log/adia-erp
su - adia
cd /opt/adia-erp
git clone <repo-url> .
npm install
npm run build -w @adia/backend
npm run build -w @adia/frontend
```

## 5. Sirlar (`.env`)

```bash
cp .env.example .env
bash deploy/secrets-gen.sh >> .env       # JWT_SECRET, FORECASTER, TELEGRAM_WEBHOOK qo'shiladi
chmod 600 .env
nano .env
```

Quyidagilarni qo'lda to'ldiring:
- `DATABASE_URL` — yuqoridagi user/pass/db
- `POSTER_ACCOUNT`, `POSTER_APP_ID`, `POSTER_APP_SECRET`, `POSTER_TOKEN`, `POSTER_WEBHOOK_SECRET`
- `BOT_TOKEN`, `BOT_USERNAME`
- `GOOGLE_APPLICATION_CREDENTIALS=/opt/adia-erp/secrets/vertex-sa.json` (faylni alohida `scp` qiling, `chmod 600`)
- `VERTEX_PROJECT_ID`, `VERTEX_REGION=europe-west1`, `VERTEX_MODEL=gemini-2.5-flash`
- `WEB_ORIGIN=https://erp.adia.uz`

## 6. Migratsiya + birinchi PM foydalanuvchi

```bash
npm run migrate -w @adia/backend
npm run seed:dev -w @adia/backend        # parolni darhol almashtir!
```

## 7. Forecaster sidecar (Docker)

```bash
cd /opt/adia-erp/apps/forecaster
docker compose up -d
curl http://127.0.0.1:8000/healthz       # {"status":"ok"}
```

## 8. Backend (PM2)

```bash
cd /opt/adia-erp
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u adia --hp /home/adia
# yuqoridagi PM2 chiqargan komandani exec qiling — boot da avtomatik start
```

## 9. nginx + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/adia-erp
sudo nano /etc/nginx/sites-available/adia-erp     # domen va sertifikat yo'lini moslang
sudo ln -s /etc/nginx/sites-available/adia-erp /etc/nginx/sites-enabled/
# rate-limit zonalarini /etc/nginx/nginx.conf http{} ga qo'shing (faylda izoh bor)

# Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d erp.adia.uz
sudo nginx -t && sudo systemctl reload nginx
```

## 10. Telegram webhook ulash

`.env` da `BOT_TOKEN` va `TELEGRAM_WEBHOOK_SECRET` to'liq bo'lganidan keyin Telegram'ga URL yuboring:

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://erp.adia.uz/api/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Tekshiruv:

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

## 11. Monitoring

- **Backend:** `pm2 status`, `pm2 logs adia-backend`.
- **Forecaster:** `docker compose logs -f forecaster`, `/healthz`.
- **DB:** `psql -d adia_erp_prod -c "SELECT count(*) FROM stock_movements;"` (alarm bo'lsa o'sib turishi kerak).
- **/health:** `curl https://erp.adia.uz/health` — `db: up`.

## 12. Backup

`pg_dump` har kuni cron orqali (alohida sozlash). `.env` va `secrets/` ni alohida zaxiralang.

## Rollback

```bash
cd /opt/adia-erp
git fetch && git checkout <eski_commit_sha>
npm install && npm run build -w @adia/backend && npm run build -w @adia/frontend
pm2 restart adia-backend
```

DB migration rollback skripti hozir yo'q — migratsiya **forward-only**. Buzilgan migratsiya bo'lsa qo'lda DROP + reverse SQL.

## Faza-4 ga qoldiriladigan

- PM2 cluster mode (`pg_try_advisory_lock` + `FOR UPDATE SKIP LOCKED` migratsiyasidan keyin).
- `pg_dump` avtomatik backup + S3 yuklash.
- Prometheus + Grafana stack.
- AmoCRM / boshqa POS integratsiyalari (TZ §14).
