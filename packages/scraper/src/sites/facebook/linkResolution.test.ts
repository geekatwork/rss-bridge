import { readFileSync } from "fs";
import { resolve } from "path";
import { createServer, type Server } from "http";
import puppeteer, { type Browser, type Page } from "puppeteer";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FacebookScraper } from "./FacebookScraper.js";
import { findFacebookPost, type FacebookPostIdentity } from "./postIdentity.js";
import type { NormalizedItem, ScraperContext } from "../../core/types.js";

vi.mock("../../core/utils.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/utils.js")>(),
  sleep: async () => {},
}));

const groupUrl = "https://www.facebook.com/groups/123456789/";
const fixture = readFileSync(resolve(process.cwd(), "src/sites/facebook/test-fixtures/link-resolution.html"), "utf8");

describe("Facebook synthetic DOM link resolution", () => {
  let browser: Browser;
  let server: Server;
  let popupUrl: string;
  let page: Page;
  let scraper: FacebookScraper;
  let context: ScraperContext;
  let identity: FacebookPostIdentity;
  let item: NormalizedItem;
  let warnings: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    server = createServer((_request, response) => { response.end("<html><body>Synthetic popup</body></html>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic popup server has no TCP address");
    popupUrl = `http://127.0.0.1:${address.port}/photo.php?fbid=987654321`;
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  afterEach(async () => { await page?.close(); });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.respond({
        status: 200, contentType: request.resourceType() === "image" ? "image/svg+xml" : "text/html",
        body: request.resourceType() === "image"
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"></svg>'
          : fixture,
      });
    });
    await page.goto(groupUrl);
    identity = await page.$eval("#post-a", (el) => ({
      text: (el.textContent || "").trim(),
      mediaUrls: Array.from(el.querySelectorAll("img")).map((img) => img.getAttribute("src") || ""),
    }));
    const logger = pino({ enabled: false });
    warnings = vi.spyOn(logger, "warn");
    context = { browser, logger, jobId: "synthetic", startedAt: new Date(), config: {} };
    scraper = new FacebookScraper({
      siteId: "facebook", name: "Synthetic", enabled: true,
      options: { groupIds: ["123456789"], scrollAttempts: 1, maxCollectedPosts: 2 },
    });
    Object.defineProperty(scraper, "page", { value: page });
    Object.defineProperty(scraper, "groupId", { value: "123456789" });
    item = {
      sourceId: "fb_hash_synthetic", sourceSite: "facebook", title: null,
      contentText: identity.text, contentHtml: null, authorName: null,
      link: null, mediaUrls: identity.mediaUrls, publishedAt: new Date(),
      rawPayload: { identity, needsLinkResolve: true, candidateUrls: [] },
    };
  });

  it("finds the same post after reordering and ignores CDN query changes", async () => {
    await page.evaluate(() => {
      const post = document.getElementById("post-a")!;
      post.parentElement!.append(post);
      post.querySelector("img")!.src = "https://scontent.synthetic.fbcdn.net/post-a.png?token=two";
    });
    const handle = await page.evaluateHandle(findFacebookPost, identity);
    try {
      expect(await page.evaluate((el: HTMLElement | null) => el?.id, handle)).toBe("post-a");
    } finally { await handle.dispose(); }
  });

  it("rejects recycled content, changed media and ambiguous duplicates", async () => {
    await page.$eval("#post-a img", (img) => { img.setAttribute("src", "https://scontent.synthetic.fbcdn.net/other.png"); });
    let handle = await page.evaluateHandle(findFacebookPost, identity);
    expect(await page.evaluate((el: HTMLElement | null) => el === null, handle)).toBe(true);
    await handle.dispose();
    await page.setContent(fixture);
    await page.$eval("#post-a", (el) => { el.parentElement!.append(el.cloneNode(true)); });
    handle = await page.evaluateHandle(findFacebookPost, identity);
    expect(await page.evaluate((el: HTMLElement | null) => el === null, handle)).toBe(true);
    await handle.dispose();
    await page.setContent(fixture);
    await page.$eval("#post-a p", (el) => { el.textContent = "A recycled unrelated post"; });
    handle = await page.evaluateHandle(findFacebookPost, identity);
    expect(await page.evaluate((el: HTMLElement | null) => el === null, handle)).toBe(true);
    await handle.dispose();
  });

  it("initial extraction defers author fallback and prefers a later content href", async () => {
    let items = await scraper.extractItems(context);
    expect(items.find((row) => row.contentText?.includes("giveaway"))?.link).toBeNull();
    await page.$eval("#post-a", (el) => {
      const anchor = document.createElement("a");
      anchor.href = "/groups/123456789/posts/987654321/";
      anchor.textContent = "Synthetic post link";
      el.append(anchor);
    });
    items = await scraper.extractItems(context);
    expect(items.find((row) => row.contentText?.includes("giveaway"))?.link)
      .toBe("https://www.facebook.com/groups/123456789/permalink/987654321/");
  });

  it("keeps native clicks and accepts a group permalink after DOM reordering", async () => {
    await page.evaluate(() => {
      const post = document.getElementById("post-a")!;
      post.parentElement!.append(post);
      post.querySelector("[data-action-id]")!.addEventListener("click", () => {
        location.href = "/groups/123456789/posts/987654321/";
      });
    });
    await scraper.resolveLinks(context, [item]);
    expect(warnings.mock.calls).toEqual([]);
    expect(item.link).toBe("https://www.facebook.com/groups/123456789/permalink/987654321/");
    expect(page.url()).toBe(groupUrl);
    expect(browser.listenerCount("targetcreated")).toBe(0);
  }, 20000);

  it("does not click another post when the captured element is recycled", async () => {
    await page.$eval("#post-a p", (el) => { el.textContent = "An unrelated recycled post"; });
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(item.mediaUrls).toEqual(identity.mediaUrls);
    expect(page.url()).toBe(groupUrl);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.sourceId }), expect.stringContaining("identity"),
    );
  });

  it("blocks a post recycled during native pointer events", async () => {
    await page.$eval("#post-a", (el) => {
      el.addEventListener("pointerdown", () => {
        el.querySelector("p")!.textContent = "A newly recycled post";
      });
      el.addEventListener("click", () => { location.href = "/groups/123456789/posts/111111111/"; });
    });
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(item.mediaUrls).toEqual(identity.mediaUrls);
    expect(page.url()).toBe(groupUrl);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.sourceId }), expect.stringContaining("blocked"),
    );
    expect(browser.listenerCount("targetcreated")).toBe(0);
  });

  it("preserves query parameters from a clicked popup and closes only that popup", async () => {
    const unrelated = await browser.newPage();
    try {
      await page.bringToFront();
      await page.$eval("#post-a", (el, url) => {
        el.addEventListener("click", () => {
          window.open(url, "_blank");
        });
      }, popupUrl);
      await scraper.resolveLinks(context, [item]);
      expect(item.link).toBe(popupUrl);
      expect(unrelated.isClosed()).toBe(false);
      expect(browser.listenerCount("targetcreated")).toBe(0);
    } finally { await unrelated.close(); }
  }, 20000);

  it("retains image-only content as unresolved instead of using author or first-image fallback", async () => {
    item.rawPayload!.needsLinkResolve = false;
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(item.mediaUrls).toEqual(identity.mediaUrls);
    expect(item.contentText).toBe(identity.text);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.sourceId, reason: "no_verified_content_destination" }),
      expect.stringContaining("unresolved"),
    );
  });

  it("rejects an in-page CDN destination and returns to the group", async () => {
    await page.$eval("#post-a", (el) => {
      el.addEventListener("click", () => {
        location.href = "https://scontent.synthetic.fbcdn.net/v/t39.30808-6/image.jpg?token=private";
      });
    });
    const debug = vi.spyOn(context.logger, "debug");
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(item.mediaUrls).toEqual(identity.mediaUrls);
    expect(page.url()).toBe(groupUrl);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "social_media_asset" }),
      "Ignoring non-content in-page destination",
    );
    expect(JSON.stringify([...debug.mock.calls, ...warnings.mock.calls])).not.toContain("token=private");
    expect(browser.listenerCount("targetcreated")).toBe(0);
  }, 20000);

  it("rejects a CDN popup destination without closing unrelated pages", async () => {
    const unrelated = await browser.newPage();
    try {
      await page.bringToFront();
      const popupTarget = new Promise<import("puppeteer").Target>((resolve) => {
        browser.once("targetcreated", resolve);
      });
      await page.$eval("#post-a", (el) => {
        el.addEventListener("click", () => {
          window.open("about:blank", "_blank");
        });
      });
      const debug = vi.spyOn(context.logger, "debug");
      const resolving = scraper.resolveLinks(context, [item]);
      const popup = await (await popupTarget).page();
      if (!popup) throw new Error("Synthetic popup page missing");
      await popup.setRequestInterception(true);
      popup.on("request", (request) => {
        void request.respond({ status: 200, contentType: "text/html", body: "<html>Synthetic CDN asset</html>" });
      });
      await popup.goto("https://scontent.synthetic.cdninstagram.com/image.jpg?token=private", { waitUntil: "domcontentloaded" });
      await resolving;
      expect(item.link).toBeNull();
      expect(item.mediaUrls).toEqual(identity.mediaUrls);
      expect(unrelated.isClosed()).toBe(false);
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "social_media_asset" }),
        "Ignoring non-content popup destination",
      );
      expect(browser.listenerCount("targetcreated")).toBe(0);
    } finally { await unrelated.close(); }
  }, 20000);

  it("clears a previously extracted CDN link before verified resolution", async () => {
    item.link = identity.mediaUrls[0];
    item.rawPayload!.needsLinkResolve = false;
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(item.mediaUrls).toEqual(identity.mediaUrls);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "social_media_asset" }), "Rejected media asset post destination",
    );
  });
});
