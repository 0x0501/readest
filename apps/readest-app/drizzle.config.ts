import { defineConfig } from 'drizzle-kit';

// Config for `pnpm db:migrate` only. Upstream's SQL stays the source of truth for
// the schema (see docs/database.md, ADR-003): each `0NN_*.sql` in `drizzle/` is a
// symlink into `docker/volumes/db/migrations`, so a new upstream migration needs
// no hand-translated DDL — one symlink and one line in `meta/_journal.json`. Files
// prefixed `local_` are ours.
//
// There is no `schema` key because nothing here diffs a schema: `drizzle-kit
// migrate` reads only `out` and `dbCredentials`, and `pnpm db:pull` writes its own
// config so it cannot overwrite the hand-maintained journal.
export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle',
  dbCredentials: { url: process.env['DATABASE_URL']! },
});
