import { describe, expect, it } from "vitest";
import { BACKGROUND_JOB_FLAGS, parseEnvFlag, parseServerConfig } from "./config.js";
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
