// ============================================================
// Jina AI Reader — a FREE, no-key way to fetch real pages.
// `https://r.jina.ai/<url>` returns clean markdown of any page,
// fetched from Jina's infra (so it isn't blocked like a direct
// datacenter request to Amazon/Flipkart would be).
//
// This is how we get REAL product data with zero API keys.
// (Rate-limited on the free tier — we cache + degrade gracefully.)
// ============================================================

const JINA = "https://r.jina.ai/";
const TIMEOUT_MS = 30_000;

// tiny in-memory cache so repeat lookups in a session don't refetch
const cache = new Map<string, string>();

export async function fetchReadable(url: string, engine: "direct" | "browser" = "direct"): Promise<string> {
  const cacheKey = `${engine}:${url}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const controller = new AbortController();
  // Browser render is slower — give it more room.
  const timer = setTimeout(() => controller.abort(), engine === "browser" ? 55_000 : TIMEOUT_MS);
  try {
    const res = await fetch(JINA + url, {
      signal: controller.signal,
      headers: {
        "X-Return-Format": "markdown",
        // "direct" = raw-HTML (fast, server-rendered pages). "browser" = full JS
        // render — needed for edge-protected grids (Croma) that block direct.
        "X-Engine": engine,
      },
    });
    if (!res.ok) throw new Error(`reader ${res.status}`);
    const text = await res.text();
    cache.set(cacheKey, text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a platform search URL for a query. */
export function searchUrl(platform: string, query: string): string {
  const q = encodeURIComponent(query);
  switch (platform) {
    case "flipkart":
      return `https://www.flipkart.com/search?q=${q}`;
    case "croma":
      return `https://www.croma.com/searchB?q=${q}%3Arelevance`;
    case "myntra":
      return `https://www.myntra.com/${encodeURIComponent(query.replace(/\s+/g, "-").toLowerCase())}`;
    default:
      return "";
  }
}
