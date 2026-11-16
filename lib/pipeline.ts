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

import type { MatchResponse, Platform, PlatformResult, ProductIdentity } from "./types";
import { CATEGORY_RULES, MATCH_THRESHOLD } from "./config";
import { ADAPTERS } from "./adapters";
import { bestMatch } from "./match/matcher";
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
      return {
        platform,
        status: "not_listed",
        reason: match ? `best match too weak (${match.confidence}) — ${match.reason}` : "no match",
      };
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
    return {
      platform,
      status: match.candidate.inStock ? "in_stock" : "out_of_stock",
      url: match.candidate.url,
      matchedTitle: match.candidate.title,
      price: match.candidate.price,
      confidence,
      reason,
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
