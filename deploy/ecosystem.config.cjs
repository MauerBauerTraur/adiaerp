// PM2 ecosystem — production process manager for ADIA ERP backend.
//
// Single instance (fork mode) per ADR-0005:
// cluster mode would require pg_try_advisory_lock on the cron guards
// and SELECT FOR UPDATE SKIP LOCKED on telegram_outbox. Faza-3 stays
// fork-mode; cluster is a Faza-4 task.
//
// The Python forecaster sidecar runs separately via docker compose —
// see deploy/README.md.
//
// Usage:
//   cd /opt/adia-erp
//   pm2 start deploy/ecosystem.config.cjs --env production
//   pm2 save
//   pm2 startup systemd                          # one-time, prints a command to run as root
//   sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u adia --hp /home/adia

module.exports = {
  apps: [
    {
      name: 'adia-backend',
      cwd: '/opt/adia-erp',
      script: 'apps/backend/dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 8000,              // allow graceful shutdown (cron workers, pg pool)
      wait_ready: false,
      env_production: {
        NODE_ENV: 'production',
        // The actual secrets live in /opt/adia-erp/.env — dotenv loads them.
        // PORT, DATABASE_URL, JWT_SECRET, POSTER_*, BOT_TOKEN, GOOGLE_APPLICATION_CREDENTIALS,
        // VERTEX_*, FORECASTER_*, WEB_ORIGIN, TELEGRAM_WEBHOOK_SECRET — all in .env.
      },
      // Log rotation — install pm2-logrotate once: `pm2 install pm2-logrotate`
      out_file: '/var/log/adia-erp/backend.out.log',
      error_file: '/var/log/adia-erp/backend.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
