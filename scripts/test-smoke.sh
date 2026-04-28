#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${BASE_URL:-http://localhost:${FEED_PORT:-3100}}"
GROUP_SOURCE_ID="smoke-test-group"
POST_SOURCE_ID="smoke-test-post"

wait_for_health() {
  local url="$1"
  for attempt in {1..30}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "[test-smoke] Starting docker services..."
docker compose up -d db feed-generator scraper >/dev/null

echo "[test-smoke] Waiting for feed-generator health endpoint..."
if ! wait_for_health "$BASE_URL/health"; then
  echo "[test-smoke] feed-generator did not become healthy in time"
  exit 1
fi

echo "[test-smoke] Seeding deterministic smoke-test records..."
docker compose exec -T db sh -lc 'set -e; PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
DELETE FROM posts
WHERE source_post_id = 'smoke-test-post';

DELETE FROM groups
WHERE (source_id = 'smoke-test-group' OR char_length(source_id) = 0)
  AND name = 'Smoke Test Group';

INSERT INTO groups (source_id, name, url)
VALUES ('smoke-test-group', 'Smoke Test Group', 'https://example.com/groups/smoke-test-group')
ON CONFLICT (source_id) DO UPDATE
SET name = EXCLUDED.name,
    url = EXCLUDED.url;

INSERT INTO posts (group_id, source_post_id, author_name, content_text, content_html, link, image_urls, posted_at)
SELECT g.id,
  'smoke-test-post',
  'Smoke Tester',
  'Smoke test post content',
  '<p>Smoke test post content</p>',
  'https://example.com/posts/smoke-test-post',
  '[]'::jsonb,
       NOW()
FROM groups g
WHERE g.source_id = 'smoke-test-group'
ON CONFLICT (source_post_id) DO UPDATE
SET group_id = EXCLUDED.group_id,
    author_name = EXCLUDED.author_name,
    content_text = EXCLUDED.content_text,
    content_html = EXCLUDED.content_html,
    link = EXCLUDED.link,
    image_urls = EXCLUDED.image_urls,
    scraped_at = NOW();
SQL

echo "[test-smoke] Checking /health response..."
health_json="$(curl -fsS "$BASE_URL/health")"
if [[ "$health_json" != *'"status":"ok"'* ]]; then
  echo "[test-smoke] Unexpected /health response: $health_json"
  exit 1
fi

echo "[test-smoke] Checking /feeds response..."
feeds_json="$(curl -fsS "$BASE_URL/feeds")"
if [[ "$feeds_json" != *"\"groupId\":\"$GROUP_SOURCE_ID\""* ]]; then
  echo "[test-smoke] Expected smoke group not found in /feeds response"
  echo "$feeds_json"
  exit 1
fi

echo "[test-smoke] Checking /feed/$GROUP_SOURCE_ID response..."
rss_xml="$(curl -fsS "$BASE_URL/feed/$GROUP_SOURCE_ID")"
if [[ "$rss_xml" != *"<rss"* ]]; then
  echo "[test-smoke] Expected RSS XML payload"
  exit 1
fi
if [[ "$rss_xml" != *"$POST_SOURCE_ID"* ]]; then
  echo "[test-smoke] Expected seeded post ID not present in feed output"
  exit 1
fi

echo "[test-smoke] Smoke tests passed"
