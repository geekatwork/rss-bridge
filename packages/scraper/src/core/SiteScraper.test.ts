import { describe, expect, it, vi } from "vitest";
import { RecoverablePageError, SiteScraper } from "./SiteScraper.js";
import type { NormalizedItem, ScraperContext, SiteConfig } from "./types.js";

class ControlledScraper extends SiteScraper {
  public listingCalls = 0;
  public initCalls = 0;
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
    this.initCalls++;
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
    return this.pages[this.nextCalls] ?? [];
  }

  async resolveLinks(_context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    for (const item of items) {
      if (!item.link) {
        item.link = `https://resolved.local/${item.sourceId}`;
      }
    }
  }

  async hasMorePages(_context: ScraperContext): Promise<boolean> {
    return this.nextCalls + 1 < this.pages.length;
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
    expect(result.errors).toContain("Page 2 (fetch): fetch failed");
  });

  it("retains partially resolved items and accurate counters when resolution fails", async () => {
    const scraper = new ControlledScraper(config, [
      [makeItem("a"), makeItem("b"), makeItem("c", true)],
      [makeItem("d")],
    ]);
    vi.spyOn(scraper, "resolveLinks").mockImplementation(async (_context, items) => {
      items[0].link = "https://resolved.local/a";
      throw new Error("resolution failed");
    });
    const result = await scraper.run(makeContext());
    expect(result.items.map((item) => item.sourceId)).toEqual(["a", "b", "c"]);
    expect(result.linksResolved).toBe(1);
    expect(result.linksResolveFailed).toBe(1);
    expect(result.errors).toEqual(["Page 1 (resolve): resolution failed"]);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it.each(["fetchListing", "extractItems", "resolveLinks"] as const)(
    "advances safely after a recoverable %s failure",
    async (method) => {
      const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
      vi.spyOn(scraper, method).mockRejectedValueOnce(new RecoverablePageError("page unavailable"));
      const context = makeContext();
      const warn = vi.spyOn(context.logger, "warn");
      const result = await scraper.run(context);
      expect(result.items.map((item) => item.sourceId)).toEqual(method === "resolveLinks" ? ["a", "b"] : ["b"]);
      expect(result.errors).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ site: "test-site", jobId: "job-1", page: 1, step: expect.any(String) }),
        "Scraper step failed"
      );
      expect(scraper.nextCalls).toBe(1);
      expect(scraper.shutdownCalls).toBe(1);
    }
  );

  it("stops after three consecutive failed pages", async () => {
    const scraper = new ControlledScraper(config, Array.from({ length: 5 }, () => [makeItem("a")]));
    vi.spyOn(scraper, "extractItems").mockRejectedValue(new RecoverablePageError("extract failed"));
    const result = await scraper.run(makeContext());
    expect(scraper.listingCalls).toBe(3);
    expect(scraper.nextCalls).toBe(2);
    expect(result.errors).toHaveLength(3);
    expect(result.items).toEqual([]);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("resets the consecutive failure count after a successful page", async () => {
    const scraper = new ControlledScraper(config, Array.from({ length: 6 }, (_, index) => [makeItem(String(index))]));
    const extract = scraper.extractItems.bind(scraper);
    vi.spyOn(scraper, "extractItems").mockImplementation(async (context) => {
      if (scraper.listingCalls !== 3 && scraper.listingCalls !== 6) {
        throw new RecoverablePageError("temporary failure");
      }
      return extract(context);
    });
    const result = await scraper.run(makeContext());
    expect(result.items.map((item) => item.sourceId)).toEqual(["2", "5"]);
    expect(result.errors).toHaveLength(4);
    expect(scraper.listingCalls).toBe(6);
  });

  it.each(["hasMorePages", "nextPage"] as const)("stops on %s failure even if marked recoverable", async (method) => {
    const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
    vi.spyOn(scraper, method).mockRejectedValue(new RecoverablePageError("navigation failed"));
    const result = await scraper.run(makeContext());
    expect(result.itemsExtracted).toBe(1);
    expect(result.errors).toEqual([`Page 1 (${method}): navigation failed`]);
    expect(scraper.listingCalls).toBe(1);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("does not advance beyond maxPages after a recoverable failure", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
    vi.spyOn(scraper, "extractItems").mockRejectedValue(new RecoverablePageError("extract failed"));
    const result = await scraper.run(makeContext({ config: { maxPages: 1 } }));
    expect(result.errors).toHaveLength(1);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("records non-Error extraction failures and stops safely", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
    vi.spyOn(scraper, "extractItems").mockRejectedValue("unknown failure");
    const result = await scraper.run(makeContext());
    expect(result.errors).toEqual(["Page 1 (extract): unknown failure"]);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("does not navigate when a recoverable failure occurs on the last page", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")]]);
    vi.spyOn(scraper, "extractItems").mockRejectedValue(new RecoverablePageError("extract failed"));
    const result = await scraper.run(makeContext());
    expect(result.errors).toEqual(["Page 1 (extract): extract failed"]);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("does not recover initialization failures even when marked recoverable", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")]]);
    vi.spyOn(scraper, "init").mockRejectedValue(new RecoverablePageError("session unavailable"));
    const result = await scraper.run(makeContext());
    expect(result.errors).toEqual(["session unavailable"]);
    expect(scraper.listingCalls).toBe(0);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
  });

  it("records fatal init and shutdown errors", async () => {
    const scraper = new ControlledScraper(config, []);
    scraper.throwOnInit = true;
    scraper.throwOnShutdown = true;
    const context = makeContext();
    const logError = vi.spyOn(context.logger, "error");

    const result = await scraper.run(context);

    expect(result.itemsExtracted).toBe(0);
    expect(result.errors).toContain("init failed");
    expect(result.errors).toContain("Shutdown: shutdown failed");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ site: "test-site", jobId: "job-1", error: "shutdown failed" }),
      "Error during shutdown"
    );
  });

  it("stops a run when its cancellation signal is aborted and still shuts down", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")]]);
    const controller = new AbortController();
    controller.abort(new Error("scrape deadline exceeded"));

    const result = await scraper.run(makeContext({ signal: controller.signal }));

    expect(scraper.initCalls).toBe(0);
    expect(scraper.listingCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
    expect(result.errors).toContain("scrape deadline exceeded");
  });

  it("does not advance pagination when cancellation occurs during a page request", async () => {
    const scraper = new ControlledScraper(config, [[makeItem("a")], [makeItem("b")]]);
    const controller = new AbortController();
    vi.spyOn(scraper, "fetchListing").mockImplementation(async () => {
      controller.abort(new Error("scrape cancelled"));
    });

    const result = await scraper.run(makeContext({ signal: controller.signal }));

    expect(scraper.listingCalls).toBe(0);
    expect(scraper.nextCalls).toBe(0);
    expect(scraper.shutdownCalls).toBe(1);
    expect(result.errors[0]).toContain("scrape cancelled");
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
