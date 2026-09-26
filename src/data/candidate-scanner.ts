// Candidate sourcing.
//
// Primary source: Helius Enhanced Transactions API polled against the Raydium
// and pump.fun program addresses. Any token mint moving through those programs
// recently (new pools + organic swap volume) enters the watchlist. Watched
// tokens are then refreshed every cycle from DexScreener to build the price
// and tx-count history the entry filter and ejection triggers need.
//
// Secondary source: GeckoTerminal's Solana pools ranked by activity (24h
// volume, 24h trade count) and newly created pools.
//
// Explicitly NOT a source: DexScreener boosted / promoted / profile lists.

import fs from "node:fs";
import { BAND_PARAMS, ENDPOINTS, KEYS, PATHS, PRICE_STRUCTURE, PROFILE_V12, RUNTIME, SOLANA, WATCHLIST_SEED_MINTS } from "../config";
import { classifyBand, isWatchOnly } from "../strategy/bands";
import { pushSample } from "../strategy/ejection-triggers";
import { evaluateEntryFilter } from "../strategy/entry-filter";
import type { Candidate, MarketSnapshot, Sample, StrategyProfile, WatchedToken } from "../types";
import { errMsg } from "../utils/format";
import { fetchJson } from "../utils/http";
import { sleep } from "../utils/sleep";
import { fetchMarketSnapshots } from "./dexscreener-client";

interface HeliusTokenTransfer {
  mint?: string;
}
interface HeliusTx {
  signature?: string;
  timestamp?: number;
  type?: string;
  source?: string;
  tokenTransfers?: HeliusTokenTransfer[];
}

/** On-disk form: sample histories as [t, v] tuples (≈40% smaller than objects). */
interface WatchlistFileToken extends Omit<WatchedToken, "priceHistory" | "txHistory"> {
  priceHistory: [number, number][] | Sample[];
  txHistory: [number, number][] | Sample[];
}
interface WatchlistFile {
  savedAt: number;
  tokens: WatchlistFileToken[];
}

function samplesFromDisk(raw: [number, number][] | Sample[] | undefined): Sample[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => (Array.isArray(s) ? { t: s[0], v: s[1] } : s));
}

export interface DiscoveryStats {
  added: number;
  seen: number;
  errors: string[];
  skipped: boolean;
}

export interface RefreshStats {
  /** tokens due for refresh this cycle (watchlist + open positions) */
  due: number;
  refreshed: number;
  unresolved: number;
  /** how many of the due tokens went through the cheap /pairs path */
  viaPairs: number;
  evicted: number;
  tiers: { hot: number; warm: number; cold: number };
  /** DexScreener snapshots fetched this cycle, keyed by mint (includes open positions). */
  snapshots: Map<string, MarketSnapshot>;
  errors: string[];
}

export class CandidateScanner {
  readonly watchlist = new Map<string, WatchedToken>();
  /** Entry-filter reject reasons for non-main books (in memory; the main book's live on the token). */
  private readonly bookRejectReasons = new Map<string, Map<string, string | null>>();

  private forget(mint: string): void {
    this.watchlist.delete(mint);
    for (const m of this.bookRejectReasons.values()) m.delete(mint);
  }

  private rejectReasonsFor(profile: StrategyProfile): Map<string, string | null> {
    let m = this.bookRejectReasons.get(profile.id);
    if (!m) this.bookRejectReasons.set(profile.id, (m = new Map()));
    return m;
  }
  private warnedNoHelius = false;
  private lastSavedAt = 0;

