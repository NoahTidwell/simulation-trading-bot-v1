// Discord alerts for the v1.4 and v1.5 books (read-only watcher; never touches the bot).
// Bot offline and data outage are bot-wide; the other alerts run per book and name the book.
//
//   npm run alerts            run forever, checking once a minute
//   node alerts/alerts.js --test    send one test message and exit
//
// Needs DISCORD_WEBHOOK_URL in the project's .env (never committed). Without it,
// alerts are printed to the console instead of sent.
//
// Alerts
//   Bot offline      no summary update for 5+ minutes (and a recovery message)
//   Data outage      5+ security checks failing on RugCheck errors within 15 minutes (and recovery)
//   Losing streak    three finished 3-hour cards in a row graded F (and each further F while it lasts)
//   Big loss         the day's equity down 5%+ (once a day), or any trade closing at −30% or worse
//   Big winner       any trade closing at +50% or better
//   Daily summary    after midnight: the day's grade, result and equity (with the written review when ready)

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { activeIds } = require("../dashboard/books.js"); // books come from data/books.json
let BOOK = "v1.4";
let BOOK_DIR = path.join(ROOT, "data", BOOK);
let CARDS = path.join(ROOT, "data", "report-cards", BOOK);
function setBook(b) { BOOK = b; BOOK_DIR = path.join(ROOT, "data", b); CARDS = path.join(ROOT, "data", "report-cards", b); }
const STATE_FILE = path.join(ROOT, "data", "alerts", "state.json");
const DASHBOARD = "http://localhost:4546";
const SHARED = "https://claude.ai/artifact/2LTnu3sXugSV96cCBGS7La";

const T = { streakFs: 3, offlineMin: 5, outageFailures: 5, outageWindowMin: 15, dayLossPct: -5, tradeLossPct: -30, tradeWinPct: 50 };
const COLOR = { red: 0xc42b2b, orange: 0xe07b24, green: 0x1d8a4e, blue: 0x1f6db4, grey: 0x7c8594 };

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const WEBHOOK = envValue("DISCORD_WEBHOOK_URL");

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const loadState = () => readJson(STATE_FILE, { seenTrades: [], offline: false, outage: false, streakCard: null, dayLossDay: null, summaryDays: [], started: Date.now() });
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  s.seenTrades = s.seenTrades.slice(-2000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}
const usd = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
const hm = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

