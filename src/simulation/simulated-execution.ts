// Simulated execution. This is the ONLY place a "fill" is produced, and it
// produces it by:
//   1. waiting a synthetic 2–4 s execution delay,
//   2. asking Jupiter /quote (read-only) what the route would return for the
//      exact size AT THAT LATER MOMENT,
//   3. applying transfer tax, priority fee, Jito tip, and quoted slippage.
//
// Nothing here builds, signs, or submits a transaction. There is no wallet.

import { RUNTIME, SIM, SOLANA } from "../config";
import { getQuote } from "../data/jupiter-quote-client";
import type { PriceFeed } from "../data/price-feed";
import type { Candidate, ExitFill, ExitReason, Position, SecurityGateResult, TradeLogEntry } from "../types";
import { randomBetween, sleep } from "../utils/sleep";
import {
  computeEntryFill,
  computeExitFill,
  computeFallbackExitFill,
  fixedFeesSol,
  solToLamports,
  toRawAmount,
} from "./cost-model";

export type EntryOutcome = { ok: true; position: Position; log: TradeLogEntry } | { ok: false; reason: string };

export interface ExitOutcome {
  fill: ExitFill;
  log: TradeLogEntry;
  fillSource: "jupiterQuote" | "fallback";
}

export async function simulateEntry(args: {
  candidate: Candidate;
  security: SecurityGateResult;
  sizeUsd: number;
  priceFeed: PriceFeed;
  now: number;
}): Promise<EntryOutcome> {
  const { candidate, security, sizeUsd, priceFeed } = args;
  const mint = candidate.token.tokenAddress;
  if (security.decimals === null || security.transferTaxPct === null) {
    return { ok: false, reason: "security result missing decimals/tax" };
  }

  // SOL/USD is required to translate the USD size into a quote amount.
  const solRes = await priceFeed.resolveSol();
  if (solRes.status !== "resolved") return { ok: false, reason: `SOL price unresolved: ${solRes.error}` };
  const solPriceUsd = solRes.priceUsd;
  const sizeSol = sizeUsd / solPriceUsd;
  const quotedPriceUsd = candidate.snapshot.priceUsd;

  // Synthetic execution latency, then quote at the later timestamp.
  const delayMs = randomBetween(SIM.executionDelayMinMs, SIM.executionDelayMaxMs);
  await sleep(delayMs);

  const quote = await getQuote({ inputMint: SOLANA.wsolMint, outputMint: mint, amountRaw: solToLamports(sizeSol) });
  if (!quote.ok) return { ok: false, reason: quote.error }; // fail closed: no quote, no entry

  const fill = computeEntryFill({
    sizeUsd,
    tokensOutRaw: quote.quote.outAmountRaw,
    decimals: security.decimals,
    transferTaxPct: security.transferTaxPct,
    solPriceUsd,
    quotedPriceUsd,
  });
  if (!(fill.tokensNet > 0) || !Number.isFinite(fill.netFillPriceUsd)) return { ok: false, reason: "quote produced zero tokens" };
  // Fill sanity check: a fill far from the reference price means the two data
  // sources disagree (stale reference / liquidity pulled) — never enter on that.
  if (Math.abs(fill.slippageRealizedPct) > SIM.maxEntryFillDeviationPct) {
    return {
      ok: false,
      reason: `fill ${fill.slippageRealizedPct.toFixed(1)}% from reference (limit ±${SIM.maxEntryFillDeviationPct}%) — data sources disagree`,
    };
  }

  const filledAt = Date.now();
  const fees = fixedFeesSol();
  const position: Position = {
    id: `${mint.slice(0, 6)}-${filledAt}`,
    tokenAddress: mint,
    symbol: candidate.snapshot.symbol,
    band: candidate.band,
    decimals: security.decimals,
    transferTaxPct: security.transferTaxPct,
    openedAt: filledAt,
    quotedEntryPriceUsd: quotedPriceUsd,
    entryNetPriceUsd: fill.netFillPriceUsd,
    tokensInitial: fill.tokensNet,
    tokensRemaining: fill.tokensNet,
    costBasisRemainingUsd: fill.totalCostUsd,
    initialSizeUsd: sizeUsd,
    initialSizeSol: sizeSol,
    highestPriceUsd: fill.grossFillPriceUsd,
    lowestPriceUsd: fill.grossFillPriceUsd,
    trailingActive: false,
    tiersDone: 0,
    lastPriceUsd: fill.grossFillPriceUsd,
    lastResolvedAt: filledAt,
    txHistory: candidate.token.txHistory.slice(-Math.ceil((RUNTIME.txHistoryRetentionMinutes * 60_000) / RUNTIME.scanIntervalMs)),
    entryTxCount5m: (candidate.snapshot.buys5m ?? 0) + (candidate.snapshot.sells5m ?? 0),
    lastSecurityCheckAt: security.checkedAt,
    securityRecheckFailures: 0,
    realizedPnlUsd: 0,
    feesPaidUsd: fill.feesUsd,
  };

  const log: TradeLogEntry = {
    timestamp: new Date(filledAt).toISOString(),
    tokenAddress: mint,
    symbol: position.symbol,
    band: position.band,
    eventType: "entry",
    quotedPrice: quotedPriceUsd,
    netFillPrice: fill.netFillPriceUsd,
    sizeUsd,
    sizeSol,
    transferTax: fill.transferTaxUsd,
    priorityFee: fees.priorityFeeSol,
    jitoTip: fees.jitoTipSol,
    slippageRealizedPct: fill.slippageRealizedPct,
    exitReason: null,
    realizedPnlUsd: null,
    realizedPnlPct: null,
    simulated: true,
    positionId: position.id,
    fillSource: "jupiterQuote",
    executionDelayMs: delayMs,
  };
  return { ok: true, position, log };
}

