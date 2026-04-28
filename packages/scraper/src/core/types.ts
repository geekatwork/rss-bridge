import type { Browser, Page } from "puppeteer";
import type { Logger } from "pino";

/**
 * Normalized item schema used across all site scrapers.
 * Every site must extract data into this unified format before storage.
 */
export interface NormalizedItem {
  /** Unique ID per site and item (e.g., "facebook_1234" or "twitter_abc") */
  sourceId: string;
  /** Which site this came from (e.g., "facebook", "twitter", "reddit") */
  sourceSite: string;
  /** Human-readable title or first line of content */
  title: string | null;
  /** Plain text content */
  contentText: string | null;
  /** HTML-formatted content */
  contentHtml: string | null;
  /** Author/creator name */
  authorName: string | null;
  /** Direct link to the original item */
  link: string | null;
  /** Array of media URLs (images, videos) */
  mediaUrls: string[];
  /** When the item was published */
  publishedAt: Date;
  /** For deduplication: hash of key fields */
  contentHash?: string;
  /** Optional raw payload for debugging */
  rawPayload?: Record<string, unknown>;
}

/**
 * Context passed to all site scraper methods.
 * Provides browser, logging, configuration, and metadata.
 */
export interface ScraperContext {
  /** Puppeteer browser instance shared across all sites */
  browser: Browser;
  /** Current page if one is active */
  page?: Page;
  /** Structured logger (pino) */
  logger: Logger;
  /** Job ID for this run */
  jobId: string;
  /** Start time of this job */
  startedAt: Date;
  /** Site-specific configuration */
  config: Record<string, unknown>;
  /** Optional credentials, cookies, proxy settings */
  credentials?: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    proxyUrl?: string;
    userAgent?: string;
  };
  /** Timeout in ms for this job */
  timeoutMs?: number;
  /** Whether to retry on failure */
  retryOnFailure?: boolean;
  /** Max items to extract per run */
  maxItems?: number;
}

/**
 * Result of a scraper run for a single site.
 */
export interface ScrapeResult {
  site: string;
  jobId: string;
  items: NormalizedItem[];
  errors: string[];
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  itemsExtracted: number;
  linksResolved: number;
  linksResolveFailed: number;
}

/**
 * Configuration for a site source.
 */
export interface SiteConfig {
  /** Unique identifier for this site (e.g., "facebook", "twitter") */
  siteId: string;
  /** Human-readable name */
  name: string;
  /** Whether this site is enabled */
  enabled: boolean;
  /** Site-specific options (selectors, endpoints, etc.) */
  options: Record<string, unknown>;
  /** Rate limits and timing */
  rateLimit?: {
    requestsPerMinute?: number;
    delayMs?: number;
  };
  /** Retry policy */
  retry?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
  };
}
