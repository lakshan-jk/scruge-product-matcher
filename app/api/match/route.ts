// ============================================================
// POST /api/match  { url }  → MatchResponse
// Cache-first: if we've resolved this Amazon product recently, return
// it instantly (no scrape). Otherwise run extract → pipeline, then
// store the result so the next lookup is free + instant.
// ============================================================

import { NextResponse } from "next/server";
import { extractFromAmazon } from "@/lib/extract/amazon";
// Live scraping (Myntra render via ScraperAPI) can take a while — give the
// serverless function room (Vercel Hobby allows up to 60s).
export const maxDuration = 60;
import { matchAcrossPlatforms } from "@/lib/pipeline";
import { cacheGet, cacheSet, cacheKeyForAmazon } from "@/lib/data/cache";
import type { MatchResponse } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const url: unknown = body?.url;

    if (typeof url !== "string" || !url.includes("amazon")) {
      return NextResponse.json(
        { error: "Please provide a valid Amazon product URL." },
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
