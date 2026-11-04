import express from "express";
import { Feed } from "feed";
import { getAllGroups, getGroupBySourceId, getPostsByGroupId } from "./db.js";
import { buildFeedUrl } from "./utils.js";
import { checkDatabase, getDatabaseHealth } from "./database.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);

function resolveFeedBaseUrl(port: number): string {
  const fallback = `http://localhost:${port}`;
  const configured = process.env.FEED_BASE_URL;
  if (!configured) return fallback;

  try {
    const parsed = new URL(configured);
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Expected an HTTP(S) base URL without credentials, query or fragment");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    console.warn(`Invalid FEED_BASE_URL; expected an HTTP(S) URL without credentials, query or fragment, falling back to ${fallback}`);
    return fallback;
  }
}

const FEED_BASE_URL = resolveFeedBaseUrl(PORT);

app.get("/health", async (_req, res) => {
  const ready = await checkDatabase();
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    database: getDatabaseHealth(),
  });
});

app.get("/feeds", async (_req, res) => {
  try {
    const groups = await getAllGroups();
    const feeds = groups.map((g) => ({
      groupId: g.source_id,
      name: g.name,
      feedUrl: `/feed/${g.source_id}`,
    }));
    res.json(feeds);
  } catch (err) {
    console.error("Error listing feeds:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/feed/:groupId", async (req, res) => {
  try {
    const group = await getGroupBySourceId(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    const posts = await getPostsByGroupId(group.id, group.url);
    const feedUrl = buildFeedUrl(FEED_BASE_URL, group.source_id);

    const feed = new Feed({
      title: group.name,
      description: `Posts from source group: ${group.name}`,
      id: feedUrl,
      link: feedUrl,
      copyright: "",
      language: "en",
      updated: posts.length > 0 ? posts[0].posted_at : new Date(),
      generator: "rss-bridge feed-generator",
    });

    for (const post of posts) {
      feed.addItem({
        title: post.author_name
          ? `${post.author_name}: ${(post.content_text || "").slice(0, 80)}`
          : (post.content_text || "").slice(0, 80),
        id: post.source_post_id,
        link: post.link,
        description: post.content_html || post.content_text || "",
        date: post.posted_at,
        author: post.author_name
          ? [{ name: post.author_name }]
          : undefined,
      });
    }

    res.set("Content-Type", "application/rss+xml; charset=utf-8");
    res.send(feed.rss2());
  } catch (err) {
    console.error("Error generating feed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Feed generator listening on port ${PORT}`);
});
