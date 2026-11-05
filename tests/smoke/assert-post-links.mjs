import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { query } = await import(pathToFileURL(`${process.cwd()}/dist/database.js`).href);
const { ensureGroup, upsertItems, closeDb } = await import(pathToFileURL(`${process.cwd()}/dist/db.js`).href);
const groupIds = [];
try {
  for (const platform of ["facebook", "instagram"]) {
    const sourceId = `cdn-regression-${platform}`;
    const groupId = await ensureGroup({
      groupId: sourceId, name: sourceId, url: `https://www.facebook.com/groups/${platform}/`,
    });
    groupIds.push(groupId);
    const media = `https://scontent.synthetic.${platform === "facebook" ? "fbcdn.net" : "cdninstagram.com"}/image.jpg?token=synthetic`;
    const sourcePostId = `${sourceId}-post`;
    const item = {
      sourceId: sourcePostId, sourceSite: "facebook", title: null, authorName: null,
      contentText: "Synthetic retained content", contentHtml: `<p>Synthetic</p><img src="${media}">`,
      link: media, mediaUrls: [media], publishedAt: new Date("2026-01-01T00:00:00Z"),
    };
    assert.equal(await upsertItems(groupId, [item]), 1);
    let row = (await query("SELECT * FROM posts WHERE source_post_id = $1", [sourcePostId])).rows[0];
    assert.equal(row.link, null);
    assert.deepEqual(row.image_urls, [media]);
    assert.equal(row.content_text, item.contentText);
    let response = await fetch(`http://feed-generator:3100/feed/${sourceId}`);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes("<item>"));

    // Simulate a historical media destination without changing its identity/content.
    await query("UPDATE posts SET link = $1 WHERE source_post_id = $2", [media, sourcePostId]);
    response = await fetch(`http://feed-generator:3100/feed/${sourceId}`);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes("<item>"));
    row = (await query("SELECT link FROM posts WHERE source_post_id = $1", [sourcePostId])).rows[0];
    assert.equal(row.link, media);

    const verified = platform === "facebook"
      ? "https://www.facebook.com/groups/123/permalink/456"
      : "https://www.instagram.com/p/Synthetic";
    assert.equal(await upsertItems(groupId, [{ ...item, link: verified }]), 1);
    assert.equal(await upsertItems(groupId, [{ ...item, link: null }]), 1);
    row = (await query("SELECT * FROM posts WHERE source_post_id = $1", [sourcePostId])).rows[0];
    assert.equal(row.link, verified);
    assert.deepEqual(row.image_urls, [media]);
    response = await fetch(`http://feed-generator:3100/feed/${sourceId}`);
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.equal((xml.match(/<item>/g) ?? []).length, 1);
    assert.ok(xml.includes(`<link>${verified}</link>`));
    assert.ok(xml.includes("Synthetic retained content"));
  }
  console.log("[test-smoke] Both social groups retain unresolved media, filter historical CDN links and accept later verified destinations");
} finally {
  for (const groupId of groupIds) await query("DELETE FROM groups WHERE id = $1", [groupId]);
  await closeDb();
}
