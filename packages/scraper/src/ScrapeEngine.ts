import puppeteer, { Browser } from "puppeteer";
import pino from "pino";
import { randomUUID } from "crypto";
import { globalRegistry, type ScrapeResult, type ScraperContext, type SiteConfig } from "./core/index.js";
import { registerAllScrapers } from "./sites/index.js";
import { ScraperConfigurationError, ScraperStateError, scraperErrorMessage } from "./core/errors.js";

/**
 * ScrapeEngine: Orchestrates site scraper jobs.
 *
 * Manages:
 * - Browser lifecycle (launch/shutdown)
 * - Job queuing and execution
 * - Site registration
 * - Logging and metrics
 *
 * Scheduled groups each use a fresh engine and run serially. Custom parallel
 * groups should use separate engines; one engine shares browser cookie state,
 * and shutdown aborts all work using that browser. Do not overlap init calls.
 */
export class ScrapeEngine {
  private logger: pino.Logger;
  private browser?: Browser;
  private browserClosePromise?: Promise<void>;
  private shutdownRequested = false;
  private siteConfigs: Map<string, SiteConfig> = new Map();

  constructor(logLevel: string = "info", bindings: { runId?: string; groupId?: string; siteId?: string } = {}) {
    this.logger = pino({ level: logLevel }).child(bindings);
    registerAllScrapers();
  }

  /**
   * Initialize the engine: launch browser.
   */
  async init(signal?: AbortSignal): Promise<void> {
    if (this.shutdownRequested) {
      throw new ScraperStateError("Cannot initialize ScrapeEngine after shutdown was requested");
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
      throw new ScraperStateError("ScrapeEngine shutdown requested during initialization");
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
    if (!this.browser) throw new ScraperStateError("Engine not initialized");
    signal?.throwIfAborted();

    const config = this.siteConfigs.get(siteId);
    if (!config) throw new ScraperConfigurationError(`Site not registered: ${siteId}`);

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

    const jobId = randomUUID();
    const jobLogger = this.logger.child({ siteId, jobId });
    const scraper = globalRegistry.get(siteId, config);
    const context: ScraperContext = {
      browser: this.browser,
      signal,
      logger: jobLogger,
      jobId,
      startedAt: new Date(),
      config: config.options,
      credentials: {
        cookies: {},
        headers: { "User-Agent": "rss-bridge/1.0" },
      },
      maxItems: config.options.maxItems as number | undefined,
    };

    jobLogger.info({ siteId, jobId: context.jobId }, "Starting scrape job");
    const result = await scraper.run(context);

    jobLogger.info(
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
   * Sequential, not Promise.all; a fresh plugin/context is created for each job.
   */
  async scrapeAll(): Promise<ScrapeResult[]> {
    const results: ScrapeResult[] = [];
    for (const [siteId] of this.siteConfigs) {
      try {
        const result = await this.scrapeOne(siteId);
        results.push(result);
      } catch (e) {
        const message = scraperErrorMessage(e);
        this.logger.error({ siteId, error: message }, "Scrape job failed");
        results.push({
          site: siteId,
          jobId: randomUUID(),
          items: [],
          errors: [message],
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
      this.logger.error({ error: scraperErrorMessage(error) }, "Failed to close browser during shutdown");
      throw error;
    });
    return this.browserClosePromise;
  }
}
