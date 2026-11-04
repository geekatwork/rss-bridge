import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { query, closeDb } = await import(pathToFileURL(`${process.cwd()}/dist/database.js`).href);
const { getPostsByGroupId } = await import(pathToFileURL(`${process.cwd()}/dist/db.js`).href);
const sourceId = "feed-window-regression";
const groupUrl = "https://window.example.test/groups/test";
let groupId;
try {
  const group = await query(
    "INSERT INTO groups (source_id, name, url) VALUES ($1, $2, $3) RETURNING id",
    [sourceId, "Feed window regression", groupUrl]
  );
  groupId = group.rows[0].id;
  for (let index = 0; index < 55; index++) {
    await query(
      `INSERT INTO posts (group_id, source_post_id, link, content_text, posted_at)
       VALUES ($1, $2, $3, 'eligible', '2026-01-01T00:00:00.000123Z')`,
      [groupId, `window-valid-${index}`, `https://article.example.test/window-${index}`]
    );
  }
  const blockedLinks = [null, " ", "https://window.example.test/", `${groupUrl}/`];
  // Distinct blank/landing strings satisfy the production unique-link index.
  for (let index = 0; index < 120; index++) {
    const link = blockedLinks[index % blockedLinks.length];
    await query(
      `INSERT INTO posts (group_id, source_post_id, link, posted_at)
       VALUES ($1, $2, $3, $4)`,
      [groupId, `window-blocked-${index}`,
        link === null ? null : link === " " ? " ".repeat(index + 1) : `${link}?blocked=${index}`,
        index < 60 ? "2026-02-01T00:00:00Z" : "2026-01-01T00:00:00.000123Z"]
    );
  }
  const expected = Array.from({ length: 50 }, (_, index) => `window-valid-${54 - index}`);
  const posts = await getPostsByGroupId(groupId, groupUrl);
  assert.deepEqual(posts.map(post => post.source_post_id), expected);
  assert.deepEqual((await getPostsByGroupId(groupId, groupUrl, 3)).map(post => post.source_post_id), expected.slice(0, 3));
  const response = await fetch(`http://127.0.0.1:3100/feed/${sourceId}`);
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.equal((xml.match(/<item>/g) ?? []).length, 50);
  let previous = -1;
  for (const id of expected) {
    const position = xml.indexOf(`>${id}<`);
    assert.ok(position > previous, `Missing/out-of-order RSS item: ${id}`);
    previous = position;
  }
  assert.ok(!xml.includes("window-blocked-"));
  await query("DELETE FROM posts WHERE group_id = $1 AND source_post_id LIKE 'window-valid-%'", [groupId]);
  assert.deepEqual(await getPostsByGroupId(groupId, groupUrl), []);
  const empty = await fetch(`http://127.0.0.1:3100/feed/${sourceId}`);
  assert.equal(empty.status, 200);
  assert.ok(!(await empty.text()).includes("<item>"));
  console.log("[test-smoke] Eligible RSS window verified beyond 120 blocked rows, including timestamp ties and empty feed");
} finally {
  if (groupId !== undefined) await query("DELETE FROM groups WHERE id = $1", [groupId]);
  await closeDb();
}
