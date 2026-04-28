import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeUrl,
  cleanHtml,
  computeContentHash,
  escapeHtml,
  extractDomain,
  getJitteredDelay,
  parseTimestamp,
  sleep,
  retryWithBackoff,
  textToParagraphHtml,
} from "./utils.js";
import type { NormalizedItem } from "./types.js";

describe("core/utils", () => {
  it("canonicalizeUrl removes tracking params and trailing slash", () => {
    const input = "https://example.com/path/?utm_source=x&utm_medium=y&fbclid=abc&id=1#frag";
    const output = canonicalizeUrl(input);
    expect(output).toBe("https://example.com/path/?id=1");
  });

  it("canonicalizeUrl returns original string for invalid URL", () => {
    const input = "not-a-valid-url";
    expect(canonicalizeUrl(input)).toBe(input);
  });

  it("extractDomain returns hostname or empty string", () => {
    expect(extractDomain("https://sub.example.com/a")).toBe("sub.example.com");
    expect(extractDomain("bad-url")).toBe("");
  });

  it("cleanHtml removes scripts/styles/tags and normalizes whitespace", () => {
    const html = "<style>.x{}</style><p>Hello <b>World</b></p><script>alert(1)</script>";
    expect(cleanHtml(html)).toBe("Hello World");
  });

  it("escapeHtml encodes HTML control chars", () => {
    const text = `<img src=x onerror='alert(1)'> & \"q\"`;
    expect(escapeHtml(text)).toBe("&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; &quot;q&quot;");
  });

  it("textToParagraphHtml escapes and preserves line breaks", () => {
    const html = textToParagraphHtml("line1\n<script>x</script>");
    expect(html).toBe("<p>line1</p><p>&lt;script&gt;x&lt;/script&gt;</p>");
    expect(textToParagraphHtml(null)).toBeNull();
  });

  it("getJitteredDelay stays within +/-30% bounds", () => {
    const base = 1000;
    for (let i = 0; i < 100; i++) {
      const value = getJitteredDelay(base);
      expect(value).toBeGreaterThanOrEqual(700);
      expect(value).toBeLessThanOrEqual(1300);
    }
  });

  it("parseTimestamp handles relative strings and invalid input", () => {
    const now = Date.now();
    const justNow = parseTimestamp("just now");
    expect(justNow).not.toBeNull();
    expect(Math.abs((justNow as Date).getTime() - now)).toBeLessThan(5000);

    const twoHours = parseTimestamp("2 hours ago");
    expect(twoHours).not.toBeNull();
    const delta = now - (twoHours as Date).getTime();
    expect(delta).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 10000);
    expect(delta).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 10000);

    expect(parseTimestamp("totally-invalid-timestamp")).toBeNull();
  });

  it("parseTimestamp handles 'yesterday' and ISO date values", () => {
    const yesterday = parseTimestamp("yesterday");
    expect(yesterday).not.toBeNull();

    const iso = parseTimestamp("2026-04-25T12:00:00.000Z");
    expect(iso).not.toBeNull();
    expect((iso as Date).toISOString()).toBe("2026-04-25T12:00:00.000Z");
  });

  it("parseTimestamp handles seconds/weeks/months/years relative values", () => {
    const now = Date.now();

    const tenSeconds = parseTimestamp("10 seconds ago");
    expect(tenSeconds).not.toBeNull();
    expect(now - (tenSeconds as Date).getTime()).toBeGreaterThanOrEqual(10_000 - 10_000);
    expect(now - (tenSeconds as Date).getTime()).toBeLessThanOrEqual(10_000 + 10_000);

    const oneWeek = parseTimestamp("1 week ago");
    expect(oneWeek).not.toBeNull();

    const threeMonths = parseTimestamp("3 months ago");
    expect(threeMonths).not.toBeNull();

    const twoYears = parseTimestamp("2 years ago");
    expect(twoYears).not.toBeNull();
  });

  it("parseTimestamp handles compact relative units", () => {
    expect(parseTimestamp("2hr ago")).not.toBeNull();
    expect(parseTimestamp("15 min")).not.toBeNull();
    expect(parseTimestamp("3d")).not.toBeNull();
    expect(parseTimestamp("1wk")).not.toBeNull();
    expect(parseTimestamp("4mo")).not.toBeNull();
    expect(parseTimestamp("2yr")).not.toBeNull();
  });

  it("retryWithBackoff retries and eventually succeeds", async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("temporary");
        }
        return "ok";
      },
      3,
      0,
      1
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("retryWithBackoff throws after max attempts", async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("always fails");
        },
        2,
        0,
        1
      )
    ).rejects.toThrow("always fails");
    expect(attempts).toBe(2);
  });

  it("retryWithBackoff wraps non-Error failures", async () => {
    await expect(
      retryWithBackoff(
        async () => {
          throw "string failure";
        },
        1,
        0,
        1
      )
    ).rejects.toThrow("string failure");
  });

  it("retryWithBackoff with zero maxAttempts fails without calling fn", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retryWithBackoff(fn, 0, 0, 1)).rejects.toThrow("All retries failed");
    expect(fn).not.toHaveBeenCalled();
  });

  it("sleep resolves after requested delay", async () => {
    vi.useFakeTimers();

    const sleeper = sleep(50);
    const onDone = vi.fn();
    sleeper.then(onDone);

    await vi.advanceTimersByTimeAsync(49);
    expect(onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await sleeper;
    expect(onDone).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("computeContentHash is deterministic for same content", () => {
    const item: NormalizedItem = {
      sourceId: "id-1",
      sourceSite: "example",
      title: "Title",
      contentText: "Body",
      contentHtml: "<p>Body</p>",
      authorName: "Author",
      link: "https://example.com/post/1",
      mediaUrls: [],
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const h1 = computeContentHash(item);
    const h2 = computeContentHash({ ...item });
    expect(h1).toBe(h2);

    const h3 = computeContentHash({ ...item, contentText: "Different body" });
    expect(h3).not.toBe(h1);
  });
});
