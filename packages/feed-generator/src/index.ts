import express from "express";
import { Feed } from "feed";
import { getAllGroups, getGroupBySourceId, getPostsByGroupId } from "./db.js";
import { buildFeedUrl, isLandingOrGroupUrl } from "./utils.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);

function resolveFeedBaseUrl(port: number): string {
  const fallback = `http://localhost:${port}`;
  const configured = process.env.FEED_BASE_URL;
  if (!configured) return fallback;

  try {
    const parsed = new URL(configured);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    console.warn(`Invalid FEED_BASE_URL "${configured}", falling back to ${fallback}`);
    return fallback;
  }
}

const FEED_BASE_URL = resolveFeedBaseUrl(PORT);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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

    const posts = await getPostsByGroupId(group.id);
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
      const postLink = post.link?.trim() || null;
      // Skip posts whose link is explicitly a landing/group page (bad link)
      // but include posts with no link at all (null) — they still have content
      if (postLink && isLandingOrGroupUrl(postLink, group.url)) {
        continue;
      }
      if (!postLink) {
        continue;
      }

      feed.addItem({
        title: post.author_name
          ? `${post.author_name}: ${(post.content_text || "").slice(0, 80)}`
          : (post.content_text || "").slice(0, 80),
        id: post.source_post_id,
        link: postLink,
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
