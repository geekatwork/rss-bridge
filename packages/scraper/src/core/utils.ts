import * as crypto from "crypto";
import type { NormalizedItem } from "./types.js";

/**
 * Compute a hash of item content for deduplication.
 * Uses title, author, and first 500 chars of text.
 */
export function computeContentHash(item: NormalizedItem): string {
  const key = `${item.sourceSite}|${item.title}|${item.authorName}|${item.contentText?.substring(0, 500) ?? ""}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Canonicalize a URL: remove tracking params, fragment, normalize scheme/host.
 * Example: https://instagram.com/p/ABC?fbclid=... → https://instagram.com/p/ABC
 */
export function canonicalizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    // Remove common tracking params
    const paramsToRemove = ["fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    paramsToRemove.forEach((p) => url.searchParams.delete(p));
    // Reconstruct without fragment
    return `${url.origin}${url.pathname}${url.search}`.replace(/\/$/, "");
  } catch {
    return urlString;
  }
}

/**
 * Wait for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry a function with exponential backoff.
 * @param fn - Function to retry
 * @param maxAttempts - Max number of attempts
 * @param initialDelayMs - Initial delay in milliseconds
 * @param backoffMultiplier - Multiply delay by this each attempt
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  initialDelayMs = 1000,
  backoffMultiplier = 2
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxAttempts) {
        const delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        await sleep(delayMs);
      }
    }
  }
  throw lastError || new Error("All retries failed");
}

/**
 * Get a jittered delay to avoid thundering herd.
 * Adds ±30% randomness to the base delay.
 * @param baseMs - Base delay in milliseconds
 */
export function getJitteredDelay(baseMs: number): number {
  const jitter = baseMs * 0.3;
  return baseMs - jitter + Math.random() * jitter * 2;
}

/**
 * Extract domain from URL.
 * Example: "https://twitter.com/user" → "twitter.com"
 */
export function extractDomain(urlString: string): string {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch {
    return "";
  }
}

/**
 * Clean HTML: strip most tags but preserve structure.
 * Naive implementation; use a proper library if needed.
 */
export function cleanHtml(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gi, "")
    .replace(/<style[^>]*>.*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Escape untrusted text for safe HTML rendering.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert plain text into paragraph HTML with escaped content.
 */
export function textToParagraphHtml(text: string | null | undefined): string | null {
  if (!text) return null;
  return `<p>${escapeHtml(text).replace(/\n/g, "</p><p>")}</p>`;
}

/**
 * Parse timestamp string in various formats.
 * Examples: "2 hours ago", "yesterday", "2026-04-25", "42 minutes ago"
 */
export function parseTimestamp(text: string): Date | null {
  const now = new Date();
  const lowerText = text.toLowerCase().trim();

  // "just now" or empty
  if (!lowerText || lowerText === "just now") return now;

  // "yesterday"
  if (lowerText === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // "N units ago" or compact forms like "2hr", "5 min", "3d"
  const match = lowerText.match(
    /^(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d|week|wk|w|month|mo|year|yr|y)s?\s*(ago)?$/
  );
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const d = new Date(now);

    if (["second", "sec", "s"].includes(unit)) d.setSeconds(d.getSeconds() - n);
    else if (["minute", "min", "m"].includes(unit)) d.setMinutes(d.getMinutes() - n);
    else if (["hour", "hr", "h"].includes(unit)) d.setHours(d.getHours() - n);
    else if (["day", "d"].includes(unit)) d.setDate(d.getDate() - n);
    else if (["week", "wk", "w"].includes(unit)) d.setDate(d.getDate() - n * 7);
    else if (["month", "mo"].includes(unit)) d.setMonth(d.getMonth() - n);
    else if (["year", "yr", "y"].includes(unit)) d.setFullYear(d.getFullYear() - n);

    return d;
  }

  // Try ISO-like date formats
  try {
    const d = new Date(text);
    if (!isNaN(d.getTime())) return d;
  } catch {
    // fall through
  }

  return null;
}
