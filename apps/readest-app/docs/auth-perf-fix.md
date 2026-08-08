# Auth / Hyperdrive performance fix

**Status:** implementing / implemented in code (grill 2026-08-09)  

**Incident:** Worker ~1k req/24h vs Hyperdrive ~1M queries; multi-minute `/api/auth/get-session`; CPU `exceededResources`  
**Feedback loop:** `node apps/readest-app/scripts/diag-auth-perf.mjs [baseUrl]`

This document is the implementation contract. Domain decisions live in
`CONTEXT.md` and `docs/database.md` (ADR-021, ADR-022). Do not re-open scope
without updating those ADRs.

---

## 1. Problem summary

### Symptoms (production)

| Observation | Detail |
| --- | --- |
| Query explosion | Hyperdrive query volume ~1000× Worker request count |
| Latency | Unauthenticated `GET /api/auth/get-session` often 30–70s; sample wall ~263s, CPU ~18s |
| CPU | Status `exceededResources` (p99 CPU ~35s) while wall clocks hit hundreds of seconds |
| Load | App barely used; background focus/refetch and any hit to `/api/auth/*` still paid full cost |

### Root cause

Better Auth was configured with **`rateLimit.storage: 'database'`** (ADR-020).
Every auth path — including **`/get-session`** — did a read-modify-write on
`public."rateLimit"` with a compare-and-swap style `UPDATE … WHERE lastRequest <= $n`
and **unbounded recursive retry** on CAS failure.

Hyperdrive had **query caching enabled**. Cached `SELECT`s returned stale
`lastRequest` values after another isolate had already advanced the row. CAS
kept failing → recursion → hundreds of thousands of no-op updates.

Production evidence (`pg_stat_statements`, stats since ~2026-07-24):

| Statement pattern | Calls | Rows affected |
| --- | ---: | ---: |
| Window-reset CAS `UPDATE "rateLimit" … lastRequest <= $n` | ~658 000 | ~181 |
| Normal `count = count + 1` path | ~10 | ~10 |
| `rateLimit` live rows | 1 | — |

Supabase `max_connections = 60` matched Hyperdrive `origin_connection_limit = 60`.
Hung auth work held Hyperdrive origin connections; new work waited without a
client-side connect timeout (`Pool` had none).

**Causal chain (one line):**  
DB-backed auth rate limit RMW + Hyperdrive-cached reads + recursive CAS → query
storm → CPU burn + connection exhaustion → multi-minute get-session.

### What is *not* the primary cause

- Client “polling millions of times” (Worker request count stayed ~1k/day)
- Hyperdrive query cache *in general* (safe for read-heavy stable data once RMW counters leave Postgres)
- JWT `definePayload` `SUM(files)` (~100 calls — secondary)

---

## 2. Agreed decisions

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Path-level BA rate limit storage | **None.** Edge `AUTH_RATE_LIMITER` only. No Postgres, no KV. |
| 2 | Session cookie cache | **On**, strategy default (compact), **maxAge = 10 minutes** |
| 3 | `withDb` connect timeout | **`connectionTimeoutMillis: 5_000`** |
| 4 | `"rateLimit"` table DDL | **Keep** (`local_005`). Runtime must not read/write it. |
| 5 | Better Auth `rateLimit` option | **`enabled: false`** |
| 6 | Hyperdrive `origin_connection_limit` | **No change in this fix**; ops checklist only |
| 7 | Edge limiter numbers | **Keep 20 / 60s / IP** |
| 8 | Hyperdrive query caching | **Leave enabled** (after PG rate limit is gone) |

### Explicit non-goals (this fix)

- Disable Hyperdrive query cache
- Lower Hyperdrive origin connection limit (document only)
- Tighten or split Cloudflare rate limit bindings
- `DROP TABLE "rateLimit"`
- Workers KV / Better Auth `secondaryStorage`
- JWT `definePayload` / storage-sum caching
- Changing observability sampling

