// simulation_trading_bot_v1 — entry point.
//
// Long-lived single process:
//   every scan cycle → manage open simulated positions → discover/refresh
//   candidates → run gates → open simulated positions → persist → report.
//
// It runs one or more strategy "books" (config.PROFILES: v1.2, and the
// parallel v1.3 paper strategy). Books share the market-data pass, discovery,
// security verdicts, the recorder and the exit monitor; each has its own entry
// rules, portfolio, risk state and output files.
//
// SIMULATION ONLY. No wallet, no key, no signing, no submission. Ever.

import { Connection } from "@solana/web3.js";
import { type BookPaths, bookPaths, ENDPOINTS, KEYS, PRICE_STRUCTURE, PROFILES, RISK, RUNTIME, SECURITY, SIMULATION_MODE, SIZING } from "./config";
import { CandidateScanner } from "./data/candidate-scanner";
import { PriceFeed } from "./data/price-feed";
import * as reporter from "./logging/console-reporter";
import { flushRecorder, pruneRecordings, recordGate, recordQuote, recordSnapshots } from "./logging/market-recorder";
import { appendEquitySample, appendTrade, ensureDataDirs, writeEventTail, writeSummary } from "./logging/trade-logger";
import { RiskManager } from "./risk/risk-manager";
import { recheckSecurity, runSecurityGate } from "./security/security-gate";
import { Portfolio } from "./simulation/portfolio";
import { simulateEntry, simulateExit } from "./simulation/simulated-execution";
import { applySecurityRecheck, checkVelocitySpike, isPriceStale, pushSample } from "./strategy/ejection-triggers";
import { effectiveGainPct, evaluateExitRules, trailingStopLevel } from "./strategy/exit-rules";
import { sizeNewPosition } from "./strategy/position-sizer";
import type { Band, Candidate, ExitReason, MarketSnapshot, Position, PriceResult, RefreshInfo, SecurityGateResult, StrategyProfile, Summary } from "./types";
import { errMsg, fmtUsd, shortAddr } from "./utils/format";
import { endCycle } from "./utils/metrics";
import { sleep } from "./utils/sleep";

if (SIMULATION_MODE !== true) {
  // Unreachable by construction; kept as an explicit guard.
  throw new Error("SIMULATION_MODE must be true");
}

/** One strategy book: its rules, simulated portfolio, risk state and output files. */
interface Book {
  profile: StrategyProfile;
  paths: BookPaths;
  /** Console label; undefined for the main book so its output is unchanged. */
  label: string | undefined;
  portfolio: Portfolio;
  risk: RiskManager;
  lastCandidates: Candidate[];
}

interface Context {
  connection: Connection;
  feed: PriceFeed;
  books: Book[];
  scanner: CandidateScanner;
  startedAt: number;
  cycle: number;
  lastDiscoveryAt: number;
  lastActivePoolDiscoveryAt: number;
  activePoolDiscoveryInFlight: boolean;
  lastEventSeq: number;
  /** Positions currently being acted on (exit / scale-out), by posKey. */
  positionLocks: Set<string>;
  /** Exit monitor: last quote attempt and last successful quote price, by posKey. */
  monitorQuotedAt: Map<string, number>;
  monitorPricedAt: Map<string, number>;
  monitorInFlight: Set<Promise<void>>;
  monitorBackoffUntil: number;
}

let shuttingDown = false;
let cycleInFlight: Promise<void> | null = null;
const EMPTY_REFRESH: RefreshInfo = { due: 0, refreshed: 0, unresolved: 0, viaPairs: 0, tiers: { hot: 0, warm: 0, cold: 0 } };

/** Position ids are only unique within a book. */
const posKey = (book: Book, position: Position) => `${book.profile.id}:${position.id}`;
const tag = (book: Book) => (book.label ? `[${book.label}] ` : "");

// ---------------------------------------------------------------------------
// Position management
// ---------------------------------------------------------------------------

