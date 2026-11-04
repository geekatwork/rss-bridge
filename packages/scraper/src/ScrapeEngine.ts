import puppeteer, { Browser } from "puppeteer";
import pino from "pino";
import { randomUUID } from "crypto";
import { globalRegistry, type ScrapeResult, type ScraperContext, type SiteConfig } from "./core/index.js";
import { registerAllScrapers } from "./sites/index.js";

/**
 * ScrapeEngine: Orchestrates site scraper jobs.
 *
 * Manages:
 * - Browser lifecycle (launch/shutdown)
 * - Job queuing and execution
 * - Site registration
 * - Logging and metrics
 */
export class ScrapeEngine {
  private logger: pino.Logger;
  private browser?: Browser;
  private browserClosePromise?: Promise<void>;
  private shutdownRequested = false;
  private siteConfigs: Map<string, SiteConfig> = new Map();

  constructor(logLevel: string = "info") {
    this.logger = pino({ level: logLevel });
    registerAllScrapers();
  }

  /**
   * Initialize the engine: launch browser.
   */
  async init(signal?: AbortSignal): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error("Cannot initialize ScrapeEngine after shutdown was requested");
    }
    signal?.throwIfAborted();
    this.logger.info("Initializing ScrapeEngine");
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    if (signal?.aborted || this.shutdownRequested) {
      await this.shutdown();
      signal?.throwIfAborted();
      throw new Error("ScrapeEngine shutdown requested during initialization");
    }
    this.logger.info("Browser launched");
  }

  /**
   * Register a site configuration.
   */
  registerSite(config: SiteConfig): void {
    this.siteConfigs.set(config.siteId, config);
    this.logger.info({ siteId: config.siteId }, "Site registered");
  }

  /**
   * Run a scrape job for a specific site.
   */
  async scrapeOne(siteId: string, signal?: AbortSignal): Promise<ScrapeResult> {
    if (!this.browser) throw new Error("Engine not initialized");
    signal?.throwIfAborted();

    const config = this.siteConfigs.get(siteId);
    if (!config) throw new Error(`Site not registered: ${siteId}`);

    if (!config.enabled) {
      this.logger.info({ siteId }, "Site disabled; skipping");
      return {
        site: siteId,
        jobId: randomUUID(),
        items: [],
        errors: ["Site disabled"],
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 0,
        itemsExtracted: 0,
        linksResolved: 0,
        linksResolveFailed: 0,
      };
    }

    const scraper = globalRegistry.get(siteId, config);
    const context: ScraperContext = {
      browser: this.browser,
      signal,
      logger: this.logger.child({ siteId }),
      jobId: randomUUID(),
      startedAt: new Date(),
      config: config.options,
      credentials: {
        cookies: {},
        headers: { "User-Agent": "rss-bridge/1.0" },
      },
      maxItems: config.options.maxItems as number | undefined,
    };

    this.logger.info({ siteId, jobId: context.jobId }, "Starting scrape job");
    const result = await scraper.run(context);

    this.logger.info(
      {
        siteId,
        jobId: context.jobId,
        itemsExtracted: result.itemsExtracted,
        linksResolved: result.linksResolved,
        durationMs: result.durationMs,
        errors: result.errors.length,
      },
      "Scrape job completed"
    );

    return result;
  }

  /**
   * Run scrape jobs for all enabled sites.
   */
  async scrapeAll(): Promise<ScrapeResult[]> {
    const results: ScrapeResult[] = [];
    for (const [siteId] of this.siteConfigs) {
      try {
        const result = await this.scrapeOne(siteId);
        results.push(result);
      } catch (e) {
        this.logger.error({ siteId, error: String(e) }, "Scrape job failed");
        results.push({
          site: siteId,
          jobId: randomUUID(),
          items: [],
          errors: [String(e)],
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 0,
          itemsExtracted: 0,
          linksResolved: 0,
          linksResolveFailed: 0,
        });
      }
    }
    return results;
  }

  /**
   * Shutdown: close browser.
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.browserClosePromise) return this.browserClosePromise;
    const browser = this.browser;
    this.browser = undefined;
    if (!browser) return;

    this.browserClosePromise = Promise.resolve().then(() => browser.close()).then(() => {
      this.logger.info("Browser closed");
    }).catch((error: unknown) => {
      this.logger.error({ error }, "Failed to close browser during shutdown");
      throw error;
    });
    return this.browserClosePromise;
  }
}
