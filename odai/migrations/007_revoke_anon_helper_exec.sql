-- 20261122000007_odai_revoke_anon_helper_exec.sql — G3 hardening: anon must not execute the RLS/approve helpers.
-- Why: Supabase's default privileges grant anon EXECUTE on public functions EXPLICITLY
--      (ACL shows "anon=X/postgres"), so the earlier "REVOKE ... FROM PUBLIC" in 003/006
--      did not strip anon. This revokes anon EXECUTE on the 7 helpers and stops future
--      auto-grants. Impact if unfixed was LOW (boolean-only helpers; anon has no table
--      SELECT policy; odai_approve_upload still raises 42501 for non-owners), but it
--      violates defense-in-depth (evidence check G3).
-- Verified on STAGING (icwjixjlxvicuwicwyot) as migration odai_revoke_anon_helper_exec:
--   evidence re-run = 12/12 PASS (G3 anon_exec=false for all helpers).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'odai_is_member(text)',
    'odai_can_write(text)',
    'odai_is_any_member()',
    'odai_is_admin_any()',
    'odai_is_admin_member(text)',
    'odai_upload_is_approved(text)',
    'odai_approve_upload(text,uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM anon', f);
  END LOOP;
END $$;

-- Prevent recurrence: future public functions must not auto-grant EXECUTE to anon.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
