---
name: readest-sync
description: Rebase this Readest fork onto upstream (readest/readest) and verify the result. Use whenever the user wants to sync, rebase, merge, pull, or catch up with upstream, mentions new upstream commits or migrations, asks why the build or migrations broke after pulling, or asks how far behind upstream this fork is. Also use before starting work that will conflict with upstream, and after any `git fetch upstream`. This fork diverges from upstream in ways that break silently — the database layer no longer uses Supabase — so reach for this skill rather than rebasing by hand.
---

# Syncing this fork with upstream

This fork replaced Supabase's schema tooling with drizzle-kit and Better Auth. Most
upstream commits rebase cleanly, but a handful of places break *quietly* — the
rebase succeeds, the tests pass, and the database is wrong. This SOP exists to
catch those before they reach a deploy.

Deployment is out of scope. Finish at "verified", and hand off.

## The shape of the divergence

Upstream keeps its SQL in `docker/volumes/db/migrations/`. This fork does not copy
it — `apps/readest-app/drizzle/0NN_*.sql` are **symlinks** into that directory, and
`drizzle/meta/_journal.json` decides what runs and in what order. That means a new
upstream migration arrives as a file nobody applies until you add it, and a renamed
or deleted one leaves a dangling symlink.

Everything else worth knowing is in `references/divergences.md` (which files
conflict and how to resolve each) and `references/pitfalls.md` (symptom → cause →
fix). Read the first when a conflict appears; read the second when something breaks
that "should" work.

## The SOP

### 1. Know what you are about to take

```bash
git fetch upstream
git log --oneline HEAD..upstream/main               # commits coming
git diff --name-only HEAD...upstream/main | sort    # files they touch
```

Use **three dots** for the file lists. `HEAD..upstream/main` compares the two tips
and reports the symmetric difference, so every file this fork added shows up as
though upstream changed it — hundreds of irrelevant lines. `HEAD...upstream/main`
diffs from the merge base and answers the question you actually asked.

Two questions decide how much work this is:

```bash
# New or changed migrations?
git diff --name-only HEAD...upstream/main -- docker/volumes/db/migrations/

# Does upstream touch anything this fork has edited? These are your conflicts.
comm -12 <(git diff --name-only HEAD...upstream/main | sort -u) \
         <(git diff --name-only upstream/main...HEAD | sort -u)
```

If both are empty, this is a routine rebase and steps 3–5 will be quick. The second
list is worth reading in full before you start — it tells you exactly which entries
in `references/divergences.md` you are about to need.

### 2. Rebase

```bash
git status --short          # start clean; stash or commit first
git rebase upstream/main
```

Conflicts here are expected in a known set of files. `references/divergences.md`
lists each one with the resolution — the short version is that this fork's edits to
upstream files (`constants.ts`, `access.ts`, `auth/page.tsx`, `wrangler.toml`,
`package.json`) are deliberate and should survive, while two files should never be
merged by hand:

- `pnpm-lock.yaml` — take either side, then `pnpm install` to regenerate.
- `apps/readest-app/src/libs/db/schema.ts` — generated. Take either side; step 5
  regenerates it from the database.

If the rebase turns into a fight across many commits, `git rebase --abort` and use a
merge instead. A merge commit is not a failure; a mangled rebase is.

### 3. Take on any new upstream migrations

Skip if step 1 showed none.

For each new `docker/volumes/db/migrations/0NN_*.sql`:

```bash
cd apps/readest-app
ln -s ../../../docker/volumes/db/migrations/0NN_name.sql drizzle/0NN_name.sql
```

Then append an entry to `drizzle/meta/_journal.json` with the next `idx` and a
`when` greater than the last. Before you do, read the new file and answer two
questions:

**Does it `REFERENCES auth.users`?** The stub table from `local_000_compat.sql` is
still there, so the migration applies — but the foreign key points at a table that
never holds a row. Add a re-pointing migration modelled on
`local_002_repoint_user_fks.sql`; its loop is written to catch whatever it finds.

