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

  // Stable product id for joining prices to products. Flipkart/Croma/Myntra all
  // repeat the same product under different query strings (?pid, ?lid, srno…), so
  // keying on the base URL misses prices. The id in the path is stable:
  //   flipkart …/p/itm1740e69…   croma …/p/323239   myntra …/12027432/buy
  const idOf = (url: string): string =>
    url.match(/\/p\/(itm[0-9a-z]+)/i)?.[1] ??
    url.match(/\/p\/(\d+)/)?.[1] ??
    url.match(/\/(\d{5,})\/buy/)?.[1] ??
    url.split("?")[0];

export function parseCandidates(markdown: string, platform: Platform): Candidate[] {
  // Price map: the site renders the price as its own link to the product,
  // e.g. [₹4,895](…/p/itm…). Key on the stable product id so variant query
  // strings don't break the join.
  const priceMap = new Map<string, string>();
  for (const m of markdown.matchAll(/\[\s*(₹\s?[\d,]+)\s*\]\((https?:\/\/[^)]+)\)/g)) {
    const id = idOf(m[2]);
    if (!priceMap.has(id)) priceMap.set(id, m[1].replace(/\s/g, ""));
  }

  // Image map: cards render as [![alt](IMAGE)](PRODUCT). Key image by product id
  // so each candidate carries its photo for visual (CLIP) matching.
  const imageMap = new Map<string, string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)\]\((https?:\/\/[^)]+)\)/g)) {
    const id = idOf(m[2]);
    if (!imageMap.has(id)) imageMap.set(id, m[1].split(" ")[0]);
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
    const block = markdown.slice(Math.max(0, u.idx - 1000), u.idx + 1000);
    const inStock = !OUT_OF_STOCK.test(block);
    // price: prefer the price-link map (by stable id); fall back to nearest ₹.
    const blockPrice = block.match(/₹\s?[\d,]{3,}/)?.[0].replace(/\s/g, "");
    const price = priceMap.get(idOf(u.url)) ?? blockPrice;

    seen.add(u.url);
    candidates.push({ title, url: u.url, inStock, price, imageUrl: imageMap.get(idOf(u.url)) });
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
