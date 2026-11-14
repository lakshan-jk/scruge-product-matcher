// ============================================================
// PLATFORM ADAPTERS — Stage 1 (candidate generation).
// Each platform implements the same interface; the registry routes
// each to its best data source:
//   • Flipkart → Jina Reader   (server-rendered, free, no key)
//   • Myntra   → ScraperAPI     (bot-protected → clean __myx JSON)
//   • Croma    → ScraperAPI     (best-effort; falls back if blocked)
// Every adapter degrades gracefully to the mock dataset on failure.
// ============================================================

import type { Candidate, Platform, ProductIdentity } from "../types";
import { mockSearch } from "../data/mock";
import { fetchReadable, searchUrl } from "../data/jina";
import { parseCandidates } from "../data/parse";
import { isScraperEnabled } from "../data/scraper";
import { searchMyntra } from "./myntra";
import { searchCroma } from "./croma";

export interface PlatformAdapter {
  platform: Platform;
  search(identity: ProductIdentity): Promise<Candidate[]>;
}

function queryFor(identity: ProductIdentity): string {
  // Prefer the LLM-cleaned search query; fall back to brand + model.
  return (identity.searchQuery || `${identity.brand} ${identity.model}`)
    .replace(/\s+/g, " ")
    .trim();
}

/** wrap any search in a mock fallback so we never silently show empty/crash. */
async function withFallback(
  identity: ProductIdentity,
  platform: Platform,
  fn: () => Promise<Candidate[]>
): Promise<Candidate[]> {
  try {
    const got = await fn();
    return got.length > 0 ? got : mockSearch(identity, platform);
  } catch {
    return mockSearch(identity, platform);
  }
}

export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  // Flipkart — free no-key Jina Reader (server-rendered).
  flipkart: {
    platform: "flipkart",
    search: (identity) =>
      withFallback(identity, "flipkart", async () => {
        const md = await fetchReadable(searchUrl("flipkart", queryFor(identity)));
        return parseCandidates(md, "flipkart");
      }),
  },

  // Myntra — ScraperAPI (bot-protected). Falls back if no key.
  myntra: {
    platform: "myntra",
    search: (identity) =>
      withFallback(identity, "myntra", async () => {
        if (!isScraperEnabled()) return mockSearch(identity, "myntra");
        return searchMyntra(queryFor(identity));
      }),
  },

  // Croma — ScraperAPI best-effort (client-side grid; may be empty → fallback).
  croma: {
    platform: "croma",
    search: (identity) =>
      withFallback(identity, "croma", async () => {
        if (!isScraperEnabled()) return mockSearch(identity, "croma");
        return searchCroma(queryFor(identity));
      }),
  },
};
