import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupConfig, NormalizedPost } from "./types.js";
import type { NormalizedItem } from "./core/index.js";

const { queryMock, endMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = queryMock;
    end = endMock;
  },
}));

import { ensureGroup, pruneFacebookPosts, upsertItems, upsertPosts } from "./db.js";

describe("scraper db", () => {
  beforeEach(() => {
    queryMock.mockReset();
    endMock.mockReset();
  });

  it("ensureGroup upserts and returns id", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 42 }] });

    const config: GroupConfig = {
      groupId: "group-1",
      name: "Group One",
      url: "https://example.com/group-1",
    };

    const id = await ensureGroup(config);

    expect(id).toBe(42);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO groups"), [
      "group-1",
      "Group One",
      "https://example.com/group-1",
    ]);
  });

  it("upsertPosts counts only rows with rowCount > 0", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 })
      ;

    const posts: NormalizedPost[] = [
      {
        sourcePostId: "p1",
        authorName: "Alice",
        contentText: "hello",
        contentHtml: "<p>hello</p>",
        link: "https://example.com/1",
        imageUrls: ["https://example.com/a.jpg"],
        postedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        sourcePostId: "p2",
        authorName: null,
        contentText: null,
        contentHtml: null,
        link: null,
        imageUrls: [],
        postedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ];

    const upserted = await upsertPosts(10, posts);

    expect(upserted).toBe(1);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO posts"), [
      10,
      "p1",
      "Alice",
      "hello",
      "<p>hello</p>",
      "https://example.com/1",
      JSON.stringify(["https://example.com/a.jpg"]),
      new Date("2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("upsertItems maps normalized items fields correctly", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const items: NormalizedItem[] = [
      {
        sourceId: "item-1",
        sourceSite: "facebook",
        title: "title",
        contentText: "content",
        contentHtml: "<p>content</p>",
        authorName: "Bob",
        link: "https://example.com/post",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];

    const upserted = await upsertItems(11, items);

    expect(upserted).toBe(1);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO posts"), [
      11,
      "item-1",
      "Bob",
      "content",
      "<p>content</p>",
      "https://example.com/post",
      JSON.stringify(["https://example.com/1.jpg", "https://example.com/2.jpg"]),
      new Date("2026-02-01T00:00:00.000Z"),
    ]);
  });

  it("preserves external hash fragments when persisting outbound links", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const items: NormalizedItem[] = [
      {
        sourceId: "item-2",
        sourceSite: "competitions-nz",
        title: "Wagner",
        contentText: null,
        contentHtml: null,
        authorName: null,
        link: "https://www.wagneraustralia.com.au/mothers-day-2026/#",
        mediaUrls: [],
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];

    await upsertItems(12, items);

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO posts"), [
      12,
      "item-2",
      null,
      null,
      null,
      "https://www.wagneraustralia.com.au/mothers-day-2026/#",
      JSON.stringify([]),
      new Date("2026-02-01T00:00:00.000Z"),
    ]);
  });

  it("skips insert when a canonicalized link already exists on another row", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            source_post_id: "existing-post",
          },
        ],
      });

    const items: NormalizedItem[] = [
      {
        sourceId: "new-source-id",
        sourceSite: "facebook",
        title: "title",
        contentText: null,
        contentHtml: null,
        authorName: null,
        link: "https://example.com/post/1?fbclid=tracking",
        mediaUrls: ["https://example.com/old.jpg", "https://example.com/new.jpg"],
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];

    const upserted = await upsertItems(11, items);

    expect(upserted).toBe(0);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("WHERE link = $1"), [
      "https://example.com/post/1",
    ]);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO posts"), expect.any(Array));
  });

  it("silently skips when the unique link index rejects a concurrent duplicate", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({ code: "23505", constraint: "uq_posts_link_non_null" });

    const items: NormalizedItem[] = [
      {
        sourceId: "new-source-id",
        sourceSite: "facebook",
        title: "title",
        contentText: "content",
        contentHtml: "<p>content</p>",
        authorName: "Bob",
        link: "https://example.com/post/1",
        mediaUrls: [],
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];

    const upserted = await upsertItems(11, items);

    expect(upserted).toBe(0);
  });

  it("pruneFacebookPosts deletes only rows older than the cutoff using a parameterized date", async () => {
    queryMock.mockResolvedValue({ rowCount: 3 });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-02-08T12:00:00.000Z").getTime());

    const deleted = await pruneFacebookPosts(7);

    expect(deleted).toBe(3);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM posts AS p"),
      [new Date("2026-02-01T12:00:00.000Z")]
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("facebook.com/groups/%"),
      expect.any(Array)
    );

    nowSpy.mockRestore();
  });
});