async function send(title, description, color, fields = []) {
  const embed = { title, description, color, fields, footer: { text: "v1.4 simulated bot · paper money" }, timestamp: new Date().toISOString() };
  if (!WEBHOOK) {
    console.log(`[alert (no webhook set)] ${title} — ${description}`);
    return true;
  }
  try {
    const res = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "v1.4 Bot", embeds: [embed] }) });
    if (!res.ok) { console.error(`${new Date().toLocaleString()} discord ${res.status}: ${await res.text()}`); return false; }
    console.log(`${new Date().toLocaleString()} sent: ${title}`);
    return true;
  } catch (e) {
    console.error(`${new Date().toLocaleString()} discord send failed: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------- checks

async function checkOffline(st) {
  const s = readJson(path.join(BOOK_DIR, "trades", "summary.json"));
  const ageMin = s ? (Date.now() - Date.parse(s.generatedAt)) / 60000 : Infinity;
  if (ageMin >= T.offlineMin && !st.offline) {
    if (await send("🔴 Bot offline", `No update from the bot for ${Number.isFinite(ageMin) ? Math.round(ageMin) + " minutes" : "a while"}. It may have crashed or the PC may be asleep.`, COLOR.red)) st.offline = true;
  } else if (ageMin < T.offlineMin && st.offline) {
    if (await send("✅ Bot back online", `Updates resumed. Equity $${s.equityUsd.toFixed(2)}, ${s.openPositions} open.`, COLOR.green)) st.offline = false;
  }
}

async function checkOutage(st) {
  const tail = readJson(path.join(BOOK_DIR, "positions", "event-tail.json"), {});
  const events = tail.events || [];
  const since = Date.now() - T.outageWindowMin * 60000;
  const fails = events.filter((e) => e.t >= since && /gate REJECT .*rugcheck: (HTTP|timeout)/.test(e.msg || "")).length;
  if (fails >= T.outageFailures && !st.outage) {
    if (await send("🔴 Data outage: RugCheck failing", `${fails} security checks failed on RugCheck errors in the last ${T.outageWindowMin} minutes. The bot rejects every coin it cannot check, so trading is effectively paused.`, COLOR.red)) st.outage = true;
  } else if (fails === 0 && st.outage) {
    if (await send("✅ RugCheck recovered", "No RugCheck failures in the last 15 minutes. Trading can resume normally.", COLOR.green)) st.outage = false;
  }
}

async function checkStreak(st) {
  let files;
  try { files = fs.readdirSync(CARDS).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(f)).sort(); } catch { return; }
  const newest = files.length ? readJson(path.join(CARDS, files[files.length - 1])) : null;
  if (!newest || st.streakCard === newest.id) return;
  const isF = (c) => c && c.grade[0] === "F";
  let n = 0;
  for (let i = files.length - 1; i >= 0; i--) { if (isF(readJson(path.join(CARDS, files[i])))) n++; else break; }
  if (n >= T.streakFs) {
    if (await send(`🟠 ${BOOK} losing streak: ${n} F periods in a row`, `Latest ${hm(newest.start)}–${hm(newest.end)}: **${newest.grade}** (${newest.score}), equity ${newest.stats.returnPct.toFixed(2)}% to $${newest.stats.endEquity.toFixed(2)}.\n${DASHBOARD}`, COLOR.orange)) st.streakCard = newest.id;
  } else {
    st.streakCard = newest.id;
  }
}

async function checkTrades(st) {
  const port = readJson(path.join(BOOK_DIR, "positions", "open-positions.json"), {});
  const seen = new Set(st.seenTrades);
  for (const t of port.closedTrades || []) {
    const key = `${t.positionId || t.id || t.tokenAddress}:${t.closedAt}`;
    if (seen.has(key)) continue;
    st.seenTrades.push(key); seen.add(key);
    if (t.closedAt < st.started) continue; // don't announce history on first run
    const pct = t.realizedPnlPct;
    if (pct <= T.tradeLossPct) {
      await send(`🟠 ${BOOK} big loss: ${t.symbol} ${pct.toFixed(1)}%`, `Closed ${hm(t.closedAt)} on ${t.finalExitReason}, ${usd(t.realizedPnlUsd)} after ${Math.round((t.closedAt - t.openedAt) / 60000)} min.${pct <= -90 ? " Looks like a rug pull." : ""}`, COLOR.orange);
    } else if (pct >= T.tradeWinPct) {
      await send(`🟢 ${BOOK} big winner: ${t.symbol} +${pct.toFixed(1)}%`, `Closed ${hm(t.closedAt)} on ${t.finalExitReason}, ${usd(t.realizedPnlUsd)} in ${Math.round((t.closedAt - t.openedAt) / 60000)} min.`, COLOR.green);
    }
  }
}

async function checkDayLoss(st) {
  const eq = fs.existsSync(path.join(BOOK_DIR, "trades", "equity.jsonl")) ? fs.readFileSync(path.join(BOOK_DIR, "trades", "equity.jsonl"), "utf8").trim().split("\n") : [];
  if (eq.length < 2) return;
  const now = new Date(), midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayKey = new Date(midnight).toDateString();
  if (st.dayLossDay === dayKey) return;
  let startEq = null;
  for (const line of eq) { try { const s = JSON.parse(line); if (s.t < midnight) startEq = s.equity; else { if (startEq === null) startEq = s.equity; break; } } catch {} }
  const cur = JSON.parse(eq[eq.length - 1]).equity;
  if (!startEq) return;
  const pct = ((cur - startEq) / startEq) * 100;
  if (pct <= T.dayLossPct) {
    if (await send(`🟠 ${BOOK} down ${Math.abs(pct).toFixed(1)}% today`, `Equity $${startEq.toFixed(2)} at midnight → $${cur.toFixed(2)} now (${usd(cur - startEq)}).`, COLOR.orange)) st.dayLossDay = dayKey;
  }
}

async function checkDailySummary(st) {
  let files;
  try { files = fs.readdirSync(path.join(CARDS, "daily")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return; }
  const f = files.at(-1);
  if (!f) return;
  const d = readJson(path.join(CARDS, "daily", f));
  if (!d || st.summaryDays.includes(d.id)) return;
  if (d.gradedAt < st.started - 6 * 3600e3) { st.summaryDays.push(d.id); return; } // old day on first run
  // Wait up to 20 minutes for the written review, then send regardless.
  if (!d.review && Date.now() - d.gradedAt < 20 * 60000) return;
  const s = d.stats;
  const color = { A: COLOR.green, B: COLOR.blue, C: COLOR.orange, D: COLOR.orange, F: COLOR.red }[d.grade[0]] || COLOR.grey;
  const fields = [
    { name: "Daily grade (average)", value: `**${d.grade}** · ${d.score}/100`, inline: true },
    { name: "Result", value: `**${d.resultGrade}** · ${s.returnPct >= 0 ? "+" : ""}${s.returnPct.toFixed(2)}%`, inline: true },
    { name: "Equity", value: `$${s.startEquity.toFixed(2)} → $${s.endEquity.toFixed(2)}`, inline: true },
    { name: "Trades", value: `${s.closedTrades} closed · ${s.wins} won`, inline: true },
    { name: "Hard stops", value: `${s.hardStops} · ${usd(s.hardStopUsd)}`, inline: true },
    { name: "Periods", value: d.periods.map((p) => p.grade).join(" "), inline: true },
  ];
  const review = d.review ? d.review.text.slice(0, 900) + (d.review.text.length > 900 ? "…" : "") : "Written review not ready yet.";
  if (await send(`📋 ${BOOK} daily review · ${new Date(d.start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`, `${review}\n\n${SHARED}`, color, fields)) st.summaryDays.push(d.id);
}

async function cycle() {
  const st = loadState();
  setBook("v1.4");
  for (const check of [checkOffline, checkOutage]) {
    try { await check(st); } catch (e) { console.error(`${new Date().toLocaleString()} ${check.name} failed: ${e.message}`); }
  }
  // Per-book state; v1.4's lives in the original top-level fields so nothing already sent repeats.
  st.books ||= {};
  for (const b of activeIds()) {
    if (!fs.existsSync(path.join(ROOT, "data", b, "trades", "summary.json"))) continue;
    const bs = b === "v1.4" ? st : (st.books[b] ||= { seenTrades: [], streakCard: null, dayLossDay: null, summaryDays: [], started: Date.now() });
    setBook(b);
    for (const check of [checkTrades, checkDayLoss, checkStreak, checkDailySummary]) {
      try { await check(bs); } catch (e) { console.error(`${new Date().toLocaleString()} [${b}] ${check.name} failed: ${e.message}`); }
    }
    if (bs !== st) bs.seenTrades = bs.seenTrades.slice(-2000);
  }
  saveState(st);
}

if (process.argv.includes("--test")) {
  send("✅ Alerts connected", "The v1.4 alert service can post to this channel. You'll get offline/outage warnings, losing streaks, big losses, big winners and a daily summary.", COLOR.green)
    .then((ok) => { process.exitCode = ok ? 0 : 1; });
} else {
  console.log(`${activeIds().join(" + ")} alerts: ${WEBHOOK ? "posting to Discord" : "NO DISCORD_WEBHOOK_URL in .env — printing only"}; checking every 60 s`);
  cycle();
  setInterval(cycle, 60000);
}
