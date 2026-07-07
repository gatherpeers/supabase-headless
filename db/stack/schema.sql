CREATE SCHEMA IF NOT EXISTS stack_meta;
REVOKE ALL ON SCHEMA stack_meta FROM public;
GRANT USAGE ON SCHEMA stack_meta TO postgres;

CREATE TABLE IF NOT EXISTS stack_meta.migration_history (
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user,

  CONSTRAINT pk_stack_migration_history_name PRIMARY KEY (name)
);

REVOKE ALL ON stack_meta.migration_history FROM public, anon, authenticated, service_role;