---

## 3. Target architecture

```
Client  →  GET /api/auth/* 
              │
              ├─ AUTH_RATE_LIMITER (CF binding, IP, 20/60s)
              │     fail → 429, no DB
              │
              └─ withDb (Pool max:1, connectionTimeoutMillis: 5000)
                    └─ Better Auth handler
                          rateLimit: disabled
                          session.cookieCache: 10 min
                          get-session: prefer signed session cookie;
                                       miss → session + user tables only
```

**Auth rate limit** (glossary): the Cloudflare binding only — not Better Auth
and not Postgres. See `CONTEXT.md`.

**Session cookie cache** (glossary): short-lived signed cookie holding session
snapshot so repeated get-session skips the database for up to 10 minutes.

---

## 4. Implementation plan

### 4.1 Code — `src/libs/auth/server.ts`

Replace the ADR-020 rate-limit block and add cookie cache.

```ts
// Rate limiting is edge-only (ADR-021). Do not use storage: 'database' —
// RMW counters through Hyperdrive caused a CAS livelock under query cache.
rateLimit: {
  enabled: false,
},

session: {
  // ADR-022. Signed snapshot; maxAge is the staleness ceiling after revoke/password change.
  cookieCache: {
    enabled: true,
    maxAge: 60 * 10, // 10 minutes
  },
},
```

Update comments that still cite ADR-020 dual storage.

### 4.2 Code — `src/libs/db/index.ts`

```ts
const pool = new Pool({
  connectionString: getConnectionString(),
  max: 1,
  connectionTimeoutMillis: 5_000,
});
```

Document: fail fast rather than hang until Worker wall/CPU limits. Callers may
surface 5xx; that is preferred to multi-minute hangs.

Optional follow-up (not required): `statement_timeout` via startup query if
slow queries (not connects) remain after deploy.

### 4.3 Tests

| File | Change |
| --- | --- |
| `src/__tests__/libs/auth-signup-allowlist.test.ts` | Expect `rateLimit: { enabled: false }` (or equivalent shape Better Auth exposes). Drop `storage: 'database'` assertion. |
| Auth / session tests if any assert cookie-cache-off behaviour | Align with cookie cache on. |
| Keep `rateLimit.test.ts` | Still covers edge binding helpers. |

Run at least:

```bash
cd apps/readest-app
pnpm exec vitest run src/__tests__/libs/auth-signup-allowlist.test.ts src/__tests__/libs/rateLimit.test.ts
```

### 4.4 Schema

- **Do not** add a drop migration for `"rateLimit"`.
- **Do not** remove `local_005_rate_limit.sql` from history.
- After deploy, table may retain a stale row; harmless. Optional ops: `TRUNCATE "rateLimit";` — not required.

### 4.5 Docs (done with this plan)

- [x] This file  
- [x] `CONTEXT.md` — **Auth rate limit**, **Session cookie cache**  
- [x] `docs/database.md` — ADR-021, ADR-022; ADR-020 marked superseded  

### 4.6 Deploy

1. Land code + tests.  
2. Deploy Worker (`opennextjs-cloudflare` / project usual path).  
3. Smoke: `diag-auth-perf.mjs` against production.  
4. Watch Workers: `exceededResources` → 0; wall p99 collapse.  
5. Watch Hyperdrive: query rate should track requests, not 1000×.  
6. Optional later: Hyperdrive origin limit (ops checklist).

No Hyperdrive config change is required for correctness of this fix.

---

## 5. Acceptance criteria

### Automated / scripted

```bash
node apps/readest-app/scripts/diag-auth-perf.mjs https://read.sumku.cc
```

| Check | Pass |
| --- | --- |
| Sequential ×5 get-session p95 | **&lt; 2s** |
| Concurrent ×10 all HTTP 200 | **yes** |
| Concurrent p95 | **&lt; 5s** |
| Script exit | **GREEN** (exit 0) |

