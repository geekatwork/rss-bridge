# Modular Scraper Architecture

## Overview

The scraper is a plugin-based system where each source is implemented as a dedicated site scraper class behind one shared lifecycle.

Design goals:
1. No source-specific logic in the core engine.
2. Add new sources by adding/registering a scraper class.
3. Reuse shared utilities for retries, logging, and normalization.
4. Persist a unified item shape for all sources.

## Runtime Flow

1. `src/index.ts` reads `SCRAPE_GROUPS` and schedule settings.
2. For each configured group, it resolves:
   - `groupId` from `groupId | sourceId | id`
   - `siteId` from config or inferred from group URL hostname
3. The orchestrator upserts/ensures the group row (`groups.source_id`).
4. `ScrapeEngine` is initialized and receives one site config (`registerSite`).
5. `ScrapeEngine.scrapeOne(siteId)` runs the registered site scraper lifecycle.
6. Returned `NormalizedItem[]` is persisted via `upsertItems()` into `posts` (`source_post_id`).
7. Cron triggers repeat runs with jitter.

## Core Components

- `src/index.ts`
  - Loads `SCRAPE_GROUPS`
  - Schedules runs with `node-cron`
  - Orchestrates `ScrapeEngine` and DB writes
- `src/ScrapeEngine.ts`
  - Launches Puppeteer browser
  - Registers site configs
  - Creates scraper instance via registry
  - Builds `ScraperContext` and executes scraper `run()`
- `src/sourceConfig.ts`
  - Validates scheduled group inputs and source-specific options
  - Maps authoritative group URLs/identifiers into plugin options
  - Applies per-group option precedence and database incremental boundaries
