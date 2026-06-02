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

function envFalsy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

const DEFAULT_LOG_TIME_ZONE = "America/Santiago";

function logTimeZone(): string {
  const tz = process.env.SERVER_LOG_TIMEZONE?.trim();
  return tz && tz.length > 0 ? tz : DEFAULT_LOG_TIME_ZONE;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC offset in whole hours for `timeZone` at instant `d` (e.g. -4 for Chile winter). */
export function utcOffsetHoursForTimeZone(timeZone: string, d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(d);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) {
    throw new Error(`Could not parse time-zone offset from ${JSON.stringify(tz)} (${timeZone})`);
  }
  const sign = m[1] === "-" ? -1 : 1;
  const hours = parseInt(m[2]!, 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (hours + minutes / 60);
}

function formatOffsetSuffix(offsetHours: number): string {
  if (offsetHours === 0) return "(+0)";
  const sign = offsetHours < 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return `(${sign}${body})`;
}

/** Bracketed wall-clock prefix for stderr/stdout server lines. */
export function serverLogTimestamp(d = new Date(), timeZone = logTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value;
  const y = g("year");
  const mo = g("month");
  const day = g("day");
  const h = g("hour");
  const min = g("minute");
  const sec = g("second");
  if (!y || !mo || !day || h == null || min == null || sec == null) {
    throw new Error(`Could not format log timestamp for ${timeZone}`);
  }
  const offset = formatOffsetSuffix(utcOffsetHoursForTimeZone(timeZone, d));
  return `[${y}-${mo}-${day} -- ${pad2(parseInt(h, 10))}:${pad2(parseInt(min, 10))}:${pad2(parseInt(sec, 10))} ${offset}]`;
}

const rawConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function installServerConsoleTimestamps(): void {
  if (envFalsy("SERVER_LOG_TIMESTAMPS")) return;
  const prefix = () => serverLogTimestamp();
  console.log = (...args: unknown[]) => rawConsole.log(prefix(), ...args);
  console.warn = (...args: unknown[]) => rawConsole.warn(prefix(), ...args);
  console.error = (...args: unknown[]) => rawConsole.error(prefix(), ...args);
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

export function formatLogServerLine(channel: string, message: string, d = new Date()): string {
  return `${serverLogTimestamp(d)} [${channel}] ${message}`;
}

export function logServer(channel: string, message: string): void {
  rawConsole.error(formatLogServerLine(channel, message));
}

installServerConsoleTimestamps();

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
