// Report-card service for simulation_trading_bot_v1. Grades every book the bot is trading
// (data/books.json, via dashboard/books.js); retired books keep their existing cards on view.
//
// A separate, read-only process. Every 3 hours (12 AM, 3 AM, 6 AM, ... local time) it grades
// the period that just ended and saves the card to data/report-cards/<book>/<period>.json, and
// after midnight a daily card to data/report-cards/<book>/daily/<date>.json. On start it
// backfills every finished period since each book began. It also serves the dashboard, the
// provisional card for the period in progress, and the Replay Lab results.
//
//   npm run report-cards      → http://localhost:4546   (API: /api/cards?book=v1.4|v1.5)

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PERIOD_MS, DAY_PERIODS, periodOf, periodId, dayOf, dayId, loadBook, gradePeriod, gradeDay } = require("./grading.js");

const { activeIds, readBooks } = require("../dashboard/books.js");
/** Books being graded: every book the bot trades. */
const gradedBooks = () => activeIds();
/** Books shown on the page: graded books plus retired books that already have cards. */
const viewBooks = () => [...new Set([...gradedBooks(), ...readBooks().retired.map((b) => b.id).filter((id) => { try { return fs.readdirSync(cardsDir(id)).some((f) => f.endsWith(".json")); } catch { return false; } })])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
/** Default book: the oldest one still graded. */
const defaultBook = () => gradedBooks()[0] || viewBooks()[0] || "v1.4";
const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(__dirname, "index.html");
const PORT = Number(process.env.REPORT_CARDS_PORT || 4546);
const HOST = "127.0.0.1";
const GRACE_MS = 2 * 60 * 1000; // wait for the bot's last samples of a period before grading it

const cardsDir = (book) => path.join(ROOT, "data", "report-cards", book);
const daysDir = (book) => path.join(cardsDir(book), "daily");
const cardFile = (id, book = defaultBook()) => path.join(cardsDir(book), `${id}.json`);
const dayFile = (id, book = defaultBook()) => path.join(daysDir(book), `${id}.json`);
const hasData = (book) => fs.existsSync(path.join(ROOT, "data", book, "trades", "summary.json"));

function writeCard(card) {
  const book = card.book || defaultBook();
  fs.mkdirSync(daysDir(book), { recursive: true });
  const file = card.kind === "day" ? dayFile(card.id, book) : cardFile(card.id, book);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(card, null, 2));
  fs.renameSync(tmp, file);
}
function readCard(id, book = defaultBook()) {
  try { return JSON.parse(fs.readFileSync(cardFile(id, book), "utf8")); } catch { return null; }
}
function listCards(book = defaultBook()) {
  if (!fs.existsSync(cardsDir(book))) return [];
  return fs.readdirSync(cardsDir(book)).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(f)).sort()
    .map((f) => readCard(f.slice(0, -5), book)).filter(Boolean);
}
function readDay(id, book = defaultBook()) {
  try { return JSON.parse(fs.readFileSync(dayFile(id, book), "utf8")); } catch { return null; }
}
function listDays(book = defaultBook()) {
  if (!fs.existsSync(daysDir(book))) return [];
  return fs.readdirSync(daysDir(book)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .map((f) => readDay(f.slice(0, -5), book)).filter(Boolean);
}

/** Save a daily card for every day whose 8 period cards all exist. Existing daily cards are kept. */
function gradeDays(data, book, log = true) {
  const byDay = new Map();
  for (const c of listCards(book)) { const k = dayId(c.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(c); }
  const made = [];
  for (const [id, cs] of byDay) {
    if (cs.length < DAY_PERIODS || fs.existsSync(dayFile(id, book))) continue;
    const day = gradeDay(data, cs, cs[0].start);
    writeCard(day);
    made.push(day);
    if (log) console.log(`${new Date().toLocaleString()}  [${book}] daily card ${id}: ${day.grade} (avg ${day.score}), result ${day.resultGrade} (${day.stats.returnPct.toFixed(2)}%)`);
  }
  return made;
}

/** Grade every finished period (all books) that has no card yet. Existing cards and reviews are kept. */
function gradeFinished(log = true, books = gradedBooks()) {
  const made = [];
  for (const book of books) {
    if (!hasData(book)) continue;
    const data = loadBook(book);
    const now = Date.now();
    for (let { start } = periodOf(data.start); start + PERIOD_MS + GRACE_MS <= now; start += PERIOD_MS) {
      const probe = periodOf(start);
      if (fs.existsSync(cardFile(periodId(probe.start), book))) continue;
      const card = gradePeriod(data, probe.start, probe.end, now);
      writeCard(card);
      made.push(card);
      if (log) console.log(`${new Date().toLocaleString()}  [${book}] graded ${card.id}: ${card.grade} (${card.score})`);
    }
    gradeDays(data, book, log);
  }
  return made;
}

const currentCache = new Map();
function currentCard(book = defaultBook()) {
  const c = currentCache.get(book);
  if (c && Date.now() - c.at < 30000) return c.card;
  const { start, end } = periodOf(Date.now());
  const card = gradePeriod(loadBook(book), start, end);
  currentCache.set(book, { at: Date.now(), card });
  return card;
}

function botStatus(book = defaultBook()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "data", book, "trades", "summary.json"), "utf8"));
    const age = Date.now() - Date.parse(s.generatedAt);
    return { live: age < 5 * 60000, summaryAgeMs: age, equityUsd: s.equityUsd, startingBankrollUsd: s.startingBankrollUsd, openPositions: s.openPositions };
  } catch {
    return { live: false, summaryAgeMs: null };
  }
}

