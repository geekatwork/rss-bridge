export function isLandingOrGroupUrl(link: string, groupUrl: string): boolean {
  try {
    const parsed = new URL(link);
    const groupParsed = new URL(groupUrl);

    const samePlatform = parsed.hostname === groupParsed.hostname;
    if (!samePlatform) return false;

    const path = parsed.pathname.toLowerCase();
    const isHomeLike =
      path === "/" || path === "/home.php" || path === "/login.php" || path === "/checkpoint" || path === "/checkpoint/";

    const normalizePath = (value: string): string => value.replace(/\/+$/, "");
    const parsedPath = normalizePath(parsed.pathname);
    const groupPath = normalizePath(groupParsed.pathname);
    const isGroupLike = parsed.origin === groupParsed.origin && parsedPath.startsWith(groupPath);

    return isHomeLike || isGroupLike;
  } catch {
    return false;
  }
}

export function buildFeedUrl(baseUrl: string, sourceId: string): string {
  const encodedSourceId = encodeURIComponent(sourceId);
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${basePath}/feed/${encodedSourceId}`;
}
