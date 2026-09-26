// DexScreener — supplementary market data (liquidity, volume, tx counts,
// price, pair age) and backup price source. Read-only public API.
//
// Deliberately NOT used: /token-boosts/*, /token-profiles/* (promoted lists).

import { ENDPOINTS, RUNTIME } from "../config";
import type { MarketSnapshot } from "../types";
import { mapLimit } from "../utils/concurrency";
import { asNumber, fetchJson } from "../utils/http";

interface DsToken {
  address?: string;
  name?: string;
  symbol?: string;
}

interface DsPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: DsToken;
  quoteToken?: DsToken;
  priceUsd?: string | number;
  txns?: { m5?: { buys?: number; sells?: number } };
  volume?: { m5?: number };
  priceChange?: { m5?: number; h1?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

interface DsTokensResponse {
  pairs?: DsPair[] | null;
}

function pairToSnapshot(pair: DsPair, mint: string, now: number): MarketSnapshot | null {
  const priceUsd = asNumber(pair.priceUsd);
  if (priceUsd === null || priceUsd <= 0) return null;
  const buys = asNumber(pair.txns?.m5?.buys);
  const sells = asNumber(pair.txns?.m5?.sells);
  return {
    tokenAddress: mint,
    symbol: pair.baseToken?.symbol ?? "?",
    name: pair.baseToken?.name ?? "",
    pairAddress: pair.pairAddress ?? "",
    dexId: pair.dexId ?? "",
    priceUsd,
    marketCapUsd: asNumber(pair.marketCap) ?? asNumber(pair.fdv),
    liquidityUsd: asNumber(pair.liquidity?.usd),
    volume5mUsd: asNumber(pair.volume?.m5),
    buys5m: buys,
    sells5m: sells,
    priceChange5mPct: asNumber(pair.priceChange?.m5),
    priceChange1hPct: asNumber(pair.priceChange?.h1),
    pairCreatedAt: asNumber(pair.pairCreatedAt),
    fetchedAt: now,
  };
}

/**
 * DexScreener returns at most `pairCap` pairs per request, counting every
 * pair a requested token appears in (base OR quote). A naive 30-address
 * batch therefore silently drops tokens whenever the others have several
 * pairs. We remember each token's pair footprint and pack batches to fit.
 */
const knownPairFootprint = new Map<string, number>();

function packBatches(mints: string[]): string[][] {
  const { pairCap, addressCap, unknownPairEstimate } = RUNTIME.dexscreener;
  const batches: string[][] = [];
  let cur: string[] = [];
  let curPairs = 0;
  for (const mint of mints) {
    const est = Math.min(pairCap, knownPairFootprint.get(mint) ?? unknownPairEstimate);
    if (cur.length > 0 && (cur.length >= addressCap || curPairs + est > pairCap)) {
      batches.push(cur);
      cur = [];
      curPairs = 0;
    }
    cur.push(mint);
    curPairs += est;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

async function fetchBatch(
  batch: string[],
  snapshots: Map<string, MarketSnapshot>,
  errors: string[],
  depth: number,
): Promise<void> {
  const url = `${ENDPOINTS.dexscreenerBase}/latest/dex/tokens/${batch.join(",")}`;
  const res = await fetchJson<DsTokensResponse>(url);
  if (!res.ok) {
    errors.push(`dexscreener batch (${batch.length} mints): ${res.error}`);
    return;
  }
  const pairs = Array.isArray(res.data.pairs) ? res.data.pairs : [];
  const now = Date.now();
  const wanted = new Set(batch);
  const bestByMint = new Map<string, DsPair>();
  const footprint = new Map<string, number>();
  for (const pair of pairs) {
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    if (base && wanted.has(base)) footprint.set(base, (footprint.get(base) ?? 0) + 1);
    if (quote && wanted.has(quote)) footprint.set(quote, (footprint.get(quote) ?? 0) + 1);
    if (pair.chainId !== "solana" || !base || !wanted.has(base)) continue;
    const liq = asNumber(pair.liquidity?.usd) ?? 0;
    const prev = bestByMint.get(base);
    const prevLiq = prev ? (asNumber(prev.liquidity?.usd) ?? 0) : -1;
    if (!prev || liq > prevLiq) bestByMint.set(base, pair);
  }
  for (const [mint, pair] of bestByMint) {
    const snap = pairToSnapshot(pair, mint, now);
    if (snap) snapshots.set(mint, snap);
  }

  const capped = pairs.length >= RUNTIME.dexscreener.pairCap;
  for (const [mint, n] of footprint) {
    // A capped response understates footprints; only learn from complete ones,
    // except that a token filling a whole response on its own is "huge".
    if (!capped) knownPairFootprint.set(mint, n);
    else if (batch.length === 1) knownPairFootprint.set(mint, RUNTIME.dexscreener.pairCap);
  }
  const missing = batch.filter((m) => !snapshots.has(m));
  if (capped && missing.length > 0 && batch.length > 1 && depth < 4) {
    // Crowded out — retry the missing ones in halves until they fit or stand alone.
    const half = Math.ceil(missing.length / 2);
    const halves = [missing.slice(0, half), missing.slice(half)].filter((h) => h.length > 0);
    await Promise.all(halves.map((h) => fetchBatch(h, snapshots, errors, depth + 1)));
  } else if (!capped) {
    for (const m of missing) knownPairFootprint.set(m, 0); // genuinely no pair right now
  }
}

/**
 * Cheap path: /pairs returns exactly the requested pairs (one per address,
 * no crowding), so tokens whose best pair is already known refresh at 30 per
 * call. Results are keyed back to the mint via the pair's base token.
 */
async function fetchByPairs(
  pairToMint: Map<string, string>,
  snapshots: Map<string, MarketSnapshot>,
  errors: string[],
): Promise<void> {
  const addrs = Array.from(pairToMint.keys());
  const batches: string[][] = [];
  for (let i = 0; i < addrs.length; i += RUNTIME.dexscreener.addressCap) batches.push(addrs.slice(i, i + RUNTIME.dexscreener.addressCap));
  await mapLimit(batches, RUNTIME.dexscreener.maxConcurrentRequests, async (batch) => {
    const url = `${ENDPOINTS.dexscreenerBase}/latest/dex/pairs/solana/${batch.join(",")}`;
    const res = await fetchJson<DsTokensResponse>(url);
    if (!res.ok) {
      errors.push(`dexscreener pairs batch (${batch.length}): ${res.error}`);
      return;
    }
    const now = Date.now();
    for (const pair of Array.isArray(res.data.pairs) ? res.data.pairs : []) {
      const mint = pair.pairAddress ? pairToMint.get(pair.pairAddress) : undefined;
      if (!mint || pair.baseToken?.address !== mint) continue;
      const snap = pairToSnapshot(pair, mint, now);
      if (snap) snapshots.set(mint, snap);
    }
  });
}

/**
 * Fetch a snapshot per token from its most liquid Solana pair.
 * `knownPairs` (mint → pair address) routes those tokens through the cheap
 * /pairs endpoint; everything else (new tokens, periodic best-pair
 * re-resolution) goes through footprint-packed /tokens batches.
 * Tokens with no usable pair are simply absent from the map (= unresolved).
 * Batch-level failures are reported in `errors`; they never throw.
 */
export async function fetchMarketSnapshots(
  mints: string[],
  knownPairs?: Map<string, string>,
): Promise<{ snapshots: Map<string, MarketSnapshot>; errors: string[] }> {
  const snapshots = new Map<string, MarketSnapshot>();
  const errors: string[] = [];
  const unique = Array.from(new Set(mints));

  const pairToMint = new Map<string, string>();
  const viaTokens: string[] = [];
  for (const mint of unique) {
    const pair = knownPairs?.get(mint);
    if (pair) pairToMint.set(pair, mint);
    else viaTokens.push(mint);
  }
  if (pairToMint.size > 0) await fetchByPairs(pairToMint, snapshots, errors);
  // A known pair that vanished (pool closed / migrated) falls back to re-resolution.
  if (errors.length === 0) {
    for (const mint of pairToMint.values()) if (!snapshots.has(mint)) viaTokens.push(mint);
  }
  await mapLimit(packBatches(viaTokens), RUNTIME.dexscreener.maxConcurrentRequests, (batch) => fetchBatch(batch, snapshots, errors, 0));
  return { snapshots, errors };
}
