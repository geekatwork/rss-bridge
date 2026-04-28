import axios from "axios";
import type { NormalizedPost } from "../../types.js";

const GRAPH_API_BASE = process.env.SOURCE_GRAPH_API_BASE || "https://graph.facebook.com/v19.0";

interface GraphApiPost {
  id: string;
  message?: string;
  from?: { name: string };
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  attachments?: {
    data: Array<{
      subattachments?: {
        data: Array<{ media?: { image?: { src: string } } }>;
      };
      media?: { image?: { src: string } };
    }>;
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function fetchPostsViaApi(
  groupId: string,
  accessToken: string,
  limit = 25
): Promise<NormalizedPost[]> {
  const url = `${GRAPH_API_BASE}/${groupId}/feed`;
  const response = await axios.get<{ data: GraphApiPost[] }>(url, {
    params: {
      access_token: accessToken,
      fields: "id,message,from,created_time,permalink_url,full_picture,attachments",
      limit,
    },
  });

  return response.data.data.map((post): NormalizedPost => {
    const imageUrls: string[] = [];
    if (post.full_picture) {
      imageUrls.push(post.full_picture);
    }
    if (post.attachments?.data) {
      for (const att of post.attachments.data) {
        if (att.subattachments?.data) {
          for (const sub of att.subattachments.data) {
            if (sub.media?.image?.src) imageUrls.push(sub.media.image.src);
          }
        }
      }
    }

    const contentText = post.message || "";
    const contentHtml = `<p>${escapeHtml(contentText)}</p>`;

    return {
      sourcePostId: post.id,
      authorName: post.from?.name || null,
      contentText,
      contentHtml,
      link: post.permalink_url || null,
      imageUrls: [...new Set(imageUrls)],
      postedAt: new Date(post.created_time),
    };
  });
}

// Backward-compatible alias
export const fetchGroupPostsViaApi = fetchPostsViaApi;
