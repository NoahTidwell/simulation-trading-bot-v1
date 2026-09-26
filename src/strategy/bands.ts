import { BAND_PARAMS, WATCH_ONLY_MIN_MARKET_CAP_USD } from "../config";
import type { Band, BandParams } from "../types";

/** Classify by market cap against a book's bands (default v1.2's). Returns null when outside both. */
export function classifyBand(marketCapUsd: number | null, bands: Record<Band, BandParams> = BAND_PARAMS): Band | null {
  if (marketCapUsd === null || !Number.isFinite(marketCapUsd)) return null;
  const a = bands.A;
  const b = bands.B;
  if (marketCapUsd >= a.marketCapMinUsd && marketCapUsd < a.marketCapMaxUsd) return "A";
  if (marketCapUsd >= b.marketCapMinUsd && marketCapUsd <= b.marketCapMaxUsd) return "B";
  return null;
}

/** Watch-only range: below v1.2's band A, above WATCH_ONLY_MIN_MARKET_CAP_USD. Refreshed and recorded like band A; never traded by v1.2. */
export function isWatchOnly(marketCapUsd: number | null): boolean {
  if (marketCapUsd === null || !Number.isFinite(marketCapUsd) || WATCH_ONLY_MIN_MARKET_CAP_USD <= 0) return false;
  return marketCapUsd >= WATCH_ONLY_MIN_MARKET_CAP_USD && marketCapUsd < BAND_PARAMS.A.marketCapMinUsd;
}

export function getBandParams(band: Band, bands: Record<Band, BandParams> = BAND_PARAMS): BandParams {
  return bands[band];
}