async function closeOrScale(ctx: Context, book: Book, position: Position, tokensToSell: number, reason: ExitReason, detail: string, now: number): Promise<void> {
  const result = await simulateExit({
    position,
    tokensToSell,
    reason,
    priceFeed: ctx.feed,
    referencePriceUsd: position.lastPriceUsd,
  });
  const { closed } = book.portfolio.applyExit(position, result.fill, reason, now);
  book.risk.onRealizedPnl(result.fill.realizedPnlUsd);
  appendTrade(result.log, book.paths);
  let note = "";
  if (closed) {
    const until = book.portfolio.blockReentry(position.tokenAddress, reason, now);
    note = ` | position closed | re-entry blocked until ${new Date(until).toISOString().slice(11, 16)}Z`;
  } else {
    note = ` | ${position.tokensRemaining.toFixed(2)} tokens remain`;
  }
  reporter.tradeEvent(result.log, `${detail}${note}`, book.label);
  book.portfolio.save(true);
}

/**
 * The scan cycle and the exit monitor both act on positions; this makes sure
 * only one of them does at a time, so nothing is exited twice or scaled out
 * against state the other is mid-way through changing.
 */
async function withPositionLock(ctx: Context, book: Book, position: Position, fn: () => Promise<void>): Promise<void> {
  const key = posKey(book, position);
  if (ctx.positionLocks.has(key) || !book.portfolio.hasPosition(position.tokenAddress)) return;
  ctx.positionLocks.add(key);
  try {
    await fn();
  } finally {
    ctx.positionLocks.delete(key);
  }
}

function recordPrice(position: Position, priceUsd: number, at: number): void {
  position.lastPriceUsd = priceUsd;
  position.lastResolvedAt = at;
  // High/low water marks before any ejection, so they include the exit check.
  if (priceUsd > position.highestPriceUsd) position.highestPriceUsd = priceUsd;
  if (priceUsd < position.lowestPriceUsd) position.lowestPriceUsd = priceUsd;
}

/** Price-based rules at the position's current price. Call under the position lock. */
async function applyPriceRules(ctx: Context, book: Book, position: Position, now: number, via: string): Promise<void> {
  const decision = evaluateExitRules(position, position.lastPriceUsd, now, book.profile);
  position.trailingStopUsd = trailingStopLevel(position, book.profile);
  position.effectiveGainPct = effectiveGainPct(position, position.lastPriceUsd);
  position.peakGainPct = effectiveGainPct(position, position.highestPriceUsd);
  if (decision.type === "exit") {
    await closeOrScale(ctx, book, position, position.tokensRemaining, decision.reason, `${decision.detail} | via ${via}`, now);
  } else if (decision.type === "scaleout") {
    await closeOrScale(ctx, book, position, decision.tokensToSell, decision.reason, `${decision.detail} | via ${via}`, now);
    if (book.portfolio.hasPosition(position.tokenAddress)) position.tiersDone = decision.tierIndex + 1;
  }
}

