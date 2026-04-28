import cron from "node-cron";
import { ScrapeEngine } from "./ScrapeEngine.js";
import { ensureGroup, upsertItems } from "./db.js";
import type { GroupConfig } from "./types.js";

interface GroupConfigInput {
  groupId?: string;
  sourceId?: string;
  id?: string;
  siteId?: string;
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
  }));
}

function getJitteredDelay(baseMs: number, jitterFraction = 0.3): number {
  const jitter = baseMs * jitterFraction;
  return baseMs + (Math.random() * 2 - 1) * jitter;
}

async function scrapeGroup(config: GroupConfig): Promise<void> {
  const siteId = config.siteId || inferSiteIdFromUrl(config.url);
  console.log(`[${new Date().toISOString()}] Scraping group: ${config.name} (${config.groupId}) via ${siteId}`);

  const groupId = await ensureGroup(config);

  const engine = new ScrapeEngine();
  await engine.init();
  engine.registerSite({
    siteId,
    name: config.name,
    enabled: true,
    options: {
      groupIds: [config.groupId],
      cookieFile: process.env.SOURCE_COOKIE_FILE || undefined,
      accessToken: process.env.SOURCE_ACCESS_TOKEN || undefined,
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

const groups = loadGroups();
const schedule = process.env.SCRAPE_SCHEDULE || "0 */2 * * *"; // default: every 2 hours

console.log(`Scraper starting with ${groups.length} group(s)`);
console.log(`Schedule: ${schedule}`);
console.log(`Groups: ${groups.map((g) => g.name).join(", ")}`);

// Run once immediately on startup
triggerRun(groups, "initial").then(() => {
  console.log("Initial scrape complete. Scheduling future runs...");
});

cron.schedule(schedule, () => {
  // Add random jitter before starting (0-10 minutes)
  const jitterMs = Math.random() * 10 * 60 * 1000;
  console.log(`[${new Date().toISOString()}] Scheduled run triggered, waiting ${Math.round(jitterMs / 1000)}s jitter...`);
  setTimeout(() => {
    void triggerRun(groups, "scheduled");
  }, jitterMs);
});

console.log("Scraper is running. Press Ctrl+C to stop.");
