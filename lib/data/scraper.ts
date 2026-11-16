// ============================================================
// ScraperAPI — for sites with enterprise bot protection that
// no-key scraping can't reach (Myntra, Croma). It renders JS and
// rotates residential proxies to return the real page.
//
// Only used for the protected platforms — Amazon & Flipkart stay
// on the free no-key Jina Reader, so we don't spend credits there.
// ============================================================

const API_KEY = process.env.SCRAPER_API_KEY;
// Must stay UNDER the route's maxDuration (60s) so a slow scrape aborts
// cleanly and degrades to "not listed" instead of the whole function being
// killed mid-request (which would surface as a 500/504).
const TIMEOUT_MS = 50_000;
const cache = new Map<string, string>();

export function isScraperEnabled(): boolean {
  return Boolean(API_KEY);
}

/** Fetch a URL through ScraperAPI (render=true = execute JS). Returns HTML. */
export async function fetchViaScraper(url: string, render = true): Promise<string> {
  if (!API_KEY) throw new Error("SCRAPER_API_KEY not set");
  const cacheKey = `${render}:${url}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const endpoint =
    `https://api.scraperapi.com/?api_key=${API_KEY}` +
    `&render=${render}&country_code=in&url=${encodeURIComponent(url)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) throw new Error(`scraperapi ${res.status}`);
    const html = await res.text();
    cache.set(cacheKey, html);
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/** ScraperAPI's structured Amazon product endpoint → clean { name, pricing, ... }. */
export async function fetchAmazonStructured(asin: string): Promise<Record<string, unknown> | null> {
  if (!API_KEY) return null;
  const endpoint =
    `https://api.scraperapi.com/structured/amazon/product` +
    `?api_key=${API_KEY}&asin=${asin}&country=in&tld=in`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a balanced JSON object that follows a marker like `window.__myx =`. */
export function extractJsonAfter(html: string, marker: string): unknown | null {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = html.indexOf("{", start);
  if (i === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(i, j + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}
