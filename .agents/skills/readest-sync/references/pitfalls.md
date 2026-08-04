# Pitfalls

Symptom first, because that is what you arrive with. Each of these has bitten
someone.

## Local testing silently reads and writes upstream's production Supabase

**Symptom:** none. That is what makes it the worst one here.

The tracked `apps/readest-app/.env` carries base64 fallbacks resolving to
`https://readest.supabase.co` — upstream's **production** project. Sign-in simply
works, against someone else's backend.

Pin it somewhere dead before any local run that touches auth or sync. `.env.local`
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

Then confirm the override took, rather than assuming — one command:

```bash
agent-browser network requests | grep -i supabase
```

Every hit should be `127.0.0.1`. A `readest.supabase.co` means stop.

## One migration takes the whole chain down

**Symptom:** `pnpm db:migrate` fails and the database is empty rather than partly
built.

drizzle-kit wraps the **entire run** in a single transaction, not one per migration.
Any migration that cannot run inside a transaction rolls back everything behind it.
Two constructs do it:

- `CREATE INDEX CONCURRENTLY` → `cannot run inside a transaction block`
- a procedure that `COMMIT`s, invoked with `CALL` → `invalid transaction termination`

Upstream's `016_add_books_synced_at.sql` does both, which is why the journal omits
it. Omitting it is correct on a fresh database because `000_base_schema.sql` already
creates the `synced_at` column, the `idx_books_user_synced` index,
`set_books_synced_at()` and the `books_set_synced_at` trigger, and its backfill loop
has no rows to walk. Establish the equivalent for any new such migration, or apply
that one file by hand with `psql -f`.

## Typecheck fails on a missing export from `foliate-js`

**Symptom:** `error TS2305: Module '"foliate-js/…"' has no exported member '…'`
straight after a rebase that otherwise went clean.

`packages/foliate-js` is a submodule and upstream moves its pointer whenever a
reader feature needs new engine code. The rebase updates the recorded commit; your
working tree keeps the old checkout, so the application compiles against an engine
that predates the feature.

```bash
git submodule status                              # a stale one carries a leading +
git submodule update --init --recursive
```

Worth running after every rebase rather than waiting for the error — several other
submodules (`tauri`, `tauri-plugins`, `simplecc-wasm`, `qcms`) can move the same way
and fail further from the cause.

## A migration is present but does nothing

**Symptom:** the file exists, `pnpm db:migrate` succeeds, the change is absent.

Only journal entries run. Add the entry to `drizzle/meta/_journal.json`.

## Foreign keys pointing at a table that never holds a row

**Symptom:** inserts fail on `user_id`, or rows vanish.

`auth.users` is a stub from `local_000_compat.sql`. It exists so upstream's SQL
applies unchanged, and stays empty — real users live in `public."user"`.
`local_002_repoint_user_fks.sql` moves the keys across, but only for what existed
when it ran.

```bash
docker exec readest-pg psql -U postgres -d postgres -tAc \
  "select conrelid::regclass||'.'||conname from pg_constraint c
   join pg_class t on t.oid=c.confrelid join pg_namespace n on n.oid=t.relnamespace
   where c.contype='f' and n.nspname='auth'"
```

Anything listed needs a re-pointing migration; copy `local_002`.

## `package.json` carrying `next build --webpack`

**Symptom:** `package.json` shows modified after a build you did not finish, or a
later build behaves oddly.

`pnpm preview`/`deploy`/`upload` run `patch-build-webpack`, which **`sed`s
`package.json` in place** and relies on `restore-build-original` afterwards.
Interrupt the build — Ctrl-C, OOM, a stray `pkill` — and the patch stays, and will
happily ride along in a commit.

```bash
cd apps/readest-app && pnpm restore-build-original
```

Guard long builds so it cannot linger:

```bash
trap 'pnpm restore-build-original >/dev/null 2>&1' EXIT INT TERM
```

## `pnpm db:pull` throws about `unknown(` or `.default(')`

**Symptom:** "drizzle-kit still emits … after the repairs".

drizzle-kit 0.31.10 generates two things that do not work, and
`scripts/db-pull.mjs` repairs both:

- `.default(')` for an empty-string default — does not parse
- a call to an undeclared `unknown()` for `bytea` — bundles cleanly, then throws
  `unknown is not defined` at Worker startup, far from the cause

The assertion firing means a drizzle-kit upgrade changed its output. Check whether
the bugs were fixed (drop that repair) or merely reshaped (update it). Keep the
assertion either way — it is what converts a silent Worker crash into a loud script
failure.

## Every sign-in returns 403 `INVALID_ORIGIN`

**Symptom:** the site works, `/api/auth/jwks` answers, sign-in always fails. Reads
as an auth bug; it is configuration.

`NEXT_PUBLIC_WEB_BASE_URL` is baked in at build time and becomes Better Auth's
`baseURL`, which the `Origin` header is checked against. It has to equal the origin
the app is served on — the `[[routes]]` custom domain in `wrangler.toml`.

Locally this also means `wrangler dev` against the committed `wrangler.toml`
inherits that custom domain as its Host. To exercise auth on `127.0.0.1`, run
against a copy with the `[[routes]]` block removed.

## `Failed to decrypt private key`

**Symptom:** `/api/auth/token` returns 500 against a database that worked before.

The JWKS private key is encrypted with `BETTER_AUTH_SECRET`. Rotating the secret
leaves a key nothing can read. Clear the table and Better Auth regenerates:

```sql
delete from jwks;
```

## Environment quirks

**`npx` and `pnpm exec` are intercepted in some shells here.** `npx biome lint .`
fails with "npx canceled due to missing packages". Run the binary directly, from the
repo root:

```bash
./node_modules/.bin/biome lint .
```

`pnpm <script>` is unaffected, so prefer `pnpm lint` / `pnpm test`.

**`pkill -f <pattern>` matches the agent's own shell**, because the pattern appears
in the invoking command line — the shell kills itself mid-command, surfacing as exit
137 or 144 with the work half-done. Kill by PID:

```bash
PID=$(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill "$PID"
```

**Browser state ends with `agent-browser close`.** Imported books, annotations and
reading progress live in the browser profile and are discarded. Re-import and carry
on.
