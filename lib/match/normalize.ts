// ============================================================
// Normalization — the unglamorous but CRITICAL part of matching.
// Different platforms write the same thing differently:
//   "128 GB" vs "128GB",  "Apple iPhone 15" vs "iPhone 15 (2023)",
//   "55 inch" vs '55"' vs "139 cm (55 inch)".
// We canonicalize everything so comparisons are apples-to-apples.
// ============================================================

/** lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\(\)\[\]\{\},.;:!/\\|"'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "128 GB" / "128gb" / "128 gb rom" → "128gb" */
export function normalizeStorageLike(s: string): string {
  const m = s.toLowerCase().match(/(\d+)\s*(gb|tb)/);
  return m ? `${m[1]}${m[2]}` : normalizeText(s);
}

/** '55"' / "55 inch" / "139 cm (55 inch)" → "55" */
export function normalizeScreenSize(s: string): string {
  const inch = s.toLowerCase().match(/(\d{2,3})\s*(?:inch|in|")/);
  if (inch) return inch[1];
  const cm = s.toLowerCase().match(/(\d{2,3})\s*cm/);
  if (cm) return String(Math.round(Number(cm[1]) / 2.54)); // cm → inch
  const n = s.match(/\d{2,3}/);
  return n ? n[0] : normalizeText(s);
}

/** map common colour variants to a canonical token. */
const COLOR_ALIASES: Record<string, string> = {
  grey: "gray", silver: "gray", space: "gray",
  jetblack: "black", midnight: "black",
  navy: "blue", teal: "blue",
};
export function normalizeColor(s: string): string {
  const t = normalizeText(s).replace(/\s+/g, "");
  return COLOR_ALIASES[t] ?? t;
}

/** Normalize one attribute by its key (ram/storage/screenSize/color). */
export function normalizeAttribute(key: string, value: string): string {
  switch (key) {
    case "ram":
    case "storage":
      return normalizeStorageLike(value);
    case "screenSize":
      return normalizeScreenSize(value);
    case "color":
      return normalizeColor(value);
    default:
      return normalizeText(value);
  }
}

/** token set of a string, for fuzzy brand/model overlap. */
export function tokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(" ").filter((t) => t.length > 1));
}

/** Jaccard overlap of two token sets → 0..1. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / new Set([...a, ...b]).size;
}

/**
 * Containment: what fraction of `needle`'s tokens appear in `haystack`.
 * Right metric for "is this model name present in the candidate title?" —
 * a longer title (extra colour/specs words) shouldn't dilute the score.
 */
export function tokenContainment(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 0;
  let inter = 0;
  for (const t of needle) if (haystack.has(t)) inter++;
  return inter / needle.size;
}
