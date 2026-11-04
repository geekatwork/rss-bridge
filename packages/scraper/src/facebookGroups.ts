export const FACEBOOK_GROUP_URL_PATTERN =
  "^https?://(www[.]|m[.]|mbasic[.])?facebook[.]com/groups/[^/?#\\s]+";

const facebookGroupUrl = new RegExp(FACEBOOK_GROUP_URL_PATTERN, "i");

export function isFacebookGroupUrl(url: string): boolean {
  return facebookGroupUrl.test(url);
}
