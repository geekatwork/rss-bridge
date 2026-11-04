import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const prefix = `rss-bridge-volume-test-${Date.now()}-${process.pid}`;
const source = `${prefix}-source`;
const container = `${prefix}-db`;
const runner = `${prefix}-pwsh`;
const directory = mkdtempSync(join(tmpdir(), "rss-bridge-volume-"));
const volumes = [];
const destinations = [];
const root = process.cwd();
const dockerBinary = execFileSync("readlink", ["-f", execFileSync("which", ["docker"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();
const postgres = "postgres:16-alpine";
const powershell = "mcr.microsoft.com/powershell:7.4-debian-12";
function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}
function volume(name) {
  docker(["volume", "create", name]);
  volumes.push(name);
}
function runMigration(destination, failure = "") {
  const result = spawnSync("docker", [
    "run", "--rm", "--name", runner, "--network", "none",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${dockerBinary}:/usr/local/bin/docker:ro`,
    "-v", `${root}:/workspace:ro`,
    "-v", `${root}/tests/volume/docker-test-wrapper.sh:/test-bin/docker:ro`,
    "-e", "PATH=/test-bin:/usr/local/bin:/usr/bin:/bin",
    "-e", `VOLUME_TEST_FAILURE=${failure}`,
    powershell, "pwsh", "-NoProfile", "-File", "/workspace/scripts/migrate-volume.ps1",
    "-OldVolume", source, "-NewVolume", destination, "-BackupDirectory", directory,
    "-DatabaseUser", "volume_test", "-DatabaseName", "volume_test",
  ], { encoding: "utf8", timeout: 180_000 });
  if (result.error) throw result.error;
  return result;
}
function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, "Unsafe migration unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  assert.ok(!result.stdout.includes("Migration verified."));
}
function empty(name) {
  return docker(["run", "--rm", "--network", "none", "-v", `${name}:/data:ro`,
    "--entrypoint", "sh", postgres, "-ec", "ls -A /data"]) === "";
}
try {
  volume(source);
  docker(["run", "-d", "--name", container, "--network", "none", "-v", `${source}:/var/lib/postgresql/data`,
    "-e", "POSTGRES_USER=volume_test", "-e", "POSTGRES_DB=volume_test", "-e", "POSTGRES_PASSWORD=test-only",
    "-v", `${resolve("db")}:/docker-entrypoint-initdb.d:ro`, postgres]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "volume_test", "-d", "volume_test"]);
    if (probe.status === 0) { ready = true; break; }
    await delay(1_000);
  }
  assert.ok(ready, "Source database did not become ready");
  docker(["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "volume_test", "-d", "volume_test",
    "-c", "INSERT INTO groups(source_id,name,url) VALUES ('preserved','Preserved','https://example.test'); INSERT INTO posts(group_id,source_post_id,posted_at) VALUES (1,'preserved-post',NOW());"]);
  const activeSourceDestination = `${prefix}-active`;
  destinations.push(activeSourceDestination);
  expectFailure(runMigration(activeSourceDestination), /in use/);
  assert.ok(!docker(["volume", "ls", "--format", "{{.Name}}"]).split("\n").includes(activeSourceDestination));
  docker(["stop", "--time", "60", container]);
  docker(["rm", container]);
  const sourceControl = docker(["run", "--rm", "--network", "none", "-v", `${source}:/data:ro`,
    "--entrypoint", "sha256sum", postgres, "/data/global/pg_control"]);
  expectFailure(runMigration(source), /must differ/);

  const rejected = `${prefix}-rejected`;
  destinations.push(rejected);
  docker(["run", "--rm", "--network", "none", "-v", `${source}:/data`,
    "--entrypoint", "sh", postgres, "-ec", "echo 15 > /data/PG_VERSION"]);
  expectFailure(runMigration(rejected), /Source must be a PostgreSQL 16 cluster/);
  docker(["run", "--rm", "--network", "none", "-v", `${source}:/data`,
    "--entrypoint", "sh", postgres, "-ec", "echo 16 > /data/PG_VERSION; echo stopped-uncleanly > /data/postmaster.pid"]);
  expectFailure(runMigration(rejected), /Source postmaster.pid exists/);
  docker(["run", "--rm", "--network", "none", "-v", `${source}:/data`,
    "--entrypoint", "rm", postgres, "/data/postmaster.pid"]);
  assert.ok(!docker(["volume", "ls", "--format", "{{.Name}}"]).split("\n").includes(rejected));

  const occupied = `${prefix}-occupied`;
  volume(occupied);
  docker(["run", "--rm", "--network", "none", "-v", `${occupied}:/data`, "--entrypoint", "sh", postgres,
    "-ec", "echo preserve-me > /data/sentinel"]);
  expectFailure(runMigration(occupied), /Destination is not empty/);
  assert.equal(docker(["run", "--rm", "--network", "none", "-v", `${occupied}:/data:ro`,
    "--entrypoint", "cat", postgres, "/data/sentinel"]), "preserve-me");
  assert.equal(readdirSync(directory).length, 0);

  const activeDestination = `${prefix}-destination-active`;
  volume(activeDestination);
  docker(["run", "-d", "--name", container, "--network", "none",
    "-v", `${activeDestination}:/data`, "--entrypoint", "sleep", postgres, "300"]);
  expectFailure(runMigration(activeDestination), /in use/);
  docker(["rm", "-f", container]);

  for (const failure of ["backup", "copy", "shutdown", ""]) {
    const destination = `${prefix}-${failure || "success"}`;
    volume(destination);
    destinations.push(destination);
    const result = runMigration(destination, failure);
    if (failure) {
      expectFailure(result, /Injected .* failure/);
      if (failure !== "shutdown") assert.ok(empty(destination));
    } else {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Migration verified/);
      docker(["run", "-d", "--name", container, "--network", "none",
        "-v", `${destination}:/var/lib/postgresql/data`, postgres]);
      let verified = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const check = spawnSync("docker", ["exec", container, "psql", "-X", "-At", "-U", "volume_test", "-d", "volume_test",
          "-c", "SELECT source_post_id FROM posts"], { encoding: "utf8" });
        if (check.status === 0) {
          assert.equal(check.stdout.trim(), "preserved-post");
          verified = true;
          break;
        }
        await delay(1_000);
      }
      assert.ok(verified, "Destination content verification failed");
      docker(["stop", "--time", "60", container]);
      docker(["rm", container]);
    }
  }
  for (const backup of readdirSync(directory)) {
    assert.equal(statSync(join(directory, backup)).mode & 0o777, 0o600);
  }
  assert.equal(docker(["run", "--rm", "--network", "none", "-v", `${source}:/data:ro`,
    "--entrypoint", "sha256sum", postgres, "/data/global/pg_control"]), sourceControl);
  console.log("PASS: active source and occupied destination refused; backup/copy/shutdown failures stop execution; verified copy preserves data; source retained");
} finally {
  for (const name of [container, runner]) {
    const exists = spawnSync("docker", ["container", "inspect", name]);
    if (exists.status === 0) docker(["rm", "-f", name]);
  }
  // Only test-created names are removed; the migration itself never deletes volumes.
  for (const name of new Set([...volumes, ...destinations])) {
    const exists = spawnSync("docker", ["volume", "inspect", name]);
    if (exists.status === 0) docker(["volume", "rm", name]);
  }
  for (const file of readdirSync(directory)) rmSync(join(directory, file));
  rmdirSync(directory);
}
