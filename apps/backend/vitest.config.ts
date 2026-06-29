import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    testTimeout: 15000,
    // Each integration suite owns its own schema; running suites serially
    // keeps the shared app pool / config singletons unambiguous.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      // Integration tests run inside an isolated schema in this database.
      // Override with TEST_DATABASE_URL env var for a custom connection.
      // Windows default: TCP to localhost; Linux default: Unix socket.
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        (process.platform === 'win32'
          ? 'postgres://postgres:postgres@localhost:5432/adia_erp_dev'
          : 'postgres:///adia_erp_dev?host=/var/run/postgresql'),
    },
  },
});
