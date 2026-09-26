// Read-only local dashboard for simulation_trading_bot_v1.
//
// A separate process from the bot. It never talks to the bot — it only reads
// the JSON/JSONL files the bot already writes under data/ and serves them to
// a single HTML page on localhost. No dependencies, no writes, no network
// beyond 127.0.0.1.
//
//   npm run dashboard      → http://localhost:4545

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const HTML = path.join(__dirname, "index.html");

// Strategy books the bot runs side by side: v1.2 writes the main data/ tree,
// v1.3 and v1.4 (parallel paper strategies) write data/v1.3/ and data/v1.4/. Selected with ?book=.
const BOOKS = { "v1.2": DATA, "v1.3": path.join(DATA, "v1.3"), "v1.4": path.join(DATA, "v1.4") };
const DEFAULT_BOOK = "v1.2";

function filesFor(book) {
  const root = BOOKS[book];
  return {
    summary: path.join(root, "trades", "summary.json"),
    positions: path.join(root, "positions", "open-positions.json"),
    events: path.join(root, "positions", "event-tail.json"),
    equity: path.join(root, "trades", "equity.jsonl"),
    tradesDir: path.join(root, "trades"),
  };
}
const PORT = Number(process.env.DASHBOARD_PORT || 4545);
const HOST = "127.0.0.1";
const EQUITY_MAX_SAMPLES = 2880; // 48h at one sample/minute
const TRADE_EVENTS_MAX = 500;

// Files are written atomically by the bot (tmp + rename), but keep the last
// good parse anyway so a transient read error never blanks the page.
const lastGood = new Map();

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    lastGood.set(file, parsed);
    return parsed;
  } catch {
    return lastGood.get(file) ?? null;
  }
}

function readJsonl(file, maxLines) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tail = maxLines ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip partial line */
    }
  }
  return out;
}

