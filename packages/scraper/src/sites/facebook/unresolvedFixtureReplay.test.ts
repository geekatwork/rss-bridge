import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { extractFacebookAlbumLinkFromImageUrls, selectFacebookContentDestination } from "./linkExtraction.js";

interface UnresolvedFacebookFixture {
  sourcePostId: string;
  groupSourceId: string;
  groupName: string;
  authorName: string | null;
  contentText: string | null;
  contentHtml: string | null;
  link: string | null;
  imageUrls: string[];
  postedAt: string;
  candidateUrls: string[];
  expectedLink: string | null;
  notes: string | null;
}

function loadFixtures(): UnresolvedFacebookFixture[] {
  const fixturePaths = [
    resolve(process.cwd(), "src/sites/facebook/__fixtures__/facebook-unresolved.json"),
    resolve(process.cwd(), "packages/scraper/src/sites/facebook/__fixtures__/facebook-unresolved.json"),
  ];
  const fixturePath = fixturePaths.find((candidate) => existsSync(candidate));
  if (!fixturePath) return [];
  return JSON.parse(readFileSync(fixturePath, "utf8")) as UnresolvedFacebookFixture[];
}

function replayFixture(fixture: UnresolvedFacebookFixture): string | null {
  const destination = selectFacebookContentDestination(fixture.candidateUrls);
  if (destination.ambiguous) return null;
  return destination.link || extractFacebookAlbumLinkFromImageUrls(fixture.imageUrls);
}

describe("Facebook unresolved fixture replay", () => {
  const fixtures = loadFixtures();

  it("loads a valid unresolved fixture dump", () => {
    expect(Array.isArray(fixtures)).toBe(true);
    const ids = new Set<string>();
    for (const fixture of fixtures) {
      expect(typeof fixture.sourcePostId).toBe("string");
      expect(ids.has(fixture.sourcePostId)).toBe(false);
      ids.add(fixture.sourcePostId);
      expect(Array.isArray(fixture.imageUrls)).toBe(true);
      expect(Array.isArray(fixture.candidateUrls)).toBe(true);
    }
  });

  it.skipIf(fixtures.length === 0)("contains real unresolved facebook rows to curate", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  const assertedFixtures = fixtures.filter((fixture) => fixture.expectedLink);
  if (assertedFixtures.length === 0) {
    it("has no curated expected links yet", () => {
      expect(assertedFixtures).toHaveLength(0);
    });
  }

  for (const fixture of assertedFixtures) {
    it(`replays fixture ${fixture.sourcePostId}`, () => {
      expect(replayFixture(fixture)).toBe(fixture.expectedLink);
    });
  }
});
