// ============================================================
// CACHE — store resolved results so repeat lookups of the same
// product skip the scrape entirely (instant + saves ScraperAPI
// credits). Keyed by the Amazon ASIN so different URL formats of
// the same product share a cache entry.
//
// Two layers: in-memory (fast) + a JSON file (survives restarts on
// a persistent host). Writes degrade silently on read-only/serverless
// filesystems — then it's just an in-memory cache.
//
// Interface is deliberately simple so it can later be swapped for
// Redis or a vector DB (the production design) with no call-site change.
// ============================================================

import fs from "fs";
import path from "path";

interface Entry {
  value: unknown;
  expires: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — prices/stock drift over time
const FILE = path.join(process.cwd(), ".cache", "results.json");

const mem = new Map<string, Entry>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, Entry>;
    for (const [k, v] of Object.entries(obj)) mem.set(k, v);
  } catch {
    /* no cache file yet — fine */
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const obj: Record<string, Entry> = {};
    for (const [k, v] of mem.entries()) obj[k] = v;
    fs.writeFileSync(FILE, JSON.stringify(obj));
  } catch {
    /* read-only fs (serverless) → in-memory only */
  }
}

export function cacheGet<T>(key: string): T | null {
  load();
  const e = mem.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    mem.delete(key);
    return null;
  }
  return e.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs = DEFAULT_TTL_MS): void {
  load();
  mem.set(key, { value, expires: Date.now() + ttlMs });
  persist();
}

/** Key by Amazon ASIN so different URL formats of the same product share a cache entry. */
export function cacheKeyForAmazon(url: string): string {
  const asin = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return asin ? `asin:${asin[1].toUpperCase()}` : `url:${url.split("?")[0].toLowerCase()}`;
}