Unauthenticated body may be `null`; that is fine — the loop measures latency
and availability of the path that was livelocking.

### Production metrics (24h after deploy)

| Metric | Target |
| --- | --- |
| Workers `exceededResources` | ~0 |
| get-session wall p99 | seconds, not minutes |
| Hyperdrive queries / Worker requests | order of **low tens per request**, not ~10³ |
| `pg_stat_statements` rateLimit CAS | no further growth at previous scale (or only residual) |

### Functional

- Sign-in / sign-up / password reset still work; Turnstile still enforced.  
- Edge 429 still works when IP exceeds 20/60s.  
- After sign-out, UI clears local token (existing AuthProvider behaviour).  
- Within 10 minutes of server-side session revoke, cookie cache may still
  report a session until maxAge or cookie clear — accepted trade-off (ADR-022).

---

## 6. Verification during implementation

1. **Local / unit:** auth option shape + rateLimit helper tests green.  
2. **Staging or prod after deploy:** run `diag-auth-perf.mjs` once cold, once warm.  
3. **DB (optional):**  
   `SELECT calls, rows, left(query,80) FROM pg_stat_statements WHERE query ILIKE '%rateLimit%' ORDER BY calls DESC;`  
   New calls to CAS update should stop after deploy.  
4. **If still RED:**  
   - Confirm deploy version includes `rateLimit.enabled: false`.  
   - Confirm no other Worker still uses old bundle against same Hyperdrive.  
   - Only then consider Hyperdrive cache / origin limit (ops checklist) — do not
     re-enable DB rate limit.

---

## 7. Ops checklist (out of this PR, after green)

Recorded so they are not forgotten; **not** part of the agreed code fix.

1. Consider lowering Hyperdrive `origin_connection_limit` from 60 → ~20 so it
   does not equal Supabase `max_connections`.  
2. If credential stuffing becomes a concern without BA path rules: second CF
   ratelimit binding or path-aware rules — **not** Postgres counters.  
3. Confirm Supabase region proximity to Worker placement (`gcp:asia-east1`).  
4. Optional: `TRUNCATE "rateLimit"` once runtime traffic is clean.

---

## 8. File checklist

| Path | Action |
| --- | --- |
| `src/libs/auth/server.ts` | `rateLimit.enabled: false`; `session.cookieCache` 10 min |
| `src/libs/db/index.ts` | `connectionTimeoutMillis: 5_000` |
| `src/__tests__/libs/auth-signup-allowlist.test.ts` | Update rateLimit expectation |
| `src/app/api/auth/[...all]/route.ts` | Comment only if it still mentions BA DB limiter |
| `docs/auth-perf-fix.md` | This plan |
| `docs/database.md` | ADR-020 superseded; ADR-021, ADR-022 |
| `CONTEXT.md` (repo root) | Glossary updates |
| `scripts/diag-auth-perf.mjs` | Already present — keep as regression loop |

---

## 9. Risk and rollback

| Risk | Mitigation |
| --- | --- |
| Cookie cache shows session up to 10 min after revoke | Accept for single-operator; sign-out clears cookies; shorten maxAge later if needed |
| Edge 20/60s too loose without BA special rules | Turnstile + allow-list; monitor; tighten CF binding later |
| Connect timeout 5s false failures under rare slowness | Prefer fail-fast; raise only with evidence |
| Rollback | Revert Worker deploy. **Do not** re-enable `storage: 'database'` without also disabling Hyperdrive query cache and fixing CAS recursion — that combination is the incident. |

---

## 10. References

- Diagnosis session notes (Workers GraphQL, `pg_stat_statements`, concurrent timeout repro)  
- Better Auth performance guide: cookie cache / secondary storage (secondary storage **not** used in this fix)  
- ADR-020 (historical), ADR-021, ADR-022 in `docs/database.md`  
- `scripts/diag-auth-perf.mjs`
