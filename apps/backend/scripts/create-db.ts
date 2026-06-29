/**
 * Local dev database bootstrap.
 *
 * Creates the `adia_erp_dev` database if it does not already exist.
 * LOCAL DEV ONLY — never run against production.
 *
 * Usage:  npm run db:create   (from apps/backend)
 */
import { Client } from 'pg';

/**
 * Resolve the dev database name from ADIA_DEV_DB (default: adia_erp_dev).
 *
 * `CREATE DATABASE` cannot be parameterized, so the name is interpolated
 * straight into the SQL string. To keep that safe, the name MUST match a
 * strict identifier whitelist — letters, digits, underscores only — which
 * leaves no room for SQL injection via the env var.
 */
const DB_IDENTIFIER_RE = /^[a-zA-Z0-9_]+$/;

function resolveDbName(): string {
  const name = process.env.ADIA_DEV_DB ?? 'adia_erp_dev';
  if (!DB_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid ADIA_DEV_DB value "${name}": a database name may contain ` +
        `only letters, digits and underscores (^[a-zA-Z0-9_]+$).`,
    );
  }
  return name;
}

const DB_NAME = resolveDbName();

async function main(): Promise<void> {
  // Connect to the maintenance database to issue CREATE DATABASE.
  // Prefer the local Unix socket (peer auth, no password) when available;
  // ADIA_ADMIN_DB_URL overrides for environments that need TCP credentials.
  const adminUrl = process.env.ADIA_ADMIN_DB_URL ?? 'postgres:///postgres?host=/var/run/postgresql';
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      DB_NAME,
    ]);
    if (rowCount && rowCount > 0) {
      console.log(`[db:create] database "${DB_NAME}" already exists — skipping.`);
      return;
    }
    // CREATE DATABASE cannot be parameterized; DB_NAME passed the strict
    // identifier whitelist in resolveDbName(), so interpolation is safe here.
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    console.log(`[db:create] created database "${DB_NAME}".`);
  } finally {
    await admin.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[db:create] failed:', err);
    process.exit(1);
  });
