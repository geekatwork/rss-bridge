export interface NormalizedPost {
  sourcePostId: string;
  authorName: string | null;
  contentText: string | null;
  contentHtml: string | null;
  link: string | null;
  imageUrls: string[];
  postedAt: Date;
  postedAtIsSource?: boolean;
}

export interface GroupConfig {
  groupId: string;
  siteId?: string;
  name: string;
  url: string;
  schedule?: string;
  options?: SourceOptions;
}

export interface SourceOptions {
  cookieFile?: string;
  maxItems?: number;
  maxPages?: number;
  limit?: number;
  sort?: "hot" | "new" | "top";
  timeFilter?: "day" | "week" | "month" | "year" | "all";
  boundaryFallbackLimit?: number;
  maxCollectedPosts?: number;
  scrollAttempts?: number;
  boundaryMinimumMarkerIndex?: number;
  debugHrefs?: boolean;
  unresolvedDumpFile?: string;
}
