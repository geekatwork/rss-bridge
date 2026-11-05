// --- IMPORTS ---
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { ElementHandle, Page, Target } from "puppeteer";
import { SiteScraper, type NormalizedItem, type ScraperContext, type SiteConfig } from "../../core/index.js";
import { closeOwnedPage, parseTimestamp, sleep, textToParagraphHtml } from "../../core/utils.js";
import { fetchPostsViaApi } from "./graphApi.js";
import {
  extractFacebookListingLink,
  normalizeFacebookClickDestination,
} from "./linkExtraction.js";
import { isSocialMediaAssetUrl } from "@rss-bridge/link-policy";
import { extractFacebookAlbumLinkFromImageUrls, extractFacebookPostLinkFromCandidates } from "./linkExtraction.js";
import type { NormalizedPost } from "../../types.js";
import { findFacebookPost, type FacebookPostIdentity } from "./postIdentity.js";
import { ScraperConfigurationError, scraperErrorMessage } from "../../core/errors.js";

// --- MAIN EXPORTS ---
export function cleanFacebookPostText(raw: string, author?: string): string {
  // Strip common mobile UI fragments before line-based cleanup.
  let normalizedRaw = raw
    .replace(/Write a public comment\s*…?/gi, " ")
    .replace(/See more\s*…?/gi, " ")
    .replace(/All-star contributor/gi, " ")
    .replace(/\bAdmin\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  let lines = normalizedRaw.split(/\r?\n/);
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
      if (/^write a public comment\s*…?$/i.test(stripped)) return false;
      if (/^see more\s*…?$/i.test(stripped)) return false;
      if (/^(\d+\s*)?(comments?|shares?|views?)$/i.test(stripped)) return false;
      if (/^all-star contributor$/i.test(stripped)) return false;
      if (/^admin$/i.test(stripped)) return false;
      // skip if only special unicode (after trimming)
      if (/^[󰞋󱙷\uE000\uF8FF]+$/u.test(line)) return false;
      return true;
    });
  if (lines.length === 0) return "";
  let t = lines.join("\n");
  // Use removeSpecialUnicode on the whole text
  t = removeSpecialUnicode(t).trim();
  t = t.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  // If a feed item starts with the all-star preamble, keep only content after the source marker.
  t = t.replace(/^all[^\p{L}\p{N}]*star contributor[\s\S]*?󳄫\s*/iu, "").trim();
  // Some mobile payloads keep timestamp inline (e.g. "3h ...") after normalization.
  while (/^([0-9]{1,2}\s*[hmwd]|yesterday|just now)\b[^\p{L}\p{N}]*/iu.test(t)) {
    t = t.replace(/^([0-9]{1,2}\s*[hmwd]|yesterday|just now)\b[^\p{L}\p{N}]*/iu, "").trim();
  }
  t = t.replace(/^[ \t\n\r]+/, "");
  t = t
    .replace(/\.{3}\s*See more\s*$/i, "...")
    .replace(/\s*See more\s*$/i, "")
    .trim();
  return t;
}

export function isLikelyFacebookNonPostContent(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (!normalized) return true;
  if (normalized === "mostrelevantsort") return true;
  if (normalized.startsWith("writesomething")) return true;
  if (normalized === "videosannouncementsevents") return true;
  if (/publicgroup.*members.*joined.*invite/.test(normalized)) return true;
  if (normalized.startsWith("letswelcomeournewmembers")) return true;
  if (normalized.startsWith("aboutthisgroup")) return true;
  if (normalized.startsWith("theresmoretoseegetmorephotosvideosandupdatesfromthisgroup")) return true;
  if (normalized.includes("logincreatenewaccount")) return true;
  if (/^\d+(comments?|shares?|views?)$/.test(normalized)) return true;

  return false;
}

// --- MAIN CLASS ---

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expires?: number;
  expirationDate?: number;
}

interface UnresolvedFacebookDumpEntry {
  timestamp: string;
  sourcePostId: string;
  postIndex: number;
  groupUrl: string;
  contentText: string | null;
  contentHtml: string | null;
  mediaUrls: string[];
  candidateUrls: string[];
  domText: string;
  domHtml: string;
}

