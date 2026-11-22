-- 20261122000005_odai_upload.sql — uploads: DB metadata (odai_upload) + private Supabase Storage bucket.
-- File bytes live in Storage; this table is the queryable metadata. Object path convention: <tenant_id>/<upload_id>/<filename>.
CREATE TABLE IF NOT EXISTS odai_upload (
  tenant_id text NOT NULL,
  upload_id uuid NOT NULL DEFAULT gen_random_uuid(),
  storage_bucket text NOT NULL DEFAULT 'odai-uploads',
  storage_path text NOT NULL,
  name text,
  mime text,
  kind text,
  size bigint,
  analyzable boolean DEFAULT false,
  text_preview text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, upload_id)
);

ALTER TABLE odai_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE odai_upload FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS odai_upload_read ON odai_upload;
CREATE POLICY odai_upload_read ON odai_upload FOR SELECT TO authenticated USING (odai_is_member(tenant_id));
DROP POLICY IF EXISTS odai_upload_insert ON odai_upload;
CREATE POLICY odai_upload_insert ON odai_upload FOR INSERT TO authenticated WITH CHECK (odai_is_member(tenant_id));
DROP POLICY IF EXISTS odai_upload_delete ON odai_upload;
CREATE POLICY odai_upload_delete ON odai_upload FOR DELETE TO authenticated USING (odai_can_write(tenant_id));

-- Private bucket (public = false).
INSERT INTO storage.buckets (id, name, public)
VALUES ('odai-uploads', 'odai-uploads', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Storage object access is scoped to the tenant prefix of the object path.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS odai_storage_upload_read ON storage.objects;
CREATE POLICY odai_storage_upload_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'odai-uploads' AND odai_is_member(split_part(name, '/', 1)));
DROP POLICY IF EXISTS odai_storage_upload_insert ON storage.objects;
CREATE POLICY odai_storage_upload_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'odai-uploads' AND odai_is_member(split_part(name, '/', 1)));
DROP POLICY IF EXISTS odai_storage_upload_delete ON storage.objects;
CREATE POLICY odai_storage_upload_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'odai-uploads' AND odai_can_write(split_part(name, '/', 1)));
