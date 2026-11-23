-- 010_purchase_procurement.sql — durable purchase-order / procurement schema.
-- Reuses odai_supplier (001) for supplier identity; adds PO lifecycle, goods receipts
-- (dedup by receipt_key), append-only status history, durable inventory positions and
-- movements. RLS: members read own workspace; only owner/admin mutate; history/receipts/
-- movements are append-only (tamper-evident). Idempotent; never drops data.

CREATE TABLE IF NOT EXISTS odai_purchase_order (
  tenant_id text NOT NULL,
  po_id text NOT NULL,
  sku text NOT NULL,
  supplier_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  received_units integer NOT NULL DEFAULT 0,
  outstanding_units integer NOT NULL,
  unit_cost numeric NOT NULL CHECK (unit_cost >= 0),
  total numeric NOT NULL CHECK (total >= 0),
  currency text NOT NULL DEFAULT 'SGD',
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  action_hash text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_sandbox boolean NOT NULL DEFAULT true,
  sent_to_supplier boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id, po_id),
  CONSTRAINT odai_po_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES odai_supplier (tenant_id, supplier)
);

CREATE TABLE IF NOT EXISTS odai_po_status_history (
  tenant_id text NOT NULL,
  po_id text NOT NULL,
  seq bigserial,
  status text NOT NULL,
  note text,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, po_id, seq),
  CONSTRAINT odai_po_hist_fk FOREIGN KEY (tenant_id, po_id) REFERENCES odai_purchase_order (tenant_id, po_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS odai_po_receipt (
  tenant_id text NOT NULL,
  po_id text NOT NULL,
  receipt_key text NOT NULL,
  units integer NOT NULL CHECK (units > 0),
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, po_id, receipt_key),
  CONSTRAINT odai_po_receipt_fk FOREIGN KEY (tenant_id, po_id) REFERENCES odai_purchase_order (tenant_id, po_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS odai_inventory_position (
  tenant_id text NOT NULL,
  sku text NOT NULL,
  stock_on_hand integer NOT NULL DEFAULT 0,
  confirmed_incoming integer NOT NULL DEFAULT 0,
  committed_stock integer NOT NULL DEFAULT 0,
  lead_time_days integer NOT NULL DEFAULT 0,
  safety_stock integer NOT NULL DEFAULT 0,
  pack_size integer NOT NULL DEFAULT 1,
  target_inventory integer NOT NULL DEFAULT 0,
  supplier_unit_cost numeric,
  budget numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS odai_inventory_movement (
  tenant_id text NOT NULL,
  movement_id text NOT NULL,
  po_id text,
  sku text NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL,
  receipt_key text,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, movement_id)
);

CREATE INDEX IF NOT EXISTS idx_odai_po_tenant_status ON odai_purchase_order (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_odai_po_tenant_sku ON odai_purchase_order (tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_odai_po_tenant_created ON odai_purchase_order (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_odai_po_hist_tenant ON odai_po_status_history (tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_odai_po_receipt_tenant ON odai_po_receipt (tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_odai_invpos_tenant ON odai_inventory_position (tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_odai_invmov_tenant_sku ON odai_inventory_movement (tenant_id, sku, ts);

ALTER TABLE odai_purchase_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_po_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_po_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_inventory_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_inventory_movement ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS odai_po_member_select ON odai_purchase_order;
  CREATE POLICY odai_po_member_select ON odai_purchase_order FOR SELECT USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_po_admin_write ON odai_purchase_order;
  CREATE POLICY odai_po_admin_write ON odai_purchase_order FOR INSERT WITH CHECK (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_po_admin_update ON odai_purchase_order;
  CREATE POLICY odai_po_admin_update ON odai_purchase_order FOR UPDATE USING (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_po_no_delete ON odai_purchase_order;
  CREATE POLICY odai_po_no_delete ON odai_purchase_order FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_pohist_member_select ON odai_po_status_history;
  CREATE POLICY odai_pohist_member_select ON odai_po_status_history FOR SELECT USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_pohist_append_only ON odai_po_status_history;
  CREATE POLICY odai_pohist_append_only ON odai_po_status_history FOR INSERT WITH CHECK (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_pohist_no_update ON odai_po_status_history;
  CREATE POLICY odai_pohist_no_update ON odai_po_status_history FOR UPDATE USING (false);
  DROP POLICY IF EXISTS odai_pohist_no_delete ON odai_po_status_history;
  CREATE POLICY odai_pohist_no_delete ON odai_po_status_history FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_poreceipt_member_select ON odai_po_receipt;
  CREATE POLICY odai_poreceipt_member_select ON odai_po_receipt FOR SELECT USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_poreceipt_append_only ON odai_po_receipt;
  CREATE POLICY odai_poreceipt_append_only ON odai_po_receipt FOR INSERT WITH CHECK (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_poreceipt_no_update ON odai_po_receipt;
  CREATE POLICY odai_poreceipt_no_update ON odai_po_receipt FOR UPDATE USING (false);
  DROP POLICY IF EXISTS odai_poreceipt_no_delete ON odai_po_receipt;
  CREATE POLICY odai_poreceipt_no_delete ON odai_po_receipt FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_invpos_member_select ON odai_inventory_position;
  CREATE POLICY odai_invpos_member_select ON odai_inventory_position FOR SELECT USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_invpos_admin_write ON odai_inventory_position;
  CREATE POLICY odai_invpos_admin_write ON odai_inventory_position FOR INSERT WITH CHECK (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_invpos_admin_update ON odai_inventory_position;
  CREATE POLICY odai_invpos_admin_update ON odai_inventory_position FOR UPDATE USING (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_invpos_no_delete ON odai_inventory_position;
  CREATE POLICY odai_invpos_no_delete ON odai_inventory_position FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_invmov_member_select ON odai_inventory_movement;
  CREATE POLICY odai_invmov_member_select ON odai_inventory_movement FOR SELECT USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_invmov_append_only ON odai_inventory_movement;
  CREATE POLICY odai_invmov_append_only ON odai_inventory_movement FOR INSERT WITH CHECK (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_invmov_no_update ON odai_inventory_movement;
  CREATE POLICY odai_invmov_no_update ON odai_inventory_movement FOR UPDATE USING (false);
  DROP POLICY IF EXISTS odai_invmov_no_delete ON odai_inventory_movement;
  CREATE POLICY odai_invmov_no_delete ON odai_inventory_movement FOR DELETE USING (false);
END $$;

-- Keep the 007 posture: future public functions must not auto-grant anon.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
