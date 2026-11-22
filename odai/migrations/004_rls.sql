-- 20261122000004_odai_rls.sql — role-based RLS across the ODAI tables (anonymous stays denied)
-- 20 tenant-scoped tables: SELECT for any member; INSERT/UPDATE/DELETE for owner/admin, all gated by tenant_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'odai_supplier','odai_product','odai_variant','odai_price_history','odai_source_receipt',
    'odai_catalog_review','odai_inventory_status','odai_channel_listing','odai_customer_consent',
    'odai_campaign','odai_spend_approval','odai_order','odai_fulfillment_handoff','odai_refund',
    'odai_expense','odai_ledger_entry','odai_profit_snapshot','odai_run','odai_trace','odai_receipt'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS odai_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY odai_member_read ON public.%I FOR SELECT TO authenticated USING (odai_is_member(tenant_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS odai_member_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY odai_member_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (odai_can_write(tenant_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS odai_member_update ON public.%I', t);
    EXECUTE format('CREATE POLICY odai_member_update ON public.%I FOR UPDATE TO authenticated USING (odai_can_write(tenant_id)) WITH CHECK (odai_can_write(tenant_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS odai_member_delete ON public.%I', t);
    EXECUTE format('CREATE POLICY odai_member_delete ON public.%I FOR DELETE TO authenticated USING (odai_can_write(tenant_id))', t);
  END LOOP;
END $$;

-- odai_fx_rate has no tenant_id (global rates): readable by any member, writable by any owner/admin.
ALTER TABLE odai_fx_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_fx_rate FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS odai_fx_read ON odai_fx_rate;
CREATE POLICY odai_fx_read ON odai_fx_rate FOR SELECT TO authenticated USING (odai_is_any_member());
DROP POLICY IF EXISTS odai_fx_write ON odai_fx_rate;
CREATE POLICY odai_fx_write ON odai_fx_rate FOR ALL TO authenticated USING (odai_is_admin_any()) WITH CHECK (odai_is_admin_any());

-- FORCE RLS makes the table owner subject to policies too; seed/migration must run as the
-- service_role (which bypasses RLS), never as the table owner.
