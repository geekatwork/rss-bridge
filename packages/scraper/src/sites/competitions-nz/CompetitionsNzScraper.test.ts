import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeCompetitionsNzUrl,
  isCompetitionsNzAuthenticated,
  normalizeCompetitionsNzCards,
  resolveCompetitionsNzDestinationUrl,
  selectCompetitionsNzNextPageUrl,
  toCompetitionsNzExitUrl,
  type CompetitionsNzRawCard,
} from "./CompetitionsNzScraper.js";

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
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce({
        headers: {
          get: (name: string) => (name.toLowerCase() === "location" ? "https://www.wagneraustralia.com.au/mothers-day-2026/#" : null),
        },
      } as unknown as Response);

    await expect(
      resolveCompetitionsNzDestinationUrl(
        "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
        fetchMock,
      )
    ).resolves.toBe("https://www.wagneraustralia.com.au/mothers-day-2026/#");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.competitions.co.nz/exit/win-wagner-dyi-bundle/38293/",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("falls back to the competitions detail URL when resolution stays on competitions.co.nz", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce({
        headers: {
          get: (name: string) => (name.toLowerCase() === "location"
            ? "https://www.competitions.co.nz/register/?return=%2Fexit%2Fwin%2Dwagner%2Ddyi%2Dbundle%2F38293%2F"
            : null),
        },
      } as unknown as Response)
      .mockResolvedValueOnce({
        url: "https://www.competitions.co.nz/register/?return=%2Fexit%2Fwin%2Dwagner%2Ddyi%2Dbundle%2F38293%2F",
      } as Response);

    await expect(
      resolveCompetitionsNzDestinationUrl(
        "https://www.competitions.co.nz/win-wagner-dyi-bundle/38293/",
        fetchMock,
      )
    ).resolves.toBe("https://www.competitions.co.nz/win-wagner-dyi-bundle/38293");
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