// ============================================================
// Parse Jina's markdown search results into structured Candidates.
//
// The pages nest an image link inside each product link, so a naive
// [text](url) regex grabs the wrong thing. Instead we:
//   1. collect every product-page URL (by platform marker)
//   2. collect every image-alt title ("Image N: <title>")
//   3. pair each product URL with the nearest preceding alt title
//   4. read a stock signal from the text block around it
// ============================================================

import type { Candidate, Platform } from "../types";

// full product-page URLs per platform
const PRODUCT_URL: Record<Platform, RegExp> = {
  flipkart: /https:\/\/www\.flipkart\.com\/[^\s)]+\/p\/itm[^\s)]+/gi,
  croma: /https:\/\/www\.croma\.com\/[^\s)]+\/p\/\d+[^\s)]*/gi,
  myntra: /https:\/\/www\.myntra\.com\/[^\s)]*\/\d{5,}\/buy[^\s)]*/gi,
};

const OUT_OF_STOCK = /(currently unavailable|sold out|out of stock|coming soon|notify me)/i;

export function parseCandidates(markdown: string, platform: Platform): Candidate[] {
  // Price map: the site renders the price as its own link to the SAME product URL,
  // e.g. [₹4,895](…/p/itm…). Map product URL → price so we never miss it.
  const priceMap = new Map<string, string>();
  for (const m of markdown.matchAll(/\[\s*(₹\s?[\d,]+)\s*\]\((https?:\/\/[^)]+)\)/g)) {
    const url = m[2].split("?")[0];
    if (!priceMap.has(url)) priceMap.set(url, m[1].replace(/\s/g, ""));
  }

  // all product URLs with their position
  const urls = [...markdown.matchAll(PRODUCT_URL[platform])].map((m) => ({
    url: m[0].split("?")[0],
    idx: m.index ?? 0,
  }));

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (seen.has(u.url)) continue;

    // Title from the URL SLUG — reliably contains brand + model (+ colour/storage):
    //   .../apple-iphone-15-black-128-gb/p/itm...  → "apple iphone 15 black 128 gb"
    const slug = u.url.split(/\/p\//)[0].split("/").pop() ?? "";
    const title = slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    if (title.length < 4) continue;

    // stock: scan a window around this product; price: from the price map
    const block = markdown.slice(Math.max(0, u.idx - 600), u.idx + 600);
    const inStock = !OUT_OF_STOCK.test(block);
    const price = priceMap.get(u.url);

    seen.add(u.url);
    candidates.push({ title, url: u.url, inStock, price });
    if (candidates.length >= 40) break;
  }

  return candidates;
}

/** Extract {title, body} from a Jina markdown PRODUCT page (Amazon). */
export function parseProductPage(markdown: string): { title: string; body: string } {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  return { title, body: markdown.slice(0, 10000) };
}
