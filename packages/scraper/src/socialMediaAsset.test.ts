import { describe, expect, it } from "vitest";
import { isSocialMediaAssetUrl } from "@rss-bridge/link-policy";

describe("shared social media asset policy", () => {
  it.each([
    "https://fbcdn.net/image.jpg",
    "https://scontent.synthetic.fbcdn.net/v/t39.30808-6/image.jpg?token=one",
    "https://scontent.synthetic.fbcdn.net/v/t39.30808-6/image.jpg?token=two",
    "https://scontent.synthetic.fbcdn.net/v/t45.1600-4/image.jpg",
    "https://SCONTENT.SYNTHETIC.FBCDN.NET./asset",
    "https://cdninstagram.com/image.jpg",
    "https://scontent.synthetic.cdninstagram.com/image.jpg?token=one",
    "https://video.synthetic.fbcdn.net/video.mp4",
  ])("rejects a social CDN asset: %s", (url) => {
    expect(isSocialMediaAssetUrl(url)).toBe(true);
  });

  it.each([
    "https://fbcdn.net.example.test/image.jpg",
    "https://notfbcdn.net/image.jpg",
    "https://cdninstagram.com.example.test/image.jpg",
    "https://notcdninstagram.com/image.jpg",
    "https://example.test/image.jpg?redirect=fbcdn.net",
    "https://www.facebook.com/groups/123/posts/456/",
    "https://www.facebook.com/photo.php?fbid=123456789",
    "https://www.instagram.com/p/Synthetic/",
    "https://www.instagram.com/reel/Synthetic/",
    "not a URL",
  ])("does not classify a non-CDN URL as media: %s", (url) => {
    expect(isSocialMediaAssetUrl(url)).toBe(false);
  });
});
