---
name: readest-sync
description: Rebase this Readest fork onto upstream readest/readest and verify past green. Use when syncing with upstream, or when something broke after taking upstream changes. A green rebase here still leaves silent damage — orphaned upstream code, mis-resolved locale catalogues, a wrong database — so reach for this rather than rebasing by hand.
---

# Syncing this fork with upstream

This fork replaced Supabase's schema tooling with drizzle-kit and Better Auth. The
migration directory is built out of **symlinks** into upstream's
`docker/volumes/db/migrations/`, and `drizzle/meta/_journal.json` decides what runs.
So a new upstream migration is a file nobody applies until someone adds a journal
entry, and a renamed one leaves a dangling symlink — neither shows up as a conflict,
a test failure, or an error.

That is the shape of every failure worth catching here: the run goes **green** and the
tree is still wrong. Green is where this SOP starts working, not where it stops.

The database is one surface of three, and on the 2026-08-10 sync it was the one that
was fine — upstream added no migrations at all. The other two took the damage:

- **Locale catalogues.** A third of the watch list, every sync, and only the ADR-023
  gate reads them.
- **Orphans.** Upstream code that rebases in cleanly and belongs to nothing here,
  because this fork deleted whatever used to import it. Valid code, so it typechecks,
  lints, and never conflicts.

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

Three queries size the job:

```bash
# New or changed migrations?
git diff --name-only HEAD...upstream/main -- docker/volumes/db/migrations/

# Did upstream change its CI? This fork's `ci-personal.yml` mirrors
# `pull-request.yml` by hand and will not follow on its own.
git diff --name-only HEAD...upstream/main -- .github/workflows/

# Does upstream touch anything this fork edited? These are your conflicts.
comm -12 <(git diff --name-only HEAD...upstream/main | sort -u) \
         <(git diff --name-only upstream/main...HEAD | sort -u)
```

Read the second list in full before starting. It is a watch list, not a prediction —
git often merges those files cleanly because the two sides touched different regions.
Its job is to tell you which entries of `references/divergences.md` to check
afterwards, whether or not a conflict appeared.

A fourth query, for step 2b — what upstream **added** inside the trees this fork hard-
forked. That is the only place an orphan can exist, because it is the only place the
fork deleted the importer. Take it now; after the rebase `upstream/main` is an ancestor
of `HEAD` and the answer comes back empty:

```bash
git diff --name-only --diff-filter=A HEAD...upstream/main -- \
  apps/readest-app/src/app/auth apps/readest-app/src/pages/api apps/readest-app/src/libs/auth
```

The narrowing is what makes the list readable. On the 2026-08-10 sync upstream added 55
files under `src/`, seven of them inside these three trees — and those seven carried
every decision there was to make.

## 2. Rebase

Turn rerere on first. Only a minority of this fork's commits touch a file upstream also
changed, but the few that do touch dozens each — the same catalogues, several commits
running — and rerere replays a resolution you already made instead of asking twice.

```bash
git config rerere.enabled true
git status --short          # start clean
git rebase upstream/main
```

Resolve conflicts against `references/divergences.md`, which carries a resolution per
file. Two files are regenerated rather than merged: `pnpm-lock.yaml` and
`src/libs/db/schema.ts` — take either side and let the `pnpm install` below and step 5
rebuild them.

Where upstream added something in the same region this fork deleted something, neither
side is wholly right and taking either one whole loses work. Resolve by line;
`references/divergences.md` carries the worked example.

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
grep -n "useTurnstile\|signIn.passkey\|forgot-password" apps/readest-app/src/app/auth/page.tsx
grep -n "self-hosted deployment" apps/readest-app/src/components/AboutWindow.tsx
```

The sign-in page is a rewrite, not an edit: upstream's version is built on its own
provider components and this one on Better Auth's client, with passkeys, a captcha
and a reset link that upstream has no equivalent of. Expect to take this side whole
and re-read upstream's diff for anything worth porting by hand.

## 2b. Sweep for orphans

A clean rebase is not the end of the merge. Upstream keeps building on files this fork
replaced or deleted, and that lands two ways.

The loud way surfaces the moment you typecheck, so pull step 6's typecheck forward and
run it here — it is the first thing that reads the merged tree for meaning rather than
for text:

```bash
pnpm -C apps/readest-app exec tsc --noEmit
```

Each error is a decision, and the answer is rarely "delete":

- The feature is gone here → delete again (`d9251322` brought two in-app-purchase
  tests back).
- The feature is one this fork **kept** → port it. `#5542` shipped Delete All Books as
  a UI plus a Supabase route; keeping the button in the conflict obliges you to rewrite
  the route in Drizzle, or the confirmation dialog calls an endpoint that is not there.
- The import moved → re-point it. `validateUserAndToken` lives in `libs/auth/verify`
  now, and a route touching no other table wants `validateRequestUser` beside it.

The quiet way is the **orphan**: upstream code nothing here imports, which no gate in
this repo can see — it is valid, so it compiles, lints and tests fine. Take step 1's
fourth list and ask of each file what reaches it. Three answers: something does (leave
it), nothing does because the fork deleted the importer (delete it), or nothing does
*yet* because it is the backend for UI you kept (wire it up).

