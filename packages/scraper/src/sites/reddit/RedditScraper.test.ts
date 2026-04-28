import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { RedditScraper } from "./RedditScraper.js";
import type { ScraperContext, SiteConfig } from "../../core/types.js";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock("../../core/utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  getJitteredDelay: vi.fn(() => 0),
  textToParagraphHtml: vi.fn((text: string | null) => {
    if (!text) return null;
    return `<p>${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/\n/g, "</p><p>")}</p>`;
  }),
}));

function makeContext(): ScraperContext {
  const loggerStub = {
    level: "info",
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    silent: () => undefined,
    child: () => loggerStub,
  };

  return {
    browser: {} as ScraperContext["browser"],
    logger: loggerStub as unknown as ScraperContext["logger"],
    jobId: "job-1",
    startedAt: new Date(),
    config: {},
  };
}

describe("RedditScraper extractItems", () => {
  const cfg: SiteConfig = {
    siteId: "reddit",
    name: "Reddit",
    enabled: true,
    options: {
      subreddits: ["typescript"],
      sort: "hot",
      limit: 2,
      maxPages: 2,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps reddit API children into NormalizedItem[] and updates pagination cursor", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        data: {
          after: "t3_next",
          children: [
            {
              kind: "t3",
              data: {
                id: "abc",
                title: "Post title",
                selftext: "Body <script>alert(1)</script> & \"quoted\"",
                author: "user1",
                permalink: "/r/typescript/comments/abc/post_title/",
                preview: {
                  images: [{ source: { url: "https://img.example/1.jpg" } }],
                },
                created_utc: 1700000000,
                score: 10,
                num_comments: 2,
              },
            },
            {
              kind: "t1",
              data: {
                id: "comment-should-be-ignored",
              },
            },
          ],
        },
      },
    } as never);

    const scraper = new RedditScraper(cfg);
    const context = makeContext();
    await scraper.fetchListing(context);
    const items = await scraper.extractItems(context);

    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe("reddit_abc");
    expect(items[0].title).toBe("Post title");
    expect(items[0].contentHtml).toBe("<p>Body &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;</p>");
    expect(items[0].link).toBe("https://reddit.com/r/typescript/comments/abc/post_title/");
    expect(items[0].mediaUrls).toEqual(["https://img.example/1.jpg"]);

    expect(await scraper.hasMorePages(context)).toBe(true);
  });

  it("throws through API errors", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("api down"));

    const scraper = new RedditScraper(cfg);
    const context = makeContext();
    await scraper.fetchListing(context);

    await expect(scraper.extractItems(context)).rejects.toThrow("api down");
  });
});
