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
  private siteConfigs: Map<string, SiteConfig> = new Map();

  constructor(logLevel: string = "info") {
    this.logger = pino({ level: logLevel });
    registerAllScrapers();
  }

  /**
   * Initialize the engine: launch browser.
   */
  async init(): Promise<void> {
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
  async scrapeOne(siteId: string): Promise<ScrapeResult> {
    if (!this.browser) throw new Error("Engine not initialized");

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
    if (this.browser) {
      await this.browser.close();
      this.logger.info("Browser closed");
    }
  }
}
