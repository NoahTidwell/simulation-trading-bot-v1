// Entry rules added in v1.5 and later (StrategyProfile.lab), shared by the live bot
// (src/index.ts) and the offline replay (scripts/replay.ts) so the two can never drift.
//
//  - Per-token entry cap: at most lab.maxEntriesPerTokenPerDay entries on one token in any rolling 24 h.
//  - Wait-and-confirm: a token's first passing signal only starts a clock. It may be entered once it
//    still passes after lab.confirmSeconds with its price no more than lab.confirmMaxDropPct below
//    the signal price. A clock older than 3× the wait is stale and restarts.
// (Early exit and minimum pair age live in exit-rules.ts and entry-filter.ts.)

import type { LabRules } from "../types";

export type ConfirmResult = "wait" | "pass" | "fail";

/** Per-book wait-and-confirm clocks. */
export class ConfirmGate {
  private readonly waiting = new Map<string, { at: number; price: number }>();

  /**
   * Called on each scan where the token passes the entry filter.
   * "wait": clock started or still running; "pass": confirmed, enter now; "fail": price dropped during the wait.
   */
  check(lab: LabRules, mint: string, priceUsd: number, now: number): { result: ConfirmResult; changePct?: number } {
    if (!(lab.confirmSeconds > 0)) return { result: "pass" };
    const w = this.waiting.get(mint);
    if (!w || now - w.at > lab.confirmSeconds * 3_000) {
      this.waiting.set(mint, { at: now, price: priceUsd });
      return { result: "wait" };
    }
    if (now - w.at < lab.confirmSeconds * 1_000) return { result: "wait" };
    this.waiting.delete(mint);
    const changePct = ((priceUsd / w.price) - 1) * 100;
    return { result: changePct < -lab.confirmMaxDropPct ? "fail" : "pass", changePct };
  }

  /** Drop clocks that can no longer confirm (call once per scan). */
  prune(lab: LabRules, now: number): void {
    for (const [mint, w] of this.waiting) if (now - w.at > lab.confirmSeconds * 3_000) this.waiting.delete(mint);
  }
}

/** True when the book has already entered this token the maximum number of times in the last 24 h. */
export function overEntryCap(lab: LabRules, entriesInLast24h: number): boolean {
  return lab.maxEntriesPerTokenPerDay > 0 && entriesInLast24h >= lab.maxEntriesPerTokenPerDay;
}
