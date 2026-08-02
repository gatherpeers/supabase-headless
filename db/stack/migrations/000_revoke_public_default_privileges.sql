-- Data API exposure in `public` becomes opt-in, matching the Supabase platform default: https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically

-- Only future objects created by `postgres` are affected; objects that already exist keep the privileges they hold. App migrations grant per object instead. The `auth`, `storage`, and `realtime` schemas are out of scope, as they are in the upstream change.

-- Functions are deliberately not listed here. Postgres grants EXECUTE on new functions to PUBLIC globally, and per-schema default privileges can only add to the global set, so the equivalent REVOKE ... IN SCHEMA public is a documented no-op. Revoke per function, or keep RPC out of `public`. See https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;