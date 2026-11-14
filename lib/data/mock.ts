// ============================================================
// MOCK DATASET — lets the whole pipeline work end-to-end today,
// with no API keys. Each "Amazon product" has matching (and
// deliberately NON-matching) listings on the other platforms so
// we can show all three outcomes: in_stock / out_of_stock / not_listed.
//
// Swap this for a real product-data API later (see lib/adapters).
// ============================================================

import type { Candidate, Platform, ProductIdentity } from "../types";

export interface MockProduct {
  identity: ProductIdentity;
  listings: Partial<Record<Platform, Candidate[]>>;
}

export const MOCK_PRODUCTS: MockProduct[] = [
  // ---------- SMARTPHONE ----------
  {
    identity: {
      brand: "Apple",
      model: "iPhone 15",
      category: "smartphone",
      attributes: { ram: "6GB", storage: "128GB" },
      title: "Apple iPhone 15 (Black, 128 GB)",
      sourceUrl: "https://www.amazon.in/dp/iphone15",
    },
    listings: {
      flipkart: [
        { title: "Apple iPhone 15 (Black, 128 GB) 6GB RAM", url: "https://flipkart.com/iphone-15-128", inStock: true, attributes: { ram: "6GB", storage: "128GB" } },
        { title: "Apple iPhone 15 (Blue, 256 GB)", url: "https://flipkart.com/iphone-15-256", inStock: true, attributes: { ram: "6GB", storage: "256GB" } },
      ],
      croma: [
        { title: "Apple iPhone 15 128GB Black", url: "https://croma.com/iphone-15", inStock: false, attributes: { ram: "6GB", storage: "128GB" } },
      ],
    },
  },
  // ---------- TELEVISION ----------
  {
    identity: {
      brand: "Samsung",
      model: "Crystal 4K Neo",
      category: "television",
      attributes: { screenSize: "55 inch" },
      title: "Samsung Crystal 4K Neo 55 inch UHD Smart TV",
      sourceUrl: "https://www.amazon.in/dp/samsung-tv-55",
    },
    listings: {
      flipkart: [
        { title: "Samsung Crystal 4K Neo 138cm (55 inch) UHD TV", url: "https://flipkart.com/samsung-55", inStock: true, attributes: { screenSize: "55 inch" } },
      ],
      croma: [
        { title: "Samsung Crystal 4K Neo 43 inch UHD TV", url: "https://croma.com/samsung-43", inStock: true, attributes: { screenSize: "43 inch" } },
      ],
    },
  },
  // ---------- SNEAKER ----------
  {
    identity: {
      brand: "Nike",
      model: "Revolution 7",
      category: "sneaker",
      attributes: { color: "Black" },
      title: "Nike Revolution 7 Running Shoes (Black)",
      sourceUrl: "https://www.amazon.in/dp/nike-rev7",
    },
    listings: {
      myntra: [
        { title: "Nike Revolution 7 Men Black Running Shoes", url: "https://myntra.com/nike-rev7-black", inStock: true, attributes: { color: "Black" } },
      ],
      flipkart: [], // not listed on Flipkart
    },
  },
];

/** naive mock "extraction": pick a product by keyword in the URL, else default. */
export function mockExtract(url: string): ProductIdentity {
  const u = url.toLowerCase();
  const hit =
    MOCK_PRODUCTS.find((p) => u.includes(p.identity.model.toLowerCase().replace(/\s+/g, "")) ||
      u.includes(p.identity.brand.toLowerCase())) ?? MOCK_PRODUCTS[0];
  return { ...hit.identity, sourceUrl: url };
}

/** mock "search": return the listings for a platform for the matched product. */
export function mockSearch(identity: ProductIdentity, platform: Platform): Candidate[] {
  const product = MOCK_PRODUCTS.find((p) => p.identity.model === identity.model);
  return product?.listings[platform] ?? [];
}
