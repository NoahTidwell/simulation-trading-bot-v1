// Single source of truth for EVERY strategy constant, endpoint, and path.
// Nothing strategy-related is hardcoded anywhere else in src/.
//
// SIMULATION ONLY. There is no wallet, key, or live-mode code path in v1.

import path from "node:path";
import dotenv from "dotenv";
import type { Band, BandParams, ExitParams, StrategyProfile } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

function envList(name: string): string[] {
  return envStr(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/** Hardcoded. There is no live mode in this project. */
export const SIMULATION_MODE = true as const;

/** Strategy revision of this bot (v1.x — "v2" is a separate bot). Shown on the dashboard. */
export const STRATEGY_VERSION = "1.2";

export const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Bankroll & sizing (simulated)
// ---------------------------------------------------------------------------

export const STARTING_BANKROLL_USD = envNum("STARTING_BANKROLL_USD", 500);

export const SIZING = {
  /**
   * Per-trade size as % of current simulated bankroll, recalculated each trade.
   * 4 → 6 on 2026-09-23 (strategy v1.2): the hard stop tightened from ~-20%
   * realized to ~-12..-14%, so risk per trade stays ≈0.8% of bankroll, while
   * the fixed per-trade fees (~$0.34 round trip) drop from ~1.9% to ~1.3% of
   * the position.
   */
  perTradePctOfBankroll: 6,
  maxConcurrentPositions: 7,
  /** Max total open exposure (at cost) as % of current bankroll. */
  maxTotalExposurePct: 60,
} as const;

// ---------------------------------------------------------------------------
// Market-cap bands
// ---------------------------------------------------------------------------

/*
 * Strategy v1.2 (2026-09-23), after 55 v1 trades (-$103.82, 1 of 55 ever reached
 * +10% net): enter earlier in the move, cut losers faster and cheaper, and let
 * winners run instead of capping them at +30%.
 *
 * Band changes: volume floors and buy:sell ratios lowered (58 of 72 in-band
 * tokens failed the 5m volume floor; by the time a token clears the old floors
 * the burst is mostly over). The new tx-acceleration check (PRICE_STRUCTURE)
 * replaces some of that selectivity with an "activity is ramping NOW" signal.
 * Hard stops are measured net of estimated EXIT costs (see EXIT.estExitSlippagePct),
 * so -12% realizes ≈ -12..-14% instead of v1's -15% setting realizing -19.8%.
 */
export const BAND_PARAMS: Record<Band, BandParams> = {
  A: {
    marketCapMinUsd: 10_000_000,
    marketCapMaxUsd: 50_000_000,
    minLiquidityUsd: 60_000,
    minVolume5mUsd: 8_000,
    minBuySellRatio5m: 1.6,
    hardStopLossPct: -12,
    maxHoldMinutes: 45,
    noFollowThroughMinutes: 12,
  },
  B: {
    marketCapMinUsd: 50_000_000,
    marketCapMaxUsd: 100_000_000,
    minLiquidityUsd: 150_000,
    minVolume5mUsd: 20_000,
    minBuySellRatio5m: 1.5,
    hardStopLossPct: -14,
    maxHoldMinutes: 90,
    noFollowThroughMinutes: 20,
  },
};

/**
 * Watch-only range (added 2026-09-25): tokens from this market cap up to band
 * A's floor are refreshed, recorded and kept on the watchlist like in-band
 * tokens, but never traded by v1.2 (v1.3 trades from $1M). Band A ($10M+) had only ~2 actively traded tokens
 * at a time; this collects real data on the $2–10M range so a lower band can be
 * judged in scripts/replay.ts (--set BAND_PARAMS.A.marketCapMinUsd=2000000)
 * before it goes live. 0 disables.
 */
export const WATCH_ONLY_MIN_MARKET_CAP_USD = envNum("WATCH_ONLY_MIN_MARKET_CAP_USD", 100_000);


// ---------------------------------------------------------------------------
// Entry filter — price structure (both bands)
// ---------------------------------------------------------------------------

export const PRICE_STRUCTURE = {
  /** Current price must exceed the max price seen in this trailing window. */
  localHighLookbackMinutes: 30,
  /** Require at least this much observed history before the local-high check can pass (fail closed). */
  minPriceHistoryMinutes: 30,
  /**
   * If the bot was down (or the data source failed) for longer than this inside
   * the lookback window, we can't know the true 30-min high → no entry until
   * the gap ages out of the window.
   */
  maxPriceHistoryGapMinutes: 3,
  /**
   * 5m change window. v1 was +5..+40%: the bot bought after most of the burst
   * and anything near +40% was a blow-off top. v1.2 enters at the START of the
   * move (+3%) and refuses to chase (> +20%).
   */
  min5mChangePct: 3,
  max5mChangePct: 20,
  /** Don't buy a token that is already extended on the hour (fail closed when unknown). */
  max1hChangePct: 60,
  minTokenAgeMinutes: 30,
  /** Guard for the buy:sell ratio — need at least this many 5m txs for the ratio to mean anything. */
  minTxCount5m: 10,
  /**
   * Early-momentum signal: the current 5m tx count must be at least this
   * multiple of the token's own trailing average (samples older than 5 min,
   * within txAccelLookbackMinutes). Activity ramping up is what precedes the
   * price move; a token grinding at its usual pace is not breaking out.
   */
  minTxAcceleration: 1.5,
  txAccelLookbackMinutes: 20,
} as const;

// ---------------------------------------------------------------------------
// Security gate (all must pass, both bands)
// ---------------------------------------------------------------------------

export const SECURITY = {
  /** RugCheck raw score must be strictly below this. */
  maxRugcheckScore: 500,
  /** Top-10 non-LP holders combined must be strictly below this % of supply. */
  maxTop10HolderPct: 25,
  /** "LP locked or burned": RugCheck lpLockedPct on the best market must be >= this. */
  minLpLockedPct: 90,
  /**
   * Original spec: transfer tax must be fixed and not owner-mutable. Relaxed
   * (false) on 2026-09-20 to widen the sample — it was rejecting the large
   * majority of momentum signals. Restored (true) on 2026-09-21: the tokens
   * the relaxation let through were the worst cohort in the first 46 trades
   * (25 exits, 1 win, -$60.76 vs 21 exits, 7 wins, -$42.53 untaxed). The
   * CURRENT tax is still read on-chain and charged on every simulated fill.
   */
  requireImmutableTransferFee: true,
  /**
   * Never enter a token whose current on-chain transfer tax exceeds this.
   * 10 → 0 on 2026-09-23: taxed tokens went 1 win in 26 trades (-$62.25) in
   * v1. A 1–3% tax each way is most of a scalp's edge; untaxed only.
   */
  maxTransferTaxPct: 0,
  /** Periodic re-check cadence on open positions. */
  recheckIntervalMs: 120_000,
  /** Consecutive failed re-checks (API error) before treating the position as unsafe and exiting. */
  recheckMaxConsecutiveFailures: 3,
} as const;

// ---------------------------------------------------------------------------
// Exit rules (both bands unless per-band above)
// ---------------------------------------------------------------------------

/*
 * All exit thresholds are measured as "effective gain": the gain on the
 * remaining tokens AFTER estimated exit costs (fixed fees at entry-time SOL
 * price + transfer tax + estExitSlippagePct). v1 compared raw market price to
 * the net entry basis, so the +5% trailing floor realized -1.2% (INU) and the
 * -15% hard stop realized -19.8% on average.
 */
export const EXIT = {
  /**
   * Scale-out rungs, ascending; `sellFraction` is a fraction of the INITIAL
   * position, one rung per cycle. There is NO final cap any more: whatever
   * remains after the last rung rides the trailing stop.
   *
   * v1 (2026-09-21) sold 25% at +10/+15/+25 and everything at +30%, so even a
   * perfect trade averaged ~+20% while stops realized ~-20%: break-even needed
   * a ~76% win rate. v1.2 banks a third early (pays for the trade, arms the
   * breakeven trail), a third into strength, and lets the last third run.
   */
  tiers: [
    { gainPct: 12, sellFraction: 1 / 3 },
    { gainPct: 35, sellFraction: 1 / 3 },
  ],
  /** Trailing stop arms together with the first rung. */
  trailingActivationGainPct: 12,
  /** Trails this % below the highest price seen since entry ... */
  trailingDistancePct: 15,
  /** ... tightening to this once the effective gain has reached tightenAtGainPct. */
  trailingDistanceTightPct: 10,
  trailingTightenAtGainPct: 50,
  /** Once active, the stop never sits below entry + this % (effective, i.e. after exit costs). */
  trailingFloorAboveEntryPct: 2,
  /** Price impact assumed on a market sell when estimating exit costs. */
  estExitSlippagePct: 1,
  /**
   * While the trailing stop is active the band's maxHoldMinutes no longer
   * applies (a winner is not cut for being slow); this absolute cap does.
   */
  maxHoldWhileTrailingMinutes: 240,
  /**
   * No follow-through: after the band's noFollowThroughMinutes, a position
   * whose best effective gain never reached this and which is at or below
   * breakeven now is closed. In v1, 65% of trades drifted to the time limit.
   */
  noFollowThroughMinPeakGainPct: 4,
} as const;

/**
 * Strategy books. v1.2 is the main book (data/). v1.3 (added 2026-09-25) is a
 * parallel paper strategy aimed at ~50 trades/day, run side by side on the same
 * market data so the two can be compared directly (data/v1.3/). Recordings
 * showed v1.2's rules produce ~6 pre-gate signals/day; v1.3's loosened entry
 * produced ~70/day across $1M–100M:
 *   - band A floor $10M → $1M (liquidity floor unchanged)
 *   - 5m volume floor × 0.6 (A $8k → $4.8k, B $20k → $12k)
 *   - buy:sell ≥ 1.2 in both bands (A 1.6, B 1.5)
 *   - no "new 30-minute high" requirement
 * Exit rules, sizing, risk limits and the security gate are identical.
 */
export const PROFILE_V12: StrategyProfile = {
  id: "v1.2",
  version: STRATEGY_VERSION,
  description: "Original book: $10M–100M coins, requires a new 30-minute high (retired 2026-09-27)",
  bands: BAND_PARAMS, // the live object, so scripts/replay.ts overrides apply
  requireNewLocalHigh: true,
  exit: EXIT, // the live object, so replay overrides apply
  startingBankrollUsd: STARTING_BANKROLL_USD,
  dataSubdir: null,
};

export const PROFILE_V13: StrategyProfile = {
  id: "v1.3",
  version: "1.3",
  description: "v1.2 with looser entry rules on $1M–100M coins (retired 2026-09-28)",
  bands: {
    A: { ...BAND_PARAMS.A, marketCapMinUsd: 1_000_000, minVolume5mUsd: BAND_PARAMS.A.minVolume5mUsd * 0.6, minBuySellRatio5m: 1.2 },
    B: { ...BAND_PARAMS.B, minVolume5mUsd: BAND_PARAMS.B.minVolume5mUsd * 0.6, minBuySellRatio5m: 1.2 },
  },
  requireNewLocalHigh: false,
  exit: EXIT,
  startingBankrollUsd: envNum("V13_STARTING_BANKROLL_USD", 500),
  dataSubdir: "v1.3",
};

/** Books the bot runs. V13_ENABLED=off runs v1.2 alone. */
/**
 * v1.4 "micro" (added 2026-09-26): sub-$1M coins, on the bet that they are
 * volatile enough that a few very large winners outweigh more frequent losers.
 * v1.3's entry logic on a $100k–$1M band, a $15k liquidity floor (sub-$1M pools
 * are thin), and exits sized for 30%+ swings: -25% hard stop, sell a quarter at
 * +40% and at +150%, a 30% trail that tightens to 20% past +150%, runners held
 * up to 4 h. Band B is disabled (an empty range).
 * Caveat: the simulation always gets an exit fill (at worst a 10% penalty);
 * real honeypots / pulled liquidity would be -100%, so its losses are understated.
 */
const V14_EXIT: ExitParams = {
  ...EXIT,
  tiers: [
    { gainPct: 40, sellFraction: 0.25 },
    { gainPct: 150, sellFraction: 0.25 },
  ],
  trailingActivationGainPct: 40,
  trailingDistancePct: 30,
  trailingDistanceTightPct: 20,
  trailingTightenAtGainPct: 150,
  trailingFloorAboveEntryPct: 5,
  maxHoldWhileTrailingMinutes: 240,
  noFollowThroughMinPeakGainPct: 8,
};

export const PROFILE_V14: StrategyProfile = {
  id: "v1.4",
  version: "1.4",
  description: "Micro caps ($100k–$1M) with wide stops and long-running winners",
  bands: {
    A: {
      ...BAND_PARAMS.A,
      marketCapMinUsd: 100_000,
      marketCapMaxUsd: 1_000_000,
      minLiquidityUsd: 15_000,
      minVolume5mUsd: 3_000,
      minBuySellRatio5m: 1.2,
      hardStopLossPct: -25,
    },
    B: { ...BAND_PARAMS.B, marketCapMinUsd: Infinity, marketCapMaxUsd: Infinity },
  },
  requireNewLocalHigh: false,
  exit: V14_EXIT,
  startingBankrollUsd: envNum("V14_STARTING_BANKROLL_USD", 500),
  dataSubdir: "v1.4",
  // All off: v1.4 trades exactly as before. scripts/replay.ts --book v1.4 switches these on per variant.
  lab: { confirmSeconds: 0, confirmMaxDropPct: 3, earlyExitMinutes: 0, earlyExitLossPct: -10, maxEntriesPerTokenPerDay: 0, minTokenAgeMinutes: 0 },
};

/**
 * v1.5 (added 2026-09-27): v1.4's market band, filters and exits, plus the three
 * rules that won the replay lab (46 h of recordings, 13 variants: +$80.15 vs the
 * v1.4 baseline's +$4.98, max drawdown −5.5% vs −21.4%, 1 hard stop vs 17):
 *   - wait 2 minutes after a signal; buy only if the token still qualifies and
 *     its price has not dipped more than 3% below the signal price
 *   - sell early when a trade is down 10% or more after 5 minutes (before the −25% stop)
 *   - at most 2 entries per token in any rolling 24 h
 */
export const PROFILE_V15: StrategyProfile = {
  ...PROFILE_V14,
  id: "v1.5",
  version: "1.5",
  description: "v1.4 + 2-minute confirm wait, early exit at −10% after 5 min, max 2 trades per coin per day",
  exit: { ...V14_EXIT },
  startingBankrollUsd: envNum("V15_STARTING_BANKROLL_USD", 500),
  dataSubdir: "v1.5",
  lab: { confirmSeconds: 120, confirmMaxDropPct: 3, earlyExitMinutes: 5, earlyExitLossPct: -10, maxEntriesPerTokenPerDay: 2, minTokenAgeMinutes: 0 },
};

/**
 * v1.6 (added 2026-09-28): v1.5 plus a 2-hour minimum pair age. All three rug
 * pulls so far (Pokémon, XDP, Mewania) were pump.fun coins 65–94 minutes old
 * that had already risen 8–14× in their first hour; across 120 live v1.4/v1.5
 * trades, coins under 2 h old went 2 wins in 13 (−$71, 10 hard stops). Replay
 * over 64 h (rug exits priced from sell quotes, 1% slippage): +$13.64 vs v1.5's
 * −$16.72, max drawdown −10.1% vs −15.1%, no rugs; it blocked only XDP,
 * Mewania and swordcat. (A 24 h minimum was close, +$12.28, but halves trades.)
 */
export const PROFILE_V16: StrategyProfile = {
  ...PROFILE_V15,
  id: "v1.6",
  version: "1.6",
  description: "v1.5 + 2-hour minimum coin age (skips freshly launched pump.fun coins)",
  exit: { ...V14_EXIT },
  startingBankrollUsd: envNum("V16_STARTING_BANKROLL_USD", 500),
  dataSubdir: "v1.6",
  lab: { ...(PROFILE_V15.lab as NonNullable<StrategyProfile["lab"]>), minTokenAgeMinutes: 120 },
};

/** Every book ever defined, oldest first (the replay can run any of them). */
export const ALL_PROFILES: StrategyProfile[] = [PROFILE_V12, PROFILE_V13, PROFILE_V14, PROFILE_V15, PROFILE_V16];

/**
 * Books the bot runs. This list is the single source of truth: at startup the bot writes it to
 * data/books.json, which the dashboards, report cards and alerts read. Retired books stay on
 * disk and can be revived with their env switch: v1.2 (retired 2026-09-27) with V12_ENABLED=on,
 * v1.3 (retired 2026-09-28: lost ~$19/day, and its $1M–100M coins are still recorded for replay)
 * with V13_ENABLED=on. V14_ENABLED / V15_ENABLED / V16_ENABLED=off drop those books.
 */
export const PROFILES: StrategyProfile[] = [
  ...(envStr("V12_ENABLED", "off") === "on" ? [PROFILE_V12] : []),
  ...(envStr("V13_ENABLED", "off") === "on" ? [PROFILE_V13] : []),
  ...(envStr("V14_ENABLED", "on") === "off" ? [] : [PROFILE_V14]),
  ...(envStr("V15_ENABLED", "on") === "off" ? [] : [PROFILE_V15]),
  ...(envStr("V16_ENABLED", "on") === "off" ? [] : [PROFILE_V16]),
];


// ---------------------------------------------------------------------------
// Standing ejection triggers (override price targets)
// ---------------------------------------------------------------------------

export const EJECTION = {
  /** 5m buy+sell tx count > this × the token's own trailing average. */
  velocityMultiplier: 5,
  velocityLookbackMinutes: 20,
  /** Need at least this much tx history before the velocity trigger can fire. */
  velocityMinHistoryMinutes: 10,
  /** Baseline floor so a near-zero average doesn't trigger on trivial counts. */
  velocityMinBaselineTx: 5,
  /**
   * v1.2: a tx spike only ejects when price is going the wrong way — effective
   * gain below zero, or price this far under the high since entry. A spike on
   * a rising price is the buying frenzy the strategy is looking for; the
   * trailing stop manages it. (v1 ejected on any spike: 6 trades, 2 wins.)
   */
  velocityEjectBelowHighPct: 8,
  stalePriceMaxSeconds: 60,
} as const;

// ---------------------------------------------------------------------------
// Risk manager (reporting + simulated entry halts)
// ---------------------------------------------------------------------------

export const RISK = {
  /** Realized loss for the (UTC) day vs. that day's starting bankroll. */
  dailyLossLimitPct: -15,
  /** Equity vs. the total simulated tranche (starting bankroll). Manual reset only. */
  drawdownCircuitBreakerPct: -30,
  /** Reporting only — no live capital exists to gate. */
  trancheGates: [
    { name: "Gate 1 (proof of edge)", minClosedTrades: 30, minWinRatePct: 45, minNetPnlPct: 10, maxDrawdownPct: 20 },
    { name: "Gate 2 (consistency)", minClosedTrades: 100, minWinRatePct: 50, minNetPnlPct: 25, maxDrawdownPct: 20 },
  ],
} as const;

// ---------------------------------------------------------------------------
// Simulation mechanics
// ---------------------------------------------------------------------------

export const SIM = {
  executionDelayMinMs: 2_000,
  executionDelayMaxMs: 4_000,
  priorityFeeSol: envNum("PRIORITY_FEE_SOL", 0.001),
  jitoTipSol: envNum("JITO_TIP_SOL", 0.0005),
  /** Slippage tolerance passed to Jupiter /quote (the quote itself reports real price impact). */
  quoteSlippageBps: 300,
  /**
   * If the exit quote is unavailable we still exit (we never hold on unresolvable data).
   * The fallback fill is priced at last resolvable price minus this penalty.
   */
  exitQuoteFailureSlippagePct: 10,
  /** A cached SOL/USD price younger than this is reused for sizing / fee conversion instead of re-fetching. */
  solPriceMaxAgeMs: 60_000,
  /**
   * Entry fill sanity check: if the Jupiter fill price deviates from the
   * DexScreener reference by more than this, the two data sources disagree
   * (stale reference, liquidity pulled mid-signal) → abort the entry.
   */
  maxEntryFillDeviationPct: 10,
} as const;

// ---------------------------------------------------------------------------
// Re-entry cooldowns (per token, after an exit)
// ---------------------------------------------------------------------------

export const REENTRY = {
  /**
   * After any exit, don't re-enter the same token for this long. Doubled from
   * 60 on 2026-09-21: PAID (8 trades) and RAYCAT (5) were re-bought within the
   * hour repeatedly for a combined -$27.50.
   */
  afterAnyExitMinutes: 120,
  /**
   * After these exit reasons, the token is blocked for badExitBlockHours.
   * Was "until the end of the UTC day" until 2026-09-27: UTC midnight is 7 PM
   * Central, so a hard stop at 4:59 PM expired two hours later and v1.4
   * re-bought VAULT at 8:48 PM for a second −27.5%. Now a rolling window.
   */
  excludeForDayReasons: ["hardStop", "velocityEjection", "securityReflag", "stalePrice"] as const,
  badExitBlockHours: 24,
  /**
   * Repeat losers: a token with this many losing trades inside the window is
   * blocked for blockHours. PAID was traded 10 times in v1 for -$13.43 — a
   * token that keeps signalling and fading is ranging, not breaking out.
   */
  repeatLoser: { maxLosses: 2, windowHours: 72, blockHours: 72 },
} as const;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const RUNTIME = {
  /** 8 s → 5 s on 2026-09-23: react to breakouts (and stops) sooner. ~35 DexScreener calls/min, limit ~300. */
  scanIntervalMs: 5_000,
  /**
   * Fast exit monitor (added 2026-09-24). Open positions are re-priced from a
   * live Jupiter sell quote for the remaining size on their own loop, instead
   * of only once per scan cycle from the Price API. The Price API is cached
   * (measured 5–10 s behind /quote), so with the 5 s cycle a stop could act on
   * a price ~15 s old — fomopay's trailing stop fired only after the price was
   * already 19% off the high. The scan cycle's check remains as the backstop.
   */
  positionMonitorIntervalMs: 1_000,
  /**
   * Jupiter /quote budget for the monitor. The keyless lite-api tier allows
   * ~60 req/min shared with entry/exit quotes; with N open positions each is
   * re-quoted every max(1 s, N × 60 / budget s). Raise with a JUPITER_API_KEY.
   */
  positionMonitorQuotesPerMinute: envNum("POSITION_MONITOR_QUOTES_PER_MIN", 45),
  /** Pause the monitor this long after Jupiter rate-limits it (the scan cycle keeps checking). */
  positionMonitorBackoffMs: 15_000,
  /**
   * Helius Enhanced Transactions calls cost ~100 credits each, one per
   * discovery program per poll. Entries need 30 min of observed history
   * anyway, so polling faster than every few minutes buys nothing.
   * 15 min × 3 programs ≈ 29k credits/day — fits the 1M/month free tier.
   */
  discoveryIntervalMs: envNum("DISCOVERY_INTERVAL_MS", 900_000),
  /** 250 → 350 on 2026-09-25 (watch-only range), → 450 on 2026-09-26 (v1.4 micro caps). */
  watchlistMaxSize: 450,
  /** Evict watched tokens not re-seen in discovery and not in a band for this long. */
  watchlistMaxIdleMinutes: 180,
  /** Evict watched tokens that never resolve any market data within this window. */
  watchlistUnresolvedEvictMinutes: 30,
  /** Cap on expensive security-gate runs per cycle (RugCheck + GoPlus + RPC). */
  maxSecurityGatesPerCycle: 3,
  gateFailCooldownMinutes: 15,
  entryFailCooldownMinutes: 3,
  apiTimeoutMs: 10_000,
  /**
   * DexScreener /tokens returns at most ~30 pairs per request (a token's pairs
   * as base AND as quote all count), so batches are packed by pair footprint,
   * not just address count.
   */
  dexscreener: {
    addressCap: 30,
    pairCap: 30,
    unknownPairEstimate: 3,
    /** Re-pick a token's most liquid pair (via /tokens) this often; otherwise refresh it via /pairs. */
    pairReresolveMinutes: 60,
    /** Batches in flight at once (DexScreener allows ~300 req/min on these endpoints). */
    maxConcurrentRequests: 4,
  },
  jupiterPriceBatchSize: 50,
  heliusTxLimit: 50,
  /**
   * Second discovery source (added 2026-09-25): GeckoTerminal's Solana pools
   * ranked by 24h volume and by 24h trade count, plus newly created pools —
   * activity rankings, not paid promotion. Helius program polling samples
   * whatever swapped in the last few seconds and missed most active $2–10M
   * tokens. 3 keyless calls per poll; GeckoTerminal enforces ~10 calls/min.
   */
  activePoolDiscoveryIntervalMs: envNum("ACTIVE_POOL_DISCOVERY_INTERVAL_MS", 300_000),
  activePoolDiscoveryCallSpacingMs: 3_000,
  /** After a GeckoTerminal 429, the next poll waits this many intervals instead of one. */
  activePoolDiscoveryBackoffIntervals: 2,
  priceHistoryRetentionMinutes: 40,
  txHistoryRetentionMinutes: 30,
  /** One equity-curve sample per this interval (data/trades/equity.jsonl). */
  equitySampleIntervalMs: 60_000,
  /**
   * Tiered market-data refresh. Every tier's interval stays well inside
   * PRICE_STRUCTURE.maxPriceHistoryGapMinutes, so history stays valid for the
   * local-high check regardless of tier; only the reaction latency differs.
   *   hot  = in band AND close to the entry thresholds → every cycle
   *   warm = in band, far from thresholds             → every 3rd cycle
   *   cold = out of band / not yet resolved            → every 8th cycle
   */
  refresh: {
    warmIntervalMs: 15_000,
    coldIntervalMs: 60_000,
    /** "close to thresholds": 5m volume ≥ this fraction of the band minimum ... */
    hotVolumeFraction: 0.5,
    /** ... OR |5m price change| ≥ this % (below the +3% entry floor, so a token is hot before it qualifies) */
    hotPriceChangePct: 1.5,
  },
  /** State-file write throttles (trade events always persist immediately). */
  watchlistSaveIntervalMs: 90_000,
  /** 60 s → 5 s on 2026-09-26: the dashboard's positions table read prices up to a minute older than the summary. */
  portfolioSaveIntervalMs: 5_000,
  logLevel: envStr("LOG_LEVEL", "info") as "debug" | "info" | "warn",
} as const;

// ---------------------------------------------------------------------------
// Keys & endpoints (read-only data APIs only)
// ---------------------------------------------------------------------------

export const KEYS = {
  helius: envStr("HELIUS_API_KEY", ""),
  rugcheck: envStr("RUGCHECK_API_KEY", ""),
  goplus: envStr("GOPLUS_ACCESS_TOKEN", ""),
  jupiter: envStr("JUPITER_API_KEY", ""),
} as const;

const jupiterDefaultBase = KEYS.jupiter ? "https://api.jup.ag" : "https://lite-api.jup.ag";

export const ENDPOINTS = {
  heliusApiBase: "https://api.helius.xyz",
  geckoTerminalBase: "https://api.geckoterminal.com/api/v2",
  heliusRpc: KEYS.helius ? `https://mainnet.helius-rpc.com/?api-key=${KEYS.helius}` : "",
  solanaRpc: envStr(
    "SOLANA_RPC_URL",
    KEYS.helius ? `https://mainnet.helius-rpc.com/?api-key=${KEYS.helius}` : "https://api.mainnet-beta.solana.com",
  ),
  dexscreenerBase: "https://api.dexscreener.com",
  jupiterBase: envStr("JUPITER_API_BASE", jupiterDefaultBase),
  jupiterQuotePath: "/swap/v1/quote",
  jupiterPricePath: "/price/v3",
  rugcheckBase: "https://api.rugcheck.xyz/v1",
  goplusBase: "https://api.gopluslabs.io/api/v1",
} as const;

// ---------------------------------------------------------------------------
// Solana constants
// ---------------------------------------------------------------------------

export const SOLANA = {
  wsolMint: "So11111111111111111111111111111111111111112",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdtMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022Program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  /**
   * Programs polled for candidate discovery (recent activity = new pools + organic volume).
   * The pump.fun bonding-curve program is deliberately omitted: tokens still on
   * the curve are far below the $1M band floor, and graduated ones show up on
   * PumpSwap / Raydium anyway — polling it only spent Helius credits.
   */
  discoveryPrograms: [
    { label: "raydium-amm-v4", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
    { label: "raydium-cpmm", address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" },
    { label: "pumpswap-amm", address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  ],
  /** Owners of pool vaults — excluded from the "non-LP holder" concentration check. */
  knownAmmAuthorities: [
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
    "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM authority
    "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", // pump.fun AMM global authority
  ],
  /** Mints ignored during discovery (quote assets). */
  ignoredMints: [
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ],
} as const;

export const WATCHLIST_SEED_MINTS = envList("WATCHLIST_MINTS");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DATA_DIR = path.join(PROJECT_ROOT, "data");
const dataDir = DATA_DIR;
export const PATHS = {
  dataDir,
  tradesDir: path.join(dataDir, "trades"),
  positionsDir: path.join(dataDir, "positions"),
  openPositionsFile: path.join(dataDir, "positions", "open-positions.json"),
  riskStateFile: path.join(dataDir, "positions", "risk-state.json"),
  watchlistFile: path.join(dataDir, "positions", "watchlist.json"),
  summaryFile: path.join(dataDir, "trades", "summary.json"),
  equityFile: path.join(dataDir, "trades", "equity.jsonl"),
  eventTailFile: path.join(dataDir, "positions", "event-tail.json"),
  /** Market recordings for offline replay (scripts/replay.ts): one gzip JSONL file per UTC day. */
  recordingsDir: path.join(dataDir, "recordings"),
} as const;

/** A book's own state and output files (v1.2 = the main tree; others under data/<subdir>/). */
export interface BookPaths {
  tradesDir: string;
  positionsDir: string;
  openPositionsFile: string;
  riskStateFile: string;
  summaryFile: string;
  equityFile: string;
  eventTailFile: string;
}

export function bookPaths(profile: StrategyProfile): BookPaths {
  const root = profile.dataSubdir ? path.join(dataDir, profile.dataSubdir) : dataDir;
  return {
    tradesDir: path.join(root, "trades"),
    positionsDir: path.join(root, "positions"),
    openPositionsFile: path.join(root, "positions", "open-positions.json"),
    riskStateFile: path.join(root, "positions", "risk-state.json"),
    summaryFile: path.join(root, "trades", "summary.json"),
    equityFile: path.join(root, "trades", "equity.jsonl"),
    eventTailFile: path.join(root, "positions", "event-tail.json"),
  };
}

export const RECORDER = {
  enabled: envStr("MARKET_RECORDER", "on") !== "off",
  /** Buffered rows are appended as one gzip member this often (and on shutdown). */
  flushIntervalMs: 300_000,
  /** Recordings older than this many days are deleted at startup (0 = keep forever). */
  retentionDays: envNum("MARKET_RECORDER_RETENTION_DAYS", 60),
} as const;
