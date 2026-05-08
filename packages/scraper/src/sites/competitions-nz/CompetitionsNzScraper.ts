import type { ElementHandle, Page } from "puppeteer";
import { canonicalizeUrl, SiteScraper, type NormalizedItem, type ScraperContext } from "../../core/index.js";
import { textToParagraphHtml } from "../../core/utils.js";

const COMPETITIONS_NZ_BASE_URL = "https://www.competitions.co.nz";
const COMPETITIONS_NZ_LOGIN_URL = `${COMPETITIONS_NZ_BASE_URL}/login/`;
const COMPETITIONS_CARD_SELECTOR = "article.competition-card";
const COMPETITIONS_NZ_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface CompetitionsNzRawCard {
  position: number;
  title: string | null;
  urlCandidates: string[];
  brandName: string | null;
  categoryNames: string[];
  badgeTexts: string[];
  endsText: string | null;
  imageUrl: string | null;
  dataType?: string | null;
  dataEndingSoon?: string | null;
}

interface CompetitionsNzPaginationLink {
  href: string;
  text: string;
  rel: string;
  className: string;
}

interface CompetitionsNzExtractResult {
  cards: CompetitionsNzRawCard[];
  currentUrl: string;
  paginationLinks: CompetitionsNzPaginationLink[];
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function canonicalizeCompetitionsNzUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, COMPETITIONS_NZ_BASE_URL);
    if (parsed.hostname !== "www.competitions.co.nz" && parsed.hostname !== "competitions.co.nz") {
      return null;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    if (!/^\/win-[^/]+\/\d+$/.test(pathname)) {
      return null;
    }

    return canonicalizeUrl(`${parsed.origin}${pathname}/`);
  } catch {
    return null;
  }
}

export function toCompetitionsNzExitUrl(rawUrl: string): string | null {
  const canonical = canonicalizeCompetitionsNzUrl(rawUrl);
  if (!canonical) {
    return null;
  }

  const parsed = new URL(canonical);
  return `${parsed.origin}/exit${parsed.pathname}/`;
}

export function selectCompetitionsNzNextPageUrl(
  links: CompetitionsNzPaginationLink[],
  currentUrl: string,
): string | null {
  for (const link of links) {
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(link.href, currentUrl).toString();
    } catch {
      continue;
    }

    if (absoluteUrl === currentUrl) {
      continue;
    }

    const rel = link.rel.toLowerCase();
    const text = link.text.toLowerCase();
    const className = link.className.toLowerCase();
    const isNext = rel.includes("next")
      || text === "next"
      || text.startsWith("next ")
      || className.includes("next");

    if (isNext) {
      return absoluteUrl;
    }
  }

  return null;
}

export async function resolveCompetitionsNzDestinationUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const canonical = canonicalizeCompetitionsNzUrl(rawUrl);
  if (!canonical) {
    return null;
  }

  const exitUrl = toCompetitionsNzExitUrl(canonical);
  if (!exitUrl) {
    return canonical;
  }

  try {
    const redirectResponse = await fetchImpl(exitUrl, {
      redirect: "manual",
      headers: {
        "user-agent": COMPETITIONS_NZ_USER_AGENT,
      },
    });

    const locationHeader = redirectResponse.headers.get("location");
    if (locationHeader) {
      const redirectedUrl = canonicalizeUrl(new URL(locationHeader, exitUrl).toString(), { preserveHash: true });
      const redirectedHost = new URL(redirectedUrl).hostname;
      if (redirectedHost !== "www.competitions.co.nz" && redirectedHost !== "competitions.co.nz") {
        return redirectedUrl;
      }
    }

    const response = await fetchImpl(exitUrl, {
      redirect: "follow",
      headers: {
        "user-agent": COMPETITIONS_NZ_USER_AGENT,
      },
    });

    const resolvedUrl = canonicalizeUrl(response.url || exitUrl, { preserveHash: true });
    if (!resolvedUrl) {
      return canonical;
    }

    const resolvedHost = new URL(resolvedUrl).hostname;
    if (resolvedHost === "www.competitions.co.nz" || resolvedHost === "competitions.co.nz") {
      return canonical;
    }

    return resolvedUrl;
  } catch {
    return canonical;
  }
}