function appendJsonLine(filePath: string, entry: UnresolvedFacebookDumpEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
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
  private clickSequence = 0;

  private buildGroupUrl(groupId: string): string {
    const configured = this.config.options.sourceUrl as string | undefined;
    const url = new URL(configured || `https://www.facebook.com/groups/${groupId}/`);
    url.searchParams.set("sorting_setting", "CHRONOLOGICAL");
    return url.toString();
  }

  private isExpectedGroupPage(url: string, groupId: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        /^(www\.|m\.|mbasic\.)?facebook\.com$/i.test(parsed.hostname) &&
        parsed.pathname.split("/")[2] === groupId
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

  private getUnresolvedDumpFile(): string | null {
    const configured = this.config.options.unresolvedDumpFile as string | undefined;
    if (configured && configured.trim()) return configured.trim();
    const envConfigured = process.env.FACEBOOK_UNRESOLVED_DUMP_FILE;
    return envConfigured && envConfigured.trim() ? envConfigured.trim() : null;
  }

  private getPostIdentity(item: NormalizedItem): FacebookPostIdentity | null {
    const identity = item.rawPayload?.identity;
    if (!identity || typeof identity !== "object" || !("text" in identity)
      || typeof identity.text !== "string" || !("mediaUrls" in identity)
      || !Array.isArray(identity.mediaUrls) || !identity.mediaUrls.every((url) => typeof url === "string")) {
      return null;
    }
    return { text: identity.text, mediaUrls: identity.mediaUrls };
  }

  private async getPostHandle(item: NormalizedItem): Promise<ElementHandle<HTMLElement> | null> {
    if (!this.page) throw new Error("Page not initialized");
    const identity = this.getPostIdentity(item);
    if (!identity) return null;
    const handle = await this.page.evaluateHandle(findFacebookPost, identity);
    const element = handle.asElement();
    if (element) return handle as ElementHandle<HTMLElement>;
    await handle.dispose();
    return null;
  }

  private async clickVerifiedTarget(item: NormalizedItem, target: ElementHandle<HTMLElement>): Promise<boolean> {
    const post = await this.getPostHandle(item);
    const identity = this.getPostIdentity(item);
    if (!post || !identity) {
      await post?.dispose();
      return false;
    }
    const page = this.page;
    if (!page) {
      await post.dispose();
      throw new Error("Page not initialized");
    }
    const binding = `rssBridgeFacebookClick${++this.clickSequence}`;
    let finish = (_allowed: boolean) => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<boolean>((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error("Native Facebook click produced no verified click event")), 5000);
    });
    try {
      // Report the guarded event before a successful click destroys its document.
      await page.exposeFunction(binding, finish);
      await post.evaluate((el, clickTarget, expected, name) => {
        const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
        let blocked = false;
        const images = Array.from(el.querySelectorAll("img")).map((img) => img.getAttribute("src"));
        const check = (event: Event) => {
          const currentImages = Array.from(el.querySelectorAll("img")).map((img) => img.getAttribute("src"));
          if (normalize(el.textContent || "") !== normalize(expected.text)
            || images.some((src) => !currentImages.includes(src))
            || !el.contains(clickTarget) || !event.composedPath().includes(clickTarget)) {
            blocked = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          if (blocked || event.type === "click") {
            const notify: unknown = Reflect.get(window, name);
            if (typeof notify === "function") void notify(!blocked);
          }
        };
        for (const name of ["pointerdown", "mousedown", "click"]) document.addEventListener(name, check, true);
        Reflect.set(window, `${name}Cleanup`, () => {
          for (const event of ["pointerdown", "mousedown", "click"]) document.removeEventListener(event, check, true);
        });
      }, target, identity, binding);
      const [, allowed] = await Promise.all([target.click(), outcome]);
      return allowed;
    } finally {
      clearTimeout(timer);
      try {
        const cleanupHandle = await page.waitForFunction((name) => {
          const cleanup: unknown = Reflect.get(window, `${name}Cleanup`);
          if (typeof cleanup === "function") cleanup();
          Reflect.deleteProperty(window, `${name}Cleanup`);
          return true;
        }, { timeout: 5000 }, binding);
        await cleanupHandle.dispose();
      } finally {
        try {
          await page.removeExposedFunction(binding);
        } finally {
          await post.dispose();
        }
      }
    }
  }

  private async readPostDom(item: NormalizedItem) {
    const post = await this.getPostHandle(item);
    if (!post) return null;
    const identity = this.getPostIdentity(item);
    try {
      return await post.evaluate((el, expected) => {
        const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
        if (!expected || normalize(el.textContent || "") !== normalize(expected.text)) return null;
        const imageKey = (value: string) => {
          const url = new URL(value);
          return `${url.origin}${url.pathname}`;
        };
        const images = new Set(Array.from(el.querySelectorAll("img[src]"))
          .map((img) => imageKey(img.getAttribute("src") || "")));
        if (!expected.mediaUrls.every((url) => images.has(imageKey(url)))) return null;
        const candidateUrls = Array.from(el.querySelectorAll("a"))
          .flatMap((a) => [a.getAttribute("href"), a.href, a.getAttribute("data-lynx-uri"), a.getAttribute("ajaxify")])
          .filter((value): value is string => !!value);
        const clickImages = Array.from(el.querySelectorAll("img[src*='scontent'], img[src*='fbcdn']"))
          .filter((img) => !/rsrc\.php|emoji/.test(img.getAttribute("src") || ""))
          .map((img) => ({ src: img.getAttribute("src") || "", rect: img.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 80)
          .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
          .map(({ src }) => src);
        return {
          candidateUrls, clickImages: Array.from(new Set(clickImages)).slice(0, 2),
          domText: (el.textContent || "").trim(), domHtml: el.innerHTML,
          postIndex: Array.from(el.parentElement?.children || []).indexOf(el),
        };
      }, identity);
    } finally {
      await post.dispose();
    }
  }

  private async getClickTarget(item: NormalizedItem, imageSrc: string): Promise<ElementHandle<HTMLElement> | null> {
    const post = await this.getPostHandle(item);
    if (!post) return null;
    try {
      const handle = await post.evaluateHandle((el, src) => {
        const image = Array.from(el.querySelectorAll("img")).find((img) => img.getAttribute("src") === src);
        if (!image) return null;
        let target: HTMLElement = image;
        for (let parent = image.parentElement; parent && parent !== el; parent = parent.parentElement) {
          if (parent.hasAttribute("data-action-id")) {
            target = parent;
            break;
          }
        }
        return target;
      }, imageSrc);
      if (!handle.asElement()) {
        await handle.dispose();
        return null;
      }
      const target = handle as ElementHandle<HTMLElement>;
      try {
        await target.scrollIntoView();
        const currentPost = await this.getPostHandle(item);
        if (currentPost) {
          try {
            const valid = await currentPost.evaluate((el, expected, clickTarget) =>
              el === expected && el.contains(clickTarget), post, target);
            if (valid) return target;
          } finally {
            await currentPost.dispose();
          }
        }
        await target.dispose();
        return null;
      } catch (error) {
        await target.dispose();
        throw error;
      }
    } finally {
      await post.dispose();
    }
  }

  private async dumpUnresolvedFixture(item: NormalizedItem, groupUrl: string): Promise<void> {
    const dumpFile = this.getUnresolvedDumpFile();
    if (!dumpFile) return;
    const dumpPayload = await this.readPostDom(item);
    if (!dumpPayload) return;

    appendJsonLine(dumpFile, {
      timestamp: new Date().toISOString(),
      sourcePostId: item.sourceId,
      postIndex: dumpPayload.postIndex,
      groupUrl,
      contentText: item.contentText,
      contentHtml: item.contentHtml,
      mediaUrls: item.mediaUrls,
      candidateUrls: dumpPayload.candidateUrls,
      domText: dumpPayload.domText,
      domHtml: dumpPayload.domHtml,
    });
  }

  private async resolveLinkFromDomFallback(
    context: ScraperContext,
    item: NormalizedItem,
    groupUrl: string,
  ): Promise<boolean> {
    if (!this.page) return false;

    const snapshot = await this.readPostDom(item);
    const captured = item.rawPayload?.candidateUrls;
    const candidateHrefs = [
      ...(snapshot?.candidateUrls || []),
      ...(Array.isArray(captured) ? captured.filter((url): url is string => typeof url === "string") : []),
    ];

    const { link: postLink, multipleInstagramLinks } = extractFacebookPostLinkFromCandidates(candidateHrefs);
    if (multipleInstagramLinks) {
      context.logger.warn({ id: item.sourceId, instagramLinks: multipleInstagramLinks }, "Multiple Instagram links in post candidates; picked most frequent");
    }
    if (postLink) {
      item.link = postLink;
      context.logger.info({ id: item.sourceId, link: postLink }, "Resolved post link from href (shared post fallback)");
      return true;
    }

    const albumLink = extractFacebookAlbumLinkFromImageUrls(item.mediaUrls ?? []);
    if (albumLink) {
      item.link = albumLink;
      context.logger.info({ id: item.sourceId, link: albumLink }, "Resolved album photo link from image URLs (fallback)");
      return true;
    }

    context.logger.warn(
      { id: item.sourceId, reason: "no_verified_content_destination", mediaCount: item.mediaUrls.length },
      "Post link unresolved; retaining content and media without a destination",
    );
    await this.dumpUnresolvedFixture(item, groupUrl);
    return false;
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

    // Mobile viewport — mobile Facebook renders reliably in headless; desktop does not
    await this.page.setViewport({ width: 412, height: 915 });

    // Mobile user agent
    await this.page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile9.144 Mobile Safari/537.36"
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
        const sameSiteMap: Record<string, "None" | "Lax" | "Strict"> = {
          no_restriction: "None",
          lax: "Lax",
          strict: "Strict",
          unspecified: "None",
        };
        const normalizedCookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          httpOnly: c.httpOnly,
          secure: c.secure,
          ...(c.sameSite
            ? { sameSite: sameSiteMap[c.sameSite.toLowerCase()] ?? "None" }
            : {}),
          ...(c.expirationDate != null
            ? { expires: Math.floor(c.expirationDate) }
            : c.expires != null
              ? { expires: c.expires }
              : {}),
        }));
        await this.page.setCookie(...normalizedCookies);
        context.logger.info({ count: cookies.length, cookiePath }, "Loaded Facebook cookies");
      } catch (e) {
        context.logger.warn({ error: scraperErrorMessage(e) }, "Failed to load cookies");
      }
    } else {
      context.logger.warn({ cookiePathCandidates }, "Cookie file not found; Facebook may show login wall");
    }

    context.logger.debug({ site: this.config.siteId }, "Facebook scraper initialized");
  }

  async fetchListing(context: ScraperContext): Promise<void> {
    const groupIds = this.config.options.groupIds as string[];
    const stopAtSourceId = this.config.options.stopAtSourceId as string | undefined;
    const boundaryFallbackLimit = (this.config.options.boundaryFallbackLimit as number) || 50;
    if (!groupIds || groupIds.length === 0) {
      throw new ScraperConfigurationError("No groupIds provided in config.options");
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
        this.apiItems = markerIndex >= 0 ? mapped.slice(0, markerIndex) : mapped.slice(0, boundaryFallbackLimit);
      } else {
        this.apiItems = mapped.slice(0, boundaryFallbackLimit);
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
    const boundaryFallbackLimit = (this.config.options.boundaryFallbackLimit as number) || 50;

    if (this.useApi) {
      return this.apiItems;
    }

    if (!this.page) throw new Error("Page not initialized");
    const currentUrl = this.page.url();
    if (!this.isExpectedGroupPage(currentUrl, this.groupId)) {
      throw new Error(`Refusing to extract from non-group page: ${currentUrl}`);
    }

    const scrollLimit = (this.config.options.scrollAttempts as number) || 30;
    const maxCollected = (this.config.options.maxCollectedPosts as number) || boundaryFallbackLimit;
    let stableCount = 0;
    let prevCollectedCount = 0;

    const collectVisiblePosts = async () => {
      const evaluatedPosts = await this.page!.evaluate((groupId: string) => {
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
          urlCandidates: string[];
          htmlBlob: string;
        }> = [];

        // Mobile layout: posts live under screen-root > mainDiv > scrollDiv
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
          if (fullText.length === 0) continue;

          // Author
          let author: string | null = null;
          const storyLabels = Array.from(child.querySelectorAll("[aria-label*='story from']"));
          if (storyLabels.length >= 1) {
            author = storyLabels[0].getAttribute("aria-label")?.replace("Unseen story from ", "") || null;
          }

          // Timestamp — check aria-label and title attrs; also grab postId from permalink <a>
          let timeText: string | null = null;
          const TIME_RE = /(\d+\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|seconds?)\s*ago|yesterday|just now|\w+\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*[ap]m)?)/i;
          let link: string | null = null;
          let postId: string | null = null;

          // Check for post IDs in /posts/{id}/ or /permalink/{id}/ or story_fbid=
          const permalinkAs = Array.from(child.querySelectorAll(
            `a[href*="/groups/${groupId}/posts/"], a[href*="/groups/${groupId}/permalink/"], a[href*="story_fbid="]`
          ));
          for (const a of permalinkAs) {
            const label = a.getAttribute("aria-label") || a.getAttribute("title") || "";
            if (!timeText) {
              const m = label.match(TIME_RE);
              if (m != null) timeText = m[1];
            }
            if (!postId) {
              const href = (a as HTMLAnchorElement).href || "";
              const cleanHref = href.split('?')[0];
              const pm = cleanHref.match(/\/posts\/(\d+)/) || cleanHref.match(/\/permalink\/(\d+)/) || href.match(/story_fbid=(\d+)/);
              if (pm != null) {
                postId = pm[1];
                link = `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
              }
            }
            if (timeText && postId) break;
          }

          // Capture outbound media candidates from anchor attributes.
          // These are evaluated in Node.js (outside page.evaluate) to avoid browser-context
          // reference issues and to keep extraction logic centralized in linkExtraction.ts.
          const anchors = Array.from(child.querySelectorAll("a"));
          const urlCandidates: string[] = [];
          const addCandidate = (value: string | null) => {
            if (!value) return;
            const trimmed = value.trim();
            if (!trimmed) return;
            urlCandidates.push(trimmed);
          };

          for (const a of anchors) {
            addCandidate(a.getAttribute("href"));
            addCandidate((a as HTMLAnchorElement).href || null);
            addCandidate(a.getAttribute("data-lynx-uri"));
            addCandidate(a.getAttribute("ajaxify"));
          }

          const htmlBlob = (child as HTMLElement).innerHTML || "";

          // Fallback: scan all aria-label / title attrs for timestamp text
          if (!timeText) {
            for (const el of Array.from(child.querySelectorAll("[aria-label],[title]"))) {
              const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
              const m = label.match(TIME_RE);
              if (m != null) { timeText = m[1]; break; }
            }
          }

          const videoEl = child.querySelector("[data-video-id]");
          if (videoEl != null && !postId) {
            const videoId = videoEl.getAttribute("data-video-id");
            if (videoId) {
              // Keep reel URL as fallback when canonical permalink isn't discoverable.
              link = `https://www.facebook.com/reel/${videoId}`;
              postId = videoId;
            }
            const tracking = videoEl.getAttribute("data-video-tracking");
            if (tracking != null) {
              try {
                const parsed = JSON.parse(tracking);
                if (parsed.top_level_post_id) {
                  postId = parsed.top_level_post_id;
                  link = `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
                }
              } catch {}
            }
          }

          if (!link && !postId) {
            const trackingEl = child.querySelector("[data-video-tracking]");
            if (trackingEl != null) {
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
          if (!link && !postId) {
            const contentImg = child.querySelector("img[src*='scontent'], img[src*='fbcdn']");
            if (contentImg != null) {
              const src = contentImg.getAttribute("src") || "";
              if (!src.includes("rsrc.php") && !src.includes("emoji")) {
                needsLinkResolve = true;
              }
            }
          }

          // Fallback ID
          if (!postId) {
            const hashStr = fullText.substring(0, 100);
            let hash = 0;
            for (let i = 0; i < hashStr.length; i++) {
              hash = ((hash << 5) - hash + hashStr.charCodeAt(i)) | 0;
            }
            postId = `hash_${Math.abs(hash)}`;
          }

          // Content text
          const contentText = fullText;

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

          // Filter: only include posts with meaningful content (>15 chars) or with images.
          // Pseudo-post filtering is done outside page.evaluate in Node context.
          if (contentText.length > 15 || images.length > 0) {
            results.push({
              index: idx,
              id,
              author,
              text: contentText,
              html,
              link,
              images,
              time: timeText,
              needsLinkResolve,
              urlCandidates,
              htmlBlob,
            });
          }
        }

        return results;
      }, this.groupId || "");

      return evaluatedPosts.map((post) => {
        let link = post.link;

        if (!link) link = extractFacebookListingLink(post.urlCandidates, post.htmlBlob);

        return {
          index: post.index,
          id: post.id,
          author: post.author,
          text: post.text,
          html: post.html,
          link,
          images: post.images,
          time: post.time,
          needsLinkResolve: post.needsLinkResolve,
          candidateUrls: post.urlCandidates,
        };
      });
    };

    const collectedPosts = new Map<string, {
      index: number;
      id: string;
      author: string | null;
      text: string;
      html: string;
      link: string | null;
      images: string[];
      time: string | null;
      needsLinkResolve: boolean;
      candidateUrls: string[];
    }>();

    const mergeVisiblePosts = (visiblePosts: Awaited<ReturnType<typeof collectVisiblePosts>>) => {
      for (const post of visiblePosts) {
        if (!collectedPosts.has(post.id)) {
          collectedPosts.set(post.id, post);
          continue;
        }

        const existing = collectedPosts.get(post.id)!;
        if (existing.text.length < post.text.length) {
          existing.text = post.text;
          existing.html = post.html;
        }
        if (!existing.link && post.link) {
          existing.link = post.link;
        }
        if (!existing.author && post.author) {
          existing.author = post.author;
        }
        if (!existing.time && post.time) {
          existing.time = post.time;
        }
        if (existing.images.length < post.images.length) {
          existing.images = post.images;
        }
        existing.needsLinkResolve = existing.needsLinkResolve || post.needsLinkResolve;
        existing.candidateUrls = Array.from(new Set([...existing.candidateUrls, ...post.candidateUrls]));
      }
    };

    mergeVisiblePosts(await collectVisiblePosts());

    // Collect across multiple virtualized slices by scrolling and merging unique posts.
    // Small deltaY (900px) steps through the feed gradually so each newly-rendered batch
    // is captured before it scrolls off the top of the virtualized list.
    for (let i = 0; i < scrollLimit; i++) {
      await this.page.mouse.move(200, 500);
      await this.page.mouse.wheel({ deltaY: 900 });
      await sleep(3000);

      const visiblePosts = await collectVisiblePosts();
      mergeVisiblePosts(visiblePosts);
      const collectedCount = collectedPosts.size;

      context.logger.debug(
        { scroll: i + 1, postsVisible: visiblePosts.length, postsCollected: collectedCount },
        "Scrolling Facebook feed"
      );

      if (collectedCount >= maxCollected) {
        context.logger.info({ scroll: i + 1, collectedCount, maxCollected }, "Reached max collected posts; stopping scroll");
        break;
      }

      if (collectedCount === prevCollectedCount) {
        stableCount++;
        if (stableCount >= 5) {
          context.logger.info({ scroll: i + 1, collectedCount }, "No additional posts collected; stopping scroll");
          break;
        }
      } else {
        stableCount = 0;
      }

      prevCollectedCount = collectedCount;
      this.scrollAttempts++;
    }

    const rawPosts = Array.from(collectedPosts.values());

    context.logger.info({ groupId: this.groupId, count: rawPosts.length }, "Extracted posts");

    const filteredRawPosts = rawPosts.filter((post) => {
      const cleanedForSignal = cleanFacebookPostText(post.text || "", post.author || undefined);
      return !isLikelyFacebookNonPostContent(cleanedForSignal || post.text || "");
    });

    const markerIndex = stopAtSourceId
      ? filteredRawPosts.findIndex((post) => post.id === stopAtSourceId)
      : -1;
    const minimumReliableMarkerIndex = Math.max(
      1,
      Number(this.config.options.boundaryMinimumMarkerIndex ?? 5),
    );
    const markerUsable = markerIndex >= minimumReliableMarkerIndex;
    const boundedFilteredPosts = markerUsable
      ? filteredRawPosts.slice(0, markerIndex)
      : filteredRawPosts.slice(0, boundaryFallbackLimit);

    context.logger.info(
      {
        groupId: this.groupId,
        rawCount: rawPosts.length,
        filteredCount: filteredRawPosts.length,
        boundedCount: boundedFilteredPosts.length,
        boundaryFallbackLimit,
        boundaryMinimumMarkerIndex: minimumReliableMarkerIndex,
        stopAtSourceId: stopAtSourceId || null,
        markerFound: markerIndex >= 0,
        markerIndex,
        markerUsable,
      },
      "Facebook extraction boundary stats"
    );

    return boundedFilteredPosts.map((post): NormalizedItem => {
      const cleanedText = cleanFacebookPostText(post.text || "", post.author || undefined);
      const sourceDate = post.time ? parseTimestamp(post.time) : null;
      const postedAt = sourceDate ?? new Date();

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
        publishedAtIsSource: sourceDate !== null,
        rawPayload: {
          fbId: post.id, needsLinkResolve: post.needsLinkResolve,
          identity: { text: post.text, mediaUrls: post.images },
          candidateUrls: post.candidateUrls,
        },
      };
    });
  }

  async resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    for (const item of items) {
      if (item.link && isSocialMediaAssetUrl(item.link)) {
        item.link = null;
        context.logger.warn({ id: item.sourceId, reason: "social_media_asset" }, "Rejected media asset post destination");
      }
    }
    if (this.useApi) return;
    if (!this.page) throw new Error("Page not initialized");

    const resolveLimit = (this.config.options.maxCollectedPosts as number) || 60;
    const itemsNeedingLinks = items
      .filter((i) => !i.link)
      .slice(0, resolveLimit);
    context.logger.info({ count: itemsNeedingLinks.length }, "Resolving links");
    if (itemsNeedingLinks.length === 0) return;

    const groupUrl = this.page.url();

    // Facebook virtualises the feed DOM — after 30+ scroll steps the early posts
    // are removed from the DOM. Scroll the feed container back to the top (not window.scrollTo,
    // since FB mobile uses its own scroll container) so those elements are re-rendered.
    await this.page.evaluate(() => {
      const screenRoot = document.getElementById("screen-root");
      if (!screenRoot) return;
      const mainDiv = screenRoot.children[0];
      if (!mainDiv) return;
      for (let i = 0; i < mainDiv.children.length; i++) {
        const child = mainDiv.children[i] as HTMLElement;
        if ((child.textContent || "").trim().length > 200) {
          child.scrollTop = 0;
          break;
        }
      }
      // Also scroll the window to the top for good measure
      window.scrollTo(0, 0);
    });
    await sleep(3000);

    for (const item of itemsNeedingLinks) {
      if (!this.isExpectedGroupPage(this.page.url(), this.groupId || "")) {
        throw new Error("Refusing to resolve links outside the configured Facebook group");
      }
      try {
        const post = await this.getPostHandle(item);
        if (!post) {
          context.logger.warn({ id: item.sourceId }, "Post identity absent or ambiguous; skipping DOM resolution");
          await this.resolveLinkFromDomFallback(context, item, groupUrl);
          continue;
        }
        try {
          await post.scrollIntoView();
        } finally {
          await post.dispose();
        }
        await sleep(1200);

        const snapshot = await this.readPostDom(item);
        if (!snapshot) {
          context.logger.warn({ id: item.sourceId }, "Post identity changed after scrolling; skipping DOM resolution");
          await this.resolveLinkFromDomFallback(context, item, groupUrl);
          continue;
        }
        const resolvedHref = extractFacebookPostLinkFromCandidates(snapshot.candidateUrls).link;
        if (resolvedHref) {
          item.link = resolvedHref;
          context.logger.info({ id: item.sourceId, link: resolvedHref }, "Resolved content link from verified post DOM");
          continue;
        }
        if (this.config.options.debugHrefs) {
          context.logger.info({ id: item.sourceId, allHrefs: snapshot.candidateUrls }, "resolveLinks: verified post hrefs");
        }

        let resolved = false;
        for (const candidate of item.rawPayload?.needsLinkResolve ? snapshot.clickImages : []) {
          const target = await this.getClickTarget(item, candidate);
          if (!target) {
            context.logger.warn({ id: item.sourceId }, "Post identity changed before click; skipping target");
            break;
          }
          context.logger.info({ id: item.sourceId }, "resolveLinks: clicking verified image");

          let cancelPopupWait = () => {};
          const newTabPromise = new Promise<string | null>((resolve) => {
            const finish = (url: string | null) => {
              clearTimeout(timeout);
              context.browser.off("targetcreated", onTarget);
              resolve(url);
            };
            const onTarget = async (target: Target) => {
              if (target.opener() !== this.page?.target()) return;
              context.browser.off("targetcreated", onTarget);
              try {
                const newPage = await target.page();
                if (newPage) {
                  let tabUrl: string;
                  try {
                    await newPage.waitForFunction(() => location.href !== "about:blank"
                      && document.readyState !== "loading", { timeout: 5000 });
                    tabUrl = newPage.url();
                  } finally {
                    await newPage.close();
                  }
                  finish(tabUrl);
                } else {
                  finish(null);
                }
              } catch (error) {
                context.logger.warn({ id: item.sourceId, error: scraperErrorMessage(error) }, "Failed to read clicked popup");
                finish(null);
              }
            };
            const timeout = setTimeout(() => finish(null), 6000);
            cancelPopupWait = () => finish(null);
            context.browser.on("targetcreated", onTarget);
          });

          try {
            if (!await this.clickVerifiedTarget(item, target)) {
              context.logger.warn({ id: item.sourceId }, "Post changed during native click; blocked interaction");
              cancelPopupWait();
              break;
            }
            await sleep(3000);
          } catch (error) {
            cancelPopupWait();
            throw error;
          } finally {
            await target.dispose();
          }

          const newTabUrl = await newTabPromise;
          if (newTabUrl && newTabUrl !== "about:blank") {
            const destination = normalizeFacebookClickDestination(newTabUrl, groupUrl);
            if (destination) {
              item.link = destination;
              context.logger.info({ id: item.sourceId, link: destination }, "Resolved clicked popup link");
              resolved = true;
              break;
            }
            context.logger.debug(
              { id: item.sourceId, reason: isSocialMediaAssetUrl(newTabUrl) ? "social_media_asset" : "non_content_destination" },
              "Ignoring non-content popup destination",
            );
          }

          const currentUrl = this.page.url();
          context.logger.debug({ id: item.sourceId }, "Checking in-page click destination");

          if (currentUrl === groupUrl) continue;
          const destination = normalizeFacebookClickDestination(currentUrl, groupUrl);
          await this.page.goBack({ waitUntil: "networkidle2" });
          await sleep(2000);
          if (!this.isExpectedGroupPage(this.page.url(), this.groupId || "")) {
            throw new Error("Click resolution did not return to the configured Facebook group");
          }
          if (destination) {
            item.link = destination;
            context.logger.info({ id: item.sourceId, link: destination }, "Resolved clicked link");
            resolved = true;
          } else {
            context.logger.debug(
              { id: item.sourceId, reason: isSocialMediaAssetUrl(currentUrl) ? "social_media_asset" : "non_content_destination" },
              "Ignoring non-content in-page destination",
            );
          }
          break;
        }

        if (!resolved) {
          await this.resolveLinkFromDomFallback(context, item, groupUrl);
          continue;
        }

      } catch (e) {
        context.logger.warn({ id: item.sourceId, error: scraperErrorMessage(e) }, "Failed to resolve link");
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
      const page = this.page;
      this.page = undefined;
      await closeOwnedPage(page);
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
      publishedAtIsSource: post.postedAtIsSource === true,
    };
  }
}
