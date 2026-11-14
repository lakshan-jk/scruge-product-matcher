// ============================================================
// LLM extraction — pull a CLEAN {brand, model, category, attributes,
// searchQuery} out of a messy Amazon title. Heuristics fail on SEO
// titles like "Buy Mens Downshifter 14 Black/Red ... at Amazon.in";
// an LLM handles them easily.
//
// OpenAI-compatible: works with local Ollama (LLM_BASE_URL=
// http://localhost:11434/v1) in dev and a hosted model (Groq, etc.)
// in production — just change the env. Returns null if no LLM is
// configured, so the heuristic extractor remains the fallback.
// ============================================================

import type { Category } from "../types";

const BASE_URL = process.env.LLM_BASE_URL;
const API_KEY = process.env.LLM_API_KEY ?? "none";
const MODEL = process.env.LLM_MODEL ?? "llama3.2";

export function isLLMExtractEnabled(): boolean {
  return Boolean(BASE_URL);
}

export interface LLMExtract {
  brand: string;
  model: string;
  category: Category;
  attributes: Record<string, string>;
  searchQuery: string;
}

const PROMPT = (title: string, body: string) =>
  [
    `Extract product data as JSON. The "model" and "searchQuery" must contain ONLY`,
    `brand + model name — NO colour, NO size, NO words like "running/shoes/mens".`,
    ``,
    `Example 1:`,
    `Title: Buy Mens Downshifter 14 Black/Red Orbit Anthracite White Running Shoes UK 8`,
    `JSON: {"brand":"Nike","model":"Downshifter 14","category":"sneaker","attributes":{"color":"black"},"searchQuery":"Nike Downshifter 14"}`,
    ``,
    `Example 2:`,
    `Title: Apple iPhone 15 (Black, 128 GB)`,
    `JSON: {"brand":"Apple","model":"iPhone 15","category":"smartphone","attributes":{"storage":"128GB"},"searchQuery":"Apple iPhone 15"}`,
    ``,
    `Now extract for this product (respond ONLY with the JSON):`,
    `Title: ${title}`,
    `Details: ${body.slice(0, 800)}`,
  ].join("\n");

export async function llmExtract(title: string, body: string): Promise<LLMExtract | null> {
  if (!isLLMExtractEnabled()) return null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: PROMPT(title, body) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    const p = JSON.parse(text);
    if (!p.brand || !p.model) return null;
    return {
      brand: String(p.brand),
      model: String(p.model),
      category: normalizeCategory(p.category),
      attributes: typeof p.attributes === "object" && p.attributes ? p.attributes : {},
      searchQuery: String(p.searchQuery || `${p.brand} ${p.model}`),
    };
  } catch {
    return null; // any failure → heuristic fallback
  }
}

function normalizeCategory(c: unknown): Category {
  const s = String(c).toLowerCase();
  if (s.includes("tv") || s.includes("televis")) return "television";
  if (s.includes("sneaker") || s.includes("shoe")) return "sneaker";
  if (s.includes("shirt") || s.includes("polo") || s.includes("jersey")) return "tshirt";
  return "smartphone";
}
