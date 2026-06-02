import { afterEach, describe, expect, it } from "vitest";
import {
  dbSlowThresholdMs,
  logDbAllStatements,
  logDbEnabled,
  logHeavyEnabled,
  logHttpInEnabled,
  logHttpOutEnabled,
  formatLogServerLine,
  redactUrlForLog,
  serverLogTimestamp,
  verboseAllEnabled,
} from "./serverLog.js";

const ENV_KEYS = [
  "DEBUG_VERBOSE",
  "DEBUG_HTTP",
  "DEBUG_HTTP_OUT",
  "DEBUG_DB",
  "DEBUG_DB_ALL",
  "DEBUG_DB_SLOW_MS",
  "DEBUG_PERF",
] as const;

function clearLogEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("serverLog env flags", () => {
  afterEach(() => {
    clearLogEnv();
  });

  it("DEBUG_VERBOSE enables all channels", () => {
    process.env.DEBUG_VERBOSE = "1";
    expect(verboseAllEnabled()).toBe(true);
    expect(logHttpInEnabled()).toBe(true);
    expect(logHttpOutEnabled()).toBe(true);
    expect(logDbEnabled()).toBe(true);
    expect(logHeavyEnabled()).toBe(true);
    expect(dbSlowThresholdMs()).toBe(20);
  });

  it("DEBUG_DB_ALL logs every statement", () => {
    process.env.DEBUG_DB_ALL = "1";
    expect(logDbAllStatements()).toBe(true);
    expect(dbSlowThresholdMs()).toBe(0);
  });
});

describe("formatLogServerLine", () => {
  it("prefixes channel lines with Chile wall clock and UTC offset", () => {
    const fixed = new Date("2026-06-01T19:58:14.640Z");
    expect(serverLogTimestamp(fixed, "America/Santiago")).toBe("[2026-06-01 -- 15:58:14 (-4)]");
    expect(formatLogServerLine("api", "--> GET /api/health", fixed)).toBe(
      "[2026-06-01 -- 15:58:14 (-4)] [api] --> GET /api/health"
    );
  });
});

describe("redactUrlForLog", () => {
  it("redacts BCentral credentials in query string", () => {
    const out = redactUrlForLog(
      "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?user=a@b.com&pass=secret&function=GetSeries"
    );
    expect(out).toMatch(/user=a(%40|@)b\.com/);
    expect(out).toContain("pass=***");
    expect(out).not.toContain("secret");
  });
});
