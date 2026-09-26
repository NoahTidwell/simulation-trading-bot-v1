// Risk manager: daily loss limit, drawdown circuit breaker, tranche-gate
// progress (reporting only — there is no live capital to gate).
//
// State is persisted so a tripped circuit breaker survives restarts. It never
// auto-resumes: to resume after manual review, delete data/positions/risk-state.json
// (or set "circuitBreakerTripped": false in it) and restart.

import fs from "node:fs";
import { PATHS, RISK } from "../config";
import type { Portfolio } from "../simulation/portfolio";
import type { TrancheGateStatus } from "../types";
import { dayKey, errMsg, fmtPct, fmtUsd } from "../utils/format";

interface RiskState {
  circuitBreakerTripped: boolean;
  trippedAt: number | null;
  trippedEquityUsd: number | null;
  dayKey: string;
  dayStartBankrollUsd: number;
  dailyRealizedPnlUsd: number;
  updatedAt: number;
}

export interface EntryPermission {
  allowed: boolean;
  reason: string | null;
}

export class RiskManager {
  private state: RiskState;
  private lastBlockedReason: string | null = null;
  private lastSavedKey = "";

  private constructor(
    state: RiskState,
    private readonly file: string = PATHS.riskStateFile,
  ) {
    this.state = state;
  }

  static load(portfolio: Portfolio, file: string = PATHS.riskStateFile): RiskManager {
    const now = Date.now();
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RiskState;
        if (raw && typeof raw.dayKey === "string") {
          if (raw.circuitBreakerTripped) {
            console.error("=".repeat(78));
            console.error("[risk] CIRCUIT BREAKER IS TRIPPED (persisted). New simulated entries remain halted.");
            console.error(`[risk] Tripped at ${raw.trippedAt ? new Date(raw.trippedAt).toISOString() : "?"} with equity ${fmtUsd(raw.trippedEquityUsd)}.`);
            console.error("[risk] Manual review required. Delete data/positions/risk-state.json to reset.");
            console.error("=".repeat(78));
          }
          return new RiskManager(raw, file);
        }
      } catch (e) {
        console.warn(`[risk] could not read risk state: ${errMsg(e)} — starting fresh`);
      }
    }
    return new RiskManager({
      circuitBreakerTripped: false,
      trippedAt: null,
      trippedEquityUsd: null,
      dayKey: dayKey(now),
      dayStartBankrollUsd: portfolio.bankrollUsd(),
      dailyRealizedPnlUsd: 0,
      updatedAt: now,
    }, file);
  }

  /** Called every cycle; only writes when something other than `updatedAt` changed. */
  save(): void {
    const { updatedAt: _ignored, ...rest } = this.state;
    const key = JSON.stringify(rest);
    if (key === this.lastSavedKey) return;
    this.lastSavedKey = key;
    this.state.updatedAt = Date.now();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get circuitBreakerTripped(): boolean {
    return this.state.circuitBreakerTripped;
  }
  get dailyRealizedPnlUsd(): number {
    return this.state.dailyRealizedPnlUsd;
  }
  get dailyRealizedPnlPct(): number {
    return this.state.dayStartBankrollUsd > 0 ? (this.state.dailyRealizedPnlUsd / this.state.dayStartBankrollUsd) * 100 : 0;
  }
  get dailyLossLimitHit(): boolean {
    return this.dailyRealizedPnlPct <= RISK.dailyLossLimitPct;
  }

  /** Call once per cycle: handles UTC day rollover and the circuit breaker. */
  evaluate(portfolio: Portfolio, now: number): void {
    const key = dayKey(now);
    if (key !== this.state.dayKey) {
      console.log(`[risk] new UTC day ${key}: daily P&L reset (yesterday ${fmtUsd(this.state.dailyRealizedPnlUsd)}), day-start bankroll ${fmtUsd(portfolio.bankrollUsd())}`);
      this.state.dayKey = key;
      this.state.dayStartBankrollUsd = portfolio.bankrollUsd();
      this.state.dailyRealizedPnlUsd = 0;
    }
    if (!this.state.circuitBreakerTripped) {
      const dd = portfolio.trancheDrawdownPct();
      if (dd <= RISK.drawdownCircuitBreakerPct) {
        this.state.circuitBreakerTripped = true;
        this.state.trippedAt = now;
        this.state.trippedEquityUsd = portfolio.equityUsd();
        console.error("=".repeat(78));
        console.error(`[risk] !!! DRAWDOWN CIRCUIT BREAKER TRIPPED: equity ${fmtUsd(portfolio.equityUsd())} is ${fmtPct(dd)} vs tranche ${fmtUsd(portfolio.startingBankrollUsd)} (limit ${RISK.drawdownCircuitBreakerPct}%)`);
        console.error("[risk] All new simulated entries are halted pending manual review. Open positions continue to be managed to exit.");
        console.error("[risk] This does NOT auto-resume. Delete data/positions/risk-state.json to reset after review.");
        console.error("=".repeat(78));
      }
    }
  }

  onRealizedPnl(pnlUsd: number): void {
    this.state.dailyRealizedPnlUsd += pnlUsd;
  }

  canOpenNewEntries(): EntryPermission {
    let result: EntryPermission = { allowed: true, reason: null };
    if (this.state.circuitBreakerTripped) {
      result = { allowed: false, reason: "drawdown circuit breaker tripped (manual review required)" };
    } else if (this.dailyLossLimitHit) {
      result = {
        allowed: false,
        reason: `daily loss limit hit (${fmtPct(this.dailyRealizedPnlPct)} of day-start bankroll, limit ${RISK.dailyLossLimitPct}%) — entries resume next UTC day`,
      };
    }
    if (result.reason !== this.lastBlockedReason) {
      if (result.reason) console.warn(`[risk] entries blocked: ${result.reason}`);
      else if (this.lastBlockedReason) console.log("[risk] entries re-enabled");
      this.lastBlockedReason = result.reason;
    }
    return result;
  }

  /** Reporting only: which tranche gates the simulated track record would satisfy. */
  trancheGateStatus(portfolio: Portfolio): TrancheGateStatus[] {
    const s = portfolio.stats();
    const netPnlPct = ((portfolio.equityUsd() - portfolio.startingBankrollUsd) / portfolio.startingBankrollUsd) * 100;
    const maxDd = portfolio.maxDrawdownPct;
    return RISK.trancheGates.map((g) => {
      const details: string[] = [];
      const okTrades = s.tradeCount >= g.minClosedTrades;
      const okWin = (s.winRatePct ?? 0) >= g.minWinRatePct;
      const okPnl = netPnlPct >= g.minNetPnlPct;
      const okDd = maxDd >= -g.maxDrawdownPct;
      details.push(`${okTrades ? "✓" : "✗"} trades ${s.tradeCount}/${g.minClosedTrades}`);
      details.push(`${okWin ? "✓" : "✗"} win rate ${s.winRatePct === null ? "n/a" : s.winRatePct.toFixed(1) + "%"} ≥ ${g.minWinRatePct}%`);
      details.push(`${okPnl ? "✓" : "✗"} net P&L ${netPnlPct.toFixed(1)}% ≥ ${g.minNetPnlPct}%`);
      details.push(`${okDd ? "✓" : "✗"} max DD ${maxDd.toFixed(1)}% ≥ -${g.maxDrawdownPct}%`);
      return { name: g.name, passed: okTrades && okWin && okPnl && okDd, details };
    });
  }
}
