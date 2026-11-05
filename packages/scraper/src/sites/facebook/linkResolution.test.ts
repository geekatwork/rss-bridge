import { readFileSync } from "fs";
import { resolve } from "path";
import { createServer, type Server } from "http";
import puppeteer, { type Browser, type Page } from "puppeteer";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FacebookScraper } from "./FacebookScraper.js";
import { findFacebookPost, type FacebookPostIdentity } from "./postIdentity.js";
import { selectFacebookPosts } from "./postScope.js";
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
  async function findPost() {
    const scope = await page.evaluateHandle(selectFacebookPosts);
    try { return await scope.evaluateHandle(findFacebookPost, identity); }
    finally { await scope.dispose(); }
  }

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
    const handle = await findPost();
    try {
      expect(await page.evaluate((el: HTMLElement | null) => el?.id, handle)).toBe("post-a");
    } finally { await handle.dispose(); }
  });

  it("rejects recycled content, changed media and ambiguous duplicates", async () => {
    await page.$eval("#post-a img", (img) => { img.setAttribute("src", "https://scontent.synthetic.fbcdn.net/other.png"); });
    let handle = await findPost();
    expect(await page.evaluate((el: HTMLElement | null) => el === null, handle)).toBe(true);
    await handle.dispose();
    await page.setContent(fixture);
    await page.$eval("#post-a", (el) => { el.parentElement!.append(el.cloneNode(true)); });
    handle = await findPost();
    expect(await page.evaluate((el: HTMLElement | null) => el === null, handle)).toBe(true);
    await handle.dispose();
    await page.setContent(fixture);
    await page.$eval("#post-a p", (el) => { el.textContent = "A recycled unrelated post"; });
    handle = await findPost();
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

    it("splits adjacent story cards inside a wrapper without borrowing a neighboring photo", async () => {
      await page.evaluate(() => {
        const feed = document.getElementById("feed")!;
        const wrapper = document.createElement("div");
        wrapper.append(...Array.from(feed.children));
        feed.append(wrapper);
        const link = document.createElement("a");
        link.href = "/photo.php?fbid=987654321";
        link.textContent = "Different giveaway photo";
        document.getElementById("post-b")!.append(link);
      });
      const items = await scraper.extractItems(context);
      expect(items).toHaveLength(2);
      const first = items.find(row => row.contentText?.includes("giveaway description"))!;
      const second = items.find(row => row.contentText?.includes("different synthetic post"))!;
      expect(first.link).toBeNull();
      expect(first.contentText).not.toContain("Different giveaway photo");
      expect(first.mediaUrls).toHaveLength(1);
      expect(second.link).toBe("https://www.facebook.com/photo.php?fbid=987654321");
      first.rawPayload!.needsLinkResolve = false;
      await scraper.resolveLinks(context, [first]);
      expect(first.link).toBeNull();
      const handle = await findPost();
      expect(await page.evaluate(el => el?.id, handle)).toBe("post-a");
      await handle.dispose();
    });

    it("skips nested shared stories rather than associating an inner photo with outer text", async () => {
      await page.evaluate(() => {
        const outer = document.getElementById("post-a")!;
        const inner = document.getElementById("post-b")!;
        const anchor = document.createElement("a");
        anchor.href = "/photo.php?fbid=987654321";
        inner.append(anchor);
        outer.append(inner);
      });
      expect(await scraper.extractItems(context)).toEqual([]);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "ambiguous_post_boundary" }), expect.any(String),
      );
      const handle = await findPost();
      expect(await page.evaluate(el => el === null, handle)).toBe(true);
      await handle.dispose();
    });

    it("rejects unmarked containers with multiple story authors", async () => {
      await page.evaluate(() => {
        const feed = document.getElementById("feed")!;
        feed.innerHTML = `<div>
          <div aria-label="Unseen story from Synthetic A"></div><p>First synthetic post body</p>
          <div aria-label="Unseen story from Synthetic B"></div><a href="/photo.php?fbid=987654321">Second synthetic post</a>
        </div>`;
      });
      expect(await scraper.extractItems(context)).toEqual([]);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "ambiguous_post_boundary" }), expect.any(String),
      );
    });

    it("does not turn a photo URL in hidden HTML into an associated post link", async () => {
      await page.$eval("#post-a", el => {
        el.setAttribute("data-unrelated-url", "https://www.facebook.com/photo.php?fbid=987654321");
      });
      const items = await scraper.extractItems(context);
      expect(items.find(row => row.contentText?.includes("giveaway"))?.link).toBeNull();
    });

    it("retains conflicting photo destinations as unresolved rather than selecting the first", async () => {
      await page.$eval("#post-a", el => {
        for (const id of ["987654321", "111111111"]) {
          const anchor = document.createElement("a");
          anchor.href = `/photo.php?fbid=${id}`;
          anchor.textContent = "Synthetic photo";
          el.append(anchor);
        }
      });
      const items = await scraper.extractItems(context);
      const first = items.find(row => row.contentText?.includes("giveaway"))!;
      expect(first.link).toBeNull();
      await scraper.resolveLinks(context, [first]);
      expect(first.link).toBeNull();
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "ambiguous_content_destinations" }), expect.any(String),
      );
    });

    it("keeps fallback identity stable when relative time and CDN tokens change", async () => {
      await page.$eval("#post-a", el => {
        const time = document.createElement("span");
        time.id = "synthetic-time";
        time.textContent = "15m";
        el.prepend(time);
      });
      const before = (await scraper.extractItems(context)).find(row => row.contentText?.includes("giveaway"))!;
      await page.$eval("#synthetic-time", el => { el.textContent = "3h"; });
      await page.$eval("#post-a img", el => {
        el.setAttribute("src", "https://scontent.synthetic.fbcdn.net/post-a.png?token=changed");
      });
      const after = (await scraper.extractItems(context)).find(row => row.contentText?.includes("giveaway"))!;
      expect(before.sourceId).toMatch(/^fb_content_[a-f0-9]{64}$/);
      expect(after.sourceId).toBe(before.sourceId);
      await page.$eval("#post-a p", el => { el.textContent += " A different source story."; });
      const changed = (await scraper.extractItems(context)).find(row => row.contentText?.includes("giveaway"))!;
      expect(changed.sourceId).not.toBe(before.sourceId);
    });
  it("keeps role-based cards separate and ignores navigation text", async () => {
    await page.evaluate(() => {
      const post = document.getElementById("post-a")!;
      const replacement = document.createElement("div");
      replacement.id = post.id;
      replacement.setAttribute("role", "article");
      replacement.innerHTML = post.innerHTML;
      post.replaceWith(replacement);
      const nav = document.createElement("nav");
      nav.innerHTML = `<div>${"Synthetic navigation ".repeat(20)}<a href="/photo.php?fbid=111111111">Unrelated navigation</a></div>`;
      document.querySelector("main")!.prepend(nav);
    });
    const items = await scraper.extractItems(context);
    expect(items).toHaveLength(2);
    expect(items.every(row => !row.contentText?.includes("navigation"))).toBe(true);
  });

  it("rechecks conflicting destinations before click resolution even when identity text is unchanged", async () => {
    await page.$eval("#post-a", el => {
      for (const id of ["987654321", "111111111"]) {
        const anchor = document.createElement("a");
        anchor.href = `/photo.php?fbid=${id}`;
        el.append(anchor);
      }
    });
    await scraper.resolveLinks(context, [item]);
    expect(item.link).toBeNull();
    expect(page.url()).toBe(groupUrl);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ambiguous_content_destinations" }), expect.any(String),
    );
    expect(browser.listenerCount("targetcreated")).toBe(0);
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
