// ============================================================
// THE PIPELINE — orchestrates the whole flow, like an agent:
//   plan   → extract the product identity from the Amazon link
//   act    → search each platform (adapters) for candidates
//   observe→ score candidates (matcher)
//   decide → in_stock / out_of_stock / not_listed + confidence
//
// Platforms are searched in PARALLEL (independent), and each is
// wrapped so one platform failing never breaks the others
// (graceful degradation).
// ============================================================

import type { Candidate, MatchResponse, Platform, PlatformResult, ProductIdentity } from "./types";
import { CATEGORY_RULES, MATCH_THRESHOLD } from "./config";
import { ADAPTERS } from "./adapters";
import { bestMatch, otherColorInStock, brandMatches, distinctiveCodes } from "./match/matcher";
import { fetchReadable } from "./data/jina";
import { fetchViaScraper } from "./data/scraper";

/** Fetch a candidate's product-page text (Flipkart via Jina, others via ScraperAPI). */
async function fetchPageText(platform: Platform, url: string): Promise<string> {
  try {
    return platform === "flipkart" ? await fetchReadable(url) : await fetchViaScraper(url, false);
  } catch {
    return "";
  }
}

/**
 * Detail-page enrichment: the distinctive code (NU87, 025, 2M2) is often on the
 * candidate's product PAGE even when the search-result title omits it. For the
 * top brand-matching candidates, fetch the page and confirm every code is there.
 * Bounded to 2 fetches so it stays within the function budget.
 */
async function enrichFromDetailPages(
  identity: ProductIdentity,
  platform: Platform,
  candidates: Candidate[]
): Promise<PlatformResult | null> {
  const codes = distinctiveCodes(identity);
  if (codes.length === 0) return null;
  const pool = candidates.filter((c) => brandMatches(identity, c)).slice(0, 2);
  for (const c of pool) {
    const text = (await fetchPageText(platform, c.url)).toLowerCase();
    if (text && codes.every((code) => text.includes(code))) {
      return {
        platform,
        status: c.inStock ? "in_stock" : "out_of_stock",
        url: c.url,
        matchedTitle: c.title,
        price: c.price,
        confidence: 0.8,
        reason: `matched via product-page details (found ${codes.join(", ")})`,
        variantConfirmed: false,
      };
    }
  }
  return null;
}
import { isLLMEnabled, llmJudge } from "./match/llm";

/** Run one platform end-to-end: search → match → decide. */
async function resolvePlatform(
  identity: ProductIdentity,
  platform: Platform
): Promise<PlatformResult> {
  try {
    // Stage 1: candidate generation
    const candidates = await ADAPTERS[platform].search(identity);

    if (candidates.length === 0) {
      return { platform, status: "not_listed", reason: "no candidates found" };
    }

    // Stage 2a: rule-based scoring ranks the candidates (cheap filter),
    // with semantic (embedding) rescue when the lexical path misses.
    const match = await bestMatch(identity, candidates);
    if (!match || match.confidence < MATCH_THRESHOLD) {
      // Before giving up, check candidate product pages for the distinctive code.
      const enriched = await enrichFromDetailPages(identity, platform, candidates);
      if (enriched) return enriched;
      const color = identity.attributes.color;
      const reason =
        color && otherColorInStock(identity, candidates)
          ? `The ${color} variant isn't listed — other colours are in stock.`
          : match
            ? `best match too weak (${match.confidence}) — ${match.reason}`
            : "no match";
      return { platform, status: "not_listed", reason };
    }

    // Stage 2b: optional LLM verification of the top candidate.
    // Gated behind LLM_JUDGE because a small local model (llama3.2) is a great
    // EXTRACTOR but an unreliable JUDGE — it would reject correct matches. With
    // a stronger model you'd turn this on for the ambiguous cases.
    let confidence = match.confidence;
    let reason = match.reason;
    if (process.env.LLM_JUDGE === "true" && isLLMEnabled()) {
      const verdict = await llmJudge(identity, match.candidate);
      if (verdict) {
        if (!verdict.isMatch) {
          return { platform, status: "not_listed", reason: `LLM: ${verdict.reason}` };
        }
        confidence = verdict.confidence;
        reason = `LLM-confirmed: ${verdict.reason}`;
      }
    }

    // Confident match → report stock from the matched listing.
    // Colour-aware out-of-stock message: if the requested colour's listing is
    // sold out, say so — and whether other colours are still available.
    const color = identity.attributes.color;
    let finalReason = reason;
    if (!match.candidate.inStock && color) {
      finalReason = `The ${color} variant is out of stock${
        otherColorInStock(identity, candidates) ? " — other colours are in stock" : ""
      }.`;
    }
    return {
      platform,
      status: match.candidate.inStock ? "in_stock" : "out_of_stock",
      url: match.candidate.url,
      matchedTitle: match.candidate.title,
      price: match.candidate.price,
      confidence,
      reason: finalReason,
      variantConfirmed: match.variantConfirmed,
    };
  } catch (err) {
    // Graceful degradation: a platform failing shouldn't sink the request.
    return {
      platform,
      status: "not_listed",
      reason: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The full flow: Amazon identity → results across its category's platforms. */
export async function matchAcrossPlatforms(
  identity: ProductIdentity
): Promise<MatchResponse> {
  const platforms = CATEGORY_RULES[identity.category].platforms;

  // parallel — platforms are independent
  const results = await Promise.all(
    platforms.map((p) => resolvePlatform(identity, p))
  );

  return { source: identity, results };
}
