// Does a "staged pump" run-up before entry predict the trades that lose or get
// dumped on? For every closed trade (current book + archives) this fetches
// GeckoTerminal minute candles around the trade, measures the shape of the 30
// minutes before entry, and tests whether any measure separates winners from
// losers. Analysis only — nothing here touches the bot's state or config.
//
//   npx tsx scripts/analyze-pump-shape.ts            (candles cached in data/analysis/candles/)
//   npx tsx scripts/analyze-pump-shape.ts --refresh  (re-fetch)

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "analysis", "candles");
const GT = "https://api.geckoterminal.com/api/v2";
const GT_SPACING_MS = 6_500; // free tier's documented 30 calls/min isn't what it enforces; stay under ~10/min
const PRE_MIN = 30;
const POST_EXIT_MIN = 60;
const REFRESH = process.argv.includes("--refresh");

interface ClosedTrade {
  positionId: string;
  tokenAddress: string;
  symbol: string;
  band: string;
  openedAt: number;
  closedAt: number;
  initialSizeUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  finalExitReason: string;
  maxGainPct?: number;
}
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }; // t = minute start, ms

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function loadTrades(): (ClosedTrade & { book: string })[] {
  const books: { book: string; file: string }[] = [{ book: "current", file: path.join(DATA, "positions", "open-positions.json") }];
  const archive = path.join(DATA, "archive");
  if (fs.existsSync(archive)) {
    for (const d of fs.readdirSync(archive)) books.push({ book: d, file: path.join(archive, d, "positions", "open-positions.json") });
  }
  const out: (ClosedTrade & { book: string })[] = [];
  for (const b of books) {
    if (!fs.existsSync(b.file)) continue;
    const p = JSON.parse(fs.readFileSync(b.file, "utf8")) as { closedTrades?: ClosedTrade[] };
    for (const t of p.closedTrades ?? []) out.push({ ...t, book: b.book });
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

let lastCallAt = 0;
async function gt<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + GT_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < 6) {
      console.log(`  GeckoTerminal rate limit — waiting 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
}

/** Most liquid Solana pair, from DexScreener (the bot's own source; far looser rate limit than GeckoTerminal). */
async function topPool(mint: string): Promise<string | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dexscreener ${mint}`);
  const r = (await res.json()) as { pairs?: { chainId: string; pairAddress: string; liquidity?: { usd?: number } }[] | null };
  const pools = (r.pairs ?? []).filter((p) => p.chainId === "solana").sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pools[0]?.pairAddress ?? null;
}

async function candlesFor(trade: ClosedTrade): Promise<{ pool: string; candles: Candle[] } | null> {
  const file = path.join(CACHE, `${trade.positionId}.json`);
  if (!REFRESH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = await topPool(trade.tokenAddress);
  if (!pool) return null;
  const from = trade.openedAt - (PRE_MIN + 5) * 60_000;
  const to = trade.closedAt + POST_EXIT_MIN * 60_000;
  const limit = Math.min(1000, Math.ceil((to - from) / 60_000) + 2);
  const r = await gt<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `${GT}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${Math.floor(to / 1000)}&limit=${limit}&currency=usd&token=${trade.tokenAddress}`,
  );
  const candles = r.data.attributes.ohlcv_list
    .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
    .filter((k) => k.t >= from)
    .sort((a, b) => a.t - b.t);
  const out = { pool, candles };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** GeckoTerminal omits minutes with no trades; fill them as flat, zero-volume candles. */
function minuteSeries(candles: Candle[], fromMs: number, toMs: number): Candle[] {
  const byT = new Map(candles.map((k) => [k.t, k]));
  const out: Candle[] = [];
  let prev = candles.filter((k) => k.t < fromMs).pop()?.c ?? candles.find((k) => k.t >= fromMs)?.o ?? NaN;
  for (let t = Math.floor(fromMs / 60_000) * 60_000; t < toMs; t += 60_000) {
    const k = byT.get(t) ?? { t, o: prev, h: prev, l: prev, c: prev, v: 0 };
    out.push(k);
    prev = k.c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

interface Features {
  runUpPct: number;
  greenPct: number;
  closeAtHighPct: number;
  volumeCv: number;
  linearityR2: number;
  maxPullbackPct: number;
  emptyMinutesPct: number;
  /** Composite: high = smooth, steady, one-directional (the fomopay shape). */
  stairScore: number;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function features(pre: Candle[]): Features {
  const closes = pre.map((k) => k.c);
  const traded = pre.filter((k) => k.v > 0);
  const green = traded.filter((k) => k.c > k.o).length;
  const atHigh = traded.filter((k) => k.h === k.l || (k.h - k.c) / (k.h - k.l) <= 0.1).length;
  const vols = pre.map((k) => k.v);
  const vMean = mean(vols);
  const volumeCv = vMean > 0 ? Math.sqrt(mean(vols.map((v) => (v - vMean) ** 2))) / vMean : NaN;
  // R² of log(close) against time: 1.0 = a perfectly straight climb.
  const ys = closes.map((c) => Math.log(c));
  const xs = ys.map((_, i) => i);
  const xm = mean(xs), ym = mean(ys);
  const sxy = xs.reduce((a, x, i) => a + (x - xm) * (ys[i] - ym), 0);
  const sxx = xs.reduce((a, x) => a + (x - xm) ** 2, 0);
  const syy = ys.reduce((a, y) => a + (y - ym) ** 2, 0);
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const slopeUp = sxy > 0;
  let peak = -Infinity, maxDd = 0;
  for (const k of pre) {
    peak = Math.max(peak, k.h);
    maxDd = Math.max(maxDd, (peak - k.l) / peak);
  }
  const f = {
    runUpPct: (closes[closes.length - 1] / pre[0].o - 1) * 100,
    greenPct: traded.length ? (green / traded.length) * 100 : 0,
    closeAtHighPct: traded.length ? (atHigh / traded.length) * 100 : 0,
    volumeCv,
    linearityR2: slopeUp ? r2 : 0,
    maxPullbackPct: maxDd * 100,
    emptyMinutesPct: ((pre.length - traded.length) / pre.length) * 100,
    stairScore: 0,
  };
  // Each component scaled to ~0..1, averaged.
  f.stairScore =
    (f.greenPct / 100 + f.closeAtHighPct / 100 + f.linearityR2 + Math.max(0, 1 - f.maxPullbackPct / 10) + Math.max(0, 1 - (Number.isFinite(f.volumeCv) ? f.volumeCv : 2) / 2)) / 5;
  return f;
}

/** Largest drop from a high to a low within any 3-minute span, from entry to exit + 60 min. */
function worstCrashPct(post: Candle[]): number {
  let worst = 0;
  for (let i = 0; i < post.length; i++) {
    for (let j = i; j < Math.min(post.length, i + 3); j++) worst = Math.max(worst, (post[i].h - post[j].l) / post[i].h);
  }
  return worst * 100;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const FEATURES: { key: keyof Features; label: string; blockIf: "high" | "low" }[] = [
  { key: "stairScore", label: "staircase score", blockIf: "high" },
  { key: "greenPct", label: "% green candles", blockIf: "high" },
  { key: "closeAtHighPct", label: "% closes at high", blockIf: "high" },
  { key: "linearityR2", label: "straightness R²", blockIf: "high" },
  { key: "maxPullbackPct", label: "max pullback %", blockIf: "low" },
  { key: "volumeCv", label: "volume variation", blockIf: "low" },
  { key: "runUpPct", label: "30m run-up %", blockIf: "high" },
  { key: "emptyMinutesPct", label: "% minutes w/o trades", blockIf: "high" },
];

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function main(): Promise<void> {
  const trades = loadTrades();
  console.log(`${trades.length} closed trades; fetching candles (cached after the first run)...`);
  const rows: { t: (typeof trades)[number]; f: Features; crash: number; pool: string }[] = [];
  const skipped: string[] = [];
  for (const [i, t] of trades.entries()) {
    try {
      const c = await candlesFor(t);
      if (!c || c.candles.length === 0) {
        skipped.push(`${t.symbol} (${t.positionId}): no candles`);
        continue;
      }
      const entryMinute = Math.floor(t.openedAt / 60_000) * 60_000;
      const pre = minuteSeries(c.candles, entryMinute - PRE_MIN * 60_000, entryMinute);
      const post = minuteSeries(c.candles, entryMinute, t.closedAt + POST_EXIT_MIN * 60_000);
      if (pre.filter((k) => k.v > 0).length < 10 || pre.some((k) => !Number.isFinite(k.c))) {
        skipped.push(`${t.symbol} (${t.positionId}): too few candles before entry`);
        continue;
      }
      rows.push({ t, f: features(pre), crash: worstCrashPct(post), pool: c.pool });
    } catch (e) {
      skipped.push(`${t.symbol} (${t.positionId}): ${(e as Error).message}`);
    }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${trades.length}`);
  }

  const wins = rows.filter((r) => r.t.realizedPnlUsd > 0);
  const losses = rows.filter((r) => r.t.realizedPnlUsd <= 0);
  const totalPnl = rows.reduce((a, r) => a + r.t.realizedPnlUsd, 0);

  console.log(`\nAnalysed ${rows.length} trades (${wins.length} wins, ${losses.length} losses, net ${fmt(totalPnl, 2)} USD); skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s}`);

  console.log("\n## Per trade (sorted by staircase score)\n");
  console.log(`${pad("symbol", 9)} ${pad("book", 8)} ${pad("entry (UTC)", 16)} ${lpad("pnl$", 7)} ${lpad("pnl%", 6)} ${pad("exit", 16)} ${lpad("stair", 5)} ${lpad("green", 5)} ${lpad("@high", 5)} ${lpad("R²", 4)} ${lpad("pullb", 5)} ${lpad("volCV", 5)} ${lpad("runup", 6)} ${lpad("crash", 5)}`);
  for (const r of rows.slice().sort((a, b) => b.f.stairScore - a.f.stairScore)) {
    const { t, f } = r;
    console.log(
      `${pad(t.symbol, 9)} ${pad(t.book === "current" ? "v1.2" : "v1", 8)} ${pad(new Date(t.openedAt).toISOString().slice(5, 16).replace("T", " "), 16)} ${lpad(fmt(t.realizedPnlUsd, 2), 7)} ${lpad(fmt(t.realizedPnlPct), 6)} ${pad(t.finalExitReason, 16)} ${lpad(fmt(f.stairScore, 2), 5)} ${lpad(fmt(f.greenPct, 0), 5)} ${lpad(fmt(f.closeAtHighPct, 0), 5)} ${lpad(fmt(f.linearityR2, 2), 4)} ${lpad(fmt(f.maxPullbackPct), 5)} ${lpad(fmt(f.volumeCv, 2), 5)} ${lpad(fmt(f.runUpPct), 6)} ${lpad(fmt(r.crash, 0), 5)}`,
    );
  }

  console.log("\n## Winners vs losers (medians)\n");
  console.log(`${pad("measure", 22)} ${lpad("winners", 8)} ${lpad("losers", 8)}`);
  for (const { key, label } of FEATURES) {
    console.log(`${pad(label, 22)} ${lpad(fmt(median(wins.map((r) => r.f[key])), 2), 8)} ${lpad(fmt(median(losses.map((r) => r.f[key])), 2), 8)}`);
  }
  console.log(`${pad("crash after entry %", 22)} ${lpad(fmt(median(wins.map((r) => r.crash)), 1), 8)} ${lpad(fmt(median(losses.map((r) => r.crash)), 1), 8)}`);

  console.log("\n## Best single-measure rule per measure (blocking >= 5 trades)\n");
  console.log(`${pad("rule", 34)} ${lpad("blocked", 7)} ${lpad("wins", 5)} ${lpad("blk P&L", 8)} ${lpad("new net", 8)} ${lpad("new win%", 8)}`);
  const results: unknown[] = [];
  for (const { key, label, blockIf } of FEATURES) {
    const values = Array.from(new Set(rows.map((r) => r.f[key]).filter(Number.isFinite))).sort((a, b) => a - b);
    let best: { thr: number; blocked: typeof rows } | null = null;
    for (const thr of values) {
      const blocked = rows.filter((r) => (blockIf === "high" ? r.f[key] >= thr : r.f[key] <= thr));
      if (blocked.length < 5 || blocked.length > rows.length - 5) continue;
      const pnl = blocked.reduce((a, r) => a + r.t.realizedPnlUsd, 0);
      if (!best || pnl < best.blocked.reduce((a, r) => a + r.t.realizedPnlUsd, 0)) best = { thr, blocked };
    }
    if (!best) continue;
    const blkPnl = best.blocked.reduce((a, r) => a + r.t.realizedPnlUsd, 0);
    const kept = rows.filter((r) => !best!.blocked.includes(r));
    const keptWins = kept.filter((r) => r.t.realizedPnlUsd > 0).length;
    const rule = `${label} ${blockIf === "high" ? ">=" : "<="} ${fmt(best.thr, 2)}`;
    console.log(
      `${pad(rule, 34)} ${lpad(String(best.blocked.length), 7)} ${lpad(String(best.blocked.filter((r) => r.t.realizedPnlUsd > 0).length), 5)} ${lpad(fmt(blkPnl, 2), 8)} ${lpad(fmt(totalPnl - blkPnl, 2), 8)} ${lpad(fmt((keptWins / kept.length) * 100), 8)}`,
    );
    results.push({ rule, blocked: best.blocked.map((r) => r.t.symbol), blockedPnlUsd: blkPnl });
  }

  const outFile = path.join(DATA, "analysis", "pump-shape.json");
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), rows: rows.map((r) => ({ ...r.t, pool: r.pool, features: r.f, crashPct: r.crash })), rules: results, skipped }, null, 2));
  console.log(`\nfull results: ${path.relative(ROOT, outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