async function managePositions(ctx: Context, book: Book, now: number, snapshots: Map<string, MarketSnapshot>, prices: Map<string, PriceResult>): Promise<string[]> {
  const errors: string[] = [];
  const positions = book.portfolio.openPositions().slice();
  if (positions.length === 0) return errors;

  // Positions are independent, so they're handled concurrently: one position's
  // 2–4 s simulated exit or security re-check no longer delays the others'
  // stop checks. Portfolio mutations are synchronous; the position lock keeps
  // this path and the exit monitor from acting on the same position at once.
  await Promise.all(positions.map(async (position) => {
    try {
      // Tx-velocity sample (DexScreener 5m buys+sells).
      const snap = snapshots.get(position.tokenAddress);
      if (snap && snap.buys5m !== null && snap.sells5m !== null) {
        pushSample(position.txHistory, snap.fetchedAt, snap.buys5m + snap.sells5m, RUNTIME.txHistoryRetentionMinutes * 60_000);
      }

      // 1. Price resolution / stale-price ejection. A recent live quote from the
      // exit monitor beats the Price API's cached number, so it isn't overwritten.
      const monitorFresh = now - (ctx.monitorPricedAt.get(posKey(book, position)) ?? 0) < RUNTIME.scanIntervalMs;
      const pr = prices.get(position.tokenAddress);
      if (pr && pr.status === "resolved") {
        if (!monitorFresh) recordPrice(position, pr.priceUsd, pr.at);
      } else if (!monitorFresh) {
        const staleSec = Math.round((now - position.lastResolvedAt) / 1000);
        if (isPriceStale(position, now)) {
          reporter.warn(`${tag(book)}${position.symbol}: price unresolved for ${staleSec}s — ejecting at last resolvable price ${position.lastPriceUsd}`);
          await withPositionLock(ctx, book, position, () =>
            closeOrScale(ctx, book, position, position.tokensRemaining, "stalePrice", `unresolved ${staleSec}s (${pr?.status === "unresolved" ? pr.error : "no result"})`, now),
          );
        } else {
          reporter.warn(`${tag(book)}${position.symbol}: price unresolved (${staleSec}s) — ${pr?.status === "unresolved" ? pr.error : "no result"}`);
        }
        return; // no fresh price → no rule evaluation this cycle
      }

      // 2. Periodic security re-check (danger flag → eject; repeated failures → eject).
      if (now - position.lastSecurityCheckAt >= SECURITY.recheckIntervalMs) {
        const recheck = await recheckSecurity(position.tokenAddress);
        position.lastSecurityCheckAt = now;
        const decision = applySecurityRecheck(position, recheck);
        if (decision.eject) {
          await withPositionLock(ctx, book, position, () => closeOrScale(ctx, book, position, position.tokensRemaining, "securityReflag", decision.detail, now));
          return;
        }
        if (recheck.status === "error") reporter.warn(`${tag(book)}${position.symbol}: security recheck failed (${position.securityRecheckFailures}/${SECURITY.recheckMaxConsecutiveFailures}): ${recheck.error}`);
      }

      await withPositionLock(ctx, book, position, async () => {
        // 3. Transaction-velocity spike.
        const velocity = checkVelocitySpike(position, now);
        if (velocity.triggered) {
          await closeOrScale(ctx, book, position, position.tokensRemaining, "velocityEjection", velocity.detail, now);
          return;
        }
        // 4. Price-based rules.
        await applyPriceRules(ctx, book, position, now, !monitorFresh && pr?.status === "resolved" ? pr.source : "quote");
      });
    } catch (e) {
      errors.push(`${tag(book)}position ${position.symbol}: ${errMsg(e)}`);
    }
  }));
  return errors;
}

// ---------------------------------------------------------------------------
// Exit monitor
// ---------------------------------------------------------------------------

/**
 * One exit-monitor tick: every open position (all books) that is due (per the
 * quote budget) and not already being quoted or acted on is re-priced from a
 * live Jupiter sell quote for its remaining size, then the price rules run.
 * Each position is handled on its own promise, so one position's 2–4 s
 * simulated exit never delays another's next check.
 */
function monitorTick(ctx: Context): void {
  const now = Date.now();
  const open = ctx.books.flatMap((book) => book.portfolio.openPositions().map((position) => ({ book, position, key: posKey(book, position) })));
  const openKeys = new Set(open.map((o) => o.key));
  for (const k of ctx.monitorQuotedAt.keys()) if (!openKeys.has(k)) ctx.monitorQuotedAt.delete(k);
  for (const k of ctx.monitorPricedAt.keys()) if (!openKeys.has(k)) ctx.monitorPricedAt.delete(k);
  if (open.length === 0 || now < ctx.monitorBackoffUntil) return;

  const perPositionMs = Math.max(RUNTIME.positionMonitorIntervalMs, (open.length * 60_000) / RUNTIME.positionMonitorQuotesPerMinute);
  for (const { book, position, key } of open) {
    if (ctx.positionLocks.has(key)) continue;
    const last = ctx.monitorQuotedAt.get(key);
    if (last === -1 || (last !== undefined && now - last < perPositionMs)) continue; // -1 = quote in flight
    ctx.monitorQuotedAt.set(key, -1);

    const task = (async () => {
      try {
        const { result, rateLimited } = await ctx.feed.resolveSellQuote({
          mint: position.tokenAddress,
          tokens: position.tokensRemaining,
          decimals: position.decimals,
          transferTaxPct: position.transferTaxPct,
        });
        if (rateLimited && Date.now() >= ctx.monitorBackoffUntil) {
          ctx.monitorBackoffUntil = Date.now() + RUNTIME.positionMonitorBackoffMs;
          reporter.warn(`exit monitor: Jupiter rate limit — pausing ${RUNTIME.positionMonitorBackoffMs / 1000}s (scan cycle still checks stops)`);
        }
        // Unresolved: the scan cycle's price feed and stale-price rule still apply.
        if (result.status !== "resolved") return;
        recordQuote(position.tokenAddress, result.at, result.priceUsd);
        await withPositionLock(ctx, book, position, async () => {
          recordPrice(position, result.priceUsd, result.at);
          ctx.monitorPricedAt.set(key, result.at);
          await applyPriceRules(ctx, book, position, Date.now(), "quote");
        });
      } catch (e) {
        reporter.warn(`${tag(book)}exit monitor ${position.symbol}: ${errMsg(e)}`);
      } finally {
        ctx.monitorQuotedAt.set(key, now);
      }
    })();
    ctx.monitorInFlight.add(task);
    void task.finally(() => ctx.monitorInFlight.delete(task));
  }
}

