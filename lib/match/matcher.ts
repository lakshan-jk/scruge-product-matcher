// ============================================================
// The MATCHING ENGINE — entity resolution.
// "Do this candidate and the target refer to the SAME product?"
//
// Two-stage design:
//   Stage 1 (candidate generation) happens in the adapters — cheap
//     search by brand+model to get a handful of candidates.
//   Stage 2 (this file) — precise scoring of each candidate.
//
// HYBRID matching:
//   • Rule-based lexical scoring = fast, precise (brand/model/variant).
//   • Embedding semantic rescue   = widens RECALL when the same product
//       is worded differently across stores. Gated on EMBED_BASE_URL;
//       the deterministic variant guards STILL run, so recall grows
//       without losing precision.
//
// Bias: PRECISION over recall. A wrong match on a shopping agent
// costs user trust, so when unsure we return no match (→ "not listed")
// rather than a confident-but-wrong answer.
// ============================================================

import type { Candidate, Category, ProductIdentity } from "../types";
import { CATEGORY_RULES, MATCH_THRESHOLD } from "../config";
import {
  normalizeAttribute,
  normalizeText,
  tokens,
  tokenContainment,
} from "./normalize";
import { isEmbedEnabled, embedTexts, cosine } from "./embed";

// Primary colour vocabulary — shared by candidate parsing and overlap scoring.
const PRIMARY_COLORS = ["black","white","blue","red","green","gray","silver","gold","pink","yellow","purple","brown","beige","navy","teal","maroon","orange","cream","burgundy","cognac","tan","khaki","olive","charcoal","ivory","sand","wine","rust","mustard","coral","rose"];

export interface MatchScore {
  candidate: Candidate;
  confidence: number; // 0..1
  reason: string;
  // true only when ALL required variant attrs (colour/size/RAM) were verified.
  // false → model matched but the exact variant (e.g. colour) is unconfirmed.
  variantConfirmed?: boolean;
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
    const t = normalizeText(title);
    const hit = PRIMARY_COLORS.find((col) => t.includes(col));
    return hit ? normalizeAttribute("color", hit) : null;
  }
  return null;
}

// Accessory/decoy terms. A "Samsung Galaxy M36 Black Back Cover" contains the
// brand, model AND colour, so it sails through brand/model/variant checks — but
// it's a ₹200 case, not the phone. Reject these outright.
const ACCESSORY =
  /\b(case|cover|flip\s?cover|back\s?cover|back\s?panel|tempered\s?glass|screen\s?guard|screen\s?protector|protector|pouch|spareware|skin|sticker|decal|charger|cable|adapter|earphone|headphone|lace|laces|insole|wall\s?mount|bracket)\b/i;

/** Parse "₹69,999" → 69999, "₹466.65" → 467 (or null). Handles decimals + commas. */
function priceNum(p?: string): number | null {
  if (!p) return null;
  const m = p.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Is this candidate an obvious decoy (accessory, or priced far below the real
 * product)? Returns a reason string if so. Used by BOTH the lexical and the
 * semantic paths so neither can match a case/cover/spare part.
 */
function decoyReason(target: ProductIdentity, c: Candidate): string | null {
  if (ACCESSORY.test(c.title)) return "looks like an accessory (case/cover/etc.), not the product";
  const sp = priceNum(target.price);
  const cp = priceNum(c.price);
  if (sp && cp && cp < 0.3 * sp) {
    return `price ${c.price} is far below the Amazon price ${target.price} — likely an accessory or different item`;
  }
  return null;
}

/**
 * The distinctive model identifier(s) must be present. Alphanumeric codes like
 * "m36", "a55", "2m2", "15" carry the model's identity; generic words (galaxy,
 * 5g, series) do not. Without this, "Galaxy A36" matches "Galaxy M36" because
 * galaxy+5g alone clear the containment threshold.
 */
function modelIdentityOk(
  target: ProductIdentity,
  candTitleTokens: Set<string>,
  candTitle: string
): boolean {
  // (a) alphanumeric codes (m36, a55, 2m2) must be present as whole tokens.
  const codes = [...tokens(target.model)].filter((t) => /\d/.test(t));
  if (!codes.every((t) => candTitleTokens.has(t))) return false;
  // (b) version numbers (3.0, 8, 23) must all appear — catches "Breaknet 2.0"
  //     matching "Breaknet 3.0", where the digits tokenize away as single chars.
  const nums = (s: string) =>
    new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(parseFloat(x))));
  const want = nums(target.model);
  const have = nums(candTitle);
  for (const n of want) if (!have.has(n)) return false;
  return true;
}

