# Database setup for this deployment

Stock Postgres, reached from the Worker through a Hyperdrive binding. No Supabase,
no PostgREST, no vendor-specific driver — swapping the provider means changing one
connection string.

This file is the operational side. The reasoning, and every `ADR-0NN` cited here
and in the SQL, lives in [`../docs/database.md`](../docs/database.md).

## What is in here

`meta/_journal.json` is the migration order. Everything drizzle-kit applies is
listed there, in that order, and nothing else in this directory is applied.

| File | Whose |
| --- | --- |
| `0NN_*.sql` | Upstream's, **symlinked** into `docker/volumes/db/migrations`. Never edited. |
| `local_000_compat.sql` | Ours. The `auth` / `extensions` schemas, the `authenticated` / `anon` / `service_role` roles, the `auth.users` stub and `auth.uid()` — everything upstream's SQL assumes Supabase provides. |
| `000_base_schema.sql` | Ours, but a copy of upstream's `docker/volumes/db/init/schema.sql` (the DDL for a fresh install) minus its two `ALTER FUNCTION auth.* OWNER` lines. Upstream ships that file but never applies it as a migration. |
| `local_001_better_auth.sql` | Ours, generated. Better Auth's six tables. |
| `local_002_repoint_user_fks.sql` | Ours. Moves the twelve `user_id` foreign keys off the `auth.users` stub and onto `public."user"`. |
| `local_005_rate_limit.sql` | Ours. Historical Better Auth `rateLimit` table (ADR-020). Runtime no longer uses it (ADR-021); DDL kept, do not drop without a new decision. |

Symlinking rather than copying means upstream's SQL stays the single source of
truth for the schema, and no DDL is ever translated by hand (ADR-003).

`src/libs/db/schema.ts` is generated from the database, not written. It exists for
types and query building only.

## Running migrations

```bash
export DATABASE_URL='postgresql://…'
pnpm db:migrate
```

**drizzle-kit wraps the entire run in one transaction** — not one per migration —
so a migration that cannot run inside a transaction fails the whole run and rolls
it back. Exactly one file has that property, and it is deliberately absent from
the journal:

Upstream's `016_add_books_synced_at.sql` says so in its own header. It uses
`CREATE INDEX CONCURRENTLY` and `CALL`s a procedure that `COMMIT`s each backfill
batch. Skipping it on a fresh database is correct rather than merely expedient:
`000_base_schema.sql` already creates the `synced_at` column, the
`idx_books_user_synced` index, `set_books_synced_at()` and the
`books_set_synced_at` trigger — every outcome 016 produces — and its backfill loop
has no rows to walk.

## After rebasing onto upstream

For each new `0NN_*.sql` upstream adds:

```bash
ln -s ../../../docker/volumes/db/migrations/0NN_name.sql drizzle/0NN_name.sql
```

then append an entry to `meta/_journal.json` with the next `idx` and a `when`
greater than the last. Re-run the migration and then `pnpm db:pull` to refresh the
generated schema.

Two things to check in the new file:

- Does it `REFERENCES auth.users(id)`? Add a re-pointing statement modelled on
  `local_002_repoint_user_fks.sql` — the stub table is still there, so the
  migration itself applies, but the foreign key would point at a table that never
  holds a row.
- Does its header say it cannot run in a transaction? Then it cannot go in the
  journal. Decide whether a fresh-database shortcut applies, as with 016, or apply
  it by hand with `psql -f`.

## After upgrading `better-auth`

Its tables are generated, never hand-written. Regenerate them and append whatever
is new as a fresh `local_*.sql`:

```js
// node --input-type=module, with DATABASE_URL set
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';

// Copy `plugins` and `advanced` from src/libs/auth/server.ts — that file is the
// authority. Anything that differs here produces DDL the adapter will not match.
const auth = betterAuth({
  database: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  plugins: [/* … */],
  advanced: {/* … */},
});
console.log(await (await getMigrations(auth.options)).compileMigrations());
```

The Kysely path is used because it is the only one that compiles SQL. Missing this
step surfaces at runtime, not at compile time (see `../docs/database.md`,
ADR-009).

## Testing locally

```bash
docker run -d --name readest-pg -e POSTGRES_PASSWORD=testpw -p 55432:5432 postgres:17
export DATABASE_URL='postgresql://postgres:testpw@127.0.0.1:55432/postgres'
pnpm db:migrate
```

Stock Postgres is deliberate: `local_000_compat.sql` supplies everything upstream
expects Supabase to have, so a passing run here means the SQL is not relying on
anything vendor-specific.
