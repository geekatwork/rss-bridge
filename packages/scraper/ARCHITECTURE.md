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
