import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

for (const [port, configured, expected] of [
  [undefined, undefined, "http://localhost:3100"],
  ["4317", undefined, "http://localhost:4317"],
  ["4317", "https://feeds.example.test:8443/rss/base/", "https://feeds.example.test:8443/rss/base/"],
]) {
  const env = {
    ...process.env,
    POSTGRES_PASSWORD: "compose-test-only",
    SCRAPE_GROUPS: "[]",
  };
  delete env.FEED_PORT;
  delete env.FEED_BASE_URL;
  if (port !== undefined) env.FEED_PORT = port;
  if (configured !== undefined) env.FEED_BASE_URL = configured;
  const config = JSON.parse(execFileSync("docker", [
    "compose", "--env-file", "/dev/null", "-f", "docker-compose.yml", "config", "--format", "json",
  ], { env, encoding: "utf8" }));
  assert.equal(config.services["feed-generator"].environment.FEED_BASE_URL, expected);
  assert.equal(Number(config.services["feed-generator"].environment.PORT), 80);
  assert.equal(String(config.services["feed-generator"].ports[0].published), port ?? "3100");
}
console.log("[test-smoke] Production Compose public feed URLs verified without starting services");
