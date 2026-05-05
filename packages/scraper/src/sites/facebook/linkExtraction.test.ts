import { describe, expect, it } from "vitest";
import {
  extractFacebookLinkFromCandidate,
  extractFacebookLinkFromHtmlBlob,
  extractFacebookPageFallbackFromCandidates,
} from "./linkExtraction.js";
import { extractFacebookAlbumLinkFromImageUrls, extractFacebookPostLinkFromCandidates, extractFirstImageUrl } from "./linkExtraction.js";

describe("Facebook real-world link extraction", () => {
  it("extracts canonical photo links from real photo.php urls", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/photo.php?fbid=1508944807910427&set=a.123456789",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/photo/?fbid=1508944807910427",
      postId: "1508944807910427",
    });
  });

  it("extracts canonical photo links from additional real fbid samples", () => {
    const first = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/photo.php?fbid=1418857496936537",
    );
    const second = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/photo/?fbid=1553950546735094&__tn__=%2CO*F",
    );

    expect(first).toEqual({
      link: "https://www.facebook.com/photo/?fbid=1418857496936537",
      postId: "1418857496936537",
    });
    expect(second).toEqual({
      link: "https://www.facebook.com/photo/?fbid=1553950546735094",
      postId: "1553950546735094",
    });
  });

  it("extracts permalink links from real group post urls", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/groups/669567236527981/permalink/3577830312368311/",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/groups/669567236527981/permalink/3577830312368311/",
      postId: "3577830312368311",
    });
  });

  it("extracts permalink links from groups posts urls", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/groups/669567236527981/posts/3577830312368311/",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/groups/669567236527981/permalink/3577830312368311/",
      postId: "3577830312368311",
    });
  });

  it("extracts story_fbid links from real story urls", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/story.php?story_fbid=3577835185701157&id=669567236527981",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/story.php?story_fbid=3577835185701157&id=669567236527981",
      postId: "3577835185701157",
    });
  });

  it("extracts additional story_fbid permalink-style links", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/story.php?story_fbid=2781310828870227&id=1818585508476102",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/story.php?story_fbid=2781310828870227&id=1818585508476102",
      postId: "2781310828870227",
    });
  });

  it("extracts canonical reel links", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://www.facebook.com/reel/2781310828870227?mibextid=rS40aB7S9Ucbxw6v",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/reel/2781310828870227",
      postId: "2781310828870227",
    });
  });

  it("extracts reel links from relative reel paths", () => {
    const actual = extractFacebookLinkFromCandidate("/reel/3577835185701157/?fs=e&s=TIeQ9V");

    expect(actual).toEqual({
      link: "https://www.facebook.com/reel/3577835185701157",
      postId: "3577835185701157",
    });
  });

  it("extracts reel links through facebook redirect wrappers", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.facebook.com%2Freel%2F3577835185701157%2F%3Fmibextid%3DrS40aB7S9Ucbxw6v",
    );

    expect(actual).toEqual({
      link: "https://www.facebook.com/reel/3577835185701157",
      postId: "3577835185701157",
    });
  });

  it("extracts instagram links through facebook redirect wrappers", () => {
    const actual = extractFacebookLinkFromCandidate(
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Freel%2FDX2Y4Feyclt%2F%3Figsh%3DMQ%253D%253D",
    );

    expect(actual).toEqual({
      link: "https://www.instagram.com/reel/DX2Y4Feyclt/",
      postId: "ig_DX2Y4Feyclt",
    });
  });

  it("extracts page links from real facebook page urls", () => {
    const actual = extractFacebookLinkFromCandidate("https://www.facebook.com/sleepyteepeetaranaki");

    expect(actual).toEqual({
      link: "https://www.facebook.com/sleepyteepeetaranaki",
      postId: null,
    });
  });

  it("extracts profile.php links as page/profile fallback", () => {
    const actual = extractFacebookLinkFromCandidate("https://www.facebook.com/profile.php?id=100088123456789");

    expect(actual).toEqual({
      link: "https://www.facebook.com/profile.php?id=100088123456789",
      postId: null,
    });
  });

  it("extracts photo links from html blob fbid fallback", () => {
    const html = '<div data-sigil="m-photo-action">something &amp;fbid=1418857496936537&amp;set=pcb.1</div>';
    const actual = extractFacebookLinkFromHtmlBlob(html);

    expect(actual).toEqual({
      link: "https://www.facebook.com/photo/?fbid=1418857496936537",
      postId: "1418857496936537",
    });
  });

  it("extracts page fallback from candidate set for sprinkles-style null media posts", () => {
    const candidates = [
      "/groups/669567236527981/",
      "/watch/?v=123",
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.facebook.com%2FAllCakedUpByLisa%2F",
    ];

    const actual = extractFacebookPageFallbackFromCandidates(candidates);
    expect(actual).toBe("https://www.facebook.com/AllCakedUpByLisa");
  });

  it("extracts sprinkles-style page fallback from profile.php candidate sets", () => {
    const candidates = [
      "/groups/669567236527981/",
      "https://www.facebook.com/profile.php?id=100088123456789",
      "/share/p/xyz",
    ];

    const actual = extractFacebookPageFallbackFromCandidates(candidates);
    expect(actual).toBe("https://www.facebook.com/profile.php?id=100088123456789");
  });

  it("prefers no fallback when only home-like and media-home redirects exist", () => {
    const candidates = [
      "/",
      "/groups/669567236527981/",
      "https://www.facebook.com/home.php",
      "https://www.facebook.com/watch/?v=12345",
    ];

    const actual = extractFacebookPageFallbackFromCandidates(candidates);
    expect(actual).toBeNull();
  });
});

