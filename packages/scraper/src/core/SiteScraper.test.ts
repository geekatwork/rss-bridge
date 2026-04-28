import { describe, expect, it } from "vitest";
import { SiteScraper } from "./SiteScraper.js";
import type { NormalizedItem, ScraperContext, SiteConfig } from "./types.js";

class ControlledScraper extends SiteScraper {
  public listingCalls = 0;
  public nextCalls = 0;
  public shutdownCalls = 0;
  public throwOnInit = false;
  public throwOnFetchPage?: number;
  public throwOnShutdown = false;

  private pages: NormalizedItem[][];

  constructor(config: SiteConfig, pages: NormalizedItem[][]) {
    super(config);
    this.pages = pages;
  }

  canHandle(_source: string): boolean {
    return true;
  }

  async init(_context: ScraperContext): Promise<void> {
    if (this.throwOnInit) {
      throw new Error("init failed");
    }
  }

  async fetchListing(_context: ScraperContext): Promise<void> {
    this.listingCalls++;
    if (this.throwOnFetchPage === this.listingCalls) {
      throw new Error("fetch failed");
    }
  }

  async extractItems(_context: ScraperContext): Promise<NormalizedItem[]> {
    return this.pages[this.listingCalls - 1] ?? [];
  }

  async resolveLinks(_context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    for (const item of items) {
      if (!item.link) {
        item.link = `https://resolved.local/${item.sourceId}`;
      }
    }
  }

  async hasMorePages(_context: ScraperContext): Promise<boolean> {
    return this.listingCalls < this.pages.length;
  }

  async nextPage(_context: ScraperContext): Promise<void> {
    this.nextCalls++;
  }

  async shutdown(_context: ScraperContext): Promise<void> {
    this.shutdownCalls++;
    if (this.throwOnShutdown) {
      throw new Error("shutdown failed");
    }
  }
}

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
    config: { maxPages: 10 },
    maxItems: 100,
    ...overrides,
  };
}

function makeItem(id: string, withLink = false): NormalizedItem {
  return {
    sourceId: id,
    sourceSite: "test-site",
    title: id,
    contentText: `content-${id}`,
    contentHtml: `<p>${id}</p>`,
    authorName: "author",
    link: withLink ? `https://existing.local/${id}` : null,
    mediaUrls: [],
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("SiteScraper run lifecycle", () => {
  const config: SiteConfig = {
    siteId: "test-site",
    name: "Test Site",
    enabled: true,
    options: {},
  };

  it("runs pagination lifecycle and tracks link resolution counters", async () => {
    const scraper = new ControlledScraper(config, [
      [makeItem("a"), makeItem("b", true)],
      [makeItem("c")],
    ]);

    const result = await scraper.run(makeContext());

    expect(scraper.listingCalls).toBe(2);
    expect(scraper.nextCalls).toBe(1);
    expect(scraper.shutdownCalls).toBe(1);

    expect(result.itemsExtracted).toBe(3);
    expect(result.linksResolved).toBe(2);
    expect(result.linksResolveFailed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("stops and records pagination errors", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
    scraper.throwOnFetchPage = 2;

    const result = await scraper.run(makeContext());

    expect(scraper.listingCalls).toBe(2);
    expect(result.itemsExtracted).toBe(1);
    expect(result.errors).toContain("Page 2: fetch failed");
  });

  it("records fatal init and shutdown errors", async () => {
    const scraper = new ControlledScraper(config, []);
    scraper.throwOnInit = true;
    scraper.throwOnShutdown = true;

    const result = await scraper.run(makeContext());

    expect(result.itemsExtracted).toBe(0);
    expect(result.errors).toContain("init failed");
    expect(result.errors).toContain("Shutdown: shutdown failed");
  });

  it("respects maxItems and exits early", async () => {
    const scraper = new ControlledScraper(config, [
      [makeItem("a"), makeItem("b")],
      [makeItem("c")],
    ]);

    const result = await scraper.run(makeContext({ maxItems: 2 }));

    expect(result.itemsExtracted).toBe(2);
    expect(scraper.listingCalls).toBe(1);
    expect(scraper.nextCalls).toBe(0);
  });
});
