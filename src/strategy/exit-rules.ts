// Price-based exits: hard stop, no-follow-through, max hold time, trailing
// stop, scale-out rungs. Ejection triggers (ejection-triggers.ts) are checked
// BEFORE these and win.
//
// One action per position per cycle. Thresholds use the EFFECTIVE gain: the
// gain on the remaining tokens after estimated exit costs, measured against
// the net entry basis (entry slippage, tax and fees already included). So
// "+12%" means ≈ +12% realized on that slice, and a -12% stop realizes ≈ -12%
// plus whatever the price gaps during the fill delay.

import { EXIT, PROFILE_V12, SIM } from "../config";
import type { ExitReason, Position, StrategyProfile } from "../types";
import { getBandParams } from "./bands";

export type ExitDecision =
  | { type: "none" }
  | { type: "exit"; reason: ExitReason; detail: string }
  | { type: "scaleout"; reason: ExitReason; tierIndex: number; tokensToSell: number; detail: string };

/** Raw price gain vs the net entry basis (no exit costs). */
export function gainPct(position: Position, priceUsd: number): number {
  return ((priceUsd - position.entryNetPriceUsd) / position.entryNetPriceUsd) * 100;
}

/**
 * Estimated cost of selling the remaining tokens at `priceUsd`, as a % of
 * their value: fixed fees (at the SOL price implied at entry), transfer tax,
 * and an assumed market-sell price impact.
 */
export function estExitCostPct(position: Position, priceUsd: number): number {
  const value = position.tokensRemaining * priceUsd;
  const solPriceUsd = position.initialSizeSol > 0 ? position.initialSizeUsd / position.initialSizeSol : 0;
  const feesUsd = (SIM.priorityFeeSol + SIM.jitoTipSol) * solPriceUsd;
  const feePct = value > 0 ? (feesUsd / value) * 100 : 0;
  return feePct + position.transferTaxPct + EXIT.estExitSlippagePct;
}

/** Gain after estimated exit costs — what selling everything now would realize, per token. */
export function effectiveGainPct(position: Position, priceUsd: number): number {
  const netExit = priceUsd * (1 - estExitCostPct(position, priceUsd) / 100);
  return gainPct(position, netExit);
}

/** Price at which the effective gain equals `effGainPct` (inverse of effectiveGainPct, cost held at `atPriceUsd`). */
function priceForEffectiveGain(position: Position, effGainPct: number, atPriceUsd: number): number {
  const costFactor = 1 - estExitCostPct(position, atPriceUsd) / 100;
  return (position.entryNetPriceUsd * (1 + effGainPct / 100)) / costFactor;
}

/** Current trailing-stop level (market price), or null if not yet active. Exit params come from the position's book. */
export function trailingStopLevel(position: Position, profile: StrategyProfile = PROFILE_V12): number | null {
  const X = profile.exit;
  if (!position.trailingActive) return null;
  const peakEff = effectiveGainPct(position, position.highestPriceUsd);
  const distance = peakEff >= X.trailingTightenAtGainPct ? X.trailingDistanceTightPct : X.trailingDistancePct;
  const trail = position.highestPriceUsd * (1 - distance / 100);
  const floor = priceForEffectiveGain(position, X.trailingFloorAboveEntryPct, position.lastPriceUsd);
  return Math.max(trail, floor);
}

/**
 * Evaluate price-based rules. Updates `highestPriceUsd`, `lowestPriceUsd` and
 * `trailingActive` on the position as a side effect (they are rule state).
 */
export function evaluateExitRules(position: Position, priceUsd: number, now: number, profile: StrategyProfile = PROFILE_V12): ExitDecision {
  const band = getBandParams(position.band, profile.bands);
  const X = profile.exit;

  if (priceUsd > position.highestPriceUsd) position.highestPriceUsd = priceUsd;
  if (priceUsd < position.lowestPriceUsd) position.lowestPriceUsd = priceUsd;

  const gain = effectiveGainPct(position, priceUsd);
  const peak = effectiveGainPct(position, position.highestPriceUsd);
  const heldMin = (now - position.openedAt) / 60_000;

  // Hard stop-loss (effective, so it realizes close to the configured level).
  if (gain <= band.hardStopLossPct) {
    return { type: "exit", reason: "hardStop", detail: `${gain.toFixed(1)}% <= ${band.hardStopLossPct}% (after est. exit costs)` };
  }

  if (!position.trailingActive && gain >= X.trailingActivationGainPct) position.trailingActive = true;

  // Replay-lab early exit: a trade already down a set amount after a few minutes is sold before the hard stop.
  const L = profile.lab;
  if (L && L.earlyExitMinutes > 0 && !position.trailingActive && heldMin >= L.earlyExitMinutes && gain <= L.earlyExitLossPct) {
    return { type: "exit", reason: "earlyLoss", detail: `held ${heldMin.toFixed(0)}m, ${gain.toFixed(1)}% <= ${L.earlyExitLossPct}%` };
  }

  // Time limits: a trailing winner is only bound by the absolute cap; anything
  // else gets the band's limit, and a trade that never moved gets cut early.
  if (position.trailingActive) {
    if (heldMin >= X.maxHoldWhileTrailingMinutes) {
      return { type: "exit", reason: "maxHoldTime", detail: `held ${heldMin.toFixed(0)}m >= ${X.maxHoldWhileTrailingMinutes}m (trailing)` };
    }
  } else {
    if (heldMin >= band.maxHoldMinutes) {
      return { type: "exit", reason: "maxHoldTime", detail: `held ${heldMin.toFixed(0)}m >= ${band.maxHoldMinutes}m` };
    }
    if (heldMin >= band.noFollowThroughMinutes && peak < X.noFollowThroughMinPeakGainPct && gain <= 0) {
      return {
        type: "exit",
        reason: "noFollowThrough",
        detail: `held ${heldMin.toFixed(0)}m, best ${peak.toFixed(1)}% < +${X.noFollowThroughMinPeakGainPct}%, now ${gain.toFixed(1)}%`,
      };
    }
  }

  const stop = trailingStopLevel(position, profile);
  if (stop !== null && priceUsd <= stop) {
    return { type: "exit", reason: "trailingStop", detail: `price ${priceUsd} <= stop ${stop} (high ${position.highestPriceUsd}, peak ${peak.toFixed(1)}%)` };
  }

  // Scale-out rungs (fractions of the INITIAL position), next undone rung only.
  // No final cap: the remainder rides the trailing stop.
  const next = position.tiersDone;
  if (next < X.tiers.length && gain >= X.tiers[next].gainPct) {
    const rung = X.tiers[next];
    const tokens = Math.min(position.tokensRemaining, position.tokensInitial * rung.sellFraction);
    return { type: "scaleout", reason: `takeProfitTier${next + 1}`, tierIndex: next, tokensToSell: tokens, detail: `${gain.toFixed(1)}% >= +${rung.gainPct}%` };
  }

  return { type: "none" };
}
