#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_file="${1:-$repo_root/packages/scraper/src/sites/facebook/__fixtures__/facebook-unresolved.json}"
limit="${2:-50}"

mkdir -p "$(dirname "$out_file")"

cd "$repo_root"

tmp_file="$(mktemp)"
docker compose exec -T db psql -U rss_bridge -d rss_bridge -At -c "
WITH unresolved AS (
  SELECT
    p.source_post_id,
    g.source_id AS group_source_id,
    g.name AS group_name,
    p.author_name,
    p.content_text,
    p.content_html,
    p.link,
    p.image_urls,
    p.posted_at,
    p.scraped_at
  FROM posts p
  JOIN groups g ON g.id = p.group_id
  WHERE p.link IS NULL
    AND g.source_id ~ '^[0-9]+$'
  ORDER BY p.scraped_at DESC, p.posted_at DESC, p.id DESC
  LIMIT ${limit}
)
SELECT COALESCE(
  json_agg(
    json_build_object(
      'sourcePostId', source_post_id,
      'groupSourceId', group_source_id,
      'groupName', group_name,
      'authorName', author_name,
      'contentText', content_text,
      'contentHtml', content_html,
      'link', link,
      'imageUrls', image_urls,
      'postedAt', posted_at,
      'scrapedAt', scraped_at,
      'candidateUrls', '[]'::json,
      'expectedLink', NULL,
      'notes', NULL
    )
  ),
  '[]'::json
)::text
FROM unresolved;
" > "$tmp_file"

# Merge new DB data with existing annotations (expectedLink, notes) from the current fixture file
if [[ -f "$out_file" ]]; then
  node - <<'EOF' "$tmp_file" "$out_file"
const fs = require("fs");
const [newFile, existingFile] = process.argv.slice(2);
const newItems = JSON.parse(fs.readFileSync(newFile, "utf8"));
const existingItems = JSON.parse(fs.readFileSync(existingFile, "utf8"));
const existingMap = new Map(existingItems.map((e) => [e.sourcePostId, e]));
const merged = newItems.map((item) => {
  const existing = existingMap.get(item.sourcePostId);
  if (existing) {
    item.expectedLink = existing.expectedLink ?? null;
    item.notes = existing.notes ?? null;
    item.candidateUrls = existing.candidateUrls ?? [];
  }
  return item;
});
fs.writeFileSync(newFile, JSON.stringify(merged, null, 2) + "\n");
EOF
fi
mv "$tmp_file" "$out_file"

echo "Wrote unresolved Facebook fixtures to $out_file"
