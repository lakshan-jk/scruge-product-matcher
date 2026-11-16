// ============================================================
// LLM JUDGE — the precise, "expensive" verifier (optional layer).
//
// Pattern: rule-based scoring is the CHEAP filter that ranks
// candidates (matcher.ts). The LLM is the PRECISE verifier that
// confirms the single best candidate — great at messy titles where
// rules are brittle ("Apple iPhone 15 (2023)" vs "iPhone 15 5G").
//
// Graceful fallback: if no LLM is configured, this returns null and
// the pipeline trusts the rule-based score. So it works with OR
// without a key.
//
// OpenAI-compatible: set LLM_API_KEY (+ optional LLM_BASE_URL for
// Ollama/others, LLM_MODEL). Works with OpenAI, Ollama, etc.
// ============================================================

import type { Candidate, ProductIdentity } from "../types";
import { CATEGORY_RULES } from "../config";

const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const API_KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

export function isLLMEnabled(): boolean {
  return Boolean(API_KEY);
}

export interface LLMVerdict {
  isMatch: boolean;
  confidence: number; // 0..1
  reason: string;
}

function buildPrompt(target: ProductIdentity, c: Candidate): string {
  const attrs = CATEGORY_RULES[target.category].requiredAttributes;
  return [
    `You are matching products across shopping sites. Decide if the CANDIDATE is the SAME product as the TARGET.`,
    `Rules: brand and model must match. These attributes must ALSO match exactly: ${attrs.join(", ")}.`,
    `A different variant (different ${attrs.join("/")}) is NOT the same product.`,
    ``,
    `TARGET: ${target.title}`,
    `  brand=${target.brand} model=${target.model} category=${target.category} ${JSON.stringify(target.attributes)}`,
    `CANDIDATE: ${c.title}`,
    `  ${c.attributes ? JSON.stringify(c.attributes) : "(no structured attributes)"}`,
    ``,
    `Respond ONLY with JSON: {"isMatch": boolean, "confidence": number 0..1, "reason": "short"}`,
  ].join("\n");
}

/**
 * AI judge — pick the ONE candidate that is truly the same product, using the
 * model's world knowledge. Resolves aliases/abbreviations ("Man Utd" =
 * "Manchester United") and rejects decoys (a jersey ≠ a plain tee), which rules
 * and embeddings can't. One call per platform; provider-agnostic (Groq / OpenAI
 * / HuggingFace router / Ollama via LLM_BASE_URL). Returns null if unavailable.
 */
export async function llmPickMatch(
  target: ProductIdentity,
  candidates: Candidate[]
): Promise<{ index: number; reason: string } | null> {
  if (!isLLMEnabled() || candidates.length === 0) return null;
  const list = candidates.slice(0, 15).map((c, i) => `${i}: ${c.title}`).join("\n");
  const prompt = [
    `You match products across shopping sites. From the CANDIDATES, pick the ONE that is the SAME product as the TARGET — same brand, model AND variant.`,
    `Use world knowledge: treat aliases/abbreviations as equal (e.g. "Man Utd" = "Manchester United", "MUFC" = "Manchester United").`,
    `But be STRICT about type and variant: a jersey is NOT a plain t-shirt; a case/cover/charger is NOT the device; different model numbers or sizes are different products (M36 ≠ A36, 3.0 ≠ 2.0, 43" ≠ 55", 128GB ≠ 256GB).`,
    ``,
    `TARGET: ${target.brand} ${target.model} (${target.category}) ${JSON.stringify(target.attributes)}`,
    `Full title: ${target.title}`,
    ``,
    `CANDIDATES:`,
    list,
    ``,
    `Respond ONLY with JSON: {"index": <number, or -1 if none truly match>, "reason": "short"}`,
  ].join("\n");
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content) as { index: number; reason: string };
    const index = Number(parsed.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) return null;
    return { index, reason: String(parsed.reason ?? "AI judge") };
  } catch {
    return null;
  }
}

/** Ask the LLM to confirm a single candidate. Returns null if LLM disabled or on error. */
export async function llmJudge(
  target: ProductIdentity,
  candidate: Candidate
): Promise<LLMVerdict | null> {
  if (!isLLMEnabled()) return null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(target, candidate) }],
      }),
    });
    if (!res.ok) return null; // degrade to rule-based
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(text) as LLMVerdict;
    return {
      isMatch: Boolean(parsed.isMatch),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason ?? "llm verdict"),
    };
  } catch {
    return null; // any failure → fall back to rule-based (graceful degradation)
  }
}
