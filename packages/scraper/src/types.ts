export interface NormalizedPost {
  sourcePostId: string;
  authorName: string | null;
  contentText: string | null;
  contentHtml: string | null;
  link: string | null;
  imageUrls: string[];
  postedAt: Date;
}

export interface GroupConfig {
  groupId: string;
  siteId?: string;
  name: string;
  url: string;
}
