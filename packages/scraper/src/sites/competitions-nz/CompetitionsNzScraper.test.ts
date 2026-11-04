import { describe, expect, it, vi } from "vitest";
import {
  CompetitionsNzScraper,
  canonicalizeCompetitionsNzUrl,
  isCompetitionsNzAuthenticated,
  normalizeCompetitionsNzCards,
  resolveCompetitionsNzDestinationUrl,
  selectCompetitionsNzNextPageUrl,
  toCompetitionsNzExitUrl,
  type CompetitionsNzRawCard,
} from "./CompetitionsNzScraper.js";
import type { NormalizedItem, ScraperContext, SiteConfig } from "../../core/types.js";

function makeResponse(options: {
  status: number;
  ok: boolean;
  url?: string;
  location?: string;
  cancelBody?: () => Promise<void>;
}): Response {
  return {
    status: options.status,
    ok: options.ok,
    url: options.url ?? "",
    headers: {
      get: (name: string) => (name.toLowerCase() === "location" ? options.location ?? null : null),
    },
    body: options.cancelBody ? { cancel: options.cancelBody } : null,
  } as unknown as Response;
}

describe("canonicalizeCompetitionsNzUrl", () => {
  it("keeps canonical competition detail URLs", () => {
    expect(canonicalizeCompetitionsNzUrl("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/")).toBe(
      "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293"
    );
  });

  it("drops exit URLs", () => {
    expect(canonicalizeCompetitionsNzUrl("https://www.competitions.co.nz/exit/win-wagner-dyi-bundle/38293/")).toBeNull();
  });

  it("builds exit URLs from canonical competition detail URLs", () => {
    expect(toCompetitionsNzExitUrl("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/")).toBe(
      "https://www.competitions.co.nz/exit/win-wagner-dyi-bundle/38293/"
    );
  });
});

describe("resolveCompetitionsNzDestinationUrl", () => {
  it("follows exit URLs and returns the final external destination", async () => {
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse({
        status: 302,
        ok: false,
        location: "https://www.wagneraustralia.com.au/mothers-day-2026/#",
        cancelBody,
      }));

    await expect(
      resolveCompetitionsNzDestinationUrl(
        "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
        fetchMock,
      )
    ).resolves.toBe("https://www.wagneraustralia.com.au/mothers-day-2026/#");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.competitions.co.nz/exit/win-wagner-dyi-bundle/38293/",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("falls back to the competitions detail URL when resolution stays on competitions.co.nz", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse({
        status: 302,
        ok: false,
        location: "https://www.competitions.co.nz/register/?return=%2Fexit%2Fwin%2Dwagner%2Ddyi%2Dbundle%2F38293%2F",
      }))
      .mockResolvedValueOnce(makeResponse({
        status: 200,
        ok: true,
        url: "https://www.competitions.co.nz/register/?return=%2Fexit%2Fwin%2Dwagner%2Ddyi%2Dbundle%2F38293%2F",
      }));

    await expect(
      resolveCompetitionsNzDestinationUrl(
        "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
        fetchMock,
      )
    ).resolves.toBe("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293");
  });

  it("uses the final URL from followed external redirects and releases both response bodies", async () => {
    const cancelManual = vi.fn().mockResolvedValue(undefined);
    const cancelFollowed = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse({ status: 200, ok: true, cancelBody: cancelManual }))
      .mockResolvedValueOnce(makeResponse({
        status: 200,
        ok: true,
        url: "https://brand.example/entry",
        cancelBody: cancelFollowed,
      }));

    await expect(resolveCompetitionsNzDestinationUrl(
      "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
      fetchMock,
    )).resolves.toBe("https://brand.example/entry");
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ redirect: "follow" }));
    expect(cancelManual).toHaveBeenCalledTimes(1);
    expect(cancelFollowed).toHaveBeenCalledTimes(1);
  });

  it.each(["manual", "followed"] as const)("rejects unsuccessful %s HTTP responses", async (responseType) => {
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const failedResponse = makeResponse({ status: 500, ok: false, cancelBody });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseType === "manual"
        ? failedResponse
        : makeResponse({ status: 200, ok: true }))
      .mockResolvedValueOnce(failedResponse);

    await expect(resolveCompetitionsNzDestinationUrl(
      "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
      fetchMock,
    )).rejects.toThrow("HTTP 500");
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("times out a destination request that never resolves", async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(resolveCompetitionsNzDestinationUrl(
      "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
      fetchMock,
      undefined,
      5,
    )).rejects.toThrow("Destination request timed out after 5ms");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("propagates job cancellation to the active destination request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const resolution = resolveCompetitionsNzDestinationUrl(
      "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
      fetchMock,
      controller.signal,
      1000,
    );
    const cancellation = new Error("job cancelled");
    controller.abort(cancellation);

    await expect(resolution).rejects.toThrow(cancellation);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("logs lookup failures and retains the source link", async () => {
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse({ status: 500, ok: false, cancelBody }));
    const warn = vi.fn();
    const context = {
      jobId: "job-1",
      signal: new AbortController().signal,
      logger: { debug: vi.fn(), warn },
    } as unknown as ScraperContext;
    const config: SiteConfig = {
      siteId: "competitions-nz",
      name: "Competitions NZ",
      enabled: true,
      options: {},
    };
    const item: NormalizedItem = {
      sourceId: "competition-38293",
      sourceSite: "competitions-nz",
      title: "Win a prize",
      contentText: null,
      contentHtml: null,
      authorName: null,
      link: "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293",
      mediaUrls: [],
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    vi.stubGlobal("fetch", fetchMock);
    try {
      await new CompetitionsNzScraper(config).resolveLinks(context, [item]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(item.link).toBe("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        site: "competitions-nz",
        jobId: "job-1",
        sourceId: "competition-38293",
        error: "Manual destination lookup returned HTTP 500",
      }),
      "Failed to resolve competition destination; keeping source link"
    );
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });
});

