\set ON_ERROR_STOP on

DROP TABLE IF EXISTS public.sdk_test_item_labels CASCADE;
DROP TABLE IF EXISTS public.sdk_test_labels CASCADE;
DROP TABLE IF EXISTS public.sdk_test_items CASCADE;
DROP TABLE IF EXISTS public.sdk_test_secrets CASCADE;
DROP FUNCTION IF EXISTS public.sdk_test_add(int, int);
DROP FUNCTION IF EXISTS public.sdk_test_void();
DROP FUNCTION IF EXISTS public.sdk_test_published_items();
DROP FUNCTION IF EXISTS public.sdk_test_seed();

DROP POLICY IF EXISTS sdk_compat_auth_objects ON storage.objects;
DROP POLICY IF EXISTS sdk_compat_public_read ON storage.objects;

NOTIFY pgrst, 'reload schema';
