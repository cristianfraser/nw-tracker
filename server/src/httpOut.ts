import { logHttpOutEnabled, logServer, redactUrlForLog } from "./serverLog.js";

/** Unless a request says otherwise: long enough for a year of a public CSV, short enough that a dead host cannot stall a sync forever. */
export const OUTBOUND_TIMEOUT_MS = 60_000;

export type FetchOutOpts = {
  /** The call's own bound (default {@link OUTBOUND_TIMEOUT_MS}); a caller's `init.signal` aborts it sooner. */
  timeoutMs?: number;
};

/** A timeout of `fetchOut`'s own bound, naming the call and the host. */
export class OutboundTimeoutError extends Error {
  constructor(label: string, host: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${label}: no answer from ${host} within ${timeoutMs / 1000}s`, options);
    this.name = "OutboundTimeoutError";
  }
}

/**
 * `fetch` wrapper for third-party HTTP. Every call is bounded: `opts.timeoutMs` (default
 * {@link OUTBOUND_TIMEOUT_MS}), combined with the caller's own `init.signal` when it passed one, so
 * a stalled connection can never hold a sync. A timeout throws {@link OutboundTimeoutError}; a
 * caller's own abort keeps its reason. Logs label, redacted URL, status, and duration when
 * `DEBUG_HTTP_OUT=1` or `DEBUG_VERBOSE=1`.
 */
export async function fetchOut(
  label: string,
  url: string | URL,
  init?: RequestInit,
  opts?: FetchOutOpts
): Promise<Response> {
  const href = typeof url === "string" ? url : url.toString();
  const timeoutMs = opts?.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const enabled = logHttpOutEnabled();
  const t0 = enabled ? performance.now() : 0;
  if (enabled) {
    logServer("http-out", `--> ${label} ${redactUrlForLog(href)}`);
  }
  try {
    const res = await fetch(href, { ...init, signal });
    if (enabled) {
      const ms = (performance.now() - t0).toFixed(1);
      logServer("http-out", `<-- ${label} HTTP ${res.status} ${ms}ms`);
    }
    return res;
  } catch (e) {
    if (enabled) {
      const ms = (performance.now() - t0).toFixed(1);
      const msg = e instanceof Error ? e.message : String(e);
      logServer("http-out", `<-- ${label} ERROR ${ms}ms ${msg}`);
    }
    // Our own bound fired (the caller's signal, if any, did not abort first).
    if (timeout.aborted && !init?.signal?.aborted) {
      throw new OutboundTimeoutError(label, new URL(href).host, timeoutMs, { cause: e });
    }
    throw e;
  }
}
