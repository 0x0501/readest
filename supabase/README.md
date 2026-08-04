# Database setup for this deployment

`supabase/migrations` is a symlink to `docker/volumes/db/migrations`, upstream's
own migration directory. Nothing is copied, so a new upstream migration is
picked up as soon as this branch is rebased.

Two files in there are ours, numbered clear of upstream's `0NN` sequence:

| File | Why |
| --- | --- |
| `000_base_schema.sql` | Upstream's `init/schema.sql` (the DDL for a new install) minus its two `ALTER FUNCTION auth.* OWNER` lines, which Supabase Cloud neither needs nor permits. Upstream ships that file for fresh installs but never applies it as a migration. |
| `900_auth_hook_plan_claim.sql` | The custom access token hook. Upstream's is closed-source, so without it every user's JWT carries no `plan` claim and reads as `free`. |

The six billing tables (`plans`, `subscriptions`, `payments`, `customers`,
`apple_iap_subscriptions`, `google_iap_subscriptions`) are deliberately absent —
upstream keeps them out of the self-host schema too. Everything that touches
them lives under `libs/payment/` and `app/api/stripe/`, which this deployment
never reaches.

## First-time setup

```bash
supabase link --project-ref <your-project-ref>
```

**Repair migration 016 before the first push.** It is the one migration that
cannot run inside a transaction — read its header — because it uses
`CREATE INDEX CONCURRENTLY` and `CALL`s a procedure that `COMMIT`s each backfill
batch. `supabase db push` wraps every migration in a transaction, so it fails
with `invalid transaction termination (SQLSTATE 2D000)`.

Skipping it is correct rather than merely expedient: on a fresh database
`000_base_schema.sql` already creates the `synced_at` column, the
`idx_books_user_synced` index, `set_books_synced_at()` and the
`books_set_synced_at` trigger — every outcome 016 produces — and its backfill
loop has no rows to walk.

```bash
supabase migration repair --status applied 016
supabase db push
```

Then enable the hook: **Authentication → Hooks → Customize Access Token (JWT)
Claims**, pointing at `public.custom_access_token_hook`. Nothing takes effect
until this is switched on, and existing sessions keep their old claims until the
token refreshes.

Finally, check it:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/verify_auth_hook.sql
```

It runs inside a transaction it rolls back, so it is safe against the live
project. A passing run prints two `PASS:` lines and exits 0.

## After rebasing onto upstream

```bash
supabase db push          # applies only what the remote has not recorded
```

If a future upstream migration also refuses to run in a transaction, `db push`
will say so by name. Read its header: if a fresh-database shortcut applies, use
`supabase migration repair --status applied <version>` and apply the parts that
matter by hand; otherwise run that one file with `psql -f` and then mark it
repaired.

## Testing changes locally

The whole chain can be rehearsed without touching the hosted project:

```bash
docker run -d --name readest-migtest -e POSTGRES_PASSWORD=testpw -p 55432:5432 \
  supabase/postgres:15.8.1.085
URL='postgresql://postgres:testpw@127.0.0.1:55432/postgres?sslmode=disable'
supabase migration repair --status applied 016 --db-url "$URL"
supabase db push --db-url "$URL" --include-all
psql "$URL" -v ON_ERROR_STOP=1 -f supabase/verify_auth_hook.sql
docker rm -f readest-migtest
```

That image already ships the `auth` schema, `auth.users` and `auth.uid()`, so
the foreign keys and RLS policies resolve exactly as they do on Supabase Cloud.
