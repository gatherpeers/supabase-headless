-- DB Entrypoint fresh volume only (platform bootstrap).

\set ON_ERROR_STOP on

\getenv postgres_db POSTGRES_DB
\getenv auth_db_password AUTH_DB_PASSWORD
\getenv realtime_db_password REALTIME_DB_PASSWORD
\getenv storage_db_password STORAGE_DB_PASSWORD
\getenv pgrst_auth_user PGRST_AUTH_USER
\getenv pgrst_auth_password PGRST_AUTH_PASSWORD

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS _realtime;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE SCHEMA IF NOT EXISTS storage;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Query performance insights
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Auth
CREATE ROLE supabase_auth_admin LOGIN PASSWORD :'auth_db_password';
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path to auth, public, extensions;

-- Realtime runtime role (least-privilege; mirrors the official supabase/postgres init script).
-- Since v2.109.0 Realtime runs its migrations as the superuser DB_USER, but the *runtime* connection uses this role and still needs:
--   * LOGIN + REPLICATION  -> open replication connections (Postgres-changes CDC + broadcast-from-db)
--   * CREATE ON DATABASE   -> create the "realtime_messages_publication" used by broadcast-from-db membership in anon/authenticated/service_role -> SET ROLE to evaluate RLS as the API roles SET on log_min_messages -> realtime.list_changes()
-- Ownership of realtime.messages is transferred to this role by Realtime's base migrations, but realtime.subscription (and future realtime tables) are only handed over by the flag-gated setup migration. Since that flag is impractical on self-host, we instead let this role access whatever the superuser migrations create in the realtime schema (see ALTER DEFAULT PRIVILEGES below).
CREATE ROLE supabase_realtime_admin NOINHERIT LOGIN REPLICATION PASSWORD :'realtime_db_password';
ALTER SCHEMA _realtime OWNER TO supabase_realtime_admin;
ALTER ROLE supabase_realtime_admin SET search_path TO public, extensions, realtime;
GRANT CREATE ON DATABASE :"postgres_db" TO supabase_realtime_admin;
GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin;
GRANT anon, authenticated, service_role TO supabase_realtime_admin;
GRANT CREATE, USAGE ON SCHEMA public TO supabase_realtime_admin;
GRANT USAGE ON SCHEMA extensions TO supabase_realtime_admin;
GRANT USAGE ON SCHEMA auth TO supabase_realtime_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO supabase_realtime_admin;
GRANT CREATE, USAGE ON SCHEMA _realtime TO supabase_realtime_admin;
GRANT USAGE ON SCHEMA realtime TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA realtime TO supabase_realtime_admin WITH GRANT OPTION;
-- Realtime's superuser migrations create realtime.subscription (and any future realtime tables)
-- owned by postgres; auto-grant this role access so Postgres-changes CDC can read/write them.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA realtime GRANT ALL ON TABLES TO supabase_realtime_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA realtime GRANT ALL ON SEQUENCES TO supabase_realtime_admin;

-- Storage
CREATE ROLE supabase_storage_admin LOGIN PASSWORD :'storage_db_password';
ALTER SCHEMA storage OWNER TO supabase_storage_admin;
ALTER ROLE supabase_storage_admin SET search_path to storage, public, extensions;

GRANT CREATE ON DATABASE :"postgres_db" TO supabase_storage_admin;
GRANT anon, authenticated, service_role TO supabase_storage_admin;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

-- Default privileges for API-exposed schemas (see db/README.md). Row access is enforced in app RLS policies.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_storage_admin IN SCHEMA storage GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_storage_admin IN SCHEMA storage GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_storage_admin IN SCHEMA storage GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_storage_admin IN SCHEMA storage GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_storage_admin IN SCHEMA storage GRANT ALL ON SEQUENCES TO service_role;

CREATE ROLE :"pgrst_auth_user" WITH LOGIN PASSWORD :'pgrst_auth_password' NOINHERIT;
GRANT anon, authenticated, service_role TO :"pgrst_auth_user";

ALTER DATABASE :"postgres_db" SET search_path TO public, extensions;

CREATE PUBLICATION supabase_realtime;