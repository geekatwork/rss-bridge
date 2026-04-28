import { describe, expect, it } from "vitest";
import { ScrapeRegistry } from "./ScrapeRegistry.js";
import { SiteScraper } from "./SiteScraper.js";
import type { NormalizedItem, ScraperContext, SiteConfig } from "./types.js";

class TestScraper extends SiteScraper {
  canHandle(_source: string): boolean {
    return true;
  }

  async init(_context: ScraperContext): Promise<void> {}

  async fetchListing(_context: ScraperContext): Promise<void> {}

  async extractItems(_context: ScraperContext): Promise<NormalizedItem[]> {
    return [];
  }

  async resolveLinks(_context: ScraperContext, _items: NormalizedItem[]): Promise<void> {}

  async hasMorePages(_context: ScraperContext): Promise<boolean> {
    return false;
  }

  async nextPage(_context: ScraperContext): Promise<void> {}

  async shutdown(_context: ScraperContext): Promise<void> {}
}

describe("ScrapeRegistry", () => {
  const baseConfig: SiteConfig = {
    siteId: "test-site",
    name: "Test Site",
    enabled: true,
    options: {},
  };

  it("registers and returns scraper instances", () => {
    const registry = new ScrapeRegistry();

    registry.register("test-site", TestScraper);

    expect(registry.has("test-site")).toBe(true);
    expect(registry.listSites()).toEqual(["test-site"]);

    const scraper = registry.get("test-site", baseConfig);
    expect(scraper).toBeInstanceOf(TestScraper);
  });

  it("throws when getting unregistered site", () => {
    const registry = new ScrapeRegistry();

    expect(() => registry.get("missing", baseConfig)).toThrow("No scraper registered for site: missing");
  });

  it("re-registering a site replaces previous scraper class", () => {
    class AlternateScraper extends TestScraper {}

    const registry = new ScrapeRegistry();
    registry.register("test-site", TestScraper);
    registry.register("test-site", AlternateScraper);

    const scraper = registry.get("test-site", baseConfig);
    expect(scraper).toBeInstanceOf(AlternateScraper);
  });
});
