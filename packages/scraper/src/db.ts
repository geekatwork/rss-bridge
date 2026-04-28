import { Pool } from "pg";
import type { NormalizedPost, GroupConfig } from "./types.js";
import type { NormalizedItem } from "./core/index.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function ensureGroup(config: GroupConfig): Promise<number> {
  const result = await pool.query(
    `INSERT INTO groups (source_id, name, url)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_id) DO UPDATE SET name = $2, url = $3
     RETURNING id`,
    [config.groupId, config.name, config.url]
  );
  return result.rows[0].id;
}

export async function upsertPosts(
  groupId: number,
  posts: NormalizedPost[]
): Promise<number> {
  let upserted = 0;
  for (const post of posts) {
    const result = await pool.query(
      `INSERT INTO posts (group_id, source_post_id, author_name, content_text, content_html, link, image_urls, posted_at, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (source_post_id) DO UPDATE SET
         author_name = EXCLUDED.author_name,
         content_text = EXCLUDED.content_text,
         content_html = EXCLUDED.content_html,
         link = EXCLUDED.link,
         image_urls = EXCLUDED.image_urls,
         scraped_at = NOW()
       RETURNING id`,
      [
        groupId,
        post.sourcePostId,
        post.authorName,
        post.contentText,
        post.contentHtml,
        post.link,
        JSON.stringify(post.imageUrls),
        post.postedAt,
      ]
    );
    if (result.rowCount && result.rowCount > 0) upserted++;
  }
  return upserted;
}

/**
 * Persist NormalizedItem records from the plugin scraper path.
 * Maps generic core types onto the existing schema columns.
 */
export async function upsertItems(
  groupId: number,
  items: NormalizedItem[]
): Promise<number> {
  let upserted = 0;
  for (const item of items) {
    const result = await pool.query(
      `INSERT INTO posts (group_id, source_post_id, author_name, content_text, content_html, link, image_urls, posted_at, scraped_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (source_post_id) DO UPDATE SET
         author_name = EXCLUDED.author_name,
         content_text = EXCLUDED.content_text,
         content_html = EXCLUDED.content_html,
         link = EXCLUDED.link,
         image_urls = EXCLUDED.image_urls,
         scraped_at = NOW()
       RETURNING id`,
      [
        groupId,
        item.sourceId,
        item.authorName,
        item.contentText,
        item.contentHtml,
        item.link,
        JSON.stringify(item.mediaUrls),
        item.publishedAt,
      ]
    );
    if (result.rowCount && result.rowCount > 0) upserted++;
  }
  return upserted;
}