`#5505` is the standing example. Its `AuthPanel` and `EmailPasswordAuth` are the
successor to the Supabase Auth UI this fork deleted, so nothing imported them — and
through the i18n scanner they held nine dead keys alive in all 33 catalogues. Upstream
also ships files whose only job is `stubTranslation` anchors (`reservedAuthKeys.ts`);
those keep strings for features this fork does not have. Step 2c is what catches them
if reading does not.

## 2c. Reconcile the locale catalogues

Roughly a third of the watch list is `public/locales/*/translation.json`, every sync.
The scanner owns which keys exist (ADR-023, in `apps/readest-app/docs/i18n.md`), which
makes resolution mechanical — and neither side is ever wholly right, so do not take
one.

Conflicts here are **JSON**, not text. Both sides append keys, so a textual union eats
the comma between the two blocks and yields a file that will not parse. Merge the
parsed objects: the shared values agree, only the key sets differ.

Then let the scanner settle it:

```bash
pnpm -C apps/readest-app i18n:extract
git diff --exit-code apps/readest-app/public/locales/  # a dead key came back, or a live one went missing
pnpm -C apps/readest-app check:translations            # a translation was lost
```

Expect to translate. Upstream ships features whose strings only ever reach
`en/translation.json`, so its own `check:translations` passes without ever seeing them:
`#5573`'s annotation counters arrived needing 185 entries across 33 languages. The
`/i18n` skill fills them. Plural categories are per language, not per string — Slavic
few/many, Arabic and Hebrew duals, and singular-after-numeral in Turkish, Hungarian and
Romanian.

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

## 3b. Re-mirror the CI if upstream moved it

Skip when step 1 showed no `.github/workflows/` changes.

Upstream's checks run on `main` only, so this fork carries its own
`ci-personal.yml`, kept in a separate file so upstream's workflows never conflict.
The trade is that it mirrors `pull-request.yml` by hand and goes stale in silence.

Read what upstream changed and copy across what applies — a Node or pnpm bump, a
new setup step, a renamed script, a check worth having. A stale runtime version is
the one that bites: CI stays green against a Node this deployment no longer builds
on, and the mismatch first appears at deploy.

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

Only the last figure is an invariant. The other two drift upward whenever *either* side
adds a migration — this fork's own auth work moved them from 22 / 19 / 0 at one sync to
24 / 21 / 0 at the next, both correct. So do not check them against a remembered
number. Check that journal entries equal applied rows, and that no foreign key reaches
`auth.users`.

## 5. Regenerate the schema

```bash
pnpm db:pull
git diff --stat src/libs/db/schema.ts
```

An empty diff means upstream changed no DDL. A diff means it did — read it, because
that is upstream moving the data model under the application.

`db:pull` can also stop with a list of columns it says nothing in the generated
schema matches. That is not a false alarm: drizzle-kit camel-cases a column name
into the property key and then lets the key stand in for the column, so a name it
mangles addresses a column that is not there — and Better Auth's Drizzle adapter
drops a `where` condition whose column it cannot find instead of raising. Add a
repair to `scripts/db-pull.mjs` beside the `credentialID` one and re-run; the guard
exists because this failure is otherwise invisible until a query quietly returns
the wrong row.

## 6. Gates

The survey decides this list, not habit. Two commands is what this step used to say,
and two commands is how a red CI gets pushed.

```bash
pnpm -C apps/readest-app format:check       # whole tree
pnpm -C apps/readest-app lint               # tsgo + biome
pnpm -C apps/readest-app exec tsc --noEmit  # what next build runs
pnpm --filter readest-share-og-worker typecheck
pnpm --filter readest-send-email-worker typecheck
pnpm test                                   # vitest
pnpm test:pg                                # against the step 4 database
```

`format:check` is the one that bites after a hand-resolved conflict. lint-staged
formats only *staged* files, so a resolution written before staging is never seen by
it, and this gate reads the whole tree. Dropping one property from a destructure is
enough: it shortens the block past the width where biome wants it on a single line.

`tsc` earns its place beside `lint` because tsgo is more permissive — the comment in
`ci-personal.yml` records a Better Auth call tsgo accepted and `next build` rejected.

Then add what the changed files earn:

- upstream touched `src-tauri/` → `pnpm fmt:check && pnpm clippy:check && pnpm test:rust`
- upstream touched `apps/readest.koplugin/` → `pnpm lint:lua && pnpm test:lua`, which
  soft-skip without luajit installed and so only really run in CI

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
- The step 6 gate set passes — `format:check` included, which lint-staged does not
  cover, plus the Rust or Lua gates if upstream touched those trees.
- `pnpm i18n:extract` leaves a zero diff and `check:translations` finds no placeholder.
- Everything upstream added under `apps/readest-app/src/` has something importing it.
- If upstream touched `.github/workflows/`, `ci-personal.yml` was re-checked
  against it — node/pnpm versions especially.

## The parts that are a hard fork now

Supabase is gone — client, helpers, and every call site. What replaced it is a
fork-owned data and auth layer that upstream has no counterpart for, so these
directories are ported by hand rather than merged, and an upstream change inside
them is a rewrite request rather than a conflict:

- `src/pages/api/**` and `src/pages/api/sync.ts` — Drizzle rewrites of what were
  PostgREST call chains.
- `src/libs/auth/**` and `src/context/AuthContext.tsx` — Better Auth, including
  the mailer, the allow-list request hook, passkeys and the captcha.
- `src/app/auth/**` — three screens upstream does not have, and one it does but
  which shares no code with this version.

`references/divergences.md` carries the per-file resolutions. Add to it as this
list grows.