/** Brand must be present in the candidate title (hard requirement). */
function brandOk(target: ProductIdentity, candTitleTokens: Set<string>): boolean {
  if (tokens(target.brand).size === 0) return true;
  return [...tokens(target.brand)].every((bt) => candTitleTokens.has(bt));
}

/**
 * Deterministic variant guard: same model but different RAM/storage/size/colour
 * is a DIFFERENT product, not a match. This is where naive matchers go wrong,
 * and it runs for BOTH the lexical and the semantic paths so embeddings can
 * never blur two variants into one.
 */
function variantCheck(
  target: ProductIdentity,
  c: Candidate
): { ok: boolean; matched: number; known: number; reason?: string } {
  const required = CATEGORY_RULES[target.category].requiredAttributes;
  let matched = 0;
  let known = 0;
  for (const key of required) {
    const want = target.attributes[key]
      ? normalizeAttribute(key, target.attributes[key])
      : null;
    const got = candidateAttr(key, c);
    if (want && got) {
      known++;
      // Colour is lenient — multi-colourways + marketing names ("Midnight Black",
      // "Awesome Iceblue") collapse to a shared primary colour.
      const ok = key === "color" ? colorsOverlap(want, got) : want === got;
      if (ok) {
        matched++;
      } else {
        return {
          ok: false,
          matched,
          known,
          reason: `${key} differs (wanted ${want}, got ${got}) — different variant`,
        };
      }
    }
  }
  return { ok: true, matched, known };
}

/** Score ONE candidate against the target identity (rule-based lexical path). */
export function scoreCandidate(
  target: ProductIdentity,
  c: Candidate
): MatchScore {
  const candTitleTokens = tokens(c.title);

  // --- decoy guard: accessories / far-cheaper items are not the product ---
  const decoy = decoyReason(target, c);
  if (decoy) {
    return { candidate: c, confidence: 0, reason: decoy };
  }

  // --- brand: must be present (hard requirement) ---
  if (!brandOk(target, candTitleTokens)) {
    return { candidate: c, confidence: 0, reason: `brand "${target.brand}" not found` };
  }

  // --- model: is the model name CONTAINED in the candidate title? ---
  // (containment, not Jaccard — extra words in the title shouldn't dilute it)
  const modelScore = tokenContainment(tokens(target.model), candTitleTokens);
  if (modelScore < 0.6) {
    return { candidate: c, confidence: 0, reason: `model "${target.model}" doesn't match` };
  }
  // The model code itself (m36 vs a36, 3.0 vs 2.0) must match — not just galaxy+5g.
  if (!modelIdentityOk(target, candTitleTokens, c.title)) {
    return { candidate: c, confidence: 0, reason: `different model identifier (not "${target.model}")` };
  }

  // --- tier guard: "iPhone 15" must NOT match "iPhone 15 Pro Max" ---
  // Tier words are CATEGORY-SPECIFIC. "Ultra"/"Pro" distinguish phone models,
  // but on a TV "4K Ultra HD" is a spec, not a model tier — applying the phone
  // rule globally wrongly rejected correct Sony/LG TVs. TVs and apparel are
  // distinguished by their required attributes (screen size, colour) + model
  // code instead, so they use an empty tier set.
  const TIER_WORDS: Record<Category, string[]> = {
    smartphone: ["pro", "max", "plus", "ultra", "mini", "lite", "se", "neo", "prime", "air", "fe"],
    television: [],
    sneaker: [],
    tshirt: [],
  };
  const TIER = TIER_WORDS[target.category];
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
  const v = variantCheck(target, c);
  if (!v.ok) {
    return { candidate: c, confidence: 0, reason: v.reason! };
  }

  // --- confidence: weight model + attributes; brand already gated ---
  const required = CATEGORY_RULES[target.category].requiredAttributes;
  const attrScore = required.length === 0 ? 1 : (v.known === 0 ? 0.5 : v.matched / v.known);
  const confidence = Number((0.25 + 0.4 * modelScore + 0.35 * attrScore).toFixed(2));

  const variantConfirmed = required.length === 0 || v.known === required.length;
  const reason = variantConfirmed
    ? `brand, model and all required attributes match`
    : `brand+model match; ${required.length - v.known} attr(s) unverified`;

  return { candidate: c, confidence: Math.min(confidence, 1), reason, variantConfirmed };
}

