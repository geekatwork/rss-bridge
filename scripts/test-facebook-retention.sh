#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run -w packages/scraper build
project="rss-bridge-retention-$(date +%s)-$$"
database="$project-db"
checker="$project-check"
network_created=false
cleanup() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then docker logs --tail=80 "$database" >&2; fi
  for container in "$checker" "$database"; do
    if docker container inspect "$container" > /dev/null 2>&1; then
      docker rm -f "$container" > /dev/null || result=1
    fi
  done
  if [ "$network_created" = true ]; then docker network rm "$project" > /dev/null || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker network create --internal "$project" > /dev/null
network_created=true
docker run -d --name "$database" --network "$project" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=retention -e POSTGRES_USER=retention -e POSTGRES_PASSWORD=retention-test-only \
  -v "$PWD/db:/docker-entrypoint-initdb.d:ro" \
  --health-cmd 'pg_isready -U retention -d retention' \
  --health-interval 1s --health-timeout 2s --health-retries 30 postgres:16-alpine > /dev/null
deadline=$((SECONDS + 60))
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$database")" = healthy ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then echo "Timed out waiting for isolated database" >&2; exit 1; fi
  sleep 1
done
docker run --rm -i --name "$checker" --network "$project" --read-only \
  -v "$PWD:/workspace:ro" -w /workspace \
  -e DATABASE_URL="postgres://retention:retention-test-only@$database:5432/retention" \
  node:26-alpine node --input-type=module <<'JS'
import assert from "node:assert/strict";
const { query, closeDb } = await import("./packages/scraper/dist/database.js");
const { pruneFacebookPosts } = await import("./packages/scraper/dist/db.js");
const { isFacebookGroupUrl } = await import("./packages/scraper/dist/facebookGroups.js");
const originalNow = Date.now;
Date.now = () => Date.parse("2026-02-08T12:00:00Z");
const supported = [];
for (const host of ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com"]) {
  for (const protocol of ["https", "http"]) {
    const url = `${protocol}://${host}/groups/group-name/?ref=test#posts`;
    supported.push(url, url.toUpperCase());
  }
}
const unsupported = [
  "https://example.test/groups/123",
  "https://facebook.com.evil.test/groups/123",
  "https://www.facebook.com.evil.test/groups/123",
  "https://notfacebook.com/groups/123",
  "https://other.facebook.com/groups/123",
  "https://facebook.com@evil.test/groups/123",
  "https://evil.test/facebook.com/groups/123",
  "https://facebook.com/pages/123",
  "https://facebook.com/groups/",
  "https://facebook.com/groups/?id=123",
  "https://facebook.com/groups/#123",
  "https://facebook.com/groups/ ",
  "ftp://facebook.com/groups/123",
  "not a URL",
];
try {
  const expected = [];
  for (const [index, url] of [...supported, ...unsupported].entries()) {
    const eligible = index < supported.length;
    assert.equal(isFacebookGroupUrl(url), eligible);
    const group = await query(
      "INSERT INTO groups (source_id, name, url) VALUES ($1, $1, $2) RETURNING id",
      [`group-${index}`, url]
    );
    for (const [age, postedAt] of [
      ["old", "2026-02-01T11:59:59.999Z"],
      ["boundary", "2026-02-01T12:00:00Z"],
      ["recent", "2026-02-08T12:00:00Z"],
    ]) {
      const sourceId = `post-${index}-${age}`;
      await query(
        "INSERT INTO posts (group_id, source_post_id, posted_at) VALUES ($1, $2, $3)",
        [group.rows[0].id, sourceId, postedAt]
      );
      if (!eligible || age !== "old") expected.push(sourceId);
    }
  }
  assert.equal(await pruneFacebookPosts(7), supported.length);
  const remaining = await query("SELECT source_post_id FROM posts ORDER BY source_post_id");
  assert.deepEqual(remaining.rows.map(row => row.source_post_id), expected.sort());
  assert.equal(await pruneFacebookPosts(7), 0);
  console.log("PASS: actual retention matches classification; supported old posts removed, boundary/recent/unrelated posts preserved");
} finally {
  Date.now = originalNow;
  await closeDb();
}
JS
