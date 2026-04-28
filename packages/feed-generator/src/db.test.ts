import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    query = queryMock;
  },
}));

import { getAllGroups, getGroupBySourceId, getPostsByGroupId } from "./db.js";

describe("feed-generator db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    await getPostsByGroupId(10);
    expect(queryMock).toHaveBeenLastCalledWith(expect.stringContaining("FROM posts"), [10, 50]);

    queryMock.mockResolvedValue({ rows });
    const result = await getPostsByGroupId(10, 5);
    expect(result).toEqual(rows);
    expect(queryMock).toHaveBeenLastCalledWith(expect.stringContaining("FROM posts"), [10, 5]);
  });
});
