// Jupiter /quote — READ ONLY. Used purely to learn the realistic fill
// (price impact / route output) for a given trade size. We never call
// /swap, never build a transaction, never sign anything.

import { ENDPOINTS, KEYS, SIM } from "../config";
import type { QuoteResult } from "../types";
import { asNumber, fetchJson } from "../utils/http";

interface JupQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string | number;
  slippageBps?: number;
  routePlan?: { swapInfo?: { label?: string } }[];
  error?: string;
}

export type QuoteOutcome = { ok: true; quote: QuoteResult } | { ok: false; error: string };

function jupiterHeaders(): Record<string, string> {
  return KEYS.jupiter ? { "x-api-key": KEYS.jupiter } : {};
}

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps?: number;
}): Promise<QuoteOutcome> {
  if (params.amountRaw <= 0n) return { ok: false, error: "quote amount must be > 0" };
  const slippageBps = params.slippageBps ?? SIM.quoteSlippageBps;
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
  });
  const url = `${ENDPOINTS.jupiterBase}${ENDPOINTS.jupiterQuotePath}?${qs.toString()}`;
  const res = await fetchJson<JupQuoteResponse>(url, { headers: jupiterHeaders() });
  if (!res.ok) return { ok: false, error: `jupiter quote: ${res.error}` };

  const d = res.data;
  if (d.error) return { ok: false, error: `jupiter quote: ${d.error}` };
  let inAmountRaw: bigint;
  let outAmountRaw: bigint;
  try {
    inAmountRaw = BigInt(d.inAmount ?? "");
    outAmountRaw = BigInt(d.outAmount ?? "");
  } catch {
    return { ok: false, error: "jupiter quote: missing/invalid inAmount or outAmount" };
  }
  if (outAmountRaw <= 0n) return { ok: false, error: "jupiter quote: zero output (no route)" };

  return {
    ok: true,
    quote: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmountRaw,
      outAmountRaw,
      priceImpactPct: (asNumber(d.priceImpactPct) ?? 0) * 100,
      slippageBps,
      routeLabels: (d.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
      fetchedAt: Date.now(),
    },
  };
}

export { jupiterHeaders };
