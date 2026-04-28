import type { SiteScraper } from "./SiteScraper.js";
import type { SiteConfig } from "./types.js";

/**
 * Registry of all available site scrapers.
 * Maps site IDs to their scraper classes.
 *
 * Usage:
 *   registry.register("facebook", FacebookScraper);
 *   registry.register("twitter", TwitterScraper);
 *   const scraper = registry.get("facebook");
 */
export class ScrapeRegistry {
  private scrapers: Map<string, new (config: SiteConfig) => SiteScraper> = new Map();

  /**
   * Register a scraper class for a given site ID.
   */
  register(siteId: string, ScraperClass: new (config: SiteConfig) => SiteScraper): void {
    this.scrapers.set(siteId, ScraperClass);
  }

  /**
   * Get a scraper instance for a site ID.
   * @throws if site is not registered
   */
  get(siteId: string, config: SiteConfig): SiteScraper {
    const ScraperClass = this.scrapers.get(siteId);
    if (!ScraperClass) {
      throw new Error(`No scraper registered for site: ${siteId}`);
    }
    return new ScraperClass(config);
  }

  /**
   * Check if a site is registered.
   */
  has(siteId: string): boolean {
    return this.scrapers.has(siteId);
  }

  /**
   * List all registered site IDs.
   */
  listSites(): string[] {
    return Array.from(this.scrapers.keys());
  }
}

/**
 * Singleton registry instance.
 */
export const globalRegistry = new ScrapeRegistry();
