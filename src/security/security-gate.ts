// Combined security gate. ALL of the following must pass or the token is
// rejected. Any API/RPC failure is a rejection (fail closed).
//
//   - Mint authority revoked        (on-chain via RPC  AND GoPlus agree)
//   - Freeze authority revoked      (on-chain via RPC  AND GoPlus agree)
//   - LP locked or burned           (RugCheck lpLockedPct on best market)
//   - Transfer tax ≤ cap; "not owner-mutable" only if SECURITY.requireImmutableTransferFee
//   - RugCheck score < 500 AND zero danger-level flags
//   - Top-10 non-LP holders < 25% of supply
//
// The RPC connection is READ ONLY. No Keypair, no signing, anywhere.

import { Connection, PublicKey } from "@solana/web3.js";
import { SECURITY, SOLANA } from "../config";
import type { SecurityGateResult, SecurityRecheckResult } from "../types";
import { errMsg } from "../utils/format";
import { countApiCall } from "../utils/metrics";
import { fetchGoplusTokenSecurity, type GoplusTokenSecurity } from "./goplus-client";
import { dangerFlags, fetchRugcheckReport, type RugcheckReport } from "./rugcheck-client";

interface OnChainMint {
  program: "spl-token" | "spl-token-2022";
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Transfer fee in %, from the Token-2022 extension; 0 for classic SPL. */
  transferFeePct: number;
  /** True if the fee config can still be changed on-chain. */
  transferFeeMutable: boolean;
  hasTransferHook: boolean;
}

type OnChainOutcome = { ok: true; mint: OnChainMint } | { ok: false; error: string };

type Raw = Record<string, unknown>;

async function fetchOnChainMint(connection: Connection, mint: string): Promise<OnChainOutcome> {
  try {
    countApiCall("rpc");
    const info = await connection.getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const value = info.value;
    if (!value) return { ok: false, error: "rpc: mint account not found" };
    const data = value.data as unknown;
    if (!data || typeof data !== "object" || !("parsed" in (data as Raw))) {
      return { ok: false, error: "rpc: mint account not parseable" };
    }
    const parsedData = data as { program?: string; parsed?: { type?: string; info?: Raw } };
    if (parsedData.parsed?.type !== "mint" || !parsedData.parsed.info) return { ok: false, error: "rpc: account is not a mint" };
    const program = parsedData.program;
    if (program !== "spl-token" && program !== "spl-token-2022") return { ok: false, error: `rpc: unexpected owner program ${program}` };
    const pInfo = parsedData.parsed.info;
    const decimals = typeof pInfo.decimals === "number" ? pInfo.decimals : null;
    if (decimals === null) return { ok: false, error: "rpc: mint has no decimals" };

    let transferFeePct = 0;
    let transferFeeMutable = false;
    let hasTransferHook = false;
    if (program === "spl-token-2022") {
      const extensions = Array.isArray(pInfo.extensions) ? (pInfo.extensions as Raw[]) : [];
      for (const ext of extensions) {
        const name = ext.extension;
        const state = (ext.state ?? {}) as Raw;
        if (name === "transferFeeConfig") {
          const newer = (state.newerTransferFee ?? {}) as Raw;
          const older = (state.olderTransferFee ?? {}) as Raw;
          const bpsNewer = typeof newer.transferFeeBasisPoints === "number" ? newer.transferFeeBasisPoints : null;
          const bpsOlder = typeof older.transferFeeBasisPoints === "number" ? older.transferFeeBasisPoints : null;
          if (bpsNewer === null && bpsOlder === null) return { ok: false, error: "rpc: transfer fee config unparseable" };
          transferFeePct = Math.max(bpsNewer ?? 0, bpsOlder ?? 0) / 100;
          transferFeeMutable = state.transferFeeConfigAuthority !== null && state.transferFeeConfigAuthority !== undefined;
        }
        if (name === "transferHook") {
          const programId = state.programId;
          hasTransferHook = typeof programId === "string" && programId.length > 0;
        }
      }
    }
    return {
      ok: true,
      mint: {
        program,
        decimals,
        mintAuthority: typeof pInfo.mintAuthority === "string" ? pInfo.mintAuthority : null,
        freezeAuthority: typeof pInfo.freezeAuthority === "string" ? pInfo.freezeAuthority : null,
        transferFeePct,
        transferFeeMutable,
        hasTransferHook,
      },
    };
  } catch (e) {
    return { ok: false, error: `rpc: ${errMsg(e)}` };
  }
}

