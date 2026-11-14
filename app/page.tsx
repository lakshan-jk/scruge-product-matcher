"use client";

import { useState } from "react";
import type { MatchResponse, PlatformResult } from "@/lib/types";

const EXAMPLES = [
  { label: "Nike sneaker", url: "https://www.amazon.in/dp/B0G2RMMTY3" },
  { label: "iPhone 16", url: "https://www.amazon.in/dp/B0DGJHBX5Y" },
  { label: "Samsung TV", url: "https://www.amazon.in/dp/B0GXB76VRW" },
];

const STATUS_UI: Record<PlatformResult["status"], { dot: string; label: string; cls: string }> = {
  in_stock: { dot: "🟢", label: "In stock", cls: "border-green-300 bg-green-50" },
  out_of_stock: { dot: "🟡", label: "Out of stock", cls: "border-amber-300 bg-amber-50" },
  not_listed: { dot: "⚪", label: "Not listed", cls: "border-gray-200 bg-gray-50" },
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<MatchResponse | null>(null);
  const [error, setError] = useState("");

  async function run(link?: string) {
    const target = link ?? url;
    if (!target) return;
    setUrl(target);
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#faf7f2] text-[#2f251f] px-5 py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold">Find the same product, everywhere</h1>
        <p className="mt-2 text-[#8a776a]">
          Paste an Amazon product link — we find the same product on the other
          platforms and tell you if you can buy it.
        </p>

        {/* input */}
        <div className="mt-6 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="https://www.amazon.in/dp/..."
            className="flex-1 rounded-lg border border-[#e5d7c6] bg-white px-4 py-3 outline-none focus:border-[#b5651d]"
          />
          <button
            onClick={() => run()}
            disabled={loading}
            className="rounded-lg bg-[#b5651d] px-5 py-3 font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Finding…" : "Find"}
          </button>
        </div>

        {/* examples */}
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <span className="text-[#8a776a]">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.url}
              onClick={() => run(ex.url)}
              className="rounded-full border border-[#e5d7c6] px-3 py-1 text-[#b5651d] hover:bg-white"
            >
              {ex.label}
            </button>
          ))}
        </div>

        {loading && (
          <p className="mt-6 rounded-lg bg-[#fff6e9] px-4 py-3 text-sm text-[#8a6a3a]">
            Reading the Amazon product and searching the other platforms live… (a few
            seconds — it fetches real pages, no API key).
          </p>
        )}

        {error && <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-red-700">{error}</p>}

        {/* source product */}
        {data && (
          <div className="mt-8">
            {data.cached && (
              <p className="mb-3 inline-block rounded-full bg-[#eef7ef] px-3 py-1 text-xs text-[#2e7d32]">
                ⚡ Served from cache (no live scrape)
              </p>
            )}
            <div className="rounded-xl border border-[#e5d7c6] bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-[#8a776a]">Amazon product</p>
              <p className="mt-1 font-semibold">{data.source.title}</p>
              {data.source.price && (
                <p className="mt-1 text-lg font-bold text-[#2f251f]">{data.source.price}</p>
              )}
              <p className="mt-1 text-sm text-[#8a776a]">
                {data.source.brand} · {data.source.model} · {data.source.category}
                {Object.keys(data.source.attributes).length > 0 && (
                  <> · {Object.entries(data.source.attributes).map(([k, v]) => `${k}: ${v}`).join(", ")}</>
                )}
              </p>
              <a href={data.source.sourceUrl} target="_blank" rel="noreferrer"
                 className="mt-1 inline-block text-sm text-[#b5651d] underline">
                View on Amazon →
              </a>
            </div>

            {/* results */}
            <div className="mt-4 space-y-3">
              {data.results.map((r) => {
                const ui = STATUS_UI[r.status];
                return (
                  <div key={r.platform} className={`rounded-xl border p-4 ${ui.cls}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold capitalize">{r.platform}</span>
                      <span className="text-sm">{ui.dot} {ui.label}</span>
                    </div>
                    {r.price && (
                      <p className="mt-1 text-lg font-bold text-[#2f251f]">{r.price}</p>
                    )}
                    {r.matchedTitle && (
                      <p className="mt-1 text-sm text-[#5a4a3d]">{r.matchedTitle}</p>
                    )}
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer"
                         className="mt-1 inline-block text-sm text-[#b5651d] underline">
                        View on {r.platform} →
                      </a>
                    )}
                    {typeof r.confidence === "number" && (
                      <p className="mt-1 text-xs text-[#8a776a]">
                        match confidence: {Math.round(r.confidence * 100)}% · {r.reason}
                      </p>
                    )}
                    {r.status === "not_listed" && r.reason && (
                      <p className="mt-1 text-xs text-[#8a776a]">{r.reason}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
