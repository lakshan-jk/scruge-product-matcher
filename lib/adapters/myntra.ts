// ============================================================
// Myntra adapter — fetch via ScraperAPI (bot-protected site), then
// read the product list from the `window.__myx` JSON embedded in the
// page. Clean structured data (brand, name, price, url) — far more
// reliable than scraping rendered HTML.
// ============================================================

import type { Candidate } from "../types";
import { fetchViaScraper, extractJsonAfter } from "../data/scraper";

/** recursively find the first non-empty `products` array in the JSON. */
function findProducts(o: unknown): any[] | null {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findProducts(v);
      if (r) return r;
    }
  } else if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.products) && rec.products.length) return rec.products as any[];
    for (const v of Object.values(rec)) {
      const r = findProducts(v);
      if (r) return r;
    }
  }
  return null;
}

export async function searchMyntra(query: string): Promise<Candidate[]> {
  const slug = query.trim().replace(/\s+/g, "-").toLowerCase();
  const url = `https://www.myntra.com/${encodeURIComponent(slug)}`;
  // render=false: the product list is in the raw HTML's window.__myx JSON,
  // so we skip JS rendering → ~5s instead of ~30-60s.
  const html = await fetchViaScraper(url, false);

  const data = extractJsonAfter(html, "window.__myx");
  const products = data ? findProducts(data) : null;
  if (!products) return [];

  return products.slice(0, 40).map((p): Candidate => ({
    title: `${p.brand ?? ""} ${p.productName ?? p.product ?? ""}`.trim(),
    url: p.landingPageUrl ? `https://www.myntra.com/${p.landingPageUrl}` : "https://www.myntra.com",
    inStock: true, // listed in search results = available on Myntra
    price: p.price != null ? `₹${Number(p.price).toLocaleString("en-IN")}` : undefined,
    attributes: p.product ? { color: extractColor(p.product) } : undefined,
    imageUrl: typeof p.searchImage === "string" ? p.searchImage : undefined, // for visual match
  }));
}

const COLORS = ["black","white","blue","red","green","grey","gray","silver","gold","pink","yellow","purple","brown","beige","navy","teal","maroon","orange","cream"];
function extractColor(s: string): string {
  const t = s.toLowerCase();
  return COLORS.find((c) => t.includes(c)) ?? "";
}
