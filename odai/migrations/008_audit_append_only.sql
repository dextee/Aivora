-- 008: tamper-evident execution records + financial integrity
-- Tightens 004's member-scoped write policies so audit/ledger/profit are APPEND-ONLY for
-- authenticated roles, and spend approvals can be decided but never erased.
-- Service-role (server admin) still bypasses RLS for legitimate writes; INSERT/SELECT are preserved.
-- Nothing here deletes data — it removes the UPDATE/DELETE policies that let owner/admin mutate or
-- erase execution and financial records.

-- Remove DELETE on audit + financial tables (no authenticated user may erase records)
DROP POLICY IF EXISTS odai_member_delete ON odai_trace;
DROP POLICY IF EXISTS odai_member_delete ON odai_receipt;
DROP POLICY IF EXISTS odai_member_delete ON odai_ledger_entry;
DROP POLICY IF EXISTS odai_member_delete ON odai_profit_snapshot;
DROP POLICY IF EXISTS odai_member_delete ON odai_spend_approval;

-- Remove UPDATE on immutable append-only tables (execution records + ledger + profit)
DROP POLICY IF EXISTS odai_member_update ON odai_trace;
DROP POLICY IF EXISTS odai_member_update ON odai_receipt;
DROP POLICY IF EXISTS odai_member_update ON odai_ledger_entry;
DROP POLICY IF EXISTS odai_member_update ON odai_profit_snapshot;
-- odai_spend_approval intentionally KEEPS its owner/admin UPDATE policy so the approve/decline
-- decision can be recorded; it simply can no longer be deleted.
