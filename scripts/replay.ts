// Offline replay of recorded market data (data/recordings/, written by the
// live bot's market recorder) through the bot's OWN entry filter, sizing,
// exit rules, ejection triggers, portfolio and risk manager — so a config
// change can be judged against days of real data in minutes.
//
//   npx tsx scripts/replay.ts                                  baseline, all recordings
//   npx tsx scripts/replay.ts --from 2026-09-25 --to 2026-09-28
//   npx tsx scripts/replay.ts --set EXIT.tiers.1.gainPct=25    baseline vs one change
//   npx tsx scripts/replay.ts --variant variants/foo.json ...  baseline vs each file
//   options: --json out.json (machine-readable results for the Replay Lab page)
//            --start-at 2026-09-26T05:16Z (no entries before this; earlier data only warms up price history)
//            --trades (list every trade)  --ungated pass|skip  --slip 0.5  --sol-usd 115
//            --book v1.3 | v1.4  (replay that book's entry + exit rules; BAND_PARAMS/EXIT overrides then don't apply — use BOOK.*)
//
// A variant file is JSON: { "name": "tp2-25", "set": { "EXIT.tiers.1.gainPct": 25 } }
// (or several --set flags; each --set on the command line forms ONE extra variant).
//
// Model, and where it differs from live:
//  * Clock ticks every 1 s. Open positions are checked every tick (like the live
//    exit monitor) against the latest recorded price; entries are evaluated every
//    scan interval (5 s), exactly through evaluateEntryFilter.
//  * Fills happen SIM.executionDelay (midpoint, 3 s) after the decision, at the
//    latest recorded price then, worsened by --slip % (pool fee + impact). Live
//    fills use a Jupiter quote at that moment; here that quote doesn't exist.
//  * Recorded prices arrive every 5 s for hot tokens, 15 s warm, 60 s cold, plus
//    ~1 s sell quotes for positions the live bot actually held.
//  * Security gate: the recorded result for the token nearest in time (±12 h).
//    Tokens the live bot never gated have no result: --ungated skip (default)
//    counts them and moves on; --ungated pass assumes they pass. Changing
//    SECURITY.* in a variant has no effect (the recorded verdict is used).
//  * No mid-hold security re-checks (their results aren't recorded).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as C from "../src/config";
import { Portfolio } from "../src/simulation/portfolio";
import { RiskManager } from "../src/risk/risk-manager";
import { classifyBand } from "../src/strategy/bands";
import { evaluateEntryFilter } from "../src/strategy/entry-filter";
import { checkVelocitySpike, isPriceStale, pushSample } from "../src/strategy/ejection-triggers";
import { evaluateExitRules } from "../src/strategy/exit-rules";
import { ConfirmGate, overEntryCap } from "../src/strategy/lab-rules";
import { sizeNewPosition } from "../src/strategy/position-sizer";
import { computeEntryFill, computeExitFill, solToLamports, toRawAmount } from "../src/simulation/cost-model";
import type { ExitReason, MarketSnapshot, Position, SecurityGateResult, WatchedToken } from "../src/types";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  set: Record<string, unknown>;
}

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flags(name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
}
const FROM = flag("--from");
const TO = flag("--to");
const UNGATED = (flag("--ungated") ?? "skip") as "skip" | "pass";
const SLIP_PCT = Number(flag("--slip") ?? 0.5);
const SOL_USD = Number(flag("--sol-usd") ?? 115);
const LIST_TRADES = argv.includes("--trades");
const JSON_OUT = flag("--json");
const START_AT = flag("--start-at") ? Date.parse(flag("--start-at") as string) : 0;
const BOOK = { "v1.3": C.PROFILE_V13, "v1.4": C.PROFILE_V14, "v1.5": C.PROFILE_V15, "v1.6": C.PROFILE_V16 }[flag("--book") ?? ""] ?? C.PROFILE_V12;
const TICK_MS = 1_000;
const FILL_DELAY_MS = (C.SIM.executionDelayMinMs + C.SIM.executionDelayMaxMs) / 2;
const GATE_MATCH_MS = 12 * 3_600_000;

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const variants: Variant[] = [{ name: "baseline", set: {} }];
const cliSets = flags("--set");
if (cliSets.length > 0) {
  const set: Record<string, unknown> = {};
  for (const s of cliSets) {
    const eq = s.indexOf("=");
    if (eq < 0) throw new Error(`--set expects PATH=VALUE, got ${s}`);
    set[s.slice(0, eq)] = parseValue(s.slice(eq + 1));
  }
  variants.push({ name: cliSets.join(" "), set });
}
for (const f of flags("--variant")) {
  const v = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<Variant>;
  variants.push({ name: v.name ?? path.basename(f, ".json"), set: v.set ?? {} });
}

