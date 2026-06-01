import { logHttpOutEnabled, logServer, redactUrlForLog } from "./serverLog.js";

/**
 * `fetch` wrapper for third-party HTTP. Logs label, redacted URL, status, and duration when
 * `DEBUG_HTTP_OUT=1` or `DEBUG_VERBOSE=1`.
 */
export async function fetchOut(
  label: string,
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const href = typeof url === "string" ? url : url.toString();
  const enabled = logHttpOutEnabled();
  const t0 = enabled ? performance.now() : 0;
  if (enabled) {
    logServer("http-out", `--> ${label} ${redactUrlForLog(href)}`);
  }
  try {
    const res = await fetch(href, init);
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
    throw e;
  }
}
