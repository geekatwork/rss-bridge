import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  scheduleMock,
  validateMock,
  ensureGroupMock,
  getLatestScrapedSourcePostIdMock,
  pruneFacebookPostsMock,
  upsertItemsMock,
  engineInitMock,
  engineRegisterSiteMock,
  engineScrapeOneMock,
  engineShutdownMock,
} = vi.hoisted(() => ({
  scheduleMock: vi.fn(),
  validateMock: vi.fn(),
  ensureGroupMock: vi.fn(),
  getLatestScrapedSourcePostIdMock: vi.fn(),
  pruneFacebookPostsMock: vi.fn(),
  upsertItemsMock: vi.fn(),
  engineInitMock: vi.fn(),
  engineRegisterSiteMock: vi.fn(),
  engineScrapeOneMock: vi.fn(),
  engineShutdownMock: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: scheduleMock,
    validate: validateMock,
  },
}));

vi.mock("./db.js", () => ({
  ensureGroup: ensureGroupMock,
  getLatestScrapedSourcePostId: getLatestScrapedSourcePostIdMock,
  pruneFacebookPosts: pruneFacebookPostsMock,
  upsertItems: upsertItemsMock,
}));

vi.mock("./ScrapeEngine.js", () => ({
  ScrapeEngine: class {
    init = engineInitMock;
    registerSite = engineRegisterSiteMock;
    scrapeOne = engineScrapeOneMock;
    shutdown = engineShutdownMock;
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("scraper index startup", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    process.env = { ...originalEnv };
    delete process.env.SCRAPE_GROUPS;
    delete process.env.SCRAPE_SCHEDULE;
    delete process.env.PRUNE_SCHEDULE;
    delete process.env.PRUNE_RETENTION_DAYS;
    delete process.env.SOURCE_COOKIE_FILE;

    vi.spyOn(global, "setTimeout").mockImplementation((cb: (...args: any[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    ensureGroupMock.mockResolvedValue(101);
    getLatestScrapedSourcePostIdMock.mockResolvedValue(null);
    engineInitMock.mockResolvedValue(undefined);
    engineRegisterSiteMock.mockReturnValue(undefined);
    engineScrapeOneMock.mockResolvedValue({
      site: "facebook",
      jobId: "job-1",
      items: [
        {
          sourceId: "post-1",
          sourceSite: "facebook",
          title: "t",
          contentText: "c",
          contentHtml: "<p>c</p>",
          authorName: "a",
          link: "https://example.com/post/1",
          mediaUrls: [],
          publishedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      errors: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 1,
      linksResolved: 1,
      linksResolveFailed: 0,
    });
    engineShutdownMock.mockResolvedValue(undefined);
    upsertItemsMock.mockResolvedValue(1);
    pruneFacebookPostsMock.mockResolvedValue(0);
    validateMock.mockReturnValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("parses group config, infers siteId from URL, and runs initial scrape", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        sourceId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);

    await import("./index.js");
    await flush();
    await flush();

    expect(ensureGroupMock).toHaveBeenCalledWith({
      groupId: "12345",
      siteId: "facebook",
      name: "My Group",
      url: "https://www.facebook.com/groups/12345",
    });

    expect(engineRegisterSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "facebook",
        name: "My Group",
        enabled: true,
        options: expect.objectContaining({
          groupIds: ["12345"],
        }),
      })
    );

    expect(engineScrapeOneMock).toHaveBeenCalledWith("facebook");
    expect(upsertItemsMock).toHaveBeenCalledWith(101, expect.any(Array));
    expect(scheduleMock).toHaveBeenCalledWith("0 */2 * * *", expect.any(Function));
    expect(scheduleMock).toHaveBeenCalledWith("0 3 * * *", expect.any(Function));
  });

  it("uses explicit siteId and id fallback, and does not upsert when no items", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        id: "abc",
        siteId: "reddit",
        name: "TS Subreddit",
        url: "https://reddit.com/r/typescript",
      },
    ]);

    engineScrapeOneMock.mockResolvedValueOnce({
      site: "reddit",
      jobId: "job-2",
      items: [],
      errors: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 0,
      linksResolved: 0,
      linksResolveFailed: 0,
    });

    await import("./index.js");
    await flush();
    await flush();

    expect(ensureGroupMock).toHaveBeenCalledWith({
      groupId: "abc",
      siteId: "reddit",
      name: "TS Subreddit",
      url: "https://reddit.com/r/typescript",
    });

    expect(engineRegisterSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "reddit",
        options: expect.objectContaining({
          groupIds: ["abc"],
        }),
      })
    );

    expect(upsertItemsMock).not.toHaveBeenCalled();
  });

  it("uses custom schedule when configured", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    process.env.SCRAPE_SCHEDULE = "*/15 * * * *";

    await import("./index.js");
    await flush();

    expect(scheduleMock).toHaveBeenCalledWith("*/15 * * * *", expect.any(Function));
  });

  it("runs competitions-nz on default schedule when no per-group schedule is set", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        siteId: "facebook",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
      {
        groupId: "comp-nz",
        siteId: "competitions-nz",
        name: "Competitions NZ",
        url: "https://www.competitions.co.nz/",
      },
    ]);
    process.env.SCRAPE_SCHEDULE = "0 * * * *";

    await import("./index.js");
    await flush();

    expect(scheduleMock).toHaveBeenCalledWith("0 * * * *", expect.any(Function));
    expect(scheduleMock).toHaveBeenCalledWith("0 3 * * *", expect.any(Function));
  });

  it("passes DB boundary marker to facebook scraper config", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    getLatestScrapedSourcePostIdMock.mockResolvedValueOnce("fb_hash_boundary");

    await import("./index.js");
    await flush();
    await flush();

    expect(engineRegisterSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "facebook",
        options: expect.objectContaining({
          stopAtSourceId: "fb_hash_boundary",
          boundaryFallbackLimit: 50,
          maxCollectedPosts: 50,
        }),
      })
    );
  });

  it("uses custom prune settings when configured", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    process.env.PRUNE_SCHEDULE = "30 4 * * *";
    process.env.PRUNE_RETENTION_DAYS = "9";

    await import("./index.js");
    await flush();

    expect(scheduleMock).toHaveBeenCalledWith("30 4 * * *", expect.any(Function));

    const pruneCb = scheduleMock.mock.calls[1]?.[1] as (() => Promise<void>) | undefined;
    await pruneCb?.();

    expect(pruneFacebookPostsMock).toHaveBeenCalledWith(9);
  });

  it("exits when SCRAPE_GROUPS is missing", async () => {
    const exitError = new Error("process-exit");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitError;
    });

    await expect(import("./index.js")).rejects.toBe(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("throws when prune schedule is invalid", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    process.env.PRUNE_SCHEDULE = "not-a-cron";
    validateMock.mockImplementation((schedule: string) => schedule !== "not-a-cron");

    await expect(import("./index.js")).rejects.toThrow('Invalid prune schedule cron expression: "not-a-cron"');
  });

  it("skips overlapping scheduled runs", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);

    let resolveScrape: (() => void) | undefined;
    engineScrapeOneMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScrape = () =>
            resolve({
              site: "facebook",
              jobId: "job-overlap",
              items: [],
              errors: [],
              startedAt: new Date("2026-01-01T00:00:00.000Z"),
              completedAt: new Date("2026-01-01T00:00:01.000Z"),
              durationMs: 1000,
              itemsExtracted: 0,
              linksResolved: 0,
              linksResolveFailed: 0,
            });
        })
    );

    await import("./index.js");
    await flush();

    const scheduleCb = scheduleMock.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(scheduleCb).toBeTypeOf("function");
    scheduleCb?.();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping scheduled run because a scrape cycle is already in progress"));

    resolveScrape?.();
    await flush();
  });

  it("skips prune runs while a scrape cycle is in progress", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);

    let resolveScrape: (() => void) | undefined;
    engineScrapeOneMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScrape = () =>
            resolve({
              site: "facebook",
              jobId: "job-overlap-prune",
              items: [],
              errors: [],
              startedAt: new Date("2026-01-01T00:00:00.000Z"),
              completedAt: new Date("2026-01-01T00:00:01.000Z"),
              durationMs: 1000,
              itemsExtracted: 0,
              linksResolved: 0,
              linksResolveFailed: 0,
            });
        })
    );

    await import("./index.js");
    await flush();

    const pruneCb = scheduleMock.mock.calls[1]?.[1] as (() => Promise<void>) | undefined;
    await pruneCb?.();

    expect(pruneFacebookPostsMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping prune run because a scrape cycle is already in progress"));

    resolveScrape?.();
    await flush();
  });

  it("logs [ALERT] when auth failure is detected in scrape errors", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);

    engineScrapeOneMock.mockResolvedValueOnce({
      site: "facebook",
      jobId: "job-auth",
      items: [],
      errors: ["authentication failed: cookies expired"],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 0,
      linksResolved: 0,
      linksResolveFailed: 0,
    });

    await import("./index.js");
    await flush();
    await flush();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[ALERT]")
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("authentication")
    );
  });

  it("logs [ALERT] after two consecutive empty scrape runs", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);

    engineScrapeOneMock.mockResolvedValue({
      site: "facebook",
      jobId: "job-empty",
      items: [],
      errors: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      durationMs: 1000,
      itemsExtracted: 0,
      linksResolved: 0,
      linksResolveFailed: 0,
    });

    await import("./index.js");
    await flush();
    await flush();

    // After initial run: consecutiveEmptyRuns=1, no alert yet
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("[ALERT]"));

    // Trigger second run via cron callback
    const scheduleCb = scheduleMock.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
    await scheduleCb?.();

    // cron callback is sync; flush lets the async triggerRun settle
    await flush();
    await flush();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[ALERT]"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("2 consecutive run"));
  });

  it("logs pruned count when prune job succeeds", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    pruneFacebookPostsMock.mockResolvedValueOnce(5);

    await import("./index.js");
    await flush();

    const pruneCb = scheduleMock.mock.calls[1]?.[1] as (() => Promise<void>) | undefined;
    await pruneCb?.();

    expect(pruneFacebookPostsMock).toHaveBeenCalledWith(7); // default retention
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Pruned 5 Facebook post(s)")
    );
  });

  it("logs [ALERT] when prune job throws", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    pruneFacebookPostsMock.mockRejectedValueOnce(new Error("DB connection lost"));

    await import("./index.js");
    await flush();

    const pruneCb = scheduleMock.mock.calls[1]?.[1] as (() => Promise<void>) | undefined;
    await pruneCb?.();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[ALERT]")
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("retention may not be enforced")
    );
  });

  it("throws when default scrape schedule is invalid", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
      },
    ]);
    process.env.SCRAPE_SCHEDULE = "bad-schedule";
    validateMock.mockImplementation((s: string) => s !== "bad-schedule");

    await expect(import("./index.js")).rejects.toThrow(
      'Invalid default scrape schedule cron expression: "bad-schedule"'
    );
  });

  it("throws when a per-group schedule is invalid", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
        schedule: "bad-group-cron",
      },
    ]);
    validateMock.mockImplementation((s: string) => s !== "bad-group-cron");

    await expect(import("./index.js")).rejects.toThrow(
      'Invalid schedule for group My Group cron expression: "bad-group-cron"'
    );
  });

  it("wires a per-group explicit schedule to cron", async () => {
    process.env.SCRAPE_GROUPS = JSON.stringify([
      {
        groupId: "12345",
        name: "My Group",
        url: "https://www.facebook.com/groups/12345",
        schedule: "*/30 * * * *",
      },
    ]);

    await import("./index.js");
    await flush();

    expect(scheduleMock).toHaveBeenCalledWith("*/30 * * * *", expect.any(Function));
  });
});
