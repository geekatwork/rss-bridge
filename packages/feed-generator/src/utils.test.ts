import { describe, expect, it } from "vitest";
import { buildFeedUrl, isLandingOrGroupUrl, isUnreliableFacebookPhotoLink } from "./utils.js";

describe("feed-generator utils", () => {
  it("flags home/login/checkpoint links on same host", () => {
    const groupUrl = "https://www.facebook.com/groups/12345";
    expect(isLandingOrGroupUrl("https://www.facebook.com/", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/home.php", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/login.php", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/checkpoint", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/checkpoint/", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/HOME.PHP", groupUrl)).toBe(true);
  });

  it("flags group-root style links on same host", () => {
    const groupUrl = "https://www.facebook.com/groups/12345";
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/12345", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/12345/posts/abc", groupUrl)).toBe(true);
  });

  it("matches group links when configured group URL has trailing slash", () => {
    const groupUrl = "https://www.facebook.com/groups/12345/";
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/12345", groupUrl)).toBe(true);
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/12345/posts/abc", groupUrl)).toBe(true);
  });

  it("does not flag links on different host", () => {
    const groupUrl = "https://www.facebook.com/groups/12345";
    expect(isLandingOrGroupUrl("https://instagram.com/p/xyz/", groupUrl)).toBe(false);
  });

  it("does not flag different group path on same host", () => {
    const groupUrl = "https://www.facebook.com/groups/12345";
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/99999", groupUrl)).toBe(false);
  });

  it("returns false for malformed links", () => {
    expect(isLandingOrGroupUrl("bad-link", "https://www.facebook.com/groups/12345")).toBe(false);
  });

  it("returns false for malformed group URL", () => {
    expect(isLandingOrGroupUrl("https://www.facebook.com/groups/12345/posts/1", "not-a-url")).toBe(false);
  });

  it("handles URL variants with query/hash/case and near-miss paths", () => {
    const groupUrl = "https://www.facebook.com/groups/12345";

    const cases: Array<{ link: string; expected: boolean; note: string }> = [
      {
        link: "https://www.facebook.com/groups/12345?ref=bookmarks",
        expected: true,
        note: "group root with query",
      },
      {
        link: "https://www.facebook.com/groups/12345/posts/abc#comment-1",
        expected: true,
        note: "group post with fragment",
      },
      {
        link: "https://WWW.FACEBOOK.COM/groups/12345/posts/abc",
        expected: true,
        note: "hostname case-insensitivity",
      },
      {
        link: "https://www.facebook.com/groups/12345-other/posts/abc",
        expected: true,
        note: "prefix path still treated as group-like by current matcher",
      },
      {
        link: "https://m.facebook.com/groups/12345/posts/abc",
        expected: false,
        note: "different host should not match",
      },
      {
        link: "https://www.facebook.com/login.php?next=/groups/12345",
        expected: true,
        note: "login path with query",
      },
    ];

    for (const testCase of cases) {
      expect(isLandingOrGroupUrl(testCase.link, groupUrl), testCase.note).toBe(testCase.expected);
    }
  });

  it("buildFeedUrl formats protocol, host, and source id", () => {
    expect(buildFeedUrl("http://localhost:3100", "abc123")).toBe("http://localhost:3100/feed/abc123");
    expect(buildFeedUrl("https://example.com", "group-1")).toBe("https://example.com/feed/group-1");
    expect(buildFeedUrl("https://feeds.example.com/base/", "group-1")).toBe("https://feeds.example.com/base/feed/group-1");
    expect(buildFeedUrl("https://example.com", "group/a b")).toBe("https://example.com/feed/group%2Fa%20b");
  });

  it("flags Facebook photo fbid links as unreliable", () => {
    expect(isUnreliableFacebookPhotoLink("https://www.facebook.com/photo.php?fbid=1484379963795536")).toBe(true);
    expect(isUnreliableFacebookPhotoLink("https://www.facebook.com/photo/?fbid=1484379963795536")).toBe(true);
    expect(isUnreliableFacebookPhotoLink("https://m.facebook.com/photo.php?fbid=1484379963795536")).toBe(true);
  });

  it("does not flag non-photo or non-facebook links", () => {
    expect(isUnreliableFacebookPhotoLink("https://www.facebook.com/story.php?story_fbid=1&id=2")).toBe(false);
    expect(isUnreliableFacebookPhotoLink("https://www.instagram.com/p/abc123/")).toBe(false);
    expect(isUnreliableFacebookPhotoLink("not-a-url")).toBe(false);
  });
});
