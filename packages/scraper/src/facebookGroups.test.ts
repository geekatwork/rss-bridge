import { describe, expect, it } from "vitest";
import { isFacebookGroupUrl } from "./facebookGroups.js";

describe("Facebook group URL policy", () => {
  it.each(["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com"])(
    "accepts HTTP/HTTPS group URLs on %s",
    (host) => {
      for (const protocol of ["http", "https"]) {
        expect(isFacebookGroupUrl(`${protocol}://${host}/groups/group-name/?ref=test#posts`)).toBe(true);
        expect(isFacebookGroupUrl(`${protocol}://${host}/groups/12345`.toUpperCase())).toBe(true);
      }
    }
  );

  it.each([
    "https://example.com/groups/123",
    "https://facebook.com.evil.test/groups/123",
    "https://www.facebook.com.evil.test/groups/123",
    "https://notfacebook.com/groups/123",
    "https://other.facebook.com/groups/123",
    "https://facebook.com@evil.test/groups/123",
    "https://evil.test/facebook.com/groups/123",
    "https://facebook.com/pages/123",
    "https://facebook.com/groups/",
    "https://facebook.com/groups/?id=123",
    "https://facebook.com/groups/#123",
    "https://facebook.com/groups/ ",
    "ftp://facebook.com/groups/123",
    "not a URL",
  ])("rejects unsupported group URL %s", (url) => {
    expect(isFacebookGroupUrl(url)).toBe(false);
  });
});