describe("selectCompetitionsNzNextPageUrl", () => {
  it("selects next URL from rel=next links", () => {
    const next = selectCompetitionsNzNextPageUrl(
      [
        { href: "/?page=1", text: "1", rel: "", className: "page-numbers" },
        { href: "/?page=2", text: "2", rel: "next", className: "page-numbers next" },
      ],
      "https://www.competitions.co.nz/",
    );

    expect(next).toBe("https://www.competitions.co.nz/?page=2");
  });

  it("selects next URL from text/class hints", () => {
    const next = selectCompetitionsNzNextPageUrl(
      [
        { href: "/?page=2", text: "Next", rel: "", className: "page-numbers" },
      ],
      "https://www.competitions.co.nz/?page=1",
    );

    expect(next).toBe("https://www.competitions.co.nz/?page=2");
  });

  it("returns null when no usable next link exists", () => {
    const next = selectCompetitionsNzNextPageUrl(
      [
        { href: "/?page=1", text: "1", rel: "", className: "page-numbers" },
        { href: "/?page=2", text: "2", rel: "", className: "page-numbers" },
      ],
      "https://www.competitions.co.nz/?page=1",
    );

    expect(next).toBeNull();
  });
});

describe("normalizeCompetitionsNzCards", () => {
  it("prefers canonical win URLs and dedupes repeated cards", () => {
    const cards: CompetitionsNzRawCard[] = [
      {
        position: 0,
        title: "Win a Wagner DYI Bundle",
        urlCandidates: [
          "https://www.competitions.co.nz/exit/win-wagner-dyi-bundle/38293/",
          "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
        ],
        brandName: "Wagner",
        categoryNames: ["Food & Drink"],
        badgeTexts: ["ENDS SOON", "Free Entry"],
        endsText: "Ends in 2 Days",
        imageUrl: "https://cdn.example.com/wagner.png",
      },
      {
        position: 1,
        title: "Win a Wagner DYI Bundle",
        urlCandidates: ["https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/"],
        brandName: "Wagner",
        categoryNames: ["Food & Drink"],
        badgeTexts: ["ENDS SOON", "Free Entry"],
        endsText: "Ends in 2 Days",
        imageUrl: "https://cdn.example.com/wagner.png",
      },
    ];

    const items = normalizeCompetitionsNzCards(cards, "competitions-nz");
    expect(items).toHaveLength(1);
    expect(items[0]?.link).toBe("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293");
    expect(items[0]?.sourceId).toBe("competitions-nz_38293");
  });

  it("excludes purchase required competitions", () => {
    const cards: CompetitionsNzRawCard[] = [
      {
        position: 0,
        title: "Win a Brand New MDC Offroad Caravan",
        urlCandidates: ["https://www.competitions.co.nz/win-brand-new-mdc-offroad-caravan/38244/"],
        brandName: "Nakie",
        categoryNames: ["Cars"],
        badgeTexts: ["ENDS SOON", "Purchase Required"],
        endsText: "Ends in 2 Days",
        imageUrl: null,
      },
    ];

    expect(normalizeCompetitionsNzCards(cards, "competitions-nz")).toHaveLength(0);
  });

  it("includes non-ending-soon competitions", () => {
    const cards: CompetitionsNzRawCard[] = [
      {
        position: 0,
        title: "Win a Home Makeover",
        urlCandidates: ["https://www.competitions.co.nz/win-home-makeover/38111/"],
        brandName: "Example Brand",
        categoryNames: ["Home & Garden"],
        badgeTexts: ["Free Entry"],
        endsText: "Ends in 28 Days",
        imageUrl: null,
        dataType: "regular",
        dataEndingSoon: "false",
      },
    ];

    const items = normalizeCompetitionsNzCards(cards, "competitions-nz");
    expect(items).toHaveLength(1);
    expect(items[0]?.link).toBe("https://www.competitions.co.nz/win-home-makeover/38111");
  });
});

describe("isCompetitionsNzAuthenticated", () => {
  it("returns true when sort controls are visible", () => {
    expect(
      isCompetitionsNzAuthenticated({
        hasGuestCtas: true,
        hasSortControl: true,
        hasCompetitionCards: false,
        hasAuthWallText: false,
        hasLoggedInCookie: false,
        hasUserIdCookie: false,
      })
    ).toBe(true);
  });

  it("returns false for guest view without auth cookies", () => {
    expect(
      isCompetitionsNzAuthenticated({
        hasGuestCtas: true,
        hasSortControl: false,
        hasCompetitionCards: false,
        hasAuthWallText: false,
        hasLoggedInCookie: false,
        hasUserIdCookie: false,
      })
    ).toBe(false);
  });

  it("returns true when auth cookies are present even if guest CTAs are visible", () => {
    expect(
      isCompetitionsNzAuthenticated({
        hasGuestCtas: true,
        hasSortControl: false,
        hasCompetitionCards: false,
        hasAuthWallText: false,
        hasLoggedInCookie: true,
        hasUserIdCookie: true,
      })
    ).toBe(true);
  });

  it("returns false when page has explicit auth wall text", () => {
    expect(
      isCompetitionsNzAuthenticated({
        hasGuestCtas: false,
        hasSortControl: false,
        hasCompetitionCards: false,
        hasAuthWallText: true,
        hasLoggedInCookie: true,
        hasUserIdCookie: true,
      })
    ).toBe(false);
  });
});