-- tools/supa_verify.sql — deterministic RLS verification for the ODAI Supabase schema.
-- Run as a superuser via:  supabase db query --local --file tools/supa_verify.sql
--   (or)  psql "$SUPABASE_DB_URL" -f tools/supa_verify.sql
-- Each scenario runs in its own transaction with SET LOCAL ROLE + a simulated auth.uid() claim,
-- so it exercises the real RLS policies without needing a live login. RAISE EXCEPTION => FAIL.
-- Test principals (seeded by migration 003):
--   owner   00000000-0000-0000-0000-0000000000a1  (demo-uncle-coffee-wellness)
--   member  00000000-0000-0000-0000-0000000000b1  (demo-uncle-coffee-wellness)
--   other   00000000-0000-0000-0000-0000000000c1  (demo-other-tenant-42)

\set ON_ERROR_STOP on

-- 1) signed-in member can READ the demo catalog (expect 10)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
DO $$ BEGIN
  IF (SELECT count(*) FROM odai_product WHERE tenant_id='demo-uncle-coffee-wellness') <> 10
    THEN RAISE EXCEPTION 'FAIL member_read: expected 10 visible products';
    ELSE RAISE NOTICE 'PASS member_read=10';
  END IF;
END $$;
ROLLBACK;

-- 2) ANONYMOUS access is DENIED (expect 0 visible)
BEGIN;
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF (SELECT count(*) FROM odai_product) <> 0
    THEN RAISE EXCEPTION 'FAIL anon_denied: anon can see % rows', (SELECT count(*) FROM odai_product);
    ELSE RAISE NOTICE 'PASS anon_denied';
  END IF;
END $$;
ROLLBACK;

-- 3) CROSS-WORKSPACE read is DENIED (other tenant owner sees 0 of demo tenant rows)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
DO $$ BEGIN
  IF (SELECT count(*) FROM odai_product WHERE tenant_id='demo-uncle-coffee-wellness') <> 0
    THEN RAISE EXCEPTION 'FAIL cross_workspace_denied: foreign user can read demo rows';
    ELSE RAISE NOTICE 'PASS cross_workspace_denied';
  END IF;
END $$;
ROLLBACK;

-- 4) OWNER write is ALLOWED (insert a run row)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
INSERT INTO odai_run (tenant_id, run_id, objective, state)
  VALUES ('demo-uncle-coffee-wellness','verify-run-persist','verify','RUNNING');
DO $$ BEGIN
  IF (SELECT count(*) FROM odai_run WHERE run_id='verify-run-persist') <> 1
    THEN RAISE EXCEPTION 'FAIL owner_write: insert did not land';
    ELSE RAISE NOTICE 'PASS owner_write';
  END IF;
END $$;
COMMIT;  -- committed: proves durable write

-- 5) PERSISTENCE after a new session (fresh transaction re-reads the committed row as the owner)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
DO $$ BEGIN
  IF (SELECT count(*) FROM odai_run WHERE run_id='verify-run-persist') <> 1
    THEN RAISE EXCEPTION 'FAIL persistence: committed row not visible in new transaction';
    ELSE RAISE NOTICE 'PASS persistence';
  END IF;
END $$;
ROLLBACK;

-- 6) MEMBER (non-admin) write is DENIED by RLS (insufficient_privilege)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1"}';
DO $$ BEGIN
  BEGIN
    INSERT INTO odai_run (tenant_id, run_id, objective, state)
      VALUES ('demo-uncle-coffee-wellness','verify-member-no-write','x','RUNNING');
    RAISE EXCEPTION 'FAIL member_write_denied: member was allowed to insert';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS member_write_denied';
  END;
END $$;
ROLLBACK;

-- cleanup the committed verify row (as owner)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
DELETE FROM odai_run WHERE run_id='verify-run-persist';
COMMIT;

DO $$ BEGIN RAISE NOTICE 'SUPA_VERIFY complete'; END $$;
