import { beforeEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer";
import pino from "pino";
import axios from "axios";
import { buildSourceConfig, parseGroups } from "./sourceConfig.js";
import { globalRegistry, type ScraperContext } from "./core/index.js";
import { registerAllScrapers } from "./sites/index.js";

const { page } = vi.hoisted(() => ({
  page: {
    goto: vi.fn(), setViewport: vi.fn(), setUserAgent: vi.fn(),
    evaluateOnNewDocument: vi.fn(), evaluate: vi.fn(),
    cookies: vi.fn(), setCookie: vi.fn(), waitForSelector: vi.fn(),
    evaluateHandle: vi.fn(), url: vi.fn(), title: vi.fn(),
    isClosed: vi.fn(() => false), close: vi.fn(),
  },
}));
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => ({ newPage: async () => page, close: vi.fn() })) } }));
vi.mock("./core/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./core/utils.js")>();
  return { ...original, sleep: vi.fn(async () => undefined) };
});
vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return { ...original, existsSync: vi.fn(() => false) };
});
vi.mock("axios", () => ({ default: { get: vi.fn() } }));

describe("scheduled config to real plugin listing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page.cookies.mockResolvedValue([]);
    page.title.mockResolvedValue("Group");
    page.evaluateHandle.mockResolvedValue({ asElement: () => null, dispose: vi.fn() });
    registerAllScrapers();
  });

  it.each([
    { groupId: "123", siteId: "facebook", name: "Facebook", url: "https://mbasic.facebook.com/groups/123/?ref=feed", expected: "https://mbasic.facebook.com/groups/123/?ref=feed&sorting_setting=CHRONOLOGICAL" },
    { groupId: "c", siteId: "competitions-nz", name: "Competitions", url: "https://www.competitions.co.nz/category/new/", expected: "https://www.competitions.co.nz/category/new/" },
    { groupId: "e", siteId: "example-site", name: "Example", url: "http://fixture:8080/listing/", expected: "http://fixture:8080/listing/" },
  ])("$siteId navigates to the configured source via its actual plugin", async ({ expected, ...input }) => {
    const [group] = parseGroups(JSON.stringify([input]));
    const config = buildSourceConfig(group, null, {});
    const scraper = globalRegistry.get(config.siteId, config);
    const context: ScraperContext = {
      browser: await puppeteer.launch(), logger: pino({ enabled: false }),
      config: config.options, jobId: "integration", startedAt: new Date(),
    };
    page.url.mockReturnValue(expected);
    page.evaluate.mockResolvedValue({ hasSortControl: true, hasCompetitionCards: true });
    await scraper.init(context);
    await scraper.fetchListing(context);
    expect(page.goto).toHaveBeenCalledWith(expected, expect.any(Object));
    await scraper.shutdown(context);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("Reddit's real plugin consumes the derived subreddit and request options", async () => {
    const [group] = parseGroups(JSON.stringify([{
      groupId: "r", name: "Reddit", url: "https://reddit.com/r/typescript",
      options: { sort: "top", timeFilter: "month", limit: 75 },
    }]));
    const config = buildSourceConfig(group, null, {});
    const scraper = globalRegistry.get("reddit", config);
    const context: ScraperContext = {
      browser: await puppeteer.launch(), logger: pino({ enabled: false }),
      config: config.options, jobId: "integration", startedAt: new Date(),
    };
    await scraper.init(context);
    await expect(scraper.fetchListing(context)).resolves.toBeUndefined();
    expect(config.options.subreddits).toEqual(["typescript"]);
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { children: [], after: null } } });
    await expect(scraper.extractItems(context)).resolves.toEqual([]);
    expect(axios.get).toHaveBeenCalledWith("https://reddit.com/r/typescript/top/.json",
      expect.objectContaining({ params: { limit: 75, t: "month" } }));
    await scraper.shutdown(context);
  });
});
