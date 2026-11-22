-- 20261122000003_odai_identity.sql — workspace membership + role (keyed on Supabase Auth uid) + RLS helper functions
CREATE TABLE IF NOT EXISTS odai_workspace_member (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Helper predicates. SECURITY INVOKER + fixed search_path so they evaluate under the
-- caller's own RLS context (they read odai_workspace_member, which exposes only the
-- caller's own membership row to non-service roles). Never exposed via the API schema.
CREATE OR REPLACE FUNCTION odai_is_member(p_tenant text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM odai_workspace_member m
                 WHERE m.user_id = auth.uid() AND m.tenant_id = p_tenant
                   AND m.role IN ('owner','admin','member'));
$$;

CREATE OR REPLACE FUNCTION odai_can_write(p_tenant text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM odai_workspace_member m
                 WHERE m.user_id = auth.uid() AND m.tenant_id = p_tenant
                   AND m.role IN ('owner','admin'));
$$;

CREATE OR REPLACE FUNCTION odai_is_any_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM odai_workspace_member m WHERE m.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION odai_is_admin_any() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM odai_workspace_member m
                 WHERE m.user_id = auth.uid() AND m.role IN ('owner','admin'));
$$;

CREATE OR REPLACE FUNCTION odai_is_admin_member(p_tenant text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM odai_workspace_member m
                 WHERE m.user_id = auth.uid() AND m.tenant_id = p_tenant
                   AND m.role IN ('owner','admin'));
$$;

-- Helpers must be callable by signed-in users (so the RLS policies can evaluate them)
-- and by the service role (admin), but NOT by anon. Revoke the default PUBLIC grant,
-- then explicitly allow authenticated + service_role. Signatures differ: the *_any
-- predicates take no argument.
REVOKE ALL ON FUNCTION public.odai_is_member(text)        FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_is_member(text)    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.odai_can_write(text)        FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_can_write(text)    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.odai_is_any_member()        FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_is_any_member()    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.odai_is_admin_any()         FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_is_admin_any()     TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.odai_is_admin_member(text)  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_is_admin_member(text) TO authenticated, service_role;

-- Membership table: a user can read their own row; an owner/admin of a tenant can manage that tenant's members.
ALTER TABLE odai_workspace_member ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_self_select ON odai_workspace_member;
CREATE POLICY member_self_select ON odai_workspace_member FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS member_admin_manage ON odai_workspace_member;
CREATE POLICY member_admin_manage ON odai_workspace_member FOR ALL TO authenticated
  USING (odai_is_admin_member(tenant_id)) WITH CHECK (odai_is_admin_member(tenant_id));

-- Demo seed (runs under the migration/service role, which bypasses RLS). Fixed uuids so
-- verification can simulate the corresponding JWT claims.
INSERT INTO odai_workspace_member (tenant_id, user_id, role) VALUES
  ('demo-uncle-coffee-wellness','00000000-0000-0000-0000-0000000000a1','owner'),
  ('demo-uncle-coffee-wellness','00000000-0000-0000-0000-0000000000b1','member'),
  ('demo-other-tenant-42','00000000-0000-0000-0000-0000000000c1','owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;
