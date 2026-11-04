import assert from "node:assert/strict";

const base = "http://127.0.0.1:3100";
const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
const readiness = await health.json();
assert.equal(readiness.status, "ok");
assert.equal(readiness.database.status, "ok");

const feeds = await fetch(`${base}/feeds`);
assert.equal(feeds.status, 200);
const group = (await feeds.json()).find((entry) => entry.groupId === "smoke-test-group");
assert.ok(group, "Scraped group missing from feed discovery");
assert.equal(group.name, "Smoke Test Group");
const feed = await fetch(`${base}${group.feedUrl}`);
assert.equal(feed.status, 200);
assert.match(feed.headers.get("content-type"), /application\/rss\+xml/);
const xml = await feed.text();
assert.match(xml, /<rss/);
assert.equal((xml.match(/<item>/g) ?? []).length, 1);
assert.ok(xml.includes("example_item-0"));
assert.ok(xml.includes("Content extracted from the local smoke fixture."));
assert.ok(xml.includes("http://fixture:8080/posts/smoke-test-post"));
console.log("[test-smoke] Database readiness, scraped feed discovery and RSS verified");
