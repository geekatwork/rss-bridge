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

Facebook link extraction searches all candidates and embedded HTML for concrete
content links before assigning page/profile fallbacks. Native image clicks are
retained, but targets are reacquired by a unique captured text-and-media
fingerprint, never a saved virtualized child index. Targets are checked again
after scrolling and before each click; absent or ambiguous identities are logged
and use captured-link/image fallbacks instead of another post's DOM. CDN query
changes are ignored when matching images, but filename numbers are never
converted into guessed photo IDs. Clicked group permalinks are accepted, group
landing/login pages are rejected, and required destination query parameters are
preserved. Content trimming is unchanged.

Mandatory synthetic browser regressions live in `facebook/linkResolution.test.ts`;
optional local unresolved dumps remain ignored and must not contain committed
personal source content or credentials.

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

## Page Failure Handling

`SiteScraper.run()` records page failures with the failing step (`fetch`, `extract`,
`resolve`, `hasMorePages`, or `nextPage`). Extracted items and partial link-resolution
results are retained if `resolveLinks()` throws; the error remains in `ScrapeResult.errors`.

Ordinary errors stop the run. For a page-local fetch, extraction, or resolution
failure, a plugin may throw `RecoverablePageError` (exported from core) only when
its current state permits a reliable `hasMorePages()` check and `nextPage()` advance.
Do not mark authentication failures, lost browser sessions, or uncertain navigation
state as recoverable. The runner advances before processing another page; it never
retries the same page implicitly. Pagination-check/advance failures always stop.

The runner stops after three consecutive failed pages, resets that count after a
successful page, and continues to honor page/item stopping limits. Initialization
failures remain fatal, and shutdown is attempted once for every run.

Three consecutive successful empty pages also stop pagination, even if the
plugin reports more pages. A nonempty page or a failed page resets the empty
counter. This is an informational termination, not a scrape error: legitimate
empty incremental runs remain healthy, while any earlier errors remain recorded.
Plugins that expect valid content beyond three consecutive blank pages must
handle that source-specific gap inside their own listing implementation.

`context.config.maxPages` defaults to 10 when omitted and must be a positive safe
integer when supplied. Invalid values produce a logged scrape error before
initialization; cleanup is still attempted. The runner does not call
`hasMorePages()` or `nextPage()` after any stopping threshold. Page limits bound
repeated nonempty results too; they do not deduplicate items or interrupt a
hung plugin method (the scheduled group deadline handles cancellation).

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
