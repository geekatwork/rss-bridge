import { ScrapeEngine } from "./ScrapeEngine.js";

async function main(): Promise<void> {
  const engine = new ScrapeEngine();
  const siteId = "competitions-nz";

  try {
    await engine.init();
    engine.registerSite({
      siteId,
      name: "Competitions NZ",
      enabled: true,
      options: {
        sourceUrl: process.env.COMPETITIONS_NZ_SOURCE_URL || "https://www.competitions.co.nz/",
        maxPages: 1,
      },
    });

    const result = await engine.scrapeOne(siteId);
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.error(error);
      }
    }

    for (const item of result.items) {
      console.log(`${item.title ?? "(untitled)"} | ${item.link ?? ""}`);
    }

    if (result.items.length === 0) {
      console.log("No competitions extracted.");
    }

    if (result.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await engine.shutdown();
  }
}

void main();