// ---------------------------------------------------------------------------
// Candidate scan + simulated entries
// ---------------------------------------------------------------------------

function sizingFor(book: Book) {
  return sizeNewPosition({
    bankrollUsd: book.portfolio.bankrollUsd(),
    cashUsd: book.portfolio.cashUsd,
    openPositionCount: book.portfolio.openPositions().length,
    totalExposureUsd: book.portfolio.exposureUsd(),
  });
}

/** Which of a book's candidates it would gate this cycle (empty if it can't enter at all). */
function candidatesToGate(ctx: Context, book: Book, now: number): Candidate[] {
  // Open positions + tokens on re-entry cooldown are never candidates.
  const candidates = ctx.scanner.candidates(now, book.portfolio.blockedMints(now), book.profile);
  book.lastCandidates = candidates;
  if (candidates.length === 0 || !book.risk.canOpenNewEntries().allowed) return [];
  const sizing = sizingFor(book);
  if (!sizing.ok) {
    reporter.debug(`${tag(book)}sizing blocked: ${sizing.reason}`);
    return [];
  }
  // Never gate more than the open position slots, so a full book doesn't waste gate calls.
  const freeSlots = SIZING.maxConcurrentPositions - book.portfolio.openPositions().length;
  return candidates.slice(0, Math.max(0, Math.min(RUNTIME.maxSecurityGatesPerCycle, freeSlots)));
}

/** A book's entries, one at a time so each sizing decision sees the previous fill. */
async function enterBook(ctx: Context, book: Book, toGate: Candidate[], gates: Map<string, SecurityGateResult>, now: number): Promise<void> {
  for (const candidate of toGate) {
    if (shuttingDown) break;
    const mint = candidate.token.tokenAddress;
    const sym = candidate.snapshot.symbol;
    const security = gates.get(mint);
    if (!security || !security.passed) continue;
    if (!book.risk.canOpenNewEntries().allowed) break;
    const sizing = sizingFor(book);
    if (!sizing.ok) {
      reporter.debug(`${tag(book)}sizing blocked: ${sizing.reason}`);
      break;
    }
    reporter.info(`${tag(book)}gate PASS ${sym}: rugcheck ${security.rugcheckScore} | top10 ${security.top10HolderPct?.toFixed(1)}% | LP locked ${security.lpLockedPct?.toFixed(1)}% | tax ${security.transferTaxPct}% — simulating entry of ${fmtUsd(sizing.sizeUsd)}`);

    const entry = await simulateEntry({ candidate, security, sizeUsd: sizing.sizeUsd, priceFeed: ctx.feed, now });
    if (!entry.ok) {
      reporter.warn(`${tag(book)}entry aborted ${sym}: ${entry.reason}`);
      ctx.scanner.markGateFailure(mint, entry.reason, now, RUNTIME.entryFailCooldownMinutes);
      continue;
    }
    book.portfolio.openPosition(entry.position, entry.position.costBasisRemainingUsd, entry.position.feesPaidUsd);
    appendTrade(entry.log, book.paths);
    reporter.tradeEvent(entry.log, `${entry.position.tokensInitial.toFixed(2)} tokens`, book.label);
    book.portfolio.save(true);
  }
}

