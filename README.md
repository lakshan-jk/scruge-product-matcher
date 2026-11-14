# Find the same product, everywhere

Paste an **Amazon product link** → the app finds the **same product** on the other
platforms (Flipkart, Croma, Myntra, by category) and shows **🟢 in stock**,
**🟡 out of stock**, or **⚪ not listed** — with a link, the price, and a match
confidence.

> How matching works, explained simply: **[HOW-MATCHING-WORKS.md](./HOW-MATCHING-WORKS.md)**

## Run it

```bash
npm install
cp .env.example .env.local   # add keys (see below) — or run with none for mock data
npm run dev                  # http://localhost:3000
```

Try the example buttons, or paste a real Amazon link (e.g. a Nike shoe).

## What it does

| Category | Searches on | Must also match |
| --- | --- | --- |
| Smartphones | Flipkart, Croma | RAM + storage |
| Televisions | Flipkart, Croma | screen size |
| Sneakers | Flipkart, Myntra | colour |
| T-shirts / polos / jerseys | Flipkart, Myntra | colour |

## Architecture

An **entity-resolution pipeline** (does a listing refer to the *same* product?),
structured like an agent: **extract → search → match → decide**, with a cache.

```
Amazon URL
  ↓ extract (lib/extract) → {brand, model, category, attributes, price}
  ↓   • ScraperAPI structured Amazon endpoint (clean) + Jina/HTML fallback
  ↓   • LLM (Ollama/Groq, OpenAI-compatible) cleans messy titles + anti-hallucination guard
  ↓ cache-first (lib/data/cache) → instant on repeat, no scrape
  ↓ search (lib/adapters)  → candidates per platform          ← Stage 1
  ↓   • Flipkart → Jina Reader (free, no key, server-rendered)
  ↓   • Myntra   → ScraperAPI → parse window.__myx JSON
  ↓   • Croma    → best-effort → graceful fallback (bot-protected)
  ↓ match (lib/match)      → confidence; variant + tier guards  ← Stage 2
  ↓ decide (lib/pipeline)  → in_stock / out_of_stock / not_listed + price
```

## Keys & configuration (`.env.local`)

```
# Scraping service for bot-protected sites (Myntra, Croma) + Amazon structured data.
SCRAPER_API_KEY=...            # free tier at scraperapi.com

# LLM for clean extraction (OpenAI-compatible). Local Ollama OR hosted (Groq, free).
LLM_BASE_URL=http://localhost:11434/v1     # Ollama local  — OR  https://api.groq.com/openai/v1
LLM_API_KEY=ollama                         # anything for Ollama; your Groq key for Groq
LLM_MODEL=llama3.2                          # Ollama  — OR  llama-3.1-8b-instant (Groq)
```

Everything degrades gracefully: no `SCRAPER_API_KEY` → protected sites fall back to a
dataset; no LLM → heuristic extraction; Flipkart + Amazon work on the free path.

## Key design decisions

- **Precision over recall** — below a confidence threshold, return "not listed"
  rather than show a wrong variant. A wrong match erodes trust.
- **Variant + tier aware** — same model, different storage/colour/size ≠ same
  product; "iPhone 15" ≠ "iPhone 15 Pro".
- **No paid product API** — Flipkart/Amazon on the free path; a scraping service
  only for the bot-protected SPAs (the right tool per site).
- **Cache** — resolved results keyed by ASIN; repeats skip the scrape.
- **Config-driven + pluggable** — add a category (config) or platform (adapter)
  without touching matching.

## Honest limitations

- **Croma** is behind enterprise bot protection; its client-side grid isn't reliably
  scrapeable even with rendering → graceful fallback (prod: its API / browser scraper).
- **Search ranking** — some base models aren't surfaced by a platform's search (it
  shows Plus/Pro variants); the matcher then correctly reports "not listed."

## Path to production

Official APIs / managed scraper for protected sites · canonical product catalog ·
**embeddings + vector DB (RAG)** for semantic matching (local `nomic-embed-text`
ready) · worker + queue for scale.
