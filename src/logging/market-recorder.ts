// Market recorder: everything the live bot observes that a strategy decision
// depends on, appended to data/recordings/market-YYYY-MM-DD.jsonl.gz so rule
// changes can be replayed offline (scripts/replay.ts) instead of waiting days
// for live trades. It records only what the bot already fetched — no extra
// API calls — and never influences a decision.
//
// Format: one JSON array per line, first element = row kind.
//   ["h", t, strategyVersion]                                   recorder (re)start
//   ["m", t, mint, symbol, pairAddress, dexId, pairCreatedAt]   token metadata, when it changes
//   ["s", t, mint, priceUsd, marketCapUsd, liquidityUsd, volume5mUsd, buys5m, sells5m, change5mPct, change1hPct]
//                                                               DexScreener snapshot (t = fetchedAt)
//   ["r", t, mint]                                              snapshot identical to the token's previous "s" row
//   ["g", t, mint, passed, reasons[], decimals, transferTaxPct, rugcheckScore, top10HolderPct, lpLockedPct]
//                                                               security gate result
//   ["q", t, mint, priceUsd]                                    exit-monitor sell-quote price (open positions)
//
// ~30 MB/day at the default refresh tiers; old days are pruned per
// RECORDER.retentionDays. Rows are buffered and appended every flushIntervalMs as a separate gzip
// member; concatenated gzip members are a valid gzip stream (zlib.gunzipSync
// and `gzip -dc` read the whole file). A crash loses at most one buffer.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PATHS, RECORDER, STRATEGY_VERSION } from "../config";
import type { MarketSnapshot, SecurityGateResult } from "../types";
import { dayKey, errMsg } from "../utils/format";

type Row = unknown[];

const buffer: Row[] = [];
const lastMeta = new Map<string, string>();
const lastValues = new Map<string, string>();
let lastFlushAt = Date.now();
let started = false;

export function recordingFileFor(ts: number): string {
  return path.join(PATHS.recordingsDir, `market-${dayKey(ts)}.jsonl.gz`);
}

function push(row: Row): void {
  if (!RECORDER.enabled) return;
  if (!started) {
    started = true;
    buffer.push(["h", Date.now(), STRATEGY_VERSION]);
  }
  buffer.push(row);
}

/** Round to 6 significant digits: plenty for replay, much smaller files. */
function sig(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(6));
}

export function recordSnapshots(snapshots: Map<string, MarketSnapshot>): void {
  if (!RECORDER.enabled) return;
  for (const s of snapshots.values()) {
    const meta = `${s.symbol}|${s.pairAddress}|${s.dexId}|${s.pairCreatedAt}`;
    if (lastMeta.get(s.tokenAddress) !== meta) {
      lastMeta.set(s.tokenAddress, meta);
      push(["m", s.fetchedAt, s.tokenAddress, s.symbol, s.pairAddress, s.dexId, s.pairCreatedAt]);
    }
    const values = [sig(s.priceUsd), sig(s.marketCapUsd), sig(s.liquidityUsd), sig(s.volume5mUsd), s.buys5m, s.sells5m, s.priceChange5mPct, s.priceChange1hPct];
    // Keyed by UTC day too, so each day's file is self-contained (its first row per token is a full "s").
    const key = `${dayKey(s.fetchedAt)}|${JSON.stringify(values)}`;
    // Quiet tokens repeat the same reading for minutes (~60% of rows); the
    // timestamp still matters (freshness, sample spacing), the values don't.
    if (lastValues.get(s.tokenAddress) === key) {
      push(["r", s.fetchedAt, s.tokenAddress]);
    } else {
      lastValues.set(s.tokenAddress, key);
      push(["s", s.fetchedAt, s.tokenAddress, ...values]);
    }
  }
}

export function recordGate(mint: string, g: SecurityGateResult): void {
  push(["g", g.checkedAt, mint, g.passed, g.reasons, g.decimals, g.transferTaxPct, g.rugcheckScore, g.top10HolderPct, g.lpLockedPct]);
}

export function recordQuote(mint: string, at: number, priceUsd: number): void {
  push(["q", at, mint, sig(priceUsd)]);
}

/** Append buffered rows (throttled unless `force`). Rows land in the file of their own UTC day. */
export function flushRecorder(force = false): void {
  const now = Date.now();
  if (buffer.length === 0 || (!force && now - lastFlushAt < RECORDER.flushIntervalMs)) return;
  lastFlushAt = now;
  const rows = buffer.splice(0, buffer.length);
  const byFile = new Map<string, string[]>();
  for (const r of rows) {
    const file = recordingFileFor(r[1] as number);
    const lines = byFile.get(file) ?? [];
    lines.push(JSON.stringify(r));
    byFile.set(file, lines);
  }
  try {
    if (!fs.existsSync(PATHS.recordingsDir)) fs.mkdirSync(PATHS.recordingsDir, { recursive: true });
    for (const [file, lines] of byFile) fs.appendFileSync(file, zlib.gzipSync(lines.join("\n") + "\n"));
  } catch (e) {
    console.error(`[recorder] failed to write ${rows.length} rows: ${errMsg(e)}`);
  }
}

/** Delete recordings older than the retention window. */
export function pruneRecordings(now: number): number {
  if (RECORDER.retentionDays <= 0 || !fs.existsSync(PATHS.recordingsDir)) return 0;
  const cutoff = dayKey(now - RECORDER.retentionDays * 86_400_000);
  let removed = 0;
  for (const f of fs.readdirSync(PATHS.recordingsDir)) {
    const m = /^market-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f);
    if (m && m[1] < cutoff) {
      fs.rmSync(path.join(PATHS.recordingsDir, f));
      removed += 1;
    }
  }
  return removed;
}
