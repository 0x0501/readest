-- Ours, not upstream. The table the daily-quota counters were always missing.
-- The ADRs cited below are in apps/readest-app/docs/database.md.
--
-- `utils/usage.ts` calls two Postgres functions, `increment_daily_usage` and
-- `get_current_usage`. Neither is defined in docker/volumes/db/migrations/, and
-- no table backs them either: upstream created both directly in its own hosted
-- project and never shipped the SQL. On any database built from the tracked
-- migrations the calls fail, the catch logs, and the counter returns 0 — so the
-- DeepL daily quota has never actually counted anything.
--
-- The functions are not recreated. Only upstream's *existing* function bodies
-- are preserved verbatim (ADR-010); there is nothing to preserve here, and a
-- counter reads better as two Drizzle statements than as PL/pgSQL (ADR-002).
--
-- Collision risk worth knowing: if upstream ever ships its own `usage_stats`,
-- its migration will fail to apply against this table rather than silently
-- diverging. That is the failure mode we want — see references/divergences.md.

CREATE TABLE IF NOT EXISTS public.usage_stats (
  user_id uuid NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  usage_type text NOT NULL,
  usage_date date NOT NULL,
  usage_count bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_type, usage_date)
);

-- The monthly rollup scans a date range within one (user, type), which the
-- primary key already orders. No second index earns its keep.
