// --- IMPORTS ---
import { readFileSync, existsSync } from "fs";
import type { Page } from "puppeteer";
import { SiteScraper, type NormalizedItem, type ScraperContext, type SiteConfig } from "../../core/index.js";
import { parseTimestamp, sleep, textToParagraphHtml } from "../../core/utils.js";
import { fetchPostsViaApi } from "./graphApi.js";
import type { NormalizedPost } from "../../types.js";

// --- MAIN EXPORTS ---
export function cleanFacebookPostText(raw: string, author?: string): string {
  let lines = raw.split(/\r?\n/);
  const namesToStrip: string[] = [];
  if (author) namesToStrip.push(author);

  // Remove metadata/timestamp/unicode from all lines, then skip lines that are empty after cleaning
  // Regex for invisible unicode and special chars
  const invisibleOrSpecial = /[\u200e\u200f\u202a-\u202e\u2066-\u2069󰞋󱙷\uE000\uF8FF]/gu;
  const timestampOnly = /^([0-9]{1,2}\s*[hmwd]|yesterday|just now)[^\p{L}\p{N}]*\s*$/iu;
  lines = lines
    .map((line) => {
      let cleaned = stripMetadata(line.trim(), namesToStrip);
      cleaned = stripTimestamps(cleaned);
      cleaned = removeSpecialUnicode(cleaned);
      return cleaned;
    })
    .filter((line) => {
      if (line === "") return false;
      // Remove invisible/special chars for timestamp check
      const stripped = line.replace(invisibleOrSpecial, "").trim();
      if (timestampOnly.test(stripped)) return false;
      // skip if only special unicode (after trimming)
      if (/^[󰞋󱙷\uE000\uF8FF]+$/u.test(line)) return false;
      return true;
    });
  if (lines.length === 0) return "";
  let t = lines.join("\n");
  // Use removeSpecialUnicode on the whole text
  t = removeSpecialUnicode(t).trim();
  t = t.replace(/^[ \t\n\r]+/, "");
  t = t
    .replace(/\.{3}\s*See more\s*$/i, "...")
    .replace(/\s*See more\s*$/i, "")
    .trim();
  return t;
}

// --- MAIN CLASS ---

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

// Robust post text cleaning logic (shared with tests)
// --- HELPER FUNCTIONS ---
function stripMetadata(line: string, namesToStrip: string[]): string {
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of namesToStrip) {
      if (line.startsWith(name + ":")) {
        line = line.substring((name + ":").length).trim();
        changed = true;
      } else if (line.startsWith(name)) {
        line = line.substring(name.length).trim();
        changed = true;
      }
    }
    const adminMatch =
      /^(Admin|Moderator|Author|Top Fan|Group Expert|Page)\b:?/i;
    if (adminMatch.test(line)) {
      line = line.replace(adminMatch, "").trim();
      changed = true;
    }
  }
  return line;
}

function stripTimestamps(line: string): string {
  let changed = true;
  while (changed) {
    changed = false;
    const timestampMatch =
      /^([0-9]{1,2}\s*[hmwd]|yesterday|just now)[^\p{L}\p{N}]*\s*/iu;
    if (timestampMatch.test(line)) {
      line = line.replace(timestampMatch, "").trim();
      changed = true;
    }
  }
  return line;
}

function removeSpecialUnicode(line: string): string {
  // Trim only the specific unicode characters from the start and end
  // Includes: 󰞋 (U+F049B), 󱙷 (U+F8677),  (U+F8FF),  (U+E000)
  return line.replace(/^[󰞋󱙷\uE000\uF8FF]+|[󰞋󱙷\uE000\uF8FF]+$/gu, "").trim();
}



interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

