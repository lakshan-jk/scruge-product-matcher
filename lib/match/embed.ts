// ============================================================
// EMBEDDINGS — semantic (text) + visual (CLIP image) recall layers.
//
// PROVIDER-SWITCHABLE via EMBED_PROVIDER:
//   • "jina" (default) — OpenAI-compatible /embeddings (jina-embeddings-v3,
//                        jina-clip-v2 for images).
//   • "hf"             — HuggingFace Inference API (all open-source models):
//                        text  → sentence-transformers feature-extraction
//                        image → a CLIP model (text+image share one space)
//
// HYBRID, by design: embeddings widen RECALL; the deterministic variant guards
// in matcher.ts keep PRECISION. Retrieval = semantic, verification = exact.
// ============================================================

const PROVIDER = (process.env.EMBED_PROVIDER ?? "jina").toLowerCase();

// --- Jina (OpenAI-compatible) config ---
const JINA_BASE = process.env.EMBED_BASE_URL;
const JINA_KEY = process.env.EMBED_API_KEY ?? process.env.LLM_API_KEY ?? "none";
const JINA_TEXT_MODEL = process.env.EMBED_MODEL ?? "jina-embeddings-v3";
const JINA_CLIP_MODEL = process.env.CLIP_MODEL ?? "jina-clip-v2";

// --- HuggingFace config ---
const HF_BASE = process.env.HF_BASE_URL ?? "https://api-inference.huggingface.co/models";
const HF_TOKEN = process.env.HF_TOKEN ?? process.env.EMBED_API_KEY;
const HF_TEXT_MODEL = process.env.HF_EMBED_MODEL ?? "sentence-transformers/all-MiniLM-L6-v2";
const HF_CLIP_MODEL = process.env.HF_CLIP_MODEL ?? "sentence-transformers/clip-ViT-B-32";

export function isEmbedEnabled(): boolean {
  return PROVIDER === "hf" ? Boolean(HF_TOKEN) : Boolean(JINA_BASE);
}

// ---------- Jina (OpenAI-compatible) ----------
async function jinaEmbed(model: string, input: unknown[]): Promise<number[][] | null> {
  try {
    const res = await fetch(`${JINA_BASE}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JINA_KEY}` },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const arr = data?.data;
    if (!Array.isArray(arr)) return null;
    return arr.map((d: { embedding: number[] }) => d.embedding);
  } catch {
    return null;
  }
}

// ---------- HuggingFace Inference ----------
/** HF feature-extraction for text (sentence-transformers → sentence vectors). */
async function hfEmbedText(texts: string[]): Promise<number[][] | null> {
  try {
    const res = await fetch(`${HF_BASE}/${HF_TEXT_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HF_TOKEN}` },
      body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // sentence-transformers returns number[][] (one vector per input).
    return Array.isArray(data) && Array.isArray(data[0]) ? (data as number[][]) : null;
  } catch {
    return null;
  }
}

/** HF CLIP text vector (same space as the image vectors below). */
async function hfClipText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${HF_BASE}/${HF_CLIP_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HF_TOKEN}` },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (Array.isArray(data[0]) ? data[0] : data) : null;
  } catch {
    return null;
  }
}

/** HF CLIP image vector — fetch the image and POST its bytes to the CLIP model. */
async function hfClipImage(url: string): Promise<number[] | null> {
  try {
    const img = await fetch(url);
    if (!img.ok) return null;
    const bytes = await img.arrayBuffer();
    const res = await fetch(`${HF_BASE}/${HF_CLIP_MODEL}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": img.headers.get("content-type") ?? "image/jpeg",
      },
      body: bytes,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (Array.isArray(data[0]) ? data[0] : data) : null;
  } catch {
    return null;
  }
}

// ---------- Public API (provider-agnostic) ----------

/** Embed a batch of texts in ONE call. Returns null if disabled or on failure. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!isEmbedEnabled() || texts.length === 0) return null;
  return PROVIDER === "hf" ? hfEmbedText(texts) : jinaEmbed(JINA_TEXT_MODEL, texts);
}

/** Embed image URLs with CLIP → one vector each (same space as text). */
export async function embedImages(urls: string[]): Promise<(number[] | null)[] | null> {
  if (!isEmbedEnabled() || urls.length === 0) return null;
  if (PROVIDER === "hf") {
    // HF: one request per image (binary body). Bounded upstream to a few images.
    return Promise.all(urls.map((u) => hfClipImage(u)));
  }
  const vecs = await jinaEmbed(JINA_CLIP_MODEL, urls.map((u) => ({ image: u })));
  return vecs ?? null;
}

/** Embed a single query string in CLIP space (for visual matching, HF path). */
export async function embedClipText(text: string): Promise<number[] | null> {
  if (!isEmbedEnabled()) return null;
  if (PROVIDER === "hf") return hfClipText(text);
  const vecs = await jinaEmbed(JINA_CLIP_MODEL, [text]);
  return vecs?.[0] ?? null;
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
