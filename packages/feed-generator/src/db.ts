import { query } from "./database.js";
import { isLandingOrGroupUrl } from "./utils.js";

export interface GroupRow {
  id: number;
  source_id: string;
  name: string;
  url: string;
}

export interface PostRow {
  id: number;
  source_post_id: string;
  author_name: string | null;
  content_text: string | null;
  content_html: string | null;
  link: string | null;
  image_urls: string[];
  posted_at: Date;
}

export async function getAllGroups(): Promise<GroupRow[]> {
  const result = await query<GroupRow>(
    "SELECT id, source_id, name, url FROM groups ORDER BY name"
  );
  return result.rows;
}

export async function getGroupBySourceId(
  sourceId: string
): Promise<GroupRow | null> {
  const result = await query<GroupRow>(
    "SELECT id, source_id, name, url FROM groups WHERE source_id = $1",
    [sourceId]
  );
  return result.rows[0] ?? null;
}

export async function getPostsByGroupId(
  groupId: number,
  groupUrl: string,
  limit = 50
): Promise<Array<PostRow & { link: string }>> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Feed limit must be a positive safe integer");
  }
  const posts: Array<PostRow & { link: string }> = [];
  let cursor: { postedAt: string; id: number } | undefined;
  const batchSize = 100;
  while (posts.length < limit) {
    const result = await query<PostRow & { cursor_posted_at: string }>(
      `SELECT id, source_post_id, author_name, content_text, content_html,
              link, image_urls, posted_at, posted_at::text AS cursor_posted_at
       FROM posts
       WHERE group_id = $1
         ${cursor ? "AND (posted_at, id) < ($3::timestamptz, $4::integer)" : ""}
       ORDER BY posted_at DESC, id DESC
       LIMIT $2`,
      cursor ? [groupId, batchSize, cursor.postedAt, cursor.id] : [groupId, batchSize]
    );
    for (const row of result.rows) {
      const link = row.link?.trim();
      if (link && !isLandingOrGroupUrl(link, groupUrl)) {
        const { cursor_posted_at, ...post } = row;
        posts.push({ ...post, link });
        if (posts.length === limit) return posts;
      }
    }
    if (result.rows.length < batchSize) break;
    const last = result.rows[result.rows.length - 1];
    // Keep PostgreSQL's full timestamp precision across keyset pages.
    cursor = { postedAt: last.cursor_posted_at, id: last.id };
  }
  return posts;
}
