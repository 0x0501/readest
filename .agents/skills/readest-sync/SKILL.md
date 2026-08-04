---
name: readest-sync
description: Rebase this Readest fork onto upstream readest/readest and verify past green. Use when syncing with upstream, or when something broke after taking upstream changes. A green rebase here can leave the database silently wrong, so reach for this rather than rebasing by hand.
---

# Syncing this fork with upstream

This fork replaced Supabase's schema tooling with drizzle-kit and Better Auth. The
migration directory is built out of **symlinks** into upstream's
`docker/volumes/db/migrations/`, and `drizzle/meta/_journal.json` decides what runs.
So a new upstream migration is a file nobody applies until someone adds a journal
entry, and a renamed one leaves a dangling symlink — neither shows up as a conflict,
a test failure, or an error.

That is the shape of every failure worth catching here: the run goes **green** and
the database is still wrong. Green is where this SOP starts working, not where it
stops.

Deployment stays with the operator. Finish at verified and hand off.

Two references sit behind this: `references/divergences.md` (which files conflict
and how to resolve each) and `references/pitfalls.md` (symptom → cause → fix). Read
the first when a conflict appears, the second when something behaves oddly.

## 1. Survey

```bash
git fetch upstream
git log --oneline HEAD..upstream/main               # commits coming
git diff --name-only HEAD...upstream/main | sort    # files they touch
```

Use **three dots** for file lists. `HEAD..upstream/main` compares the two tips and
reports the symmetric difference, so every file this fork added looks like an
upstream change — hundreds of misleading lines. Three dots diff from the merge base
and answer the question you asked.

Two queries size the job:

```bash
# New or changed migrations?
git diff --name-only HEAD...upstream/main -- docker/volumes/db/migrations/

# Does upstream touch anything this fork edited? These are your conflicts.
comm -12 <(git diff --name-only HEAD...upstream/main | sort -u) \
         <(git diff --name-only upstream/main...HEAD | sort -u)
```

Read the second list in full before starting. It is a watch list, not a prediction —
git often merges those files cleanly because the two sides touched different regions.
Its job is to tell you which entries of `references/divergences.md` to check
afterwards, whether or not a conflict appeared.

## 2. Rebase

```bash
git status --short          # start clean
git rebase upstream/main
```

Resolve conflicts against `references/divergences.md`, which carries a resolution
per file. Two files are regenerated rather than merged: `pnpm-lock.yaml` and
`src/libs/db/schema.ts` — take either side and let steps 2b and 5 rebuild them.

If the rebase turns into a fight across many commits, `git rebase --abort` and merge
instead. A merge commit is fine; a mangled rebase is not.

```bash
git submodule update --init --recursive    # pointers move with the rebase
pnpm install                               # rebuild the lockfile
```

The submodules are easy to forget and fail late. `packages/foliate-js` is the
reader engine, and upstream moves its pointer whenever a feature needs new engine
code — the rebase updates the recorded commit but leaves your checkout behind, so
the first symptom is a typecheck error about a missing export from
`foliate-js/*.js`. `git submodule status` marks a stale one with a leading `+`.

Then confirm the fork's intent survived the merge, for each file the watch list
named. These are the load-bearing ones:

```bash
grep -n "NEXT_PUBLIC_WEB_BASE_URL" apps/readest-app/src/services/constants.ts
grep -n "PAYMENTS_ENABLED = " apps/readest-app/src/utils/access.ts
grep -n "providers={\['github'\]}" apps/readest-app/src/app/auth/page.tsx
```

## 3. Adopt new upstream migrations

Skip when step 1 found none. For each new `0NN_*.sql`:

```bash
cd apps/readest-app
ln -s ../../../docker/volumes/db/migrations/0NN_name.sql drizzle/0NN_name.sql
```

Then append an entry to `drizzle/meta/_journal.json` with the next `idx` and a
`when` greater than the last — the symlink alone runs nothing.

Read each new file and answer two questions before you add it:

**Does it `REFERENCES auth.users`?** Add a re-pointing migration modelled on
`local_002_repoint_user_fks.sql`; its loop handles whatever it finds rather than
naming tables.

**Does its header say it cannot run inside a transaction?** Then it stays out of the
journal, and you apply it by hand with `psql -f` or establish that a
fresh-database shortcut makes it unnecessary. Upstream's `016_add_books_synced_at.sql`
is the standing example. `references/pitfalls.md` explains why one such migration
takes the whole chain down with it.

## 4. Rebuild from empty

This is the step that gets past green. Build the schema from nothing:

```bash
docker run -d --name readest-pg -e POSTGRES_PASSWORD=testpw -p 55432:5432 postgres:17
cd apps/readest-app
export DATABASE_URL='postgresql://postgres:testpw@127.0.0.1:55432/postgres'
pnpm db:migrate
```

```bash
P="docker exec readest-pg psql -U postgres -d postgres -tAc"
$P "select count(*) from drizzle.__drizzle_migrations"
$P "select count(*) from pg_tables where schemaname='public'"
$P "select count(*) from pg_constraint c join pg_class t on t.oid=c.confrelid
    join pg_namespace n on n.oid=t.relnamespace
    where c.contype='f' and n.nspname='auth'"
```

The counts grow as upstream adds migrations; the last figure is the one that must
not move. Reference point at the last sync: 21 migrations, 18 tables, 0.

## 5. Regenerate the schema

```bash
pnpm db:pull
git diff --stat src/libs/db/schema.ts
```

An empty diff means upstream changed no DDL. A diff means it did — read it, because
that is upstream moving the data model under the application.

## 6. Gates

```bash
pnpm lint          # tsgo + biome
pnpm test          # vitest
```

Add `pnpm fmt:check && pnpm clippy:check && pnpm test:rust` when the rebase touched
`src-tauri/`.

## 7. Hand off

```bash
docker rm -f readest-pg
```

Report what upstream brought, which files needed hand-resolution, any migration
added or skipped, and the gate results. Deploying is the operator's call.

## Before you call it done

Each of these is checkable, and each has been wrong at least once:

- `git submodule status` shows no leading `+` — no stale checkout.
- `find apps/readest-app/drizzle -xtype l` is empty — no dangling symlinks.
- Journal entries equal rows in `drizzle.__drizzle_migrations` on a fresh database —
  every migration you adopted actually ran.
- Zero foreign keys reference `auth.users`.
- `docker/volumes/db/migrations/` is pristine and the fork deletes nothing upstream
  ships (`references/divergences.md` has both commands).
- `node -p "require('./apps/readest-app/package.json').scripts.build"` reads
  `next build` — an interrupted OpenNext build leaves `--webpack` seded in, and it
  rides along in a commit.
- `pnpm lint` and `pnpm test` pass.

## When the data layer lands

The Supabase teardown is at Phase 0: the schema tooling moved, but the application
still calls `@supabase/supabase-js`. When later phases replace those call sites,
roughly forty more files — `sync.ts` and everything under `pages/api/` — become a
hard fork whose upstream changes need porting rather than merging. Add them to
`references/divergences.md` as it happens.
