# Database

This deployment runs on stock Postgres, reached from the Worker through a
Cloudflare Hyperdrive binding. Upstream runs on Supabase — GoTrue for
authentication, PostgREST for data transport, and row-level security for
authorization — and this fork replaces all three. `drizzle/README.md` covers the
day-to-day operations; this file records why the shape is what it is.

| Layer | Upstream | Here |
| --- | --- | --- |
| Authentication | GoTrue | Better Auth (JWT + API Key plugins) |
| Data transport | PostgREST | Drizzle ORM over Hyperdrive (`pg` driver) |
| Authorization | RLS policies + `auth.uid()` | Explicit `WHERE user_id` in the application |
| Database | Supabase Postgres | Any Postgres |

## One deployment constraint worth knowing

`NEXT_PUBLIC_WEB_BASE_URL` is baked in at build time and becomes Better Auth's
`baseURL`, which is what the Origin header is checked against. **It has to be the
origin the Worker is actually served on** — the `[[routes]]` custom domain in
`wrangler.toml`. A mismatch does not degrade gracefully: every sign-in returns 403
`INVALID_ORIGIN` while the rest of the site works, so it looks like an auth bug
rather than a configuration one. The deploy workflow already fails the build when
the variable is unset; it cannot check that the value is *right*.

The same applies locally: point it at the dev server's own origin, and note that a
`wrangler dev` run against the committed `wrangler.toml` inherits the custom
domain as its Host.

## Architecture decision records

The repository had no ADR convention before this work. These follow
Context / Decision / Consequences, and the source comments cite them by number.

### ADR-001: Remove Supabase entirely rather than replacing only Auth

**Context.** The dependency is three layers deep: GoTrue (18 `supabase.auth.*`
call sites, the sign-in page, the KOReader Lua client, the browser extension),
PostgREST (106 `.from()` and 12 `.rpc()` call sites), and RLS with `auth.uid()`
(54 policies plus seven function bodies). A Better Auth session token does not
pass through PostgREST, so `auth.uid()` returns NULL and all seven RPCs break.
Better Auth's own migration guide states it does not cover RLS.

**Decision.** Replace all three layers.

**Consequences.** This is a hard fork of the data layer. Upstream changes to
files like `sync.ts` now need manual rebasing.

### ADR-002: Rewrite data access as Drizzle rather than shimming PostgREST

**Context.** Every call site obtains its client from one factory, and the
operator vocabulary in use is about eighteen calls wide, so a compatibility shim
inside that factory could have left all 106 call sites untouched and kept the
upstream merge surface near zero.

**Decision.** No shim. Rewrite as Drizzle.

**Consequences.** Type safety and an idiomatic data layer, at the cost of
conflict-free merges of upstream changes to those files. Seventeen existing test
files assert the shape of PostgREST call chains and are invalidated (ADR-012).

### ADR-003: Upstream SQL stays the source of truth for the schema

**Context.** Upstream adds roughly four or five migrations a month, each tied to
a change in sync semantics. If a Drizzle schema were authoritative, every one
would have to be re-expressed as DDL by hand.

**Decision.** Upstream SQL stays authoritative. Each `0NN_*.sql` in `drizzle/` is
a symlink into `docker/volumes/db/migrations`. `src/libs/db/schema.ts` is
generated from the live database by `pnpm db:pull` and used only for types and
query building.

**Consequences.** No DDL is ever hand-translated. `schema.ts` is a build artifact
and must not be edited. Picking up a new upstream migration is one symlink and
one journal line.

### ADR-004: Stay independent of the database provider

**Context.** The point of the exercise is being able to change database backends.

**Decision.** Depend on nothing but a Postgres connection string, supplied
through Hyperdrive. Use `drizzle-orm/node-postgres`; provider-specific drivers
such as `drizzle-orm/neon-http` are not permitted.

**Consequences.** Changing provider is changing one connection string. Provider
specific optimisations are given up.

### ADR-005: Authorization moves from RLS into the application

**Context.** Hyperdrive pools in transaction mode and resets a connection when it
is returned, so a Worker invocation may get several connections and would have to
re-apply any `SET` per query or transaction. Cloudflare advises against holding a
long transaction to keep such state. Session-GUC-driven RLS therefore cannot be
relied on as the enforcement layer.

**Decision.** RLS is no longer the enforcement layer. Every query filters by
`user_id` explicitly. The policies stay in the database as defence in depth; they
are inert until a non-owner role is configured, which is not done yet.

