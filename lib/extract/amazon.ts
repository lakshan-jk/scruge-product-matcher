// ============================================================
// EXTRACT — Amazon URL → canonical identity { brand, model,
// category, attributes }.
//
// Real path (no key!): fetch the page via Jina Reader, then parse
// the title + specs heuristically. Falls back to the mock dataset
// if the fetch fails (rate limit / network) — graceful degradation.
// ============================================================

import type { Category, ProductIdentity } from "../types";
import { mockExtract } from "../data/mock";
import { fetchReadable } from "../data/jina";
import { parseProductPage } from "../data/parse";
import { llmExtract } from "./llm-extract";
import { fetchViaScraper, isScraperEnabled, fetchAmazonStructured } from "../data/scraper";

const BRANDS = [
  "apple","samsung","oneplus","xiaomi","redmi","realme","vivo","oppo","motorola","nothing","google","iqoo","poco",
  "nike","adidas","puma","reebok","asics","campus","sparx","bata","woodland","skechers","converse","new balance","fila","crocs",
  "sony","lg","tcl","hisense","mi","oneplus","acer","toshiba",
  "levis","us polo","allen solly","roadster","h&m","puma","nike","adidas","jack & jones","peter england",
];

// Pure footwear/apparel brands — they NEVER make phones or TVs. Used to stop a
// brand-less shoe title (e.g. "Nike Court Vision Alta") defaulting to smartphone.
const SPORT_BRANDS = ["nike","adidas","puma","reebok","asics","campus","sparx","bata","woodland","skechers","converse","new balance","fila","crocs"];

const COLORS = ["black","white","blue","red","green","gray","grey","silver","gold","pink","yellow","purple","brown","beige","navy","teal","maroon","orange","cream","burgundy","cognac","tan","khaki","olive","charcoal","ivory","sand","wine","rust","mustard","coral","rose"];

function detectCategory(title: string, body: string, brand = ""): Category {
  // Prefer the TITLE — the page body has junk (related products, ads)
  // that falsely triggers categories (e.g. "UHD" on a phone page).
  const t = title.toLowerCase();
  const b = brand.toLowerCase();
  if (/\b(t-?shirt|tee|polo|jersey)\b/.test(t)) return "tshirt";
  if (/\b(shoe|sneaker|running|trainer|loafer|high-?top|low-?top)\b/.test(t)) return "sneaker";
  if (/\b(tv|television|smart tv|led tv|uhd|qled|oled|nanocell|bravia)\b/.test(t)) return "television";
  if (/\b(iphone|galaxy|smartphone|pixel|redmi|oneplus|poco|iqoo|narzo|5g|phone)\b/.test(t)) return "smartphone";

  // No category word in the title, but the BRAND resolves it: a sportswear brand
  // makes shoes/apparel, never a phone — so never let it fall through to the
  // smartphone default (which routed shoes to Croma instead of Myntra).
  if (SPORT_BRANDS.some((x) => b === x || t.includes(x))) {
    return /\b(shirt|tee|polo|jersey|track|short|hoodie)\b/.test(t) ? "tshirt" : "sneaker";
  }

  // weak fallback on the body only if the title was ambiguous
  const bb = body.toLowerCase();
  if (/\b(t-?shirt|polo|jersey)\b/.test(bb)) return "tshirt";
  if (/\b(running shoe|sneaker|footwear)\b/.test(bb)) return "sneaker";
  if (/\b(television|smart tv|led tv)\b/.test(bb)) return "television";
  return "smartphone";
}

function detectBrand(title: string): string {
  const t = title.toLowerCase();
  const hit = BRANDS.find((b) => t.includes(b));
  if (hit) return hit.charAt(0).toUpperCase() + hit.slice(1);
  return title.trim().split(/\s+/)[0] ?? "";
}

