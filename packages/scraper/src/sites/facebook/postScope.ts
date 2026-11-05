// Self-contained because Puppeteer serializes this function into the browser.
export function selectFacebookPosts(): { posts: HTMLElement[]; ambiguous: number } {
  const main = document.getElementById("screen-root")?.children[0];
  if (!main) return { posts: [], ambiguous: 0 };
  const posts: HTMLElement[] = [];
  let ambiguous = 0;
  const storySelector = "article, [role='article']";
  for (const container of Array.from(main.children)) {
    if (container.matches("nav, header, footer, [role='navigation']")) continue;
    if (!container.matches("[role='feed']")
      && !container.querySelector(`${storySelector}, [aria-label*='story from']`)
      && (container.textContent || "").trim().length <= 200) continue;
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const stories = child.matches(storySelector)
        ? [child]
        : Array.from(child.querySelectorAll<HTMLElement>(storySelector))
          .filter((story) => !story.parentElement?.closest(storySelector));
      for (const story of stories.length ? stories : [child]) {
        // A nested story or multiple author headers has no reliable single-post boundary.
        if (story.querySelector(storySelector)
          || story.querySelectorAll("[aria-label*='story from']").length > 1) {
          ambiguous++;
          continue;
        }
        posts.push(story);
      }
    }
  }
  return { posts, ambiguous };
}
