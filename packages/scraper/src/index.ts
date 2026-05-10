import cron from "node-cron";
import { ScrapeEngine } from "./ScrapeEngine.js";
import {
  ensureGroup,
  getLatestScrapedSourcePostId,
  pruneFacebookPosts,
  upsertItems,
} from "./db.js";
import type { GroupConfig } from "./types.js";

interface GroupConfigInput {
  groupId?: string;
  sourceId?: string;
  id?: string;
  siteId?: string;
  schedule?: string;
  name: string;
  url: string;
}

function inferSiteIdFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const normalized = host.replace(/^www\./, "").replace(/^m\./, "");
    return normalized.split(".")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

function parseGroupId(input: GroupConfigInput): string {
  const id = input.groupId || input.sourceId || input.id;
  if (!id) {
    throw new Error(`Missing group identifier for config "${input.name}"`);
  }
  return id;
}

function loadGroups(): GroupConfig[] {
  const raw = process.env.SCRAPE_GROUPS;
  if (!raw) {
    console.error("SCRAPE_GROUPS env var is not set. Expected JSON array.");
    process.exit(1);
  }

  const parsed = JSON.parse(raw) as GroupConfigInput[];
  return parsed.map((group) => ({
    groupId: parseGroupId(group),
    siteId: group.siteId || inferSiteIdFromUrl(group.url),
    name: group.name,
    url: group.url,
    schedule: group.schedule,
  }));
}

function getGroupSchedule(group: GroupConfig, defaultSchedule: string): string {
  if (group.schedule) {
    return group.schedule;
  }
  return defaultSchedule;
}

function getJitteredDelay(baseMs: number, jitterFraction = 0.3): number {
  const jitter = baseMs * jitterFraction;
  return baseMs + (Math.random() * 2 - 1) * jitter;
}

async function scrapeGroup(config: GroupConfig): Promise<void> {
  const siteId = config.siteId || inferSiteIdFromUrl(config.url);
  console.log(`[${new Date().toISOString()}] Scraping group: ${config.name} (${config.groupId}) via ${siteId}`);

  const groupId = await ensureGroup(config);
  const stopAtSourceId = await getLatestScrapedSourcePostId(groupId);
  const facebookBoundaryFallbackLimit = parsePositiveInteger(process.env.FACEBOOK_BOUNDARY_FALLBACK_LIMIT, 50);

  const engine = new ScrapeEngine();
  await engine.init();
  engine.registerSite({
    siteId,
    name: config.name,
    enabled: true,
    options: {
      groupIds: [config.groupId],
      cookieFile: process.env.SOURCE_COOKIE_FILE || undefined,
      competitionsNzUsername: process.env.COMPETITIONS_NZ_USERNAME || undefined,
      competitionsNzPassword: process.env.COMPETITIONS_NZ_PASSWORD || undefined,
      stopAtSourceId: stopAtSourceId ?? undefined,
      ...(siteId === "facebook"
        ? {
          boundaryFallbackLimit: facebookBoundaryFallbackLimit,
          maxCollectedPosts: facebookBoundaryFallbackLimit,
        }
        : {}),
    },
  });

  try {
    console.log(`  Running ${siteId} scraper...`);
    const result = await engine.scrapeOne(siteId);
    console.log(`  Scraper returned ${result.itemsExtracted} items`);
    if (result.errors.length > 0) {
      console.warn(`  Scraper errors:`, result.errors);
    }
    if (result.items.length > 0) {
      const upserted = await upsertItems(groupId, result.items);
      console.log(`  Upserted ${upserted} items into database`);
    } else {
      console.log(`  No items found for ${config.name}`);
    }
  } catch (err) {
    console.error(`  Scraper failed:`, err instanceof Error ? err.message : err);
  } finally {
    await engine.shutdown();
  }
}

async function runAllGroups(groups: GroupConfig[]): Promise<void> {
  for (const group of groups) {
    try {
      // Random delay between groups to avoid pattern detection
      const delay = getJitteredDelay(2000);
      await new Promise((r) => setTimeout(r, delay));
      await scrapeGroup(group);
    } catch (err) {
      console.error(`Error scraping group ${group.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

let runInProgress = false;

async function triggerRun(groups: GroupConfig[], trigger: "initial" | "scheduled"): Promise<void> {
  if (runInProgress) {
    console.warn(`[${new Date().toISOString()}] Skipping ${trigger} run because a scrape cycle is already in progress`);
    return;
  }

  runInProgress = true;
  try {
    await runAllGroups(groups);
  } finally {
    runInProgress = false;
  }
}

async function triggerPrune(retentionDays: number): Promise<void> {
  if (runInProgress) {
    console.warn(`[${new Date().toISOString()}] Skipping prune run because a scrape cycle is already in progress`);
    return;
  }

  runInProgress = true;
  try {
    const deleted = await pruneFacebookPosts(retentionDays);
    console.log(
      `[${new Date().toISOString()}] Pruned ${deleted} Facebook post(s) older than ${retentionDays} day(s)`
    );
  } catch (err) {
    console.error(`Prune job failed:`, err instanceof Error ? err.message : err);
  } finally {
    runInProgress = false;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const groups = loadGroups();
const defaultSchedule = process.env.SCRAPE_SCHEDULE || "0 */2 * * *"; // default for groups without explicit schedule
const pruneSchedule = process.env.PRUNE_SCHEDULE || "0 3 * * *";
const pruneRetentionDays = parsePositiveInteger(process.env.PRUNE_RETENTION_DAYS, 7);

const groupsBySchedule = new Map<string, GroupConfig[]>();
for (const group of groups) {
  const schedule = getGroupSchedule(group, defaultSchedule);
  const existing = groupsBySchedule.get(schedule);
  if (existing) {
    existing.push(group);
  } else {
    groupsBySchedule.set(schedule, [group]);
  }
}

console.log(`Scraper starting with ${groups.length} group(s)`);
console.log(`Default schedule: ${defaultSchedule}`);
console.log(`Prune schedule: ${pruneSchedule} (Facebook groups older than ${pruneRetentionDays} day(s))`);
console.log(`Groups: ${groups.map((g) => g.name).join(", ")}`);
console.log(
  `Group schedules: ${Array.from(groupsBySchedule.entries())
    .map(([schedule, scheduledGroups]) => `${schedule} -> [${scheduledGroups.map((g) => g.name).join(", ")}]`)
    .join("; ")}`
);

// Run once immediately on startup
triggerRun(groups, "initial").then(() => {
  console.log("Initial scrape complete. Scheduling future runs...");
});

for (const [schedule, scheduledGroups] of groupsBySchedule.entries()) {
  cron.schedule(schedule, () => {
    // Add random jitter before starting (0-10 minutes)
    const jitterMs = Math.random() * 10 * 60 * 1000;
    console.log(
      `[${new Date().toISOString()}] Scheduled run triggered for ${scheduledGroups.length} group(s) on ${schedule}, waiting ${Math.round(jitterMs / 1000)}s jitter...`
    );
    setTimeout(() => {
      void triggerRun(scheduledGroups, "scheduled");
    }, jitterMs);
  });
}

cron.schedule(pruneSchedule, () => {
  void triggerPrune(pruneRetentionDays);
});

console.log("Scraper is running. Press Ctrl+C to stop.");
