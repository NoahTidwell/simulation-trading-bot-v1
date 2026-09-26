// Cost model for simulated fills.
//
// Every fill pays: real quoted slippage/price impact (from Jupiter /quote),
// the token's transfer tax (if any), a priority fee, and a Jito tip. All of
// it is netted into the position's basis / proceeds so P&L is what would
// actually have happened, not an idealized fill.

import { SIM } from "../config";
import type { EntryFill, ExitFill } from "../types";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function fixedFeesSol(): { priorityFeeSol: number; jitoTipSol: number; totalSol: number } {
  return { priorityFeeSol: SIM.priorityFeeSol, jitoTipSol: SIM.jitoTipSol, totalSol: SIM.priorityFeeSol + SIM.jitoTipSol };
}

/** Convert a UI token amount to raw units without losing integer precision. */
export function toRawAmount(uiAmount: number, decimals: number): bigint {
  if (!(uiAmount > 0)) return 0n;
  const whole = Math.floor(uiAmount);
  const frac = uiAmount - whole;
  const scale = 10n ** BigInt(decimals);
  const fracRaw = BigInt(Math.floor(frac * Number(scale)));
  return BigInt(whole) * scale + fracRaw;
}

export function fromRawAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Entry: we spend `sizeSol` and the route returns `tokensOutRaw`. Transfer tax
 * is taken from the tokens received; fixed fees are added to the cost.
 */
export function computeEntryFill(args: {
  sizeUsd: number;
  tokensOutRaw: bigint;
  decimals: number;
  transferTaxPct: number;
  solPriceUsd: number;
  quotedPriceUsd: number;
}): EntryFill {
  const fees = fixedFeesSol();
  const tokensGross = fromRawAmount(args.tokensOutRaw, args.decimals);
  const tokensNet = tokensGross * (1 - args.transferTaxPct / 100);
  const grossFillPriceUsd = args.sizeUsd / tokensGross;
  const priorityFeeUsd = fees.priorityFeeSol * args.solPriceUsd;
  const jitoTipUsd = fees.jitoTipSol * args.solPriceUsd;
  const feesUsd = priorityFeeUsd + jitoTipUsd;
  const transferTaxUsd = (tokensGross - tokensNet) * grossFillPriceUsd;
  const totalCostUsd = args.sizeUsd + feesUsd;
  return {
    tokensGross,
    tokensNet,
    grossFillPriceUsd,
    netFillPriceUsd: totalCostUsd / tokensNet,
    transferTaxUsd,
    priorityFeeUsd,
    jitoTipUsd,
    feesUsd,
    totalCostUsd,
    slippageRealizedPct: ((grossFillPriceUsd - args.quotedPriceUsd) / args.quotedPriceUsd) * 100,
    solPriceUsd: args.solPriceUsd,
  };
}

/**
 * Exit: we send `tokensSold` (tax comes off before the pool sees them) and the
 * route returns `solOutRaw`. Fixed fees reduce proceeds.
 */
export function computeExitFill(args: {
  tokensSold: number;
  solOutRaw: bigint;
  transferTaxPct: number;
  solPriceUsd: number;
  referencePriceUsd: number;
  basisReleasedUsd: number;
}): ExitFill {
  const solOut = lamportsToSol(args.solOutRaw);
  const grossProceedsUsd = solOut * args.solPriceUsd;
  return finalizeExit({ ...args, solOut, grossProceedsUsd });
}

/**
 * Exit when no quote is obtainable: still exit (we never hold on unresolvable
 * data), priced at the last resolvable price minus a configured penalty.
 */
export function computeFallbackExitFill(args: {
  tokensSold: number;
  transferTaxPct: number;
  solPriceUsd: number;
  referencePriceUsd: number;
  basisReleasedUsd: number;
}): ExitFill {
  const tokensAfterTax = args.tokensSold * (1 - args.transferTaxPct / 100);
  const grossProceedsUsd = tokensAfterTax * args.referencePriceUsd * (1 - SIM.exitQuoteFailureSlippagePct / 100);
  const solOut = args.solPriceUsd > 0 ? grossProceedsUsd / args.solPriceUsd : 0;
  return finalizeExit({ ...args, solOut, grossProceedsUsd });
}

function finalizeExit(args: {
  tokensSold: number;
  transferTaxPct: number;
  solPriceUsd: number;
  referencePriceUsd: number;
  basisReleasedUsd: number;
  solOut: number;
  grossProceedsUsd: number;
}): ExitFill {
  const fees = fixedFeesSol();
  const priorityFeeUsd = fees.priorityFeeSol * args.solPriceUsd;
  const jitoTipUsd = fees.jitoTipSol * args.solPriceUsd;
  const feesUsd = priorityFeeUsd + jitoTipUsd;
  const transferTaxUsd = args.tokensSold * (args.transferTaxPct / 100) * args.referencePriceUsd;
  const netProceedsUsd = Math.max(0, args.grossProceedsUsd - feesUsd);
  const netFillPriceUsd = args.tokensSold > 0 ? netProceedsUsd / args.tokensSold : 0;
  const realizedPnlUsd = netProceedsUsd - args.basisReleasedUsd;
  return {
    tokensSold: args.tokensSold,
    solOut: args.solOut,
    grossProceedsUsd: args.grossProceedsUsd,
    transferTaxUsd,
    priorityFeeUsd,
    jitoTipUsd,
    feesUsd,
    netProceedsUsd,
    netFillPriceUsd,
    slippageRealizedPct: ((netFillPriceUsd - args.referencePriceUsd) / args.referencePriceUsd) * 100,
    basisReleasedUsd: args.basisReleasedUsd,
    realizedPnlUsd,
    realizedPnlPct: args.basisReleasedUsd > 0 ? (realizedPnlUsd / args.basisReleasedUsd) * 100 : 0,
    solPriceUsd: args.solPriceUsd,
  };
}
