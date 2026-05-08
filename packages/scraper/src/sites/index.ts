/**
 * Sites Index: Export all registered site scrapers.
 *
 * When adding a new site scraper:
 * 1. Import the scraper class
 * 2. Register it with globalRegistry in the default export function
 */

import { ExampleScraper } from "./ExampleScraper.js";
import { CompetitionsNzScraper } from "./competitions-nz/index.js";
import { FacebookScraper } from "./facebook/index.js";
import { RedditScraper } from "./reddit/index.js";
import { globalRegistry } from "../core/index.js";

/**
 * Register all available site scrapers.
 * Call this once at application startup.
 */
export function registerAllScrapers(): void {
  globalRegistry.register("competitions-nz", CompetitionsNzScraper);
  globalRegistry.register("facebook", FacebookScraper);
  globalRegistry.register("reddit", RedditScraper);
  globalRegistry.register("example-site", ExampleScraper);
  // Future sites:
  // globalRegistry.register("twitter", TwitterScraper);
}

export { ExampleScraper };
export { CompetitionsNzScraper } from "./competitions-nz/index.js";
export { FacebookScraper } from "./facebook/index.js";
export { RedditScraper } from "./reddit/index.js";
