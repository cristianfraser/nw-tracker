/**
 * Opt-in verbose server logging (stderr).
 *
 * `DEBUG_VERBOSE=1` — all channels below.
 * `DEBUG_HTTP=1` — incoming Express requests.
 * `DEBUG_HTTP_OUT=1` — outbound `fetch` to third parties.
 * `DEBUG_DB=1` — SQLite statements slower than `DEBUG_DB_SLOW_MS` (default 20).
 * `DEBUG_DB_ALL=1` — every SQLite statement (very noisy; also on with `DEBUG_VERBOSE` if slow ms is 0).
 * `DEBUG_PERF=1` — labeled expensive work (`timeHeavy` / `timeHeavyAsync`).
 * Parsed with every other flag in `config.ts`.
 */
import { serverConfig } from "./config.js";

function logTimeZone(): string {
  return serverConfig().log.timeZone;
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
  if (!serverConfig().log.timestamps) return;
  const prefix = () => serverLogTimestamp();
  console.log = (...args: unknown[]) => rawConsole.log(prefix(), ...args);
  console.warn = (...args: unknown[]) => rawConsole.warn(prefix(), ...args);
  console.error = (...args: unknown[]) => rawConsole.error(prefix(), ...args);
}

export function verboseAllEnabled(): boolean {
  return serverConfig().log.verbose;
}

export function logHttpInEnabled(): boolean {
  return serverConfig().log.http;
}

export function logHttpOutEnabled(): boolean {
  return serverConfig().log.httpOut;
}

export function logDbEnabled(): boolean {
  return serverConfig().log.db;
}

export function logDbAllStatements(): boolean {
  return serverConfig().log.dbAll;
}

export function logHeavyEnabled(): boolean {
  return serverConfig().log.perf;
}

export function dbSlowThresholdMs(): number {
  const log = serverConfig().log;
  if (log.dbAll) return 0;
  if (log.dbSlowMs != null) return log.dbSlowMs;
  return log.db ? 20 : Infinity;
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
