// Simulated portfolio: cash, open positions, realized/unrealized P&L, drawdown.
// Persisted to data/positions/open-positions.json for restart recovery.
//
// Definitions:
//   bankroll = cash + remaining cost basis of open positions   (used for sizing)
//   equity   = cash + mark-to-market value of open positions   (used for drawdown)

import fs from "node:fs";
import { PATHS, REENTRY, RUNTIME, STARTING_BANKROLL_USD } from "../config";
import { effectiveGainPct } from "../strategy/exit-rules";
import type { ClosedTrade, ExitFill, ExitReason, Position } from "../types";
import { errMsg } from "../utils/format";

/**
 * Effective gain for the whole initial position at `priceUsd`. At close
 * tokensRemaining is 0, which would make the fee share undefined, so it is
 * evaluated as if the full position were still held.
 */
function effectiveGainAt(position: Position, priceUsd: number): number {
  return effectiveGainPct({ ...position, tokensRemaining: position.tokensInitial }, priceUsd);
}

interface PortfolioState {
  simulated: true;
  startingBankrollUsd: number;
  cashUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  totalFeesUsd: number;
  positions: Position[];
  closedTrades: ClosedTrade[];
  /** mint → epoch ms until which the token may not be re-entered */
  reentryBlockedUntil: Record<string, number>;
  updatedAt: number;
}

export class Portfolio {
  private state: PortfolioState;

  private constructor(
    state: PortfolioState,
    private readonly file: string = PATHS.openPositionsFile,
  ) {
    this.state = state;
  }

