import type { SiteConfig } from "./core/types.js";
import { isFacebookGroupUrl } from "./facebookGroups.js";
import type { GroupConfig, SourceOptions } from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function sourceUrl(value: unknown): URL {
  const parsed = new URL(text(value, "Group url"));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Group url must use HTTP(S) without credentials");
  }
  return parsed;
}

export function inferSiteIdFromUrl(url: string): string {
  if (isFacebookGroupUrl(url)) return "facebook";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "competitions.co.nz" || host === "www.competitions.co.nz") return "competitions-nz";
    if (["reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com"].includes(host)) return "reddit";
    const normalized = host.replace(/^www\./, "").replace(/^m\./, "");
    const inferred = normalized.split(".")[0] || "unknown";
    return inferred === "facebook" ? "unknown" : inferred;
  } catch {
    return "unknown";
  }
}

const allowed: Record<string, readonly string[]> = {
  facebook: ["cookieFile", "maxItems", "boundaryFallbackLimit", "maxCollectedPosts",
    "scrollAttempts", "boundaryMinimumMarkerIndex", "debugHrefs", "unresolvedDumpFile"],
  reddit: ["maxItems", "maxPages", "limit", "sort", "timeFilter"],
  "competitions-nz": ["cookieFile", "maxItems"],
  "example-site": ["maxItems", "maxPages"],
};

function options(value: unknown, siteId: string): SourceOptions {
  const input = object(value, "Group options");
  for (const [key, setting] of Object.entries(input)) {
    if (!allowed[siteId]?.includes(key)) throw new Error(`Unsupported ${siteId} option: ${key}`);
    if (key === "cookieFile" || key === "unresolvedDumpFile") {
      input[key] = text(setting, `options.${key}`);
    } else if (key === "sort") {
      if (typeof setting !== "string" || !["hot", "new", "top"].includes(setting)) throw new Error("Invalid Reddit sort");
    } else if (key === "timeFilter") {
      if (typeof setting !== "string" || !["day", "week", "month", "year", "all"].includes(setting)) throw new Error("Invalid Reddit timeFilter");
    } else if (key === "debugHrefs") {
      if (typeof setting !== "boolean") throw new Error("options.debugHrefs must be boolean");
    } else {
      const minimum = key === "boundaryMinimumMarkerIndex" ? 0 : key === "limit" ? 25 : 1;
      const maximum = key === "limit" ? 100 : 2_147_482_647;
      if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < minimum || setting > maximum) {
        throw new Error(`options.${key} must be an integer between ${minimum} and ${maximum}`);
      }
    }
  }
  return input;
}

function subreddit(url: URL): string {
  if (!["reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com"].includes(url.hostname)) {
    throw new Error("Reddit url must use a supported reddit.com host");
  }
  const match = url.pathname.match(/^\/r\/([a-zA-Z0-9_]+)(?:\/|$)/);
  if (!match) throw new Error("Reddit url must identify one subreddit at /r/<name>");
  return match[1];
}

export function parseGroups(raw: string): GroupConfig[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("SCRAPE_GROUPS must be a JSON array");
  const identifiers = new Set<string>();
  return parsed.map((value) => {
    const input = object(value, "Group");
    const groupId = text(input.groupId || input.sourceId || input.id, "Group identifier");
    if (identifiers.has(groupId)) throw new Error(`Duplicate group identifier: ${groupId}`);
    identifiers.add(groupId);
    const url = text(input.url, "Group url");
    const parsedUrl = sourceUrl(url);
    const siteId = input.siteId === undefined ? inferSiteIdFromUrl(url) : text(input.siteId, "Group siteId");
    if (siteId === "reddit") subreddit(parsedUrl);
    if (siteId === "facebook" && !isFacebookGroupUrl(url)) throw new Error("Facebook url must identify a supported Facebook group");
    if (siteId === "facebook" && parsedUrl.pathname.split("/")[2] !== groupId) {
      throw new Error("Facebook group identifier must match the configured URL");
    }
    if (siteId === "competitions-nz"
      && !["competitions.co.nz", "www.competitions.co.nz"].includes(parsedUrl.hostname)) {
      throw new Error("Competitions NZ url must use competitions.co.nz");
    }
    return {
      groupId, siteId, name: text(input.name, "Group name"), url,
      schedule: input.schedule === undefined ? undefined : text(input.schedule, "Group schedule"),
      ...(input.options === undefined ? {} : { options: options(input.options, siteId) }),
    };
  });
}

export function buildSourceConfig(
  group: GroupConfig,
  stopAtSourceId: string | null,
  environment: NodeJS.ProcessEnv = process.env
): SiteConfig {
  const siteId = group.siteId || inferSiteIdFromUrl(group.url);
  const configured = group.options ?? {};
  const fallback = Number.parseInt(environment.FACEBOOK_BOUNDARY_FALLBACK_LIMIT || "", 10);
  const boundaryLimit = configured.boundaryFallbackLimit
    ?? (Number.isInteger(fallback) && fallback > 0 ? fallback : 50);
  return {
    siteId, name: group.name, enabled: true,
    options: {
      ...configured,
      groupIds: [group.groupId],
      sourceUrl: group.url,
      ...(siteId === "reddit" ? { subreddits: [subreddit(sourceUrl(group.url))] } : {}),
      cookieFile: configured.cookieFile || environment.SOURCE_COOKIE_FILE || undefined,
      stopAtSourceId: stopAtSourceId ?? undefined,
      ...(siteId === "facebook" ? {
        boundaryFallbackLimit: boundaryLimit,
        maxCollectedPosts: configured.maxCollectedPosts ?? boundaryLimit,
      } : {}),
    },
  };
}
