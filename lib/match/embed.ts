// ============================================================
// EMBEDDINGS — the semantic recall layer.
//
// Rule-based matching is precise but brittle on RECALL: it misses a
// listing when the same product is worded differently across stores
// ("BRAVIA 2M2" vs "Bravia 2 … K55S25BM2"). Embeddings fix exactly
// that — cosine similarity on the title catches "same product, said
// differently" where token overlap fails.
//
// HYBRID, by design: embeddings widen RECALL (find the candidate);
// the deterministic variant guards in matcher.ts keep PRECISION
// (reject the wrong colour / RAM / size). Retrieval = semantic,
// verification = exact.
//
// OpenAI-compatible: set EMBED_BASE_URL (+ EMBED_MODEL) to a hosted
// embeddings API or a local Ollama (nomic-embed-text). If unset, the
// layer is disabled and matching falls back to pure rules — safe.
// ============================================================

const BASE_URL = process.env.EMBED_BASE_URL;
const API_KEY = process.env.EMBED_API_KEY ?? process.env.LLM_API_KEY ?? "none";
const MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

export function isEmbedEnabled(): boolean {
  return Boolean(BASE_URL);
}

/** Embed a batch of texts in ONE call. Returns null if disabled or on any failure. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!isEmbedEnabled() || texts.length === 0) return null;
  try {
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, input: texts }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const arr = data?.data;
    if (!Array.isArray(arr) || arr.length !== texts.length) return null;
    return arr.map((d: { embedding: number[] }) => d.embedding);
  } catch {
    return null; // any failure → caller falls back to rules
  }
}

/** Cosine similarity of two equal-length vectors → -1..1. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