  static load(file: string = PATHS.openPositionsFile, startingBankrollUsd: number = STARTING_BANKROLL_USD): Portfolio {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PortfolioState;
        if (raw && raw.simulated === true && typeof raw.cashUsd === "number") {
          raw.positions = Array.isArray(raw.positions) ? raw.positions : [];
          raw.closedTrades = Array.isArray(raw.closedTrades) ? raw.closedTrades : [];
          raw.totalFeesUsd = typeof raw.totalFeesUsd === "number" ? raw.totalFeesUsd : 0;
          raw.reentryBlockedUntil = raw.reentryBlockedUntil && typeof raw.reentryBlockedUntil === "object" ? raw.reentryBlockedUntil : {};
          for (const p of raw.positions) {
            // pre-field state files
            if (typeof p.entryTxCount5m !== "number") p.entryTxCount5m = 0;
            if (typeof p.lowestPriceUsd !== "number") p.lowestPriceUsd = Math.min(p.lastPriceUsd, p.highestPriceUsd);
            if (typeof p.tiersDone !== "number") {
              const legacy = p as Position & { tier1Done?: boolean; tier2Done?: boolean };
              p.tiersDone = (legacy.tier1Done ? 1 : 0) + (legacy.tier2Done ? 1 : 0);
              delete legacy.tier1Done;
              delete legacy.tier2Done;
            }
          }
          console.log(
            `[portfolio] restored state: cash $${raw.cashUsd.toFixed(2)}, ${raw.positions.length} open position(s), ${raw.closedTrades.length} closed trade(s)`,
          );
          return new Portfolio(raw, file);
        }
      } catch (e) {
        console.warn(`[portfolio] could not read ${file}: ${errMsg(e)} — starting fresh`);
      }
    }
    return new Portfolio({
      simulated: true,
      startingBankrollUsd,
      cashUsd: startingBankrollUsd,
      peakEquityUsd: startingBankrollUsd,
      maxDrawdownPct: 0,
      totalFeesUsd: 0,
      positions: [],
      closedTrades: [],
      reentryBlockedUntil: {},
      updatedAt: Date.now(),
    }, file);
  }

  private lastSavedAt = 0;

  /**
   * Trade events call this with `force` (cash / positions changed). The
   * per-cycle call is throttled: between trades only mark-to-market fields
   * move, and those are re-resolved from live prices on restart anyway.
   */
  save(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastSavedAt < RUNTIME.portfolioSaveIntervalMs) return false;
    this.state.updatedAt = now;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
    this.lastSavedAt = now;
    return true;
  }

  // --- accessors ---

  get startingBankrollUsd(): number {
    return this.state.startingBankrollUsd;
  }
  get cashUsd(): number {
    return this.state.cashUsd;
  }
  get totalFeesUsd(): number {
    return this.state.totalFeesUsd;
  }
  get peakEquityUsd(): number {
    return this.state.peakEquityUsd;
  }
  get maxDrawdownPct(): number {
    return this.state.maxDrawdownPct;
  }
  get closedTrades(): readonly ClosedTrade[] {
    return this.state.closedTrades;
  }

  openPositions(): Position[] {
    return this.state.positions;
  }

  openMints(): Set<string> {
    return new Set(this.state.positions.map((p) => p.tokenAddress));
  }

  /** Mints that may not be entered right now: open positions + re-entry cooldowns. Prunes expired blocks. */
  blockedMints(now: number): Set<string> {
    const out = this.openMints();
    for (const [mint, until] of Object.entries(this.state.reentryBlockedUntil)) {
      if (until > now) out.add(mint);
      else delete this.state.reentryBlockedUntil[mint];
    }
    return out;
  }

  reentryBlockCount(now: number): number {
    return Object.values(this.state.reentryBlockedUntil).filter((u) => u > now).length;
  }

  /**
   * Block re-entry on a token after an exit. Applies the longest of any
   * existing block, the per-exit cooldown, and the repeat-loser block. Call
   * after the closing trade has been recorded (applyExit), so it counts.
   */
  blockReentry(mint: string, reason: ExitReason, now: number): number {
    const badExit = (REENTRY.excludeForDayReasons as readonly string[]).includes(reason);
    let until = badExit ? now + REENTRY.badExitBlockHours * 3_600_000 : now + REENTRY.afterAnyExitMinutes * 60_000;
    const { maxLosses, windowHours, blockHours } = REENTRY.repeatLoser;
    const since = now - windowHours * 3_600_000;
    const recentLosses = this.state.closedTrades.filter((t) => t.tokenAddress === mint && t.closedAt >= since && t.realizedPnlUsd <= 0).length;
    if (recentLosses >= maxLosses) until = Math.max(until, now + blockHours * 3_600_000);
    const existing = this.state.reentryBlockedUntil[mint] ?? 0;
    this.state.reentryBlockedUntil[mint] = Math.max(existing, until);
    return this.state.reentryBlockedUntil[mint];
  }

  /** Entries on a token since `since` (closed trades and open positions). */
  entriesOnToken(mint: string, since: number): number {
    return this.state.closedTrades.filter((t) => t.tokenAddress === mint && t.openedAt >= since).length
      + this.state.positions.filter((p) => p.tokenAddress === mint && p.openedAt >= since).length;
  }

  hasPosition(mint: string): boolean {
    return this.state.positions.some((p) => p.tokenAddress === mint);
  }

  exposureUsd(): number {
    return this.state.positions.reduce((a, p) => a + p.costBasisRemainingUsd, 0);
  }

  bankrollUsd(): number {
    return this.state.cashUsd + this.exposureUsd();
  }

  marketValueUsd(): number {
    return this.state.positions.reduce((a, p) => a + p.tokensRemaining * p.lastPriceUsd, 0);
  }

  equityUsd(): number {
    return this.state.cashUsd + this.marketValueUsd();
  }

  unrealizedPnlUsd(): number {
    return this.marketValueUsd() - this.exposureUsd();
  }

  realizedPnlUsd(): number {
    return this.state.closedTrades.reduce((a, t) => a + t.realizedPnlUsd, 0) + this.state.positions.reduce((a, p) => a + p.realizedPnlUsd, 0);
  }

  /** Drawdown of current equity from peak equity, as a negative-or-zero %. */
  currentDrawdownPct(): number {
    const eq = this.equityUsd();
    const peak = this.state.peakEquityUsd;
    if (peak <= 0) return 0;
    return Math.min(0, ((eq - peak) / peak) * 100);
  }

  /** Equity vs the total simulated tranche (starting bankroll), as a %. */
  trancheDrawdownPct(): number {
    const start = this.state.startingBankrollUsd;
    return start > 0 ? ((this.equityUsd() - start) / start) * 100 : 0;
  }

  // --- mutations ---

  openPosition(position: Position, totalCostUsd: number, feesUsd: number): void {
    if (totalCostUsd > this.state.cashUsd + 1e-9) {
      throw new Error(`simulated cash insufficient: ${totalCostUsd} > ${this.state.cashUsd}`);
    }
    this.state.cashUsd -= totalCostUsd;
    this.state.totalFeesUsd += feesUsd;
    this.state.positions.push(position);
  }

  /** Apply an exit fill. Returns whether the position is now fully closed. */
  applyExit(position: Position, fill: ExitFill, reason: ExitReason, now: number): { closed: boolean } {
    this.state.cashUsd += fill.netProceedsUsd;
    this.state.totalFeesUsd += fill.feesUsd;
    position.tokensRemaining = Math.max(0, position.tokensRemaining - fill.tokensSold);
    position.costBasisRemainingUsd = Math.max(0, position.costBasisRemainingUsd - fill.basisReleasedUsd);
    position.realizedPnlUsd += fill.realizedPnlUsd;
    position.feesPaidUsd += fill.feesUsd;

    const dust = position.tokensRemaining <= position.tokensInitial * 1e-9;
    if (!dust) return { closed: false };

    const totalCost = position.initialSizeUsd + position.feesPaidUsd - fill.feesUsd; // basis incl. entry fees
    this.state.closedTrades.push({
      positionId: position.id,
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      band: position.band,
      openedAt: position.openedAt,
      closedAt: now,
      initialSizeUsd: position.initialSizeUsd,
      realizedPnlUsd: position.realizedPnlUsd,
      realizedPnlPct: totalCost > 0 ? (position.realizedPnlUsd / totalCost) * 100 : 0,
      finalExitReason: reason,
      maxGainPct: effectiveGainAt(position, position.highestPriceUsd),
      maxAdversePct: effectiveGainAt(position, position.lowestPriceUsd),
    });
    this.state.positions = this.state.positions.filter((p) => p.id !== position.id);
    return { closed: true };
  }

  /** Update peak/drawdown bookkeeping after prices moved. */
  markToMarket(): void {
    const eq = this.equityUsd();
    if (eq > this.state.peakEquityUsd) this.state.peakEquityUsd = eq;
    const dd = this.currentDrawdownPct();
    if (dd < this.state.maxDrawdownPct) this.state.maxDrawdownPct = dd;
  }

  // --- stats ---

  stats(): {
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRatePct: number | null;
    averageWinUsd: number | null;
    averageLossUsd: number | null;
    averageWinPct: number | null;
    averageLossPct: number | null;
  } {
    const trades = this.state.closedTrades;
    const wins = trades.filter((t) => t.realizedPnlUsd > 0);
    const losses = trades.filter((t) => t.realizedPnlUsd <= 0);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      tradeCount: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
      averageWinUsd: avg(wins.map((t) => t.realizedPnlUsd)),
      averageLossUsd: avg(losses.map((t) => t.realizedPnlUsd)),
      averageWinPct: avg(wins.map((t) => t.realizedPnlPct)),
      averageLossPct: avg(losses.map((t) => t.realizedPnlPct)),
    };
  }
}
