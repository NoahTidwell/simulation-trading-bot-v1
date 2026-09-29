// Report-card grading for one strategy book over one 3-hour period.
//
// Reads only the files the bot writes (through the dashboard's helpers) and works in the
// fee-free view: every fill's fixed SOL fee is added back, so grades measure strategy quality.
//
// Score out of 100:
//   Returns      40  equity change over the period (includes open positions), -4% → 0, 0% → 20, +4% → 40
//   Trade quality 25  profit factor of positions closed in the period (neutral when there are fewer than 3)
//   Risk control  20  deepest equity drawdown inside the period (-8% → 0), minus 2 per hard stop
//   Activity      15  entries vs. the target pace
// Uptime below 50% of the period caps the grade at D; a tripped circuit breaker or daily loss limit costs 10.

"use strict";

const { filesFor, readJson, readJsonl, allTradeEvents, eventFeeUsd, feeLedger } = require("../dashboard/server.js");

const PERIOD_MS = 3 * 3600 * 1000;
const TARGET_ENTRIES = 4; // v1.4 has averaged about 4 entries per 3 hours

const REASONS = { noFollowThrough: "no follow-through", maxHoldTime: "max hold time", trailingStop: "trailing stop", hardStop: "hard stop", velocityEjection: "velocity ejection", takeProfitTier1: "take-profit 1", takeProfitTier2: "take-profit 2" };
const reasonText = (r) => REASONS[r] || r;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Local-clock period containing time t: [start, end), aligned to 12 AM, 3 AM, 6 AM, ... */
function periodOf(t) {
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(d.getHours() / 3) * 3).getTime();
  return { start, end: start + PERIOD_MS };
}
const periodId = (start) => {
  const d = new Date(start), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
};

function letter(score) {
  const cuts = [[95, "A+"], [88, "A"], [84, "A-"], [80, "B+"], [75, "B"], [71, "B-"], [67, "C+"], [62, "C"], [58, "C-"], [50, "D"]];
  for (const [c, l] of cuts) if (score >= c) return l;
  return "F";
}

/** Load everything a card needs for one book, once (cards for many periods reuse it). */
function loadBook(book) {
  const FILES = filesFor(book);
  const events = allTradeEvents(FILES).map((e) => ({ ...e, t: Date.parse(e.timestamp) })).sort((a, b) => a.t - b.t);
  const L = feeLedger(FILES);
  // Fee-free realized P&L for each exit/scale-out: its own fee back plus a proceeds-weighted share of the entry fee.
  for (const e of events) {
    if (e.eventType === "entry") continue;
    const pos = L.byPos.get(e.positionId);
    const proceeds = pos ? pos.exits.reduce((a, x) => a + x.e.sizeUsd, 0) : 0;
    const entryShare = pos && proceeds > 0 ? pos.entry * (e.sizeUsd / proceeds) : 0;
    e.pnl = (e.realizedPnlUsd ?? 0) + eventFeeUsd(e) + entryShare;
  }
  let i = 0, cum = 0;
  const equity = readJsonl(FILES.equity).map((s) => {
    while (i < L.timeline.length && L.timeline[i].t <= s.t) cum += L.timeline[i++].fee;
    return { t: s.t, equity: s.equity + cum, open: s.open };
  });
  const summary = readJson(FILES.summary);
  return { book, events, equity, summary, start: equity.length ? equity[0].t : events[0]?.t ?? Date.now() };
}