**Consequences.** Authorization correctness moves from the database to the code.
**A missing `user_id` filter is a privilege escalation and will not fail to
compile.** This is the standing risk of the whole design, and the reason ADR-012
requires a cross-user test per data route.

### ADR-006: `plan` and `storage_usage_bytes` stay JWT claims

**Context.** The client reads both straight off the token, synchronously.

**Decision.** Better Auth's JWT plugin carries them via `definePayload`.

**Consequences.** `utils/access.ts` and `useQuotaStats` barely change. The costs:
the JWT plugin is not a session replacement, so both mechanisms coexist; the
default 15-minute lifetime is too short for a client with no refresh loop, so it
is set to 7 days; and usage is a snapshot taken when the token is signed.

Two facts here were established by testing, against expectation. Better Auth
1.6.25 does **not** default to database-generated UUIDs on Postgres — it emits
`id text`, which cannot carry the twelve `user_id uuid` foreign keys or the
`${user.id}/${fileName}` object-storage keys, so
`advanced.database.generateId: 'uuid'` is set explicitly. And the API Key plugin
is no longer part of `better-auth`; it ships as `@better-auth/api-key`.

### ADR-007: Better Auth keeps its default tables; a migration re-points the keys

**Context.** Twelve `REFERENCES auth.users(id) ON DELETE CASCADE` are spread
across five upstream migrations. The alternative was giving Better Auth's pool a
`search_path` of `auth` and renaming its model to `users`, leaving all twelve
untouched.

**Decision.** Use the default tables — `public."user"`, `session`, `account`,
`verification`, `jwks`, `apikey` — and add `local_002_repoint_user_fks.sql`.

**Consequences.** No implicit magic. Each new upstream table referencing
`auth.users` needs re-pointing; `local_000_compat.sql` keeps an empty
`auth.users` stub so such a migration still applies. `user` is a reserved word in
Postgres and must always be quoted.

### ADR-008: drizzle-kit executes migrations

**Context.** The alternatives were keeping the Supabase CLI, adopting a neutral
migration tool, or writing one.

**Decision.** `drizzle-kit migrate`, over a hand-maintained
`drizzle/meta/_journal.json`.

**Consequences.** One tool, one history, no Supabase left. Testing settled the
open question: drizzle-kit wraps the **entire run** in a single transaction, not
one per migration. Any migration that cannot run inside a transaction fails and
rolls back the whole chain — which is why upstream's 016 is absent from the
journal. See `drizzle/README.md`.

### ADR-009: Better Auth's tables are managed by drizzle too

**Context.** Three parties would otherwise want to change the schema: upstream
SQL, Better Auth's own migrator, and drizzle-kit.

**Decision.** Better Auth uses the Drizzle adapter. Its DDL is generated by its
own migration compiler and committed as `local_001_better_auth.sql`, then owned
by drizzle-kit like everything else.

**Consequences.** One tool, one history. Upgrading `better-auth` means
regenerating and appending a migration — see `drizzle/README.md`. Skipping that
step surfaces at runtime, not at compile time.

### ADR-010: The seven RPC bodies are unchanged; `auth.uid()` is reimplemented

**Context.** `replica_keys_create` / `_list` / `_forget` and the four
`*_inbox_item` functions read `auth.uid()` directly. They carry real concurrency
semantics — CRDT merge, `FOR UPDATE SKIP LOCKED` — and porting them to TypeScript
would be a poor trade.

**Decision.** Recreate the `auth` schema and an `auth.uid()` that reads
`request.jwt.claim.sub`, and have callers `set_config(..., true)` inside the same
transaction as the call. The function bodies are untouched.

**Consequences.** Upstream edits to those functions take effect as-is. Every RPC
call site goes through a shared "begin, set claim, call" helper. Verified on
workerd over Hyperdrive: the claim is visible inside the transaction and gone
immediately after commit, so nothing leaks to the next query on a pooled
connection.

### ADR-011: Non-browser clients use device tokens

**Context.** The KOReader plugin carries a hand-written GoTrue client and token
lifecycle in Lua; the browser extension scrapes the Supabase token out of the web
app's localStorage.

**Decision.** KOReader moves to Better Auth API keys, which the plugin supports
as a session source, so no server-side special case is needed. The extension
keeps capturing credentials automatically and only changes which storage key it
matches.

