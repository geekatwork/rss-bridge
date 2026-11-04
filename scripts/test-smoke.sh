#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="rss-bridge-smoke-$(date +%s)-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f tests/smoke/docker-compose.yml)
scraper_service=scraper
group_id=smoke-test-group
case "${1:-}" in
  "") ;;
  --broken-config) scraper_service=scraper-broken; group_id=broken-test-group ;;
  *) echo "Usage: $0 [--broken-config]" >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then echo "Too many arguments" >&2; exit 1; fi

cleanup() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    "${compose[@]}" logs --no-color --tail=80 >&2
  fi
  "${compose[@]}" down --volumes --remove-orphans --rmi local || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[test-smoke] Building and starting isolated project $project..."
node tests/smoke/assert-compose.mjs
"${compose[@]}" up -d --build --wait --wait-timeout 120 db fixture feed-generator
"${compose[@]}" up -d --build scraper scraper-broken

echo "[test-smoke] Requiring a completed, healthy scraper run..."
"${compose[@]}" exec -T "$scraper_service" node /smoke/assert-scraper.mjs success "$group_id"

echo "[test-smoke] Checking source-derived database records (no manual seeding)..."
"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U smoke -d smoke <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM posts) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one scraped post';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM posts p JOIN groups g ON g.id = p.group_id
    WHERE g.source_id = 'smoke-test-group'
      AND p.source_post_id = 'example_item-0'
      AND p.author_name = 'Smoke Tester'
      AND p.content_text = 'Content extracted from the local smoke fixture.'
      AND p.content_html = '<p>Content extracted from the local smoke fixture.</p>'
      AND p.link = 'http://fixture:8080/posts/smoke-test-post'
      AND p.posted_at = '2026-01-01T12:00:00Z'::timestamptz
      AND p.posted_at_is_source
  ) THEN
    RAISE EXCEPTION 'Scraped fixture content was not persisted correctly';
  END IF;
END $$;
SQL

echo "[test-smoke] Checking database readiness, discovery and rendered RSS..."
"${compose[@]}" exec -T feed-generator node /smoke/assert-feed.mjs

echo "[test-smoke] Checking eligible feed-window pagination with separate test-only rows..."
"${compose[@]}" exec -T feed-generator node /smoke/assert-feed-window.mjs

echo "[test-smoke] Checking broken scraper health and success-check rejection..."
"${compose[@]}" exec -T scraper-broken node /smoke/assert-scraper.mjs failure
if "${compose[@]}" exec -T scraper-broken node /smoke/assert-scraper.mjs success broken-test-group; then
  echo "[test-smoke] ERROR: broken scraper passed the success check" >&2
  exit 1
fi

echo "[test-smoke] Smoke tests passed"
