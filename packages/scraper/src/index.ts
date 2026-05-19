import cron from "node-cron";
import { createServer } from "node:http";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
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

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

type AlertReason = "auth_failure" | "timeout" | "repeated_empty";

interface GroupAlertState {
  groupName: string;
  activeReasons: Set<AlertReason>;
  consecutiveEmptyRuns: number;
  lastAlertAt?: string;
  lastAlertMessage?: string;
}

interface HealthSnapshot {
  status: "ok" | "degraded";
  runInProgress: boolean;
  timestamp: string;
  groupsWithAlerts: number;
  prune: {
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastDeleted: number | null;
    lastError: string | null;
  };
  groups: Array<{
    groupId: string;
    groupName: string;
    consecutiveEmptyRuns: number;
    activeReasons: AlertReason[];
    lastAlertAt?: string;
    lastAlertMessage?: string;
  }>;
}

interface PruneState {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDeleted: number | null;
  lastError: string | null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setNodeTimeout(() => {
      reject(new TimeoutError(`Timed out after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearNodeTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearNodeTimeout(timer);
        reject(error);
      });
  });
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

function getGroupAlertState(groupId: string, groupName: string): GroupAlertState {
  const existing = groupAlertStateByGroupId.get(groupId);
  if (existing) return existing;

  const created: GroupAlertState = {
    groupName,
    activeReasons: new Set<AlertReason>(),
    consecutiveEmptyRuns: 0,
  };
  groupAlertStateByGroupId.set(groupId, created);
  return created;
}

function setGroupAlert(groupId: string, groupName: string, reason: AlertReason, message: string): void {
  const state = getGroupAlertState(groupId, groupName);
  state.activeReasons.add(reason);
  state.lastAlertAt = new Date().toISOString();
  state.lastAlertMessage = message;
}

function clearGroupAlertReason(groupId: string, reason: AlertReason): void {
  const state = groupAlertStateByGroupId.get(groupId);
  if (!state) return;
  state.activeReasons.delete(reason);
}

function clearAllGroupAlerts(groupId: string): void {
  const state = groupAlertStateByGroupId.get(groupId);
  if (!state) return;
  state.activeReasons.clear();
  state.lastAlertAt = undefined;
  state.lastAlertMessage = undefined;
}

function getHealthSnapshot(): HealthSnapshot {
  const groups = Array.from(groupAlertStateByGroupId.entries()).map(([groupId, state]) => ({
    groupId,
    groupName: state.groupName,
    consecutiveEmptyRuns: state.consecutiveEmptyRuns,
    activeReasons: Array.from(state.activeReasons.values()),
    lastAlertAt: state.lastAlertAt,
    lastAlertMessage: state.lastAlertMessage,
  }));

  const groupsWithAlerts = groups.filter((group) => group.activeReasons.length > 0).length;

  return {
    status: groupsWithAlerts > 0 || Boolean(pruneState.lastError) ? "degraded" : "ok",
    runInProgress,
    timestamp: new Date().toISOString(),
    groupsWithAlerts,
    prune: {
      lastStartedAt: pruneState.lastStartedAt,
      lastCompletedAt: pruneState.lastCompletedAt,
      lastDeleted: pruneState.lastDeleted,
      lastError: pruneState.lastError,
    },
    groups,
  };
}

function startHealthServer(): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const healthPort = parsePositiveInteger(process.env.SCRAPER_HEALTH_PORT, 8081);
  const server = createServer((req, res) => {
    if (!req.url || req.url.split("?")[0] !== "/health") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const snapshot = getHealthSnapshot();
    res.statusCode = snapshot.status === "ok" ? 200 : 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(snapshot));
  });

  server.listen(healthPort, "0.0.0.0", () => {
    console.log(`Health endpoint listening on port ${healthPort}`);
  });
}

async function scrapeGroup(config: GroupConfig): Promise<void> {
  const siteId = config.siteId || inferSiteIdFromUrl(config.url);
  const groupTimeoutMs = parsePositiveInteger(process.env.SCRAPE_GROUP_TIMEOUT_MS, 20 * 60 * 1000);
  const alertState = getGroupAlertState(config.groupId, config.name);
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
    const result = await withTimeout(
      engine.scrapeOne(siteId),
      groupTimeoutMs,
      `${config.name} (${config.groupId}) via ${siteId}`
    );
    console.log(`  Scraper returned ${result.itemsExtracted} items`);
    if (result.errors.length > 0) {
      console.warn(`  Scraper errors:`, result.errors);

      const hasAuthFailure = result.errors.some((error) => /authentication failed|cookies are required/i.test(error));
      if (hasAuthFailure) {
        const alertMessage = `[ALERT] ${config.name} (${config.groupId}) failed authentication. Refresh cookie files in /app/cookies and verify mount visibility.`;
        setGroupAlert(config.groupId, config.name, "auth_failure", alertMessage);
        console.error(alertMessage);
      } else {
        clearGroupAlertReason(config.groupId, "auth_failure");
      }
    } else {
      clearGroupAlertReason(config.groupId, "auth_failure");
    }

    if (result.itemsExtracted === 0) {
      const current = alertState.consecutiveEmptyRuns + 1;
      alertState.consecutiveEmptyRuns = current;
      if (current >= 2) {
        const alertMessage = `[ALERT] ${config.name} (${config.groupId}) returned 0 items for ${current} consecutive runs. Check cookies, source availability, and scraper logs.`;
        setGroupAlert(config.groupId, config.name, "repeated_empty", alertMessage);
        console.error(alertMessage);
      }
    } else {
      alertState.consecutiveEmptyRuns = 0;
      clearGroupAlertReason(config.groupId, "repeated_empty");
      clearAllGroupAlerts(config.groupId);
    }

    if (result.items.length > 0) {
      const upserted = await upsertItems(groupId, result.items);
      console.log(`  Upserted ${upserted} items into database`);
    } else {
      console.log(`  No items found for ${config.name}`);
    }
  } catch (err) {
    console.error(`  Scraper failed:`, err instanceof Error ? err.message : err);
    if (err instanceof TimeoutError) {
      const alertMessage = `[ALERT] ${config.name} (${config.groupId}) scrape exceeded timeout (${groupTimeoutMs}ms). Browser/session likely stalled; moving on to next group.`;
      setGroupAlert(config.groupId, config.name, "timeout", alertMessage);
      console.error(alertMessage);
    }
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
const groupAlertStateByGroupId = new Map<string, GroupAlertState>();
const pruneState: PruneState = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastDeleted: null,
  lastError: null,
};

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
  pruneState.lastStartedAt = new Date().toISOString();
  pruneState.lastCompletedAt = null;
  pruneState.lastDeleted = null;
  pruneState.lastError = null;
  try {
    const deleted = await pruneFacebookPosts(retentionDays);
    pruneState.lastDeleted = deleted;
    pruneState.lastCompletedAt = new Date().toISOString();
    console.log(
      `[${new Date().toISOString()}] Pruned ${deleted} Facebook post(s) older than ${retentionDays} day(s)`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pruneState.lastError = message;
    pruneState.lastCompletedAt = new Date().toISOString();
    console.error(`Prune job failed:`, message);
    console.error(`[ALERT] Prune job failed and retention may not be enforced until the next successful run.`);
  } finally {
    runInProgress = false;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertValidCronSchedule(schedule: string, label: string): void {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid ${label} cron expression: "${schedule}"`);
  }
}

const groups = loadGroups();
const defaultSchedule = process.env.SCRAPE_SCHEDULE || "0 */2 * * *"; // default for groups without explicit schedule
const pruneSchedule = process.env.PRUNE_SCHEDULE || "0 3 * * *";
const pruneRetentionDays = parsePositiveInteger(process.env.PRUNE_RETENTION_DAYS, 7);

assertValidCronSchedule(defaultSchedule, "default scrape schedule");
assertValidCronSchedule(pruneSchedule, "prune schedule");

const groupsBySchedule = new Map<string, GroupConfig[]>();
for (const group of groups) {
  const schedule = getGroupSchedule(group, defaultSchedule);
  assertValidCronSchedule(schedule, `schedule for group ${group.name}`);
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
startHealthServer();

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
