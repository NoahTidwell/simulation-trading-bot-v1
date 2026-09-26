// THE single code path for per-trade sizing, concurrency cap, and total
// exposure cap. Nothing else in the codebase decides how big a position is
// or whether another one may be opened.

import { SIZING } from "../config";

export interface SizingInputs {
  /** cash + cost basis of open positions */
  bankrollUsd: number;
  cashUsd: number;
  openPositionCount: number;
  /** sum of remaining cost basis across open positions */
  totalExposureUsd: number;
}

export type SizingResult = { ok: true; sizeUsd: number } | { ok: false; reason: string };

export function sizeNewPosition(input: SizingInputs): SizingResult {
  if (input.openPositionCount >= SIZING.maxConcurrentPositions) {
    return { ok: false, reason: `concurrency cap: ${input.openPositionCount}/${SIZING.maxConcurrentPositions} open` };
  }
  if (!(input.bankrollUsd > 0)) return { ok: false, reason: "bankroll is zero" };

  const sizeUsd = roundUsd(input.bankrollUsd * (SIZING.perTradePctOfBankroll / 100));
  if (sizeUsd <= 0) return { ok: false, reason: "computed size is zero" };

  const maxExposureUsd = input.bankrollUsd * (SIZING.maxTotalExposurePct / 100);
  if (input.totalExposureUsd + sizeUsd > maxExposureUsd) {
    return {
      ok: false,
      reason: `exposure cap: ${(input.totalExposureUsd + sizeUsd).toFixed(2)} > ${maxExposureUsd.toFixed(2)} (${SIZING.maxTotalExposurePct}% of bankroll)`,
    };
  }
  if (sizeUsd > input.cashUsd) {
    return { ok: false, reason: `insufficient simulated cash: need ${sizeUsd.toFixed(2)}, have ${input.cashUsd.toFixed(2)}` };
  }
  return { ok: true, sizeUsd };
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}
