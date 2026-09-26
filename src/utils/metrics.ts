// Lightweight API-call accounting: how many external calls each cycle makes,
// per service, cumulative and for the current cycle. Reporting only.

export type ApiService = "dexscreener" | "jupiter-price" | "jupiter-quote" | "helius" | "rugcheck" | "goplus" | "rpc" | "other";

const total: Record<ApiService, number> = { dexscreener: 0, "jupiter-price": 0, "jupiter-quote": 0, helius: 0, rugcheck: 0, goplus: 0, rpc: 0, other: 0 };
let cycle: Record<ApiService, number> = { ...total };
const startedAt = Date.now();

export function countApiCall(service: ApiService): void {
  total[service] += 1;
  cycle[service] += 1;
}

export function serviceForUrl(url: string): ApiService {
  if (url.includes("dexscreener.com")) return "dexscreener";
  if (url.includes("helius")) return "helius";
  if (url.includes("rugcheck")) return "rugcheck";
  if (url.includes("gopluslabs")) return "goplus";
  if (url.includes("jup.ag")) return url.includes("/price") ? "jupiter-price" : "jupiter-quote";
  return "other";
}

/** Snapshot the current cycle's counts and reset them for the next cycle. */
export function endCycle(): { cycle: Record<ApiService, number>; total: Record<ApiService, number>; perMinute: Record<ApiService, number> } {
  const snapshot = { ...cycle };
  cycle = { dexscreener: 0, "jupiter-price": 0, "jupiter-quote": 0, helius: 0, rugcheck: 0, goplus: 0, rpc: 0, other: 0 };
  const minutes = Math.max(1 / 60, (Date.now() - startedAt) / 60_000);
  const perMinute = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round((v / minutes) * 10) / 10])) as Record<ApiService, number>;
  return { cycle: snapshot, total: { ...total }, perMinute };
}