/** Grade one book for the period [start, end). `now` lets the current period be graded as provisional. */
function gradePeriod(data, start, end, now = Date.now()) {
  const upto = Math.min(end, now);
  const provisional = now < end;
  const span = upto - Math.max(start, data.start);

  // Equity over the period.
  const inP = data.equity.filter((s) => s.t >= start && s.t < upto);
  const before = data.equity.filter((s) => s.t < start).at(-1);
  const startEq = before?.equity ?? inP[0]?.equity ?? null;
  const endEq = inP.at(-1)?.equity ?? startEq;
  const retPct = startEq ? ((endEq - startEq) / startEq) * 100 : 0;
  let peak = startEq ?? 0, maxDd = 0;
  for (const s of inP) { peak = Math.max(peak, s.equity); if (peak > 0) maxDd = Math.min(maxDd, ((s.equity - peak) / peak) * 100); }
  // Uptime: the share of the period not inside a gap of more than 3 minutes between equity samples.
  let down = 0, prevT = Math.max(start, data.start);
  for (const s of inP) { if (s.t - prevT > 180000) down += s.t - prevT; prevT = s.t; }
  if (upto - prevT > 180000) down += upto - prevT;
  const uptimePct = span > 0 ? clamp((1 - down / span) * 100, 0, 100) : 0;

  // Fills in the period.
  const ev = data.events.filter((e) => e.t >= start && e.t < upto);
  const entries = ev.filter((e) => e.eventType === "entry");
  const exitsAll = ev.filter((e) => e.eventType !== "entry");
  const realized = exitsAll.reduce((a, e) => a + (e.pnl || 0), 0);

  // Positions whose final exit landed in the period, with P&L across all their exits.
  const closedIds = new Set(ev.filter((e) => e.eventType === "exit").map((e) => e.positionId));
  const closed = [...closedIds].map((id) => {
    const all = data.events.filter((e) => e.positionId === id);
    const entry = all.find((e) => e.eventType === "entry");
    const exits = all.filter((e) => e.eventType !== "entry");
    const pnl = exits.reduce((a, e) => a + (e.pnl || 0), 0);
    const final = exits.filter((e) => e.eventType === "exit").at(-1);
    const cost = entry?.sizeUsd || null;
    return { id, symbol: final?.symbol || entry?.symbol, pnl, pct: cost ? (pnl / cost) * 100 : null, reason: final?.exitReason, holdMin: entry ? (final.t - entry.t) / 60000 : null, closedAt: final?.t };
  });
  const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0);
  const grossWin = wins.reduce((a, c) => a + c.pnl, 0), grossLoss = -losses.reduce((a, c) => a + c.pnl, 0);
  const pf = closed.length ? (grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0) : null;
  const reasons = {};
  for (const e of ev.filter((x) => x.eventType === "exit")) reasons[e.exitReason] = (reasons[e.exitReason] || 0) + 1;
  const hardStops = reasons.hardStop || 0;
  const openAtEnd = inP.at(-1)?.open ?? before?.open ?? 0;

  // Scores.
  const sReturn = 40 * clamp((retPct + 4) / 8, 0, 1);
  const pfScore = pf == null ? 12.5 : pf >= 2 ? 25 : pf >= 1 ? 10 + 15 * (pf - 1) : pf >= 0.5 ? 20 * (pf - 0.5) : 0;
  const sQuality = 12.5 + Math.min(1, closed.length / 3) * (pfScore - 12.5);
  const sRisk = clamp(20 * clamp(1 + maxDd / 8, 0, 1) - 2 * hardStops, 0, 20);
  const targetEntries = TARGET_ENTRIES * (span / PERIOD_MS);
  const sActivity = targetEntries > 0 ? 15 * Math.min(1, entries.length / targetEntries) : 0;
  let score = sReturn + sQuality + sRisk + sActivity;
  const flags = [];
  const s = data.summary;
  if (uptimePct < 50) { flags.push(`Bot was offline for ${Math.round(100 - uptimePct)}% of the period.`); score = Math.min(score, 57); }
  const cbTripped = provisional && s && (s.circuitBreakerTripped || s.dailyLossLimitHit);
  if (cbTripped) { score -= 10; flags.push(s.circuitBreakerTripped ? "Circuit breaker is tripped." : "Daily loss limit is hit."); }
  score = clamp(score, 0, 100);

  // Plain-language notes, most important first.
  const usd = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
  const notes = [...flags];
  notes.push(`Equity ${retPct >= 0 ? "rose" : "fell"} ${Math.abs(retPct).toFixed(2)}% (${usd(endEq - startEq)}), with ${usd(realized)} realized from ${exitsAll.length} exit${exitsAll.length === 1 ? "" : "s"} and scale-outs.`);
  if (!entries.length) notes.push("No new entries. The filters found nothing that qualified.");
  else if (entries.length < targetEntries * 0.5) notes.push(`Only ${entries.length} entr${entries.length === 1 ? "y" : "ies"} against a pace of about ${Math.round(targetEntries)}.`);
  if (closed.length >= 3) notes.push(`${wins.length} of ${closed.length} closed trades won; profit factor ${pf === Infinity ? "∞ (no losers)" : pf.toFixed(2)}.`);
  if (hardStops) notes.push(`${hardStops} hard stop${hardStops > 1 ? "s" : ""} (−25%) hit.`);
  const nft = reasons.noFollowThrough || 0, exitsN = Object.values(reasons).reduce((a, b) => a + b, 0);
  if (exitsN >= 3 && nft / exitsN >= 0.5) notes.push(`${nft} of ${exitsN} exits were "no follow-through": entries are stalling right after the buy.`);
  if (maxDd <= -3) notes.push(`Deepest drawdown inside the period was ${maxDd.toFixed(2)}%.`);
  const best = [...closed].sort((a, b) => b.pnl - a.pnl)[0], worst = [...closed].sort((a, b) => a.pnl - b.pnl)[0];
  if (best && best.pnl > 0) notes.push(`Best trade: ${best.symbol} ${usd(best.pnl)}${best.pct != null ? ` (${best.pct >= 0 ? "+" : ""}${best.pct.toFixed(1)}%)` : ""}, ${reasonText(best.reason)}.`);
  if (worst && worst.pnl < 0) notes.push(`Worst trade: ${worst.symbol} ${usd(worst.pnl)}${worst.pct != null ? ` (${worst.pct.toFixed(1)}%)` : ""}, ${reasonText(worst.reason)}.`);

  return {
    id: periodId(start), book: data.book, start, end, provisional, gradedAt: now,
    grade: letter(score), score: Math.round(score * 10) / 10,
    subjects: [
      { key: "returns", label: "Returns", score: sReturn, max: 40 },
      { key: "quality", label: "Trade quality", score: sQuality, max: 25 },
      { key: "risk", label: "Risk control", score: sRisk, max: 20 },
      { key: "activity", label: "Activity", score: sActivity, max: 15 },
    ].map((x) => ({ ...x, score: Math.round(x.score * 10) / 10, grade: letter((x.score / x.max) * 100) })),
    stats: {
      startEquity: startEq, endEquity: endEq, returnPct: retPct, realizedUsd: realized, maxDrawdownPct: maxDd, uptimePct,
      entries: entries.length, exits: exitsAll.length, closedTrades: closed.length, wins: wins.length, losses: losses.length,
      winRatePct: closed.length ? (wins.length / closed.length) * 100 : null, profitFactor: pf === Infinity ? null : pf, profitFactorInfinite: pf === Infinity,
      avgWinUsd: wins.length ? grossWin / wins.length : null, avgLossUsd: losses.length ? -grossLoss / losses.length : null,
      hardStops, openAtEnd, exitReasons: reasons,
    },
    trades: closed.sort((a, b) => a.closedAt - b.closedAt),
    equityPath: inP.filter((_, k) => k % 3 === 0 || k === inP.length - 1).map((x) => [x.t, Math.round(x.equity * 100) / 100]),
    notes,
    review: null,
  };
}

