// Standing ejection triggers, checked every cycle on every open position and
// evaluated BEFORE price targets:
//   1. transaction-velocity spike while price is going against us
//   2. stale / unresolvable price
//   3. mid-hold security re-flag (the API call lives in security-gate.ts; the
//      decision helper is here)

import { EJECTION, SECURITY } from "../config";
import type { Position, Sample, SecurityRecheckResult } from "../types";
import { effectiveGainPct } from "./exit-rules";

export interface VelocityCheck {
  triggered: boolean;
  current: number | null;
  baseline: number | null;
  detail: string;
}

/** Push a sample and trim anything older than `retentionMs`. */
export function pushSample(history: Sample[], t: number, v: number, retentionMs: number): void {
  history.push({ t, v });
  const cutoff = t - retentionMs;
  let drop = 0;
  while (drop < history.length && history[drop].t < cutoff) drop++;
  if (drop > 0) history.splice(0, drop);
}

/**
 * 5-minute buy+sell tx count vs the token's own trailing 20-minute average.
 * Baseline samples are those older than 5 minutes (so the current 5m window
 * doesn't dampen its own spike) and within the lookback. Needs enough history
 * to be meaningful — otherwise it does not fire (there is nothing to compare
 * against; this is not an "allow" default, it's the absence of a signal).
 */
export function checkVelocitySpike(position: Position, now: number): VelocityCheck {
  const h = position.txHistory;
  if (h.length === 0) return { triggered: false, current: null, baseline: null, detail: "no tx history" };
  const current = h[h.length - 1].v;
  const lookbackStart = now - (EJECTION.velocityLookbackMinutes + 5) * 60_000;
  const baselineSamples = h.filter((s) => s.t >= lookbackStart && s.t <= now - 5 * 60_000);
  if (baselineSamples.length === 0) return { triggered: false, current, baseline: null, detail: "no baseline yet" };
  const spanMin = (now - baselineSamples[0].t) / 60_000;
  if (spanMin < EJECTION.velocityMinHistoryMinutes) {
    return { triggered: false, current, baseline: null, detail: `baseline span ${spanMin.toFixed(0)}m < ${EJECTION.velocityMinHistoryMinutes}m` };
  }
  const avg = baselineSamples.reduce((a, s) => a + s.v, 0) / baselineSamples.length;
  // The breakout that triggered the entry is itself a tx burst; the baseline is
  // floored at the entry-time count so the trigger detects a further
  // acceleration (frenzy / dump), not the breakout we deliberately bought.
  const baseline = Math.max(avg, EJECTION.velocityMinBaselineTx, position.entryTxCount5m);
  const spike = current > EJECTION.velocityMultiplier * baseline;
  // Direction matters: a spike while price holds up is the frenzy we bought
  // for (the trailing stop manages it); a spike while price falls is a dump.
  const gain = effectiveGainPct(position, position.lastPriceUsd);
  const high = Math.max(position.highestPriceUsd, position.lastPriceUsd);
  const offHighPct = ((high - position.lastPriceUsd) / high) * 100;
  const adverse = gain < 0 || offHighPct >= EJECTION.velocityEjectBelowHighPct;
  return {
    triggered: spike && adverse,
    current,
    baseline,
    detail:
      `5m txs ${current} vs ${EJECTION.velocityMultiplier}x baseline ${baseline.toFixed(1)} (trailing avg ${avg.toFixed(1)}, at entry ${position.entryTxCount5m})` +
      ` | gain ${gain.toFixed(1)}%, ${offHighPct.toFixed(1)}% off high`,
  };
}

/** True when the live price has been unresolvable for longer than allowed. */
export function isPriceStale(position: Position, now: number): boolean {
  return now - position.lastResolvedAt > EJECTION.stalePriceMaxSeconds * 1000;
}

export type SecurityEjectDecision = { eject: false } | { eject: true; detail: string };

/**
 * Apply a periodic security re-check result. Danger flags eject immediately.
 * Repeated API failures also eject (fail closed) after the configured count —
 * we never "assume unchanged".
 */
export function applySecurityRecheck(position: Position, result: SecurityRecheckResult): SecurityEjectDecision {
  if (result.status === "danger") {
    position.securityRecheckFailures = 0;
    return { eject: true, detail: `danger flags: ${result.flags.join(", ")}` };
  }
  if (result.status === "error") {
    position.securityRecheckFailures += 1;
    if (position.securityRecheckFailures >= SECURITY.recheckMaxConsecutiveFailures) {
      return { eject: true, detail: `security unresolvable ${position.securityRecheckFailures}x (${result.error ?? "error"})` };
    }
    return { eject: false };
  }
  position.securityRecheckFailures = 0;
  return { eject: false };
}
