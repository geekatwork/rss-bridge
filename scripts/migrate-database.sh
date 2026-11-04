#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$PWD
backup=""
deduplicate=false
compose_file=""
project=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup|--compose-file|--project-name)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then echo "Missing value for $1" >&2; exit 1; fi
      case "$1" in
        --backup) backup=$2 ;;
        --compose-file) compose_file=$2 ;;
        --project-name) project=$2 ;;
      esac
      shift 2 ;;
    --deduplicate) deduplicate=true; shift ;;
    *) echo "Usage: $0 --backup /absolute/path.dump [--deduplicate] [--compose-file FILE --project-name NAME]" >&2; exit 1 ;;
  esac
done
if [[ "$backup" != /* ]] || [ ! -d "$(dirname "$backup")" ]; then
  echo "An absolute --backup path with an existing parent directory is required" >&2
  exit 1
fi
backup="$(cd "$(dirname "$backup")" && pwd -P)/$(basename "$backup")"
case "$backup" in
  "$root"/*) echo "Store database backups outside the repository" >&2; exit 1 ;;
esac
compose=(docker compose)
if [ -n "$compose_file" ] || [ -n "$project" ]; then
  if [ -z "$compose_file" ] || [ -z "$project" ]; then
    echo "--compose-file and --project-name must be supplied together" >&2
    exit 1
  fi
  compose+=(--env-file /dev/null -f "$compose_file" -p "$project")
fi

umask 077
echo "[db:migrate] Backing up before any schema/data changes: $backup"
if ! (set -o noclobber; "${compose[@]}" exec -T db sh -c \
  'exec pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$backup"); then
  echo "Backup failed (or path already exists); no migration attempted. Any partial new dump is unusable." >&2
  exit 1
fi
"${compose[@]}" exec -T db pg_restore --list < "$backup" > /dev/null
echo "[db:migrate] Backup archive verified. Applying migrations (deduplicate=$deduplicate)..."
"${compose[@]}" exec -T db sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -v deduplicate="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  sh "$deduplicate" < scripts/migrate-database.sql
echo "[db:migrate] Verified schema and migration history. Backup retained at $backup"
