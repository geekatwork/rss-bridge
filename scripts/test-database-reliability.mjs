import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const service = process.argv[2];
assert.ok(["scraper", "feed-generator"].includes(service), "Expected scraper or feed-generator");
const moduleUrl = pathToFileURL(resolve(`packages/${service}/dist/database.js`)).href;
const sockets = new Set();
const startupParameters = [];
let acceptStartup = true;
let answerQueries = true;
let queryCount = 0;

function message(type, payload) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), length, payload]);
}
const ready = message("Z", Buffer.from("I"));
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  // Fault tests intentionally disconnect clients before they finish writing.
  socket.on("error", (error) => {
    if (error.code !== "ECONNRESET" && error.code !== "EPIPE") throw error;
  });
  let startup = true;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= (startup ? 4 : 5)) {
      const length = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
      if (buffer.length < length) return;
      const packet = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      if (startup) {
        startup = false;
        startupParameters.push(packet.subarray(8).toString());
        if (acceptStartup) {
          socket.write(Buffer.concat([message("R", Buffer.alloc(4)), ready]));
        }
      } else if (packet[0] === 81) {
        queryCount++;
        if (answerQueries) {
          socket.write(Buffer.concat([message("C", Buffer.from("SELECT 1\0")), ready]));
        }
      }
    }
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${address.port}/test?sslmode=disable`;
process.env.DB_CONNECT_TIMEOUT_MS = "100";
process.env.DB_QUERY_TIMEOUT_MS = "100";
const db = await import(moduleUrl);
const errors = [];
const originalError = console.error;
console.error = (value) => errors.push(JSON.parse(value));

async function waitFor(predicate) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for protocol event");
    await delay(5);
  }
}

try {
  assert.equal(db.getDatabaseHealth().status, "unknown");
  assert.equal(await db.checkDatabase(), true);
  assert.equal(db.getDatabaseHealth().status, "ok");
  assert.ok(startupParameters[0].includes("statement_timeout\0" + "100\0"));

  // An error on an idle client must be handled, not become an uncaught EventEmitter error.
  for (const socket of sockets) socket.destroy();
  await waitFor(() => db.getDatabaseHealth().status === "degraded");
  assert.equal(errors.at(-1).event, "database_pool_error");
  assert.equal(await db.checkDatabase(), true);
  assert.equal(db.getDatabaseHealth().lastError, null);

  // Real pg connection succeeds, but a sent query never receives any response.
  answerQueries = false;
  let started = performance.now();
  await assert.rejects(db.query("SELECT 1"), /Query read timeout/);
  assert.ok(performance.now() - started < 2_000, "Query timeout was not bounded");
  assert.equal(db.getDatabaseHealth().status, "degraded");
  await waitFor(() => sockets.size === 0);
  answerQueries = true;
  assert.equal(await db.checkDatabase(), true);

  // Full pool: connection acquisition must time out instead of waiting behind stalled queries.
  answerQueries = false;
  const previousQueries = queryCount;
  const busy = Array.from({ length: 10 }, () => db.checkDatabase());
  await waitFor(() => queryCount >= previousQueries + 10);
  started = performance.now();
  assert.equal(await db.checkDatabase(), false);
  assert.ok(performance.now() - started < 500, "Pool acquisition timeout was not bounded");
  assert.deepEqual(await Promise.all(busy), Array(10).fill(false));
  await waitFor(() => sockets.size === 0);
  answerQueries = true;
  assert.equal(await db.checkDatabase(), true);

  // Accept TCP but never complete the PostgreSQL startup handshake.
  for (const socket of sockets) socket.destroy();
  await waitFor(() => db.getDatabaseHealth().status === "degraded");
  acceptStartup = false;
  started = performance.now();
  assert.equal(await db.checkDatabase(), false);
  assert.ok(performance.now() - started < 500, "Connection handshake timeout was not bounded");
  await waitFor(() => sockets.size === 0);
  acceptStartup = true;
  assert.equal(await db.checkDatabase(), true);
  assert.equal(db.getDatabaseHealth().status, "ok");
  assert.ok(db.getDatabaseHealth().lastSuccessAt);
  assert.ok(errors.some((error) => error.event === "database_query_error"));
  assert.ok(errors.every((error) => error.service === service));

  for (const name of ["DB_CONNECT_TIMEOUT_MS", "DB_QUERY_TIMEOUT_MS"]) {
    for (const value of ["", "0", "-1", "abc", "1.5", "2147483648"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`], {
        env: { ...process.env, [name]: value }, encoding: "utf8", timeout: 3_000,
      });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`${name} must be a positive integer`));
    }
  }
  console.log(`PASS: ${service}: idle errors, unresponsive queries, pool exhaustion, handshake timeouts, recovery and invalid configuration`);
} finally {
  console.error = originalError;
  await db.closeDb();
  for (const socket of sockets) socket.destroy();
  server.close();
  await once(server, "close");
}
