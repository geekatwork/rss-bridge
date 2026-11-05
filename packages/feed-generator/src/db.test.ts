import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    on = vi.fn();
    query = queryMock;
  },
}));

import { getAllGroups, getGroupBySourceId, getPostsByGroupId } from "./db.js";

describe("feed-generator db", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("getAllGroups returns rows ordered by name", async () => {
    const rows = [
      { id: 1, source_id: "a", name: "A", url: "https://a" },
      { id: 2, source_id: "b", name: "B", url: "https://b" },
    ];
    queryMock.mockResolvedValue({ rows });

    const result = await getAllGroups();

    expect(result).toEqual(rows);
    expect(queryMock).toHaveBeenCalledWith("SELECT id, source_id, name, url FROM groups ORDER BY name");
  });

  it("getGroupBySourceId returns first row or null", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, source_id: "fb-1", name: "FB", url: "https://fb" }] });

    const found = await getGroupBySourceId("fb-1");
    expect(found?.source_id).toBe("fb-1");
    expect(queryMock).toHaveBeenCalledWith("SELECT id, source_id, name, url FROM groups WHERE source_id = $1", ["fb-1"]);

    queryMock.mockResolvedValueOnce({ rows: [] });
    const missing = await getGroupBySourceId("missing");
    expect(missing).toBeNull();
  });

  it("getPostsByGroupId uses default limit and custom limit", async () => {
    const rows = [
      {
        id: 1,
        source_post_id: "p1",
        author_name: "Alice",
        content_text: "text",
        content_html: "<p>text</p>",
        link: "https://example.com",
        image_urls: [],
        posted_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    queryMock.mockResolvedValue({ rows });
    await getPostsByGroupId(10, "https://example.test/groups/10");
    expect(queryMock).toHaveBeenLastCalledWith(expect.stringContaining("ORDER BY posted_at DESC, id DESC"), [10, 100]);

    queryMock.mockResolvedValue({ rows });
    const result = await getPostsByGroupId(10, "https://example.test/groups/10", 5);
    expect(result).toEqual(rows);
    expect(queryMock).toHaveBeenLastCalledWith(expect.stringContaining("FROM posts"), [10, 100]);
  });

  it("scans past 100 ineligible posts using an exact timestamp and ID cursor", async () => {
    const blocked = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index, link: index % 2 ? null : "https://example.test/",
      posted_at: new Date("2026-01-01T00:00:00Z"),
      cursor_posted_at: "2026-01-01 00:00:00.000123+00",
    }));
    queryMock.mockResolvedValueOnce({ rows: blocked }).mockResolvedValueOnce({
      rows: [{ id: 100, link: " https://other.test/post ", cursor_posted_at: "2026-01-01 00:00:00.000123+00" }],
    });
    const posts = await getPostsByGroupId(10, "https://example.test/groups/10");
    expect(posts).toEqual([{ id: 100, link: "https://other.test/post" }]);
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("(posted_at, id) < ($3::timestamptz, $4::integer)"),
      [10, 100, "2026-01-01 00:00:00.000123+00", 101]
    );
  });

  it("filters null, blank, home and group links before applying the output limit", async () => {
    queryMock.mockResolvedValue({ rows: [
      { link: null }, { link: " " }, { link: "https://example.test/" },
      { link: "https://example.test/groups/10/" },
      { link: " https://example.test/posts/1 " },
      { link: "https://example.test/posts/2" },
    ] });
    expect(await getPostsByGroupId(10, "https://example.test/groups/10", 1))
      .toEqual([{ link: "https://example.test/posts/1" }]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty feed when no rows are eligible", async () => {
    queryMock.mockResolvedValue({ rows: [{ link: null }] });
    expect(await getPostsByGroupId(10, "https://example.test/groups/10")).toEqual([]);
  });

  it("scans past CDN links before filling the eligible feed window", async () => {
    const blocked = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
      link: `https://scontent.synthetic.${index % 2 ? "fbcdn.net" : "cdninstagram.com"}/image.jpg?token=${index}`,
      cursor_posted_at: "2026-01-01 00:00:00.000123+00",
    }));
    const valid = [
      { id: 100, link: "https://www.facebook.com/groups/123/posts/456/", image_urls: ["https://scontent.synthetic.fbcdn.net/image.jpg"] },
      { id: 99, link: "https://www.instagram.com/p/Synthetic/" },
      { id: 98, link: "https://example.test/competition.jpg?entry=required" },
    ];
    queryMock.mockResolvedValueOnce({ rows: blocked }).mockResolvedValueOnce({ rows: valid });
    expect(await getPostsByGroupId(10, "https://www.facebook.com/groups/123/", 3)).toEqual(valid);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces errors from later batches instead of returning a partial feed", async () => {
    queryMock.mockResolvedValueOnce({ rows: Array.from({ length: 100 }, (_, id) => ({
      id, link: null, cursor_posted_at: "2026-01-01 00:00:00+00",
    })) }).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getPostsByGroupId(10, "https://example.test/groups/10")).rejects.toThrow("database unavailable");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid limits: %s", async (limit) => {
    await expect(getPostsByGroupId(10, "https://example.test/groups/10", limit)).rejects.toThrow(RangeError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
