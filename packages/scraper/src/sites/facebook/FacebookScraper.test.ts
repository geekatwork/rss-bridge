
// --- IMPORTS ---
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FacebookScraper } from "./FacebookScraper.js";
import { cleanFacebookPostText } from "./FacebookScraper.js";
import { fetchPostsViaApi } from "./graphApi.js";
import type { ScraperContext, SiteConfig } from "../../core/types.js";

// --- MOCKS ---
vi.mock("./graphApi.js", () => ({
  fetchPostsViaApi: vi.fn(),
}));

// --- HELPER FUNCTIONS ---
function makeContext(): ScraperContext {
  const loggerStub = {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => loggerStub,
  };

  return {
    browser: {
      newPage: vi.fn(),
    } as unknown as ScraperContext["browser"],
    logger: loggerStub as unknown as ScraperContext["logger"],
    jobId: "job-1",
    startedAt: new Date(),
    config: {},
  };
}

describe("FacebookScraper API mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Graph API path when accessToken is configured", async () => {
    vi.mocked(fetchPostsViaApi).mockResolvedValue([
      {
        sourcePostId: "post_1",
        authorName: "Author",
        contentText: "Hello",
        contentHtml: "<p>Hello</p>",
        link: "https://example.com/post/1",
        imageUrls: ["https://example.com/image.jpg"],
        postedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const cfg: SiteConfig = {
      siteId: "facebook",
      name: "Facebook",
      enabled: true,
      options: {
        accessToken: "token",
        groupIds: ["12345"],
      },
    };

    const scraper = new FacebookScraper(cfg);
    const context = makeContext();

    await scraper.init(context);
    await scraper.fetchListing(context);
    const items = await scraper.extractItems(context);

    expect(fetchPostsViaApi).toHaveBeenCalledWith("12345", "token");
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe("post_1");
    expect(items[0].sourceSite).toBe("facebook");
    expect(items[0].authorName).toBe("Author");
  });

  it("fetchListing throws if groupIds are missing", async () => {
    const cfg: SiteConfig = {
      siteId: "facebook",
      name: "Facebook",
      enabled: true,
      options: {
        accessToken: "token",
      },
    };

    const scraper = new FacebookScraper(cfg);
    const context = makeContext();

    await scraper.init(context);
    await expect(scraper.fetchListing(context)).rejects.toThrow("No groupIds provided in config.options");
  });
});

describe("Facebook post content cleaning logic", () => {
  it("removes author, admin, timestamp, and special unicode", () => {
    const raw = "Aaron Terrence William Wells: Admin                    ‎‎3h‎󰞋‎󱙷‎\nGIVEAWAY TIME 💝...";
    const cleaned = cleanFacebookPostText(raw, "Aaron Terrence William Wells");
    expect(cleaned).toBe("GIVEAWAY TIME 💝...");
  });
  it("removes only author and timestamp if no admin", () => {
    const raw = "Tania Elson: 49m\nCollection only Palmerston North residents";
    const cleaned = cleanFacebookPostText(raw, "Tania Elson");
    expect(cleaned).toBe("Collection only Palmerston North residents");
  });
  it("removes only timestamp if no author", () => {
    const raw = "9h\nSome post content";
    const cleaned = cleanFacebookPostText(raw);
    expect(cleaned).toBe("Some post content");
  });
  it("removes special unicode from start/end", () => {
    const raw = "\uE000\uF8FFGIVEAWAY\uF8FF\uE000";
    const cleaned = cleanFacebookPostText(raw);
    expect(cleaned).toBe("GIVEAWAY");
  });
});