/** Do two colour strings share a primary colour? (lenient — for multi-colourways) */
function colorsOverlap(a: string, b: string): boolean {
  const ca = PRIMARY_COLORS.filter((c) => a.includes(c));
  const cb = PRIMARY_COLORS.filter((c) => b.includes(c));
  if (ca.length === 0 || cb.length === 0) return true; // unknown → don't reject
  return ca.some((c) => cb.includes(c));
}

// Minimum cosine to accept a semantic (embedding) match before variant checks.
const EMBED_THRESHOLD = 0.82;

/**
 * Semantic rescue: when the lexical path found no confident match (usually the
 * model is worded differently across stores), use embeddings to find the closest
 * candidate — then STILL enforce brand + variant guards so precision holds.
 */
async function semanticRescue(
  target: ProductIdentity,
  candidates: Candidate[]
): Promise<MatchScore | null> {
  const targetText = `${target.brand} ${target.model}`;
  const vecs = await embedTexts([targetText, ...candidates.map((c) => c.title)]);
  if (!vecs) return null;
  const [tv, ...cvs] = vecs;

  let best: Candidate | null = null;
  let bestSim = 0;
  candidates.forEach((c, i) => {
    const sim = cosine(tv, cvs[i]);
    if (sim > bestSim) {
      bestSim = sim;
      best = c;
    }
  });
  if (!best || bestSim < EMBED_THRESHOLD) return null;

  // Precision guards still apply — embeddings widen recall, they don't relax
  // brand identity, decoy rejection, or variant (colour/RAM/size) correctness.
  const chosen: Candidate = best;
  if (decoyReason(target, chosen)) return null;
  const chosenTokens = tokens(chosen.title);
  if (!brandOk(target, chosenTokens)) return null;
  if (!modelIdentityOk(target, chosenTokens, chosen.title)) return null; // M36≈A36 / 2.0≈3.0 by cosine
  const v = variantCheck(target, chosen);
  if (!v.ok) return null;

  const requiredLen = CATEGORY_RULES[target.category].requiredAttributes.length;
  const variantConfirmed = requiredLen === 0 || v.known === requiredLen;
  const confidence = Number(Math.min(0.6 + 0.4 * bestSim, 0.95).toFixed(2));
  return {
    candidate: chosen,
    confidence,
    reason: variantConfirmed
      ? `semantic match (cosine ${bestSim.toFixed(2)}); brand + variants verified`
      : `semantic match (cosine ${bestSim.toFixed(2)}); variant (e.g. colour) unconfirmed`,
    variantConfirmed,
  };
}

/** Pick the best-scoring candidate (Stage 2 result), with semantic recall rescue. */
export async function bestMatch(
  target: ProductIdentity,
  candidates: Candidate[]
): Promise<MatchScore | null> {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((c) => scoreCandidate(target, c))
    .sort((a, b) => b.confidence - a.confidence);
  const top = scored[0];

  // Lexical path already confident → done (fast, no embedding call).
  if (top.confidence >= MATCH_THRESHOLD) return top;

  // Lexical missed → try semantic rescue (if embeddings are configured).
  if (isEmbedEnabled()) {
    const rescued = await semanticRescue(target, candidates);
    if (rescued && rescued.confidence > top.confidence) return rescued;
  }
  return top;
}
