/**
 * Typed access to Vite environment variables.
 * Defined in `.env` (see `.env.example`); never committed.
 */
export const env = {
  // Fallback must match the backend default port (apps/backend → 3001).
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001',
  isDev: import.meta.env.DEV,
} as const;
