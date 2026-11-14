// ============================================================
// Croma adapter — Croma's product grid comes from an edge-protected
// search API (api.croma.com). Direct calls are blocked (Akamai), and
// the search page HTML is a product-less shell — so we call the real
// API THROUGH ScraperAPI (residential proxy) with the browser headers
// it expects (origin/referer). Returns clean product JSON.
// ============================================================

import type { Candidate } from "../types";

const KEY = process.env.SCRAPER_API_KEY;
const TIMEOUT_MS = 40_000;

export async function searchCroma(query: string): Promise<Candidate[]> {
  if (!KEY) return [];

  const target =
    `https://api.croma.com/searchservices/v1/search` +
    `?currentPage=0&query=${encodeURIComponent(query + ":relevance")}` +
    `&fields=FULL&channel=WEB&channelCode=560078&spellOpt=DEFAULT`;

  const scraperUrl =
    `https://api.scraperapi.com/?api_key=${KEY}&keep_headers=true` +
    `&url=${encodeURIComponent(target)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(scraperUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        origin: "https://www.croma.com",
        referer: "https://www.croma.com/",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { products?: any[] };
    const products = data.products ?? [];

    return products.slice(0, 40).map((p): Candidate => ({
      title: p.name ?? "",
      url: p.url ? `https://www.croma.com${p.url}` : "https://www.croma.com",
      // a product in the search results is listed; stockFlag=false → out of stock
      inStock: p.stockFlag !== false && p.plmStatus !== "SOLDOUT",
      price: p.price?.formattedValue ? String(p.price.formattedValue).replace(/\s/g, "") : undefined,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
