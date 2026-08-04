# Pitfalls

Each of these bit someone for real. Symptom first, because that is what you will
have when you arrive here.

## The dangerous one: local testing hits upstream's production Supabase

**Symptom:** none. That is the problem.

The tracked `apps/readest-app/.env` carries base64 fallbacks that resolve to
`https://readest.supabase.co` — upstream's **production** project. Nothing in the app
warns you; sign-in simply works, against someone else's backend.

Before any local run that touches auth or sync, pin it somewhere dead. `.env.local`
is gitignored:

```bash
cat > apps/readest-app/.env.local <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=local-dummy-anon-key
DATABASE_URL=postgresql://postgres:testpw@127.0.0.1:55432/postgres
BETTER_AUTH_SECRET=local-only-not-a-real-key
SIGNUP_ALLOWED_EMAILS=you@example.com
NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3000
EOF
```

Then *verify* rather than trust it — the check costs one command:

```bash
agent-browser network requests | grep -i supabase
```

Any request to `readest.supabase.co` means the override did not take. Stop.

## `package.json` left with `next build --webpack`

**Symptom:** `git status` shows `package.json` modified after a build you did not
finish; or a later build behaves oddly.

`pnpm preview`/`deploy`/`upload` run `patch-build-webpack`, which **`sed`s
`package.json` in place** and relies on `restore-build-original` running afterwards.
Interrupt the build — Ctrl-C, OOM, a stray `pkill` — and the patch stays applied. It
will happily ride along in a commit.

```bash
node -p "require('./apps/readest-app/package.json').scripts.build"
# want: dotenv -e .env.tauri -- next build     (no --webpack)
cd apps/readest-app && pnpm restore-build-original
```

Wrap long builds so this cannot happen:

```bash
trap 'pnpm restore-build-original >/dev/null 2>&1' EXIT INT TERM
```

## A migration silently does nothing

**Symptom:** the migration file exists, `pnpm db:migrate` succeeds, the change is not
in the database.

The file is not in `drizzle/meta/_journal.json`. Only journal entries run. A symlink
alone does nothing.

## The whole chain rolls back on one migration

**Symptom:** `pnpm db:migrate` fails and the database is empty — not partially
applied.

drizzle-kit wraps the **entire run** in a single transaction. One migration that
cannot run inside a transaction takes everything with it. Two constructs cause it:

- `CREATE INDEX CONCURRENTLY` → `cannot run inside a transaction block`
- a procedure that `COMMIT`s, invoked with `CALL` → `invalid transaction termination`

Upstream's `016_add_books_synced_at.sql` does both, which is why it is absent from
the journal. Skipping it is correct on a fresh database because
`000_base_schema.sql` already creates the `synced_at` column, the
`idx_books_user_synced` index, `set_books_synced_at()` and the `books_set_synced_at`
trigger, and its backfill loop has no rows to walk. For a *new* such migration,
decide whether an equivalent shortcut applies or run that one file with `psql -f`.

## Foreign keys pointing at a table that never holds a row

**Symptom:** inserts fail with a foreign-key violation on `user_id`, or rows vanish.

`auth.users` is a stub from `local_000_compat.sql`. It exists so upstream's SQL
applies unchanged, and it is always empty — real users live in `public."user"`.
`local_002_repoint_user_fks.sql` moves the keys across, but only for what existed
when it ran.

```bash
docker exec readest-pg psql -U postgres -d postgres -tAc \
  "select conrelid::regclass||'.'||conname from pg_constraint c
   join pg_class t on t.oid=c.confrelid join pg_namespace n on n.oid=t.relnamespace
   where c.contype='f' and n.nspname='auth'"
```

Anything listed needs a re-pointing migration. Copy `local_002`; its loop handles
whatever it finds rather than naming tables.

## `pnpm db:pull` throws about `unknown(` or `.default(')`

**Symptom:** the script fails with "drizzle-kit still emits … after the repairs".

drizzle-kit 0.31.10 generates two things that do not work, and `scripts/db-pull.mjs`
repairs both:

- `.default(')` for an empty-string default — does not parse
- a call to an undeclared `unknown()` for `bytea` — bundles cleanly, then throws
  `unknown is not defined` at Worker startup, far from the cause

The assertion means a drizzle-kit upgrade changed its output. Check whether the bugs
were fixed (drop the repair) or merely changed shape (update it). Do not delete the
assertion.

## Every sign-in returns 403 `INVALID_ORIGIN`

**Symptom:** the site works, `/api/auth/jwks` answers, but every sign-in fails. Looks
like an auth bug; it is configuration.

`NEXT_PUBLIC_WEB_BASE_URL` is baked in at build time and becomes Better Auth's
`baseURL`, which the `Origin` header is checked against. It has to equal the origin
the app is actually served on — the `[[routes]]` custom domain in `wrangler.toml`.

Locally this also means a `wrangler dev` against the committed `wrangler.toml`
inherits that custom domain as its Host. To test on `127.0.0.1`, run against a copy
with the `[[routes]]` block removed.

## `Failed to decrypt private key`

**Symptom:** `/api/auth/token` returns 500 against a database that worked before.

The JWKS private key is encrypted with `BETTER_AUTH_SECRET`. Rotating the secret
without clearing the table leaves a key nothing can read:

```sql
delete from jwks;   -- Better Auth regenerates on next use
```

## Environment quirks that waste time

**`npx` and `pnpm exec` are intercepted in some shells here.** `npx biome lint .`
fails with "npx canceled due to missing packages". Run the binary directly:

```bash
./node_modules/.bin/biome lint .            # from the repo root
```

`pnpm <script>` is unaffected — prefer `pnpm lint` / `pnpm test`.

**`pkill -f <pattern>` matches the agent's own shell.** The pattern appears in the
invoking command line, so the shell kills itself mid-command — surfacing as exit 137
or 144 with the real work half-done. Kill by PID:

```bash
PID=$(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill "$PID"
```

**Browser state does not survive `agent-browser close`.** Imported books,
annotations and reading progress live in the browser profile and are discarded. Do
not treat their absence after a restart as a regression — re-import and continue.