async function scanAndEnter(ctx: Context, now: number): Promise<string[]> {
  const errors: string[] = [];

  if (now - ctx.lastDiscoveryAt >= RUNTIME.discoveryIntervalMs) {
    const d = await ctx.scanner.discover(now);
    ctx.lastDiscoveryAt = now;
    errors.push(...d.errors);
    if (!d.skipped) reporter.debug(`discovery: ${d.added} new mints (${d.seen} transfers seen)`);
  }

  // GeckoTerminal activity lists: in the background, so a slow response never delays the cycle.
  if (!ctx.activePoolDiscoveryInFlight && now - ctx.lastActivePoolDiscoveryAt >= RUNTIME.activePoolDiscoveryIntervalMs) {
    ctx.lastActivePoolDiscoveryAt = now;
    ctx.activePoolDiscoveryInFlight = true;
    void ctx.scanner
      .discoverActivePools(now)
      .then((d) => {
        // Rate-limited: push the next poll out (lastActivePoolDiscoveryAt is the schedule anchor).
        if (d.rateLimited) ctx.lastActivePoolDiscoveryAt = now + (RUNTIME.activePoolDiscoveryBackoffIntervals - 1) * RUNTIME.activePoolDiscoveryIntervalMs;
        for (const e of d.errors) reporter.warn(`discovery: ${e}`);
        reporter.debug(`active-pool discovery: ${d.added} new mints (${d.seen} pools seen)`);
      })
      .catch((e) => reporter.warn(`active-pool discovery: ${errMsg(e)}`))
      .finally(() => {
        ctx.activePoolDiscoveryInFlight = false;
      });
  }

  // Each book's candidates (its own entry rules); the security gate then runs
  // once per token for all books that want it — a verdict is about the token.
  const perBook = ctx.books.map((book) => ({ book, toGate: candidatesToGate(ctx, book, now) }));
  const wanted = new Map<string, { candidate: Candidate; books: string[] }>();
  for (const { book, toGate } of perBook) {
    for (const c of toGate) {
      const w = wanted.get(c.token.tokenAddress) ?? { candidate: c, books: [] };
      w.books.push(book.profile.id);
      wanted.set(c.token.tokenAddress, w);
    }
  }
  if (wanted.size === 0) return errors;

  for (const { candidate: c, books } of wanted.values()) {
    reporter.info(`signal${ctx.books.length > 1 ? ` [${books.join(", ")}]` : ""}: ${c.snapshot.symbol} (${shortAddr(c.token.tokenAddress)}) band ${c.band} mcap ${fmtUsd(c.snapshot.marketCapUsd, 0)} liq ${fmtUsd(c.snapshot.liquidityUsd, 0)} 5m vol ${fmtUsd(c.snapshot.volume5mUsd, 0)} 5m ${c.snapshot.priceChange5mPct?.toFixed(1)}% — running security gate`);
  }
  const mints = Array.from(wanted.keys());
  const results = await Promise.all(mints.map((m) => runSecurityGate(ctx.connection, m)));
  const gates = new Map<string, SecurityGateResult>();
  for (const [i, mint] of mints.entries()) {
    const g = results[i];
    gates.set(mint, g);
    recordGate(mint, g);
    if (!g.passed) {
      reporter.info(`gate REJECT ${wanted.get(mint)!.candidate.snapshot.symbol}: ${g.reasons.join("; ")}`);
      ctx.scanner.markGateFailure(mint, g.reasons[0] ?? "gate failed", now, RUNTIME.gateFailCooldownMinutes);
    }
  }

  // Books are independent portfolios, so their entries (each with its own 2–4 s
  // simulated delay) run concurrently.
  await Promise.all(perBook.map(({ book, toGate }) => enterBook(ctx, book, toGate, gates, now).catch((e) => errors.push(`${tag(book)}entries: ${errMsg(e)}`))));
  return errors;
}

// ---------------------------------------------------------------------------
// Summary / persistence
// ---------------------------------------------------------------------------

