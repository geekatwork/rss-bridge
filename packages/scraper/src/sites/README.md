# Site Scrapers

Each file in this directory implements a `SiteScraper` for a specific content source.

## Quick Start: Adding a New Site

1. **Copy the template**: Use `ExampleScraper.ts` as a starting point.
   ```bash
   cp ExampleScraper.ts YourSiteScraper.ts
   ```

2. **Implement the 7 required methods**:
   - `canHandle(source)` — Identify if your scraper should run
   - `init(context)` — Setup browser, cookies, login
   - `fetchListing(context)` — Navigate to the listing page
   - `extractItems(context)` — Parse items from DOM/API
   - `resolveLinks(context, items)` — Get external links if needed
   - `hasMorePages(context)` → `nextPage(context)` — Pagination
   - `shutdown(context)` — Cleanup

3. **Register your scraper** in `src/sites/index.ts`:
   ```typescript
   import { YourSiteScraper } from "./YourSiteScraper.js";
   
   globalRegistry.register("your-site", YourSiteScraper);
   ```

4. **Add configuration** in `.env` or your config file:
   ```json
   {
     "siteId": "your-site",
     "name": "Your Site Name",
     "enabled": true,
     "options": {
       "sourceUrl": "https://example.com/feed",
       "maxPages": 5
     }
   }
   ```

5. **Test**:
   ```bash
  export SCRAPE_GROUPS='[{"groupId":"demo-group","siteId":"your-site","name":"Your Site","url":"https://example.com"}]'
  npm run dev
   ```

## Architecture

- **SiteScraper** (core/SiteScraper.ts) — Abstract base class with the `run()` lifecycle
- **ScrapeRegistry** (core/ScrapeRegistry.ts) — Maps site IDs to scraper classes
- **ScraperContext** (core/types.ts) — Browser, logger, config, passed to all methods
- **NormalizedItem** (core/types.ts) — Unified output format for all sites
- Cookie path conventions and site-scoped layout: see `packages/scraper/ARCHITECTURE.md` under "Cookie file layout"

## Examples

### Facebook Scraper (`facebook/FacebookScraper.ts`)
- Loads cookies for authentication
- Sets mobile viewport to match Facebook's mobile detection
- Uses Puppeteer to navigate and scroll the feed
- Clicks images to resolve Instagram links
- Extracts timestamps, authors, text, images

### Reddit Scraper (`reddit/RedditScraper.ts`)
- Fetches subreddit feed
- Extracts posts, comments, scores
- Resolves URLs embedded in text

### Twitter Scraper — Future
- Uses Twitter search API or HTML scraping
- Extracts retweets, likes, timestamps
- Resolves quoted tweets

## Best Practices

1. **Respect robots.txt and terms of service** — Add rate limiting, delays
2. **Log everything** — Use context.logger for debugging
3. **Handle errors gracefully** — SiteScraper.run() catches them
4. **Normalize timestamps** — Use parseTimestamp() from core/utils
5. **Deduplicate** — Use computeContentHash() + store hashes in DB
6. **Test with fixture HTML** — Mock responses instead of live scraping during dev

## Config Template

```json
{
  "siteId": "my-site",
  "name": "My Site",
  "enabled": true,
  "options": {
    "sourceUrl": "https://example.com",
    "selectors": {
      "items": ".post",
      "title": ".post-title",
      "author": ".post-author",
      "timestamp": ".post-date"
    },
    "maxPages": 5
  },
  "rateLimit": {
    "requestsPerMinute": 30,
    "delayMs": 2000
  },
  "retry": {
    "maxAttempts": 3,
    "initialDelayMs": 1000,
    "backoffMultiplier": 2
  }
}
```
