// Shared types for simulation_trading_bot_v1.
// Everything here describes SIMULATED state. No wallet or key material exists anywhere.

export type Band = "A" | "B";

export type EventType = "entry" | "scaleout" | "exit";

export type ExitReason =
  | `takeProfitTier${number}`
  | "takeProfitFinal"
  | "trailingStop"
  | "hardStop"
  | "noFollowThrough"
  | "maxHoldTime"
  | "velocityEjection"
  | "stalePrice"
  | "securityReflag";

export interface BandParams {
  marketCapMinUsd: number;
  marketCapMaxUsd: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minBuySellRatio5m: number;
  /** Negative percentage, e.g. -15 */
  hardStopLossPct: number;
  maxHoldMinutes: number;
  /** Close a position that has gone nowhere after this long (see EXIT.noFollowThroughMinPeakGainPct). */
  noFollowThroughMinutes: number;
}

/** One timestamped numeric sample (price, tx count, ...). */
export interface Sample {
  t: number;
  v: number;
}

/** Market data for a token, taken from its most liquid Solana pair. */
export interface MarketSnapshot {
  tokenAddress: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  priceUsd: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  /** ms epoch of first liquidity add (pair creation), if known */
  pairCreatedAt: number | null;
  fetchedAt: number;
}

/** A token the scanner is tracking. Persisted so history survives restarts. */
export interface WatchedToken {
  tokenAddress: string;
  symbol: string;
  source: string;
  firstSeenAt: number;
  lastDiscoveredAt: number;
  lastSnapshot: MarketSnapshot | null;
  priceHistory: Sample[];
  /** 5-minute buy+sell tx counts over time */
  txHistory: Sample[];
  /** Don't re-run the (expensive) security gate before this time. */
  gateCooldownUntil: number | null;
  lastRejectReason: string | null;
  /** Tiered refresh: next time this token's market data is due (0 = every cycle). */
  nextRefreshAt: number;
  /** Consecutive refreshes with no DexScreener pair (0 = resolved last time). */
  unresolvedStreak: number;
  /** When the best (most liquid) pair was last re-resolved via the /tokens endpoint. */
  pairResolvedAt: number;
}

/** Exit-rule parameters (config.EXIT shape); each strategy book can have its own. */
export interface ExitParams {
  tiers: readonly { gainPct: number; sellFraction: number }[];
  trailingActivationGainPct: number;
  trailingDistancePct: number;
  trailingDistanceTightPct: number;
  trailingTightenAtGainPct: number;
  trailingFloorAboveEntryPct: number;
  estExitSlippagePct: number;
  maxHoldWhileTrailingMinutes: number;
  noFollowThroughMinPeakGainPct: number;
}

/**
 * One parallel paper strategy ("book"). Books share market data, discovery,
 * security verdicts and the exit monitor; each has its own entry rules, exit
 * parameters, portfolio, risk state and output files.
 */
export interface StrategyProfile {
  id: string;
  version: string;
  /** Band thresholds used for classification and the entry filter. */
  bands: Record<Band, BandParams>;
  /** Require a new 30-minute high at entry (v1.2 yes; v1.3 no). */
  requireNewLocalHigh: boolean;
  /** Exit parameters (hard stop / time limits come from `bands`). */
  exit: ExitParams;
  startingBankrollUsd: number;
  /** null = the main data/ tree; otherwise data/<subdir>/. */
  dataSubdir: string | null;
}

export interface Candidate {
  token: WatchedToken;
  snapshot: MarketSnapshot;
  band: Band;
}

export interface SecurityGateResult {
  passed: boolean;
  reasons: string[];
  decimals: number | null;
  transferTaxPct: number | null;
  rugcheckScore: number | null;
  top10HolderPct: number | null;
  lpLockedPct: number | null;
  checkedAt: number;
}

export interface SecurityRecheckResult {
  status: "ok" | "danger" | "error";
  flags: string[];
  error?: string;
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inAmountRaw: bigint;
  outAmountRaw: bigint;
  priceImpactPct: number;
  slippageBps: number;
  routeLabels: string[];
  fetchedAt: number;
}

export type PriceResult =
  | { status: "resolved"; priceUsd: number; source: "jupiter" | "jupiterQuote" | "dexscreener"; at: number }
  | { status: "unresolved"; error: string; at: number };

export interface Position {
  id: string;
  tokenAddress: string;
  symbol: string;
  band: Band;
  decimals: number;
  transferTaxPct: number;
  openedAt: number;
  /** Market price at the moment the entry signal fired. */
  quotedEntryPriceUsd: number;
  /** Effective per-token basis with slippage, tax, and fees netted in. */
  entryNetPriceUsd: number;
  tokensInitial: number;
  tokensRemaining: number;
  costBasisRemainingUsd: number;
  initialSizeUsd: number;
  initialSizeSol: number;
  highestPriceUsd: number;
  /** Lowest price seen since entry (for the max-adverse-excursion stat). */
  lowestPriceUsd: number;
  trailingActive: boolean;
  /** Current trailing-stop price, refreshed every cycle for display (null while inactive). */
  trailingStopUsd?: number | null;
  /** Effective gain now / at the high (after estimated exit costs), refreshed every cycle for display. */
  effectiveGainPct?: number;
  peakGainPct?: number;
  /** Number of EXIT.tiers rungs already sold (0 = none). */
  tiersDone: number;
  lastPriceUsd: number;
  /** Last time a live price was successfully resolved. */
  lastResolvedAt: number;
  txHistory: Sample[];
  /** 5m buys+sells at the moment of entry — floors the velocity-ejection baseline. */
  entryTxCount5m: number;
  lastSecurityCheckAt: number;
  securityRecheckFailures: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
}