function buildSummary(
  ctx: Context,
  book: Book,
  now: number,
  cycleInfo: { errors: string[]; durationMs: number; refresh: RefreshInfo; apiCalls: Summary["apiCalls"] },
): Summary {
  const p = book.portfolio;
  const stats = p.stats();
  const permission = book.risk.canOpenNewEntries();
  const bankroll = p.bankrollUsd();
  const candidateSymbols = book.lastCandidates.map((c) => c.snapshot.symbol);
  const X = book.profile.exit;
  return {
    generatedAt: new Date(now).toISOString(),
    simulated: true,
    book: book.profile.id,
    startingBankrollUsd: p.startingBankrollUsd,
    cashUsd: p.cashUsd,
    bankrollUsd: bankroll,
    equityUsd: p.equityUsd(),
    openPositions: p.openPositions().length,
    totalExposureUsd: p.exposureUsd(),
    exposurePct: bankroll > 0 ? (p.exposureUsd() / bankroll) * 100 : 0,
    ...stats,
    realizedPnlUsd: p.realizedPnlUsd(),
    unrealizedPnlUsd: p.unrealizedPnlUsd(),
    totalFeesUsd: p.totalFeesUsd,
    peakEquityUsd: p.peakEquityUsd,
    currentDrawdownPct: p.currentDrawdownPct(),
    maxDrawdownPct: p.maxDrawdownPct,
    dailyRealizedPnlUsd: book.risk.dailyRealizedPnlUsd,
    dailyRealizedPnlPct: book.risk.dailyRealizedPnlPct,
    dailyLossLimitHit: book.risk.dailyLossLimitHit,
    circuitBreakerTripped: book.risk.circuitBreakerTripped,
    entriesAllowed: permission.allowed,
    entriesBlockedReason: permission.reason,
    trancheGates: book.risk.trancheGateStatus(p),
    watchlistSize: ctx.scanner.watchlist.size,
    candidatesLastCycle: book.lastCandidates.length,
    candidateSymbols,
    funnel: { ...ctx.scanner.funnel(now, book.profile), onReentryBlock: p.reentryBlockCount(now) },
    refresh: cycleInfo.refresh,
    apiCalls: cycleInfo.apiCalls,
    errorsLastCycle: cycleInfo.errors,
    cycleDurationMs: cycleInfo.durationMs,
    cycle: ctx.cycle,
    uptimeSec: Math.round((now - ctx.startedAt) / 1000),
    startedAt: new Date(ctx.startedAt).toISOString(),
    limits: {
      scanIntervalMs: RUNTIME.scanIntervalMs,
      maxConcurrentPositions: SIZING.maxConcurrentPositions,
      maxTotalExposurePct: SIZING.maxTotalExposurePct,
      perTradePctOfBankroll: SIZING.perTradePctOfBankroll,
      dailyLossLimitPct: RISK.dailyLossLimitPct,
      drawdownCircuitBreakerPct: RISK.drawdownCircuitBreakerPct,
      bands: {
        A: bandLimits(book, "A"),
        B: bandLimits(book, "B"),
      },
      tiers: X.tiers.map((t) => ({ gainPct: t.gainPct, sellFraction: t.sellFraction })),
      trailingActivationGainPct: X.trailingActivationGainPct,
      strategy: {
        version: book.profile.version,
        trailingDistancePct: X.trailingDistancePct,
        trailingDistanceTightPct: X.trailingDistanceTightPct,
        trailingTightenAtGainPct: X.trailingTightenAtGainPct,
        trailingFloorAboveEntryPct: X.trailingFloorAboveEntryPct,
        maxHoldWhileTrailingMinutes: X.maxHoldWhileTrailingMinutes,
        noFollowThroughMinPeakGainPct: X.noFollowThroughMinPeakGainPct,
        min5mChangePct: PRICE_STRUCTURE.min5mChangePct,
        max5mChangePct: PRICE_STRUCTURE.max5mChangePct,
        max1hChangePct: PRICE_STRUCTURE.max1hChangePct,
        minTxAcceleration: PRICE_STRUCTURE.minTxAcceleration,
        requireNewLocalHigh: book.profile.requireNewLocalHigh,
      },
    },
  };
}

function bandLimits(book: Book, band: Band) {
  const b = book.profile.bands[band];
  return {
    marketCapMinUsd: b.marketCapMinUsd,
    marketCapMaxUsd: b.marketCapMaxUsd,
    hardStopLossPct: b.hardStopLossPct,
    maxHoldMinutes: b.maxHoldMinutes,
    noFollowThroughMinutes: b.noFollowThroughMinutes,
    minLiquidityUsd: b.minLiquidityUsd,
    minVolume5mUsd: b.minVolume5mUsd,
    minBuySellRatio5m: b.minBuySellRatio5m,
  };
}