function readTradeEvents(FILES) {
  let files;
  try {
    files = fs
      .readdirSync(FILES.tradesDir)
      .filter((f) => /^trades-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const events = [];
  for (const f of files.slice(-3)) events.push(...readJsonl(path.join(FILES.tradesDir, f)));
  return events.slice(-TRADE_EVENTS_MAX);
}

// ---------------------------------------------------------------------------
// Fee-free view (?fees=exclude, the page's default)
//
// The simulation charges fixed SOL fees (priority fee + Jito tip) on every
// fill. While strategies are being tuned those are set to 0 in .env, but trades
// from before that paid them. This view adds every fill's fixed fee back, so
// all numbers show strategy quality alone. Pool fees and price impact stay —
// they are inside the Jupiter quotes. Nothing on disk is changed.
// ---------------------------------------------------------------------------

/** USD value of one trade-log event's fixed fees (SOL price implied by the fill itself). */
function eventFeeUsd(e) {
  const feeSol = (Number(e.priorityFee) || 0) + (Number(e.jitoTip) || 0);
  if (!(feeSol > 0) || !(e.sizeSol > 0)) return 0;
  // Entry: sizeUsd is what was spent in SOL. Exit: sizeUsd is proceeds AFTER fees, sizeSol the gross SOL out.
  const solUsd = e.eventType === "entry" ? e.sizeUsd / e.sizeSol : e.sizeUsd / Math.max(1e-12, e.sizeSol - feeSol);
  return Number.isFinite(solUsd) ? feeSol * solUsd : 0;
}

function allTradeEvents(FILES) {
  let files;
  try {
    files = fs.readdirSync(FILES.tradesDir).filter((f) => /^trades-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  return files.flatMap((f) => readJsonl(path.join(FILES.tradesDir, f)));
}

function feeLedger(FILES) {
  const byPos = new Map(); // positionId → { entry, exits: [{ e, fee }], total }
  const timeline = []; // [{ t, fee }] ascending
  let total = 0;
  for (const e of allTradeEvents(FILES)) {
    const fee = eventFeeUsd(e);
    const pos = byPos.get(e.positionId) ?? { entry: 0, exits: [], total: 0 };
    if (e.eventType === "entry") pos.entry += fee;
    else pos.exits.push({ e, fee });
    pos.total += fee;
    byPos.set(e.positionId, pos);
    if (fee > 0) timeline.push({ t: Date.parse(e.timestamp), fee });
    total += fee;
  }
  timeline.sort((a, b) => a.t - b.t);
  return { byPos, timeline, total };
}

function applyFeeFree(state, FILES) {
  const L = feeLedger(FILES);
  if (!(L.total > 0)) return;
  const s = state.summary;

  // Closed trades: the whole position's fees back.
  state.closedTrades = state.closedTrades.map((t) => {
    const fee = L.byPos.get(t.positionId)?.total ?? 0;
    const pnl = t.realizedPnlUsd + fee;
    return { ...t, realizedPnlUsd: pnl, realizedPnlPct: t.initialSizeUsd > 0 ? (pnl / t.initialSizeUsd) * 100 : t.realizedPnlPct };
  });

  // Open positions: the entry fee is in the remaining basis pro rata; the rest is realized.
  let openEntryShare = 0;
  state.positions = state.positions.map((p) => {
    const pos = L.byPos.get(p.id);
    if (!pos) return p;
    const remaining = p.tokensInitial > 0 ? p.tokensRemaining / p.tokensInitial : 1;
    openEntryShare += pos.entry * remaining;
    const exitFees = pos.exits.reduce((a, x) => a + x.fee, 0);
    return { ...p, costBasisRemainingUsd: p.costBasisRemainingUsd - pos.entry * remaining, realizedPnlUsd: p.realizedPnlUsd + exitFees + pos.entry * (1 - remaining) };
  });

  // Fill log: each exit gets its own fee back plus a proceeds-weighted share of the entry fee.
  state.trades = state.trades.map((e) => {
    if (e.eventType === "entry") return e;
    const pos = L.byPos.get(e.positionId);
    if (!pos) return e;
    const own = eventFeeUsd(e);
    const proceeds = pos.exits.reduce((a, x) => a + x.e.sizeUsd, 0);
    const entryShare = proceeds > 0 ? pos.entry * (e.sizeUsd / proceeds) : 0;
    const pnl = (e.realizedPnlUsd ?? 0) + own + entryShare;
    const basis = e.realizedPnlPct ? (e.realizedPnlUsd ?? 0) / (e.realizedPnlPct / 100) : null;
    return { ...e, sizeUsd: e.sizeUsd + own, realizedPnlUsd: pnl, realizedPnlPct: basis ? (pnl / (basis - entryShare)) * 100 : e.realizedPnlPct };
  });

  // Equity curve: every sample gets the fees paid up to its time back.
  let i = 0;
  let cum = 0;
  state.equity = state.equity.map((smp) => {
    while (i < L.timeline.length && L.timeline[i].t <= smp.t) cum += L.timeline[i++].fee;
    return { ...smp, equity: smp.equity + cum, cash: smp.cash + cum, bankroll: smp.bankroll + cum, realized: smp.realized + cum };
  });

  if (!s) return;
  const F = L.total;
  const dayStart = Date.parse(new Date().toISOString().slice(0, 10));
  const feesToday = L.timeline.filter((x) => x.t >= dayStart).reduce((a, x) => a + x.fee, 0);
  const dayBankroll = s.dailyRealizedPnlPct ? s.dailyRealizedPnlUsd / (s.dailyRealizedPnlPct / 100) : null;
  const closed = state.closedTrades;
  const wins = closed.filter((t) => t.realizedPnlUsd > 0);
  const losses = closed.filter((t) => t.realizedPnlUsd <= 0);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  let peak = s.startingBankrollUsd;
  let maxDd = 0;
  for (const smp of state.equity) {
    peak = Math.max(peak, smp.equity);
    maxDd = Math.min(maxDd, ((smp.equity - peak) / peak) * 100);
  }
  const equityUsd = s.equityUsd + F;
  peak = Math.max(peak, equityUsd);
  const currentDd = Math.min(0, ((equityUsd - peak) / peak) * 100);
  state.summary = {
    ...s,
    equityUsd,
    cashUsd: s.cashUsd + F,
    bankrollUsd: s.bankrollUsd + F - openEntryShare,
    realizedPnlUsd: s.realizedPnlUsd + F - openEntryShare,
    unrealizedPnlUsd: s.unrealizedPnlUsd + openEntryShare,
    dailyRealizedPnlUsd: s.dailyRealizedPnlUsd + feesToday,
    dailyRealizedPnlPct: dayBankroll ? ((s.dailyRealizedPnlUsd + feesToday) / dayBankroll) * 100 : s.dailyRealizedPnlPct,
    peakEquityUsd: peak,
    currentDrawdownPct: currentDd,
    maxDrawdownPct: Math.min(maxDd, currentDd),
    tradeCount: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    averageWinUsd: avg(wins.map((t) => t.realizedPnlUsd)),
    averageLossUsd: avg(losses.map((t) => t.realizedPnlUsd)),
    averageWinPct: avg(wins.map((t) => t.realizedPnlPct)),
    averageLossPct: avg(losses.map((t) => t.realizedPnlPct)),
    totalFeesUsd: 0,
    feesExcludedUsd: F,
  };
}

/** Which books have written a summary yet (the page only offers those). */
function availableBooks() {
  return Object.keys(BOOKS).map((id) => ({ id, available: fs.existsSync(filesFor(id).summary) }));
}

function buildState(book, excludeFees) {
  const FILES = filesFor(book);
  const summary = readJson(FILES.summary);
  const portfolio = readJson(FILES.positions);
  const events = readJson(FILES.events);
  let summaryAgeMs = null;
  if (summary && summary.generatedAt) summaryAgeMs = Date.now() - Date.parse(summary.generatedAt);
  const state = {
    serverTime: Date.now(),
    book,
    books: availableBooks(),
    summaryAgeMs,
    summary,
    positions: portfolio ? portfolio.positions || [] : [],
    closedTrades: portfolio ? portfolio.closedTrades || [] : [],
    events: events ? events.events || [] : [],
    equity: readJsonl(FILES.equity, EQUITY_MAX_SAMPLES),
    trades: readTradeEvents(FILES),
  };
  if (excludeFees) applyFeeFree(state, FILES);
  state.fees = excludeFees ? "excluded" : "included";
  return state;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/api/state") {
    const book = url.searchParams.get("book") || DEFAULT_BOOK;
    if (!Object.prototype.hasOwnProperty.call(BOOKS, book)) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: `unknown book ${book}` }));
      return;
    }
    let body;
    try {
      // Fixed fees are excluded unless the page asks for them (?fees=include).
      body = JSON.stringify(buildState(book, url.searchParams.get("fees") !== "include"));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(body);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(HTML, (err, html) => {
      if (err) {
        res.writeHead(500).end("dashboard/index.html missing");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    });
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`simulation_trading_bot_v1 dashboard (read-only) → http://localhost:${PORT}`);
  for (const [id, dir] of Object.entries(BOOKS)) console.log(`  ${id}  ${dir}`);
});
