import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
  const result = await pool.query<GroupRow>(
    "SELECT id, source_id, name, url FROM groups ORDER BY name"
  );
  return result.rows;
}

export async function getGroupBySourceId(
  sourceId: string
): Promise<GroupRow | null> {
  const result = await pool.query<GroupRow>(
    "SELECT id, source_id, name, url FROM groups WHERE source_id = $1",
    [sourceId]
  );
  return result.rows[0] ?? null;
}

export async function getPostsByGroupId(
  groupId: number,
  limit = 50
): Promise<PostRow[]> {
  const result = await pool.query<PostRow>(
    `SELECT id, source_post_id, author_name, content_text, content_html,
            link, image_urls, posted_at
     FROM posts
     WHERE group_id = $1
     ORDER BY posted_at DESC
     LIMIT $2`,
    [groupId, limit]
  );
  return result.rows;
}
