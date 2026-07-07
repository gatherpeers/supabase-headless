-- Ephemeral objects for supabase-js SDK coverage. Dropped entirely after the run.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.sdk_test_items (
  id serial PRIMARY KEY,
  title text NOT NULL,
  published boolean DEFAULT false,
  views int DEFAULT 0,
  tags text[] DEFAULT '{}',
  search tsvector,
  meta jsonb DEFAULT '{}'::jsonb,
  parent_id int REFERENCES public.sdk_test_items(id)
);

CREATE TABLE IF NOT EXISTS public.sdk_test_labels (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS public.sdk_test_item_labels (
  item_id int NOT NULL REFERENCES public.sdk_test_items(id) ON DELETE CASCADE,
  label_id int NOT NULL REFERENCES public.sdk_test_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, label_id)
);

CREATE TABLE IF NOT EXISTS public.sdk_test_secrets (
  id serial PRIMARY KEY,
  owner uuid DEFAULT auth.uid(),
  content text
);

ALTER TABLE public.sdk_test_secrets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdk_test_secrets_owner ON public.sdk_test_secrets;
CREATE POLICY sdk_test_secrets_owner ON public.sdk_test_secrets
  FOR ALL TO authenticated
  USING (owner = auth.uid())
  WITH CHECK (owner = auth.uid());

CREATE OR REPLACE FUNCTION public.sdk_test_add(a int, b int) RETURNS int
  LANGUAGE sql AS $$ SELECT a + b $$;

CREATE OR REPLACE FUNCTION public.sdk_test_void() RETURNS void
  LANGUAGE sql AS $$ SELECT 1 $$;

CREATE OR REPLACE FUNCTION public.sdk_test_published_items()
  RETURNS SETOF public.sdk_test_items
  LANGUAGE sql AS $$ SELECT * FROM public.sdk_test_items WHERE published = true $$;

CREATE OR REPLACE FUNCTION public.sdk_test_seed() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  TRUNCATE public.sdk_test_item_labels, public.sdk_test_labels, public.sdk_test_items, public.sdk_test_secrets RESTART IDENTITY CASCADE;
  INSERT INTO public.sdk_test_items (title, published, views, tags, search, meta, parent_id) VALUES
    ('Engines', true, 100, '{math}', to_tsvector('english', 'analytical engines'), '{"country":"UK"}', null),
    ('Git', true, 250, '{git,unix}', to_tsvector('english', 'git plumbing'), '{"country":"FI"}', 1),
    ('Kernel', false, 50, '{unix}', to_tsvector('english', 'kernel monolith'), '{"country":"FI"}', 2);
  INSERT INTO public.sdk_test_labels (name) VALUES ('unix'), ('math');
  INSERT INTO public.sdk_test_item_labels (item_id, label_id) VALUES
    (2, 1), (3, 1),  -- unix -> Git, Kernel
    (1, 2), (2, 2);  -- math -> Engines, Git
END;
$$;

GRANT SELECT ON public.sdk_test_items, public.sdk_test_labels, public.sdk_test_item_labels TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sdk_test_items TO authenticated;
GRANT ALL ON public.sdk_test_items, public.sdk_test_secrets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sdk_test_secrets TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.sdk_test_add(int,int), public.sdk_test_void(), public.sdk_test_published_items(), public.sdk_test_seed()
  TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sdk_test_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sdk_test_items;
  END IF;
END $$;

SELECT public.sdk_test_seed();
NOTIFY pgrst, 'reload schema';

DROP POLICY IF EXISTS sdk_compat_auth_objects ON storage.objects;
CREATE POLICY sdk_compat_auth_objects ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id LIKE 'sdk-test-%')
  WITH CHECK (bucket_id LIKE 'sdk-test-%');

DROP POLICY IF EXISTS sdk_compat_public_read ON storage.objects;
CREATE POLICY sdk_compat_public_read ON storage.objects
  FOR SELECT TO anon
  USING (
    bucket_id LIKE 'sdk-test-pub-%'
    AND EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = storage.objects.bucket_id AND b.public = true)
  );
