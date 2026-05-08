import { Pool } from "pg";
import type { NormalizedPost, GroupConfig } from "./types.js";
import type { NormalizedItem } from "./core/index.js";
import { canonicalizeUrl } from "./core/utils.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function closeDb(): Promise<void> {
  await pool.end();
}

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

interface PersistablePost {
  sourcePostId: string;
  authorName: string | null;
  contentText: string | null;
  contentHtml: string | null;
  link: string | null;
  imageUrls: string[];
  postedAt: Date;
}

interface ExistingPostRow {
  source_post_id: string;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function normalizeLink(link: string | null | undefined): string | null {
  const trimmed = link?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const preserveHash = parsed.hostname !== "www.competitions.co.nz" && parsed.hostname !== "competitions.co.nz";
    return canonicalizeUrl(trimmed, { preserveHash });
  } catch {
    return canonicalizeUrl(trimmed);
  }
}

async function persistPost(groupId: number, post: PersistablePost): Promise<number> {
  const normalizedLink = normalizeLink(post.link);

  if (normalizedLink) {
    const existingByLink = await pool.query<ExistingPostRow>(
      `SELECT source_post_id
       FROM posts
       WHERE link = $1
       LIMIT 1`,
      [normalizedLink]
    );
    const linkRow = existingByLink.rows[0] ?? null;
    if (linkRow && linkRow.source_post_id !== post.sourcePostId) {
      return 0;
    }
  }

  try {
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
        normalizedLink,
        JSON.stringify(post.imageUrls),
        post.postedAt,
      ]
    );

    return result.rowCount ?? 0;
  } catch (error) {
    const pgError = error as PgErrorLike;
    if (pgError.code === "23505" && pgError.constraint === "uq_posts_link_non_null") {
      return 0;
    }
    throw error;
  }
}

export async function upsertPosts(
  groupId: number,
  posts: NormalizedPost[]
): Promise<number> {
  let upserted = 0;
  for (const post of posts) {
    const result = await persistPost(groupId, {
      sourcePostId: post.sourcePostId,
      authorName: post.authorName,
      contentText: post.contentText,
      contentHtml: post.contentHtml,
      link: post.link,
      imageUrls: post.imageUrls,
      postedAt: post.postedAt,
    });
    if (result > 0) upserted++;
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
    const result = await persistPost(groupId, {
      sourcePostId: item.sourceId,
      authorName: item.authorName,
      contentText: item.contentText,
      contentHtml: item.contentHtml,
      link: item.link,
      imageUrls: item.mediaUrls,
      postedAt: item.publishedAt,
    });
    if (result > 0) upserted++;
  }
  return upserted;
}

export async function pruneFacebookPosts(retentionDays = 7): Promise<number> {
  const safeRetentionDays = Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : 7;
  const cutoffDate = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `DELETE FROM posts AS p
     USING groups AS g
     WHERE p.group_id = g.id
       AND p.posted_at < $1
       AND (
         LOWER(g.url) LIKE 'https://www.facebook.com/groups/%'
         OR LOWER(g.url) LIKE 'http://www.facebook.com/groups/%'
         OR LOWER(g.url) LIKE 'https://m.facebook.com/groups/%'
         OR LOWER(g.url) LIKE 'http://m.facebook.com/groups/%'
         OR LOWER(g.url) LIKE 'https://mbasic.facebook.com/groups/%'
         OR LOWER(g.url) LIKE 'http://mbasic.facebook.com/groups/%'
       )
     RETURNING p.id`,
    [cutoffDate]
  );

  return result.rowCount ?? 0;
}

/**
 * Returns the most recently scraped source post id for a group.
 * Used as a boundary marker so site scrapers can stop when they reach
 * content that has already been persisted.
 */
export async function getLatestScrapedSourcePostId(
  groupId: number
): Promise<string | null> {
  const result = await pool.query(
    `SELECT source_post_id
     FROM posts
     WHERE group_id = $1
     ORDER BY scraped_at DESC, id DESC
     LIMIT 1`,
    [groupId]
  );
  return result.rows[0]?.source_post_id ?? null;
}