  static load(): CandidateScanner {
    const s = new CandidateScanner();
    try {
      if (fs.existsSync(PATHS.watchlistFile)) {
        const raw = JSON.parse(fs.readFileSync(PATHS.watchlistFile, "utf8")) as WatchlistFile;
        for (const t of raw.tokens ?? []) {
          s.watchlist.set(t.tokenAddress, {
            ...t,
            priceHistory: samplesFromDisk(t.priceHistory),
            txHistory: samplesFromDisk(t.txHistory),
            nextRefreshAt: typeof t.nextRefreshAt === "number" ? t.nextRefreshAt : 0,
            unresolvedStreak: typeof t.unresolvedStreak === "number" ? t.unresolvedStreak : 0,
            // Pre-field files: trust the stored best pair as of its snapshot time.
            pairResolvedAt: typeof t.pairResolvedAt === "number" ? t.pairResolvedAt : (t.lastSnapshot?.fetchedAt ?? 0),
          });
        }
      }
    } catch (e) {
      console.warn(`[scanner] could not load watchlist: ${errMsg(e)} — starting empty`);
    }
    const now = Date.now();
    for (const mint of WATCHLIST_SEED_MINTS) s.addToken(mint, "seed", now);
    return s;
  }

  /** Throttled: the file is ~MBs, so it's written every watchlistSaveIntervalMs (or on `force`). */
  save(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastSavedAt < RUNTIME.watchlistSaveIntervalMs) return false;
    const tokens: WatchlistFileToken[] = Array.from(this.watchlist.values()).map((t) => ({
      ...t,
      priceHistory: t.priceHistory.map((s) => [s.t, s.v] as [number, number]),
      txHistory: t.txHistory.map((s) => [s.t, s.v] as [number, number]),
    }));
    const payload: WatchlistFile = { savedAt: now, tokens };
    const tmp = `${PATHS.watchlistFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, PATHS.watchlistFile);
    this.lastSavedAt = now;
    return true;
  }

  private addToken(mint: string, source: string, now: number): boolean {
    if ((SOLANA.ignoredMints as readonly string[]).includes(mint)) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return false;
    const existing = this.watchlist.get(mint);
    if (existing) {
      existing.lastDiscoveredAt = now;
      return false;
    }
    this.watchlist.set(mint, {
      tokenAddress: mint,
      symbol: "?",
      source,
      firstSeenAt: now,
      lastDiscoveredAt: now,
      lastSnapshot: null,
      priceHistory: [],
      txHistory: [],
      gateCooldownUntil: null,
      lastRejectReason: null,
      nextRefreshAt: 0,
      unresolvedStreak: 0,
      pairResolvedAt: 0,
    });
    return true;
  }

  /** Poll Helius for recent activity on the Raydium / pump.fun programs. */
  async discover(now: number): Promise<DiscoveryStats> {
    const stats: DiscoveryStats = { added: 0, seen: 0, errors: [], skipped: false };
    if (!KEYS.helius) {
      if (!this.warnedNoHelius) {
        console.warn("[scanner] HELIUS_API_KEY not set — candidate discovery disabled; only WATCHLIST_MINTS seeds are watched");
        this.warnedNoHelius = true;
      }
      stats.skipped = true;
      return stats;
    }
    // Programs are polled concurrently, then processed in config order.
    const responses = await Promise.all(
      SOLANA.discoveryPrograms.map((program) =>
        fetchJson<HeliusTx[]>(`${ENDPOINTS.heliusApiBase}/v0/addresses/${program.address}/transactions?api-key=${KEYS.helius}&limit=${RUNTIME.heliusTxLimit}`),
      ),
    );
    for (const [i, program] of SOLANA.discoveryPrograms.entries()) {
      const res = responses[i];
      if (!res.ok) {
        stats.errors.push(`helius ${program.label}: ${res.error.replace(KEYS.helius, "***")}`);
        continue;
      }
      if (!Array.isArray(res.data)) {
        stats.errors.push(`helius ${program.label}: unexpected response shape`);
        continue;
      }
      for (const tx of res.data) {
        for (const tr of tx.tokenTransfers ?? []) {
          if (!tr.mint) continue;
          stats.seen += 1;
          if (this.addToken(tr.mint, program.label, now)) stats.added += 1;
        }
      }
    }
    return stats;
  }

  /**
   * Secondary discovery: GeckoTerminal's most active Solana pools (by 24h
   * volume, by 24h trade count) and newly created pools. Every base-token mint
   * enters the watchlist; the market-cap bands are applied later from
   * DexScreener data, exactly as for Helius-discovered mints.
   */
  async discoverActivePools(now: number): Promise<DiscoveryStats & { rateLimited: boolean }> {
    const stats = { added: 0, seen: 0, errors: [] as string[], skipped: false, rateLimited: false };
    const lists = ["pools?sort=h24_volume_usd_desc&page=1", "pools?sort=h24_tx_count_desc&page=1", "new_pools?page=1"];
    for (const [i, list] of lists.entries()) {
      // Sequential and spaced: GeckoTerminal's keyless tier throttles bursts.
      if (i > 0) await sleep(RUNTIME.activePoolDiscoveryCallSpacingMs);
      const res = await fetchJson<{ data?: { relationships?: { base_token?: { data?: { id?: string } } } }[] }>(
        `${ENDPOINTS.geckoTerminalBase}/networks/solana/${list}`,
      );
      if (!res.ok) {
        if (res.status === 429) {
          // Stop this round; the caller backs off before the next one.
          stats.rateLimited = true;
          stats.errors.push(`geckoterminal rate limit on ${list.split("?")[0]} — skipping the rest of this round`);
          break;
        }
        stats.errors.push(`geckoterminal ${list.split("?")[0]}: ${res.error}`);
        continue;
      }
      for (const pool of res.data.data ?? []) {
        const id = pool.relationships?.base_token?.data?.id;
        if (!id?.startsWith("solana_")) continue;
        stats.seen += 1;
        if (this.addToken(id.slice("solana_".length), "geckoterminal", now)) stats.added += 1;
      }
    }
    return stats;
  }

  /** Which refresh tier a token belongs to, from its last snapshot. */
  private tierOf(token: WatchedToken): "hot" | "warm" | "cold" {
    const snap = token.lastSnapshot;
    if (!snap || token.unresolvedStreak > 0) return "cold";
    // Watch-only tokens are refreshed like band A so their recordings are replayable at full resolution.
    const band = classifyBand(snap.marketCapUsd) ?? (isWatchOnly(snap.marketCapUsd) ? "A" : null);
    if (!band) return "cold";
    const minVol = BAND_PARAMS[band].minVolume5mUsd * RUNTIME.refresh.hotVolumeFraction;
    const nearVolume = (snap.volume5mUsd ?? 0) >= minVol;
    const moving = Math.abs(snap.priceChange5mPct ?? 0) >= RUNTIME.refresh.hotPriceChangePct;
    return nearVolume || moving ? "hot" : "warm";
  }

  /**
   * ONE DexScreener pass per cycle: open positions (always) plus every watched
   * token whose tier says it's due. Extends histories, assigns the next tier,
   * evicts dead entries. Returns the snapshots so the position manager can use
   * them without a second fetch.
   */
  async refresh(now: number, positionMints: Set<string>): Promise<RefreshStats> {
    const stats: RefreshStats = { due: 0, refreshed: 0, unresolved: 0, viaPairs: 0, evicted: 0, tiers: { hot: 0, warm: 0, cold: 0 }, snapshots: new Map(), errors: [] };
    const due: string[] = Array.from(positionMints);
    for (const [mint, t] of this.watchlist) {
      if (positionMints.has(mint)) continue;
      const tier = this.tierOf(t);
      stats.tiers[tier] += 1;
      if (t.nextRefreshAt <= now) due.push(mint);
    }
    stats.due = due.length;
    if (due.length === 0) return stats;

    // Tokens with a recently-resolved best pair go through the cheap /pairs
    // endpoint; the rest (new, or due for best-pair re-resolution) via /tokens.
    const reresolveMs = RUNTIME.dexscreener.pairReresolveMinutes * 60_000;
    const knownPairs = new Map<string, string>();
    for (const mint of due) {
      const t = this.watchlist.get(mint);
      const pair = t?.lastSnapshot?.pairAddress;
      if (t && pair && now - t.pairResolvedAt < reresolveMs) knownPairs.set(mint, pair);
    }
    const { snapshots, errors } = await fetchMarketSnapshots(due, knownPairs);
    stats.snapshots = snapshots;
    stats.viaPairs = knownPairs.size;
    stats.errors.push(...errors);
    const priceRetentionMs = RUNTIME.priceHistoryRetentionMinutes * 60_000;
    const txRetentionMs = RUNTIME.txHistoryRetentionMinutes * 60_000;

    for (const mint of due) {
      const token = this.watchlist.get(mint);
      if (!token) continue;
      const snap = snapshots.get(mint);
      if (snap) {
        token.symbol = snap.symbol;
        token.lastSnapshot = snap;
        token.unresolvedStreak = 0;
        if (!knownPairs.has(mint) || knownPairs.get(mint) !== snap.pairAddress) token.pairResolvedAt = now;
        pushSample(token.priceHistory, snap.fetchedAt, snap.priceUsd, priceRetentionMs);
        if (snap.buys5m !== null && snap.sells5m !== null) {
          pushSample(token.txHistory, snap.fetchedAt, snap.buys5m + snap.sells5m, txRetentionMs);
        }
        stats.refreshed += 1;
      } else {
        if (errors.length === 0) token.unresolvedStreak += 1; // a batch failure isn't the token's fault
        stats.unresolved += 1;
      }
      // Schedule the next refresh from the (possibly new) tier. A batch-level
      // API failure leaves snapshots empty; keep those tokens due next cycle.
      const tier = errors.length > 0 && !snap ? "hot" : this.tierOf(token);
      token.nextRefreshAt = tier === "hot" ? 0 : now + (tier === "warm" ? RUNTIME.refresh.warmIntervalMs : RUNTIME.refresh.coldIntervalMs);
    }

    stats.evicted = this.evict(now, positionMints);
    return stats;
  }

  private evict(now: number, exclude: Set<string>): number {
    let evicted = 0;
    const idleMs = RUNTIME.watchlistMaxIdleMinutes * 60_000;
    const unresolvedMs = RUNTIME.watchlistUnresolvedEvictMinutes * 60_000;
    for (const [mint, t] of this.watchlist) {
      if (exclude.has(mint)) continue;
      if (t.source === "seed") continue;
      const neverResolved = t.lastSnapshot === null && now - t.firstSeenAt > unresolvedMs;
      const wentDark = t.lastSnapshot !== null && t.unresolvedStreak > 0 && now - t.lastSnapshot.fetchedAt > unresolvedMs;
      const idle = now - t.lastDiscoveredAt > idleMs && watchRank(t) === 0;
      if (neverResolved || wentDark || idle) {
        this.forget(mint);
        evicted += 1;
      }
    }
    // Hard size cap: drop out-of-range tokens first, then watch-only, then
    // in-band; least recently discovered first within each.
    if (this.watchlist.size > RUNTIME.watchlistMaxSize) {
      const removable = Array.from(this.watchlist.values())
        .filter((t) => !exclude.has(t.tokenAddress) && t.source !== "seed")
        .sort((a, b) => watchRank(a) - watchRank(b) || a.lastDiscoveredAt - b.lastDiscoveredAt);
      const excess = this.watchlist.size - RUNTIME.watchlistMaxSize;
      for (const t of removable.slice(0, excess)) {
        this.forget(t.tokenAddress);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Tokens that pass a book's band classification + full entry filter right
   * now. Only the main book (v1.2) records reject reasons for the funnel.
   */
  candidates(now: number, exclude: Set<string>, profile: StrategyProfile = PROFILE_V12): Candidate[] {
    const main = profile === PROFILE_V12;
    const reasons = main ? null : this.rejectReasonsFor(profile);
    const out: Candidate[] = [];
    for (const token of this.watchlist.values()) {
      if (exclude.has(token.tokenAddress)) continue;
      if (token.gateCooldownUntil !== null && now < token.gateCooldownUntil) continue;
      const snap = token.lastSnapshot;
      if (!snap || now - snap.fetchedAt > RUNTIME.scanIntervalMs * 2) continue; // stale snapshot = no signal
      const band = classifyBand(snap.marketCapUsd, profile.bands);
      if (!band) continue;
      const filter = evaluateEntryFilter(token, snap, band, now, profile);
      if (!filter.passed) {
        if (main) token.lastRejectReason = filter.reasons[0] ?? null;
        else reasons!.set(token.tokenAddress, filter.reasons[0] ?? null);
        continue;
      }
      out.push({ token, snapshot: snap, band });
    }
    out.sort((a, b) => (b.snapshot.volume5mUsd ?? 0) - (a.snapshot.volume5mUsd ?? 0));
    return out;
  }

  markGateFailure(mint: string, reason: string, now: number, cooldownMinutes: number): void {
    const t = this.watchlist.get(mint);
    if (!t) return;
    t.gateCooldownUntil = now + cooldownMinutes * 60_000;
    t.lastRejectReason = reason;
  }

  /**
   * Reporting only: why in-band tokens are not candidates right now, bucketed
   * by the first failing check, plus how many have enough clean history to
   * pass the local-high check at all.
   */
  funnel(now: number, profile: StrategyProfile = PROFILE_V12): ScannerFunnel {
    const main = profile === PROFILE_V12;
    const bookReasons = main ? null : this.rejectReasonsFor(profile);
    const reasons: Record<string, number> = {};
    let inBand = 0;
    let eligibleHistory = 0;
    let onGateCooldown = 0;
    const lookbackMs = PRICE_STRUCTURE.localHighLookbackMinutes * 60_000;
    const minHistMs = PRICE_STRUCTURE.minPriceHistoryMinutes * 60_000;
    const maxGapMs = PRICE_STRUCTURE.maxPriceHistoryGapMinutes * 60_000;
    for (const t of this.watchlist.values()) {
      if (!t.lastSnapshot || classifyBand(t.lastSnapshot.marketCapUsd, profile.bands) === null) continue;
      inBand += 1;
      if (t.gateCooldownUntil !== null && now < t.gateCooldownUntil) onGateCooldown += 1;
      const h = t.priceHistory;
      if (h.length > 0 && now - h[0].t >= minHistMs) {
        let gap = 0;
        const lb = now - lookbackMs;
        for (let i = 1; i < h.length; i++) if (h[i].t >= lb) gap = Math.max(gap, h[i].t - Math.max(h[i - 1].t, lb));
        gap = Math.max(gap, now - h[h.length - 1].t);
        if (gap <= maxGapMs) eligibleHistory += 1;
      }
      // A security-gate cooldown is about the token, so it shows in every book's funnel.
      const own = main ? t.lastRejectReason : (bookReasons!.get(t.tokenAddress) ?? null);
      const gated = t.gateCooldownUntil !== null && now < t.gateCooldownUntil;
      const bucket = bucketReason(gated && !main ? (t.lastRejectReason ?? own) : own);
      reasons[bucket] = (reasons[bucket] ?? 0) + 1;
    }
    return { inBand, eligibleHistory, onGateCooldown, reasons };
  }
}

export interface ScannerFunnel {
  inBand: number;
  eligibleHistory: number;
  onGateCooldown: number;
  reasons: Record<string, number>;
}

/** Keep-priority on the watchlist: 2 = tradable band, 1 = watch-only range, 0 = neither. */
function watchRank(t: WatchedToken): number {
  const mcap = t.lastSnapshot?.marketCapUsd ?? null;
  if (classifyBand(mcap) !== null) return 2;
  return isWatchOnly(mcap) ? 1 : 0;
}

function bucketReason(reason: string | null): string {
  if (!reason) return "not evaluated";
  if (reason.startsWith("liquidity")) return "liquidity";
  if (reason.startsWith("5m volume")) return "5m volume";
  if (reason.startsWith("5m tx count")) return "5m tx count";
  if (reason.startsWith("buy:sell")) return "buy:sell ratio";
  if (reason.startsWith("5m change") || reason.startsWith("5m price change")) return "5m price change";
  if (reason.startsWith("1h")) return "1h extended";
  if (reason.startsWith("tx acceleration")) return "tx acceleration";
  if (reason.startsWith("age") || reason.startsWith("pair age")) return "token age";
  if (reason.startsWith("price history") || reason.startsWith("no price history")) return "price history";
  if (reason.startsWith("not a new")) return "not a new high";
  return "security gate";
}
