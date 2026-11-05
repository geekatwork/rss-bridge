# Feed Generator

The feed-generator service exposes RSS feeds from normalized data stored in Postgres.

## What it does

- Serves health and discovery endpoints for available feeds.
- Generates RSS 2.0 XML for a specific source group.
- Filters out missing, landing/group and Facebook/Instagram CDN media destinations.

## Endpoints

- GET /health
  - Runs a bounded database probe; returns HTTP 200 when ready or HTTP 503 when
    the database is unavailable, including `database.status`, `lastError`, and
    `lastSuccessAt`. A later successful probe restores database readiness.

- GET /feeds
  - Returns available groups and feed paths.
  - Response shape:
    - groupId: source group identifier (groups.source_id)
    - name: display name
    - feedUrl: relative route to the feed

- GET /feed/:groupId
  - Returns RSS XML for one group.
  - Uses configured `FEED_BASE_URL` to set channel link/id to the feed URL itself.
    Request host/protocol and forwarded headers are never used.

## Architecture

The service has two layers:

1. HTTP layer (src/index.ts)
- Handles Express routes.
- Builds RSS output with the feed package.
- Renders the eligible post window returned by data access.

2. Data access layer (src/db.ts)
- Queries groups and posts from Postgres.
- Applies existing link eligibility checks during bounded post pagination.
- Uses source-generic schema fields:
  - groups.source_id
  - posts.source_post_id

Request flow:

1. Client requests /feed/:groupId.
2. Service loads group by source_id.
3. Service fetches latest posts for the group's internal id.
4. Service scans posts in batches of at most 100, ordered by publication date and
   row ID descending, excluding null/blank, landing/group and social CDN links before counting
   toward the 50-item output limit.
5. Service emits RSS XML.

Keyset pagination retains PostgreSQL's full timestamp precision to avoid skipping
rows tied within a millisecond. Scanning stops at 50 eligible items or exhaustion,
not an arbitrary raw-row cap, so newer ineligible rows cannot hide older valid
items. Memory and each query result are bounded; total work depends on the number
of ineligible rows scanned, and existing database timeouts still apply per query.
Posts arriving ahead of the cursor during a request are picked up on the next
request. The shared `@rss-bridge/link-policy` rejects `fbcdn.net` and
`cdninstagram.com` hosts and their subdomains as item destinations, including
already-persisted links. Images remain media, not post destinations. Other hosts
are not rejected merely for an image-shaped path; legitimate social permalinks
and external content links retain existing behavior.

Unresolved posts remain stored but are excluded until a usable destination is
available. This filter does not rewrite historical rows or reader history.

## Environment variables

- DATABASE_URL (required)
  - Postgres connection string.

- PORT (optional, default 3100)
  - HTTP listen port.

- FEED_BASE_URL (optional)
  - Public HTTP(S) origin with optional reverse-proxy path prefix, for example
    `https://feeds.example.com:8443/rss`. Generates stable channel IDs/links such
    as `https://feeds.example.com:8443/rss/feed/<groupId>`.
  - Trailing slashes are removed; group IDs are URL-encoded.
  - Standalone default: `http://localhost:${PORT}`. Compose default:
    `http://localhost:${FEED_PORT:-3100}`, independent of container port 80.
  - Set this explicitly for remote readers, a shared Docker network or a reverse
    proxy. No URL is derived from request headers.
  - Invalid URLs, non-HTTP(S) schemes, credentials, query strings and fragments
    log a warning and retain the existing fallback to `http://localhost:${PORT}`.
  - A proxy prefix affects generated URLs only: configure the proxy to strip it
    before forwarding to the service's `/feed/...` routes. `/feeds` discovery
    still returns service-relative routes, without that prefix.

- DB_CONNECT_TIMEOUT_MS (optional, default 5000)
  - Maximum pool acquisition/connection startup wait.

- DB_QUERY_TIMEOUT_MS (optional, default 10000)
  - Postgres statement deadline, including lock waits. A client read deadline one
    second later also bounds unresponsive connections and evicts them from the pool.
  - Limits are per query; a feed request can execute multiple queries sequentially.
  - In Compose `.env`, use `FEED_DB_QUERY_TIMEOUT_MS` for this value.

Timeouts must be positive integer milliseconds (maximum 2147482647); invalid
values fail startup. Idle pool errors and query failures are logged and surfaced
in database health; failed data requests still return errors rather than empty feeds.

## Local development

From packages/feed-generator:

1. Install dependencies
- npm install

2. Run in dev mode
- npm run dev

3. Build
- npm run build

4. Run compiled output
- npm run start

## Docker notes

In this repository, the service is typically started via docker-compose from repo root.

Common checks:

- http://localhost:3100/health
- http://localhost:3100/feeds
- http://localhost:3100/feed/<groupId>

## Implementation notes

- The channel link and id intentionally point to this service's feed URL, not an upstream source URL.
- Items without a safe, non-landing link are skipped from RSS output.
