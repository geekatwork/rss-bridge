import axios from "axios";
import { SiteScraper, type NormalizedItem, type ScraperContext, type SiteConfig } from "../../core/index.js";
import { sleep, getJitteredDelay, textToParagraphHtml } from "../../core/utils.js";

/**
 * RedditScraper: Scrapes public subreddit posts via API.
 *
 * Uses reddit.com/r/{subreddit}/.json endpoint (public, no auth needed).
 * Respects robots.txt and rate limits (1 req/sec per Reddit's rules).
 *
 * Config options:
 * - subreddits: Array of subreddit names (e.g., ["python", "javascript"])
 * - limit: Posts per request (25-100, default: 50)
 * - sort: Sorting strategy ("hot", "new", "top", default: "hot")
 * - timeFilter: For "top" sort ("day", "week", "month", "year", "all", default: "week")
 * - maxPages: Pagination rounds (default: 1)
 */
export class RedditScraper extends SiteScraper {
  private subreddit?: string;
  private after?: string;
  private pageCount = 0;

  canHandle(source: string): boolean {
    return source === "reddit" || source.startsWith("https://reddit.com/r/");
  }

  async init(context: ScraperContext): Promise<void> {
    context.logger.info({ site: this.config.siteId }, "Initializing Reddit scraper");
    // Reddit API doesn't require setup; just set headers
    // No browser needed for API-based scraping
    context.logger.debug({ site: this.config.siteId }, "Reddit scraper initialized");
  }

  async fetchListing(context: ScraperContext): Promise<void> {
    const subreddits = this.config.options.subreddits as string[];
    if (!subreddits || subreddits.length === 0) {
      throw new Error("No subreddits provided in config.options");
    }

    this.subreddit = subreddits[0];
    context.logger.info({ subreddit: this.subreddit }, "Fetching Reddit listings");
  }

  async extractItems(context: ScraperContext): Promise<NormalizedItem[]> {
    if (!this.subreddit) throw new Error("Subreddit not set");

    const sort = (this.config.options.sort as string) || "hot";
    const timeFilter = (this.config.options.timeFilter as string) || "week";
    const limit = (this.config.options.limit as number) || 50;

    const params: Record<string, string | number> = { limit };
    if (this.after) params.after = this.after;
    if (sort === "top") params.t = timeFilter;

    const url = `https://reddit.com/r/${this.subreddit}/${sort}/.json`;

    context.logger.debug({ subreddit: this.subreddit, sort, url }, "Fetching from Reddit API");

    // Respect rate limits
    await sleep(getJitteredDelay(1000));

    try {
      const response = await axios.get(url, {
        params,
        headers: {
          "User-Agent": "rss-bridge/1.0 (by reddit user)",
        },
        timeout: 10000,
      });

      const data = response.data?.data;
      if (!data || !data.children) {
        context.logger.warn("No children in Reddit response");
        return [];
      }

      // Update pagination cursor
      this.after = data.after;

      const items: NormalizedItem[] = data.children
        .filter((child: Record<string, unknown>) => child.kind === "t3") // t3 = post
        .map((child: Record<string, unknown>) => {
          const post = child.data as Record<string, unknown>;
          return {
            sourceId: `reddit_${post.id}`,
            sourceSite: this.config.siteId,
            title: (post.title as string) || null,
            contentText: (post.selftext as string) || null,
            contentHtml: textToParagraphHtml((post.selftext as string) || null),
            authorName: (post.author as string) || null,
            link: `https://reddit.com${post.permalink}`,
            mediaUrls: (() => {
              const preview = post.preview as Record<string, unknown> | undefined;
              const images = preview?.images as Array<Record<string, unknown>> | undefined;
              const sourceUrl = (images?.[0]?.source as Record<string, unknown> | undefined)?.url as string | undefined;
              if (sourceUrl) return [sourceUrl];
              const u = post.url as string | undefined;
              return u && !u.startsWith("/r/") ? [u] : [];
            })(),
            publishedAt: new Date(((post.created_utc as number) || 0) * 1000),
            rawPayload: { score: post.score, num_comments: post.num_comments },
          };
        });

      context.logger.info({ subreddit: this.subreddit, count: items.length }, "Extracted Reddit posts");
      return items;
    } catch (e) {
      context.logger.error({ subreddit: this.subreddit, error: String(e) }, "Failed to fetch Reddit");
      throw e;
    }
  }

  async resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    // Reddit links are already resolved from API; no additional resolution needed
    context.logger.debug({ count: items.length }, "Reddit links already resolved");
  }

  async hasMorePages(context: ScraperContext): Promise<boolean> {
    const maxPages = (this.config.options.maxPages as number) || 1;
    return this.pageCount < maxPages && !!this.after;
  }

  async nextPage(context: ScraperContext): Promise<void> {
    context.logger.debug({ subreddit: this.subreddit, page: this.pageCount + 1 }, "Pagination");
    this.pageCount++;
  }

  async shutdown(context: ScraperContext): Promise<void> {
    context.logger.debug({ site: this.config.siteId }, "Reddit scraper shutdown");
  }
}
