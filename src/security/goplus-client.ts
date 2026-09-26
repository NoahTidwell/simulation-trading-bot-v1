// GoPlus Solana token security. Used for mint/freeze authority and transfer-fee
// mutability. Fails closed on any error, non-1 code, or missing result.

import { ENDPOINTS, KEYS } from "../config";
import { asNumber, fetchJson } from "../utils/http";

export interface GoplusHolder {
  account: string;
  /** Percent of total supply (0–100). */
  pct: number;
  isLocked: boolean;
  tag: string;
}

export interface GoplusTokenSecurity {
  mintable: boolean | null;
  freezable: boolean | null;
  transferFeeUpgradable: boolean | null;
  /** Reported current transfer fee %, if GoPlus exposes one. */
  transferFeePct: number | null;
  hasTransferHook: boolean | null;
  transferHookUpgradable: boolean | null;
  nonTransferable: boolean | null;
  closable: boolean | null;
  balanceMutable: boolean | null;
  holderCount: number | null;
  /** Top holders as reported (usually the top 10). Empty if not provided. */
  holders: GoplusHolder[];
}

export type GoplusOutcome = { ok: true; security: GoplusTokenSecurity } | { ok: false; error: string };

type Raw = Record<string, unknown>;

interface GoplusResponse {
  code?: number;
  message?: string;
  result?: Record<string, Raw>;
}

/** GoPlus encodes booleans as {"status": "0"|"1", ...}. Unknown → null (fail closed upstream). */
function statusFlag(v: unknown): boolean | null {
  if (!v || typeof v !== "object") return null;
  const s = (v as Raw).status;
  if (s === "1" || s === 1 || s === true) return true;
  if (s === "0" || s === 0 || s === false) return false;
  return null;
}

/**
 * GoPlus shape: { current_fee_rate: { fee_rate: "0.03", maximum_fee }, scheduled_fee_rate: [...] }
 * where fee_rate is a fraction (0.03 = 3%). Empty object = no fee extension.
 */
function parseTransferFee(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Raw;
  if (Object.keys(r).length === 0) return 0;
  const current = r.current_fee_rate;
  const rate = current && typeof current === "object" ? asNumber((current as Raw).fee_rate) : asNumber(current);
  if (rate === null) return null;
  return rate * 100;
}

function parseHolders(v: unknown): GoplusHolder[] {
  if (!Array.isArray(v)) return [];
  const out: GoplusHolder[] = [];
  for (const h of v as Raw[]) {
    const account = typeof h.account === "string" ? h.account : "";
    const frac = asNumber(h.percent);
    if (!account || frac === null) continue;
    out.push({
      account,
      pct: frac * 100,
      isLocked: h.is_locked === 1 || h.is_locked === "1" || h.is_locked === true,
      tag: typeof h.tag === "string" ? h.tag : "",
    });
  }
  return out;
}

export async function fetchGoplusTokenSecurity(mint: string): Promise<GoplusOutcome> {
  const url = `${ENDPOINTS.goplusBase}/solana/token_security?contract_addresses=${mint}`;
  const headers: Record<string, string> = KEYS.goplus ? { authorization: KEYS.goplus } : {};
  const res = await fetchJson<GoplusResponse>(url, { headers });
  if (!res.ok) return { ok: false, error: `goplus: ${res.error}` };
  const body = res.data;
  if (body.code !== 1) return { ok: false, error: `goplus: code ${body.code ?? "?"} ${body.message ?? ""}`.trim() };
  const entry = body.result?.[mint] ?? Object.values(body.result ?? {})[0];
  if (!entry || typeof entry !== "object") return { ok: false, error: "goplus: no result for mint" };

  const hook = entry.transfer_hook;
  const hasTransferHook =
    hook === undefined || hook === null ? null : Array.isArray(hook) ? hook.length > 0 : statusFlag(hook) ?? Boolean(hook);

  return {
    ok: true,
    security: {
      mintable: statusFlag(entry.mintable),
      freezable: statusFlag(entry.freezable),
      transferFeeUpgradable: statusFlag(entry.transfer_fee_upgradable),
      transferFeePct: parseTransferFee(entry.transfer_fee),
      hasTransferHook,
      transferHookUpgradable: statusFlag(entry.transfer_hook_upgradable),
      nonTransferable: statusFlag(entry.non_transferable),
      closable: statusFlag(entry.closable),
      balanceMutable: statusFlag(entry.balance_mutable_authority),
      holderCount: asNumber(entry.holder_count),
      holders: parseHolders(entry.holders),
    },
  };
}
