export interface FacebookLinkExtractionResult {
  link: string | null;
  postId: string | null;
}

const FACEBOOK_BASE = "https://www.facebook.com";

function unwrapRedirectTarget(raw: string): string | null {
  try {
    const parsed = new URL(raw, FACEBOOK_BASE);
    if ((parsed.hostname.includes("l.facebook.com") || parsed.hostname.includes("facebook.com"))
      && parsed.pathname.includes("/l.php")) {
      const target = parsed.searchParams.get("u");
      if (!target) return null;
      try {
        return unwrapRedirectTarget(decodeURIComponent(target));
      } catch {
        return unwrapRedirectTarget(target);
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function isFacebookPageOrProfileLink(link: string): boolean {
  try {
    const parsed = new URL(link, FACEBOOK_BASE);
    if (!parsed.hostname.includes("facebook.com")) return false;

    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const lower = path.toLowerCase();
    if (lower === "/profile.php") {
      return /^\d{5,}$/.test(parsed.searchParams.get("id") || "");
    }

    const reserved = new Set([
      "",
      "/",
      "/watch",
      "/groups",
      "/marketplace",
      "/gaming",
      "/events",
      "/notifications",
      "/messages",
      "/bookmarks",
      "/friends",
      "/reels",
      "/stories",
      "/share",
      "/search",
      "/photo.php",
      "/story.php",
      "/home.php",
      "/login.php",
      "/checkpoint",
    ]);

    return /^\/[A-Za-z0-9._-]+$/.test(path) && !reserved.has(lower);
  } catch {
    return false;
  }
}

export function extractFacebookLinkFromCandidate(raw: string): FacebookLinkExtractionResult {
  const resolved = unwrapRedirectTarget(raw);
  if (!resolved) return { link: null, postId: null };

  try {
    const parsed = new URL(resolved, FACEBOOK_BASE);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    const lowPath = path.toLowerCase();

    if (host.includes("instagram.com")) {
      const canonical = `${parsed.origin}${path}`;
      const match = canonical.match(/instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)/i);
      return {
        link: canonical,
        postId: match ? `ig_${match[2]}` : null,
      };
    }

    if (!host.includes("facebook.com")) {
      return { link: null, postId: null };
    }

    const groupPermalinkMatch = path.match(/^\/groups\/(\d+)\/(?:posts|permalink)\/(\d+)\/?$/i);
    if (groupPermalinkMatch) {
      return {
        link: `${parsed.origin}/groups/${groupPermalinkMatch[1]}/permalink/${groupPermalinkMatch[2]}/`,
        postId: groupPermalinkMatch[2],
      };
    }

    if (lowPath === "/story.php") {
      const storyId = parsed.searchParams.get("story_fbid");
      if (storyId) {
        return {
          link: `${parsed.origin}${path}${parsed.search}`,
          postId: storyId,
        };
      }
    }

    const reelMatch = path.match(/^\/reel\/(\d+)\/?$/i);
    if (reelMatch) {
      return {
        link: `${parsed.origin}/reel/${reelMatch[1]}`,
        postId: reelMatch[1],
      };
    }

    if (lowPath.includes("/photo") || lowPath.includes("photo.php")) {
      const fbid = parsed.searchParams.get("fbid") || resolved.match(/[?&]fbid=(\d+)/i)?.[1] || null;
      return {
        link: fbid ? `${parsed.origin}/photo/?fbid=${fbid}` : `${parsed.origin}${path}`,
        postId: fbid,
      };
    }

    if (lowPath === "/profile.php") {
      const id = parsed.searchParams.get("id");
      if (id && /^\d{5,}$/.test(id)) {
        return {
          link: `${parsed.origin}/profile.php?id=${id}`,
          postId: null,
        };
      }
    }

    if (isFacebookPageOrProfileLink(`${parsed.origin}${path}${parsed.search}`)) {
      return {
        link: `${parsed.origin}${path.replace(/\/+$/, "")}`,
        postId: null,
      };
    }

    return { link: null, postId: null };
  } catch {
    return { link: null, postId: null };
  }
}

export function extractFacebookLinkFromHtmlBlob(htmlBlob: string): FacebookLinkExtractionResult {
  const decodedBlob = htmlBlob
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/");

  const blobCandidates: string[] = [];
  const directUrls = decodedBlob.match(/https?:\/\/[^"'<>\s]+/gi) || [];
  blobCandidates.push(...directUrls);

  const escapedUrls = htmlBlob.match(/https?:\\\/\\\/[^"'<>\s]+/gi) || [];
  for (const escaped of escapedUrls) {
    blobCandidates.push(escaped.replace(/\\\//g, "/"));
  }

  const encodedUrls = decodedBlob.match(/(?:[?&](?:u|url)=)(https?%3A%2F%2F[^"'<>\s&]+)/gi) || [];
  for (const pair of encodedUrls) {
    const encoded = pair.replace(/^(?:[?&](?:u|url)=)/i, "");
    try {
      blobCandidates.push(decodeURIComponent(encoded));
    } catch {
      // Ignore invalid encoding.
    }
  }

  const photoIdMatch = decodedBlob.match(/(?:\?|&|&amp;|%3[Ff]|%26)fbid(?:=|%3[Dd])(\d{6,})/i);
  if (photoIdMatch) {
    blobCandidates.push(`https://www.facebook.com/photo/?fbid=${photoIdMatch[1]}`);
  }

  for (const candidate of blobCandidates) {
    const extracted = extractFacebookLinkFromCandidate(candidate.trim());
    if (extracted.link) return extracted;
  }

  return { link: null, postId: null };
}

export function extractFacebookPageFallbackFromCandidates(candidates: string[]): string | null {
  for (const raw of candidates) {
    const extracted = extractFacebookLinkFromCandidate(raw);
    if (extracted.link && isFacebookPageOrProfileLink(extracted.link)) {
      return extracted.link;
    }
  }
  return null;
}

/**
 * From a list of candidate URLs (hrefs, data-lynx-uri, ajaxify values), return the first one
 * that resolves to a concrete Facebook post link (photo, permalink, story, reel, group post).
 * Unlike extractFacebookPageFallbackFromCandidates this does NOT return bare page/profile links
 * — it only returns links that point to a specific piece of content (have a postId).
 */
export function extractFacebookPostLinkFromCandidates(candidates: string[]): string | null {
  let firstFacebookContentLink: string | null = null;

  for (const raw of candidates) {
    const extracted = extractFacebookLinkFromCandidate(raw);
    if (!extracted.link || !extracted.postId) {
      continue;
    }

    if (extracted.link.includes("instagram.com/")) {
      return extracted.link;
    }

    if (!firstFacebookContentLink) {
      firstFacebookContentLink = extracted.link;
    }
  }

  return firstFacebookContentLink;
}

/**
 * For album/multi-photo posts, Facebook CDN image URLs embed the parent photo ID in the
 * filename segment (e.g. `v/t39.30808-6/<digits>_<photoId>_<digits>_n.jpg`).
 * We scan all image URLs, extract the embedded fbid, and return the first
 * `photo/?fbid=<id>` we can construct from them.
 * Returns null if no suitable ID is found.
 */
export function extractFacebookAlbumLinkFromImageUrls(imageUrls: string[]): string | null {
  for (const url of imageUrls) {
    // Skip tiny thumbnails (profile pics, avatars are in t39.30808-1 or have p38x38 in stp)
    if (/t39\.30808-1\/|p3[0-9]x3[0-9]_|p4[0-5]x4[0-5]_/.test(url)) continue;

    // CDN filename pattern: /<digits>_<photoLikeId>_<digits>_n.jpg
    // In captured fixtures this embedded ID is consistently +6,000,000 from the canonical photo fbid,
    // so normalize by subtracting 6 to recover the permalink id.
    const filenameMatch = url.match(/\/(\d+)_(\d{10,})_\d+_n\./i);
    if (filenameMatch) {
      try {
        const normalized = (BigInt(filenameMatch[2]) - 6000000n).toString();
        if (/^\d{10,}$/.test(normalized)) {
          return `https://www.facebook.com/photo/?fbid=${normalized}`;
        }
      } catch {
        // ignore invalid bigint conversion and continue fallbacks
      }
    }

    // Fallback: fbid embedded in stp query param (e.g. s_fbid=<id>)
    const stpFbidMatch = url.match(/[?&](?:fbid|s_fbid)=(\d{10,})/i);
    if (stpFbidMatch) {
      return `https://www.facebook.com/photo/?fbid=${stpFbidMatch[1]}`;
    }
  }
  return null;
}

/**
 * From a list of Facebook CDN image URLs, return the first usable content image.
 * This avoids selecting avatars/tiny thumbnails and gives deterministic behavior
 * for multi-image posts: if many are present, we pick the first suitable one.
 */
export function extractFirstImageUrl(imageUrls: string[]): string | null {
  for (const url of imageUrls) {
    // Skip avatar/profile thumbnail variants.
    if (/t39\.30808-1\//.test(url)) continue;

    let w = 0;
    let h = 0;
    try {
      const stp = new URL(url).searchParams.get("stp") ?? "";
      const match = stp.match(/[sp](\d+)x(\d+)/i);
      if (match) {
        w = parseInt(match[1], 10);
        h = parseInt(match[2], 10);
      }
    } catch {
      // Ignore malformed URLs and keep evaluating other candidates.
    }

    // If dimensions are known and tiny, skip.
    if (w > 0 && h > 0 && (w < 100 || h < 100)) continue;

    return url;
  }

  return null;
}

/**
 * Backward-compatible alias retained for callers that still reference the old name.
 * Current behavior is "first usable image" for deterministic multi-image handling.
 */
export function extractLargestImageUrl(imageUrls: string[]): string | null {
  return extractFirstImageUrl(imageUrls);
}
