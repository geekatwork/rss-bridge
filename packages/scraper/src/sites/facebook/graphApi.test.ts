import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { fetchGroupPostsViaApi, fetchPostsViaApi } from "./graphApi.js";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

describe("facebook graphApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps Graph API response into NormalizedPost[] with escaped html and deduped images", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        data: [
          {
            id: "post_1",
            message: "Hello <world> & \"friends\"",
            from: { name: "Alice" },
            created_time: "2026-01-02T03:04:05.000Z",
            permalink_url: "https://www.facebook.com/groups/123/posts/post_1",
            full_picture: "https://img.example/a.jpg",
            attachments: {
              data: [
                {
                  subattachments: {
                    data: [
                      { media: { image: { src: "https://img.example/a.jpg" } } },
                      { media: { image: { src: "https://img.example/b.jpg" } } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    } as never);

    const posts = await fetchPostsViaApi("123", "token", 10);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toMatch(/\/123\/feed$/);
    expect(vi.mocked(axios.get).mock.calls[0]?.[1]).toMatchObject({
      params: {
        access_token: "token",
        limit: 10,
      },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].sourcePostId).toBe("post_1");
    expect(posts[0].authorName).toBe("Alice");
    expect(posts[0].link).toBe("https://www.facebook.com/groups/123/posts/post_1");
    expect(posts[0].contentText).toBe("Hello <world> & \"friends\"");
    expect(posts[0].contentHtml).toBe("<p>Hello &lt;world&gt; &amp; &quot;friends&quot;</p>");
    expect(posts[0].imageUrls).toEqual([
      "https://img.example/a.jpg",
      "https://img.example/b.jpg",
    ]);
    expect(posts[0].postedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("handles posts with minimal fields", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        data: [
          {
            id: "post_2",
            created_time: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
    } as never);

    const posts = await fetchPostsViaApi("123", "token");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      sourcePostId: "post_2",
      authorName: null,
      contentText: "",
      contentHtml: "<p></p>",
      link: null,
      imageUrls: [],
    });
  });

  it("exposes backward-compatible alias", () => {
    expect(fetchGroupPostsViaApi).toBe(fetchPostsViaApi);
  });
});