/** Strip Amazon marketplace boilerplate from a title for clean display. */
function sanitizeTitle(t: string): string {
  return t
    .replace(/\s*[:|-]\s*amazon\.in.*$/i, "")   // " : Amazon.in: Sports, Fitness & Outdoors"
    .replace(/\s*\|\s*amazon.*$/i, "")           // " | Amazon …"
    .replace(/^buy\s+/i, "")                      // "Buy …" SEO prefix
    .replace(/\s+online\s+at\s+.*/i, "")         // "… online at low prices in India"
    .replace(/\s+/g, " ")
    .trim();
}

function detectModel(title: string, brand: string): string {
  // take the part before the first "(", drop the brand word
  let m = title.split("(")[0];
  m = m.replace(new RegExp(brand, "i"), "").trim();
  // drop trailing noise
  return m.replace(/\s+/g, " ").trim() || title;
}

function detectAttributes(category: Category, text: string): Record<string, string> {
  const t = text.toLowerCase();
  const attrs: Record<string, string> = {};
  if (category === "smartphone") {
    const ram = t.match(/(\d+)\s*gb\s*ram/) ?? t.match(/(\d+)\s*gb\b(?=.*ram)/);
    const rom = t.match(/(\d+)\s*(gb|tb)\s*(rom|storage|internal|ssd)/) ?? t.match(/(\d+)\s*(gb|tb)\b/);
    if (ram) attrs.ram = `${ram[1]}GB`;
    if (rom) attrs.storage = `${rom[1]}${rom[2].toUpperCase()}`;
    const col = COLORS.find((c) => t.includes(c)); // colour is part of a phone's identity too
    if (col) attrs.color = col;
  } else if (category === "television") {
    const inch = t.match(/(\d{2,3})\s*(?:inch|")/);
    if (inch) attrs.screenSize = `${inch[1]} inch`;
  } else {
    const col = COLORS.find((c) => t.includes(c));
    if (col) attrs.color = col;
  }
  return attrs;
}

const ERROR_PAGE = /(page not found|sorry|robot check|captcha|not a robot|enter the characters|something went wrong|access denied|service unavailable|\b503\b|temporarily unavailable|too many requests|\b429\b)/i;

/** Pull the product title out of raw Amazon HTML (ScraperAPI fallback). */
function amazonTitleFromHtml(html: string): string {
  const span = html.match(/id="productTitle"[^>]*>([^<]+)</i);
  if (span) return span[1].trim();
  const og = html.match(/property="og:title"\s+content="([^"]+)"/i);
  if (og) return og[1].trim();
  const t = html.match(/<title>([^<]+)<\/title>/i);
  return t ? t[1].replace(/\s*[:|-].*$/, "").trim() : "";
}

/** Fetch Amazon product data: ScraperAPI STRUCTURED endpoint (clean name + price +
 *  stock as JSON) → raw HTML → Jina. First that returns a good title wins. */
async function fetchAmazon(url: string): Promise<{ title: string; body: string; price?: string }> {
  const asin = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];

  // 1. Structured endpoint — cleanest: name, pricing, specs, availability.
  if (asin && isScraperEnabled()) {
    const p = await fetchAmazonStructured(asin);
    const name = typeof p?.name === "string" ? p.name : "";
    if (name && !ERROR_PAGE.test(name)) {
      const bullets = Array.isArray(p?.feature_bullets) ? p!.feature_bullets.join(" ") : "";
      const info = p?.product_information ? JSON.stringify(p.product_information) : "";
      const price = typeof p?.pricing === "string" ? p.pricing.replace(/\s/g, "") : undefined;
      return { title: name, body: `${name}\n${bullets}\n${info}`, price };
    }
  }

  // 2. Raw HTML via ScraperAPI (title from productTitle span).
  if (isScraperEnabled()) {
    try {
      const html = await fetchViaScraper(url, false);
      const title = amazonTitleFromHtml(html);
      if (title && !ERROR_PAGE.test(title)) return { title, body: html.slice(0, 120000) };
    } catch {
      /* fall through */
    }
  }

  // 3. Jina (free) fallback.
  try {
    const md = await fetchReadable(url);
    const pp = parseProductPage(md);
    if (pp.title && !ERROR_PAGE.test(pp.title)) return pp;
  } catch {
    /* fall through */
  }
  throw new Error(
    "Couldn't read that Amazon product right now (the source may be rate-limited). Please try again in a moment."
  );
}

