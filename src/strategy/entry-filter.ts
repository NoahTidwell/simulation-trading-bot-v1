// Entry filter: liquidity, volume, buy:sell ratio, price structure, token age.
// Every check fails closed on missing data.

import { PRICE_STRUCTURE, PROFILE_V12 } from "../config";
import type { Band, MarketSnapshot, StrategyProfile, WatchedToken } from "../types";
import { getBandParams } from "./bands";

export interface EntryFilterResult {
  passed: boolean;
  reasons: string[];
}

export function evaluateEntryFilter(
  token: WatchedToken,
  snap: MarketSnapshot,
  band: Band,
  now: number,
  profile: StrategyProfile = PROFILE_V12,
): EntryFilterResult {
  const p = getBandParams(band, profile.bands);
  const reasons: string[] = [];

  // --- liquidity / volume ---
  if (snap.liquidityUsd === null) reasons.push("liquidity unknown");
  else if (snap.liquidityUsd < p.minLiquidityUsd) reasons.push(`liquidity ${snap.liquidityUsd.toFixed(0)} < ${p.minLiquidityUsd}`);

  if (snap.volume5mUsd === null) reasons.push("5m volume unknown");
  else if (snap.volume5mUsd < p.minVolume5mUsd) reasons.push(`5m volume ${snap.volume5mUsd.toFixed(0)} < ${p.minVolume5mUsd}`);

  // --- buy:sell ratio ---
  if (snap.buys5m === null || snap.sells5m === null) {
    reasons.push("5m tx counts unknown");
  } else {
    const total = snap.buys5m + snap.sells5m;
    if (total < PRICE_STRUCTURE.minTxCount5m) {
      reasons.push(`5m tx count ${total} < ${PRICE_STRUCTURE.minTxCount5m}`);
    } else {
      const ratio = snap.sells5m === 0 ? Number.POSITIVE_INFINITY : snap.buys5m / snap.sells5m;
      if (ratio < p.minBuySellRatio5m) reasons.push(`buy:sell ${ratio.toFixed(2)} < ${p.minBuySellRatio5m}`);
    }
  }

  // --- 5m price change window ---
  if (snap.priceChange5mPct === null) {
    reasons.push("5m price change unknown");
  } else if (snap.priceChange5mPct < PRICE_STRUCTURE.min5mChangePct) {
    reasons.push(`5m change ${snap.priceChange5mPct.toFixed(1)}% < +${PRICE_STRUCTURE.min5mChangePct}%`);
  } else if (snap.priceChange5mPct > PRICE_STRUCTURE.max5mChangePct) {
    reasons.push(`5m change ${snap.priceChange5mPct.toFixed(1)}% > +${PRICE_STRUCTURE.max5mChangePct}% (blow-off)`);
  }

  // --- not already extended on the hour ---
  // `== null` also covers snapshots persisted before this field existed.
  if (snap.priceChange1hPct == null) {
    reasons.push("1h price change unknown");
  } else if (snap.priceChange1hPct > PRICE_STRUCTURE.max1hChangePct) {
    reasons.push(`1h change ${snap.priceChange1hPct.toFixed(1)}% > +${PRICE_STRUCTURE.max1hChangePct}% (extended)`);
  }

  // --- activity accelerating: current 5m txs vs the token's own trailing average ---
  // Samples at least 5 min old, so the current window doesn't dilute its own
  // spike. The 30-min history requirement below guarantees these exist on any
  // token that could otherwise pass; missing baseline → reject (fail closed).
  if (snap.buys5m !== null && snap.sells5m !== null) {
    const current = snap.buys5m + snap.sells5m;
    const lookbackStart = now - (PRICE_STRUCTURE.txAccelLookbackMinutes + 5) * 60_000;
    const baseline = token.txHistory.filter((s) => s.t >= lookbackStart && s.t <= now - 5 * 60_000);
    if (baseline.length === 0) {
      reasons.push("tx acceleration: no baseline");
    } else {
      const avg = Math.max(1, baseline.reduce((a, s) => a + s.v, 0) / baseline.length);
      const accel = current / avg;
      if (accel < PRICE_STRUCTURE.minTxAcceleration) {
        reasons.push(`tx acceleration ${accel.toFixed(2)}x < ${PRICE_STRUCTURE.minTxAcceleration}x`);
      }
    }
  }

  // --- token age ---
  if (snap.pairCreatedAt === null) {
    reasons.push("pair age unknown");
  } else {
    const ageMin = (now - snap.pairCreatedAt) / 60_000;
    const minAge = profile.lab?.minTokenAgeMinutes || PRICE_STRUCTURE.minTokenAgeMinutes;
    if (ageMin < minAge) reasons.push(`age ${ageMin.toFixed(0)}m < ${minAge}m`);
  }

  // --- new local high vs trailing window ---
  // Coverage is measured from the oldest RETAINED sample (retention > lookback),
  // so a token watched for 30+ minutes qualifies. History is persisted across
  // restarts; a gap longer than maxPriceHistoryGapMinutes inside the window
  // (downtime, data outage) means the true high is unknown → fail closed.
  const lookbackStart = now - PRICE_STRUCTURE.localHighLookbackMinutes * 60_000;
  const all = token.priceHistory.filter((s) => s.t < snap.fetchedAt);
  const prior = all.filter((s) => s.t >= lookbackStart);
  if (all.length === 0 || prior.length === 0) {
    reasons.push("no price history");
  } else {
    const coveredMin = (now - all[0].t) / 60_000;
    if (coveredMin < PRICE_STRUCTURE.minPriceHistoryMinutes) {
      reasons.push(`price history ${coveredMin.toFixed(0)}m < ${PRICE_STRUCTURE.minPriceHistoryMinutes}m`);
    } else {
      const maxGapMs = PRICE_STRUCTURE.maxPriceHistoryGapMinutes * 60_000;
      let largestGapMs = prior[0].t - Math.max(lookbackStart, all[0].t);
      for (let i = 1; i < prior.length; i++) largestGapMs = Math.max(largestGapMs, prior[i].t - prior[i - 1].t);
      largestGapMs = Math.max(largestGapMs, snap.fetchedAt - prior[prior.length - 1].t);
      if (largestGapMs > maxGapMs) {
        reasons.push(`price history gap ${(largestGapMs / 60_000).toFixed(1)}m > ${PRICE_STRUCTURE.maxPriceHistoryGapMinutes}m`);
      } else {
        // v1.3 keeps the history/gap requirement (tx-acceleration needs the
        // baseline) but not the breakout itself.
        const priorHigh = Math.max(...prior.map((s) => s.v));
        if (profile.requireNewLocalHigh && !(snap.priceUsd > priorHigh)) reasons.push(`not a new ${PRICE_STRUCTURE.localHighLookbackMinutes}m high`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons };
}
