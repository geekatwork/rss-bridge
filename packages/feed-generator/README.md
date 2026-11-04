# Feed Generator

The feed-generator service exposes RSS feeds from normalized data stored in Postgres.

## What it does

- Serves health and discovery endpoints for available feeds.
- Generates RSS 2.0 XML for a specific source group.
- Filters out low-quality links that look like platform landing pages or root group pages.

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
  - Uses the request host/protocol to set channel link/id to the feed URL itself.

## Architecture

The service has two layers:

1. HTTP layer (src/index.ts)
- Handles Express routes.
- Builds RSS output with the feed package.
- Applies link safety filtering before adding items.

2. Data access layer (src/db.ts)
- Queries groups and posts from Postgres.
- Uses source-generic schema fields:
  - groups.source_id
  - posts.source_post_id

Request flow:

1. Client requests /feed/:groupId.
2. Service loads group by source_id.
3. Service fetches latest posts for the group's internal id.
4. Service filters invalid/landing links.
5. Service emits RSS XML.

## Environment variables

- DATABASE_URL (required)
  - Postgres connection string.

- PORT (optional, default 3100)
  - HTTP listen port.

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