/** Per-cycle persistence is throttled inside each store; `force` (shutdown) writes everything. */
function persistAll(ctx: Context, force = false): void {
  for (const book of ctx.books) {
    try {
      book.portfolio.save(force);
    } catch (e) {
      reporter.error(`${tag(book)}persist portfolio: ${errMsg(e)}`);
    }
    try {
      book.risk.save();
    } catch (e) {
      reporter.error(`${tag(book)}persist risk state: ${errMsg(e)}`);
    }
  }
  try {
    ctx.scanner.save(force);
  } catch (e) {
    reporter.error(`persist watchlist: ${errMsg(e)}`);
  }
  try {
    flushRecorder(force);
  } catch (e) {
    reporter.error(`persist recordings: ${errMsg(e)}`);
  }
  // One shared event feed (book-labelled lines), mirrored into each book's dashboard files.
  const seq = reporter.eventSequence();
  if (force || seq !== ctx.lastEventSeq) {
    for (const book of ctx.books) writeEventTail(reporter.recentEvents(), book.paths);
    ctx.lastEventSeq = seq;
  }
}

function writeSummaries(ctx: Context, now: number, info: { errors: string[]; durationMs: number; refresh: RefreshInfo }, report: boolean): void {
  const apiCalls = endCycle();
  for (const book of ctx.books) {
    // The main book shows every error (shared ones included); other books only their own.
    const errors = book === ctx.books[0] ? info.errors : info.errors.filter((e) => e.startsWith(tag(book)));
    const summary = buildSummary(ctx, book, now, { ...info, errors, apiCalls });
    writeSummary(summary, book.paths);
    appendEquitySample(summary, now, book.paths);
    if (report) {
      reporter.cycleReport(
        summary,
        book.portfolio.openPositions(),
        { inBand: summary.funnel.inBand, candidateSymbols: summary.candidateSymbols, errors: book === ctx.books[0] ? info.errors : [] },
        book.label,
        book.profile,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runCycle(ctx: Context): Promise<void> {
  ctx.cycle += 1;
  const now = Date.now();
  const errors: string[] = [];
  let refreshInfo: RefreshInfo = EMPTY_REFRESH;
  const openMints = new Set(ctx.books.flatMap((b) => Array.from(b.portfolio.openMints())));

  // 1. One market-data pass: open positions (all books) + every watched token that is due.
  let snapshots = new Map<string, MarketSnapshot>();
  try {
    const r = await ctx.scanner.refresh(now, openMints);
    snapshots = r.snapshots;
    recordSnapshots(snapshots);
    refreshInfo = { due: r.due, refreshed: r.refreshed, unresolved: r.unresolved, viaPairs: r.viaPairs, tiers: r.tiers };
    errors.push(...r.errors);
    if (r.evicted > 0) reporter.debug(`watchlist: evicted ${r.evicted}`);
  } catch (e) {
    errors.push(`refresh: ${errMsg(e)}`);
  }

  // 2. Manage open simulated positions (ejections + price rules), one price lookup for all books.
  try {
    const prices = openMints.size > 0 ? await ctx.feed.resolveMany(Array.from(openMints), snapshots) : new Map<string, PriceResult>();
    const results = await Promise.all(ctx.books.map((book) => managePositions(ctx, book, now, snapshots, prices)));
    for (const r of results) errors.push(...r);
  } catch (e) {
    errors.push(`managePositions: ${errMsg(e)}`);
  }

  for (const book of ctx.books) {
    book.portfolio.markToMarket();
    book.risk.evaluate(book.portfolio, now);
  }

  // 3. Discovery + candidate evaluation + simulated entries.
  if (!shuttingDown) {
    try {
      errors.push(...(await scanAndEnter(ctx, now)));
    } catch (e) {
      errors.push(`scanAndEnter: ${errMsg(e)}`);
    }
  }

  for (const book of ctx.books) {
    book.portfolio.markToMarket();
    book.risk.evaluate(book.portfolio, Date.now());
  }
  persistAll(ctx);

  const done = Date.now();
  writeSummaries(ctx, done, { errors, durationMs: done - now, refresh: refreshInfo }, true);
}

async function main(): Promise<void> {
  reporter.banner();
  const books: Book[] = PROFILES.map((profile, i) => {
    const paths = bookPaths(profile);
    const portfolio = Portfolio.load(paths.openPositionsFile, profile.startingBankrollUsd);
    return { profile, paths, label: i === 0 ? undefined : profile.id, portfolio, risk: RiskManager.load(portfolio, paths.riskStateFile), lastCandidates: [] };
  });
  ensureDataDirs(books.map((b) => b.paths));
  try {
    const pruned = pruneRecordings(Date.now());
    if (pruned > 0) reporter.info(`recorder: deleted ${pruned} recording(s) past retention`);
  } catch (e) {
    reporter.warn(`recorder: prune failed: ${errMsg(e)}`);
  }

  const scanner = CandidateScanner.load();
  const ctx: Context = {
    // Read-only usage only. Rate-limit retries are disabled so a throttled RPC
    // fails fast and closed instead of stalling a cycle.
    connection: new Connection(ENDPOINTS.solanaRpc, { commitment: "confirmed", disableRetryOnRateLimit: true }),
    feed: new PriceFeed(),
    books,
    scanner,
    startedAt: Date.now(),
    cycle: 0,
    lastDiscoveryAt: 0,
    lastActivePoolDiscoveryAt: 0,
    activePoolDiscoveryInFlight: false,
    lastEventSeq: -1,
    positionLocks: new Set(),
    monitorQuotedAt: new Map(),
    monitorPricedAt: new Map(),
    monitorInFlight: new Set(),
    monitorBackoffUntil: 0,
  };
  reporter.startupSummary({
    startingBankroll: books[0].portfolio.startingBankrollUsd,
    restoredPositions: books[0].portfolio.openPositions().length,
    watchlist: scanner.watchlist.size,
    heliusEnabled: Boolean(KEYS.helius),
    rpc: ENDPOINTS.solanaRpc,
  });
  for (const book of books.slice(1)) {
    const a = book.profile.bands.A;
    reporter.info(
      `parallel book ${book.profile.id}: bankroll ${fmtUsd(book.portfolio.bankrollUsd())}, ${book.portfolio.openPositions().length} open | ` +
        `band A from ${fmtUsd(a.marketCapMinUsd, 0)}, 5m vol ≥ ${fmtUsd(a.minVolume5mUsd, 0)}, buy:sell ≥ ${a.minBuySellRatio5m}, new 30m high ${book.profile.requireNewLocalHigh ? "required" : "not required"}`,
    );
  }

  const onSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    reporter.info(`${sig} received — finishing current cycle, flushing state, then exiting`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("unhandledRejection", (r) => reporter.error(`unhandled rejection: ${errMsg(r)}`));
  process.on("uncaughtException", (e) => reporter.error(`uncaught exception: ${errMsg(e)}`));

  // Exit monitor: its own fast loop, independent of the scan cycle's duration.
  const monitorLoop = (async () => {
    while (!shuttingDown) {
      try {
        monitorTick(ctx);
      } catch (e) {
        reporter.error(`exit monitor: ${errMsg(e)}`);
      }
      await sleep(RUNTIME.positionMonitorIntervalMs);
    }
  })();

  while (!shuttingDown) {
    const started = Date.now();
    cycleInFlight = runCycle(ctx).catch((e) => reporter.error(`cycle ${ctx.cycle} failed: ${errMsg(e)}`));
    await cycleInFlight;
    cycleInFlight = null;
    const elapsed = Date.now() - started;
    const wait = Math.max(0, RUNTIME.scanIntervalMs - elapsed);
    // Sleep in short slices so shutdown is responsive.
    const deadline = Date.now() + wait;
    while (!shuttingDown && Date.now() < deadline) await sleep(Math.min(250, deadline - Date.now()));
  }

  if (cycleInFlight) await cycleInFlight;
  await monitorLoop;
  await Promise.all(ctx.monitorInFlight);
  persistAll(ctx, true);
  writeSummaries(ctx, Date.now(), { errors: [], durationMs: 0, refresh: EMPTY_REFRESH }, false);
  reporter.info("state persisted. bye.");
  process.exit(0);
}

main().catch((e) => {
  reporter.error(`fatal: ${errMsg(e)}`);
  process.exit(1);
});
