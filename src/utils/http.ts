// Small fetch wrapper used by every data client. It NEVER throws: every
// failure (network, timeout, non-2xx, bad JSON) is returned as { ok: false }
// so callers are forced to handle it explicitly and fail closed.

import { RUNTIME } from "../config";
import { errMsg } from "./format";
import { countApiCall, serviceForUrl } from "./metrics";

export type HttpResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number | null };

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = RUNTIME.apiTimeoutMs,
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  countApiCall(serviceForUrl(url));
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      return { ok: false, error: `HTTP ${res.status}${body ? `: ${body}` : ""}`, status: res.status };
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${errMsg(e)}`, status: res.status };
    }
    return { ok: true, data, status: res.status };
  } catch (e) {
    const msg = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : errMsg(e);
    return { ok: false, error: msg, status: null };
  } finally {
    clearTimeout(timer);
  }
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
