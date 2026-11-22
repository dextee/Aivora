-- 20261122000006_odai_upload_approval.sql — upload approval gate.
-- A private upload is INACCESSIBLE (metadata + file bytes) until an owner/admin approves it.
ALTER TABLE odai_upload ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;
ALTER TABLE odai_upload ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE odai_upload ADD COLUMN IF NOT EXISTS approved_at timestamptz;
-- Populate uploaded_by from the caller's JWT at insert time (PostgREST request context).
ALTER TABLE odai_upload ALTER COLUMN uploaded_by SET DEFAULT auth.uid();

-- True only when the matching odai_upload row exists, is approved, and the caller is a member
-- of that tenant. SECURITY DEFINER so it can read odai_upload/membership without recursion;
-- returns a boolean only (no row data). Guarded so a non-UUID second path segment is safe.
CREATE OR REPLACE FUNCTION odai_upload_is_approved(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (split_part(p_name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     AND EXISTS (
       SELECT 1 FROM odai_upload u
       WHERE u.tenant_id = split_part(p_name,'/',1)
         AND u.upload_id = split_part(p_name,'/',2)::uuid
         AND u.approved
     )
     AND odai_is_member(split_part(p_name,'/',1));
$$;
REVOKE ALL ON FUNCTION public.odai_upload_is_approved(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_upload_is_approved(text) TO authenticated, service_role;

-- Approve RPC: owner/admin only; sets approved + approver + timestamp. SECURITY DEFINER with an
-- explicit role check (auth.uid() is the caller's claim even inside a definer function).
CREATE OR REPLACE FUNCTION odai_approve_upload(p_tenant text, p_upload_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM odai_workspace_member m
                 WHERE m.user_id = auth.uid() AND m.tenant_id = p_tenant AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'not authorized to approve uploads for this workspace' USING errcode = '42501';
  END IF;
  UPDATE odai_upload SET approved = true, approved_by = auth.uid(), approved_at = now()
    WHERE tenant_id = p_tenant AND upload_id = p_upload_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.odai_approve_upload(text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.odai_approve_upload(text, uuid) TO authenticated, service_role;

-- Metadata read: approved rows are visible to any member; a user always sees their OWN uploads
-- (pending or approved) so they can track them; owner/admin sees all (to approve).
DROP POLICY IF EXISTS odai_upload_read ON odai_upload;
CREATE POLICY odai_upload_read ON odai_upload FOR SELECT TO authenticated
  USING ( approved OR uploaded_by = auth.uid() OR odai_can_write(tenant_id) );

-- File bytes: replace the membership-only read with an APPROVAL-gated read (blocks until approved).
DROP POLICY IF EXISTS odai_storage_upload_read ON storage.objects;
CREATE POLICY odai_storage_upload_read ON storage.objects FOR SELECT TO authenticated
  USING ( bucket_id = 'odai-uploads' AND odai_upload_is_approved(name) );
