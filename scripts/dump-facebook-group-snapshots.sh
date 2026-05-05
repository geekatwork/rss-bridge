#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="${1:-$repo_root/packages/scraper/src/sites/facebook/__fixtures__/snapshots}"
limit="${2:-50}"

mkdir -p "$out_dir"

cd "$repo_root"

dump_group() {
  local group_source_id="$1"
  local file_path="$out_dir/facebook-group-${group_source_id}.json"

  docker compose exec -T db psql -U rss_bridge -d rss_bridge -At -c "
WITH ranked AS (
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
    p.scraped_at,
    ROW_NUMBER() OVER (PARTITION BY g.source_id ORDER BY p.posted_at DESC, p.id DESC) AS row_num
  FROM posts p
  JOIN groups g ON g.id = p.group_id
  WHERE g.source_id = '${group_source_id}'
)
SELECT COALESCE(
  json_agg(
    json_build_object(
      'rowNum', row_num,
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
      'notes', NULL
    )
    ORDER BY row_num
  ),
  '[]'::json
)::text
FROM ranked
WHERE row_num <= ${limit};
" > "$file_path"

  echo "Wrote snapshot for ${group_source_id} to ${file_path}"
}

dump_group "669567236527981"
dump_group "1818585508476102"