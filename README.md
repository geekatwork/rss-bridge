# RSS Bridge: Source Groups to RSS

[![CI](https://github.com/geekatwork/rss-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/geekatwork/rss-bridge/actions/workflows/ci.yml)

A Docker-based monorepo that scrapes source group content and exposes it as RSS feeds for readers like Tiny Tiny RSS.

## What Runs

This project runs three core services:

- PostgreSQL: stores normalized groups and posts.
- Scraper: plugin-based extraction on a schedule (with jitter).
- Feed Generator: serves RSS from stored posts.

Optional tooling:

- pgAdmin: browser UI for inspecting the PostgreSQL database.

## Architecture

```text
┌──────────────┐     subscribes     ┌──────────────────┐     reads    ┌──────────────┐
│   RSS Reader │ ──────────────────>│  Feed Generator  │ ────────────>│  PostgreSQL  │
│   (TTRSS)    │    RSS/Atom XML    │  (Express HTTP)  │              │              │
└──────────────┘                    └──────────────────┘              └──────────────┘
                                                                            ▲
                                                                            │ writes
                                                                      ┌──────────────┐
                                                                      │   Scraper    │
                                                                      │ (cron+jitter)│
                                                                      └──────────────┘
```

## Repository Layout

```text
.
├── docker-compose.yml
├── db/
│   └── 01-init.sql
├── cookies/
│   └── facebook/
├── packages/
│   ├── feed-generator/
│   │   └── README.md
│   └── scraper/
│       ├── ARCHITECTURE.md
│       └── src/
└── README.md
```

## Data Model

Schema uses source-generic identifiers:

- `groups.source_id`
- `posts.source_post_id`

## Quick Start

1. Create or update `.env` in repo root:
   - `POSTGRES_PASSWORD=<strong password>`
   - `SCRAPE_GROUPS=<json array>`
   - `PRUNE_RETENTION_DAYS=7` (optional; Facebook groups only)
   - `PRUNE_SCHEDULE=0 3 * * *` (optional; daily prune cron)

2. Start the stack:

   ```bash
   docker compose up -d
   ```

3. Verify services:

   ```bash
   curl http://localhost:3100/health
   curl http://localhost:3100/feeds
   curl http://localhost:3100/feed/<groupId>
   docker compose logs scraper --tail=100
   ```

4. Optional: start pgAdmin for database inspection:

   ```bash
   docker compose --profile tools up -d pgadmin
   ```

   Then open `http://localhost:5050` and sign in with:
   - email: `admin@example.com` or `PGADMIN_DEFAULT_EMAIL`
   - password: `admin` or `PGADMIN_DEFAULT_PASSWORD`

   Add a server in pgAdmin with:
   - host: `db`
   - port: `5432`
   - database: `rss_bridge` unless overridden by `POSTGRES_DB`
   - username: `rss_bridge` unless overridden by `POSTGRES_USER`
   - password: `POSTGRES_PASSWORD`

## SCRAPE_GROUPS Format

`SCRAPE_GROUPS` is a JSON array. Each object supports:

- `groupId` (preferred)
- `sourceId` (alias)
- `id` (alias)
- `siteId` (optional; inferred from URL hostname if omitted)
- `name`
- `url`

Example:

```json
[
  {
    "groupId": "1818585508476102",
    "siteId": "facebook",
    "name": "Instagram Contests",
    "url": "https://www.facebook.com/groups/1818585508476102"
  }
]
```

## Cookie File Layout

Use site-scoped cookie directories directly under `cookies`:

```text
cookies/
   facebook/
      fb_cookies.json
      fb_cookies.example.json
```

Notes:

- Keep real cookie files local only (ignored by `.gitignore`).
- Commit only redacted example files (for example, `*.example.json`).
- If needed, override the cookie path via `SOURCE_COOKIE_FILE`.

Competitions NZ destination-link lookups use a 10-second deadline per HTTP request
and inherit the active scrape's cancellation signal. Failed lookups are logged with
the competition ID and retain the original competitions.co.nz link.

## Feed Endpoints

- `GET /health` -> service health payload.
- `GET /feeds` -> discover available feed routes.
- `GET /feed/:groupId` -> RSS XML for one group.

Notes:

- Feed channel `link`/`id` intentionally points to the feed URL itself.
- Items with landing/root-like links are filtered out.

## Scraper Scheduler Diagnostics

The scraper logs JSON events alongside its existing scrape output:

- `job_scheduled`: cron's scheduled time, callback observation time, and intentional jitter.
- `job_started`, `job_finished`, `job_failed`: actual execution timestamps and monotonic duration.
- `job_skipped_locked`: work skipped by the existing shared scrape/prune lock.
- `job_missed`: cron reported a missed execution. The event records observation time;
  node-cron 4.2.1's missed-event date is not reliable as the missed scheduled time.
  The scraper queues one immediate catch-up per missed scrape schedule (or prune job);
  repeated misses for that same schedule are coalesced, and catch-ups wait for any
  active scrape/prune cycle to finish.
  An independent 30-second deadline check also detects schedules silently skipped
  by node-cron (including a delayed first heartbeat). After a 30-second grace
  period, it queues the same catch-up; late callbacks and missed events for that
  occurrence are coalesced. `schedule_missed` records whether node-cron or the
  watchdog detected the miss. This check stays active when runtime telemetry is off.
- `scheduler_runtime`: when enabled with `SCRAPER_RUNTIME_DIAGNOSTICS=true`, samples
  event-loop maximum/p99 delay, timer delay, and wall-clock drift every 30 seconds.
  Delays/drift above 2 seconds produce warnings. These distinguish symptoms, not
  definitive causes of host suspension. This sampling is disabled by default.

To temporarily enable these samples, set `SCRAPER_RUNTIME_DIAGNOSTICS=true` in the
Compose `.env` file and recreate the scraper:

```bash
docker compose up -d --force-recreate scraper
```

Set it to `false` (or remove the setting) and recreate the service again to stop
the samples. Health reporting and scheduled/missed/recovered job diagnostics remain
enabled regardless of this flag. Only the periodic runtime telemetry is disabled.

The internal scraper `GET /health` endpoint includes `jobs`, with per-group scrape
and prune timestamps, last success/error, missed/skipped counts, and freshness.
It returns HTTP 503 when any job is stale, the database probe fails, or existing
alert conditions apply. Both services probe Postgres with a bounded `SELECT 1` on
`GET /health`, returning `database` status, last error, and last successful query
time. Idle-client pool errors are logged as `database_pool_error`; query and
connection errors as `database_query_error`. Failed calls still reject (no empty
success fallback); subsequent successful queries can restore database health.
Successful empty scrapes count as success; reported scraper errors do not.

Group alerts remain active until an error-free run finishes persistence (when
there are items) and browser cleanup. Partial results may still be saved, but
cannot clear earlier alerts. Health tracks `auth_failure`, `timeout`,
`scrape_failure`, `database_failure` (setup or persistence), and `cleanup_failure`
independently; a healthy database probe alone does not clear a group's failed run.
Successful runs with no new posts also clear group alerts: no write is needed.
`consecutiveEmptyRuns` counts empty results with reported scraper errors, not
legitimate error-free incremental runs. Two such failed empty runs add
`repeated_empty`; any reported error already makes group health degraded immediately.
These alerts supplement existing job freshness; failed runs never advance last
success or its deadline.

Database limits are configured per process:

| Variable | Scraper default | Feed default |
| --- | --- | --- |
| `DB_CONNECT_TIMEOUT_MS` | 5000 | 5000 |
| `DB_QUERY_TIMEOUT_MS` | 30000 | 10000 |

Connection limits cover both pool acquisition and connection startup. Postgres
`statement_timeout` cancels statements after the query limit, including lock waits;
the client's read timeout is one second longer and evicts an unresponsive connection.
These are per-query limits, not whole-request or whole-scrape budgets. Invalid
values fail startup; only positive integers up to 2147482647 ms are accepted.
In Compose `.env`, use `SCRAPER_DB_QUERY_TIMEOUT_MS` and `FEED_DB_QUERY_TIMEOUT_MS`
to set service-specific query limits; `DB_CONNECT_TIMEOUT_MS` applies to both.
If increasing the scraper limits, also increase `SCRAPER_HEALTHCHECK_TIMEOUT`
(default `40s`) to exceed connection plus query limits plus one second.

Run `npm run test:database` to build both services and test real `pg` clients
against an isolated local protocol server: idle disconnects, unresponsive queries,
pool exhaustion, startup timeouts, and recovery. No production database is used.

Freshness allows the next cron occurrence plus 10 minutes of jitter and a full
sequential scrape cycle (group count times the group timeout plus inter-group delay).
Startup receives the same cycle allowance. Each group's `SCRAPE_GROUP_TIMEOUT_MS`
(default 20 minutes) covers database setup, browser initialization, scraping, persistence,
and cleanup. On timeout, the scraper aborts the run and closes its browser. It waits for
in-flight work to settle before releasing the shared run lock, so a non-cancellable
operation can keep later groups queued until it finishes. Prune allows 5 minutes after
its scheduled time. Failed/skipped/missed runs do not extend the freshness deadline.
Missed-run recovery state is in memory and resets on process restart; startup scraping
continues to provide the existing restart behavior. This is not a durable distributed
queue and does not guarantee recovery after a crash during catch-up.
Docker health status alone does not trigger a restart under `restart: unless-stopped`.

Inspect the health payload from inside the container:

```bash
docker compose exec -T scraper sh -c 'wget -qO- "http://127.0.0.1:${SCRAPER_HEALTH_PORT:-8081}/health"'
```

For an incident, collect a bounded UTC log window and host events at the same times:

```bash
docker logs --timestamps --since "2026-11-02T05:50:00Z" --until "2026-11-02T06:20:00Z" rss-bridge-scraper
docker inspect rss-bridge-scraper --format '{{.State.Status}} Restarts={{.RestartCount}} OOM={{.State.OOMKilled}} Started={{.State.StartedAt}}'
docker events --since "2026-11-02T05:50:00Z" --until "2026-11-02T06:20:00Z" --filter container=rss-bridge-scraper
journalctl --utc --since "2026-11-02 05:50:00 UTC" --until "2026-11-02 06:20:00 UTC" --no-pager
```

Current container state is not historical proof of restart/OOM absence, and Docker
events may no longer be retained. Correlate runtime samples with host sleep/clock
events and CPU throttling before choosing a remediation.

## Retention

The scraper runs a daily retention job for Facebook groups only.

- Posts older than 7 days are deleted based on `posted_at`.
- The prune job is scoped to groups whose stored URL is a Facebook group URL.
- Other sources are not pruned by this job.

Tune or disable it with scraper environment variables:

- `PRUNE_RETENTION_DAYS` defaults to `7`.
- `PRUNE_SCHEDULE` defaults to `0 3 * * *`.

Run it on demand:

```bash
npm run -w packages/scraper prune
```

## Link Deduplication

Post links are treated as unique after URL canonicalization.

- Duplicate non-null links are skipped with a structured `post_duplicate_skipped` log
  (canonical-link match or unique-index race); full links/content are not logged.
- Existing rows are not merged or updated when another post arrives with the same canonical link.
- Repeat scrapes for the same `source_post_id` still follow the normal upsert path.
- Source IDs remain globally unique. A same-ID update from another group is rejected
  explicitly rather than overwriting the owning group's content.
- The database is the authoritative deduplication layer: the pre-insert canonical-link
  check avoids unnecessary writes, and unique constraints enforce identity/link
  integrity under concurrency. No additional engine-wide content-hash deduplication
  is performed. Plugins may deduplicate their own collected pages.

### Publication Dates and Incremental Boundaries

Scrapers mark a parsed source publication timestamp with `publishedAtIsSource: true`
(`postedAtIsSource` on the legacy post path). Missing flags mean fallback/unknown.
New rows always store a timestamp, but repeat fallback observations cannot change
the stored publication date. Source-derived observations can correct it; fallback
observations cannot downgrade its provenance. Existing rows start with unknown
provenance because their original timestamp quality cannot be inferred reliably.
Competitions NZ currently supplies scrape-time fallback dates.

Incremental boundary selection uses publication date descending, then row ID
descending for ties, rather than the timestamp of the last processed insert.
This avoids selecting the tail of a newest-to-oldest persistence batch.

Before deploying this change to an existing database, back up the database and apply
the additive, repeatable timestamp-provenance migration:

```bash
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/03-post-timestamp-provenance.sql
```

PostgreSQL entrypoint scripts run automatically only for new volumes. Existing
volumes require the explicit command above; it does not delete or backfill dates.

The optional PostgreSQL integrity test uses a uniquely named isolated schema and
removes it afterward. Supply a test database URL with schema-creation permission:

```bash
SCRAPER_TEST_DATABASE_URL=<test-database-url> npm run -w packages/scraper test:unit -- src/db.integration.test.ts
```

Without that variable the integration test is skipped; the regular unit tests still run.

## TT-RSS Docker Networking

If TT-RSS runs in Docker and subscribes to `http://feed-generator/feed/<groupId>`,
the TT-RSS containers must share a Docker network with this project.

Without the shared network, `feed-generator` may resolve in one TT-RSS container
but fail in another (for example, web UI checks can fail with DNS errors).

Add the external `rss-bridge` network to TT-RSS services in your TT-RSS
`docker-compose.yml`:

```yaml
services:
   app:
      networks:
         - ttrss_default
         - rss-bridge

   updater:
      networks:
         - ttrss_default
         - rss-bridge

   web-nginx:
      networks:
         - ttrss_default
         - rss-bridge

networks:
   ttrss_default:
      external: true
   rss-bridge:
      external: true
```

Then recreate TT-RSS services:

```bash
docker compose up -d --force-recreate app updater web-nginx
```

After that, TT-RSS can use feed URLs like:

- `http://feed-generator/feed/1818585508476102`

## Package Docs

- Scraper architecture and extension guide:
  - `packages/scraper/ARCHITECTURE.md`
  - `packages/scraper/src/sites/README.md`
- Feed generator architecture and operations:
  - `packages/feed-generator/README.md`

## Redeploying to Docker

Both service images install dependencies with `npm ci` from the root workspace
lockfile, scoped to the service being built. Build stages include development
tools; final images omit development and optional dependencies (including the
optional TypeScript peer), preserving the workspace layout for nested dependencies.
Chromium is installed only in the scraper runtime; Puppeteer's separate browser
download is disabled.

The scraper still runs as UID/GID `10001:10001`. Application files are root-owned
and readable by that user; only the browser cache needs writable ownership. Builds
do not recursively change ownership of application files or dependencies.
Container working directories are `/app/packages/scraper` and
`/app/packages/feed-generator`; cookie mounts remain at `/app/cookies`.

Validate both images without touching the running Compose stack:

```bash
npm run test:docker-images
```

These checks also run in CI. They compare installed package versions with the
lockfile, reject development dependencies, launch Chromium as the scraper user on
a read-only filesystem, and check RSS generation and a degraded feed health
response when the database is unavailable.
Test containers have no network access to other services and are removed afterward.

To apply code or dependency changes to your Docker container:

1. Rebuild the Docker image:
   ```sh
   docker-compose build
   ```
2. Restart the container with the new image:
   ```sh
   docker-compose up -d
   ```

This ensures your latest changes are reflected in the running service. For a specific service, use:
   ```sh
   docker-compose build <service_name>
   docker-compose up -d <service_name>
   ```

## pgAdmin

pgAdmin is available as an optional Compose service under the `tools` profile.

Start it:

```bash
docker compose --profile tools up -d pgadmin
```

Stop it:

```bash
docker compose --profile tools stop pgadmin
```

Remove it:

```bash
docker compose --profile tools rm -f pgadmin
```

Default access:

- URL: `http://localhost:5050`
- Email: `admin@example.com`
- Password: `admin`

Environment overrides:

- `PGADMIN_PORT`
- `PGADMIN_DEFAULT_EMAIL`
- `PGADMIN_DEFAULT_PASSWORD`
