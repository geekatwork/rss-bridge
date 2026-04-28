import { describe, expect, it } from "vitest";
import { FacebookScraper } from "./facebook/FacebookScraper.js";
import { RedditScraper } from "./reddit/RedditScraper.js";
import { ExampleScraper } from "./ExampleScraper.js";
import type { ScraperContext, SiteConfig } from "../core/types.js";

function makeContext(overrides: Partial<ScraperContext> = {}): ScraperContext {
  const loggerStub = {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => loggerStub,
  };

  return {
    browser: {} as ScraperContext["browser"],
    logger: loggerStub as unknown as ScraperContext["logger"],
    jobId: "job-1",
    startedAt: new Date(),
    config: {},
    ...overrides,
  };
}

describe("FacebookScraper", () => {
  const cfg: SiteConfig = {
    siteId: "facebook",
    name: "Facebook",
    enabled: true,
    options: {},
  };

  it("canHandle matches facebook id and group url", () => {
    const scraper = new FacebookScraper(cfg);
    expect(scraper.canHandle("facebook")).toBe(true);
    expect(scraper.canHandle("https://www.facebook.com/groups/123")).toBe(true);
    expect(scraper.canHandle("reddit")).toBe(false);
  });

  it("hasMorePages is false by default", async () => {
    const scraper = new FacebookScraper(cfg);
    expect(await scraper.hasMorePages(makeContext())).toBe(false);
  });

  it("shutdown without page does not throw", async () => {
    const scraper = new FacebookScraper(cfg);
    await expect(scraper.shutdown(makeContext())).resolves.toBeUndefined();
  });
});

describe("RedditScraper", () => {
  const cfg: SiteConfig = {
    siteId: "reddit",
    name: "Reddit",
    enabled: true,
    options: { subreddits: ["typescript"], maxPages: 2 },
  };

  it("canHandle matches reddit id and subreddit url", () => {
    const scraper = new RedditScraper(cfg);
    expect(scraper.canHandle("reddit")).toBe(true);
    expect(scraper.canHandle("https://reddit.com/r/typescript")).toBe(true);
    expect(scraper.canHandle("facebook")).toBe(false);
  });

  it("fetchListing throws when subreddits config is missing", async () => {
    const scraper = new RedditScraper({ ...cfg, options: {} });
    await expect(scraper.fetchListing(makeContext())).rejects.toThrow("No subreddits provided in config.options");
  });

  it("hasMorePages depends on after cursor and page count", async () => {
    const scraper = new RedditScraper(cfg);

    // Without cursor it should not paginate.
    expect(await scraper.hasMorePages(makeContext())).toBe(false);

    // Set internal cursor and verify pagination path.
    (scraper as unknown as { after: string; pageCount: number }).after = "t3_abc";
    (scraper as unknown as { after: string; pageCount: number }).pageCount = 0;
    expect(await scraper.hasMorePages(makeContext())).toBe(true);

    await scraper.nextPage(makeContext());
    await scraper.nextPage(makeContext());
    expect(await scraper.hasMorePages(makeContext())).toBe(false);
  });

  it("resolveLinks is a no-op for API items", async () => {
    const scraper = new RedditScraper(cfg);
    await expect(scraper.resolveLinks(makeContext(), [])).resolves.toBeUndefined();
  });
});

describe("ExampleScraper", () => {
  const cfg: SiteConfig = {
    siteId: "example-site",
    name: "Example",
    enabled: true,
    options: { maxPages: 2 },
  };

  it("canHandle only matches example-site", () => {
    const scraper = new ExampleScraper(cfg);
    expect(scraper.canHandle("example-site")).toBe(true);
    expect(scraper.canHandle("https://example.com")).toBe(false);
  });

  it("hasMorePages is false when page is not initialized", async () => {
    const scraper = new ExampleScraper(cfg);
    expect(await scraper.hasMorePages(makeContext())).toBe(false);
  });

  it("nextPage throws when page is not initialized", async () => {
    const scraper = new ExampleScraper(cfg);
    await expect(scraper.nextPage(makeContext())).rejects.toThrow("Page not initialized");
  });

  it("shutdown without page does not throw", async () => {
    const scraper = new ExampleScraper(cfg);
    await expect(scraper.shutdown(makeContext())).resolves.toBeUndefined();
  });
});
