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
