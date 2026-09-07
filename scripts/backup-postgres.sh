#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

read_env() {
  local key="$1"
  local fallback="${2:-}"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

BACKUP_DIR="${BACKUP_DIR:-$(read_env BACKUP_DIR "$ROOT/backups")}"
if [[ "$BACKUP_DIR" != /* ]]; then BACKUP_DIR="$ROOT/${BACKUP_DIR#./}"; fi
RETENTION="${BACKUP_RETENTION_DAYS:-$(read_env BACKUP_RETENTION_DAYS 14)}"
mkdir -p "$BACKUP_DIR"
TARGET="$BACKUP_DIR/mafia-$(date +%Y-%m-%d_%H-%M-%S).sql.gz"

if command -v docker >/dev/null 2>&1 && docker inspect mafia-noir-postgres >/dev/null 2>&1; then
  POSTGRES_USER="$(read_env POSTGRES_USER mafia)"
  POSTGRES_DB="$(read_env POSTGRES_DB mafia)"
  docker exec mafia-noir-postgres pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip -9 > "$TARGET"
else
  DATABASE_URL="$(read_env DATABASE_URL)"
  if [[ -z "$DATABASE_URL" ]]; then
    echo "DATABASE_URL не найден в $ENV_FILE" >&2
    exit 1
  fi
  command -v pg_dump >/dev/null 2>&1 || { echo "Установите postgresql-client" >&2; exit 1; }
  pg_dump --clean --if-exists "$DATABASE_URL" | gzip -9 > "$TARGET"
fi

find "$BACKUP_DIR" -type f -name 'mafia-*.sql.gz' -mtime "+$RETENTION" -delete
chmod 600 "$TARGET"
echo "Backup created: $TARGET"
