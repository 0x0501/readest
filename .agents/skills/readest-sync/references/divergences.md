# What this fork changed, and how to resolve each conflict

Two facts make the rebase easier than it looks:

- **The fork deletes nothing upstream ships.** No `git rm` to re-apply, no
  resurrection conflicts.
- **`docker/volumes/db/migrations/` is pristine upstream.** The fork's own SQL lives
  in `apps/readest-app/drizzle/`, so upstream's migration directory takes their side
  wholesale, every time.

Verify both after any rebase — **three dots**, or upstream's own new files show up as
things this fork deleted:

```bash
git diff --stat upstream/main...HEAD -- docker/volumes/db/migrations/   # expect empty
git diff --diff-filter=D --name-only upstream/main...HEAD               # expect empty
```

## Fork-only files — cannot conflict

Nothing upstream has these paths, so they rebase silently. Listed so you recognise
them as intentional rather than stray:

| Path | What it is |
| --- | --- |
| `apps/readest-app/drizzle/**` | Migration directory: symlinks to upstream SQL, the `local_*.sql` files, `meta/_journal.json`, `README.md` |
| `apps/readest-app/drizzle.config.ts` | drizzle-kit config for `pnpm db:migrate` |
| `apps/readest-app/scripts/db-pull.mjs` | Regenerates `src/libs/db/schema.ts` |
| `apps/readest-app/src/libs/db/` | Database client + generated schema |
| `apps/readest-app/src/libs/auth/server.ts` | Better Auth configuration |
| `apps/readest-app/src/app/api/auth/[...all]/route.ts` | Better Auth handler |
| `apps/readest-app/src/__tests__/libs/auth-*.test.ts`, `db-connection-string.test.ts` | Tests for the above |
| `apps/readest-app/docs/database.md` | Architecture decision records |
| `.github/workflows/deploy-personal.yml` | This deployment's CI |

## Fork edits inside upstream files — where conflicts land

Each of these is a deliberate deviation. Keep the fork's intent; re-apply it on top
of whatever upstream changed rather than discarding either side.

| File | The fork's change | If upstream also changed it |
| --- | --- | --- |
| `src/services/constants.ts` | `READEST_WEB_BASE_URL` and friends read `NEXT_PUBLIC_*` env vars instead of hardcoding `readest.com` | Keep the env-var indirection; take upstream's new constants alongside |
| `src/utils/access.ts` | `PAYMENTS_ENABLED = false` | Keep the flag false; take upstream's plan-gate logic |
| `src/app/user/page.tsx`, `src/app/user/components/AccountActions.tsx`, `src/hooks/useAvailablePlans.ts` | Checkout UI hidden behind `PAYMENTS_ENABLED` | Keep the guard, re-wrap whatever upstream added |
| `src/app/auth/page.tsx` | `providers={['github']}` — only what this deployment configured | Keep the narrowed list; do not restore google/apple/discord |
| `src/app/reader/components/sidebar/SearchBar.tsx` | A skipped (cloud-only) book says "Download this book to search inside it" rather than "Search failed" | Keep the extra branch; its test pins both messages |
| `wrangler.toml` | This deployment's zone, routes, R2/KV/Hyperdrive bindings, vars | Almost always take the fork's side; upstream's is a different account |
| `package.json` | Adds `db:migrate` and `db:pull` | Take upstream's dependency changes, keep the two scripts |
| `.env.local.example` | Documents `DATABASE_URL`, `BETTER_AUTH_*`, `SIGNUP_ALLOWED_EMAILS`, `GITHUB_CLIENT_*` | Union of both |
| `.gitignore` | Adds `.dev.vars` | Union of both |

## Never merge by hand — regenerate

| File | Why | What to do |
| --- | --- | --- |
| `pnpm-lock.yaml` | Merge conflicts here are unresolvable by reading | Take either side, then `pnpm install` |
| `src/libs/db/schema.ts` | Generated from the live database | Take either side, then `pnpm db:pull` after the migration chain runs |

## Upstream PRs carried locally

`f0b856fa fix(sync): handle OneDrive OAuth callbacks (#5479)` is an upstream pull
request applied here early. When upstream merges it, the rebase drops it as already
applied, or conflicts trivially. If you see conflicts across
`services/sync/providers/oauth/`, `app/auth/utils/nativeAuth.ts`, or
`src-tauri/plugins/tauri-plugin-native-bridge/`, check whether upstream has landed
#5479 — if so, take upstream's version wholesale and let the local commit disappear.

Check for this class of thing before assuming a conflict is real:

```bash
git log --oneline upstream/main --grep="#5479"
```

## The migration invariants

Three counts that should stay in agreement:

```
symlinks in drizzle/           = upstream migration files
journal entries                = symlinks − skipped + local_*.sql + 000_base_schema
rows in drizzle.__drizzle_migrations = journal entries
```

At the last sync: 18 upstream files, 18 symlinks, 21 journal entries (18 − 1 skipped
016 + 4 local), 21 rows on a fresh database.

The one that matters most is not a count: **zero foreign keys may reference
`auth.users`** once `local_002_repoint_user_fks.sql` has run.
