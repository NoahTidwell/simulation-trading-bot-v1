// Reads data/books.json, the list of books the bot trades (written by the bot at startup from
// config.PROFILES). Shared by the dashboard, the report-card service and the alerts, so the list
// of books lives in exactly one place. Falls back to the book folders on disk if the file is missing.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DATA = path.resolve(__dirname, "..", "data");
const FILE = path.join(DATA, "books.json");

let cache = null, cacheAt = 0;

/** { active: [{ id, version, description, dataDir, startingBankrollUsd }], retired: [...] } */
function readBooks() {
  if (cache && Date.now() - cacheAt < 10_000) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    const dirs = fs.readdirSync(DATA).filter((d) => /^v\d+\.\d+$/.test(d) && fs.existsSync(path.join(DATA, d, "trades", "summary.json"))).sort();
    cache = { active: dirs.map((id) => ({ id, version: id.slice(1), description: "", dataDir: id, startingBankrollUsd: 500 })), retired: [] };
  }
  cacheAt = Date.now();
  return cache;
}

/** Ids of the books being traded now, oldest first. */
const activeIds = () => readBooks().active.map((b) => b.id);
/** Absolute data folder of a book (active or retired), or null if unknown. */
function bookDir(id) {
  const b = [...readBooks().active, ...readBooks().retired].find((x) => x.id === id);
  return b ? path.join(DATA, b.dataDir) : null;
}
/** Description of a book for tooltips. */
const describe = (id) => [...readBooks().active, ...readBooks().retired].find((x) => x.id === id)?.description || "";

module.exports = { readBooks, activeIds, bookDir, describe, DATA };
