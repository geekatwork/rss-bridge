import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeResult, SiteConfig } from "./core/types.js";

const {
  launchMock,
  registerAllScrapersMock,
  registryGetMock,
  scraperRunMock,
  browserCloseMock,
  logger,
} = vi.hoisted(() => {
  const loggerMock = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  loggerMock.child.mockReturnValue(loggerMock);

  return {
    launchMock: vi.fn(),
    registerAllScrapersMock: vi.fn(),
    registryGetMock: vi.fn(),
    scraperRunMock: vi.fn(),
    browserCloseMock: vi.fn(),
    logger: loggerMock,
  };
});

vi.mock("puppeteer", () => ({
  default: {
    launch: launchMock,
  },
}));

vi.mock("pino", () => ({
  default: vi.fn(() => logger),
}));

vi.mock("./sites/index.js", () => ({
  registerAllScrapers: registerAllScrapersMock,
}));

vi.mock("./core/index.js", () => ({
  globalRegistry: {
    get: registryGetMock,
  },
}));

import { ScrapeEngine } from "./ScrapeEngine.js";

describe("ScrapeEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logger.child.mockReturnValue(logger);
    launchMock.mockResolvedValue({ close: browserCloseMock });
    scraperRunMock.mockResolvedValue({
      site: "facebook",
      jobId: "job-1",
      items: [],
      errors: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 0,
      linksResolved: 0,
      linksResolveFailed: 0,
    } satisfies ScrapeResult);
    registryGetMock.mockReturnValue({ run: scraperRunMock });
  });

  function enabledConfig(siteId: string): SiteConfig {
    return {
      siteId,
      name: siteId,
      enabled: true,
      options: {},
    };
  }

  it("registers all scrapers in constructor", () => {
    new ScrapeEngine();
    expect(registerAllScrapersMock).toHaveBeenCalledTimes(1);
  });

  it("initializes browser via puppeteer", async () => {
    const engine = new ScrapeEngine();
    await engine.init();

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0]?.[0]).toMatchObject({
      headless: true,
    });
  });

  it("throws when scrapeOne runs before init", async () => {
    const engine = new ScrapeEngine();
    engine.registerSite(enabledConfig("facebook"));

    await expect(engine.scrapeOne("facebook")).rejects.toThrow("Engine not initialized");
  });

  it("returns disabled result for disabled sites", async () => {
    const engine = new ScrapeEngine();
    await engine.init();

    engine.registerSite({
      siteId: "facebook",
      name: "Facebook",
      enabled: false,
      options: {},
    });

    const result = await engine.scrapeOne("facebook");

    expect(result.itemsExtracted).toBe(0);
    expect(result.errors).toEqual(["Site disabled"]);
    expect(registryGetMock).not.toHaveBeenCalled();
  });

  it("runs scraper via registry for enabled site", async () => {
    const engine = new ScrapeEngine();
    await engine.init();
    engine.registerSite(enabledConfig("facebook"));

    const result = await engine.scrapeOne("facebook");

    expect(registryGetMock).toHaveBeenCalledWith("facebook", expect.objectContaining({ siteId: "facebook" }));
    expect(scraperRunMock).toHaveBeenCalledTimes(1);
    expect(result.site).toBe("facebook");
  });

  it("scrapeAll collects failures and continues", async () => {
    const engine = new ScrapeEngine();
    await engine.init();

    engine.registerSite(enabledConfig("facebook"));
    engine.registerSite(enabledConfig("reddit"));

    scraperRunMock.mockResolvedValueOnce({
      site: "facebook",
      jobId: "job-ok",
      items: [],
      errors: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 0,
      linksResolved: 0,
      linksResolveFailed: 0,
    } satisfies ScrapeResult);
    scraperRunMock.mockRejectedValueOnce(new Error("boom"));

    const results = await engine.scrapeAll();

    expect(results).toHaveLength(2);
    expect(results[0].errors).toEqual([]);
    expect(results[1].errors[0]).toContain("boom");
  });

  it("shutdown closes browser", async () => {
    const engine = new ScrapeEngine();
    await engine.init();

    await engine.shutdown();

    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });
});
