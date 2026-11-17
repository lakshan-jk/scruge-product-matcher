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
import { resetQuotaFlag, isQuotaExhausted } from "@/lib/data/scraper";
import type { MatchResponse } from "@/lib/types";

const QUOTA_NOTICE =
  "⚠ Our live-data quota is exhausted for now, so Myntra/Croma results may be limited (Flipkart still works). Full results resume when the quota resets.";

const MAX_URL_LEN = 2048;

/**
 * Validate that `raw` is a real Amazon product URL and return the normalized
 * string, or null. Guards against SSRF: the HOST must be an amazon domain
 * (not just a string containing "amazon"), and a 10-char ASIN must be present.
 */
function validateAmazonUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LEN) return null;
  // Accept URLs pasted without a scheme ("amazon.in/dp/XXXX" → add https://).
  const s = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  // Host must END in amazon.in / amazon.com (optionally with a subdomain), OR be
  // an Amazon short-link domain (amzn.in / amzn.to / a.co). Anchoring the TLD is
  // critical: a loose "amazon\.[a-z.]+$" would also match a spoof like
  // "amazon.in.evil.com", re-opening the SSRF. Whitelist TLDs.
  const host = u.hostname.toLowerCase();
  const isAmazon = /^([a-z0-9-]+\.)*amazon\.(in|com)$/.test(host);
  const isShort = /^(amzn\.in|amzn\.to|a\.co)$/.test(host);
  if (!isAmazon && !isShort) return null;

  // Full links must carry an ASIN; short links just need a non-empty path
  // (they'll be resolved to the full URL before use).
  if (isAmazon && !/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(u.pathname)) return null;
  if (isShort && u.pathname.length < 2) return null;

  return s;
}

/** Follow an Amazon short link (amzn.in/d/...) to its full product URL. */
async function resolveShortLink(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    return res.url || null; // final URL after redirects
  } catch {
    return null;
  }
}

function isShortLink(url: string): boolean {
  try {
    return /^(amzn\.in|amzn\.to|a\.co)$/.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
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
    let url = validateAmazonUrl(body?.url);
    if (!url) {
      return NextResponse.json(
        { error: "Please provide a valid Amazon product URL (e.g. https://www.amazon.in/dp/XXXXXXXXXX)." },
        { status: 400 }
      );
    }

    // Short link (amzn.in/d/...) → follow the redirect to the full product URL,
    // then re-validate (so SSRF guards still apply to the resolved target).
    if (isShortLink(url)) {
      const resolved = await resolveShortLink(url);
      const full = resolved ? validateAmazonUrl(resolved) : null;
      if (!full || isShortLink(full)) {
        return NextResponse.json(
          { error: "Couldn't resolve that short link to an Amazon product. Please paste the full product URL." },
          { status: 400 }
        );
      }
      url = full;
    }

    // 1. Cache-first — skip the scrape if we've seen this product recently.
    const key = cacheKeyForAmazon(url);
    const hit = cacheGet<MatchResponse>(key);
    if (hit) {
      return NextResponse.json({ ...hit, cached: true });
    }

    // 2. Miss → resolve live.
    resetQuotaFlag();
    const identity = await extractFromAmazon(url);
    const result = await matchAcrossPlatforms(identity);

    // 3. Store for next time (don't cache a quota-degraded result).
    const notice = isQuotaExhausted() ? QUOTA_NOTICE : undefined;
    if (!notice) cacheSet(key, result);

    return NextResponse.json({ ...result, notice, cached: false });
  } catch (err) {
    // If the whole lookup failed because the scraping quota is gone, say so clearly.
    if (isQuotaExhausted()) {
      return NextResponse.json(
        { error: "Live-data quota is exhausted right now. Please try again after it resets." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Something went wrong." },
      { status: 500 }
    );
  }
}
