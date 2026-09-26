// Human-readable stdout output. No UI, no server — just the console.

import { BAND_PARAMS, EXIT, RUNTIME, SIZING } from "../config";
import { gainPct, trailingStopLevel } from "../strategy/exit-rules";
import type { Position, Summary, TradeLogEntry, StrategyProfile } from "../types";
import { fmtCompact, fmtDuration, fmtPct, fmtPrice, fmtSignedUsd, fmtTime, fmtUsd, pad, shortAddr } from "../utils/format";

const LEVELS = { debug: 0, info: 1, warn: 2 } as const;
const threshold = LEVELS[RUNTIME.logLevel] ?? LEVELS.info;

/** Recent non-cycle lines (signals, gate results, trades, warnings, errors), mirrored to disk for the read-only dashboard. */
export interface ReportedEvent {
  t: number;
  level: "info" | "warn" | "error" | "trade";
  msg: string;
}
const recent: ReportedEvent[] = [];
const RECENT_MAX = 300;
let eventSeq = 0;
function remember(level: ReportedEvent["level"], msg: string): void {
  recent.push({ t: Date.now(), level, msg });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  eventSeq += 1;
}
export function recentEvents(): ReportedEvent[] {
  return recent.slice();
}
/** Monotonic counter — lets the persister skip the write when nothing was logged. */
export function eventSequence(): number {
  return eventSeq;
}

export function debug(msg: string): void {
  if (threshold <= LEVELS.debug) console.log(`${fmtTime()} [debug] ${msg}`);
}
export function info(msg: string): void {
  remember("info", msg);
  if (threshold <= LEVELS.info) console.log(`${fmtTime()} ${msg}`);
}
export function warn(msg: string): void {
  remember("warn", msg);
  if (threshold <= LEVELS.warn) console.warn(`${fmtTime()} [warn] ${msg}`);
}
export function error(msg: string): void {
  remember("error", msg);
  console.error(`${fmtTime()} [error] ${msg}`);
}

export function banner(): void {
  console.log("=".repeat(78));
  console.log("  simulation_trading_bot_v1 — SIMULATION MODE (hardcoded)");
  console.log("  No wallet. No private key. No signing. No real funds. Every trade below is simulated.");
  console.log("=".repeat(78));
}

/** `book` labels lines from a non-main strategy book, e.g. "v1.3". */
export function tradeEvent(entry: TradeLogEntry, extra?: string, book?: string): void {
  const tag = entry.eventType === "entry" ? "ENTRY " : entry.eventType === "scaleout" ? "SCALE " : "EXIT  ";
  const pnl = entry.realizedPnlUsd === null ? "" : ` pnl ${fmtSignedUsd(entry.realizedPnlUsd)} (${fmtPct(entry.realizedPnlPct)})`;
  const reason = entry.exitReason ? ` reason=${entry.exitReason}` : "";
  const src = entry.fillSource === "fallback" ? " [FALLBACK FILL]" : "";
  const line =
    `${book ? `[${book}] ` : ""}[SIM ${tag}] ${entry.symbol} (${shortAddr(entry.tokenAddress)}) band ${entry.band} | ` +
    `quoted ${fmtPrice(entry.quotedPrice)} → net fill ${fmtPrice(entry.netFillPrice)} (${fmtPct(entry.slippageRealizedPct, 2)} slip) | ` +
    `${fmtUsd(entry.sizeUsd)} / ${entry.sizeSol.toFixed(4)} SOL | fees ${entry.priorityFee + entry.jitoTip} SOL + tax ${fmtUsd(entry.transferTax)}` +
    `${reason}${pnl}${src} | delay ${entry.executionDelayMs}ms${extra ? ` | ${extra}` : ""}`;
  remember("trade", line);
  console.log(`${fmtTime()} ${line}`);
}

