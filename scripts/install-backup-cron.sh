#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/backup-postgres.sh"
LOG="$ROOT/backups/backup.log"
mkdir -p "$ROOT/backups"
chmod +x "$SCRIPT"
LINE="15 3 * * * cd '$ROOT' && '$SCRIPT' >> '$LOG' 2>&1"
( crontab -l 2>/dev/null | grep -Fv "$SCRIPT" || true; echo "$LINE" ) | crontab -
echo "Ежедневная резервная копия установлена на 03:15."
echo "Проверка: crontab -l"