function buildCompetitionSummary(card: CompetitionsNzRawCard): string | null {
  const summaryParts: string[] = [];
  const filteredBadges = card.badgeTexts.filter(
    (badge) => !/^(ends soon|purchase required)$/i.test(badge)
  );

  if (filteredBadges.length > 0) {
    summaryParts.push(filteredBadges.join(" | "));
  }
  if (card.categoryNames.length > 0) {
    summaryParts.push(card.categoryNames.join(", "));
  }
  if (card.endsText) {
    summaryParts.push(card.endsText);
  }

  return summaryParts.length > 0 ? summaryParts.join(" | ") : card.title;
}

export function normalizeCompetitionsNzCards(cards: CompetitionsNzRawCard[], siteId: string): NormalizedItem[] {
  const seenLinks = new Set<string>();
  const items: NormalizedItem[] = [];

  for (const card of cards) {
    if (card.badgeTexts.some((badge) => /purchase required/i.test(badge))) {
      continue;
    }

    const link = card.urlCandidates
      .map((candidate) => canonicalizeCompetitionsNzUrl(candidate))
      .find((candidate): candidate is string => Boolean(candidate));

    if (!link || seenLinks.has(link)) {
      continue;
    }
    seenLinks.add(link);

    const idMatch = link.match(/\/(\d+)\/?$/);
    const summary = buildCompetitionSummary(card);
    items.push({
      sourceId: `${siteId}_${idMatch?.[1] ?? card.position}`,
      sourceSite: siteId,
      title: card.title,
      contentText: summary,
      contentHtml: textToParagraphHtml(summary),
      authorName: card.brandName,
      link,
      mediaUrls: card.imageUrl ? [card.imageUrl] : [],
      publishedAt: new Date(),
      rawPayload: {
        position: card.position,
        badgeTexts: card.badgeTexts,
        endsText: card.endsText,
      },
    });
  }

  return items;
}

export class CompetitionsNzScraper extends SiteScraper {
  private page?: Page;
  private listingLoaded = false;
  private usePagingFallback = true;
  private nextPageUrl: string | null = null;
  private seenSourceIds = new Set<string>();

  canHandle(source: string): boolean {
    return source === "competitions-nz" || source.includes("competitions.co.nz");
  }

  async init(context: ScraperContext): Promise<void> {
    context.logger.info({ site: this.config.siteId }, "Initializing Competitions NZ scraper");
    this.page = await context.browser.newPage();
    await this.page.setViewport({ width: 1440, height: 2200 });
    await this.page.setUserAgent(COMPETITIONS_NZ_USER_AGENT);
  }

  private async firstAvailableSelector(selectors: string[]): Promise<string> {
    if (!this.page) throw new Error("Page not initialized");

    for (const selector of selectors) {
      if (await this.page.$(selector)) {
        return selector;
      }
    }

    throw new Error(`Expected one of selectors: ${selectors.join(", ")}`);
  }

  private async findClickableByText(pattern: RegExp): Promise<ElementHandle<Element> | null> {
    if (!this.page) throw new Error("Page not initialized");

    const handle = await this.page.evaluateHandle(
      ({ source, flags }) => {
        const regex = new RegExp(source, flags);
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
        return candidates.find((candidate) => regex.test((candidate.textContent || "").trim())) ?? null;
      },
      { source: pattern.source, flags: pattern.flags }
    );

    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }

