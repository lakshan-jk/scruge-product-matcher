// ============================================================
// The matching RULES from the assignment, as data (not code).
// This is the single source of truth: which platforms to search
// per category, and which attributes MUST also match.
//
// Adding a new category = adding one entry here. (Config-driven,
// the same pattern as a pluggable integration platform.)
// ============================================================

import type { Category, Platform } from "./types";

export interface CategoryRule {
  platforms: Platform[];       // where to search for this category
  requiredAttributes: string[]; // attrs that MUST match (beyond brand + model)
}

export const CATEGORY_RULES: Record<Category, CategoryRule> = {
  smartphone: {
    platforms: ["flipkart", "croma"],
    requiredAttributes: ["ram", "storage", "color"],
  },
  television: {
    platforms: ["flipkart", "croma"],
    requiredAttributes: ["screenSize"],
  },
  sneaker: {
    platforms: ["flipkart", "myntra"],
    requiredAttributes: ["color"],
  },
  tshirt: {
    platforms: ["flipkart", "myntra"],
    requiredAttributes: ["color"],
  },
};

// Confidence below this → we DON'T claim a match (precision over recall:
// for a shopping agent, a wrong match costs trust, so when unsure we
// say "not listed" rather than show the wrong product).
export const MATCH_THRESHOLD = 0.7;
