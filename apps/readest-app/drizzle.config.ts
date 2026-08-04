import { defineConfig } from 'drizzle-kit';

// Upstream's SQL stays the source of truth for the schema (ADR-003): each
// `0NN_*.sql` in `drizzle/` is a symlink into `docker/volumes/db/migrations`, so a
// new upstream migration needs no hand-translated DDL — one symlink and one line
// in `meta/_journal.json`. Files prefixed `local_` are ours. `schema.ts` is a
// generated artifact (`pnpm db:pull`), used only for types and query building.
export default defineConfig({
  dialect: 'postgresql',
  schema: './drizzle/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env['DATABASE_URL']! },
  // Better Auth's tables live in `public` alongside the application's; `auth` and
  // `extensions` hold the compatibility shim and are not modelled in Drizzle.
  schemaFilter: ['public'],
});
