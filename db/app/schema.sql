CREATE SCHEMA IF NOT EXISTS app_meta;
REVOKE ALL ON SCHEMA app_meta FROM public;
GRANT USAGE ON SCHEMA app_meta TO postgres;

CREATE TABLE IF NOT EXISTS app_meta.migration_history (
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user,

  CONSTRAINT pk_app_migration_history_name PRIMARY KEY (name)
);

REVOKE ALL ON app_meta.migration_history FROM public, anon, authenticated, service_role;