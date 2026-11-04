import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
assert.ok(mode === "success" || mode === "failure", "Expected success or failure mode");
const groupId = process.argv[3] ?? (mode === "failure" ? "broken-test-group" : "smoke-test-group");
const deadline = Date.now() + 90_000;
let lastHealth;
while (Date.now() < deadline) {
  const response = await fetch("http://127.0.0.1:8081/health", { signal: AbortSignal.timeout(6_000) })
    .catch((error) => {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
      return null;
    });
  if (response) {
    lastHealth = await response.json();
    const jobs = lastHealth.jobs.filter((job) => job.jobId.startsWith("scrape:"));
    if (!lastHealth.runInProgress && jobs.some((job) => job.lastCompletedAt)) {
      assert.equal(lastHealth.database.status, "ok");
      assert.equal(lastHealth.jobs.some((job) => job.stale), false);
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(job.jobId, `scrape:${groupId}`);
      const group = lastHealth.groups.find((entry) => entry.groupId === groupId);
      assert.ok(group);
      if (mode === "success") {
        assert.equal(response.status, 200, JSON.stringify(lastHealth));
        assert.equal(lastHealth.status, "ok");
        assert.ok(job.lastSuccessAt, JSON.stringify(job));
        assert.equal(job.lastError, null);
        assert.deepEqual(group.activeReasons, []);
      } else {
        assert.equal(response.status, 503);
        assert.equal(lastHealth.status, "degraded");
        assert.equal(job.lastSuccessAt, null);
        assert.ok(job.lastError);
        assert.ok(group.activeReasons.includes("scrape_failure"));
      }
      console.log(`[test-smoke] ${mode}: completed job and health verified`);
      process.exit(0);
    }
  }
  await delay(500);
}
throw new Error(`Scraper did not complete before deadline: ${JSON.stringify(lastHealth)}`);
