/**
 * Opt-in verbose server logging (stderr).
 *
 * `DEBUG_VERBOSE=1` — all channels below.
 * `DEBUG_HTTP=1` — incoming Express requests.
 * `DEBUG_HTTP_OUT=1` — outbound `fetch` to third parties.
 * `DEBUG_DB=1` — SQLite statements slower than `DEBUG_DB_SLOW_MS` (default 20).
 * `DEBUG_DB_ALL=1` — every SQLite statement (very noisy; also on with `DEBUG_VERBOSE` if slow ms is 0).
 * `DEBUG_PERF=1` — labeled expensive work (`timeHeavy` / `timeHeavyAsync`).
 */

function envTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function verboseAllEnabled(): boolean {
  return envTruthy("DEBUG_VERBOSE");
}

export function logHttpInEnabled(): boolean {
  return verboseAllEnabled() || envTruthy("DEBUG_HTTP");
}

export function logHttpOutEnabled(): boolean {
  return verboseAllEnabled() || envTruthy("DEBUG_HTTP_OUT");
}

export function logDbEnabled(): boolean {
  return verboseAllEnabled() || envTruthy("DEBUG_DB");
}

export function logDbAllStatements(): boolean {
  return envTruthy("DEBUG_DB_ALL") || (verboseAllEnabled() && process.env.DEBUG_DB_SLOW_MS?.trim() === "0");
}

export function logHeavyEnabled(): boolean {
  return verboseAllEnabled() || envTruthy("DEBUG_PERF");
}

export function dbSlowThresholdMs(): number {
  if (logDbAllStatements()) return 0;
  const raw = process.env.DEBUG_DB_SLOW_MS?.trim();
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return verboseAllEnabled() || envTruthy("DEBUG_DB") ? 20 : Infinity;
}

export function logServer(channel: string, message: string): void {
  console.error(`[${channel}] ${message}`);
}

/** Hide credentials in outbound URL query strings (BCentral, etc.). */
export function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["pass", "password", "token", "api_key", "apikey"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    const q = url.indexOf("?");
    if (q < 0) return url;
    return `${url.slice(0, q)}?…`;
  }
}
