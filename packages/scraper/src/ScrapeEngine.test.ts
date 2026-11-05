import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as setNodeTimeout } from "node:timers";
import type { ScrapeResult, ScraperContext, SiteConfig } from "./core/types.js";

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
import { ScraperConfigurationError, ScraperStateError } from "./core/errors.js";

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

  it("distinguishes invalid engine state from unregistered site configuration", async () => {
    const engine = new ScrapeEngine();
    await expect(engine.scrapeOne("missing")).rejects.toBeInstanceOf(ScraperStateError);
    await engine.init();
    await expect(engine.scrapeOne("missing")).rejects.toBeInstanceOf(ScraperConfigurationError);
    await engine.shutdown();
  });

  it("scrapeAll reports unusual thrown values without serializing payloads", async () => {
    const engine = new ScrapeEngine();
    await engine.init();
    engine.registerSite(enabledConfig("facebook"));
    scraperRunMock.mockRejectedValue(Object.create(null));
    const results = await engine.scrapeAll();
    expect(results[0].errors).toEqual(["Unknown thrown object"]);
    expect(logger.error).toHaveBeenCalledWith(
      { siteId: "facebook", error: "Unknown thrown object" }, "Scrape job failed",
    );
    await engine.shutdown();
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

    const signal = new AbortController().signal;
    const result = await engine.scrapeOne("facebook", signal);

    expect(registryGetMock).toHaveBeenCalledWith("facebook", expect.objectContaining({ siteId: "facebook" }));
    expect(scraperRunMock).toHaveBeenCalledTimes(1);
    expect(scraperRunMock.mock.calls[0]?.[0]).toMatchObject({ signal });
    expect(result.site).toBe("facebook");
  });

  it.each([
    ["facebook", "facebook"],
    ["facebook", "reddit"],
  ])("isolates overlapping %s/%s jobs on separate engines", async (firstSite, secondSite) => {
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const firstBrowser = { close: firstClose };
    const secondBrowser = { close: secondClose };
    launchMock.mockResolvedValueOnce(firstBrowser).mockResolvedValueOnce(secondBrowser);
    const contexts: ScraperContext[] = [];
    const releases: Array<() => void> = [];
    registryGetMock.mockImplementation((siteId: string, config: SiteConfig) => ({
      run: async (context: ScraperContext): Promise<ScrapeResult> => {
        contexts.push(context);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        context.signal?.throwIfAborted();
        return {
          site: siteId, jobId: context.jobId, errors: [],
          items: [{
            sourceId: String(config.options.groupId), sourceSite: siteId,
            title: null, contentText: null, contentHtml: null, authorName: null,
            link: `https://example.test/${config.options.groupId}`, mediaUrls: [],
            publishedAt: new Date(),
          }],
          startedAt: context.startedAt, completedAt: new Date(), durationMs: 1,
          itemsExtracted: 1, linksResolved: 0, linksResolveFailed: 0,
        };
      },
    }));
    const first = new ScrapeEngine();
    const second = new ScrapeEngine();
    await Promise.all([first.init(), second.init()]);
    first.registerSite({ ...enabledConfig(firstSite), options: { groupId: "first" } });
    second.registerSite({ ...enabledConfig(secondSite), options: { groupId: "second" } });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRun = first.scrapeOne(firstSite, firstController.signal);
    const secondRun = second.scrapeOne(secondSite, secondController.signal);
    const failure = new Error("First job cancelled");
    const firstRejected = expect(firstRun).rejects.toBe(failure);
    try {
      // Both jobs reached their barrier before either was released.
      expect(contexts).toHaveLength(2);
      expect(contexts[0].browser).toBe(firstBrowser);
      expect(contexts[1].browser).toBe(secondBrowser);
      expect(contexts[0].jobId).not.toBe(contexts[1].jobId);
      expect(contexts[0].config).toEqual({ groupId: "first" });
      expect(contexts[1].config).toEqual({ groupId: "second" });
      firstController.abort(failure);
      releases[0]();
      await firstRejected;
      await first.shutdown();
      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(secondClose).not.toHaveBeenCalled();
      expect(secondController.signal.aborted).toBe(false);
      releases[1]();
      const result = await secondRun;
      expect(result.jobId).toBe(contexts[1].jobId);
      expect(result.items.map((item) => item.sourceId)).toEqual(["second"]);
      expect(result.errors).toEqual([]);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([firstRun, secondRun]);
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
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

  it("closes the browser if shutdown is requested during initialization", async () => {
    let finishLaunch: ((browser: { close: typeof browserCloseMock }) => void) | undefined;
    launchMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishLaunch = resolve;
    }));
    const engine = new ScrapeEngine();
    const init = engine.init();
    await engine.shutdown();
    finishLaunch?.({ close: browserCloseMock });

    await expect(init).rejects.toThrow("shutdown requested during initialization");
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });

  it("logs and rethrows browser close failures", async () => {
    const closeError = new Error("browser close failed");
    browserCloseMock.mockRejectedValueOnce(closeError);
    const engine = new ScrapeEngine();
    await engine.init();

    await expect(engine.shutdown()).rejects.toThrow(closeError);
    expect(logger.error).toHaveBeenCalledWith(
      { error: closeError.message },
      "Failed to close browser during shutdown"
    );
  });

  it("shares an in-progress browser close between concurrent shutdown calls", async () => {
    let finishClose: (() => void) | undefined;
    browserCloseMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishClose = resolve;
    }));
    const engine = new ScrapeEngine();
    await engine.init();

    const firstShutdown = engine.shutdown();
    const secondShutdown = engine.shutdown();
    await Promise.resolve();
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
    finishClose?.();
    await Promise.all([firstShutdown, secondShutdown]);
  });
});
