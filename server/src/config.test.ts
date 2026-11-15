import { describe, expect, it } from "vitest";
import { BACKGROUND_JOB_FLAGS, liveEnvFlag, liveEnvRaw, liveEnvText, parseEnvFlag, parseServerConfig } from "./config.js";
import { ingestAuthConfigFromEnv } from "./ingestAuth.js";
import { resolveIngestServiceUrl } from "./ingestFeeder.js";
import { DEMO_SYNC_DISABLED_SOURCES } from "./syncSourceIds.js";

describe("parseEnvFlag", () => {
  it("reads 1/true/yes as on and 0/false/no as off, whatever the case and spaces", () => {
    for (const v of ["1", "true", "YES", " True "]) expect(parseEnvFlag("X", v)).toBe(true);
    for (const v of ["0", "false", " NO ", "False"]) expect(parseEnvFlag("X", v)).toBe(false);
  });

  it("leaves an unset or empty flag to its default, and refuses anything else", () => {
    expect(parseEnvFlag("X", undefined)).toBeNull();
    expect(parseEnvFlag("X", "  ")).toBeNull();
    expect(() => parseEnvFlag("X", "on")).toThrow(/X="on"/);
  });
});

describe("parseServerConfig defaults, in order: explicit, demo, background jobs, built-in", () => {
  it("turns every scheduler on by default, the ingest scheduler and its executor off", () => {
    const c = parseServerConfig({});
    expect([c.globalSync.enabled, c.liveQuotes.enabled, c.dbBackup.enabled, c.cacheWarm, c.usageLog]).toEqual([true, true, true, true, true]);
    expect([c.ingestScheduler, c.jobQueueExecutor]).toEqual([false, false]);
    expect(c.profile.demo).toBe(false);
    expect(c.profile.disabledSyncSources.size).toBe(0);
    expect(c.profile.afpUnoOfficialSource).toBe("sp");
  });

  it("BACKGROUND_JOBS_ENABLED=0 defaults every background flag off; an explicit flag still wins", () => {
    const off = parseServerConfig({ BACKGROUND_JOBS_ENABLED: "0" });
    expect([off.globalSync.enabled, off.liveQuotes.enabled, off.dbBackup.enabled, off.cacheWarm, off.usageLog]).toEqual([false, false, false, false, false]);
    expect(parseServerConfig({ BACKGROUND_JOBS_ENABLED: "no", GLOBAL_SYNC_ENABLED: "1" }).globalSync.enabled).toBe(true);
    expect(BACKGROUND_JOB_FLAGS).toContain("USAGE_LOG_ENABLED");
  });

  it("never runs the ingest scheduler or its executor with background jobs off, whatever their flags say", () => {
    expect(parseServerConfig({ INGEST_SCHEDULER_ENABLED: "1" })).toMatchObject({ ingestScheduler: true, jobQueueExecutor: true });
    expect(parseServerConfig({ INGEST_SCHEDULER_ENABLED: "1", BACKGROUND_JOBS_ENABLED: "0" })).toMatchObject({
      ingestScheduler: false,
      jobQueueExecutor: false,
    });
    expect(parseServerConfig({ INGEST_SCHEDULER_ENABLED: "1", JOB_QUEUE_EXECUTOR_ENABLED: "0" }).jobQueueExecutor).toBe(false);
  });

  it("the demo profile: market syncs and the usage log on (even with background jobs off), backups off, author-only sources out", () => {
    const c = parseServerConfig({ DEMO_MODE: "1", BACKGROUND_JOBS_ENABLED: "0" });
    expect([c.globalSync.enabled, c.liveQuotes.enabled, c.usageLog, c.dbBackup.enabled]).toEqual([true, true, true, false]);
    expect(c.cacheWarm).toBe(false);
    expect(c.profile).toMatchObject({ demo: true, readOnlyApi: true, afpUnoOfficialSource: "uno_api", marketAwakeGate: true, usageInAnalyticsDb: true });
    expect([...c.profile.disabledSyncSources].sort()).toEqual([...DEMO_SYNC_DISABLED_SOURCES].sort());
    expect(parseServerConfig({ DEMO_MODE: "true", DB_BACKUP_ENABLED: "1" }).dbBackup.enabled).toBe(true);
  });

  it("reads numbers, refusing a malformed one", () => {
    const c = parseServerConfig({ LIVE_QUOTES_INTERVAL_MS: "60000", PORT: "4000", DB_BACKUP_KEEP: "3" });
    expect(c.liveQuotes.intervalMs).toBe(60_000);
    expect(c.liveQuotes.maxAgeMs).toBe(120_000);
    expect(c.port).toBe(4000);
    expect(c.dbBackup.keep).toBe(3);
    expect(() => parseServerConfig({ GLOBAL_SYNC_INTERVAL_MS: "soon" })).toThrow(/GLOBAL_SYNC_INTERVAL_MS/);
  });

  it("debug channels: DEBUG_VERBOSE turns them all on", () => {
    expect(parseServerConfig({ DEBUG_VERBOSE: "1" }).log).toMatchObject({ http: true, httpOut: true, db: true, perf: true, dbAll: false });
    expect(parseServerConfig({ DEBUG_VERBOSE: "1", DEBUG_DB_SLOW_MS: "0" }).log.dbAll).toBe(true);
  });
});

