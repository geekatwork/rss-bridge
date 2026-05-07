import { closeDb, pruneFacebookPosts } from "./db.js";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const retentionDays = parsePositiveInteger(process.env.PRUNE_RETENTION_DAYS, 7);
  const deleted = await pruneFacebookPosts(retentionDays);
  console.log(
    `[${new Date().toISOString()}] Pruned ${deleted} Facebook post(s) older than ${retentionDays} day(s)`
  );
}

main()
  .catch((err) => {
    console.error("One-shot prune failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });