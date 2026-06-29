# packages/

Reserved for shared TypeScript packages (types, utilities) that both
`apps/backend` and `apps/frontend` import from.

Currently empty — package types are duplicated in each app's
`src/lib/types.ts` / `src/auth/roles.ts`. Lift them here when the
duplication starts hurting.
