import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import type { NormalizedItem } from "./core/types.js";

const databaseUrl = process.env.SCRAPER_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("enforces post integrity in an isolated PostgreSQL schema", async () => {
  if (!databaseUrl) throw new Error("SCRAPER_TEST_DATABASE_URL is required");
  const databaseDirectory = [resolve(process.cwd(), "../../db"), resolve(process.cwd(), "db")]
    .find((path) => existsSync(resolve(path, "01-init.sql")));
  if (!databaseDirectory) throw new Error("Database schema scripts not found");
  const client = new Client({ connectionString: databaseUrl });
  const schema = `integrity_${randomUUID().replace(/-/g, "")}`;
  await client.connect();
  let closeDb: (() => Promise<void>) | undefined;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const initialSql = readFileSync(resolve(databaseDirectory, "01-init.sql"), "utf8");
    // Exercise an existing pre-provenance schema, then the repeatable additive migration.
    await client.query(initialSql.replace("    posted_at_is_source BOOLEAN NOT NULL DEFAULT FALSE,\n", ""));
    const migration = readFileSync(resolve(databaseDirectory, "03-post-timestamp-provenance.sql"), "utf8");
    await client.query(migration);
    await client.query(migration);
    const connection = new URL(databaseUrl);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", connection.toString());
    vi.resetModules();
    const db = await import("./db.js");
    closeDb = db.closeDb;
    const first = await db.ensureGroup({ groupId: "first", name: "First", url: "https://example.com/first" });
    const second = await db.ensureGroup({ groupId: "second", name: "Second", url: "https://example.com/second" });
    const item = (sourceId: string, publishedAt: string, overrides: Partial<NormalizedItem> = {}): NormalizedItem => ({
      sourceId, sourceSite: "test", title: null, authorName: null,
      contentText: sourceId, contentHtml: null, link: null, mediaUrls: [],
      publishedAt: new Date(publishedAt), ...overrides,
    });

    const media = "https://scontent.synthetic.fbcdn.net/image.jpg?token=synthetic";
    await db.upsertItems(first, [item("media-only", "2026-10-01", { link: media, mediaUrls: [media] })]);
    let mediaRow = (await client.query("SELECT * FROM posts WHERE source_post_id = 'media-only'")).rows[0];
    expect(mediaRow.link).toBeNull();
    expect(mediaRow.image_urls).toEqual([media]);
    const verified = "https://www.instagram.com/p/Synthetic";
    await db.upsertItems(first, [item("media-only", "2026-10-01", { link: verified, mediaUrls: [media] })]);
    await db.upsertItems(first, [item("media-only", "2026-10-01", { mediaUrls: [media] })]);
    mediaRow = (await client.query("SELECT * FROM posts WHERE source_post_id = 'media-only'")).rows[0];
    expect(mediaRow.link).toBe(verified);
    expect(mediaRow.image_urls).toEqual([media]);
    await client.query("UPDATE posts SET link = $1 WHERE source_post_id = 'media-only'", [media]);
    await db.upsertItems(first, [item("media-only", "2026-10-01", { link: verified, mediaUrls: [media] })]);
    mediaRow = (await client.query("SELECT * FROM posts WHERE source_post_id = 'media-only'")).rows[0];
    expect(mediaRow.link).toBe(verified);

    await db.upsertItems(first, [item("fallback", "2026-11-01")]);
    await db.upsertItems(first, [item("fallback", "2026-11-02")]);
    let row = (await client.query("SELECT * FROM posts WHERE source_post_id = 'fallback'")).rows[0];
    expect(row.posted_at.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(row.posted_at_is_source).toBe(false);
    await db.upsertItems(first, [item("fallback", "2026-10-30", { publishedAtIsSource: true })]);
    await db.upsertItems(first, [item("fallback", "2026-11-03")]);
    row = (await client.query("SELECT * FROM posts WHERE source_post_id = 'fallback'")).rows[0];
    expect(row.posted_at.toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(row.posted_at_is_source).toBe(true);

    await expect(db.upsertItems(second, [item("fallback", "2026-11-03", { contentText: "overwrite" })]))
      .rejects.toThrow("belongs to another group");
    row = (await client.query("SELECT * FROM posts WHERE source_post_id = 'fallback'")).rows[0];
    expect(row.group_id).toBe(first);
    expect(row.content_text).toBe("fallback");

    expect(await db.upsertItems(first, [item("link-owner", "2026-10-29", {
      link: "https://example.com/post?utm_source=tracking",
    })])).toBe(1);
    expect(await db.upsertItems(second, [item("link-duplicate", "2026-10-29", {
      link: "https://example.com/post?fbclid=tracking",
    })])).toBe(0);
    await expect(client.query(
      "INSERT INTO posts (group_id, source_post_id, link, posted_at) VALUES ($1, 'race', 'https://example.com/post', NOW())",
      [second]
    )).rejects.toMatchObject({ code: "23505", constraint: "uq_posts_link_non_null" });
    await expect(client.query(
      "INSERT INTO posts (group_id, source_post_id, posted_at) VALUES ($1, 'fallback', NOW())", [first]
    )).rejects.toMatchObject({ code: "23505" });

    await db.upsertItems(first, [
      item("newest", "2026-11-02", { publishedAtIsSource: true }),
      item("older", "2026-11-01", { publishedAtIsSource: true }),
    ]);
    expect(await db.getLatestScrapedSourcePostId(first)).toBe("newest");
    await db.upsertItems(first, [item("older", "2026-11-01", { publishedAtIsSource: true })]);
    expect(await db.getLatestScrapedSourcePostId(first)).toBe("newest");
    await db.upsertItems(first, [item("tie", "2026-11-02", { publishedAtIsSource: true })]);
    expect(await db.getLatestScrapedSourcePostId(first)).toBe("tie");
    expect(await db.getLatestScrapedSourcePostId(second)).toBeNull();
  } finally {
    try {
      if (closeDb) await closeDb();
    } finally {
      vi.unstubAllEnvs();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    }
  }
}, 20_000);
