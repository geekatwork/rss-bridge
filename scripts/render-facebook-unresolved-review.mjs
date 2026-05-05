import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const repoRoot = resolve(import.meta.dirname, "..");
const fixturePath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(repoRoot, "packages/scraper/src/sites/facebook/__fixtures__/facebook-unresolved.json");
const outputPath = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : resolve(repoRoot, "packages/scraper/src/sites/facebook/__fixtures__/facebook-unresolved-review.md");

/** @typedef {{
 * sourcePostId: string;
 * groupSourceId: string;
 * groupName: string;
 * authorName: string | null;
 * contentText: string | null;
 * contentHtml: string | null;
 * link: string | null;
 * imageUrls: string[];
 * postedAt: string;
 * scrapedAt?: string;
 * candidateUrls: string[];
 * expectedLink: string | null;
 * notes: string | null;
 * }} UnresolvedFacebookFixture */

/** @param {string | null | undefined} value */
function cleanText(value) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/** @param {string | null | undefined} value */
function escapeMarkdown(value) {
  return cleanText(value)
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]<>])/g, "\\$1");
}

/** @param {string | null | undefined} value */
function toQuotedLine(value) {
  const text = escapeMarkdown(value) || "No text captured.";
  return `> ${text}`;
}

/** @param {UnresolvedFacebookFixture} fixture */
function isReviewableFixture(fixture) {
  const content = cleanText(fixture.contentText);
  if (!content) return false;
  if (content === "Most relevantSORT") return false;
  if (content === "VideosAnnouncementsEvents") return false;
  if (content.startsWith("Write something")) return false;
  if (content.includes("Public group") && content.includes("Invite")) return false;
  return true;
}

/** @param {UnresolvedFacebookFixture[]} fixtures */
function render(fixtures) {
  const unresolved = fixtures.filter((fixture) => !fixture.expectedLink && isReviewableFixture(fixture));
  const groups = new Map();
  for (const fixture of unresolved) {
    const key = `${fixture.groupName} (${fixture.groupSourceId})`;
    const items = groups.get(key) ?? [];
    items.push(fixture);
    groups.set(key, items);
  }

  const lines = [
    "# Facebook Null Link Review",
    "",
    "Fill in the correct URL by replying with `sourcePostId -> expected URL`, or edit the JSON fixture directly if you prefer.",
    "",
    `Total unresolved items: ${unresolved.length}`,
    "",
    "## How To Use",
    "",
    "1. Read each post summary below.",
    "2. Open any image or candidate URL links that help identify the source post.",
    "3. Reply with the `sourcePostId` and the URL it should resolve to.",
    "4. Optional: include notes if the post should intentionally stay null.",
    "",
  ];

  for (const [groupLabel, items] of groups) {
    lines.push(`## ${groupLabel}`);
    lines.push("");

    for (const [index, fixture] of items.entries()) {
      lines.push(`### ${index + 1}. ${fixture.sourcePostId}`);
      lines.push("");
      lines.push(`- Posted: ${fixture.postedAt}`);
      lines.push(`- Scraped: ${fixture.scrapedAt ?? "unknown"}`);
      lines.push(`- Author: ${escapeMarkdown(fixture.authorName) || "Unknown"}`);
      lines.push(`- Current link: ${fixture.link ?? "null"}`);
      lines.push(`- Expected link: ${fixture.expectedLink ?? ""}`);
      lines.push(`- Notes: ${escapeMarkdown(fixture.notes) || ""}`);
      lines.push(`- Image count: ${fixture.imageUrls.length}`);
      lines.push(`- Candidate count: ${fixture.candidateUrls.length}`);
      lines.push("");
      lines.push("Content:");
      lines.push(toQuotedLine(fixture.contentText));
      lines.push("");

      if (fixture.imageUrls.length > 0) {
        lines.push("Image URLs:");
        for (const imageUrl of fixture.imageUrls.slice(0, 3)) {
          lines.push(`- ${imageUrl}`);
        }
        if (fixture.imageUrls.length > 3) {
          lines.push(`- ... ${fixture.imageUrls.length - 3} more`);
        }
        lines.push("");
      }

      if (fixture.candidateUrls.length > 0) {
        lines.push("Candidate URLs:");
        for (const candidateUrl of fixture.candidateUrls.slice(0, 5)) {
          lines.push(`- ${candidateUrl}`);
        }
        if (fixture.candidateUrls.length > 5) {
          lines.push(`- ... ${fixture.candidateUrls.length - 5} more`);
        }
        lines.push("");
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/** @type {UnresolvedFacebookFixture[]} */
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
writeFileSync(outputPath, render(fixtures), "utf8");

console.log(`Wrote Facebook unresolved review to ${outputPath}`);