describe("extractFacebookPostLinkFromCandidates", () => {
  it("returns photo link from a list of hrefs containing fbid", () => {
    const hrefs = [
      "/profile.php?id=100088123456789",
      "/photo/?fbid=1584469407021487&set=a.724514279683675",
      "/pages/SomePage/123456789",
    ];
    expect(extractFacebookPostLinkFromCandidates(hrefs)).toBe(
      "https://www.facebook.com/photo/?fbid=1584469407021487",
    );
  });

  it("returns permalink link when present among hrefs", () => {
    const hrefs = [
      "/profile.php?id=100088123456789",
      "/groups/669567236527981/permalink/3577830312368311/",
    ];
    expect(extractFacebookPostLinkFromCandidates(hrefs)).toBe(
      "https://www.facebook.com/groups/669567236527981/permalink/3577830312368311/",
    );
  });

  it("returns reel link from a relative reel href", () => {
    const hrefs = [
      "/SomePage",
      "/reel/2781310828870227/",
    ];
    expect(extractFacebookPostLinkFromCandidates(hrefs)).toBe(
      "https://www.facebook.com/reel/2781310828870227",
    );
  });

  it("returns null when only page/profile links are present", () => {
    const hrefs = [
      "/SomePage",
      "/profile.php?id=100088123456789",
    ];
    expect(extractFacebookPostLinkFromCandidates(hrefs)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(extractFacebookPostLinkFromCandidates([])).toBeNull();
  });

  it("prefers photo link over page link when photo appears first", () => {
    const hrefs = [
      "/photo/?fbid=9999999999999",
      "/SomePage",
    ];
    expect(extractFacebookPostLinkFromCandidates(hrefs)).toBe(
      "https://www.facebook.com/photo/?fbid=9999999999999",
    );
  });
});

describe("extractFacebookAlbumLinkFromImageUrls", () => {
  it("extracts canonical photo link from CDN filename pattern", () => {
    const urls = [
      "https://scontent.example.com/v/t39.30808-6/12345_122229060350121725_67890_n.jpg?...",
    ];
    expect(extractFacebookAlbumLinkFromImageUrls(urls)).toBe(
      "https://www.facebook.com/photo/?fbid=122229060344121725",
    );
  });

  it("skips thumbnail/avatar CDN URLs (t39.30808-1)", () => {
    const urls = [
      "https://scontent.example.com/v/t39.30808-1/12345_122229060344121725_67890_n.jpg",
    ];
    expect(extractFacebookAlbumLinkFromImageUrls(urls)).toBeNull();
  });

  it("extracts photo link from fbid query param when no filename match", () => {
    const urls = [
      "https://scontent.example.com/v/t39.30808-6/img.jpg?fbid=122229060518121725&otherparam=x",
    ];
    expect(extractFacebookAlbumLinkFromImageUrls(urls)).toBe(
      "https://www.facebook.com/photo/?fbid=122229060518121725",
    );
  });

  it("returns null for empty list", () => {
    expect(extractFacebookAlbumLinkFromImageUrls([])).toBeNull();
  });
});

describe("extractFirstImageUrl", () => {
  it("returns first usable content image when many are present", () => {
    const urls = [
      "https://scontent.example.com/v/t39.30808-1/avatar.jpg?stp=c0.5000x0.5000f_dst-webp_e15_p38x38_q70_tt1_u",
      "https://scontent.example.com/v/t39.30808-6/first.jpg?stp=c0.5394x0.4792f_dst-webp_e15_p205x205_q70_tt1_u",
      "https://scontent.example.com/v/t39.30808-6/second.jpg?stp=c0.5000x0.3300f_dst-webp_e15_p206x205_q70_tt1_u",
    ];

    expect(extractFirstImageUrl(urls)).toBe(urls[1]);
  });

  it("returns null when only avatars/tiny images exist", () => {
    const urls = [
      "https://scontent.example.com/v/t39.30808-1/a.jpg?stp=c0.5000x0.5000f_dst-webp_e15_p38x38_q70_tt1_u",
      "https://scontent.example.com/v/t39.30808-6/b.jpg?stp=c0.5000x0.5000f_dst-webp_e15_p40x40_q70_tt1_u",
    ];

    expect(extractFirstImageUrl(urls)).toBeNull();
  });
});
