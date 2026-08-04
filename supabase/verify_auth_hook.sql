-- Verifies 900_auth_hook_plan_claim.sql against a database it has been applied
-- to. Everything happens inside a transaction that is rolled back, so it is safe
-- to run against the live project.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/verify_auth_hook.sql
--
-- Passing output ends with `PASS: ...`; any failed assertion aborts.

begin;

-- Some servers raise the threshold above NOTICE, which would hide the PASS
-- lines and make a passing run indistinguishable from one that did nothing.
set local client_min_messages = notice;

do $$
declare
  -- Random so a repeat run never collides with leftovers from an aborted one.
  uid uuid := gen_random_uuid();
  result jsonb;
begin
  -- A user with no files at all: the claim must still be issued, usage zero.
  result := public.custom_access_token_hook(jsonb_build_object(
    'user_id', gen_random_uuid(),
    'claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated')));
  assert result -> 'claims' ->> 'plan' = 'pro',
    'unknown user should still get plan=pro, got ' || coalesce(result -> 'claims' ->> 'plan', '<null>');
  assert (result -> 'claims' ->> 'storage_usage_bytes')::bigint = 0,
    'unknown user should report zero usage, got ' || (result -> 'claims' ->> 'storage_usage_bytes');

  insert into auth.users (id, instance_id, aud, role, email)
  values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify-auth-hook@invalid');
  insert into public.files (user_id, file_key, file_size, deleted_at) values
    (uid, 'verify-a.epub', 1000, null),
    (uid, 'verify-b.epub', 2500, null),
    (uid, 'verify-c.epub', 9999, now());   -- soft-deleted, must not count

  result := public.custom_access_token_hook(jsonb_build_object(
    'user_id', uid,
    'claims', jsonb_build_object('sub', uid::text, 'role', 'authenticated', 'aud', 'authenticated')));

  assert result -> 'claims' ->> 'plan' = 'pro',
    'plan claim wrong: ' || coalesce(result -> 'claims' ->> 'plan', '<null>');
  assert (result -> 'claims' ->> 'storage_usage_bytes')::bigint = 3500,
    'usage should exclude soft-deleted rows, got ' || (result -> 'claims' ->> 'storage_usage_bytes');
  -- GoTrue rejects a hook that drops the claims it requires.
  assert result -> 'claims' ->> 'role' = 'authenticated', 'existing claims must survive';
  assert result -> 'claims' ->> 'aud' = 'authenticated', 'existing claims must survive';
  assert result ->> 'user_id' = uid::text, 'the event envelope must survive';

  raise notice 'PASS: plan=pro, usage excludes soft-deleted files, existing claims preserved';
end $$;

-- Only GoTrue may call it.
do $$
begin
  assert has_function_privilege('supabase_auth_admin',
    'public.custom_access_token_hook(jsonb)', 'execute'), 'supabase_auth_admin must be able to execute';
  assert not has_function_privilege('authenticated',
    'public.custom_access_token_hook(jsonb)', 'execute'), 'authenticated must not be able to execute';
  assert not has_function_privilege('anon',
    'public.custom_access_token_hook(jsonb)', 'execute'), 'anon must not be able to execute';
  raise notice 'PASS: execute granted to supabase_auth_admin only';
end $$;

rollback;
