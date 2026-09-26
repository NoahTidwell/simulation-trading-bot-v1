// Live price lookups for open positions.
// Primary: Jupiter Price API. Backup: DexScreener (either a snapshot fetched
// this cycle or a fresh lookup). If both fail the result is an explicit
// { status: "unresolved" } — NEVER a stale or fallback number.

import { ENDPOINTS, RUNTIME, SIM, SOLANA } from "../config";
import type { MarketSnapshot, PriceResult } from "../types";
import { asNumber, fetchJson } from "../utils/http";
import { fetchMarketSnapshots } from "./dexscreener-client";
import { getQuote, jupiterHeaders } from "./jupiter-quote-client";
import { lamportsToSol, toRawAmount } from "../simulation/cost-model";

// Price API v3 shape: { [mint]: { usdPrice, ... } }. v2 shape: { data: { [mint]: { price } } }.
type JupPriceResponse = Record<string, unknown> & { data?: Record<string, unknown> };

function parseJupiterPrices(body: JupPriceResponse, mints: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const table = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  for (const mint of mints) {
    const entry = table[mint] as Record<string, unknown> | undefined | null;
    if (!entry || typeof entry !== "object") continue;
    const p = asNumber(entry.usdPrice) ?? asNumber(entry.price);
    if (p !== null && p > 0) out.set(mint, p);
  }
  return out;
}

export class PriceFeed {
  private solPrice: { priceUsd: number; at: number } | null = null;
  private solInFlight: Promise<PriceResult> | null = null;

  /**
   * Resolve USD prices for many mints. Snapshots fetched this cycle (if given)
   * serve as the DexScreener backup so we don't double-call.
   */
  async resolveMany(mints: string[], backupSnapshots?: Map<string, MarketSnapshot>): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    const unique = Array.from(new Set(mints));
    if (unique.length === 0) return results;

    const errors: string[] = [];
    const jupiter = new Map<string, number>();
    for (let i = 0; i < unique.length; i += RUNTIME.jupiterPriceBatchSize) {
      const batch = unique.slice(i, i + RUNTIME.jupiterPriceBatchSize);
      const url = `${ENDPOINTS.jupiterBase}${ENDPOINTS.jupiterPricePath}?ids=${batch.join(",")}`;
      const res = await fetchJson<JupPriceResponse>(url, { headers: jupiterHeaders() });
      if (!res.ok) {
        errors.push(`jupiter price: ${res.error}`);
        continue;
      }
      for (const [m, p] of parseJupiterPrices(res.data, batch)) jupiter.set(m, p);
    }

    const now = Date.now();
    const missing: string[] = [];
    for (const mint of unique) {
      const p = jupiter.get(mint);
      if (p !== undefined) results.set(mint, { status: "resolved", priceUsd: p, source: "jupiter", at: now });
      else missing.push(mint);
    }

    if (missing.length > 0) {
      // Backup: snapshots from this cycle, else a fresh DexScreener call.
      const stillMissing: string[] = [];
      for (const mint of missing) {
        const snap = backupSnapshots?.get(mint);
        if (snap && now - snap.fetchedAt < RUNTIME.scanIntervalMs * 2) {
          results.set(mint, { status: "resolved", priceUsd: snap.priceUsd, source: "dexscreener", at: snap.fetchedAt });
        } else {
          stillMissing.push(mint);
        }
      }
      if (stillMissing.length > 0) {
        const { snapshots, errors: dsErrors } = await fetchMarketSnapshots(stillMissing);
        errors.push(...dsErrors);
        for (const mint of stillMissing) {
          const snap = snapshots.get(mint);
          if (snap) results.set(mint, { status: "resolved", priceUsd: snap.priceUsd, source: "dexscreener", at: snap.fetchedAt });
          else results.set(mint, { status: "unresolved", error: errors.join("; ") || "no price from jupiter or dexscreener", at: now });
        }
      }
    }
    return results;
  }

  /**
   * Live executable price for selling `tokens` of `mint`: a Jupiter sell quote
   * for that exact size, as USD per token (before transfer tax, like every
   * other market price here). The Price API is cached for several seconds;
   * a quote reflects the pool right now, which is what a stop needs.
   */
  async resolveSellQuote(args: { mint: string; tokens: number; decimals: number; transferTaxPct: number }): Promise<{ result: PriceResult; rateLimited: boolean }> {
    const now = Date.now();
    const sol = await this.resolveSol();
    if (sol.status !== "resolved") return { result: { status: "unresolved", error: `SOL price: ${sol.error}`, at: now }, rateLimited: false };
    const tokensIn = args.tokens * (1 - args.transferTaxPct / 100);
    const quote = await getQuote({ inputMint: args.mint, outputMint: SOLANA.wsolMint, amountRaw: toRawAmount(tokensIn, args.decimals) });
    if (!quote.ok) return { result: { status: "unresolved", error: quote.error, at: now }, rateLimited: quote.error.includes("HTTP 429") };
    const solOut = lamportsToSol(quote.quote.outAmountRaw);
    const priceUsd = (solOut * sol.priceUsd) / tokensIn;
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return { result: { status: "unresolved", error: "quote produced no price", at: now }, rateLimited: false };
    return { result: { status: "resolved", priceUsd, source: "jupiterQuote", at: quote.quote.fetchedAt }, rateLimited: false };
  }

  /**
   * SOL/USD. A cached value younger than `maxAgeMs` is reused (SOL moves far
   * slower than the fill it's pricing); otherwise one Jupiter price call.
   */
  async resolveSol(maxAgeMs: number = SIM.solPriceMaxAgeMs): Promise<PriceResult> {
    if (this.solPrice && Date.now() - this.solPrice.at <= maxAgeMs) {
      return { status: "resolved", priceUsd: this.solPrice.priceUsd, source: "jupiter", at: this.solPrice.at };
    }
    // Concurrent exits share one in-flight lookup instead of each calling Jupiter.
    this.solInFlight ??= this.fetchSol().finally(() => {
      this.solInFlight = null;
    });
    return this.solInFlight;
  }

  private async fetchSol(): Promise<PriceResult> {
    const res = await this.resolveMany([SOLANA.wsolMint]);
    const r = res.get(SOLANA.wsolMint);
    if (r && r.status === "resolved") {
      this.solPrice = { priceUsd: r.priceUsd, at: r.at };
      return r;
    }
    return r ?? { status: "unresolved", error: "no SOL price", at: Date.now() };
  }

  /**
   * Last known SOL price, used ONLY to convert fixed SOL fees to USD on exits
   * (we must always be able to exit). Null if never resolved.
   */
  lastKnownSolPrice(): number | null {
    return this.solPrice?.priceUsd ?? null;
  }
}
