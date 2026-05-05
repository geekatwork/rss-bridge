import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

interface FacebookGroupSnapshotRow {
  rowNum: number;
  sourcePostId: string;
  groupSourceId: string;
  groupName: string;
  authorName: string | null;
  contentText: string | null;
  contentHtml: string | null;
  link: string | null;
  imageUrls: string[];
  postedAt: string;
  scrapedAt: string;
  notes: string | null;
}

function loadSnapshot(groupSourceId: string): FacebookGroupSnapshotRow[] {
  const candidatePaths = [
    resolve(process.cwd(), `src/sites/facebook/__fixtures__/snapshots/facebook-group-${groupSourceId}.json`),
    resolve(process.cwd(), `packages/scraper/src/sites/facebook/__fixtures__/snapshots/facebook-group-${groupSourceId}.json`),
  ];
  const fixturePath = candidatePaths.find((candidate) => existsSync(candidate));
  if (!fixturePath) return [];
  return JSON.parse(readFileSync(fixturePath, "utf8")) as FacebookGroupSnapshotRow[];
}

describe("Facebook group snapshots", () => {
  const groups = [
    { groupSourceId: "669567236527981", groupName: "Facebook Competitions NZ" },
    { groupSourceId: "1818585508476102", groupName: "Instagram Contests" },
  ];

  for (const group of groups) {
    it(`loads the first 50 items for ${group.groupName}`, () => {
      const rows = loadSnapshot(group.groupSourceId);
      expect(rows).toHaveLength(50);
      expect(rows[0]?.groupSourceId).toBe(group.groupSourceId);
      expect(rows[0]?.groupName).toBe(group.groupName);

      const ids = new Set<string>();
      for (const row of rows) {
        expect(typeof row.rowNum).toBe("number");
        expect(row.rowNum).toBeGreaterThanOrEqual(1);
        expect(typeof row.sourcePostId).toBe("string");
        expect(ids.has(row.sourcePostId)).toBe(false);
        ids.add(row.sourcePostId);
        expect(Array.isArray(row.imageUrls)).toBe(true);
        expect(typeof row.postedAt).toBe("string");
        expect(typeof row.scrapedAt).toBe("string");
      }
    });
  }
});