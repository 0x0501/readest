-- Migration 900: custom access token hook supplying the `plan` claim.
--
-- utils/access.ts reads the subscription plan straight off the JWT
-- (`jwtDecode(token)['plan']`), and every premium gate — email-in
-- (isEmailInPlan), third-party cloud sync (isCloudSyncAllowed), offline TTS
-- download (isTTSCacheAllowed) — keys off it. The hook that produces that claim
-- is not part of the open-source tree, so a self-hosted deployment issues
-- tokens with no `plan` at all and every user reads as 'free', locking those
-- three features for everyone.
--
-- This deployment has no billing, so the hook returns 'pro' unconditionally.
-- Nothing expires it: getSubscriptionPlan only reads `plan`, and every token
-- refresh re-runs this function.
--
-- `storage_usage_bytes` is the other claim getStoragePlanData expects. Left
-- absent it reads as 0 and the profile page's storage bar sits empty forever,
-- so compute it from the files table. The quota it is compared against comes
-- from STORAGE_FIXED_QUOTA (see wrangler.toml [vars]).
--
-- Numbered 900 to stay clear of upstream's 0NN sequence.
--
-- After applying, enable it under Authentication > Hooks > Custom Access Token
-- and point it at public.custom_access_token_hook.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
-- SECURITY DEFINER so the hook can read public.files, which has RLS enabled and
-- policies written against auth.uid() — inside the hook there is no session
-- user for those policies to match. Supabase documents this as the alternative
-- to hand-writing a supabase_auth_admin policy on every table the hook touches.
-- Empty search_path per Supabase's function linting; names are qualified below.
security definer
set search_path = ''
as $$
declare
  updated_claims jsonb;
  usage_bytes bigint;
begin
  select coalesce(sum(f.file_size), 0)
    into usage_bytes
    from public.files f
   where f.user_id = (event ->> 'user_id')::uuid
     and f.deleted_at is null;

  updated_claims := event -> 'claims';
  updated_claims := jsonb_set(updated_claims, '{plan}', to_jsonb('pro'::text));
  updated_claims := jsonb_set(updated_claims, '{storage_usage_bytes}', to_jsonb(usage_bytes));

  return jsonb_set(event, '{claims}', updated_claims);
end;
$$;

-- Reachable by GoTrue and nobody else.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