// ---------------------------------------------------------------------------
// Config overrides (config objects are read at call time, so mutating them
// changes the bot's own rule code; originals are restored between variants)
// ---------------------------------------------------------------------------

const CONFIG_ROOTS: Record<string, object> = {
  EXIT: C.EXIT, PRICE_STRUCTURE: C.PRICE_STRUCTURE, BAND_PARAMS: C.BAND_PARAMS, SIZING: C.SIZING,
  RISK: C.RISK, EJECTION: C.EJECTION, REENTRY: C.REENTRY, SIM: C.SIM, RUNTIME: C.RUNTIME,
  // v1.3 profile fields (BOOK.requireNewLocalHigh, BOOK.bands.A.minBuySellRatio5m, ...). Not for v1.2,
  // whose bands ARE BAND_PARAMS — override those via BAND_PARAMS.* instead.
  ...(BOOK === C.PROFILE_V12 ? {} : { BOOK }),
};
const ORIGINALS = Object.fromEntries(Object.entries(CONFIG_ROOTS).map(([k, v]) => [k, structuredClone(v)]));

function restoreConfig(): void {
  for (const [k, obj] of Object.entries(CONFIG_ROOTS)) {
    const o = obj as Record<string, unknown>;
    for (const key of Object.keys(o)) delete o[key];
    Object.assign(o, structuredClone(ORIGINALS[k]));
  }
}

function applySet(pathStr: string, value: unknown): void {
  const parts = pathStr.split(".");
  const root = CONFIG_ROOTS[parts[0]];
  if (!root) throw new Error(`unknown config root in ${pathStr} (known: ${Object.keys(CONFIG_ROOTS).join(", ")})`);
  let cur = root as Record<string, unknown>;
  for (const p of parts.slice(1, -1)) {
    if (cur[p] === undefined || typeof cur[p] !== "object") throw new Error(`no such config path: ${pathStr}`);
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) throw new Error(`no such config path: ${pathStr}`);
  cur[last] = value;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

type Row = [string, number, string, ...unknown[]];

function recordingFiles(): string[] {
  const dir = C.PATHS.recordingsDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => /^market-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null && (!FROM || m[1] >= FROM) && (!TO || m[1] <= TO))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map((m) => path.join(dir, m[0]));
}

function readRows(file: string): Row[] {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const rows: Row[] = [];
  for (const line of text.split("\n")) if (line) rows.push(JSON.parse(line) as Row);
  // Within a file rows are near-ordered (per flush); sort for a strict clock.
  return rows.sort((a, b) => a[1] - b[1]);
}