// ---------------------------------------------------------------------------- daily cards

const DAY_PERIODS = 8;
/** Local calendar day containing t: [start, end), midnight to midnight. */
function dayOf(t) {
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { start, end };
}
const dayId = (start) => periodId(start).slice(0, 10);

/**
 * Daily card: the grade is the AVERAGE of the day's eight 3-hour scores (how consistently the
 * strategy performed). Because an average can disagree with the money made (one +13% period can
 * carry a day of weak ones), the card also carries a result grade from the day's equity change:
 * −8% → 0, 0% → 50, +8% → 100.
 * With fewer than 8 finished periods the card is provisional (the day so far).
 */
function gradeDay(data, periodCards, dayStart, now = Date.now()) {
  const { start, end } = dayOf(dayStart);
  const cards = periodCards.filter((c) => c.start >= start && c.start < end && !c.pending).sort((a, b) => a.start - b.start);
  if (!cards.length) return null;
  const provisional = cards.length < DAY_PERIODS;
  const score = cards.reduce((a, c) => a + c.score, 0) / cards.length;

  // Equity over the whole day (or the part covered so far).
  const upto = Math.min(end, cards.at(-1).end, now);
  const before = data.equity.filter((s) => s.t < start).at(-1);
  const inDay = data.equity.filter((s) => s.t >= start && s.t < upto);
  const startEq = before?.equity ?? inDay[0]?.equity ?? null;
  const endEq = inDay.at(-1)?.equity ?? startEq;
  const retPct = startEq ? ((endEq - startEq) / startEq) * 100 : 0;
  let peak = startEq ?? 0, maxDd = 0, hi = startEq ?? 0, lo = startEq ?? 0;
  for (const s of inDay) {
    peak = Math.max(peak, s.equity); hi = Math.max(hi, s.equity); lo = Math.min(lo, s.equity);
    if (peak > 0) maxDd = Math.min(maxDd, ((s.equity - peak) / peak) * 100);
  }
  const resultScore = clamp(50 + (retPct / 8) * 50, 0, 100);

  const sum = (k) => cards.reduce((a, c) => a + (c.stats[k] || 0), 0);
  const trades = cards.flatMap((c) => c.trades);
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const reasons = {};
  for (const c of cards) for (const [k, v] of Object.entries(c.stats.exitReasons || {})) reasons[k] = (reasons[k] || 0) + v;
  const hardStopUsd = trades.filter((t) => t.reason === "hardStop").reduce((a, t) => a + t.pnl, 0);
  const counts = {};
  for (const c of cards) counts[c.grade[0]] = (counts[c.grade[0]] || 0) + 1;
  const best = cards.reduce((a, c) => (c.score > a.score ? c : a));
  const worst = cards.reduce((a, c) => (c.score < a.score ? c : a));
  const hm = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const usd = (x) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
  const notes = [];
  notes.push(`Average of ${cards.length} period score${cards.length > 1 ? "s" : ""}: ${score.toFixed(1)} (${letter(score)}). Grades: ${["A", "B", "C", "D", "F"].filter((g) => counts[g]).map((g) => `${counts[g]} ${g}`).join(", ")}.`);
  notes.push(`Equity ${retPct >= 0 ? "rose" : "fell"} ${Math.abs(retPct).toFixed(2)}% (${usd(endEq - startEq)}) to $${endEq.toFixed(2)}; result grade ${letter(resultScore)}.`);
  if (letter(score)[0] !== letter(resultScore)[0]) notes.push(`The average and the result disagree: ${retPct >= 0 ? "a few strong periods carried a day of weaker ones" : "steady-looking periods still added up to a losing day"}.`);
  if (trades.length) notes.push(`${wins.length} of ${trades.length} closed trades won; profit factor ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞"}.`);
  if (reasons.hardStop) notes.push(`${reasons.hardStop} hard stop${reasons.hardStop > 1 ? "s" : ""} cost ${usd(hardStopUsd)}.`);
  notes.push(`Best period ${hm(best.start)} (${best.grade}), worst ${hm(worst.start)} (${worst.grade}).`);

  return {
    id: dayId(start), kind: "day", book: data.book, start, end, provisional, gradedAt: now,
    grade: letter(score), score: Math.round(score * 10) / 10,
    resultGrade: letter(resultScore), resultScore: Math.round(resultScore * 10) / 10,
    periods: cards.map((c) => ({ id: c.id, start: c.start, grade: c.grade, score: c.score, returnPct: c.stats.returnPct })),
    stats: {
      startEquity: startEq, endEquity: endEq, returnPct: retPct, highEquity: hi, lowEquity: lo, maxDrawdownPct: maxDd,
      realizedUsd: sum("realizedUsd"), entries: sum("entries"), exits: sum("exits"), closedTrades: trades.length,
      wins: wins.length, losses: losses.length, winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, profitFactorInfinite: grossLoss === 0 && grossWin > 0,
      hardStops: reasons.hardStop || 0, hardStopUsd, exitReasons: reasons, gradeCounts: counts,
    },
    trades,
    equityPath: inDay.filter((_, k) => k % 10 === 0 || k === inDay.length - 1).map((x) => [x.t, Math.round(x.equity * 100) / 100]),
    notes,
    review: null,
  };
}

module.exports = { PERIOD_MS, DAY_PERIODS, periodOf, periodId, dayOf, dayId, letter, loadBook, gradePeriod, gradeDay };
