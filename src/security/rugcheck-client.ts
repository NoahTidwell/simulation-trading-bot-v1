// RugCheck report client. Fails closed: any non-success response, timeout, or
// unparseable body is returned as { ok: false } and the caller must treat the
// token as unsafe.

import { ENDPOINTS, KEYS } from "../config";
import { asNumber, fetchJson } from "../utils/http";

export interface RugcheckRisk {
  name: string;
  description: string;
  level: string;
  score: number | null;
}

export interface RugcheckHolder {
  address: string;
  owner: string;
  pct: number;
}

export interface RugcheckMarket {
  pubkey: string;
  marketType: string;
  liquidityA: string | null;
  liquidityB: string | null;
  lpLockedPct: number | null;
}

export interface RugcheckReport {
  mint: string;
  score: number | null;
  scoreNormalised: number | null;
  risks: RugcheckRisk[];
  topHolders: RugcheckHolder[];
  markets: RugcheckMarket[];
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number | null;
  rugged: boolean;
}

export type RugcheckOutcome = { ok: true; report: RugcheckReport } | { ok: false; error: string };

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseReport(mint: string, raw: Raw): RugcheckReport | null {
  if (!raw || typeof raw !== "object") return null;
  const token = (raw.token ?? {}) as Raw;
  const risksRaw = Array.isArray(raw.risks) ? (raw.risks as Raw[]) : [];
  const holdersRaw = Array.isArray(raw.topHolders) ? (raw.topHolders as Raw[]) : [];
  const marketsRaw = Array.isArray(raw.markets) ? (raw.markets as Raw[]) : [];

  return {
    mint,
    score: asNumber(raw.score),
    scoreNormalised: asNumber(raw.score_normalised),
    risks: risksRaw.map((r) => ({
      name: str(r.name) ?? "unknown",
      description: str(r.description) ?? "",
      level: (str(r.level) ?? "").toLowerCase(),
      score: asNumber(r.score),
    })),
    topHolders: holdersRaw.map((h) => ({
      address: str(h.address) ?? "",
      owner: str(h.owner) ?? "",
      pct: asNumber(h.pct) ?? Number.NaN,
    })),
    markets: marketsRaw.map((m) => {
      const lp = (m.lp ?? {}) as Raw;
      return {
        pubkey: str(m.pubkey) ?? "",
        marketType: str(m.marketType) ?? "",
        liquidityA: str(m.liquidityA),
        liquidityB: str(m.liquidityB),
        lpLockedPct: asNumber(lp.lpLockedPct),
      };
    }),
    mintAuthority: str(token.mintAuthority) ?? str(raw.mintAuthority),
    freezeAuthority: str(token.freezeAuthority) ?? str(raw.freezeAuthority),
    decimals: asNumber(token.decimals),
    rugged: raw.rugged === true,
  };
}

export async function fetchRugcheckReport(mint: string): Promise<RugcheckOutcome> {
  const url = `${ENDPOINTS.rugcheckBase}/tokens/${mint}/report`;
  const headers: Record<string, string> = KEYS.rugcheck ? { authorization: `Bearer ${KEYS.rugcheck}` } : {};
  const res = await fetchJson<Raw>(url, { headers });
  if (!res.ok) return { ok: false, error: `rugcheck: ${res.error}` };
  const report = parseReport(mint, res.data);
  if (!report) return { ok: false, error: "rugcheck: unparseable report" };
  if (report.score === null) return { ok: false, error: "rugcheck: report has no score" };
  return { ok: true, report };
}

export function dangerFlags(report: RugcheckReport): string[] {
  return report.risks.filter((r) => r.level === "danger").map((r) => r.name);
}
