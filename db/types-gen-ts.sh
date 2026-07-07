set -Eeuo pipefail

# Usage:
#   ./db/types-gen-ts.sh [included_schemas] [output_file]
# Examples:
#   ./db/types-gen-ts.sh
#   ./db/types-gen-ts.sh public database.types.ts
#   ./db/types-gen-ts.sh public,storage,auth database.types.ts

SCHEMAS="${1:-public,storage,auth}"
OUT_FILE="${2:-database.types.ts}"
POSTGREST_VERSION="${POSTGREST_VERSION:-14.14}"
PROFILE="${COMPOSE_PROFILE:-dashboard}"
SERVICE="${PG_META_SERVICE:-postgres-meta}"

cleanup() {
  docker compose stop "$SERVICE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting $SERVICE with profile '$PROFILE'..."
docker compose --profile "$PROFILE" up -d --force-recreate "$SERVICE" >/dev/null

echo "Waiting for postgres-meta to be ready..."
for i in $(seq 1 30); do
  if docker compose exec -T "$SERVICE" node -e "fetch('http://127.0.0.1:8080/config/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "postgres-meta did not become ready in time" >&2
    exit 1
  fi
done

GEN_URL="http://127.0.0.1:8080/generators/typescript?included_schemas=${SCHEMAS}&detect_one_to_one_relationships=true&postgrest_version=${POSTGREST_VERSION}"

echo "Generating types for schemas: $SCHEMAS"
docker compose exec -T -e GEN_URL="$GEN_URL" "$SERVICE" node -e "fetch(process.env.GEN_URL).then(async r=>{const t=await r.text(); if(!r.ok){console.error(t); process.exit(1)} process.stdout.write(t)}).catch(e=>{console.error(e); process.exit(1)})" > "$OUT_FILE"

echo "Types written to $OUT_FILE"