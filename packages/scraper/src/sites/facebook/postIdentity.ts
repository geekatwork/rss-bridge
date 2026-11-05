export interface FacebookPostIdentity {
  text: string;
  mediaUrls: string[];
}

// Self-contained because Puppeteer serializes this function into the browser.
export function findFacebookPost(identity: FacebookPostIdentity): HTMLElement | null {
  const main = document.getElementById("screen-root")?.children[0];
  if (!main) return null;
  const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
  const imageKey = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  };
  const expectedText = normalizeText(identity.text);
  if (!expectedText) return null;
  const expectedImages = new Set(identity.mediaUrls.map(imageKey));
  const matches: HTMLElement[] = [];
  for (const container of Array.from(main.children)) {
    for (const post of Array.from(container.children)) {
      if (!(post instanceof HTMLElement)) continue;
      if (normalizeText(post.textContent || "") !== expectedText) continue;
      const images = new Set(Array.from(post.querySelectorAll("img"))
        .map((img) => imageKey(img.getAttribute("src") || "")));
      if (Array.from(expectedImages).every((key) => images.has(key))) {
        matches.push(post);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
