import { describe, expect, it } from "vitest";
import { buildSourceConfig, parseGroups } from "./sourceConfig.js";

const reddit = { groupId: "reddit-ts", name: "TypeScript", url: "https://www.reddit.com/r/typescript/" };

describe("scheduled source configuration", () => {
  it("maps Reddit URL and validated options without losing them", () => {
    const [group] = parseGroups(JSON.stringify([{ ...reddit, options: { sort: "top", timeFilter: "month", limit: 75, maxPages: 2 } }]));
    expect(buildSourceConfig(group, "boundary", {})).toMatchObject({
      siteId: "reddit", options: {
        sourceUrl: reddit.url, subreddits: ["typescript"], sort: "top", timeFilter: "month",
        limit: 75, maxPages: 2, stopAtSourceId: "boundary",
      },
    });

  });

  it.each(["reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com"])(
    "infers supported Reddit host %s", (host) => {
      const [group] = parseGroups(JSON.stringify([{ ...reddit, url: `https://${host}/r/typescript/` }]));
      expect(group.siteId).toBe("reddit");
    }
  );

  it("uses per-group options over global cookie and Facebook defaults", () => {
    const [group] = parseGroups(JSON.stringify([{
      groupId: "123", name: "Facebook", url: "https://mbasic.facebook.com/groups/123/",
      options: { cookieFile: "/app/cookies/custom.json", boundaryFallbackLimit: 12, maxCollectedPosts: 30, debugHrefs: false },
    }]));
    expect(buildSourceConfig(group, null, { SOURCE_COOKIE_FILE: "/global.json", FACEBOOK_BOUNDARY_FALLBACK_LIMIT: "50" }))
      .toMatchObject({ options: {
        groupIds: ["123"], cookieFile: "/app/cookies/custom.json",
        boundaryFallbackLimit: 12, maxCollectedPosts: 30, debugHrefs: false,
      } });
  });

  it("preserves environment fallback and alias identifiers for existing groups", () => {
    const [group] = parseGroups(JSON.stringify([{
      sourceId: "123", name: "Facebook", url: "https://www.facebook.com/groups/123",
    }]));
    expect(group.options).toBeUndefined();
    expect(buildSourceConfig(group, "stop", { SOURCE_COOKIE_FILE: "/global.json", FACEBOOK_BOUNDARY_FALLBACK_LIMIT: "80" }))
      .toMatchObject({ options: { cookieFile: "/global.json", boundaryFallbackLimit: 80, maxCollectedPosts: 80, stopAtSourceId: "stop" } });
  });

  it("infers Competitions NZ and preserves the configured listing path", () => {
    const [group] = parseGroups(JSON.stringify([{
      groupId: "competitions", name: "Competitions", url: "https://www.competitions.co.nz/category/new/",
    }]));
    expect(buildSourceConfig(group, null, {})).toMatchObject({
      siteId: "competitions-nz", options: { sourceUrl: group.url },
    });
  });

  it.each([
    null, {}, [{ ...reddit, options: [] }],
    [{ ...reddit, options: { limit: 101 } }],
    [{ ...reddit, options: { sort: ["top"] } }],
    [{ ...reddit, options: { sort: "random" } }],
    [{ ...reddit, options: { timeFilter: "hour" } }],
    [{ ...reddit, options: { maxPages: 0 } }],
    [{ ...reddit, options: { subreddits: ["different"] } }],
    [{ ...reddit, options: { sourceUrl: "https://evil.test" } }],
    [{ ...reddit, options: { stopAtSourceId: "override" } }],
    [{ ...reddit, options: { cookieFile: "/cookie.json" } }],
    [{ ...reddit, url: "ftp://reddit.com/r/typescript" }],
    [{ ...reddit, url: "https://user:password@reddit.com/r/typescript" }],
    [{ ...reddit, url: "https://reddit.com/" }],
    [{ ...reddit, siteId: "reddit", url: "https://reddit.com.evil.test/r/typescript" }],
    [reddit, reddit],
    [{ groupId: "123", name: "FB", url: "https://www.facebook.com/groups/999" }],
    [{ groupId: "123", siteId: "facebook", name: "FB", url: "https://evil.test/groups/123" }],
    [{ groupId: "c", siteId: "competitions-nz", name: "C", url: "https://evil.test/" }],
    [{ groupId: "123", name: "FB", url: "https://facebook.com/groups/123", options: { debugHrefs: "true" } }],
    [{ groupId: "123", name: "FB", url: "https://facebook.com/groups/123", options: { cookieFile: "" } }],
    [{ groupId: "123", name: "FB", url: "https://facebook.com/groups/123", options: { boundaryMinimumMarkerIndex: -1 } }],
  ])("rejects invalid or identity-overriding configuration %#", (input) => {
    expect(() => parseGroups(JSON.stringify(input))).toThrow();
  });

  it("allows an empty group list and unknown plugins without unvalidated options", () => {
    expect(parseGroups("[]")).toEqual([]);
    expect(parseGroups(JSON.stringify([{ ...reddit, siteId: "unknown-smoke-plugin" }]))[0].siteId)
      .toBe("unknown-smoke-plugin");
  });
});
