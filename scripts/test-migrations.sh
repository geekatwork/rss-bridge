#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="rss-bridge-migrations-$(date +%s)-$$"
file=tests/migrations/docker-compose.yml
compose=(docker compose --env-file /dev/null -f "$file" -p "$project")
temporary=$(mktemp -d)
cleanup() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --no-color --tail=80 >&2; fi
  "${compose[@]}" down --volumes --remove-orphans || result=1
  rm -f "$temporary"/{refused,upgrade,repeat,invalid,fresh,occupied,unavailable,clean}.dump
  rmdir "$temporary"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sql() {
  "${compose[@]}" exec -T db psql -X -v ON_ERROR_STOP=1 -U migration_test -d migration_test "$@"
}
migrate() {
  bash scripts/migrate-database.sh --compose-file "$file" --project-name "$project" "$@"
}
expect_failure() {
  if "$@"; then echo "Expected command to fail: $*" >&2; exit 1; fi
}
"${compose[@]}" up -d --wait --wait-timeout 60
container=$("${compose[@]}" ps -q db)
started=$(docker inspect -f '{{.State.StartedAt}}' "$container")

echo "[test:migrations] Fresh schema and occupied backup protection"
migrate --backup "$temporary/fresh.dump"
test "$(stat -c '%a' "$temporary/fresh.dump")" = 600
cp "$temporary/fresh.dump" "$temporary/occupied.dump"
expect_failure migrate --backup "$temporary/occupied.dump"
cmp "$temporary/fresh.dump" "$temporary/occupied.dump"

echo "[test:migrations] Simulating a populated pre-index/pre-provenance volume"
sql <<'SQL'
DROP TABLE schema_migrations;
DROP INDEX uq_posts_link_non_null;
ALTER TABLE posts DROP COLUMN posted_at_is_source;
INSERT INTO groups (source_id, name, url) VALUES
  ('legacy', 'Legacy', 'https://example.test'),
  ('other', 'Other group', 'https://example.test/other');
INSERT INTO posts (group_id, source_post_id, content_text, link, posted_at) VALUES
  (1, 'first', 'keep original', 'https://example.test/post', '2020-01-01'),
  (2, 'duplicate', 'do not merge', 'https://example.test/post', '2021-01-01'),
  (1, 'null-one', 'keep null', NULL, '2022-01-01'),
  (1, 'null-two', 'keep null too', NULL, '2023-01-01');
SQL
expect_failure migrate --backup "$temporary/refused.dump"
sql <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 4
     OR to_regclass('schema_migrations') IS NOT NULL
     OR to_regclass('uq_posts_link_non_null') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusal changed the legacy database';
  END IF;
END $$;
SQL
migrate --backup "$temporary/upgrade.dump" --deduplicate
history=$(sql -Atc 'SELECT version, applied_at FROM schema_migrations ORDER BY version')
migrate --backup "$temporary/repeat.dump"
test "$history" = "$(sql -Atc 'SELECT version, applied_at FROM schema_migrations ORDER BY version')"
sql <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 3
     OR (SELECT count(*) FROM schema_migrations) <> 2
     OR (SELECT count(*) FROM posts WHERE link IS NULL) <> 2
     OR NOT EXISTS (SELECT 1 FROM posts WHERE id = 1 AND group_id = 1 AND source_post_id = 'first'
       AND content_text = 'keep original' AND posted_at = '2020-01-01'::timestamptz)
     OR EXISTS (SELECT 1 FROM posts WHERE posted_at_is_source) THEN
    RAISE EXCEPTION 'Upgrade/rerun did not preserve the intended data';
  END IF;
  BEGIN
    INSERT INTO posts (group_id, source_post_id, link, posted_at)
    VALUES (1, 'blocked', 'https://example.test/post', NOW());
    RAISE EXCEPTION 'Unique link index did not reject a duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO posts (group_id, source_post_id, link, posted_at)
    VALUES (1, 'first', 'https://example.test/other', NOW());
    RAISE EXCEPTION 'Source-post identity constraint did not reject a duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
SQL

echo "[test:migrations] Backup restores original duplicate rows"
"${compose[@]}" exec -T db createdb -U migration_test restore_test
"${compose[@]}" exec -T db pg_restore -e -U migration_test -d restore_test < "$temporary/upgrade.dump"
sql -d restore_test <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 4 OR to_regclass('uq_posts_link_non_null') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-migration backup did not restore original data';
  END IF;
END $$;
SQL

echo "[test:migrations] Invalid existing index rolls back all migration changes"
sql <<'SQL'
DROP TABLE schema_migrations;
DROP INDEX uq_posts_link_non_null;
CREATE INDEX uq_posts_link_non_null ON posts (link);
ALTER TABLE posts DROP COLUMN posted_at_is_source;
INSERT INTO posts (group_id, source_post_id, link, posted_at)
VALUES (1, 'rollback-duplicate', 'https://example.test/post', NOW());
SQL
expect_failure migrate --backup "$temporary/invalid.dump" --deduplicate
sql <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 4
     OR to_regclass('schema_migrations') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_name = 'posts' AND column_name = 'posted_at_is_source') THEN
    RAISE EXCEPTION 'Failed migration did not roll back';
  END IF;
END $$;
SQL

echo "[test:migrations] Backup failure does not apply schema changes"
expect_failure bash scripts/migrate-database.sh --compose-file "$file" \
  --project-name "$project-absent" --backup "$temporary/unavailable.dump"
sql <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 4 OR to_regclass('schema_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'Backup failure changed database state';
  END IF;
END $$;
SQL

echo "[test:migrations] Non-destructive legacy upgrade needs no deduplication opt-in"
sql <<'SQL'
DELETE FROM posts WHERE source_post_id = 'rollback-duplicate';
DROP INDEX uq_posts_link_non_null;
SQL
migrate --backup "$temporary/clean.dump"
sql <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 3 OR (SELECT count(*) FROM schema_migrations) <> 2 THEN
    RAISE EXCEPTION 'Non-destructive legacy upgrade changed post count or missed history';
  END IF;
END $$;
SQL
test "$container" = "$("${compose[@]}" ps -q db)"
test "$started" = "$(docker inspect -f '{{.State.StartedAt}}' "$container")"
echo "[test:migrations] Passed; database container was not recreated or restarted"
