-- Functions become fail-closed for role `postgres`, matching the table/sequence opt-in in `000`.
-- Postgres grants EXECUTE on new functions to PUBLIC by default. That grant is global, so a
-- per-schema REVOKE (IN SCHEMA public) is a documented no-op; only the global form works.
-- See https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html

-- Only future functions created by `postgres` are affected. Existing functions keep their ACLs.
-- Functions owned by service roles (`supabase_auth_admin`, `supabase_storage_admin`,
-- `supabase_realtime_admin`) are out of scope. App migrations GRANT EXECUTE per function for
-- any RPC that should be reachable via the Data API.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;