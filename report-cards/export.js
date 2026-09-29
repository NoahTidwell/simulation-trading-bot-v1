// Build a shareable snapshot of the v1.4 performance review for publishing as a web page.
//
//   node report-cards/export.js      → data/report-cards/site/{index.html, cards.json}
//
// The published page reads cards.json instead of the local API. Re-run and republish after each
// 3-hour review to keep the shared copy current. Nothing secret is included: only the cards
// (grades, stats, token symbols, P&L, reviews) and the bot's equity and status.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { apiPayload, gradeFinished, viewBooks } = require("./server.js");

const OUT = path.resolve(__dirname, "..", "data", "report-cards", "site");
fs.mkdirSync(OUT, { recursive: true });

gradeFinished(false);
// cards.json holds the default book and the list of books; every book also gets cards-<book>.json.
const payload = apiPayload();
fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(payload));
for (const f of fs.readdirSync(OUT).filter((f) => /^cards-.+.json$/.test(f))) fs.unlinkSync(path.join(OUT, f));
for (const b of viewBooks()) fs.writeFileSync(path.join(OUT, `cards-${b}.json`), JSON.stringify(apiPayload(b)));

// The publishing host wraps the page in its own document, so drop the outer html/head/body tags.
let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
html = html
  .replace(/<!doctype html>\s*/i, "")
  .replace(/<html[^>]*>\s*/i, "")
  .replace(/<head>\s*/i, "")
  .replace(/<meta charset[^>]*>\s*/i, "")
  .replace(/<meta name="viewport"[^>]*>\s*/i, "")
  .replace(/<\/head>\s*/i, "")
  .replace(/<body[^>]*>\s*/i, "")
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, "\n");
fs.writeFileSync(path.join(OUT, "index.html"), html);

const last = payload.cards.at(-1);
console.log(`Snapshot written to ${OUT}: ${payload.cards.length} cards, latest ${last?.id} ${last?.grade}, in progress ${payload.current.grade}.`);
