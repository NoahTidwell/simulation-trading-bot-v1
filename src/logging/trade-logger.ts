// Append-only trade log (JSON Lines, one file per UTC day) and the running
// summary.json rewritten every cycle.

import fs from "node:fs";
import path from "node:path";
import { type BookPaths, PATHS, RUNTIME } from "../config";
import type { Summary, TradeLogEntry } from "../types";
import { dayKey, errMsg } from "../utils/format";
import type { ReportedEvent } from "./console-reporter";

/** The main book's files; other books pass their own (config.bookPaths). */
const MAIN: BookPaths = PATHS;

export function ensureDataDirs(extra: BookPaths[] = []): void {
  for (const dir of [PATHS.dataDir, PATHS.tradesDir, PATHS.positionsDir, ...extra.flatMap((p) => [p.tradesDir, p.positionsDir])]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function tradeLogFileFor(ts: number, paths: BookPaths = MAIN): string {
  return path.join(paths.tradesDir, `trades-${dayKey(ts)}.jsonl`);
}

/** Synchronous append so a record is on disk before the process moves on. */
export function appendTrade(entry: TradeLogEntry, paths: BookPaths = MAIN): void {
  const file = tradeLogFileFor(Date.parse(entry.timestamp) || Date.now(), paths);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[logger] FAILED to append trade record to ${file}: ${errMsg(e)}`);
    console.error(`[logger] record: ${JSON.stringify(entry)}`);
  }
}

export function writeSummary(summary: Summary, paths: BookPaths = MAIN): void {
  try {
    const tmp = `${paths.summaryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 2));
    fs.renameSync(tmp, paths.summaryFile);
  } catch (e) {
    console.error(`[logger] failed to write summary: ${errMsg(e)}`);
  }
}

/** Recent console events, mirrored for the read-only dashboard. */
export function writeEventTail(events: ReportedEvent[], paths: BookPaths = MAIN): void {
  try {
    const tmp = `${paths.eventTailFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), events }));
    fs.renameSync(tmp, paths.eventTailFile);
  } catch (e) {
    console.error(`[logger] failed to write event tail: ${errMsg(e)}`);
  }
}

const lastEquitySampleAt = new Map<string, number>();

/** Append one equity sample per minute (JSON Lines) for the equity curve. */
export function appendEquitySample(summary: Summary, now: number, paths: BookPaths = MAIN): void {
  if (now - (lastEquitySampleAt.get(paths.equityFile) ?? 0) < RUNTIME.equitySampleIntervalMs) return;
  lastEquitySampleAt.set(paths.equityFile, now);
  const sample = {
    t: now,
    equity: round2(summary.equityUsd),
    bankroll: round2(summary.bankrollUsd),
    cash: round2(summary.cashUsd),
    open: summary.openPositions,
    realized: round2(summary.realizedPnlUsd),
  };
  try {
    fs.appendFileSync(paths.equityFile, JSON.stringify(sample) + "\n");
  } catch (e) {
    console.error(`[logger] failed to append equity sample: ${errMsg(e)}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