- `src/core/SiteScraper.ts`
  - Abstract lifecycle contract:
    - `canHandle()`
    - `init()`
    - `fetchListing()`
    - `extractItems()`
    - `resolveLinks()`
    - `hasMorePages()`
    - `nextPage()`
    - `shutdown()`
    - `run()`
  - Stops pagination after three recoverable failed pages or three successful
    empty pages; nonempty success resets both counters, failures reset the empty
    counter. Empty termination is healthy, but recorded failures remain errors.
  - Validates a positive integer page limit (default 10) before initialization;
    always attempts shutdown. See [page failure handling](src/sites/README.md#page-failure-handling).
- `src/core/ScrapeRegistry.ts`
  - Maps `siteId` -> scraper class
- `src/db.ts`
  - Ensures groups
  - Upserts normalized items

## Error contract

Lifecycle methods should throw `Error` instances. Core exports
`ScraperConfigurationError` for invalid configuration/registration,
`ScraperStateError` for invalid engine/plugin lifecycle state, and
`RecoverablePageError` for page-local failures with safe pagination advancement.
All support an optional `cause`. Configuration, state, transport, authentication,
and cancellation errors remain fatal; only explicit `RecoverablePageError`
from fetch/extract/resolve enables advancement. Pagination and cleanup failures
never implicitly retry. The runner preserves partial resolved items and prior
errors and always attempts shutdown.

`scraperErrorMessage(unknown)` is the shared caught-error boundary for plugin,
engine, scheduler, retry, and database health reporting. It preserves ordinary
Error messages and string-valued own data `message` properties, handles primitive
throws, and reports unsupported objects explicitly without serializing arbitrary
request/credential payloads or calling object getters/toString. Malformed
accessors/proxies cannot prevent error reporting. `ScrapeResult.errors` remains
`string[]`; no retry classification or alert policy changes are introduced.

## Resource ownership and cleanup

- The scheduled orchestrator creates an engine for each group and always awaits
  engine shutdown. On a group deadline it aborts the signal, requests browser
  shutdown, and waits for active work to settle before starting the next group.
- `ScrapeEngine` owns browser launch/close. Its shutdown request is terminal;
  repeated calls share the same close promise, including a close failure.
  Plugins borrow `context.browser` and must not launch/close it themselves.
- Plugins own pages allocated with `context.browser.newPage()`. Assign each page
  to a field immediately, before viewport/cookie/login setup can fail.
  `SiteScraper.run()` attempts plugin shutdown even after partial initialization,
  cancellation, extraction or resolution failure. API-only plugins need not
  allocate any pages.
- Detach page fields before awaiting cleanup. Use shared
  `closeOwnedPage(page)` for absent/already-closed pages and normal close;
  failures propagate for the runner to log and append to existing result errors.
  Reset other plugin state in `finally` when page closure can fail.
- Dispose temporary JS/element handles in `finally`. Remove only listeners and
  timers created by the plugin, including timeout/failure paths. Scope popup
  ownership to its opener; never close all browser tabs or mutate another job's
  page. `context.page`, if supplied, is borrowed unless explicitly transferred.
- Use abort-aware bounded requests and check `context.signal` around long work.
  Cancellation does not replace cleanup. Browser closure may have already
  closed a plugin's page; cleanup must tolerate that without hiding real errors.

The browser engine's existing launch/shutdown methods are the shared browser
lifecycle implementation; no second browser-launch wrapper is necessary.
The example, Facebook and Competitions NZ plugins reuse `closeOwnedPage`.

## Concurrency model

Production scheduling is serial within one scraper process. `runAllGroups`
awaits each group's scrape, persistence and engine shutdown before starting the
next group. The shared `runInProgress` guard covers the entire cycle and prune:
overlapping ordinary schedules are skipped, while missed executions coalesce
into the serialized recovery queue. A timeout aborts the group and closes its
browser, but retains the guard until active work settles. `scrapeAll()` also
runs sites sequentially.

Each scheduled group gets its own `ScrapeEngine`, browser and abort controller.
Each `scrapeOne()` creates a new plugin instance, context and random job ID.
Plugin page/pagination state must stay instance-local; never reuse one plugin
instance for overlapping `run()` calls. The registry shares constructors, not
plugin instances.

Custom callers can overlap different groups/sites with separate engines, using
`Promise.all` and a `finally` that awaits every engine's shutdown. This provides
browser cookie/session, cancellation and cleanup isolation even for two groups
using the same plugin. Separate plugin instances on one engine still share the
browser's cookies, and shutting down that engine affects every job using it;
that is not the supported group-isolation pattern. Do not overlap engine init
or shut down an engine while unrelated work still needs its browser.

No additional mutex is needed for the current single-process serial scheduler.
Its in-memory guard is not distributed: multiple scraper replicas would need
cross-process scheduling/retention coordination before being enabled. Database
uniqueness prevents duplicate rows, not concurrent browser sessions or duplicate
scrape work. Parallelism would also require deliberate resource/rate budgets.
This story validates isolation; it does not enable production parallelism.

Tests in `ScrapeEngine.test.ts` use explicit barriers to prove two separate
engines overlap for same-site and different-site jobs, with distinct contexts,
configurations, job IDs and browser ownership. Cancelling/closing one leaves the
other able to finish. `index.test.ts` verifies persistence/cleanup serialization,
overlap/prune exclusion and deadline settlement before releasing the run guard.

## Separate browser container assessment

### Recommendation

Retain local Chromium as the default for now. A separate browser image is
feasible, but is not a drop-in replacement for `puppeteer.launch()`: it changes
group isolation, timeout termination, network access and deployment ownership.
Implement it only as an explicit opt-in after the validation gates below pass.
This assessment adds no remote-browser setting or Compose service.

The current scraper image includes Chromium and launches a fresh browser per
scheduled group. Chromium and Node share the scraper container's resource
budget. A split can remove Chromium from the remote-only scraper image and give
browser CPU/memory its own container limits, but adds connection/service failure
modes and does not remove Node-side blocking or prove a scheduler reliability
improvement. No image-size, memory or latency improvement is claimed without
measurement.

An older standalone browser container may exist on a host, but it is not part
of the current Compose definition or engine connection path. Do not infer that
the scraper uses it, reuse it without compatibility/session verification, or
remove it as an orphan during deployment.

### Lifecycle and isolation

| Concern | Local default | Required remote design |
| --- | --- | --- |
| Allocation | Engine launches its own browser | Acquire a fresh, exclusively owned browser session per group, or define isolated contexts with provider-enforced termination |
| Cookies | Fresh browser per group; plugin loads mounted cookies | Cookie injection occurs over the connection; no shared default context between groups |
| Cleanup | Engine closes owned browser | Close only the owned session/context, await termination acknowledgement, then disconnect |
| Deadline | Abort and browser close settle active work | Disconnect alone is insufficient: remote work can continue; provider must enforce a bounded session deadline and orphan cleanup |
| Failure | Browser loss fails that group's work | Connection loss, browser restart and failed cleanup must surface in group health and prevent unsafe session reuse |

Puppeteer's connected `browser.close()` sends `Browser.close` to the remote
browser; it must not be used against a process shared with unrelated clients.
`disconnect()` detaches the client without terminating the browser. A provider
session API or exclusive per-connection browser must define what close means.
Do not blindly reconnect/retry an in-progress extraction or persistence step.
Retain current partial-result/error reporting and serialized scheduling.

Plugins should continue receiving the same borrowed `context.browser`; session
acquisition/release belongs in the engine, not individual plugins. Cookie files
can remain mounted only in the scraper: cookies are sent through Puppeteer, not
read by Chromium from that mount. Downloads, browser-side files and any future
filesystem APIs need explicit remote storage handling.

### Connectivity and resource boundaries

- Use a dedicated internal control network. Never publish the DevTools/WebSocket
  control endpoint publicly or put endpoint credentials into logs, examples or
  committed configuration. Use authenticated access where the provider supports
  it and TLS when crossing trusted local-network boundaries.
- The browser needs outbound DNS/HTTPS for source pages and redirects; the
  scraper still needs outbound access for API/HTTP plugins. An internal control
  network alone cannot provide browser internet access; separate egress routing
  must be configured. The browser must not receive database credentials or
  unnecessary database-network access.
- Browser-side `localhost` refers to the browser container, not the scraper.
  Fixture services in smoke tests must be reachable from that container.
  Container DNS and proxy/source allowlists must cover redirects and media.
- Pin the browser/provider image and verify Chrome/DevTools compatibility with
  the locked Puppeteer client. An old image labeled with a Puppeteer version is
  not evidence of compatibility with the current client.
- Set measured CPU/memory, shared-memory and writable-temp budgets, session
  limits and queue timeouts. Queue/connect time counts toward the group deadline.
  Splitting containers moves resource consumption; it does not eliminate it.
  Define session expiry and quotas independently of scraper-client survival.
- Preserve least-privilege operation and evaluate Chromium sandbox support for
  the chosen image/runtime rather than mechanically copying local launch flags.

### Deployment and validation gates

1. Select a maintained, pinned provider/image and verify its session ownership,
   termination and authentication contracts. Measure image size, peak memory,
   CPU, connection latency and scrape duration against the local baseline.
2. Add explicit local/remote mode validation with no silent fallback to local
   Chromium on remote failure. Keep the current local configuration working.
   A smaller remote-only image and a local image require deliberate build targets;
   removing Chromium unconditionally would break the local default.
3. Test fresh per-group cookies, same-site isolation, native clicks/popups,
   timestamps, partial results, close failure, deadline termination, orphan
   expiry, connection refusal/loss and browser-container restart. Confirm no
   session survives a completed/failed group beyond its bounded expiry.
4. Run the isolated smoke suite with browser-accessible fixture networking.
   Extend readiness to validate actual session acquisition, not just a listening
   socket; report remote outages without success-shaped fallback.
5. Stage one group, then a complete cycle and scheduled recovery/prune. Roll out
   only after an idle check, without restarting the database or feed generator.
   Keep a documented local-mode rollback and drain/terminate owned remote sessions
   before switching modes. Do not use `--remove-orphans` to manage unrelated
   host containers.

No additional deployment is required to accept this assessment. A remote-browser
implementation should be a separate, explicitly approved change after these
ownership and operational decisions are settled.

## Current File Structure

```text
packages/scraper/src/
├── core/
│   ├── SiteScraper.ts
│   ├── ScrapeRegistry.ts
│   ├── types.ts
│   ├── utils.ts
│   └── index.ts
├── sites/
│   ├── README.md
│   ├── ExampleScraper.ts
│   ├── facebook/
│   │   ├── FacebookScraper.ts
│   │   ├── graphApi.ts
│   │   └── index.ts
│   ├── reddit/
│   │   ├── RedditScraper.ts
│   │   └── index.ts
│   └── index.ts
├── ScrapeEngine.ts
├── db.ts
├── index.ts
└── types.ts
```

## Configuration

### SCRAPE_GROUPS

`SCRAPE_GROUPS` is a JSON array. Each object supports:
- `groupId` (preferred)
- `sourceId` (accepted alias)
- `id` (accepted alias)
- `siteId` (optional; inferred from URL hostname if omitted)
- `name`
- `url`
- `options` (optional; source-specific validated settings)

See the root [SCRAPE_GROUPS contract](../../README.md#scrape_groups-format) for
supported options and examples. Invalid options/identities fail startup rather
than being silently discarded. Reddit derives one subreddit per configured URL;
Competitions NZ and example-site receive the listing URL; Facebook preserves
the configured group URL and enforces chronological sorting. Database-derived
incremental boundaries cannot be overridden in options.

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

### Other environment variables

- `SCRAPE_SCHEDULE` (cron, default `0 */2 * * *`)
- `SOURCE_COOKIE_FILE` (optional; passed to site scraper)
- `SCRAPE_GROUP_TIMEOUT_MS` (whole-group deadline, default 1200000)
- `FACEBOOK_BOUNDARY_FALLBACK_LIMIT` (default 50)
- `PUPPETEER_EXECUTABLE_PATH` (optional)

### Cookie file layout

Preferred layout is site-scoped directly under `cookies`:

```text
cookies/
  facebook/
    fb_cookies.json
    fb_cookies.example.json
```

Facebook scraper cookie path resolution order:
1. Per-group `options.cookieFile` (if set)
2. `SOURCE_COOKIE_FILE` (if set)
3. `/app/cookies/facebook/fb_cookies.json` (default)

Commit only redacted example files (`*.example.json`); keep live cookie files local and ignored.

## Data Model (Current)

DB columns are source-generic:
- `groups.source_id`
- `posts.source_post_id`

The scraper persists normalized fields (author/content/link/media/published date) independent of source.

## Add a New Site

1. Create scraper class (usually by copying `src/sites/ExampleScraper.ts`).
2. Implement all `SiteScraper` lifecycle methods.
3. Register it in `src/sites/index.ts` with `globalRegistry.register("my-site", MySiteScraper)`.
4. Add validation/adapter support in `src/sourceConfig.ts` for any scheduled
   source options, then add a `SCRAPE_GROUPS` entry using `siteId: "my-site"`.
5. Run locally and verify DB writes.

## Local Development Commands

From `packages/scraper`:

```bash
npm run build
npm run dev
```

Minimal local run example:

```bash
export SCRAPE_GROUPS='[{"groupId":"demo-group","siteId":"example-site","name":"Example","url":"https://example.com"}]'
npm run dev
```

## Notes

- Site-specific behavior belongs in site scraper implementations under `src/sites/*`.
- Core/orchestrator code should remain source-neutral.
- `sites/README.md` is the quick-start for adding new site scrapers.