    return element as ElementHandle<Element>;
  }

  private async findVisibleSortControl(maxTop = 1400): Promise<ElementHandle<Element> | null> {
    if (!this.page) throw new Error("Page not initialized");

    const handle = await this.page.evaluateHandle((topLimit) => {
      const labels = ["Newest", "Popular", "Ending Soon", "Prize Value"];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role='button']"));

      const normalizedText = (value: string) => value.replace(/\s+/g, " ").trim();
      for (const candidate of candidates) {
        const text = normalizedText(candidate.textContent || "");
        if (!labels.includes(text)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        if (rect.top < 0 || rect.top > topLimit) {
          continue;
        }

        return candidate;
      }

      return null;
    }, maxTop);

    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }

    return element as ElementHandle<Element>;
  }

  private async readElementText(element: ElementHandle<Element>): Promise<string> {
    if (!this.page) throw new Error("Page not initialized");

    return this.page.evaluate(
      (node) => (node.textContent || "").replace(/\s+/g, " ").trim(),
      element,
    );
  }

  private async ensureNewestSort(context: ScraperContext): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    const sortControl = await this.findVisibleSortControl();
    if (!sortControl) {
      context.logger.warn("Competitions NZ sort control not found; continuing with site default ordering");
      return;
    }

    const currentSort = await this.readElementText(sortControl);
    if (/^newest$/i.test(currentSort)) {
      context.logger.info({ sort: currentSort }, "Competitions NZ sort is already Newest");
      await sortControl.dispose();
      return;
    }

    await sortControl.click();
    await sortControl.dispose();

    const newestOption = await this.findClickableByText(/^newest$/i);
    if (!newestOption) {
      context.logger.warn({ currentSort }, "Could not find Newest option after opening sort control");
      return;
    }

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => null),
      newestOption.click(),
    ]);
    await newestOption.dispose();

    const appliedSort = await this.findVisibleSortControl();
    if (!appliedSort) {
      context.logger.warn("Could not verify Competitions NZ sort after selection");
      return;
    }

    const appliedSortText = await this.readElementText(appliedSort);
    await appliedSort.dispose();
    context.logger.info({ sort: appliedSortText }, "Applied Competitions NZ sort setting");
  }

  private async login(context: ScraperContext): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    const username = this.config.options.competitionsNzUsername as string | undefined;
    const password = this.config.options.competitionsNzPassword as string | undefined;
    if (!username || !password) {
      throw new Error("COMPETITIONS_NZ_USERNAME and COMPETITIONS_NZ_PASSWORD are required");
    }

    await this.page.goto(COMPETITIONS_NZ_LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
    const emailSelector = await this.firstAvailableSelector([
      "input[placeholder='your@email.com']",
      "input[type='email']",
      "input[name='email']",
    ]);
    const passwordSelector = await this.firstAvailableSelector([
      "input[placeholder='Enter your password']",
      "input[type='password']",
      "input[name='password']",
    ]);

    await this.page.click(emailSelector, { clickCount: 3 });
    await this.page.type(emailSelector, username, { delay: 20 });
    await this.page.click(passwordSelector, { clickCount: 3 });
    await this.page.type(passwordSelector, password, { delay: 20 });

    const signInButton = await this.findClickableByText(/sign in/i);
    if (!signInButton) {
      throw new Error("Could not find the Competitions NZ sign-in button");
    }

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      signInButton.click(),
    ]);
    await signInButton.dispose();
  }

  async fetchListing(context: ScraperContext): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");
    if (this.listingLoaded) return;

    await this.login(context);

    const sourceUrl = (this.config.options.sourceUrl as string | undefined) || `${COMPETITIONS_NZ_BASE_URL}/`;
    await this.page.goto(sourceUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await this.page.waitForSelector(COMPETITIONS_CARD_SELECTOR, { timeout: 60000 });
    await this.ensureNewestSort(context);
    await this.page.waitForSelector(COMPETITIONS_CARD_SELECTOR, { timeout: 60000 });
    context.logger.info("Collecting all competitions with pagination; excluding only Purchase Required entries");
    this.usePagingFallback = true;
    this.nextPageUrl = null;
    this.listingLoaded = true;
  }

  async extractItems(context: ScraperContext): Promise<NormalizedItem[]> {
    if (!this.page) throw new Error("Page not initialized");

    const extraction = await this.page.evaluate((): CompetitionsNzExtractResult => {
      const articles = Array.from(document.querySelectorAll<HTMLElement>("article.competition-card"));

      const cards = articles.map((article, index) => {
        const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>("a[href]"));
        const competitionAnchors = anchors.filter((anchor) => {
          const href = anchor.getAttribute("href") || "";
          return href.includes("/win-") || href.includes("/exit/");
        });
        const brandAnchor = anchors.find((anchor) => (anchor.getAttribute("href") || "").includes("/brands/"));
        const categoryAnchors = anchors.filter((anchor) => {
          const href = anchor.getAttribute("href") || "";
          return href.startsWith("/")
            && !href.includes("/win-")
            && !href.includes("/exit/")
            && !href.includes("/brands/")
            && !href.includes("/register")
            && !href.includes("/login");
        });
        const fullText = (article.textContent || "").replace(/\s+/g, " ").trim();
        const endsMatch = fullText.match(/Ends(?: in)? [A-Za-z0-9 ]+/i);
        const badgePatterns = [
          /ENDS SOON/i,
          /Purchase Required/i,
          /Free Entry/i,
          /Quiz Entry/i,
          /25 Words or Less/i,
          /Codeword Entry/i,
          /Creative Entry/i,
          /Social Media/i,
        ];
        const badgeTexts = badgePatterns
          .map((pattern) => fullText.match(pattern)?.[0] || null)
          .filter((value): value is string => Boolean(value));

        return {
          position: index,
          title: competitionAnchors.find((anchor) => {
            const text = (anchor.textContent || "").trim();
            return text !== "" && !/^details$/i.test(text);
          })?.textContent?.trim() || null,
          urlCandidates: competitionAnchors.map((anchor) => anchor.href),
          brandName: brandAnchor?.textContent?.trim() || null,
          categoryNames: categoryAnchors
            .map((anchor) => anchor.textContent?.trim() || "")
            .filter((value) => value !== ""),
          badgeTexts,
          endsText: endsMatch?.[0] || null,
          imageUrl: article.querySelector("img")?.getAttribute("src") || null,
          dataType: article.getAttribute("data-type"),
          dataEndingSoon: article.getAttribute("data-ending-soon"),
        };
      });

      const paginationLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((anchor) => ({
          href: anchor.getAttribute("href") || "",
          text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
          rel: anchor.getAttribute("rel") || "",
          className: anchor.className || "",
        }))
        .filter((link) => link.href !== "");

      return {
        cards,
        currentUrl: window.location.href,
        paginationLinks,
      };
    });

    const items = normalizeCompetitionsNzCards(
      extraction.cards.map((card) => ({
        ...card,
        categoryNames: dedupeStrings(card.categoryNames),
        badgeTexts: dedupeStrings(card.badgeTexts),
        urlCandidates: dedupeStrings(card.urlCandidates),
      })),
      this.config.siteId,
    );

    this.nextPageUrl = this.usePagingFallback
      ? selectCompetitionsNzNextPageUrl(extraction.paginationLinks, extraction.currentUrl)
      : null;

    const dedupedItems = items.filter((item) => {
      if (this.seenSourceIds.has(item.sourceId)) {
        return false;
      }
      this.seenSourceIds.add(item.sourceId);
      return true;
    });

    context.logger.info({ count: dedupedItems.length, nextPageUrl: this.nextPageUrl }, "Extracted Competitions NZ items");
    return dedupedItems;
  }

  async resolveLinks(context: ScraperContext, items: NormalizedItem[]): Promise<void> {
    for (const item of items) {
      if (!item.link) {
        continue;
      }

      const originalLink = item.link;
      const resolvedLink = await resolveCompetitionsNzDestinationUrl(originalLink);
      if (resolvedLink && resolvedLink !== originalLink) {
        item.link = resolvedLink;
        item.rawPayload = {
          ...(item.rawPayload ?? {}),
          sourceLink: originalLink,
        };
      }
    }

    context.logger.debug({ count: items.length }, "Competitions NZ links resolved through exit URLs");
  }

  async hasMorePages(_context: ScraperContext): Promise<boolean> {
    return this.usePagingFallback && Boolean(this.nextPageUrl);
  }

  async nextPage(_context: ScraperContext): Promise<void> {
    if (!this.page || !this.nextPageUrl) {
      return;
    }

    const destination = this.nextPageUrl;
    this.nextPageUrl = null;
    await this.page.goto(destination, { waitUntil: "networkidle2", timeout: 60000 });
    await this.page.waitForSelector(COMPETITIONS_CARD_SELECTOR, { timeout: 60000 });
  }

  async shutdown(context: ScraperContext): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => undefined);
      this.page = undefined;
    }
    this.listingLoaded = false;
    this.usePagingFallback = false;
    this.nextPageUrl = null;
    this.seenSourceIds.clear();
    context.logger.debug({ site: this.config.siteId }, "Competitions NZ scraper shutdown complete");
  }
}