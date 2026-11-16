// ============================================================
// POST /api/match  { url }  → MatchResponse
// Cache-first: if we've resolved this Amazon product recently, return
// it instantly (no scrape). Otherwise run extract → pipeline, then
// store the result so the next lookup is free + instant.
//
// Hardened: strict Amazon-URL validation (no SSRF — the host must be
// amazon and a real ASIN must be present), input-size cap, and a
// best-effort per-IP rate limit so the scrape/LLM fan-out can't be
// abused to burn API credits.
// ============================================================

import { NextResponse } from "next/server";
import { extractFromAmazon } from "@/lib/extract/amazon";
// Live scraping (Myntra render via ScraperAPI) can take a while — give the
// serverless function room (Vercel Hobby allows up to 60s).
export const maxDuration = 60;
import { matchAcrossPlatforms } from "@/lib/pipeline";
import { cacheGet, cacheSet, cacheKeyForAmazon } from "@/lib/data/cache";
import type { MatchResponse } from "@/lib/types";

const MAX_URL_LEN = 2048;

/**
 * Validate that `raw` is a real Amazon product URL and return the normalized
 * string, or null. Guards against SSRF: the HOST must be an amazon domain
 * (not just a string containing "amazon"), and a 10-char ASIN must be present.
 */
function validateAmazonUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_URL_LEN) return null;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  // Host must END in amazon.in / amazon.com (optionally with a subdomain).
  // Anchoring the TLD is critical: a loose "amazon\.[a-z.]+$" would also match
  // a spoof like "amazon.in.evil.com", re-opening the SSRF. Whitelist TLDs.
  const host = u.hostname.toLowerCase();
  if (!/^([a-z0-9-]+\.)*amazon\.(in|com)$/.test(host)) return null;

  // A genuine product link carries an ASIN. Requiring it also blocks
  // "amazon" as a bare word and arbitrary amazon-domain paths.
  if (!/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(u.pathname)) return null;

  return s;
}

// Best-effort per-IP rate limit. NOTE: serverless memory is per-instance, so
// this is a soft guard, not a hard limit — a production deploy should back this
// with Upstash/Redis. Still enough to stop a naive abuse loop on one instance.
const RATE_LIMIT = 15; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, { count: number; reset: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  e.count++;
  return e.count > RATE_LIMIT;
}

export async function POST(req: Request) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute and try again." },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const url = validateAmazonUrl(body?.url);
    if (!url) {
      return NextResponse.json(
        { error: "Please provide a valid Amazon product URL (e.g. https://www.amazon.in/dp/XXXXXXXXXX)." },
        { status: 400 }
      );
    }

    // 1. Cache-first — skip the scrape if we've seen this product recently.
    const key = cacheKeyForAmazon(url);
    const hit = cacheGet<MatchResponse>(key);
    if (hit) {
      return NextResponse.json({ ...hit, cached: true });
    }

    // 2. Miss → resolve live.
    const identity = await extractFromAmazon(url);
    const result = await matchAcrossPlatforms(identity);

    // 3. Store for next time.
    cacheSet(key, result);

    return NextResponse.json({ ...result, cached: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Something went wrong." },
      { status: 500 }
    );
  }
}