function positionLine(p: Position, now: number, profile?: StrategyProfile): string {
  const gain = gainPct(p, p.lastPriceUsd);
  const high = gainPct(p, p.highestPriceUsd);
  const stop = trailingStopLevel(p, profile);
  const remainingPct = (p.tokensRemaining / p.tokensInitial) * 100;
  const staleSec = Math.round((now - p.lastResolvedAt) / 1000);
  return (
    `    ${pad(p.symbol.slice(0, 10), 10)} ${p.band}  ${pad(fmtPct(gain), 8)} held ${pad(fmtDuration(now - p.openedAt), 8)} ` +
    `hi ${pad(fmtPct(high), 8)} px ${pad(fmtPrice(p.lastPriceUsd), 12)} ` +
    `trail ${stop ? fmtPrice(stop) : "off"}  tiers ${p.tiersDone}/${(profile?.exit ?? EXIT).tiers.length}  ` +
    `left ${remainingPct.toFixed(0)}%  basis ${fmtUsd(p.costBasisRemainingUsd)}  real ${fmtSignedUsd(p.realizedPnlUsd)}` +
    (staleSec > RUNTIME.scanIntervalMs / 1000 + 2 ? `  STALE ${staleSec}s` : "")
  );
}

export function cycleReport(summary: Summary, positions: Position[], extra: { inBand: number; candidateSymbols: string[]; errors: string[] }, book?: string, profile?: StrategyProfile): void {
  const s = summary;
  const now = Date.now();
  console.log(
    `${fmtTime()} ${book ? `[${book}] ` : ""}cycle ${s.cycle} | bankroll ${fmtUsd(s.bankrollUsd)} | equity ${fmtUsd(s.equityUsd)} | cash ${fmtUsd(s.cashUsd)} | ` +
      `open ${s.openPositions}/${SIZING.maxConcurrentPositions} (${fmtPct(s.exposurePct, 0)} exp) | closed ${s.tradeCount} | ` +
      `win ${s.winRatePct === null ? "n/a" : s.winRatePct.toFixed(0) + "%"} | avgW ${fmtSignedUsd(s.averageWinUsd)} avgL ${fmtSignedUsd(s.averageLossUsd)} | ` +
      `real ${fmtSignedUsd(s.realizedPnlUsd)} unreal ${fmtSignedUsd(s.unrealizedPnlUsd)} | DD ${fmtPct(s.currentDrawdownPct)} (max ${fmtPct(s.maxDrawdownPct)}) | ` +
      `day ${fmtSignedUsd(s.dailyRealizedPnlUsd)} | watch ${s.watchlistSize} (${extra.inBand} in band) | cand ${s.candidatesLastCycle}` +
      (s.entriesAllowed ? "" : ` | ENTRIES HALTED`),
  );
  for (const p of positions) console.log(positionLine(p, now, profile));
  if (extra.candidateSymbols.length > 0) debug(`${book ? `[${book}] ` : ""}candidates: ${extra.candidateSymbols.join(", ")}`);
  for (const e of extra.errors) warn(e);
}

export function startupSummary(opts: { startingBankroll: number; restoredPositions: number; watchlist: number; heliusEnabled: boolean; rpc: string }): void {
  info(`starting bankroll (simulated): ${fmtUsd(opts.startingBankroll)}`);
  info(`restored open positions: ${opts.restoredPositions} | watchlist: ${opts.watchlist}`);
  info(`discovery: ${opts.heliusEnabled ? "Helius program polling (Raydium + pump.fun)" : "DISABLED (no HELIUS_API_KEY)"}`);
  info(`rpc (read-only): ${opts.rpc.replace(/api-key=[^&]+/, "api-key=***")}`);
  const { A, B } = BAND_PARAMS;
  const band = (p: typeof A) => `${fmtCompact(p.marketCapMinUsd)}–${fmtCompact(p.marketCapMaxUsd)}`;
  info(`scan interval ${RUNTIME.scanIntervalMs}ms | discovery interval ${RUNTIME.discoveryIntervalMs}ms | mcap bands A ${band(A)}, B ${band(B)}`);
}