/** Replay Lab results (replay-lab/results/*.json from scripts/replay.ts --json), merged by variant name. */
function loadLab() {
  const dir = path.join(ROOT, "replay-lab", "results");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return null; }
  const runs = files.map((f) => { try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }; } catch { return null; } }).filter(Boolean);
  if (!runs.length) return null;
  const variants = new Map();
  for (const r of runs) for (const v of r.variants) if (!variants.has(v.name)) variants.set(v.name, { ...v, run: r.file });
  const r0 = runs[0];
  return { book: r0.book, from: r0.from, to: r0.to, slipPct: r0.slipPct, live: r0.live, generatedAt: Math.max(...runs.map((r) => r.generatedAt)), variants: [...variants.values()] };
}

/** Everything the page shows for one book: saved cards, the period in progress, today so far and status. */
function apiPayload(book = defaultBook()) {
  const view = viewBooks(), graded = new Set(gradedBooks()), info = readBooks();
  if (!view.includes(book)) book = defaultBook();
  const describe = (id) => [...info.active, ...info.retired].find((b) => b.id === id)?.description || "";
  const base = { book, books: view.map((id) => ({ id, available: hasData(id), retired: !graded.has(id), description: describe(id) })), lab: loadLab(), serverTime: Date.now(), nextGradeAt: periodOf(Date.now()).end + GRACE_MS };
  if (!hasData(book)) return { ...base, cards: [], days: [], today: null, current: null, status: { live: false, summaryAgeMs: null } };
  const cards = listCards(book);
  const data = loadBook(book);
  // In the grace window right after a period ends, its card isn't saved yet: show a preliminary one.
  const prev = periodOf(Date.now() - PERIOD_MS);
  if (!cards.some((c) => c.id === periodId(prev.start)) && prev.end > data.start) {
    cards.push({ ...gradePeriod(data, prev.start, prev.end), pending: true, finalAt: prev.end + GRACE_MS });
  }
  // Today so far: a provisional daily card from today's finished periods.
  const today = dayOf(Date.now());
  const days = listDays(book);
  const todayCard = days.some((d) => d.id === dayId(today.start)) ? null : gradeDay(data, cards, today.start);
  return { ...base, cards, days, today: todayCard, current: currentCard(book), status: botStatus(book) };
}

const send = (res, code, body, type = "application/json; charset=utf-8") =>
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method !== "GET") return send(res, 405, { error: "read-only" });
  try {
    if (url.pathname === "/api/cards") return send(res, 200, apiPayload(url.searchParams.get("book") || defaultBook()));
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return fs.readFile(HTML, (err, html) => (err ? send(res, 500, "report-cards/index.html missing", "text/plain") : send(res, 200, html, "text/html; charset=utf-8")));
    }
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
  send(res, 404, { error: "not found" });
});

if (require.main === module) {
  const made = gradeFinished(false);
  console.log(`Report cards: ${gradedBooks().map((b) => `${b} ${hasData(b) ? listCards(b).length : "no data yet"}`).join(", ")} (${made.length} new).`);
  // Check once a minute; a period is graded two minutes after it ends.
  setInterval(() => { try { gradeFinished(); } catch (e) { console.error("grading failed:", e.message); } }, 60000);
  server.listen(PORT, HOST, () => console.log(`Report cards (read-only) → http://localhost:${PORT}`));
}

module.exports = { gradedBooks, viewBooks, defaultBook, cardFile, readCard, writeCard, listCards, readDay, listDays, gradeFinished, apiPayload, hasData };
