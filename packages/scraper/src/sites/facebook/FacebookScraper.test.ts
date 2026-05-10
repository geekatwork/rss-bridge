
// --- IMPORTS ---
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FacebookScraper } from "./FacebookScraper.js";
import { cleanFacebookPostText } from "./FacebookScraper.js";
import { isLikelyFacebookNonPostContent } from "./FacebookScraper.js";
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

  it("caps API items at boundary fallback limit when stop marker is missing", async () => {
    const posts = Array.from({ length: 55 }, (_, i) => ({
      sourcePostId: `post_${i + 1}`,
      authorName: "Author",
      contentText: `Hello ${i + 1}`,
      contentHtml: `<p>Hello ${i + 1}</p>`,
      link: `https://example.com/post/${i + 1}`,
      imageUrls: [],
      postedAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    vi.mocked(fetchPostsViaApi).mockResolvedValue(posts);

    const cfg: SiteConfig = {
      siteId: "facebook",
      name: "Facebook",
      enabled: true,
      options: {
        accessToken: "token",
        groupIds: ["12345"],
        stopAtSourceId: "post_999",
        boundaryFallbackLimit: 50,
      },
    };

    const scraper = new FacebookScraper(cfg);
    const context = makeContext();

    await scraper.init(context);
    await scraper.fetchListing(context);
    const items = await scraper.extractItems(context);

    expect(items).toHaveLength(50);
    expect(items[0].sourceId).toBe("post_1");
    expect(items[49].sourceId).toBe("post_50");
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

  it("removes mobile UI boilerplate fragments from content", () => {
    const raw = "All-star contributor WIN NOW... See more Write a public comment…";
    const cleaned = cleanFacebookPostText(raw);
    expect(cleaned).toBe("WIN NOW...");
  });

  it("trims all-star preamble so content starts at source label", () => {
    const raw = "All-star contributor          ‎‎5h‎󰞋‎󱙷‎󱐆All-star contributor󳄫Canvasland‎5h‎󰞋‎󱙷‎** Give Away **... See more1󰍸1󰍺";
    const cleaned = cleanFacebookPostText(raw);
    expect(cleaned.startsWith("Canvasland")).toBe(true);
  });

  it("detects pseudo-post UI fragments", () => {
    expect(isLikelyFacebookNonPostContent("Most relevantSORT")).toBe(true);
    expect(isLikelyFacebookNonPostContent("Write something... Photo Feeling")).toBe(true);
    expect(isLikelyFacebookNonPostContent("VideosAnnouncementsEvents")).toBe(true);
    expect(isLikelyFacebookNonPostContent("Facebook Competitions NZ Public group·12Kmembers Joined Invite")).toBe(true);
    expect(isLikelyFacebookNonPostContent("Let's welcome our new members: ...")).toBe(true);
    expect(isLikelyFacebookNonPostContent("About this group Instagram Contests")).toBe(true);
    expect(isLikelyFacebookNonPostContent("There's more to see Get more photos, videos and updates from this group. Log in Create new account")).toBe(true);
  });

  it("does not flag normal giveaway post text as pseudo-post", () => {
    expect(isLikelyFacebookNonPostContent("INSTAGRAM giveaway - Win a prize pack now")).toBe(false);
  });
});
