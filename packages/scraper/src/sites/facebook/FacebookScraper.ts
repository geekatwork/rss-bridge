// --- IMPORTS ---
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { Page } from "puppeteer";
import { SiteScraper, type NormalizedItem, type ScraperContext, type SiteConfig } from "../../core/index.js";
import { parseTimestamp, sleep, textToParagraphHtml } from "../../core/utils.js";
import { fetchPostsViaApi } from "./graphApi.js";
import {
  extractFirstImageUrl,
  extractFacebookLinkFromCandidate,
  extractFacebookLinkFromHtmlBlob,
  extractFacebookPageFallbackFromCandidates,
} from "./linkExtraction.js";
import { extractFacebookAlbumLinkFromImageUrls, extractFacebookPostLinkFromCandidates } from "./linkExtraction.js";
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

  private buildGroupUrl(groupId: string): string {
    return `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL`;
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

  private getUnresolvedDumpFile(): string | null {
    const configured = this.config.options.unresolvedDumpFile as string | undefined;
    if (configured && configured.trim()) return configured.trim();
    const envConfigured = process.env.FACEBOOK_UNRESOLVED_DUMP_FILE;
    return envConfigured && envConfigured.trim() ? envConfigured.trim() : null;
  }

  private async dumpUnresolvedFixture(item: NormalizedItem, postIndex: number, groupUrl: string): Promise<void> {
    if (!this.page) return;
    const dumpFile = this.getUnresolvedDumpFile();
    if (!dumpFile) return;

    const dumpPayload = await this.page.evaluate((idx: number) => {
      const screenRoot = document.getElementById("screen-root");
      const mainDiv = screenRoot?.children[0];
      if (!mainDiv) return null;
      let scrollDiv: Element | null = null;
      for (let i = 0; i < mainDiv.children.length; i++) {
        const child = mainDiv.children[i];
        if ((child.textContent || "").trim().length > 200) {
          scrollDiv = child;
          break;
        }
      }
      if (!scrollDiv || !scrollDiv.children[idx]) return null;
      const postEl = scrollDiv.children[idx] as HTMLElement;
      const candidates: string[] = [];
      const addCandidate = (value: string | null) => {
        if (!value) return;
        const trimmed = value.trim();
        if (!trimmed) return;
        candidates.push(trimmed);
      };
      const anchors = Array.from(postEl.querySelectorAll("a"));
      for (const anchor of anchors) {
        addCandidate(anchor.getAttribute("href"));
        if (anchor instanceof HTMLAnchorElement) {
          addCandidate(anchor.href || null);
        }
        addCandidate(anchor.getAttribute("data-lynx-uri"));
        addCandidate(anchor.getAttribute("ajaxify"));
      }
      return {
        candidateUrls: Array.from(new Set(candidates)),
        domText: (postEl.textContent || "").trim(),
        domHtml: postEl.innerHTML || "",
      };
    }, postIndex);

    if (!dumpPayload) return;

    appendJsonLine(dumpFile, {
      timestamp: new Date().toISOString(),
      sourcePostId: item.sourceId,
      postIndex,
      groupUrl,
      contentText: item.contentText,
      contentHtml: item.contentHtml,
      mediaUrls: item.mediaUrls,
      candidateUrls: dumpPayload.candidateUrls,
      domText: dumpPayload.domText,
      domHtml: dumpPayload.domHtml,
    });
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

    const scrollLimit = (this.config.options.scrollAttempts as number) || 30;
    const maxCollected = (this.config.options.maxCollectedPosts as number) || 60;
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

          // Filter: only include posts with meaningful content (>15 chars) or with images
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

        if (!link) {
          for (const raw of post.urlCandidates) {
            const extracted = extractFacebookLinkFromCandidate(raw);
            if (!extracted.link) continue;
            link = extracted.link;
            break;
          }
        }

        if (!link && post.htmlBlob) {
          const extracted = extractFacebookLinkFromHtmlBlob(post.htmlBlob);
          if (extracted.link) {
            link = extracted.link;
          }
        }

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

    // Mobile Facebook often hides outbound URLs behind clickable media.
    // Resolve links across the same bounded set of posts collected from the feed,
    // not just the first 25 unresolved items, or later posts will never be tried.
    // Only attempt items flagged needsLinkResolve (have a content image) to avoid
    // clicking non-post header elements.
    const resolveLimit = (this.config.options.maxCollectedPosts as number) || 60;
    const itemsNeedingLinks = items
      .filter((i) => !i.link && i.rawPayload?.needsLinkResolve)
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
      try {
        const postIndex = item.rawPayload?.index as number;
        if (postIndex === undefined || postIndex === null) continue;

        // Scroll post into view first (unconditionally), then get image click position.
        // Must scroll BEFORE checking rect dimensions — after 30+ feed scrolls, early posts
        // are far above the viewport and their images report rect.width=0 until scrolled in.
        const scrolled = await this.page.evaluate((idx: number) => {
          const screenRoot = document.getElementById("screen-root");
          if (!screenRoot) return { ok: false, reason: "no screen-root" };
          const mainDiv = screenRoot.children[0];
          if (!mainDiv) return { ok: false, reason: "no mainDiv" };
          let scrollDiv: Element | null = null;
          for (let i = 0; i < mainDiv.children.length; i++) {
            const child = mainDiv.children[i];
            if ((child.textContent || "").trim().length > 200) {
              scrollDiv = child;
              break;
            }
          }
          if (!scrollDiv) return { ok: false, reason: "no scrollDiv" };
          const postEl = scrollDiv.children[idx] as HTMLElement | undefined;
          if (!postEl) return { ok: false, reason: `no element at idx ${idx}`, total: scrollDiv.children.length };
          // Scroll the LARGEST content image into view so getBoundingClientRect returns non-zero dimensions
          const allImgs = postEl.querySelectorAll("img[src*='scontent'], img[src*='fbcdn']");
          let largestImg: HTMLElement | null = null;
          let largestWidth = 0;
          for (const img of Array.from(allImgs)) {
            const src = img.getAttribute("src") || "";
            if (src.includes("rsrc.php") || src.includes("emoji")) continue;
            const w = (img as HTMLElement).offsetWidth || (img as HTMLElement).getBoundingClientRect().width;
            if (w > largestWidth) {
              largestWidth = w;
              largestImg = img as HTMLElement;
            }
          }
          if (largestImg) {
            largestImg.scrollIntoView({ block: "center" });
            return { ok: true, scrollDivLen: scrollDiv.children.length, scrollDivScrollTop: (scrollDiv as HTMLElement).scrollTop };
          }
          // No content image — scroll the post element itself into view
          postEl.scrollIntoView({ block: "center" });
          return { ok: true, noImg: true, scrollDivLen: scrollDiv.children.length };
        }, postIndex);

        context.logger.info({ id: item.sourceId, postIndex, scrolled }, "resolveLinks: scrollIntoView result");

        if (!scrolled || !(scrolled as { ok?: boolean }).ok) continue;

        // Wait for image to render now that it's in the viewport
        await sleep(1200);

        // Get click position after element is in view

          // Try href-based extraction first — album/carousel posts have fbid in <a href>
          // even though clicking the images navigates to home (no click needed)
          const hrefLink = await this.page.evaluate((idx: number) => {
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
            const anchors = Array.from(postEl.querySelectorAll("a[href]"));
            for (const anchor of anchors) {
              const href = anchor.getAttribute("href") || "";
              if (/fbid=\d+|photo\.php/.test(href)) {
                try {
                  return new URL(href, "https://www.facebook.com").href;
                } catch {
                  return href;
                }
              }
            }
            return null;
          }, postIndex);

          // If no href with fbid found, try data-action-id elements which may contain anchors with fbid
          let hrefLinkAlt = null;
          if (!hrefLink) {
            hrefLinkAlt = await this.page.evaluate((idx: number) => {
              const screenRoot = document.getElementById("screen-root");
              const mainDiv = screenRoot?.children[0];
              if (!mainDiv) return null;
              let scrollDiv = null;
              for (let i = 0; i < mainDiv.children.length; i++) {
                const child = mainDiv.children[i];
                if ((child.textContent || "").trim().length > 200) {
                  scrollDiv = child;
                  break;
                }
              }
              if (!scrollDiv || !scrollDiv.children[idx]) return null;
              const postEl = scrollDiv.children[idx] as Element;
              // For album posts: each image tile is in a <div data-action-id> ancestor
              // Check if that action el or its children have an anchor with fbid
              const actionEls = Array.from(postEl.querySelectorAll("[data-action-id]"));
              for (const actionEl of actionEls) {
                const childAnchors = Array.from(actionEl.querySelectorAll("a[href]"));
                for (const anchor of childAnchors) {
                  const href = anchor.getAttribute("href") || "";
                  if (/fbid=\d+|photo\.php/.test(href)) {
                    try {
                      return new URL(href, "https://www.facebook.com").href;
                    } catch {
                      return href;
                    }
                  }
                }
              }
              return null;
            }, postIndex);
          }

          const resolvedHref = hrefLink || hrefLinkAlt;
          if (resolvedHref) {
            item.link = resolvedHref;
            context.logger.info({ id: item.sourceId, link: resolvedHref, method: hrefLink ? "direct" : "actionEl" }, "Resolved photo link from href");
            continue;
          }

            // Debug probe: log all hrefs found in this post element (only for items that end up
            // going to home during click-resolution, i.e., album posts). Remove once investigated.
            if (this.config.options?.debugHrefs) {
              const allHrefs = await this.page.evaluate((idx: number) => {
                const screenRoot = document.getElementById("screen-root");
                const mainDiv = screenRoot?.children[0];
                if (!mainDiv) return [];
                let scrollDiv: Element | null = null;
                for (let i = 0; i < mainDiv.children.length; i++) {
                  const child = mainDiv.children[i];
                  if ((child.textContent || "").trim().length > 200) { scrollDiv = child; break; }
                }
                if (!scrollDiv) return [];
                const postEl = scrollDiv.children[idx];
                if (!postEl) return [];
                return Array.from(postEl.querySelectorAll("a[href]")).map(a => a.getAttribute("href") || "").filter(Boolean);
              }, postIndex);
              context.logger.info({ id: item.sourceId, postIndex, allHrefs }, "resolveLinks: all hrefs in post");
            }
            // Get click position after element is in view
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
          const imgWidths: number[] = [];
          const candidates: Array<{ x: number; y: number; w: number; h: number; actionId: string | null }> = [];
          for (const img of Array.from(allImgs)) {
            const src = img.getAttribute("src") || "";
            if (src.includes("rsrc.php") || src.includes("emoji")) continue;
            const rect = img.getBoundingClientRect();
            imgWidths.push(rect.width);
            if (rect.width > 80) {
              let actionEl: HTMLElement | null = null;
              let parent = img.parentElement;
              while (parent && parent !== postEl) {
                if (parent.getAttribute("data-action-id")) {
                  actionEl = parent as HTMLElement;
                  break;
                }
                parent = parent.parentElement;
              }
              const targetRect = actionEl?.getBoundingClientRect() ?? rect;
              candidates.push({
                x: targetRect.x + targetRect.width / 2,
                y: targetRect.y + targetRect.height / 2,
                w: targetRect.width,
                h: targetRect.height,
                actionId: actionEl?.getAttribute("data-action-id") ?? null,
              });
            }
          }
          candidates.sort((a, b) => {
            const areaDiff = b.w * b.h - a.w * a.h;
            if (areaDiff !== 0) return areaDiff;
            return b.w - a.w;
          });
          const uniqueCandidates = candidates.filter((candidate, index, arr) => {
            return arr.findIndex((other) => Math.abs(other.x - candidate.x) < 2 && Math.abs(other.y - candidate.y) < 2) === index;
          });
          if (uniqueCandidates.length > 0) {
            return {
              x: uniqueCandidates[0].x,
              y: uniqueCandidates[0].y,
              w: uniqueCandidates[0].w,
              imgWidths,
              candidates: uniqueCandidates.slice(0, 2), // max 2 candidates — album posts won't resolve via clicking anyway
            };
          }
          return { noMatch: true, imgWidths };
        }, postIndex);

        if (!clickPos || (clickPos as { noMatch?: boolean }).noMatch) {
          context.logger.info({ id: item.sourceId, postIndex, clickPos }, "resolveLinks: no clickable image found");
          continue;
        }

        let resolved = false;
        const candidates = ((clickPos as { candidates?: Array<{ x: number; y: number; w: number; actionId?: string | null }> }).candidates || [clickPos as { x: number; y: number; w: number; actionId?: string | null }]);
        for (const candidate of candidates) {
          context.logger.info({ id: item.sourceId, postIndex, x: candidate.x, y: candidate.y, w: candidate.w, actionId: candidate.actionId ?? null }, "resolveLinks: clicking image");

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

          if (candidate.actionId) {
            await this.page.evaluate((idx: number, actionId: string) => {
              const screenRoot = document.getElementById("screen-root");
              const mainDiv = screenRoot?.children[0];
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
              const postEl = scrollDiv.children[idx] as HTMLElement | undefined;
              if (!postEl) return;
              const actionEl = Array.from(postEl.querySelectorAll("[data-action-id]")).find(
                (el) => el.getAttribute("data-action-id") === actionId,
              );
              if (actionEl instanceof HTMLElement) {
                actionEl.scrollIntoView({ block: "center" });
                actionEl.click();
              }
            }, postIndex, candidate.actionId);
          } else {
            await this.page.mouse.click(candidate.x, candidate.y);
          }
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
              context.logger.debug({ id: item.sourceId, link: item.link }, "Resolved Instagram link");
            } else if (igReelMatch) {
              item.link = `https://www.instagram.com/reel/${igReelMatch[1]}/`;
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
              context.logger.info({ id: item.sourceId, link: item.link }, "Resolved external link");
            }
            resolved = true;
            break;
          }

          const currentUrl = this.page.url();
          context.logger.info({ id: item.sourceId, currentUrl: currentUrl.substring(0, 80) }, "resolveLinks: page URL after click");

          const groupBasePath = groupUrl.split("?")[0].replace(/\/$/, "");
          const isGroupSubPage = currentUrl.replace(/\?.*/, "").replace(/\/$/, "").startsWith(groupBasePath);
          const didNavigate = currentUrl !== groupUrl && !currentUrl.startsWith(groupUrl);

          if (!didNavigate || isGroupSubPage) {
            if (isGroupSubPage && currentUrl !== groupUrl) {
              context.logger.info({ id: item.sourceId }, "resolveLinks: group sub-page, going back");
              await this.page.goBack({ waitUntil: "networkidle2" }).catch(() => {});
              await sleep(2000);
            }
            continue;
          }

          if (this.isHomeOrLoginLikePage(currentUrl)) {
            context.logger.info({ id: item.sourceId, link: currentUrl }, "Ignoring home/login-like in-page redirect");
            await this.page.goBack({ waitUntil: "networkidle2" }).catch(() => {});
            await sleep(2000);
            break; // album/carousel posts won't resolve via clicking — don't waste time on further candidates
          }
          const fbidMatch = currentUrl.match(/fbid=(\d+)/);
          const permalinkMatch = currentUrl.match(/permalink\/(\d+)/);
          if (fbidMatch) {
            item.link = currentUrl;
            context.logger.info({ id: item.sourceId, link: currentUrl.substring(0, 80) }, "Resolved photo link");
          } else if (permalinkMatch) {
            item.link = currentUrl;
            context.logger.info({ id: item.sourceId, link: currentUrl.substring(0, 80) }, "Resolved permalink link");
          } else {
            item.link = currentUrl;
            context.logger.info({ id: item.sourceId, link: currentUrl.substring(0, 80) }, "Resolved link");
          }
          await this.page.goBack({ waitUntil: "networkidle2" });
          await sleep(2000);
          resolved = true;
          break;
        }

        if (!resolved) {
          // Fallback: extract links from post DOM when media clicks fail (shared/album posts).
          // Shared posts contain anchors pointing to the original post (photo, permalink, etc.)
          // that we can extract without relying on image-click navigation.
          // NOTE: extraction functions run in Node.js, not inside page.evaluate, because they
          // are not available in the browser context.
          const candidateHrefs = await this.page.evaluate((idx: number) => {
            const screenRoot = document.getElementById("screen-root");
            const mainDiv = screenRoot?.children[0];
            if (!mainDiv) return [];
            let scrollDiv: Element | null = null;
            for (let i = 0; i < mainDiv.children.length; i++) {
              const child = mainDiv.children[i];
              if ((child.textContent || "").trim().length > 200) {
                scrollDiv = child;
                break;
              }
            }
            if (!scrollDiv || !scrollDiv.children[idx]) return [];
            const postEl = scrollDiv.children[idx];
            if (!postEl) return [];

            const hrefs: string[] = [];
            const anchors = Array.from(postEl.querySelectorAll("a[href]"));
            for (const anchor of anchors) {
              const href = anchor.getAttribute("href");
              if (href) hrefs.push(href);
              const lynx = anchor.getAttribute("data-lynx-uri");
              if (lynx) hrefs.push(lynx);
              const ajaxify = anchor.getAttribute("ajaxify");
              if (ajaxify) hrefs.push(ajaxify);
            }
            return hrefs;
          }, postIndex);

          const postLink = extractFacebookPostLinkFromCandidates(candidateHrefs);
          if (postLink) {
            item.link = postLink;
            context.logger.info({ id: item.sourceId, link: postLink }, "Resolved post link from href (shared post fallback)");
          } else {
            const albumLink = extractFacebookAlbumLinkFromImageUrls(item.mediaUrls ?? []);
            if (albumLink) {
              item.link = albumLink;
              context.logger.info({ id: item.sourceId, link: albumLink }, "Resolved album photo link from image URLs (fallback)");
            } else {
            const pageLink = extractFacebookPageFallbackFromCandidates(candidateHrefs);
            if (pageLink) {
              item.link = pageLink;
              context.logger.info({ id: item.sourceId, link: pageLink }, "Resolved page link from post content (fallback)");
            } else {
            const firstImage = extractFirstImageUrl(item.mediaUrls ?? []);
            if (firstImage) {
              item.link = firstImage;
              context.logger.info({ id: item.sourceId, link: firstImage }, "Resolved link from first image URL (fallback)");
            } else {
              await this.dumpUnresolvedFixture(item, postIndex, groupUrl);
            }
          }
          }
          }
          continue;
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