describe("live variables", () => {
  it("are read on each call, trimmed, null when unset or empty", () => {
    const env: NodeJS.ProcessEnv = { INGEST_TOKEN: "  abc  ", INGEST_URL: "   ", FINTUAL_PASSWORD: " p w " };
    expect(liveEnvText("INGEST_TOKEN", env)).toBe("abc");
    expect(liveEnvText("INGEST_URL", env)).toBeNull();
    expect(liveEnvText("COINGECKO_API_KEY", env)).toBeNull();
    expect(liveEnvRaw("FINTUAL_PASSWORD", env)).toBe(" p w ");
    env.INGEST_TOKEN = "later";
    expect(liveEnvText("INGEST_TOKEN", env)).toBe("later");
  });

  it("read the process environment as it is now, not as it was at boot", () => {
    const before = process.env.PORTFOLIO_START_YMD;
    try {
      process.env.PORTFOLIO_START_YMD = "2019-01-01";
      expect(liveEnvText("PORTFOLIO_START_YMD")).toBe("2019-01-01");
      process.env.PORTFOLIO_START_YMD = "2020-02-02";
      expect(liveEnvText("PORTFOLIO_START_YMD")).toBe("2020-02-02");
    } finally {
      if (before === undefined) delete process.env.PORTFOLIO_START_YMD;
      else process.env.PORTFOLIO_START_YMD = before;
    }
  });

  it("flags follow the one truthiness rule and are off when unset", () => {
    expect(liveEnvFlag("SERVE_CLIENT_DIST", {})).toBe(false);
    expect(liveEnvFlag("SERVE_CLIENT_DIST", { SERVE_CLIENT_DIST: "1" })).toBe(true);
    expect(liveEnvFlag("SERVE_CLIENT_DIST", { SERVE_CLIENT_DIST: "0" })).toBe(false);
    expect(() => liveEnvFlag("SERVE_CLIENT_DIST", { SERVE_CLIENT_DIST: "on" })).toThrow(/SERVE_CLIENT_DIST/);
  });

  it("ingest: the service URL and the access rule come from the given environment", () => {
    expect(resolveIngestServiceUrl({ INGEST_URL: "http://10.0.0.2:3002//" })).toBe("http://10.0.0.2:3002");
    expect(ingestAuthConfigFromEnv({ INGEST_TOKEN: "t", INGEST_ALLOW_REMOTE: "1" })).toEqual({ token: "t", allowRemote: true, demoMode: false });
    expect(ingestAuthConfigFromEnv({ DEMO_MODE: "1" }).demoMode).toBe(true);
    expect(() => ingestAuthConfigFromEnv({ INGEST_ALLOW_REMOTE: "1" })).toThrow(/requires INGEST_TOKEN/);
  });
});
