#!/bin/sh
set -eu

apply_migrations() {
  meta_schema="$1"
  schema_file="$2"
  migrations_dir="$3"
  name_prefix="$4"

  echo "==> Ensuring ${meta_schema} schema..."
  psql -v ON_ERROR_STOP=1 -f "$schema_file"

  if [ ! -d "$migrations_dir" ]; then
    echo "==> No migrations directory: ${migrations_dir}"
    return 0
  fi

  # POSIX glob expansion is sorted; no ls parsing needed.
  for file in "$migrations_dir"/*.sql; do
    [ -f "$file" ] || continue
    base=$(basename "$file")

    case "$base" in
      -*) echo "Skipping draft ${base}"; continue ;;
    esac

    name="${name_prefix}/${base}"
    checksum=$(sha256sum "$file" | awk '{print $1}')
    existing=$(psql -tAc "SELECT checksum FROM ${meta_schema}.migration_history WHERE name = '${name}'" | tr -d '[:space:]')

    if [ -z "$existing" ]; then
      echo "Applying ${name}..."
      # Single transaction: the migration and its history row commit (or roll back) together.
      psql -v ON_ERROR_STOP=1 --single-transaction \
        -f "$file" \
        -c "INSERT INTO ${meta_schema}.migration_history (name, checksum) VALUES ('${name}', '${checksum}');"
    elif [ "$existing" != "$checksum" ]; then
      echo "Checksum mismatch for ${name} (stored=${existing} current=${checksum})" >&2
      exit 1
    else
      echo "Skipping ${name} (already applied)"
    fi
  done
}

apply_migrations stack_meta /stack/schema.sql /stack/migrations stack
apply_migrations app_meta /app/schema.sql /app/migrations app

echo "==> Reloading PostgREST schema cache..."
psql -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';"