/** Accounts that hold tokens on behalf of a pool: vaults, pool addresses, AMM authorities. */
function lpAccountSet(report: RugcheckReport): Set<string> {
  const lp = new Set<string>(SOLANA.knownAmmAuthorities);
  for (const m of report.markets) {
    if (m.liquidityA) lp.add(m.liquidityA);
    if (m.liquidityB) lp.add(m.liquidityB);
    if (m.pubkey) lp.add(m.pubkey);
  }
  return lp;
}

interface OnChainHolder {
  tokenAccount: string;
  owner: string;
  pct: number;
}

/** Top-20 token accounts by balance, straight from the chain (read-only RPC). */
async function fetchOnChainTopHolders(connection: Connection, mint: string): Promise<OnChainHolder[] | null> {
  try {
    const pk = new PublicKey(mint);
    countApiCall("rpc");
    countApiCall("rpc");
    const [largest, supply] = await Promise.all([connection.getTokenLargestAccounts(pk), connection.getTokenSupply(pk)]);
    const total = Number(supply.value.amount);
    if (!(total > 0)) return null;
    const accounts = largest.value;
    if (accounts.length === 0) return null;
    countApiCall("rpc");
    const infos = await connection.getMultipleParsedAccounts(accounts.map((a) => a.address));
    return accounts.map((a, i) => {
      const data = infos.value[i]?.data as { parsed?: { info?: Raw } } | undefined;
      const owner = typeof data?.parsed?.info?.owner === "string" ? (data.parsed.info.owner as string) : "";
      return { tokenAccount: a.address.toBase58(), owner, pct: (Number(a.amount) / total) * 100 };
    });
  } catch {
    return null;
  }
}

/**
 * Sum of the top-10 non-LP holders' % of supply.
 * Sources, in order: GoPlus holders → RugCheck topHolders → on-chain largest
 * accounts. Null when none provides data → the gate fails closed.
 */
async function top10NonLpHolderPct(
  connection: Connection,
  mint: string,
  report: RugcheckReport,
  gp: GoplusTokenSecurity,
): Promise<{ pct: number; source: string } | null> {
  const lp = lpAccountSet(report);
  let holders: { pct: number }[] = [];
  let source = "";
  if (gp.holders.length > 0) {
    holders = gp.holders.filter((h) => !lp.has(h.account) && !/(raydium|orca|meteora|pump|jupiter|lp|pool)/i.test(h.tag));
    source = "goplus";
  } else if (report.topHolders.length > 0) {
    holders = report.topHolders.filter((h) => !lp.has(h.address) && !lp.has(h.owner));
    source = "rugcheck";
  } else {
    const chain = await fetchOnChainTopHolders(connection, mint);
    if (!chain) return null;
    holders = chain.filter((h) => !lp.has(h.tokenAccount) && !lp.has(h.owner));
    source = "on-chain";
  }
  if (holders.some((h) => !Number.isFinite(h.pct))) return null;
  const pct = holders
    .slice()
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10)
    .reduce((acc, h) => acc + h.pct, 0);
  return { pct, source };
}

