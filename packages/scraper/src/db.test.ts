import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupConfig, NormalizedPost } from "./types.js";
import type { NormalizedItem } from "./core/index.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    query = queryMock;
  },
}));

import { ensureGroup, pruneFacebookPosts, upsertItems, upsertPosts } from "./db.js";

describe("scraper db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

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
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[1]?.[6]).toBe(JSON.stringify(["https://example.com/a.jpg"]));
  });

  it("upsertItems maps normalized items fields correctly", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });

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
