// ============================================================
// The MATCHING ENGINE — entity resolution.
// "Do this candidate and the target refer to the SAME product?"
//
// Two-stage design:
//   Stage 1 (candidate generation) happens in the adapters — cheap
//     search by brand+model to get a handful of candidates.
//   Stage 2 (this file) — precise scoring of each candidate.
//
// Bias: PRECISION over recall. A wrong match on a shopping agent
// costs user trust, so when unsure we return no match (→ "not listed")
// rather than a confident-but-wrong answer.
// ============================================================

import type { Candidate, ProductIdentity } from "../types";
import { CATEGORY_RULES } from "../config";
import {
  normalizeAttribute,
  normalizeText,
  tokens,
  tokenContainment,
} from "./normalize";

export interface MatchScore {
  candidate: Candidate;
  confidence: number; // 0..1
  reason: string;
}

/**
 * Try to read a required attribute off a candidate: prefer the
 * structured value the adapter gave us; otherwise parse the title.
 */
function candidateAttr(key: string, c: Candidate): string | null {
  if (c.attributes?.[key]) return normalizeAttribute(key, c.attributes[key]);
  // fallback: parse from the title
  const title = c.title;
  if (key === "ram") {
    const m = title.match(/(\d+)\s*gb\s*ram/i);
    return m ? normalizeAttribute("ram", m[1] + "gb") : null;
  }
  if (key === "storage") {
    const m = title.match(/(\d+)\s*(gb|tb)\b/gi);
    // last GB/TB in the title is usually storage (RAM comes first)
    return m ? normalizeAttribute("storage", m[m.length - 1]) : null;
  }
  if (key === "screenSize") {
    const m = title.match(/(\d{2,3})\s*(?:inch|in|"|cm)/i);
    return m ? normalizeAttribute("screenSize", m[0]) : null;
  }
  if (key === "color") {
    const colors = ["black","white","blue","red","green","gray","grey","silver","gold","pink","yellow","purple","brown","beige"];
    const t = normalizeText(title);
    const hit = colors.find((col) => t.includes(col));
    return hit ? normalizeAttribute("color", hit) : null;
  }
  return null;
}

/** Score ONE candidate against the target identity. */
export function scoreCandidate(
  target: ProductIdentity,
  c: Candidate
): MatchScore {
  const candTitleTokens = tokens(c.title);

  // --- brand: must be present (hard requirement) ---
  const brandPresent = tokens(target.brand).size === 0
    ? true
    : [...tokens(target.brand)].every((bt) => candTitleTokens.has(bt));
  if (!brandPresent) {
    return { candidate: c, confidence: 0, reason: `brand "${target.brand}" not found` };
  }

  // --- model: is the model name CONTAINED in the candidate title? ---
  // (containment, not Jaccard — extra words in the title shouldn't dilute it)
  const modelScore = tokenContainment(tokens(target.model), candTitleTokens);
  if (modelScore < 0.6) {
    return { candidate: c, confidence: 0, reason: `model "${target.model}" doesn't match` };
  }

  // --- tier guard: "iPhone 15" must NOT match "iPhone 15 Pro Max" ---
  // A model-tier word present on one side but not the other = different model.
  const TIER = ["pro", "max", "plus", "ultra", "mini", "lite", "se", "neo", "prime", "air", "fe"];
  const targetMods = new Set(TIER.filter((w) => tokens(target.model).has(w)));
  const candMods = new Set(TIER.filter((w) => candTitleTokens.has(w)));
  const sameMods =
    targetMods.size === candMods.size && [...targetMods].every((w) => candMods.has(w));
  if (!sameMods) {
    return {
      candidate: c,
      confidence: 0,
      reason: `different model tier (${[...candMods].join(" ") || "base"} vs ${[...targetMods].join(" ") || "base"})`,
    };
  }

  // --- required attributes (the variant guard) ---
  const required = CATEGORY_RULES[target.category].requiredAttributes;
  let attrMatched = 0;
  let attrKnown = 0;
  for (const key of required) {
    const want = target.attributes[key]
      ? normalizeAttribute(key, target.attributes[key])
      : null;
    const got = candidateAttr(key, c);
    if (want && got) {
      attrKnown++;
      // Colour is lenient — shoes/apparel have multi-colourways ("Black/Red
      // Orbit Anthracite White"), so a shared primary colour counts as a match.
      const ok = key === "color" ? colorsOverlap(want, got) : want === got;
      if (ok) {
        attrMatched++;
      } else {
        // HARD FAIL: same model but different RAM/storage/size = a DIFFERENT
        // variant, not the same product. This is where naive matchers go wrong.
        return {
          candidate: c,
          confidence: 0,
          reason: `${key} differs (wanted ${want}, got ${got}) — different variant`,
        };
      }
    }
  }

  // --- confidence: weight model + attributes; brand already gated ---
  const attrScore = required.length === 0 ? 1 : (attrKnown === 0 ? 0.5 : attrMatched / attrKnown);
  const confidence = Number((0.25 + 0.4 * modelScore + 0.35 * attrScore).toFixed(2));

  const reason = attrKnown < required.length
    ? `brand+model match; ${required.length - attrKnown} attr(s) unverified`
    : `brand, model and all required attributes match`;

  return { candidate: c, confidence: Math.min(confidence, 1), reason };
}

const PRIMARY_COLORS = ["black","white","blue","red","green","gray","silver","gold","pink","yellow","purple","brown","beige","navy","teal","maroon","orange","cream"];
/** Do two colour strings share a primary colour? (lenient — for multi-colourways) */
function colorsOverlap(a: string, b: string): boolean {
  const ca = PRIMARY_COLORS.filter((c) => a.includes(c));
  const cb = PRIMARY_COLORS.filter((c) => b.includes(c));
  if (ca.length === 0 || cb.length === 0) return true; // unknown → don't reject
  return ca.some((c) => cb.includes(c));
}

/** Pick the best-scoring candidate (Stage 2 result). */
export function bestMatch(
  target: ProductIdentity,
  candidates: Candidate[]
): MatchScore | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((c) => scoreCandidate(target, c))
    .sort((a, b) => b.confidence - a.confidence);
  return scored[0];
}
