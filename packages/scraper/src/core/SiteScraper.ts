import type { NormalizedItem, ScraperContext, ScrapeResult, SiteConfig } from "./types.js";

/**
 * Abstract base class for all site-specific scrapers.
 * Extend this class to add a new content source.
 *
 * Each site implementation must:
 * 1. Identify if it can handle a given source
 * 2. Initialize resources (browser, proxy, etc.)
 * 3. Fetch and extract items
 * 4. Resolve external links if needed
 * 5. Clean up resources
 *
 * The engine handles: retries, timeouts, deduplication, persistence.
 */
export abstract class SiteScraper {
  protected config: SiteConfig;
  protected context?: ScraperContext;

  constructor(config: SiteConfig) {
    this.config = config;
  }

  /**
   * Check if this scraper can handle the given source.
    * Example: site === "news" or url.includes("example.com")
   */
  abstract canHandle(source: string): boolean;

  /**
   * Initialize scraper for this run.
   * Open pages, set cookies, login if needed, etc.
   * Called once per job.
   */
  abstract init(context: ScraperContext): Promise<void>;

  /**
   * Fetch the listing page(s) where items are displayed.
    * Example: navigate to a source listing page, search results, or collection view.
   * This is where scrolling, pagination setup happens.
   */
  abstract fetchListing(context: ScraperContext): Promise<void>;

  /**
   * Extract items from the current page DOM or API response.
   * Return raw item data; link resolution happens in the next phase.
   * Should extract as much as possible without clicking individual items.
   */
  abstract extractItems(context: ScraperContext): Promise<NormalizedItem[]>;

  /**
   * Resolve external links for items that don't have them.
   * Example: click image to open Instagram link, or fetch from API.
   * Modifies items in-place.
   */
  abstract resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void>;

  /**
   * Check if there are more items to fetch.
   * If true, caller will paginate and call fetchListing → extractItems again.
   */
  abstract hasMorePages(context: ScraperContext): Promise<boolean>;

  /**
   * Go to the next page.
   * Example: scroll, click "Next", update API offset, etc.
   */
  abstract nextPage(context: ScraperContext): Promise<void>;

  /**
   * Clean up: close pages, clear cookies, disconnect proxy, etc.
   * Called once at end of job, even if there were errors.
   */
  abstract shutdown(context: ScraperContext): Promise<void>;

  /**
   * Convenience: run the full lifecycle and return a result object.
   * Caller handles retries and error reporting.
   */
  async run(context: ScraperContext): Promise<ScrapeResult> {
    this.context = context;
    const startedAt = new Date();
    const errors: string[] = [];
    const allItems: NormalizedItem[] = [];
    let linksResolved = 0;
    let linksFailed = 0;

    try {
      context.logger.info({ site: this.config.siteId }, "Initializing scraper");
      await this.init(context);

      let pageCount = 0;
      const maxPages = (context.config.maxPages as number) ?? 10;

      // Pagination loop
      while (pageCount < maxPages) {
        try {
          context.logger.debug({ site: this.config.siteId, page: pageCount + 1 }, "Fetching listing");
          await this.fetchListing(context);

          context.logger.debug({ site: this.config.siteId, page: pageCount + 1 }, "Extracting items");
          const items = await this.extractItems(context);
          context.logger.info({ site: this.config.siteId, page: pageCount + 1, count: items.length }, "Extracted items");

          if (items.length > 0) {
            context.logger.debug({ site: this.config.siteId }, "Resolving links");
            const beforeCount = items.filter((i) => i.link).length;
            await this.resolveLinks(context, items);
            const afterCount = items.filter((i) => i.link).length;
            linksResolved += afterCount - beforeCount;
            linksFailed += items.filter((i) => !i.link).length;
            allItems.push(...items);
          }

          const hasMore = await this.hasMorePages(context);
          if (!hasMore || allItems.length >= (context.maxItems ?? 100)) {
            context.logger.info({ site: this.config.siteId }, "No more pages or max items reached");
            break;
          }

          await this.nextPage(context);
          pageCount++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          context.logger.warn({ site: this.config.siteId, page: pageCount + 1, error: msg }, "Error during pagination");
          errors.push(`Page ${pageCount + 1}: ${msg}`);
          break; // Stop on pagination error
        }
      }

      context.logger.info({ site: this.config.siteId, total: allItems.length }, "Scraping completed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      context.logger.error({ site: this.config.siteId, error: msg }, "Fatal error during scrape");
      errors.push(msg);
    } finally {
      try {
        await this.shutdown(context);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        context.logger.error({ site: this.config.siteId, error: msg }, "Error during shutdown");
        errors.push(`Shutdown: ${msg}`);
      }
    }

    const completedAt = new Date();
    return {
      site: this.config.siteId,
      jobId: context.jobId,
      items: allItems,
      errors,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      itemsExtracted: allItems.length,
      linksResolved,
      linksResolveFailed: linksFailed,
    };
  }
}
