import type { NormalizedItem, ScraperContext, ScrapeResult, SiteConfig } from "./types.js";
import { ScraperConfigurationError, scraperErrorMessage } from "./errors.js";

/** A page-local failure after which the plugin can safely check and advance pagination. */
export class RecoverablePageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoverablePageError";
  }
}

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
 * The scheduled orchestrator handles timeouts and database persistence/deduplication.
 * Methods should throw Error instances. Configuration/state errors are fatal.
 * Only RecoverablePageError from fetch/extract/resolve permits page advancement;
 * transport errors and abort reasons remain fatal unless safe advancement is explicit.
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
   * @throws Error for configuration, authentication, setup or resource failures.
   */
  abstract init(context: ScraperContext): Promise<void>;

  /**
   * Fetch the listing page(s) where items are displayed.
    * Example: navigate to a source listing page, search results, or collection view.
   * This is where scrolling, pagination setup happens.
   * @throws Error to stop; RecoverablePageError only when safe pagination is possible.
   */
  abstract fetchListing(context: ScraperContext): Promise<void>;

  /**
   * Extract items from the current page DOM or API response.
   * Return raw item data; link resolution happens in the next phase.
   * Should extract as much as possible without clicking individual items.
   * @throws Error to stop; RecoverablePageError only when safe pagination is possible.
   */
  abstract extractItems(context: ScraperContext): Promise<NormalizedItem[]>;

  /**
   * Resolve external links for items that don't have them.
   * Example: click image to open Instagram link, or fetch from API.
   * Modifies items in-place.
   * @throws Error to stop; RecoverablePageError only when safe pagination is possible.
   * Partial item updates survive failures.
   */
  abstract resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void>;

  /**
   * Check if there are more items to fetch.
   * If true, caller will paginate and call fetchListing → extractItems again.
   * @throws Error to stop; pagination failures are never recovered automatically.
   */
  abstract hasMorePages(context: ScraperContext): Promise<boolean>;

  /**
   * Go to the next page.
   * Example: scroll, click "Next", update API offset, etc.
   * @throws Error to stop; pagination failures are never recovered automatically.
   */
  abstract nextPage(context: ScraperContext): Promise<void>;

  /**
   * Clean up: close pages, clear cookies, disconnect proxy, etc.
   * Called once at end of job, even if there were errors.
   * @throws Error for cleanup failures, appended to the result without hiding prior errors.
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
      const configuredMaxPages = context.config.maxPages;
      const maxPages = configuredMaxPages === undefined ? 10 : configuredMaxPages;
      if (typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages < 1) {
        throw new ScraperConfigurationError("maxPages must be a positive safe integer");
      }
      context.logger.info({ site: this.config.siteId }, "Initializing scraper");
      context.signal?.throwIfAborted();
      await this.init(context);

      let pageCount = 0;
      let consecutivePageErrors = 0;
      let consecutiveEmptyPages = 0;
      const recordPageError = (step: string, error: unknown): void => {
        const message = scraperErrorMessage(error);
        context.logger.warn(
          { site: this.config.siteId, jobId: context.jobId, page: pageCount + 1, step, error: message },
          "Scraper step failed"
        );
        errors.push(`Page ${pageCount + 1} (${step}): ${message}`);
      };

      // Pagination loop
      while (pageCount < maxPages) {
        context.signal?.throwIfAborted();
        let step = "fetch";
        let pageFailed = false;
        let emptyPage = false;
        try {
          context.logger.debug({ site: this.config.siteId, page: pageCount + 1 }, "Fetching listing");
          await this.fetchListing(context);
          context.signal?.throwIfAborted();

          step = "extract";
          context.logger.debug({ site: this.config.siteId, page: pageCount + 1 }, "Extracting items");
          const items = await this.extractItems(context);
          context.signal?.throwIfAborted();
          context.logger.info({ site: this.config.siteId, page: pageCount + 1, count: items.length }, "Extracted items");
          emptyPage = items.length === 0;

          if (items.length > 0) {
            step = "resolve";
            context.logger.debug({ site: this.config.siteId }, "Resolving links");
            const unresolvedItems = items.filter((item) => !item.link);
            try {
              await this.resolveLinks(context, items);
              context.signal?.throwIfAborted();
            } finally {
              linksResolved += unresolvedItems.filter((item) => item.link).length;
              linksFailed += items.filter((item) => !item.link).length;
              allItems.push(...items);
            }
          }
        } catch (error) {
          recordPageError(step, error);
          pageFailed = true;
          consecutivePageErrors++;
          if (!(error instanceof RecoverablePageError)) break;
          if (consecutivePageErrors >= 3) {
            context.logger.warn(
              { site: this.config.siteId, jobId: context.jobId, consecutivePageErrors },
              "Stopping after three consecutive failed pages"
            );
            break;
          }
        }

        if (!pageFailed) {
          consecutivePageErrors = 0;
          consecutiveEmptyPages = emptyPage ? consecutiveEmptyPages + 1 : 0;
          if (consecutiveEmptyPages >= 3) {
            context.logger.info(
              { site: this.config.siteId, jobId: context.jobId, page: pageCount + 1, consecutiveEmptyPages },
              "Stopping after three consecutive empty pages"
            );
            break;
          }
        } else {
          consecutiveEmptyPages = 0;
        }
        if (allItems.length >= (context.maxItems ?? 100) || pageCount + 1 >= maxPages) break;

        try {
          step = "hasMorePages";
          const hasMorePages = await this.hasMorePages(context);
          context.signal?.throwIfAborted();
          if (!hasMorePages) {
            context.logger.info({ site: this.config.siteId }, "No more pages or max items reached");
            break;
          }

          step = "nextPage";
          await this.nextPage(context);
          context.signal?.throwIfAborted();
          pageCount++;
        } catch (error) {
          recordPageError(step, error);
          break;
        }
      }

      context.logger.info({ site: this.config.siteId, total: allItems.length }, "Scraping completed");
    } catch (e) {
      const msg = scraperErrorMessage(e);
      context.logger.error({ site: this.config.siteId, error: msg }, "Fatal error during scrape");
      errors.push(msg);
    } finally {
      try {
        await this.shutdown(context);
      } catch (e) {
        const msg = scraperErrorMessage(e);
        context.logger.error({ site: this.config.siteId, jobId: context.jobId, error: msg }, "Error during shutdown");
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
