// ============================================================
// Croma adapter — fetch via ScraperAPI. Croma's product grid is
// loaded by a client-side API that resists rendering, so this is
// best-effort: parse any product tiles present in the HTML, else
// return [] (the registry falls back gracefully).
// ============================================================

import type { Candidate } from "../data/../types";
import { fetchViaScraper } from "../data/scraper";

export async function searchCroma(query: string): Promise<Candidate[]> {
  const url = `https://www.croma.com/search/?text=${encodeURIComponent(query)}`;
  const html = await fetchViaScraper(url, true);

  // product links: /<slug>/p/<digits>
  const linkRe = /href="(\/[a-z0-9-]+\/p\/\d+)"/gi;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    // title: Croma puts it in the slug (…/apple-iphone-15-128gb-black-/p/…)
    const title = path
      .split("/p/")[0]
      .replace(/^\//, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      title,
      url: `https://www.croma.com${path}`,
      inStock: true,
    });
    if (out.length >= 15) break;
  }
  return out;
}
