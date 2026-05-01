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

## Feed Endpoints

- `GET /health` -> service health payload.
- `GET /feeds` -> discover available feed routes.
- `GET /feed/:groupId` -> RSS XML for one group.

Notes:

- Feed channel `link`/`id` intentionally points to the feed URL itself.
- Items with landing/root-like links are filtered out.

## Package Docs

- Scraper architecture and extension guide:
  - `packages/scraper/ARCHITECTURE.md`
  - `packages/scraper/src/sites/README.md`
- Feed generator architecture and operations:
  - `packages/feed-generator/README.md`

## Redeploying to Docker

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
