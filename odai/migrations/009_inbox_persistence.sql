-- 009_inbox_persistence.sql — validated membership lifecycle + persistent notifications,
-- recipients (per-user read state) and durable approvals for the online Inbox.
-- Additive only: extends odai_workspace_member, adds three tables. Never drops data.
-- Idempotent (IF NOT EXISTS / DO blocks) so a re-run is a safe no-op.

-- 1) Membership lifecycle fields (spec §4). Existing rows keep ACTIVE.
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS membership_status text NOT NULL DEFAULT 'ACTIVE'
  CHECK (membership_status IN ('ACTIVE','PENDING','SUSPENDED','REVOKED'));
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS invited_by uuid;
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE odai_workspace_member ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2) Persistent notification event record (spec §7). Dedup unique per workspace+key.
CREATE TABLE IF NOT EXISTS odai_notification (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  source_module text NOT NULL,
  source_event_id text,
  source_entity_type text,
  source_entity_id text,
  objective_id text,
  task_id text,
  agent_id text,
  skill_id text,
  notification_type text NOT NULL,
  category text NOT NULL,
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  title text NOT NULL,
  message text NOT NULL,
  structured_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text,
  action_reference text,
  deduplication_key text NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  schema_version integer NOT NULL DEFAULT 1,
  CONSTRAINT odai_notification_dedup UNIQUE (tenant_id, deduplication_key)
);

-- 3) Per-recipient delivery/read state (spec §8): one user marking read must not
--    mark read for others. Unique per notification+user.
CREATE TABLE IF NOT EXISTS odai_notification_recipient (
  notification_recipient_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES odai_notification(notification_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  delivery_status text NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED')),
  read_at timestamptz,
  acknowledged_at timestamptz,
  archived_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT odai_notification_recipient_unique UNIQUE (notification_id, user_id)
);

-- 4) Durable approval record (spec §11): the notification is NOT the approval.
--    Bound to entity version + payload hash; parameter change invalidates.
CREATE TABLE IF NOT EXISTS odai_approval (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  objective_id text,
  task_id text,
  source_entity_type text NOT NULL,
  source_entity_id text NOT NULL,
  requested_by_agent_id text,
  required_permission text NOT NULL,
  authorized_owner_id uuid,
  requested_action text NOT NULL,
  approved_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_version integer NOT NULL DEFAULT 1,
  payload_hash text NOT NULL,
  approval_status text NOT NULL DEFAULT 'PENDING'
    CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','EXPIRED','INVALIDATED','EXECUTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  executed_at timestamptz,
  execution_reference text,
  CONSTRAINT odai_approval_entity_unique UNIQUE (tenant_id, source_entity_type, source_entity_id, payload_hash)
);

-- 5) Indexes (spec §12).
CREATE INDEX IF NOT EXISTS idx_odai_notification_tenant_created ON odai_notification (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_odai_notification_category ON odai_notification (tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_odai_notification_priority ON odai_notification (tenant_id, priority);
CREATE INDEX IF NOT EXISTS idx_odai_notification_source_entity ON odai_notification (tenant_id, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_odai_notification_objective ON odai_notification (tenant_id, objective_id);
CREATE INDEX IF NOT EXISTS idx_odai_notif_recipient_user ON odai_notification_recipient (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_odai_notif_recipient_read ON odai_notification_recipient (notification_id, read_at);
CREATE INDEX IF NOT EXISTS idx_odai_approval_tenant_status ON odai_approval (tenant_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_odai_approval_entity ON odai_approval (tenant_id, source_entity_type, source_entity_id);

-- 6) RLS: workspace isolation; members read their workspace's notifications and their
--    own recipient rows; only owner/admin may create approvals or write notifications;
--    recipients update only their own read state. Reuses the SECURITY DEFINER helpers
--    from 003 (already granted to authenticated + service_role).
ALTER TABLE odai_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_notification_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_approval ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS odai_notif_member_select ON odai_notification;
  CREATE POLICY odai_notif_member_select ON odai_notification FOR SELECT
    USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_notif_admin_insert ON odai_notification;
  CREATE POLICY odai_notif_admin_insert ON odai_notification FOR INSERT
    WITH CHECK (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_notif_no_update ON odai_notification;
  CREATE POLICY odai_notif_no_update ON odai_notification FOR UPDATE
    USING (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_notif_no_delete ON odai_notification;
  CREATE POLICY odai_notif_no_delete ON odai_notification FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_notifrecip_own_select ON odai_notification_recipient;
  CREATE POLICY odai_notifrecip_own_select ON odai_notification_recipient FOR SELECT
    USING (public.odai_is_member(tenant_id) AND user_id = auth.uid());
  DROP POLICY IF EXISTS odai_notifrecip_own_update ON odai_notification_recipient;
  CREATE POLICY odai_notifrecip_own_update ON odai_notification_recipient FOR UPDATE
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  DROP POLICY IF EXISTS odai_notifrecip_admin_insert ON odai_notification_recipient;
  CREATE POLICY odai_notifrecip_admin_insert ON odai_notification_recipient FOR INSERT
    WITH CHECK (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_notifrecip_no_delete ON odai_notification_recipient;
  CREATE POLICY odai_notifrecip_no_delete ON odai_notification_recipient FOR DELETE USING (false);

  DROP POLICY IF EXISTS odai_approval_member_select ON odai_approval;
  CREATE POLICY odai_approval_member_select ON odai_approval FOR SELECT
    USING (public.odai_is_member(tenant_id));
  DROP POLICY IF EXISTS odai_approval_admin_write ON odai_approval;
  CREATE POLICY odai_approval_admin_write ON odai_approval FOR INSERT
    WITH CHECK (public.odai_can_write(tenant_id));
  DROP POLICY IF EXISTS odai_approval_owner_update ON odai_approval;
  CREATE POLICY odai_approval_owner_update ON odai_approval FOR UPDATE
    USING (public.odai_can_write(tenant_id) AND (authorized_owner_id IS NULL OR authorized_owner_id = auth.uid()));
  DROP POLICY IF EXISTS odai_approval_no_delete ON odai_approval;
  CREATE POLICY odai_approval_no_delete ON odai_approval FOR DELETE USING (false);
END $$;

-- 7) Never auto-grant anon execute on any function this migration might add (none added),
--    and keep future public functions from default-granting anon (defense in depth, 007).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