/**
 * Simulated (partial or full) exit. Always produces a fill: if the quote is
 * unavailable we still exit, using the fallback cost model, because holding
 * on unresolvable data is never allowed.
 */
export async function simulateExit(args: {
  position: Position;
  tokensToSell: number;
  reason: ExitReason;
  priceFeed: PriceFeed;
  referencePriceUsd: number;
}): Promise<ExitOutcome> {
  const { position, priceFeed, reason, referencePriceUsd } = args;
  const tokensSold = Math.min(args.tokensToSell, position.tokensRemaining);
  const fraction = position.tokensRemaining > 0 ? tokensSold / position.tokensRemaining : 0;
  const basisReleasedUsd = position.costBasisRemainingUsd * fraction;
  const isFull = tokensSold >= position.tokensRemaining - 1e-12;

  const delayMs = randomBetween(SIM.executionDelayMinMs, SIM.executionDelayMaxMs);
  await sleep(delayMs);

  // SOL price: fresh if possible; otherwise last known (fees only — exits must proceed).
  const solRes = await priceFeed.resolveSol();
  const solPriceUsd = solRes.status === "resolved" ? solRes.priceUsd : (priceFeed.lastKnownSolPrice() ?? 0);

  let fill: ExitFill | null = null;
  let fillSource: "jupiterQuote" | "fallback" = "fallback";
  if (solPriceUsd > 0) {
    const tokensAfterTax = tokensSold * (1 - position.transferTaxPct / 100);
    const quote = await getQuote({
      inputMint: position.tokenAddress,
      outputMint: SOLANA.wsolMint,
      amountRaw: toRawAmount(tokensAfterTax, position.decimals),
    });
    if (quote.ok) {
      fill = computeExitFill({
        tokensSold,
        solOutRaw: quote.quote.outAmountRaw,
        transferTaxPct: position.transferTaxPct,
        solPriceUsd,
        referencePriceUsd,
        basisReleasedUsd,
      });
      fillSource = "jupiterQuote";
    }
  }
  if (!fill) {
    fill = computeFallbackExitFill({
      tokensSold,
      transferTaxPct: position.transferTaxPct,
      solPriceUsd,
      referencePriceUsd,
      basisReleasedUsd,
    });
  }

  const fees = fixedFeesSol();
  const log: TradeLogEntry = {
    timestamp: new Date().toISOString(),
    tokenAddress: position.tokenAddress,
    symbol: position.symbol,
    band: position.band,
    eventType: isFull ? "exit" : "scaleout",
    quotedPrice: referencePriceUsd,
    netFillPrice: fill.netFillPriceUsd,
    sizeUsd: fill.netProceedsUsd,
    sizeSol: fill.solOut,
    transferTax: fill.transferTaxUsd,
    priorityFee: fees.priorityFeeSol,
    jitoTip: fees.jitoTipSol,
    slippageRealizedPct: fill.slippageRealizedPct,
    exitReason: reason,
    realizedPnlUsd: fill.realizedPnlUsd,
    realizedPnlPct: fill.realizedPnlPct,
    simulated: true,
    positionId: position.id,
    fillSource,
    executionDelayMs: delayMs,
  };
  return { fill, log, fillSource };
}