**Consequences.** The Lua shrinks substantially — sign-in, OTP and the refresh
loop all go — and nobody types a password on an e-ink screen. The extension
change is about two lines. The web app gains a device-token management screen.

### ADR-012: Tests reach a real database

**Context.** The only existing seam is the `@/utils/supabase` module, mocked in
seventeen test files. Those tests assert the shape of PostgREST call chains and
never check the data.

**Decision.** Pure logic — cursor arithmetic, CRDT merge decisions, object-key
validation — stays in the jsdom tier with no database. Route handlers that touch
the database are tested against a real Postgres container.

**Consequences.** Assertions describe behaviour instead of implementation, and
the new tier covers something nothing covered before: whether the migrations and
the SQL are correct. It is also the only defence against ADR-005's standing
risk, so every data route needs a "user A cannot read or write user B's data"
test. CI gains a service container.

### ADR-013: The daily-usage counters get a table of their own

**Context.** `utils/usage.ts` called two Postgres functions,
`increment_daily_usage` and `get_current_usage`. Neither is defined in
`docker/volumes/db/migrations/`, and no table backs them: upstream created both
directly in its hosted project and never shipped the SQL. On any database built
from the tracked migrations the calls failed, the `catch` logged, and the
counter returned 0 — so the DeepL daily quota never counted anything, and the
test that covered it asserted the arguments of a mocked `supabase.rpc` call,
which passed for as long as the function did not exist.

**Decision.** Add `usage_stats` in `drizzle/local_003_usage_stats.sql` and do
the counting in Drizzle. The functions are not recreated: ADR-010 preserves
upstream's *existing* function bodies so upstream edits apply as-is, and there
was never a body here to preserve. Reads and writes resolve the UTC date in
Postgres rather than in the Worker, so the window does not depend on which
machine asks.

**Consequences.** Quotas start applying, which is a behaviour change on any
deployment that had DeepL keys configured — usage that silently counted as zero
now counts. `getCurrentUsage` no longer swallows errors: a quota it cannot read
must not be granted, so the route fails closed. Writes stay best-effort, since a
translation already delivered should not fail afterwards. If upstream ever ships
its own `usage_stats`, its migration will fail to apply against this table
rather than diverge quietly.

### ADR-014: json and jsonb columns are read through a raw expression

**Context.** Four columns hold JSON the client has already stringified —
`book_configs.progress`, `search_config`, `view_settings` and `books.metadata`.
`transformBookConfigToDB` sends `JSON.stringify(progress)`, and
`transformBookConfigFromDB` calls `JSON.parse` on the way back, so the value on
the wire is a *string* and the column holds a jsonb string. PostgREST returned
that string unchanged. Drizzle does not: node-postgres parses the wire value and
Drizzle's own jsonb mapper parses it a second time, so the client receives an
array where it expects a string and throws inside its own `JSON.parse`.

Writes are unaffected — Drizzle stringifies for the driver exactly as PostgREST
did, and the stored value is byte-identical.

**Decision.** `sync.ts` selects json and jsonb columns as ``sql`${column}` ``
rather than as the column object. A raw expression carries no decoder, so
Drizzle hands back the driver's value, which is what PostgREST produced.

**Consequences.** The rule is applied by column *type*, not by column name, so a
new jsonb column inherits it. Columns whose value is a genuine object —
`stat_pages.ext` — are unaffected either way, since one parse is correct for
them and one parse is what they get. A real-database test pushes a config and
pulls it back asserting `typeof progress === 'string'`, because this failure
mode is invisible to a mocked query: it lives in the driver.

### ADR-015: Account recovery and email change are gone, not stubbed

**Context.** `/auth/recovery` finished a password reset that GoTrue started by
mailing a link, and `/auth/update` changed an account's email by mailing a
confirmation to both addresses. This deployment configures no outbound mail —
the only email Worker here is inbound. Better Auth can drive either flow, but
not without a sender.

**Decision.** `/auth/update` is deleted along with its menu action.
`/auth/recovery` becomes a change-password form built on
`authClient.changePassword`, which takes the current password and needs no mail
at all; it revokes other sessions, which is the point of changing a password
under suspicion.

**Consequences.** A forgotten password is an operator problem, resolved against
the database. That is defensible for an instance whose sign-up is an
`SIGNUP_ALLOWED_EMAILS` allow-list. Dropping the email change also closes a gap
that list left open: the allow-list gates account *creation*, so an account
could otherwise move itself to an address that was never invited.
