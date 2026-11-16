// ============================================================
// Shared types for the product-matching pipeline.
// Keeping these in one place so every stage (extract → search →
// match → decide) speaks the same language.
// ============================================================

export type Category = "smartphone" | "laptop" | "television" | "sneaker" | "tshirt";

export type Platform = "flipkart" | "croma" | "myntra";

// The three possible outcomes the assignment asks for, per platform.
export type Availability = "in_stock" | "out_of_stock" | "not_listed";

/**
 * The canonical identity we extract from the Amazon product.
 * Everything downstream matches against THIS.
 *
 * `attributes` holds the category-specific fields that must also match:
 *   smartphone → { ram, storage }
 *   television → { screenSize }
 *   sneaker    → { color }
 *   tshirt     → { color }
 */
export interface ProductIdentity {
  brand: string;
  model: string;
  category: Category;
  attributes: Record<string, string>;
  title: string;      // original title, kept for the LLM / debugging
  sourceUrl: string;
  price?: string;     // the Amazon price, for comparison
  searchQuery?: string; // clean query for searching other platforms (LLM-cleaned)
  imageUrl?: string;  // Amazon product image — for visual (CLIP) matching
}

/** A raw candidate a platform adapter returns from its search. */
export interface Candidate {
  title: string;
  url: string;
  inStock: boolean;
  price?: string;          // e.g. "₹69,999" — for price comparison
  // adapters fill whatever structured attrs they can; the matcher
  // falls back to parsing the title when these are missing.
  attributes?: Record<string, string>;
  imageUrl?: string;       // listing thumbnail — for visual (CLIP) matching
}

/** The result we show for ONE platform. */
export interface PlatformResult {
  platform: Platform;
  status: Availability;
  url?: string;            // present when in_stock / out_of_stock
  matchedTitle?: string;
  price?: string;          // the matched listing's price
  confidence?: number;     // 0..1 — how sure we are it's the same product
  reason?: string;         // short human explanation (why matched / why not)
  // false when the model matched but a required variant attr (colour/size/RAM)
  // could NOT be confirmed — so stock is for the MODEL, not necessarily the
  // exact variant the user searched. The UI shows a caveat in that case.
  variantConfirmed?: boolean;
}

/** The full response the API returns. */
export interface MatchResponse {
  source: ProductIdentity;
  results: PlatformResult[];
  cached?: boolean;   // true when served from cache (no live scrape)
  notice?: string;    // e.g. scraping-quota-exhausted banner for the UI
}