/** Drop any attribute whose value isn't actually present in the title (anti-hallucination). */
function verifyAttributesInTitle(attrs: Record<string, string>, title: string): Record<string, string> {
  const t = title.toLowerCase();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const v = String(value).toLowerCase();
    if (key === "ram" || key === "storage" || key === "screenSize") {
      const num = v.match(/\d+/)?.[0];
      if (num && t.includes(num)) out[key] = value; // the number must be in the title
    } else if (key === "color") {
      const col = v.split(/[\s/]+/)[0];
      if (col && t.includes(col)) out[key] = value;
    } else if (t.includes(v)) {
      out[key] = value;
    }
  }
  return out;
}

/** Amazon price. HTML → the real price element (a-offscreen / a-price-whole);
 *  markdown (Jina) → most-frequent ₹ (the product price repeats most there). */
function extractAmazonPrice(text: string): string | undefined {
  // HTML path: the first a-offscreen in the buy box is the current price.
  const off = text.match(/class="a-offscreen">\s*(₹[\d,]+)/);
  if (off) return off[1].replace(/\s/g, "");
  const whole = text.match(/class="a-price-whole">\s*([\d,]+)/);
  if (whole) return "₹" + whole[1].replace(/\s/g, "");
  // markdown path: most frequent ₹ amount (ignores one-off promo amounts)
  const prices = [...text.matchAll(/₹\s?[\d,]{3,}/g)].map((m) => m[0].replace(/\s/g, ""));
  if (prices.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const p of prices) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export async function extractFromAmazon(url: string): Promise<ProductIdentity> {
  // Jina first (free); ScraperAPI fallback if Jina is blocked/503'd. Throws a
  // clear message if both fail — better than matching a garbage error page.
  const { title, body, price: srcPrice } = await fetchAmazon(url);

  // Prefer the LLM for clean extraction (handles messy SEO titles);
  // fall back to heuristics if no LLM is configured or it fails.
  const llm = await llmExtract(title, body);

  const brand = llm ? llm.brand : detectBrand(title);
  let category = llm ? llm.category : detectCategory(title, body, brand);
  // Guard: footwear/apparel brands don't make phones or TVs. If the LLM mislabels
  // a Nike/adidas/Skechers product as a phone (→ wrong store searched), trust the
  // keyword heuristic instead. Fixes the "searched Croma for a shoe" errors.
  if (llm && (category === "smartphone" || category === "television")) {
    const heuristic = detectCategory(title, body, brand);
    if (heuristic === "sneaker" || heuristic === "tshirt") category = heuristic;
  }
  const model = llm ? llm.model : detectModel(title, brand);
  // Attributes from the TITLE only — the page body has noise (e.g. "iCloud 50 GB")
  // that produces WRONG attributes → false variant-mismatches. Empty is safe.
  // Keep only attributes that actually appear in the title. A small LLM can
  // hallucinate (e.g. guess storage "256GB" when the title has no storage),
  // and a WRONG attribute causes false variant-mismatches. Unverified = empty = safe.
  const attributes = verifyAttributesInTitle(
    llm ? llm.attributes : detectAttributes(category, title),
    title
  );
  // Query = brand + model (model is LLM-cleaned). We DON'T append the variant
  // attr — it skews search ranking toward other tiers (Plus/Pro); the matcher's
  // variant guard enforces the exact storage/colour afterwards.
  const searchQuery = `${brand} ${model}`;

  // Amazon's own price. Pages list many ₹ amounts (accessories, EMI, offers),
  // but the actual product price repeats the most → pick the MOST FREQUENT.
  const price = srcPrice ?? extractAmazonPrice(body);

  return { brand, model, category, attributes, title: sanitizeTitle(title), sourceUrl: url, price, searchQuery };
}
