/**
 * OG link previews (oak's LinkPreviewService port). Pages and preview images are
 * fetched through the MAIN process (window.spaceNet) — the renderer's own fetch
 * is CORS-bound and most sites do not send the headers. The session cache is
 * keyed by URL and memoizes failures too: a dead link is not re-fetched on every
 * re-render of the row.
 */

export interface LinkPreview {
  title: string;
  description: string | null;
  imageUrl: string | null;
}

interface FetchResult {
  finalUrl: string;
  contentType: string;
  data: Uint8Array;
}

declare global {
  interface Window {
    spaceNet?: {
      fetchText(url: string): Promise<FetchResult | null>;
      fetchImage(url: string): Promise<FetchResult | null>;
    };
  }
}

const previewCache = new Map<string, Promise<LinkPreview | null>>();

export function linkPreviewFor(pageUrl: string): Promise<LinkPreview | null> {
  const cached = previewCache.get(pageUrl);
  if (cached !== undefined) {
    return cached; // in-flight dedup + positive + NEGATIVE caching (oak pattern)
  }
  const promise = fetchPreview(pageUrl);
  previewCache.set(pageUrl, promise);
  return promise;
}

async function fetchPreview(pageUrl: string): Promise<LinkPreview | null> {
  const bridge = typeof window !== "undefined" ? window.spaceNet : undefined;
  const page = await bridge?.fetchText(pageUrl);
  if (!page) {
    return null; // network failure / non-2xx / timeout — memoized null
  }
  const preview = parseOpenGraph(decodeUtf8(page.data), page.finalUrl);
  if (preview === null) {
    return null; // a page without a title gives no card (oak rule)
  }
  return preview;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Pure DOMParser-based OG parser: og:title/description/image in any attribute
 *  order, <title> fallback, relative og:image resolved against the final URL.
 *  DOMParser decodes HTML entities, so no manual unescape is needed. */
export function parseOpenGraph(html: string, baseUrl: string): LinkPreview | null {
  const document = new DOMParser().parseFromString(html, "text/html");
  const metaByProperty = new Map<string, string>();
  for (const meta of document.querySelectorAll("meta[property], meta[name]")) {
    const key = meta.getAttribute("property") ?? meta.getAttribute("name");
    const value = meta.getAttribute("content");
    if (key !== null && value !== null && key.startsWith("og:") && !metaByProperty.has(key)) {
      metaByProperty.set(key, value.trim());
    }
  }
  const title = metaByProperty.get("og:title")?.trim()
    ?? document.querySelector("title")?.textContent?.trim()
    ?? "";
  if (title.length === 0) {
    return null;
  }
  const description = metaByProperty.get("og:description")?.trim() || null;
  const rawImage = metaByProperty.get("og:image");
  let imageUrl: string | null = null;
  if (rawImage !== undefined && rawImage.length > 0) {
    try {
      imageUrl = new URL(rawImage, baseUrl).href; // relative og:image resolves against the page
    } catch {
      imageUrl = null; // a malformed image URL drops the thumbnail, not the card
    }
  }
  return { title, description, imageUrl };
}
