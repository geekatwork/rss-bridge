import type { Page } from "puppeteer";
import { SiteScraper, type NormalizedItem, type ScraperContext, type SiteConfig } from "../core/index.js";
import { sleep, textToParagraphHtml } from "../core/utils.js";

/**
 * TEMPLATE: ExampleScraper
 *
 * This is a skeleton showing how to implement a new site scraper.
 * Copy this file, rename the class, and implement each method.
 *
 * Methods to implement:
 * 1. canHandle() - identify if this scraper should run for a given source
 * 2. init() - setup browser page, cookies, login
 * 3. fetchListing() - navigate to the listing page
 * 4. extractItems() - parse items from DOM or API
 * 5. resolveLinks() - click to get external links if needed
 * 6. hasMorePages() / nextPage() - pagination
 * 7. shutdown() - cleanup
 *
 * Each method receives a ScraperContext with browser, logger, config, etc.
 * Return normalized NormalizedItem objects.
 */
export class ExampleScraper extends SiteScraper {
  private page?: Page;
  private currentPageNumber = 0;

  /**
   * Example: check if the source is for this site.
   * In real implementations, check URL pattern or site name.
   */
  canHandle(source: string): boolean {
    // Example: return source === "example-site" || source.includes("example.com");
    return source === "example-site";
  }

  /**
   * Initialize: setup page, cookies, user agent, etc.
   */
  async init(context: ScraperContext): Promise<void> {
    context.logger.info({ site: this.config.siteId }, "Initializing");
    this.page = await context.browser.newPage();

    // Set viewport (mobile vs desktop)
    await this.page.setViewport({ width: 1920, height: 1080 });

    // Set user agent if provided
    if (context.credentials?.userAgent) {
      await this.page.setUserAgent(context.credentials.userAgent);
    }

    // Set cookies if provided
    if (context.credentials?.cookies) {
      const cookieArray = Object.entries(context.credentials.cookies).map(([name, value]) => ({
        name,
        value,
        domain: "example.com",
        path: "/",
      }));
      await this.page.setCookie(...cookieArray);
    }

    context.logger.debug({ site: this.config.siteId }, "Initialized");
  }

  /**
   * Fetch the listing page.
   * Navigate to the source URL and wait for content to load.
   */
  async fetchListing(context: ScraperContext): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    const sourceUrl = this.config.options.sourceUrl as string;
    if (!sourceUrl) throw new Error("sourceUrl required in config.options");

    context.logger.debug({ site: this.config.siteId, url: sourceUrl }, "Navigating");
    await this.page.goto(sourceUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000); // Wait for JS to settle
  }

  /**
   * Extract items from the current page.
   * Parse DOM or API response into NormalizedItem array.
   *
   * Example logic:
   * - Find all item containers
   * - For each, extract title, author, date, text, image, link
   * - Return array of normalized items
   */
  async extractItems(context: ScraperContext): Promise<NormalizedItem[]> {
    if (!this.page) throw new Error("Page not initialized");

    const items = await this.page.evaluate(() => {
      const results: Array<{
        id: string;
        title: string | null;
        author: string | null;
        text: string;
        imageUrl: string | null;
        link: string | null;
        publishedAt: string | null;
      }> = [];

      // Example: find all article elements
      const articles = document.querySelectorAll("article");
      articles.forEach((article, idx) => {
        results.push({
          id: `item-${idx}`,
          title: article.querySelector("h2")?.textContent || null,
          author: article.querySelector(".author")?.textContent || null,
          text: article.querySelector(".content")?.textContent || "",
          imageUrl: article.querySelector("img")?.getAttribute("src") || null,
          link: article.querySelector("a")?.getAttribute("href") || null,
          publishedAt: article.querySelector("time")?.getAttribute("datetime") || null,
        });
      });

      return results;
    });

    // Normalize into NormalizedItem array
    return items.map((item): NormalizedItem => {
      return {
        sourceId: `example_${item.id}`,
        sourceSite: this.config.siteId,
        title: item.title,
        authorName: item.author,
        contentText: item.text,
        contentHtml: textToParagraphHtml(item.text),
        link: item.link,
        mediaUrls: item.imageUrl ? [item.imageUrl] : [],
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
      };
    });
  }

  /**
   * Resolve external links by clicking items or fetching from API.
   * Modifies items in-place by setting the `link` field.
   *
   * Example:
   * - For items without a link
   * - Click to open, capture new tab URL, or parse API response
   * - Set item.link
   */
  async resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    context.logger.debug({ site: this.config.siteId, itemsToResolve: items.filter((i) => !i.link).length }, "Resolving links");
    // Example: items without links can be updated here
    // For now, skip if already have links
    const itemsNeedingLinks = items.filter((i) => !i.link);
    context.logger.debug({ count: itemsNeedingLinks.length }, "Items needing link resolution");
  }

  /**
   * Check if there are more pages to fetch.
   * Return true if pagination exists.
   */
  async hasMorePages(context: ScraperContext): Promise<boolean> {
    if (!this.page) return false;

    const maxPages = (this.config.options.maxPages ?? 1) as number;
    return this.currentPageNumber < maxPages;
  }

  /**
   * Go to the next page.
   * Example: click "Next" button, scroll to load more, update API offset.
   */
  async nextPage(context: ScraperContext): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    context.logger.debug({ site: this.config.siteId, nextPage: this.currentPageNumber + 1 }, "Pagination");
    this.currentPageNumber++;

    // Example: scroll to load more
    await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(2000);
  }

  /**
   * Shutdown: close page, clear resources.
   */
  async shutdown(context: ScraperContext): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    context.logger.debug({ site: this.config.siteId }, "Shutdown complete");
  }
}
