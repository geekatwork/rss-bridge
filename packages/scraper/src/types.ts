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
}
