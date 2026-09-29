// Reviewer tools for report cards.
//
//   node report-cards/review.js show [id|latest]           print a card as text (for reading before a review)
//   node report-cards/review.js write <id|latest> <file>   attach a written review (markdown-ish text) to a card
//   node report-cards/review.js pending                    list finished cards that have no review yet
//   Daily cards use ids like day:2026-09-26 (or day:latest) with show and write.
//   Add --book <id> to pick a book (default: the oldest graded book). `pending` lists every book.
//
// Grades are never changed by a review; the review sits beside the automatic notes.

"use strict";

const fs = require("node:fs");
const { listCards, readCard, writeCard, gradeFinished, listDays, readDay, gradedBooks, defaultBook, hasData } = require("./server.js");

const argv = process.argv.slice(2);
const bi = argv.indexOf("--book");
const BOOKSEL = bi >= 0 ? argv.splice(bi, 2)[1] : defaultBook();
const [cmd = "show", arg, file] = argv;
gradeFinished(false); // make sure the latest finished period has a card

const pick = (id) => {
  if (id && id.startsWith("day:")) {
    const d = id.slice(4);
    return d === "latest" ? listDays(BOOKSEL).at(-1) : readDay(d, BOOKSEL);
  }
  const cards = listCards(BOOKSEL);
  return !id || id === "latest" ? cards.at(-1) : readCard(id, BOOKSEL);
};
const t = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

if (cmd === "pending") {
  for (const b of gradedBooks().filter(hasData)) {
    for (const c of listCards(b).filter((c) => !c.review)) console.log(`--book ${b}  ${c.id}  ${c.grade.padEnd(2)} ${c.score}`);
    for (const d of listDays(b).filter((d) => !d.review)) console.log(`--book ${b}  day:${d.id}  ${d.grade.padEnd(2)} avg ${d.score} · result ${d.resultGrade} (${d.stats.returnPct.toFixed(2)}%)`);
  }
} else if (cmd === "show") {
  const c = pick(arg);
  if (!c) { console.error("No such card."); process.exit(1); }
  const s = c.stats;
  if (c.kind === "day") {
    console.log(`${c.book} DAILY ${c.id}  ${t(c.start)} – ${t(c.end)}`);
    console.log(`GRADE ${c.grade} (average ${c.score}/100) · RESULT ${c.resultGrade} (${c.resultScore}/100)`);
    console.log(`periods ${c.periods.map((p) => `${new Date(p.start).getHours()}h ${p.grade} (${p.returnPct.toFixed(1)}%)`).join(" · ")}`);
    console.log(`equity ${s.startEquity?.toFixed(2)} → ${s.endEquity?.toFixed(2)} (${s.returnPct.toFixed(2)}%), high ${s.highEquity?.toFixed(2)}, low ${s.lowEquity?.toFixed(2)}, max DD ${s.maxDrawdownPct.toFixed(2)}%`);
    console.log(`entries ${s.entries}, closed ${s.closedTrades} (${s.wins}W/${s.losses}L), PF ${s.profitFactorInfinite ? "∞" : s.profitFactor?.toFixed(2) ?? "–"}, hard stops ${s.hardStops} (${s.hardStopUsd.toFixed(2)}), exits ${JSON.stringify(s.exitReasons)}`);
    console.log("notes:"); for (const n of c.notes) console.log(`  - ${n}`);
    if (c.review) console.log(`review:
${c.review.text}`);
    process.exit(0);
  }
  console.log(`${c.book} ${c.id}  ${t(c.start)} – ${t(c.end)}`);
  console.log(`GRADE ${c.grade}  (${c.score}/100)  ${c.subjects.map((x) => `${x.label} ${x.score}/${x.max} ${x.grade}`).join(" · ")}`);
  console.log(`equity ${s.startEquity?.toFixed(2)} → ${s.endEquity?.toFixed(2)} (${s.returnPct.toFixed(2)}%), realized ${s.realizedUsd.toFixed(2)}, max DD ${s.maxDrawdownPct.toFixed(2)}%, uptime ${s.uptimePct.toFixed(0)}%`);
  console.log(`entries ${s.entries}, exits ${s.exits}, closed ${s.closedTrades} (${s.wins}W/${s.losses}L), PF ${s.profitFactorInfinite ? "∞" : s.profitFactor?.toFixed(2) ?? "–"}, hard stops ${s.hardStops}, open at end ${s.openAtEnd}`);
  console.log(`exit reasons ${JSON.stringify(s.exitReasons)}`);
  for (const tr of c.trades) console.log(`  ${tr.symbol?.padEnd(12)} ${tr.pnl >= 0 ? "+" : ""}${tr.pnl.toFixed(2).padStart(7)}  ${tr.pct != null ? tr.pct.toFixed(1).padStart(6) + "%" : ""}  ${tr.reason}  held ${tr.holdMin?.toFixed(0)}m`);
  console.log("notes:"); for (const n of c.notes) console.log(`  - ${n}`);
  if (c.review) console.log(`review (${t(c.review.at)}):\n${c.review.text}`);
} else if (cmd === "write") {
  const c = pick(arg);
  if (!c || !file) { console.error("Usage: review.js write <id|latest> <file>"); process.exit(1); }
  c.review = { text: fs.readFileSync(file, "utf8").trim(), at: Date.now(), by: "Claude" };
  writeCard(c);
  console.log(`Review attached to ${c.id}.`);
} else {
  console.error(`Unknown command ${cmd}`);
  process.exit(1);
}
