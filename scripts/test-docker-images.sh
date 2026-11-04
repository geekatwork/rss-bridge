#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
services=("$@")
if [ "$#" -eq 0 ]; then
  services=(scraper feed-generator)
fi

image=""
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if [ -n "$image" ]; then docker image rm "$image" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

for service in "${services[@]}"; do
  case "$service" in
    scraper|feed-generator) ;;
    *) echo "Unknown service: $service" >&2; exit 1 ;;
  esac
  image="rss-bridge-test-${service}:$$"
  container="rss-bridge-test-${service}-$$"
  docker build -f "packages/$service/Dockerfile" -t "$image" .
  docker run --rm --init -i --name "$container" --network none --read-only \
    --tmpfs /tmp -e HOME=/tmp -e XDG_CACHE_HOME=/tmp/.cache \
    -e XDG_CONFIG_HOME=/tmp/.config -e SERVICE="$service" \
    --entrypoint node "$image" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

async function main() {
  const service = process.env.SERVICE;
  assert.equal(process.cwd(), `/app/packages/${service}`);
  const lock = JSON.parse(fs.readFileSync("/app/package-lock.json", "utf8"));
  let checked = 0;
  function checkPackage(directory) {
    if (fs.lstatSync(directory).isSymbolicLink()) return;
    const installed = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const key = path.relative("/app", directory);
    const locked = lock.packages[key];
    assert.ok(locked, `Unexpected dependency: ${key}`);
    assert.equal(installed.version, locked.version, `Lockfile mismatch: ${key}`);
    assert.notEqual(locked.dev, true, `Development dependency in runtime: ${key}`);
    checked++;
    checkModules(path.join(directory, "node_modules"));
  }
  function checkModules(directory) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(".")) continue;
      const location = path.join(directory, name);
      if (name.startsWith("@")) {
        for (const child of fs.readdirSync(location)) checkPackage(path.join(location, child));
      } else {
        checkPackage(location);
      }
    }
  }
  checkModules("/app/node_modules");
  checkModules(path.join(process.cwd(), "node_modules"));
  assert.ok(checked > 0);
  for (const dependency of Object.keys(require("./package.json").dependencies)) {
    require.resolve(dependency);
  }
  for (const dependency of ["typescript", "vitest", "tsx"]) {
    assert.throws(() => require.resolve(dependency), { code: "MODULE_NOT_FOUND" });
  }
  assert.ok(!fs.existsSync("/usr/local/bin/npm"));
  assert.ok(!fs.existsSync("/usr/local/bin/npx"));

  if (service === "scraper") {
    assert.equal(process.getuid(), 10001);
    assert.equal(process.getgid(), 10001);
    assert.throws(() => require.resolve("express"), { code: "MODULE_NOT_FOUND" });
    require("./dist/ScrapeEngine.js");
    const browser = await require("puppeteer").launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>docker-smoke</title>");
      assert.equal(await page.title(), "docker-smoke");
    } finally {
      await browser.close();
    }
  } else {
    assert.throws(() => require.resolve("puppeteer"), { code: "MODULE_NOT_FOUND" });
    const feed = new (require("feed").Feed)({ title: "Test", id: "test", copyright: "" });
    assert.match(feed.rss2(), /<rss/);
    const server = spawn(process.execPath, ["dist/index.js"], {
      env: {
        ...process.env, PORT: "3100",
        DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
        DB_CONNECT_TIMEOUT_MS: "100", DB_QUERY_TIMEOUT_MS: "100",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exited = once(server, "exit");
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (server.exitCode !== null) throw new Error(`Feed server exited: ${server.exitCode}`);
        const reachable = await fetch("http://127.0.0.1:3100/health")
          .catch((error) => {
            if (error.cause?.code !== "ECONNREFUSED") throw error;
            return null;
          });
        if (reachable) {
          assert.equal(reachable.status, 503);
          const health = await reachable.json();
          assert.equal(health.status, "degraded");
          assert.equal(health.database.status, "degraded");
          assert.ok(health.database.lastError);
          healthy = true;
          break;
        }
        await delay(100);
      }
      assert.ok(healthy, "Feed health endpoint did not become ready");
    } finally {
      server.kill("SIGTERM");
      await exited;
    }
  }
  console.log(`PASS: ${service}: ${checked} locked production packages; runtime smoke test passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
JS
  cleanup
  image=""
  container=""
done
