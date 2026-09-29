// data/books.json: the list of books the running bot trades, written at startup. The dashboards,
// report cards and alerts read it instead of keeping their own copies of the list.

import fs from "node:fs";
import path from "node:path";
import { ALL_PROFILES, bookPaths, DATA_DIR } from "../config";
import type { StrategyProfile } from "../types";

export function writeBookRegistry(active: StrategyProfile[]): void {
  const dataRoot = DATA_DIR;
  const row = (p: StrategyProfile) => ({
    id: p.id,
    version: p.version,
    description: p.description ?? "",
    dataDir: path.relative(dataRoot, path.dirname(path.dirname(bookPaths(p).summaryFile))) || ".",
    startingBankrollUsd: p.startingBankrollUsd,
  });
  const ids = new Set(active.map((p) => p.id));
  const out = {
    generatedAt: new Date().toISOString(),
    active: active.map(row),
    retired: ALL_PROFILES.filter((p) => !ids.has(p.id)).map(row),
  };
  const file = path.join(dataRoot, "books.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
