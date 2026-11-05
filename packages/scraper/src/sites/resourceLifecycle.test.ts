import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Browser } from "puppeteer";
import type { ScraperContext } from "../core/types.js";
import { ExampleScraper } from "./ExampleScraper.js";
import { FacebookScraper } from "./facebook/FacebookScraper.js";
import { CompetitionsNzScraper } from "./competitions-nz/CompetitionsNzScraper.js";

describe.each([ExampleScraper, FacebookScraper, CompetitionsNzScraper])("%s resource lifecycle", (Scraper) => {
  function setup(closed = false) {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const browserClose = vi.fn();
    const browser = { close: browserClose } as unknown as Browser;
    const context: ScraperContext = {
      browser, logger: pino({ enabled: false }), jobId: "cleanup", startedAt: new Date(), config: {},
    };
    const scraper = new Scraper({ siteId: "test", name: "test", enabled: true, options: {} });
    Object.defineProperty(scraper, "page", {
      value: { isClosed: () => closed, close }, writable: true,
    });
    return { scraper, context, close, browserClose };
  }

  it("closes only its own page once and tolerates repeated shutdown", async () => {
    const { scraper, context, close, browserClose } = setup();
    await scraper.shutdown(context);
    await scraper.shutdown(context);
    expect(close).toHaveBeenCalledTimes(1);
    expect(browserClose).not.toHaveBeenCalled();
  });

  it("tolerates a page already closed by deadline-driven engine cleanup", async () => {
    const { scraper, context, close } = setup(true);
    await scraper.shutdown(context);
    expect(close).not.toHaveBeenCalled();
  });

  it("detaches its page before a close failure and propagates that failure", async () => {
    const { scraper, context, close, browserClose } = setup();
    const error = new Error("Synthetic close failure");
    close.mockRejectedValue(error);
    await expect(scraper.shutdown(context)).rejects.toBe(error);
    await expect(scraper.shutdown(context)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browserClose).not.toHaveBeenCalled();
  });
});