/** Security gate results by mint, from every file in range (a variant may signal before the live bot did). */
function loadGates(files: string[]): Map<string, { t: number; g: SecurityGateResult }[]> {
  const out = new Map<string, { t: number; g: SecurityGateResult }[]>();
  for (const f of files) {
    for (const r of readRows(f)) {
      if (r[0] !== "g") continue;
      const [, t, mint, passed, reasons, decimals, tax, rug, top10, lp] = r as [string, number, string, boolean, string[], number | null, number | null, number | null, number | null, number | null];
      const list = out.get(mint) ?? [];
      list.push({ t, g: { passed, reasons, decimals, transferTaxPct: tax, rugcheckScore: rug, top10HolderPct: top10, lpLockedPct: lp, checkedAt: t } });
      out.set(mint, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One replay run
// ---------------------------------------------------------------------------

interface PendingEntry {
  kind: "entry";
  dueAt: number;
  mint: string;
  token: WatchedToken;
  snap: MarketSnapshot;
  band: "A" | "B";
  gate: SecurityGateResult;
  sizeUsd: number;
}
interface PendingExit {
  kind: "exit";
  dueAt: number;
  position: Position;
  tokens: number;
  reason: ExitReason;
  tierIndex: number | null;
}

interface RunResult {
  name: string;
  portfolio: Portfolio;
  ungatedSignals: Set<string>;
  gateRejects: number;
  entryAborts: number;
  confirmRejects: number;
  firstT: number;
  lastT: number;
}

function runVariant(v: Variant, files: string[], gates: Map<string, { t: number; g: SecurityGateResult }[]>): RunResult {
  restoreConfig();
  for (const [p, val] of Object.entries(v.set)) applySet(p, val);

  // Real Portfolio / RiskManager logic on in-memory state. save() is never called.
  const PortfolioCtor = Portfolio as unknown as new (s: unknown) => Portfolio;
  const portfolio = new PortfolioCtor({
    simulated: true, startingBankrollUsd: C.STARTING_BANKROLL_USD, cashUsd: C.STARTING_BANKROLL_USD, peakEquityUsd: C.STARTING_BANKROLL_USD,
    maxDrawdownPct: 0, totalFeesUsd: 0, positions: [], closedTrades: [], reentryBlockedUntil: {}, updatedAt: 0,
  });
  const RiskCtor = RiskManager as unknown as new (s: unknown) => RiskManager;
  const risk = new RiskCtor({ circuitBreakerTripped: false, trippedAt: null, trippedEquityUsd: null, dayKey: "", dayStartBankrollUsd: C.STARTING_BANKROLL_USD, dailyRealizedPnlUsd: 0, updatedAt: 0 });

  const tokens = new Map<string, WatchedToken>();
  const meta = new Map<string, { symbol: string; pairAddress: string; dexId: string; pairCreatedAt: number | null }>();
  const lastPrice = new Map<string, { p: number; t: number }>(); // DexScreener snapshots
  // Jupiter sell quotes (recorded ~1/s for positions the live bot held). Snapshots can lag the chain by
  // 20+ s: during the XDP rug a stale pre-crash snapshot arrived after the crash quote and the replay
  // booked a −99% exit as +133%. Live exits fill at the quote, so a fresh quote always wins.
  const lastQuote = new Map<string, { p: number; t: number }>();
  const QUOTE_FRESH_MS = 10_000;
  function priceNow(mint: string, now: number): { p: number; t: number } | null {
    const q = lastQuote.get(mint);
    if (q && now - q.t <= QUOTE_FRESH_MS) return q;
    return lastPrice.get(mint) ?? null;
  }
  const gateCooldown = new Map<string, number>();
  const pending: (PendingEntry | PendingExit)[] = [];
  const busy = new Set<string>(); // mints with a pending fill
  const ungatedSignals = new Set<string>();
  let gateRejects = 0;
  let entryAborts = 0;
  let confirmRejects = 0;
  const confirm = new ConfirmGate(); // wait-and-confirm clocks (shared logic with the live bot)
  let clock = 0;
  let nextScanAt = 0;
  let firstT = 0;
  let lastT = 0;
  let posSeq = 0;

  const priceRetentionMs = C.RUNTIME.priceHistoryRetentionMinutes * 60_000;
  const txRetentionMs = C.RUNTIME.txHistoryRetentionMinutes * 60_000;

  function gateFor(mint: string, t: number): SecurityGateResult | null {
    const list = gates.get(mint);
    if (!list) return null;
    let best: { t: number; g: SecurityGateResult } | null = null;
    for (const e of list) if (Math.abs(e.t - t) <= GATE_MATCH_MS && (!best || Math.abs(e.t - t) < Math.abs(best.t - t))) best = e;
    return best?.g ?? null;
  }

  function fillPrice(mint: string, now: number): number | null {
    return priceNow(mint, now)?.p ?? null;
  }

  function doExit(pe: PendingExit, now: number): void {
    const { position } = pe;
    const price = fillPrice(position.tokenAddress, now) ?? position.lastPriceUsd;
    const gross = price * (1 - SLIP_PCT / 100);
    const tokensSold = Math.min(pe.tokens, position.tokensRemaining);
    const fraction = position.tokensRemaining > 0 ? tokensSold / position.tokensRemaining : 0;
    const solOut = (tokensSold * (1 - position.transferTaxPct / 100) * gross) / SOL_USD;
    const fill = computeExitFill({
      tokensSold, solOutRaw: solToLamports(solOut), transferTaxPct: position.transferTaxPct, solPriceUsd: SOL_USD,
      referencePriceUsd: position.lastPriceUsd, basisReleasedUsd: position.costBasisRemainingUsd * fraction,
    });
    const { closed } = portfolio.applyExit(position, fill, pe.reason, now);
    risk.onRealizedPnl(fill.realizedPnlUsd);
    if (closed) portfolio.blockReentry(position.tokenAddress, pe.reason, now);
    else if (pe.tierIndex !== null) position.tiersDone = pe.tierIndex + 1;
  }

  function doEntry(pe: PendingEntry, now: number): void {
    const price = fillPrice(pe.mint, now);
    if (price === null) return;
    const gross = price * (1 + SLIP_PCT / 100);
    const deviation = ((gross - pe.snap.priceUsd) / pe.snap.priceUsd) * 100;
    if (Math.abs(deviation) > C.SIM.maxEntryFillDeviationPct) {
      entryAborts += 1;
      gateCooldown.set(pe.mint, now + C.RUNTIME.entryFailCooldownMinutes * 60_000);
      return;
    }
    const decimals = pe.gate.decimals ?? 6;
    const tax = pe.gate.transferTaxPct ?? 0;
    const sizeSol = pe.sizeUsd / SOL_USD;
    const fill = computeEntryFill({ sizeUsd: pe.sizeUsd, tokensOutRaw: toRawAmount(pe.sizeUsd / gross, decimals), decimals, transferTaxPct: tax, solPriceUsd: SOL_USD, quotedPriceUsd: pe.snap.priceUsd });
    if (fill.totalCostUsd > portfolio.cashUsd) return;
    const position: Position = {
      id: `replay-${++posSeq}`, tokenAddress: pe.mint, symbol: pe.snap.symbol, band: pe.band, decimals, transferTaxPct: tax, openedAt: now,
      quotedEntryPriceUsd: pe.snap.priceUsd, entryNetPriceUsd: fill.netFillPriceUsd, tokensInitial: fill.tokensNet, tokensRemaining: fill.tokensNet,
      costBasisRemainingUsd: fill.totalCostUsd, initialSizeUsd: pe.sizeUsd, initialSizeSol: sizeSol, highestPriceUsd: fill.grossFillPriceUsd,
      lowestPriceUsd: fill.grossFillPriceUsd, trailingActive: false, tiersDone: 0, lastPriceUsd: fill.grossFillPriceUsd, lastResolvedAt: now,
      txHistory: pe.token.txHistory.slice(), entryTxCount5m: (pe.snap.buys5m ?? 0) + (pe.snap.sells5m ?? 0),
      lastSecurityCheckAt: now, securityRecheckFailures: 0, realizedPnlUsd: 0, feesPaidUsd: fill.feesUsd,
    };
    portfolio.openPosition(position, fill.totalCostUsd, fill.feesUsd);
  }

  function managePositions(now: number): void {
    for (const position of portfolio.openPositions().slice()) {
      if (busy.has(position.tokenAddress)) continue;
      const lp = priceNow(position.tokenAddress, now);
      if (lp && (lp.t > position.lastResolvedAt || lp.p !== position.lastPriceUsd)) {
        position.lastPriceUsd = lp.p;
        position.lastResolvedAt = lp.t;
        if (lp.p > position.highestPriceUsd) position.highestPriceUsd = lp.p;
        if (lp.p < position.lowestPriceUsd) position.lowestPriceUsd = lp.p;
      }
      let decision: { reason: ExitReason; tokens: number; tierIndex: number | null } | null = null;
      if (isPriceStale(position, now)) decision = { reason: "stalePrice", tokens: position.tokensRemaining, tierIndex: null };
      else {
        const vel = checkVelocitySpike(position, now);
        if (vel.triggered) decision = { reason: "velocityEjection", tokens: position.tokensRemaining, tierIndex: null };
        else {
          const d = evaluateExitRules(position, position.lastPriceUsd, now, BOOK);
          if (d.type === "exit") decision = { reason: d.reason, tokens: position.tokensRemaining, tierIndex: null };
          else if (d.type === "scaleout") decision = { reason: d.reason, tokens: d.tokensToSell, tierIndex: d.tierIndex };
        }
      }
      if (decision) {
        busy.add(position.tokenAddress);
        pending.push({ kind: "exit", dueAt: now + FILL_DELAY_MS, position, ...decision });
      }
    }
  }

  function scanEntries(now: number): void {
    const blocked = portfolio.blockedMints(now);
    const candidates: { token: WatchedToken; snap: MarketSnapshot; band: "A" | "B" }[] = [];
    for (const token of tokens.values()) {
      const snap = token.lastSnapshot;
      if (!snap || blocked.has(token.tokenAddress) || busy.has(token.tokenAddress)) continue;
      if ((gateCooldown.get(token.tokenAddress) ?? 0) > now) continue;
      if (now - snap.fetchedAt > C.RUNTIME.scanIntervalMs * 2) continue;
      const band = classifyBand(snap.marketCapUsd, BOOK.bands);
      if (!band) continue;
      if (!evaluateEntryFilter(token, snap, band, now, BOOK).passed) continue;
      const lab = BOOK.lab;
      if (lab && overEntryCap(lab, portfolio.entriesOnToken(token.tokenAddress, now - 24 * 3_600_000))) continue;
      if (lab) {
        const { result } = confirm.check(lab, token.tokenAddress, snap.priceUsd, now);
        if (result === "fail") confirmRejects += 1;
        if (result !== "pass") continue;
      }
      candidates.push({ token, snap, band });
    }
    if (candidates.length === 0 || !risk.canOpenNewEntries().allowed) return;
    candidates.sort((a, b) => (b.snap.volume5mUsd ?? 0) - (a.snap.volume5mUsd ?? 0));
    const pendingEntries = pending.filter((p) => p.kind === "entry") as PendingEntry[];
    const freeSlots = C.SIZING.maxConcurrentPositions - portfolio.openPositions().length - pendingEntries.length;
    let committedUsd = pendingEntries.reduce((a, p) => a + p.sizeUsd, 0);
    for (const c of candidates.slice(0, Math.max(0, Math.min(C.RUNTIME.maxSecurityGatesPerCycle, freeSlots)))) {
      const mint = c.token.tokenAddress;
      let gate = gateFor(mint, now);
      if (!gate) {
        ungatedSignals.add(`${c.snap.symbol} ${mint.slice(0, 6)}`);
        if (UNGATED === "skip") {
          gateCooldown.set(mint, now + C.RUNTIME.gateFailCooldownMinutes * 60_000);
          continue;
        }
        gate = { passed: true, reasons: [], decimals: 6, transferTaxPct: 0, rugcheckScore: null, top10HolderPct: null, lpLockedPct: null, checkedAt: now };
      }
      if (!gate.passed) {
        gateRejects += 1;
        gateCooldown.set(mint, now + C.RUNTIME.gateFailCooldownMinutes * 60_000);
        continue;
      }
      const sizing = sizeNewPosition({
        bankrollUsd: portfolio.bankrollUsd(), cashUsd: portfolio.cashUsd - committedUsd,
        openPositionCount: portfolio.openPositions().length + pending.filter((p) => p.kind === "entry").length,
        totalExposureUsd: portfolio.exposureUsd() + committedUsd,
      });
      if (!sizing.ok) break;
      committedUsd += sizing.sizeUsd;
      busy.add(mint);
      pending.push({ kind: "entry", dueAt: now + FILL_DELAY_MS, mint, token: c.token, snap: c.snap, band: c.band, gate, sizeUsd: sizing.sizeUsd });
    }
  }

  function tick(now: number): void {
    // Fills that are due.
    for (let i = 0; i < pending.length; ) {
      const p = pending[i];
      if (p.dueAt > now) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      if (p.kind === "exit") {
        busy.delete(p.position.tokenAddress);
        if (portfolio.hasPosition(p.position.tokenAddress)) doExit(p, now);
      } else {
        busy.delete(p.mint);
        doEntry(p, now);
      }
    }
    managePositions(now);
    portfolio.markToMarket();
    risk.evaluate(portfolio, now);
    if (now >= nextScanAt) {
      nextScanAt = now + C.RUNTIME.scanIntervalMs;
      if (now >= START_AT) scanEntries(now);
    }
  }

  const lastS = new Map<string, Row>();

  function ingest(row: Row): void {
    let r = row;
    if (r[0] === "r") {
      // Unchanged reading: the token's previous "s" values at the new time.
      const prev = lastS.get(r[2]);
      if (!prev) return;
      r = [prev[0], r[1], r[2], ...prev.slice(3)] as Row;
    } else if (r[0] === "s") {
      lastS.set(r[2], r);
    }
    const [kind, t, mint] = r;
    if (kind === "m") {
      const [, , , symbol, pairAddress, dexId, pairCreatedAt] = r as [string, number, string, string, string, string, number | null];
      meta.set(mint, { symbol, pairAddress, dexId, pairCreatedAt });
    } else if (kind === "s") {
      const [, , , price, mcap, liq, vol5m, buys, sells, ch5, ch1h] = r as [string, number, string, number, number | null, number | null, number | null, number | null, number | null, number | null, number | null];
      if (!(price > 0)) return;
      const m = meta.get(mint) ?? { symbol: "?", pairAddress: "", dexId: "", pairCreatedAt: null };
      let token = tokens.get(mint);
      if (!token) {
        token = { tokenAddress: mint, symbol: m.symbol, source: "replay", firstSeenAt: t, lastDiscoveredAt: t, lastSnapshot: null, priceHistory: [], txHistory: [], gateCooldownUntil: null, lastRejectReason: null, nextRefreshAt: 0, unresolvedStreak: 0, pairResolvedAt: t };
        tokens.set(mint, token);
      }
      const snap: MarketSnapshot = {
        tokenAddress: mint, symbol: m.symbol, name: m.symbol, pairAddress: m.pairAddress, dexId: m.dexId, priceUsd: price, marketCapUsd: mcap,
        liquidityUsd: liq, volume5mUsd: vol5m, buys5m: buys, sells5m: sells, priceChange5mPct: ch5, priceChange1hPct: ch1h, pairCreatedAt: m.pairCreatedAt, fetchedAt: t,
      };
      token.symbol = m.symbol;
      token.lastSnapshot = snap;
      pushSample(token.priceHistory, t, price, priceRetentionMs);
      if (buys !== null && sells !== null) {
        pushSample(token.txHistory, t, buys + sells, txRetentionMs);
        const pos = portfolio.openPositions().find((p) => p.tokenAddress === mint);
        if (pos) pushSample(pos.txHistory, t, buys + sells, txRetentionMs);
      }
      const prev = lastPrice.get(mint);
      if (!prev || t >= prev.t) lastPrice.set(mint, { p: price, t });
    } else if (kind === "q") {
      const price = r[3] as number;
      const prev = lastQuote.get(mint);
      if (price > 0 && (!prev || t >= prev.t)) lastQuote.set(mint, { p: price, t });
    }
  }

  for (const f of files) {
    for (const r of readRows(f)) {
      if (r[0] === "h" || r[0] === "g") continue;
      const t = r[1];
      if (clock === 0) {
        clock = Math.floor(t / TICK_MS) * TICK_MS;
        firstT = t;
      }
      while (clock + TICK_MS <= t) {
        clock += TICK_MS;
        tick(clock);
      }
      ingest(r);
      lastT = t;
    }
  }
  // Drain pending fills; open positions are left open and reported.
  for (let i = 0; i < 10 && pending.length > 0; i++) tick((clock += TICK_MS));
  return { name: v.name, portfolio, ungatedSignals, gateRejects, entryAborts, confirmRejects, firstT: Math.max(firstT, START_AT), lastT };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(d));
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

function liveTradesBetween(from: number, to: number): { n: number; pnl: number; wins: number } {
  const file = C.bookPaths(BOOK).openPositionsFile;
  if (!fs.existsSync(file)) return { n: 0, pnl: 0, wins: 0 }; // book has no live history yet
  const p = JSON.parse(fs.readFileSync(file, "utf8")) as { closedTrades: { openedAt: number; realizedPnlUsd: number }[] };
  const ts = p.closedTrades.filter((t) => t.openedAt >= from && t.openedAt <= to);
  return { n: ts.length, pnl: ts.reduce((a, t) => a + t.realizedPnlUsd, 0), wins: ts.filter((t) => t.realizedPnlUsd > 0).length };
}

function main(): void {
  const files = recordingFiles();
  if (files.length === 0) {
    console.log(`no recordings in ${C.PATHS.recordingsDir}${FROM || TO ? ` for ${FROM ?? "…"}..${TO ?? "…"}` : ""}`);
    return;
  }
  console.log(`replaying ${files.length} recording file(s): ${files.map((f) => path.basename(f)).join(", ")}`);
  console.log(`entry rules: ${BOOK.id}`);
  console.log(`fills ${FILL_DELAY_MS / 1000}s after decision, slip ${SLIP_PCT}%/side, SOL $${SOL_USD}, ungated signals: ${UNGATED}\n`);
  const gates = loadGates(files);
  // The risk manager logs day rollovers / blocks for the live console; mute it during runs.
  const saved = { log: console.log, warn: console.warn, error: console.error };
  let results: RunResult[];
  try {
    console.log = console.warn = console.error = () => {};
    results = variants.map((v) => runVariant(v, files, gates));
  } finally {
    Object.assign(console, saved);
  }
  restoreConfig();

  const r0 = results[0];
  const hours = (r0.lastT - r0.firstT) / 3_600_000;
  console.log(`period ${iso(r0.firstT)} → ${iso(r0.lastT)} UTC (${hours.toFixed(1)} h)`);
  const live = liveTradesBetween(r0.firstT, r0.lastT);
  console.log(`live bot, same period: ${live.n} trades, ${live.wins} wins, ${fmt(live.pnl)} USD (calibration check for the baseline)\n`);

  console.log(`${pad("variant", 34)} ${lpad("trades", 6)} ${lpad("win%", 5)} ${lpad("net $", 8)} ${lpad("net %", 6)} ${lpad("maxDD%", 7)} ${lpad("open", 4)} ${lpad("ungated", 7)}  exits`);
  for (const r of results) {
    const p = r.portfolio;
    const s = p.stats();
    const net = p.realizedPnlUsd();
    const reasons: Record<string, number> = {};
    for (const t of p.closedTrades) reasons[t.finalExitReason] = (reasons[t.finalExitReason] ?? 0) + 1;
    const exits = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(
      `${pad(r.name, 34)} ${lpad(String(s.tradeCount), 6)} ${lpad(fmt(s.winRatePct, 0), 5)} ${lpad(fmt(net), 8)} ${lpad(fmt((net / p.startingBankrollUsd) * 100, 1), 6)} ${lpad(fmt(p.maxDrawdownPct, 1), 7)} ${lpad(String(p.openPositions().length), 4)} ${lpad(String(r.ungatedSignals.size), 7)}  ${exits || "-"}`,
    );
  }
  if (r0.ungatedSignals.size > 0) {
    console.log(`\nsignals with no recorded security verdict (${UNGATED === "skip" ? "skipped" : "assumed to pass"}): ${Array.from(r0.ungatedSignals).slice(0, 15).join(", ")}${r0.ungatedSignals.size > 15 ? ", …" : ""}`);
  }

  if (JSON_OUT) {
    const out = {
      generatedAt: Date.now(), book: BOOK.id, from: r0.firstT, to: r0.lastT, slipPct: SLIP_PCT, live,
      variants: results.map((r, i) => {
        const p = r.portfolio, s = p.stats(), net = p.realizedPnlUsd();
        return {
          name: r.name, set: variants[i].set, trades: s.tradeCount, winRatePct: s.winRatePct, netUsd: net,
          netPct: (net / p.startingBankrollUsd) * 100, maxDrawdownPct: p.maxDrawdownPct, open: p.openPositions().length,
          confirmRejects: r.confirmRejects,
          closed: p.closedTrades.map((t) => ({ openedAt: t.openedAt, closedAt: t.closedAt, symbol: t.symbol, pnl: t.realizedPnlUsd, pct: t.realizedPnlPct, peakPct: t.maxGainPct, reason: t.finalExitReason })),
        };
      }),
    };
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(out));
    console.log(`
wrote ${JSON_OUT}`);
  }

  if (LIST_TRADES) {
    for (const r of results) {
      console.log(`\n## ${r.name}\n`);
      for (const t of r.portfolio.closedTrades) {
        console.log(`${iso(t.openedAt)}  ${pad(t.symbol, 10)} ${t.band} ${lpad(fmt(t.realizedPnlUsd), 7)} ${lpad(fmt(t.realizedPnlPct, 1), 6)}%  peak ${lpad(fmt(t.maxGainPct, 1), 5)}%  ${Math.round((t.closedAt - t.openedAt) / 60_000)}m  ${t.finalExitReason}`);
      }
    }
  }
}

main();
