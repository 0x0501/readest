-- Ours, not upstream. Runs first, before the base schema.
--
-- Upstream's SQL is written against a Supabase database: it GRANTs to the
-- `authenticated` / `anon` / `service_role` roles, installs pgcrypto into an
-- `extensions` schema, points twelve foreign keys at `auth.users`, and calls
-- `auth.uid()` from RLS policies and from seven function bodies. None of that
-- exists on a stock Postgres.
--
-- Providing those four things here is what lets every upstream migration apply
-- verbatim, forever, with no hand-translated DDL (ADR-003).

CREATE SCHEMA IF NOT EXISTS auth;

-- 008 does `CREATE EXTENSION pgcrypto WITH SCHEMA extensions` and then calls
-- `extensions.gen_random_bytes()`.
CREATE SCHEMA IF NOT EXISTS extensions;

-- GRANT and POLICY targets only; nothing ever logs in as these. Authorization
-- is enforced in the application layer (ADR-005) and the app connects as the
-- owner, which bypasses RLS, so the policies upstream attaches to these roles
-- are inert. They exist so upstream's statements parse.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- The target of upstream's twelve `REFERENCES auth.users(id)` clauses. Stays
-- empty: local_002_repoint_user_fks.sql moves those keys onto Better Auth's
-- `public."user"` once it exists. The table itself is kept so that a future
-- upstream migration adding another `REFERENCES auth.users(id)` still applies —
-- re-pointing it is then one more statement (ADR-007).
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);

-- Supabase's `auth.uid()` reads the subject claim that PostgREST copies out of
-- the JWT into a session variable. Ours reads the same variable, so the seven
-- RPC bodies in 008 / 010 / 012 are unchanged and any upstream edit to them
-- takes effect as-is (ADR-010). The caller sets it with `set_config(...)` inside
-- the same transaction as the call; unset yields NULL, which matches no row.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