export interface ClosedTrade {
  positionId: string;
  tokenAddress: string;
  symbol: string;
  band: Band;
  openedAt: number;
  closedAt: number;
  initialSizeUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  finalExitReason: ExitReason;
  /**
   * Best and worst effective gain (after estimated exit costs) seen while
   * open — how far the trade went for / against us. Without these, "the
   * entries are bad" and "the exits give it back" look identical.
   */
  maxGainPct: number;
  maxAdversePct: number;
}

export interface TradeLogEntry {
  timestamp: string;
  tokenAddress: string;
  symbol: string;
  band: Band;
  eventType: EventType;
  quotedPrice: number;
  netFillPrice: number;
  sizeUsd: number;
  sizeSol: number;
  transferTax: number;
  priorityFee: number;
  jitoTip: number;
  slippageRealizedPct: number;
  exitReason: ExitReason | null;
  realizedPnlUsd: number | null;
  realizedPnlPct: number | null;
  simulated: true;
  /** Extra diagnostics, not part of the required schema. */
  positionId: string;
  fillSource: "jupiterQuote" | "fallback";
  executionDelayMs: number;
}

export interface EntryFill {
  tokensGross: number;
  tokensNet: number;
  grossFillPriceUsd: number;
  netFillPriceUsd: number;
  transferTaxUsd: number;
  priorityFeeUsd: number;
  jitoTipUsd: number;
  feesUsd: number;
  totalCostUsd: number;
  slippageRealizedPct: number;
  solPriceUsd: number;
}

export interface ExitFill {
  tokensSold: number;
  solOut: number;
  grossProceedsUsd: number;
  transferTaxUsd: number;
  priorityFeeUsd: number;
  jitoTipUsd: number;
  feesUsd: number;
  netProceedsUsd: number;
  netFillPriceUsd: number;
  slippageRealizedPct: number;
  basisReleasedUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  solPriceUsd: number;
}

export interface RefreshInfo {
  /** tokens fetched this cycle (open positions + due watchlist entries) */
  due: number;
  refreshed: number;
  unresolved: number;
  viaPairs: number;
  tiers: { hot: number; warm: number; cold: number };
}

export interface TrancheGateStatus {
  name: string;
  passed: boolean;
  details: string[];
}

export interface Summary {
  generatedAt: string;
  simulated: true;
  /** Strategy book id ("v1.2", "v1.3"). */
  book?: string;
  startingBankrollUsd: number;
  cashUsd: number;
  bankrollUsd: number;
  equityUsd: number;
  openPositions: number;
  totalExposureUsd: number;
  exposurePct: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  averageWinUsd: number | null;
  averageLossUsd: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  peakEquityUsd: number;
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  dailyRealizedPnlUsd: number;
  dailyRealizedPnlPct: number;
  dailyLossLimitHit: boolean;
  circuitBreakerTripped: boolean;
  entriesAllowed: boolean;
  entriesBlockedReason: string | null;
  trancheGates: TrancheGateStatus[];
  watchlistSize: number;
  candidatesLastCycle: number;
  candidateSymbols: string[];
  /** Scanner funnel (reporting only): why in-band tokens aren't candidates right now. */
  funnel: { inBand: number; eligibleHistory: number; onGateCooldown: number; onReentryBlock: number; reasons: Record<string, number> };
  /** Tiered market-data refresh stats for this cycle. */
  refresh: RefreshInfo;
  /** External API calls: this cycle, cumulative since start, and per-minute average. */
  apiCalls: { cycle: Record<string, number>; total: Record<string, number>; perMinute: Record<string, number> };
  errorsLastCycle: string[];
  cycleDurationMs: number;
  cycle: number;
  uptimeSec: number;
  startedAt: string;
  /** Static strategy limits, so a viewer can render progress against them. */
  limits: {
    scanIntervalMs: number;
    maxConcurrentPositions: number;
    maxTotalExposurePct: number;
    perTradePctOfBankroll: number;
    dailyLossLimitPct: number;
    drawdownCircuitBreakerPct: number;
    bands: Record<
      Band,
      {
        marketCapMinUsd: number;
        marketCapMaxUsd: number;
        hardStopLossPct: number;
        maxHoldMinutes: number;
        noFollowThroughMinutes: number;
        minLiquidityUsd?: number;
        minVolume5mUsd?: number;
        minBuySellRatio5m?: number;
      }
    >;
    /** Scale-out rungs; whatever remains after the last one rides the trailing stop. */
    tiers: { gainPct: number; sellFraction: number }[];
    trailingActivationGainPct: number;
    strategy: {
      version: string;
      trailingDistancePct: number;
      trailingDistanceTightPct: number;
      trailingTightenAtGainPct: number;
      trailingFloorAboveEntryPct: number;
      maxHoldWhileTrailingMinutes: number;
      noFollowThroughMinPeakGainPct: number;
      min5mChangePct: number;
      max5mChangePct: number;
      max1hChangePct: number;
      minTxAcceleration: number;
      requireNewLocalHigh?: boolean;
    };
  };
}