/**
 * FacebookScraper: Scrapes public Facebook groups and resolves Instagram links.
 *
 * Features:
 * - Mobile viewport (412x915) to match mobile Facebook
 * - Puppeteer mouse.wheel scrolling to trigger lazy loading
 * - Click-intercept to resolve Instagram post links from embedded iframes
 * - Native mouse clicks for external link detection
 * - Photo link resolution via fbid and permalink detection
 *
 * Config options:
 * - groupIds: Array of Facebook group IDs to scrape
 * - cookieFile: Path to cookie JSON file (default: /app/cookies/facebook/fb_cookies.json)
 * - maxPages: Max pagination rounds (default: 1)
 * - scrollAttempts: Max mouse.wheel scrolls per page (default: 10)
 */
export class FacebookScraper extends SiteScraper {
  private page?: Page;
  private scrollAttempts = 0;
  private groupId?: string;
  private morePages = false;
  private useApi = false;
  private apiItems: NormalizedItem[] = [];

  private buildGroupUrl(groupId: string): string {
    return `https://www.facebook.com/groups/${groupId}/?sorting_setting=RECENT_ACTIVITY`;
  }

  private isExpectedGroupPage(url: string, groupId: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        /^(www\.|m\.)?facebook\.com$/i.test(parsed.hostname) &&
        new RegExp(`^/groups/${groupId}(?:/|$)`).test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  private isHomeOrLoginLikePage(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (!/^(www\.|m\.)?facebook\.com$/i.test(parsed.hostname)) return false;
      const path = parsed.pathname.toLowerCase();
      const looksLikeHome = path === "/" || path === "/home.php" || path === "/login.php" || path === "/checkpoint/";
      const feedParam = parsed.searchParams.get("sk") === "h_chr";
      return looksLikeHome || feedParam;
    } catch {
      return false;
    }
  }

  canHandle(source: string): boolean {
    // Match Facebook group URLs or explicit "facebook" identifier
    return source === "facebook" || source.startsWith("https://www.facebook.com/groups/");
  }

  async init(context: ScraperContext): Promise<void> {
    context.logger.info({ site: this.config.siteId }, "Initializing Facebook scraper");
    // If an access token is provided, use the Graph API — no browser needed
    const accessToken = this.config.options.accessToken as string | undefined;
    if (accessToken) {
      this.useApi = true;
      context.logger.info({ site: this.config.siteId }, "Access token found; will use Graph API");
      return;
    }

    this.page = await context.browser.newPage();

    // Mobile viewport to match Facebook's detection
    await this.page.setViewport({ width: 412, height: 915 });

    // Mobile user agent
    await this.page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36"
    );

    // Disable webdriver detection
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Load cookies from configured path, then canonical default.
    const configuredCookiePath = this.config.options.cookieFile as string | undefined;
    const cookiePathCandidates = configuredCookiePath
      ? [configuredCookiePath]
      : ["/app/cookies/facebook/fb_cookies.json"];
    const cookiePath = cookiePathCandidates.find((path) => existsSync(path));

    if (cookiePath) {
      try {
        const raw = readFileSync(cookiePath, "utf-8");
        const cookies: CookieEntry[] = JSON.parse(raw);
        await this.page.setCookie(...cookies);
        context.logger.info({ count: cookies.length, cookiePath }, "Loaded Facebook cookies");
      } catch (e) {
        context.logger.warn({ error: String(e) }, "Failed to load cookies");
      }
    } else {
      context.logger.warn({ cookiePathCandidates }, "Cookie file not found; Facebook may show login wall");
    }