**Does its header say it cannot run inside a transaction?** Then it cannot go in the
journal at all. drizzle-kit wraps the **entire run** in one transaction, not one per
migration, so a single `CREATE INDEX CONCURRENTLY` or a procedure that `COMMIT`s
rolls back everything. Upstream's `016_add_books_synced_at.sql` is the existing
example and is deliberately absent from the journal. Decide whether a
fresh-database shortcut applies (as it does for 016, because `000_base_schema.sql`
already produces every one of its outcomes), or apply that one file by hand with
`psql -f`.

Also check nothing went stale:

```bash
find apps/readest-app/drizzle -xtype l    # broken symlinks — upstream renamed or deleted a file
```

### 4. Verify the migration chain against a real database

Passing tests do not prove the schema is right. Build it from empty:

```bash
docker run -d --name readest-pg -e POSTGRES_PASSWORD=testpw -p 55432:5432 postgres:17
cd apps/readest-app
export DATABASE_URL='postgresql://postgres:testpw@127.0.0.1:55432/postgres'
pnpm db:migrate
```

Then confirm the invariants. The counts move as upstream adds migrations; what must
stay true is that **no foreign key still points at the `auth.users` stub**:

```bash
P="docker exec readest-pg psql -U postgres -d postgres -tAc"
$P "select count(*) from drizzle.__drizzle_migrations"                       # = journal entries
$P "select count(*) from pg_tables where schemaname='public'"
$P "select count(*) from pg_constraint c join pg_class t on t.oid=c.confrelid
    join pg_namespace n on n.oid=t.relnamespace
    where c.contype='f' and n.nspname='auth'"                                # must be 0
```

For reference, the chain was 21 migrations / 18 tables / 0 stale FKs at the last
sync.

### 5. Regenerate the schema

```bash
pnpm db:pull      # rewrites src/libs/db/schema.ts from the live database
git diff --stat apps/readest-app/src/libs/db/schema.ts
```

An empty diff means upstream changed no DDL. A diff means it did — read it, because
that is upstream changing the data model under the application.

This script repairs two things drizzle-kit gets wrong and asserts if the repairs
stop matching. If it throws about `unknown(` or `.default(')`, drizzle-kit's output
changed; see `references/pitfalls.md`.

### 6. Gates

```bash
cd apps/readest-app
pnpm lint          # tsgo + biome
pnpm test          # vitest
```

If biome fails to resolve, run it directly from the repo root:
`./node_modules/.bin/biome lint .` — `npx`/`pnpm exec` are unreliable in some
shells here.

Run the Rust gates only if the rebase touched `src-tauri/`:
`pnpm fmt:check && pnpm clippy:check && pnpm test:rust`.

### 7. Optional: prove it in a browser

Worth doing when upstream touched the reader, library, or auth. See
`references/pitfalls.md` for the `.env.local` you need first — **the tracked `.env`
falls back to upstream's production Supabase**, so a careless local run reads and
writes someone else's backend.

### 8. Clean up and hand off

```bash
docker rm -f readest-pg
git status --short         # expect only intentional changes
```

Report what upstream brought, which files needed hand-resolution, whether any
migration was added or skipped, and the gate results. Leave deploying to the user.

## Before you call it done

- `find apps/readest-app/drizzle -xtype l` is empty.
- Journal entry count equals rows in `drizzle.__drizzle_migrations` on a fresh database.
- Zero foreign keys reference `auth.users`.
- `package.json`'s `build` script reads `next build`, **not** `next build --webpack`
  — an interrupted OpenNext build leaves that `sed` applied, and it survives a
  commit. This has happened.
- `pnpm lint` and `pnpm test` pass.

## When the data layer lands

The Supabase teardown is only at Phase 0: the schema tooling moved, but the
application still calls `@supabase/supabase-js`. When the later phases replace those
call sites, roughly forty more files — `sync.ts` and everything under
`pages/api/` — become a hard fork, and upstream changes to them will need manual
porting rather than merging. Add them to `references/divergences.md` as that happens.
