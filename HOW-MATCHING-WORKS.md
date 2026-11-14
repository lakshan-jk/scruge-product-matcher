# How the matching works

## Part 1 — Explained like you're 5 🧸

Imagine you have a **red toy car**, and you want to know if your friends have the
*exact same* one.

To be the **same** car, it's not enough that it's "a car." It has to be the
**same brand**, the **same model**, and the **same special thing** — for a car
that might be the **colour**. A red car and a blue car are **not** the same.

So for each friend's shop I check:

1. **Do they have a car like this?** (I search their shop.)
2. **Is it the same brand and model?**
3. **Is the special thing the same?** (Same colour? Same memory? Same size?)

Then I tell you one of three things:

- 🟢 **In stock** — "Yes! Exact same car, you can buy it." (here's the link + price)
- 🟡 **Out of stock** — "Exact same car, but can't buy it now." (here's the link)
- ⚪ **Not listed** — "They don't have this exact car."

One important rule: **if I'm not sure it's the same car, I say 'not listed'** —
showing you the *wrong* car is worse than saying "I didn't find it."

---

## Part 2 — How it actually works 🛠️

This is an **entity-resolution** problem: *"do two listings from different sites
refer to the same real-world product?"* Titles differ everywhere, so string
comparison alone fails.

**The pipeline (like an agent):**

```
Amazon link
  ↓  EXTRACT   → the product identity: brand, model, category, attributes, price
  ↓  (cache-first → instant if we've seen this product before)
  ↓  SEARCH    → each platform returns candidate listings   ← Stage 1 (cheap)
  ↓  MATCH     → score each candidate vs the identity        ← Stage 2 (precise)
  ↓  DECIDE    → in stock / out of stock / not listed + confidence + price
```

**1. Extract (clean identity from a messy page)**
- Amazon product data comes from a structured product API (clean name, price,
  stock), with a raw-HTML/reader fallback.
- A **local LLM (Ollama / any OpenAI-compatible model)** turns the messy title
  into a clean `{brand, model, category, attributes}` — heuristics fail on SEO
  titles like *"Buy Mens Downshifter 14 Black/Red … Running Shoes UK 8"*.
- **Anti-hallucination guard:** an attribute is only kept if its value actually
  appears in the title (a small model can guess "256GB" when the title has none —
  a wrong attribute would cause false mismatches, so we drop it).

**2. Search (candidate generation — Stage 1)** — per platform, by brand + model.

**3. Match (Stage 2)** — normalize everything (`"128 GB"` = `"128GB"`,
`"139 cm (55 inch)"` = `55`), then require:
- brand present, model name contained in the title,
- **variant guard:** same model but different RAM/storage/size = a *different*
  product → rejected,
- **tier guard:** "iPhone 15" must **not** match "iPhone 15 Pro/Plus",
- colour is lenient (shoes have multi-colourways like "Black/Red Orbit").

Produces a **confidence score**; only a match above a threshold counts.

---

## Part 3 — Where the data comes from (no paid product API) 🌐

The interesting engineering is that there's **no paid product-data API** — each
site is reached by the cheapest method that works:

| Source | Method | Why |
| --- | --- | --- |
| **Amazon** | ScraperAPI structured endpoint (+ Jina fallback) | clean name/price/stock |
| **Flipkart** | **Jina Reader — free, no key** | server-rendered → scrapes cleanly |
| **Myntra** | ScraperAPI → parse its `window.__myx` JSON | bot-protected SPA |
| **Croma** | best-effort → graceful fallback | heavy bot protection (see below) |

**Honest limitation — Croma.** Croma's product grid is loaded by a client-side API
behind enterprise bot protection; even a rendering scraper doesn't reliably return
it. It degrades gracefully. In production I'd use Croma's official API or a
browser-automation scraper. Server-rendered sites (Flipkart) scrape with no key;
JS-heavy SPAs (Myntra, Croma) need a scraping service — I use the right tool per site.

**Honest limitation — platform search ranking.** For some base models (e.g. a base
iPhone 16), a platform's search surfaces the Plus/Pro variants and not the exact
base model. The matcher then *correctly* returns "not listed" rather than showing a
different variant — precision over recall, by design.

**Honest limitation — location-specific pricing.** In India, price and stock vary by
delivery pincode. Croma's API already takes a store/pincode code (currently a default
Bangalore store); Flipkart/Myntra return default/national pricing here. In production
I'd thread a single user pincode through every platform so the comparison is
apples-to-apples for that location.

---

## Part 4 — Design choices & trade-offs ⚖️

- **Precision over recall.** A wrong match on a shopping agent erodes trust (and for
  savings, costs money), so below a confidence threshold I return "not listed." I'd
  rather miss than mislead.
- **Config-driven rules.** Platforms + required attributes per category live in one
  config file — add a category in one line.
- **Pluggable adapters.** Each platform implements one interface; data access is
  swappable without touching the matching logic.
- **Cache.** Resolved results are cached by ASIN → repeat lookups skip the scrape
  entirely (instant + saves scraper credits).
- **Rule-based matching + LLM extraction.** The LLM is a great *extractor* (messy
  titles); rule-based scoring is the reliable *matcher*. (An LLM *judge* is wired in
  but gated off — a small local model is unreliable as a judge; a stronger model
  would turn it on for ambiguous cases.)

## Path to production

Official product APIs / a managed scraper for the protected sites · a canonical
product catalog resolved once and reused · **embeddings + a vector DB (RAG)** for
semantic matching instead of string rules (the local `nomic-embed-text` model is
already available for this) · a worker + queue for scale.