    context.logger.debug({ site: this.config.siteId }, "Facebook scraper initialized");
  }

  async fetchListing(context: ScraperContext): Promise<void> {
    const groupIds = this.config.options.groupIds as string[];
    const stopAtSourceId = this.config.options.stopAtSourceId as string | undefined;
    if (!groupIds || groupIds.length === 0) {
      throw new Error("No groupIds provided in config.options");
    }

    // Graph API path: fetch directly and store items for extractItems()
    if (this.useApi) {
      this.groupId = groupIds[0];
      const accessToken = this.config.options.accessToken as string;
      context.logger.info({ groupId: this.groupId }, "Fetching via Graph API");
      const posts = await fetchPostsViaApi(this.groupId, accessToken);
      const mapped = posts.map((p) => this.postToItem(p));
      if (stopAtSourceId) {
        const markerIndex = mapped.findIndex((item) => item.sourceId === stopAtSourceId);
        this.apiItems = markerIndex >= 0 ? mapped.slice(0, markerIndex) : mapped;
      } else {
        this.apiItems = mapped;
      }
      context.logger.info({ groupId: this.groupId, count: this.apiItems.length }, "Graph API returned items");
      return;
    }

    if (!this.page) throw new Error("Page not initialized");

    // Use the first group ID; pagination will cycle through others
    this.groupId = groupIds[0];
    const url = this.buildGroupUrl(this.groupId);

    let loadedExpectedGroup = false;
    let finalUrl = "";
    let pageTitle = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      context.logger.debug({ groupId: this.groupId, url, attempt }, "Navigating to Facebook group");
      await this.page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(8000); // Wait for JS and lazy-loaded content

      finalUrl = this.page.url();
      pageTitle = await this.page.title();

      if (this.isExpectedGroupPage(finalUrl, this.groupId)) {
        loadedExpectedGroup = true;
        break;
      }

      context.logger.warn(
        { groupId: this.groupId, attempt, finalUrl, title: pageTitle },
        "Facebook redirected away from expected group page"
      );
    }

    if (!loadedExpectedGroup) {
      throw new Error(`Expected group page ${this.groupId} but landed on ${finalUrl} (${pageTitle})`);
    }

    context.logger.info({ groupId: this.groupId, title: pageTitle }, "Loaded Facebook group");

    // Remove "unsupported browser" interstitial if present
    await this.page.evaluate(() => {
      const interstitial = document.getElementById("unsupported-interstitial");
      if (interstitial) interstitial.remove();
    });

    this.scrollAttempts = 0;
  }

  async extractItems(context: ScraperContext): Promise<NormalizedItem[]> {
    if (!this.groupId) throw new Error("Group ID not set");
    const stopAtSourceId = this.config.options.stopAtSourceId as string | undefined;

    if (this.useApi) {
      return this.apiItems;
    }

    if (!this.page) throw new Error("Page not initialized");
    const currentUrl = this.page.url();
    if (!this.isExpectedGroupPage(currentUrl, this.groupId)) {
      throw new Error(`Refusing to extract from non-group page: ${currentUrl}`);
    }

    const scrollLimit = (this.config.options.scrollAttempts as number) || 10;
    let prevPostCount = 0;
    let stableCount = 0;

    // Load additional posts before extraction.
    for (let i = 0; i < scrollLimit; i++) {
      await this.page.mouse.move(200, 400);
      await this.page.mouse.wheel({ deltaY: 2000 });
      await sleep(2500);

      const postCount = await this.page.evaluate(() => {
        const screenRoot = document.getElementById("screen-root");
        if (!screenRoot) return 0;
        const mainDiv = screenRoot.children[0];
        if (!mainDiv) return 0;
        let scrollDiv: Element | null = null;
        for (let j = 0; j < mainDiv.children.length; j++) {
          const child = mainDiv.children[j];
          if ((child.textContent || "").trim().length > 200) {
            scrollDiv = child;
            break;
          }
        }
        if (!scrollDiv) return 0;

        let count = 0;
        for (const c of Array.from(scrollDiv.children)) {
          const txt = (c.textContent || "").trim();
          if (txt.length < 30) continue;
          count++;
        }
        return count;
      });

      context.logger.debug({ scroll: i + 1, postsVisible: postCount }, "Scrolling Facebook feed");

      if (postCount === prevPostCount) {
        stableCount++;
        if (stableCount >= 2) {
          context.logger.info({ scroll: i + 1 }, "No additional posts loaded; stopping scroll");
          break;
        }
      } else {
        stableCount = 0;
      }

      prevPostCount = postCount;
      this.scrollAttempts++;
    }

    // Extract posts from DOM
    const rawPosts = await this.page.evaluate((groupId: string) => {
      const results: Array<{
        index: number;
        id: string;
        author: string | null;
        text: string;
        html: string;
        link: string | null;
        images: string[];
        time: string | null;
        needsLinkResolve: boolean;
      }> = [];

      const screenRoot = document.getElementById("screen-root");
      if (!screenRoot) return results;
      const mainDiv = screenRoot.children[0];
      if (!mainDiv) return results;

      let scrollDiv: Element | null = null;
      for (let i = 0; i < mainDiv.children.length; i++) {
        const child = mainDiv.children[i];
        if ((child.textContent || "").trim().length > 200) {
          scrollDiv = child;
          break;
        }
      }
      if (!scrollDiv) return results;

      const feedChildren = Array.from(scrollDiv.children);

      for (let idx = 0; idx < feedChildren.length; idx++) {
        const child = feedChildren[idx];

        const fullText = (child.textContent || "").trim();
        if (fullText.length < 30) continue;

        // Author
        const storyLabels = child.querySelectorAll("[aria-label^='Unseen story from']");
        let author: string | null = null;
        if (storyLabels.length >= 1) {
          author = storyLabels[0].getAttribute("aria-label")?.replace("Unseen story from ", "") || null;
        }

        // Timestamp
        let timeText: string | null = null;
        const allLabeled = child.querySelectorAll("[aria-label]");
        for (const el of Array.from(allLabeled)) {
          const label = el.getAttribute("aria-label") || "";
          const m = label.match(/^(\d+\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|seconds?)\s*ago|yesterday|just now)/i);
          if (m) {
            timeText = m[1];
            break;
          }
        }

        // Link (from data-video-tracking or will be resolved via click)
        let link: string | null = null;
        let postId: string | null = null;

        const videoEl = child.querySelector("[data-video-id]");
        if (videoEl) {
          const videoId = videoEl.getAttribute("data-video-id");
          if (videoId) {
            link = `https://www.facebook.com/reel/${videoId}`;
            postId = videoId;
          }
          const tracking = videoEl.getAttribute("data-video-tracking");
          if (tracking) {
            try {
              const parsed = JSON.parse(tracking);
              if (parsed.top_level_post_id) {
                postId = parsed.top_level_post_id;
                link = `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
              }
            } catch {}
          }
        }

        if (!link) {
          const trackingEl = child.querySelector("[data-video-tracking]");
          if (trackingEl) {
            try {
              const parsed = JSON.parse(trackingEl.getAttribute("data-video-tracking") || "");
              postId = parsed.top_level_post_id || parsed.mf_story_key || null;
              if (postId) {
                link = `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
              }
            } catch {}
          }
        }

        // Check if there's a content image we might click to resolve a link
        let needsLinkResolve = false;
        if (!link) {
          const contentImg = child.querySelector("img[src*='scontent'], img[src*='fbcdn']");
          if (contentImg) {
            const src = contentImg.getAttribute("src") || "";
            if (!src.includes("rsrc.php") && !src.includes("emoji")) {
              needsLinkResolve = true;
            }
          }
        }

        // Fallback ID
        if (!postId) {
          let hashStr = fullText.substring(0, 100);
          let hash = 0;
          for (let i = 0; i < hashStr.length; i++) {
            hash = ((hash << 5) - hash + hashStr.charCodeAt(i)) | 0;
          }
          postId = `hash_${Math.abs(hash)}`;
        }

        // Content text (raw in page context; cleaned in Node context)
        let contentText = fullText;

        // Images
        const images: string[] = [];
        child.querySelectorAll("img[src*='fbcdn'], img[src*='scontent']").forEach((img) => {
            const src = img.getAttribute("src");
            if (src && !src.includes("emoji") && !src.includes("rsrc.php")) {
              images.push(src);
            }
          });

        const html = contentText ? `<p>${contentText.replace(/\n/g, "</p><p>")}</p>` : "";
        const id = `fb_${postId}`;

        if (contentText.length > 5 || images.length > 0) {
          results.push({ index: idx, id, author, text: contentText, html, link, images, time: timeText, needsLinkResolve });
        }
      }

      return results;
    }, this.groupId || "");

    context.logger.info({ groupId: this.groupId, count: rawPosts.length }, "Extracted posts");

    const markerIndex = stopAtSourceId
      ? rawPosts.findIndex((post) => post.id === stopAtSourceId)
      : -1;
    const boundedRawPosts = markerIndex >= 0 ? rawPosts.slice(0, markerIndex) : rawPosts;

    context.logger.info(
      {
        groupId: this.groupId,
        rawCount: rawPosts.length,
        boundedCount: boundedRawPosts.length,
        stopAtSourceId: stopAtSourceId || null,
        markerFound: markerIndex >= 0,
      },
      "Facebook extraction boundary stats"
    );

    return boundedRawPosts.map((post): NormalizedItem => {
      const cleanedText = cleanFacebookPostText(post.text || "", post.author || undefined);
      const postedAt = post.time ? (parseTimestamp(post.time) || new Date()) : new Date();

      return {
        sourceId: post.id,
        sourceSite: this.config.siteId,
        title: null,
        contentText: cleanedText || null,
        contentHtml: textToParagraphHtml(cleanedText || null),
        authorName: post.author,
        link: post.link,
        mediaUrls: post.images,
        publishedAt: postedAt,
        rawPayload: { fbId: post.id, needsLinkResolve: post.needsLinkResolve, index: post.index },
      };
    });
  }

  async resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    if (this.useApi) return;
    if (!this.page) throw new Error("Page not initialized");

    const itemsNeedingLinks = items.filter((i) => !i.link && i.rawPayload?.needsLinkResolve);
    context.logger.debug({ count: itemsNeedingLinks.length }, "Resolving links");

    const groupUrl = this.page.url();

    for (const item of itemsNeedingLinks) {
      try {
        const postIndex = item.rawPayload?.index as number;
        if (postIndex === undefined) continue;

        // Scroll image into view
        await this.page.evaluate((idx: number) => {
          const screenRoot = document.getElementById("screen-root");
          if (!screenRoot) return;
          const mainDiv = screenRoot.children[0];
          if (!mainDiv) return;
          let scrollDiv: Element | null = null;
          for (let i = 0; i < mainDiv.children.length; i++) {
            const child = mainDiv.children[i];
            if ((child.textContent || "").trim().length > 200) {
              scrollDiv = child;
              break;
            }
          }
          if (!scrollDiv) return;
          const postEl = scrollDiv.children[idx];
          if (!postEl) return;
          const allImgs = postEl.querySelectorAll("img[src*='scontent'], img[src*='fbcdn']");
          for (const img of Array.from(allImgs)) {
            const src = img.getAttribute("src") || "";
            if (src.includes("rsrc.php") || src.includes("emoji")) continue;
            const rect = img.getBoundingClientRect();
            if (rect.width > 100) {
              img.scrollIntoView({ block: "center" });
              return;
            }
          }
        }, postIndex);

        await sleep(500);

        // Get click position
        const clickPos = await this.page.evaluate((idx: number) => {
          const screenRoot = document.getElementById("screen-root");
          if (!screenRoot) return null;
          const mainDiv = screenRoot.children[0];
          if (!mainDiv) return null;
          let scrollDiv: Element | null = null;
          for (let i = 0; i < mainDiv.children.length; i++) {
            const child = mainDiv.children[i];
            if ((child.textContent || "").trim().length > 200) {
              scrollDiv = child;
              break;
            }
          }
          if (!scrollDiv) return null;
          const postEl = scrollDiv.children[idx];
          if (!postEl) return null;
          const allImgs = postEl.querySelectorAll("img[src*='scontent'], img[src*='fbcdn']");
          for (const img of Array.from(allImgs)) {
            const src = img.getAttribute("src") || "";
            if (src.includes("rsrc.php") || src.includes("emoji")) continue;
            const rect = img.getBoundingClientRect();
            if (rect.width > 100) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        }, postIndex);

        if (!clickPos) continue;

        // Listen for new tab (Instagram embeds open in new tab)
        const newTabPromise = new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 6000);
          context.browser.once("targetcreated", async (target) => {
            clearTimeout(timeout);
            try {
              const newPage = await target.page();
              if (newPage) {
                await newPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
                const tabUrl = newPage.url();
                await newPage.close();
                resolve(tabUrl === "about:blank" ? null : tabUrl);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        });

        // Click the image
        await this.page.mouse.click(clickPos.x, clickPos.y);
        await sleep(3000);

        const newTabUrl = await newTabPromise;
        if (newTabUrl && newTabUrl !== "about:blank") {
          if (this.isHomeOrLoginLikePage(newTabUrl)) {
            context.logger.debug({ id: item.sourceId, link: newTabUrl }, "Ignoring home/login-like redirect link");
            continue;
          }
          const igMatch = newTabUrl.match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/);
          const igReelMatch = newTabUrl.match(/instagram\.com\/reel\/([A-Za-z0-9_-]+)/);
          if (igMatch) {
            item.link = `https://www.instagram.com/p/${igMatch[1]}/`;
            item.sourceId = `ig_${igMatch[1]}`;
            context.logger.debug({ id: item.sourceId, link: item.link }, "Resolved Instagram link");
          } else if (igReelMatch) {
            item.link = `https://www.instagram.com/reel/${igReelMatch[1]}/`;
            item.sourceId = `ig_${igReelMatch[1]}`;
            context.logger.debug({ id: item.sourceId, link: item.link }, "Resolved Instagram reel");
          } else {
            try {
              const parsed = new URL(newTabUrl);
              if (parsed.origin && parsed.origin !== "null") {
                item.link = `${parsed.origin}${parsed.pathname}`;
              } else {
                item.link = newTabUrl;
              }
            } catch {
              item.link = newTabUrl;
            }
            context.logger.debug({ id: item.sourceId, link: item.link }, "Resolved external link");
          }
        } else {
          // Check if current page navigated
          const currentUrl = this.page.url();
          if (currentUrl !== groupUrl && !currentUrl.includes(groupUrl.split("?")[0])) {
            if (this.isHomeOrLoginLikePage(currentUrl)) {
              context.logger.debug({ id: item.sourceId, link: currentUrl }, "Ignoring home/login-like in-page redirect");
              await this.page.goBack({ waitUntil: "networkidle2" }).catch(() => {});
              await sleep(2000);
              continue;
            }
            const fbidMatch = currentUrl.match(/fbid=(\d+)/);
            const permalinkMatch = currentUrl.match(/permalink\/(\d+)/);
            if (fbidMatch) {
              item.link = currentUrl;
              item.sourceId = `fb_${fbidMatch[1]}`;
              context.logger.debug({ id: item.sourceId, link: "fbid" }, "Resolved photo link");
            } else if (permalinkMatch) {
              item.link = currentUrl;
              item.sourceId = `fb_${permalinkMatch[1]}`;
            } else {
              item.link = currentUrl;
            }
            await this.page.goBack({ waitUntil: "networkidle2" });
            await sleep(2000);
          }
        }

        // Close stray tabs
        const pages = await context.browser.pages();
        for (const p of pages) {
          if (p !== this.page) {
            await p.close().catch(() => {});
          }
        }
      } catch (e) {
        context.logger.warn({ id: item.sourceId, error: String(e) }, "Failed to resolve link");
      }
    }
  }

  async hasMorePages(context: ScraperContext): Promise<boolean> {
    return this.morePages;
  }

  async nextPage(context: ScraperContext): Promise<void> {
    context.logger.info("No pagination for Facebook groups; stopping");
    this.morePages = false;
  }

  async shutdown(context: ScraperContext): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    context.logger.debug({ site: this.config.siteId }, "Facebook scraper shutdown");
  }

  private postToItem(post: NormalizedPost): NormalizedItem {
    return {
      sourceId: post.sourcePostId,
      sourceSite: this.config.siteId,
      title: null,
      contentText: post.contentText,
      contentHtml: post.contentHtml,
      authorName: post.authorName,
      link: post.link,
      mediaUrls: post.imageUrls,
      publishedAt: post.postedAt,
    };
  }
}