export async function runSecurityGate(connection: Connection, mint: string): Promise<SecurityGateResult> {
  const checkedAt = Date.now();
  const reasons: string[] = [];
  const result: SecurityGateResult = {
    passed: false,
    reasons,
    decimals: null,
    transferTaxPct: null,
    rugcheckScore: null,
    top10HolderPct: null,
    lpLockedPct: null,
    checkedAt,
  };

  const [onchain, rug, gp] = await Promise.all([
    fetchOnChainMint(connection, mint),
    fetchRugcheckReport(mint),
    fetchGoplusTokenSecurity(mint),
  ]);

  if (!onchain.ok) reasons.push(onchain.error);
  if (!rug.ok) reasons.push(rug.error);
  if (!gp.ok) reasons.push(gp.error);
  if (!onchain.ok || !rug.ok || !gp.ok) return result; // fail closed on any data failure

  const chain = onchain.mint;
  const report = rug.report;
  const sec = gp.security;
  result.decimals = chain.decimals;
  result.rugcheckScore = report.score;

  // --- authorities (on-chain AND GoPlus must both say revoked) ---
  if (chain.mintAuthority !== null) reasons.push("mint authority not revoked (on-chain)");
  if (chain.freezeAuthority !== null) reasons.push("freeze authority not revoked (on-chain)");
  if (sec.mintable !== false) reasons.push(`goplus mintable=${sec.mintable ?? "unknown"}`);
  if (sec.freezable !== false) reasons.push(`goplus freezable=${sec.freezable ?? "unknown"}`);

  // --- transfer tax: mutability check is configurable; the current rate is always bounded ---
  if (SECURITY.requireImmutableTransferFee) {
    if (chain.transferFeeMutable) reasons.push("transfer fee config authority still set (on-chain)");
    if (sec.transferFeeUpgradable !== false) reasons.push(`goplus transfer_fee_upgradable=${sec.transferFeeUpgradable ?? "unknown"}`);
  }
  if (chain.transferFeePct > SECURITY.maxTransferTaxPct) reasons.push(`transfer tax ${chain.transferFeePct}% > ${SECURITY.maxTransferTaxPct}% cap`);
  if (chain.hasTransferHook || sec.hasTransferHook === true) reasons.push("transfer hook present");
  if (sec.nonTransferable === true) reasons.push("token is non-transferable");
  if (sec.balanceMutable === true) reasons.push("balance mutable authority present");
  // On-chain is the source of truth for the tax value; if GoPlus reports a
  // materially different rate the data conflicts → fail closed.
  if (sec.transferFeePct !== null && Math.abs(sec.transferFeePct - chain.transferFeePct) > 0.01) {
    reasons.push(`transfer tax mismatch: on-chain ${chain.transferFeePct}% vs goplus ${sec.transferFeePct}%`);
  }
  result.transferTaxPct = chain.transferFeePct;

  // --- RugCheck score + danger flags ---
  if (report.rugged) reasons.push("rugcheck: token flagged as rugged");
  if (report.score === null || report.score >= SECURITY.maxRugcheckScore) {
    reasons.push(`rugcheck score ${report.score ?? "n/a"} >= ${SECURITY.maxRugcheckScore}`);
  }
  const danger = dangerFlags(report);
  if (danger.length > 0) reasons.push(`rugcheck danger flags: ${danger.join(", ")}`);

  // --- LP locked or burned ---
  const lpPcts = report.markets.map((m) => m.lpLockedPct).filter((v): v is number => v !== null);
  if (lpPcts.length === 0) {
    reasons.push("no LP lock data");
  } else {
    const best = Math.max(...lpPcts);
    result.lpLockedPct = best;
    if (best < SECURITY.minLpLockedPct) reasons.push(`LP locked/burned ${best.toFixed(1)}% < ${SECURITY.minLpLockedPct}%`);
  }

  // --- holder concentration ---
  const top10 = await top10NonLpHolderPct(connection, mint, report, sec);
  result.top10HolderPct = top10?.pct ?? null;
  if (top10 === null) reasons.push("holder data unavailable (goplus, rugcheck, on-chain)");
  else if (top10.pct >= SECURITY.maxTop10HolderPct) {
    reasons.push(`top-10 non-LP holders ${top10.pct.toFixed(1)}% >= ${SECURITY.maxTop10HolderPct}% (${top10.source})`);
  }

  result.passed = reasons.length === 0;
  return result;
}

/**
 * Lightweight periodic re-check for open positions: any new danger-level
 * RugCheck flag (or a "rugged" mark) ejects. API failures are reported as
 * errors so the caller can count them and fail closed.
 */
export async function recheckSecurity(mint: string): Promise<SecurityRecheckResult> {
  const rug = await fetchRugcheckReport(mint);
  if (!rug.ok) return { status: "error", flags: [], error: rug.error };
  const flags = dangerFlags(rug.report);
  if (rug.report.rugged) flags.push("rugged");
  return flags.length > 0 ? { status: "danger", flags } : { status: "ok", flags: [] };
}
