import { DEMO_SYNC_DISABLED_SOURCES, type GlobalSyncSource } from "./syncSourceIds.js";

/**
 * The server's configuration: every flag and tuning variable it reads from the environment,
 * parsed by one set of rules (2026-11-07, docs/untangle-plan.md F14).
 *
 * - **One truthiness rule.** A flag is on for `1` / `true` / `yes`, off for `0` / `false` / `no`
 *   (case and surrounding space ignored), its default when unset or empty; anything else throws.
 * - **One default order.** A flag's value is, first to last: what the environment sets
 *   explicitly; the demo's default (`DEMO_MODE=1`); the background-jobs default
 *   (`BACKGROUND_JOBS_ENABLED=0`); the built-in default. Until 2026-11-07 the demo and
 *   background defaults were written into `process.env` at boot, in whichever order `index.ts`
 *   called them.
 * - **When it is read.** `index.ts` calls {@link initServerConfig} once, after `loadRootDotenv()`:
 *   from then on every flag is the boot value, a restart picks up a change. Code that never calls
 *   it (tests, one-off scripts) reads the current `process.env` on each call, so a test may set a
 *   variable and see it. Credentials (`BCENTRAL_*`, `COINGECKO_API_KEY`, `INGEST_TOKEN`) are not
 *   here: they are read where used after `loadRootDotenv()`, so a key added to `.env` is picked up
 *   without a restart.
 */

export type DeploymentProfile = {
  /** `DEMO_MODE`: the hosted, public, read-only demo. */
  demo: boolean;
  /** The `/api` is read-only (the demo's write guard, `httpSecurity.ts`). */
  readOnlyApi: boolean;
  /** Sync sources this deployment never runs (shown «Not configured»). */
  disabledSyncSources: ReadonlySet<GlobalSyncSource>;
  /** Where UNO's official valor cuota comes from (`afpUnoOfficialSync.ts`). */
  afpUnoOfficialSource: "sp" | "uno_api";
  /** The market schedulers sleep while nobody browses (`demoMarketActivity.ts`). */
  marketAwakeGate: boolean;
  /** The usage log is written to the demo's analytics file, not the main DB (`usageDb.ts`). */
  usageInAnalyticsDb: boolean;
};

export type ServerConfig = {
  port: number;
  bindHost: string;
  corsOrigins: string[];
  profile: DeploymentProfile;
  backgroundJobs: boolean;
  globalSync: { enabled: boolean; intervalMs: number; nyseStaleIntervalMs: number; wakeGapMs: number };
  liveQuotes: {
    enabled: boolean;
    intervalMs: number;
    sessionIntervalMs: number;
    retentionHours: number;
    /** Explicit `LIVE_QUOTES_MAX_AGE_MS`, or 2 × the interval. */
    maxAgeMs: number;
    streamEnabled: boolean;
    streamUrl: string;
    flushGapMs: number;
  };
  dbBackup: { enabled: boolean; keep: number; dir: string | null; dirKeep: number };
  cacheWarm: boolean;
  usageLog: boolean;
  /** The ingest scheduler (`ingestRunScheduler.ts`): only the primary instance's LaunchAgent sets it. */
  ingestScheduler: boolean;
  /** The job queue's executor (`jobQueueExecutor.ts`); defaults to the ingest scheduler's value. */
  jobQueueExecutor: boolean;
  bcentralGate: { minIntervalMs: number; backoffBaseMs: number; backoffMaxMs: number };
  log: {
    verbose: boolean;
    http: boolean;
    httpOut: boolean;
    db: boolean;
    dbAll: boolean;
    perf: boolean;
    /** Raw `DEBUG_DB_SLOW_MS` (null when unset); `serverLog.ts` derives the threshold. */
    dbSlowMs: number | null;
    timeZone: string;
  };
};

/** The flags `BACKGROUND_JOBS_ENABLED=0` defaults off. */
export const BACKGROUND_JOB_FLAGS = [
  "GLOBAL_SYNC_ENABLED",
  "LIVE_QUOTES_SYNC_ENABLED",
  "DB_BACKUP_ENABLED",
  "CACHE_WARM_ENABLED",
  "USAGE_LOG_ENABLED",
  "INGEST_SCHEDULER_ENABLED",
  "JOB_QUEUE_EXECUTOR_ENABLED",
] as const;

/**
 * The demo's defaults: the market syncs run (only while someone browses), backups are pointless
 * against a regenerated DB, and the usage log goes to the demo's own analytics file.
 */
export const DEMO_FLAG_DEFAULTS: Readonly<Record<string, boolean>> = {
  GLOBAL_SYNC_ENABLED: true,
  LIVE_QUOTES_SYNC_ENABLED: true,
  DB_BACKUP_ENABLED: false,
  USAGE_LOG_ENABLED: true,
};

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** `1/true/yes` → true, `0/false/no` → false, unset or empty → null; anything else throws. */
export function parseEnvFlag(name: string, raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`${name}=${JSON.stringify(raw)}: expected 1/true/yes or 0/false/no`);
}

/** A positive number, or the fallback when unset or empty; anything else throws. */
function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}=${JSON.stringify(env[name])}: expected a positive number`);
  return n;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return Math.trunc(positiveNumber(env, name, fallback));
}

function text(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

/** Parse the whole configuration from `env` (pure). */
export function parseServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const demo = parseEnvFlag("DEMO_MODE", env.DEMO_MODE) ?? false;
  const backgroundJobs = parseEnvFlag("BACKGROUND_JOBS_ENABLED", env.BACKGROUND_JOBS_ENABLED) ?? true;
  const flag = (name: string, builtIn: boolean): boolean => {
    const explicit = parseEnvFlag(name, env[name]);
    if (explicit != null) return explicit;
    if (demo && name in DEMO_FLAG_DEFAULTS) return DEMO_FLAG_DEFAULTS[name]!;
    if (!backgroundJobs && (BACKGROUND_JOB_FLAGS as readonly string[]).includes(name)) return false;
    return builtIn;
  };
  // A second ingest scheduler would start every bank run twice, so `BACKGROUND_JOBS_ENABLED=0`
  // turns it off whatever its own flag says.
  const ingestScheduler = backgroundJobs && (parseEnvFlag("INGEST_SCHEDULER_ENABLED", env.INGEST_SCHEDULER_ENABLED) ?? false);
  const jobQueueExecutor = backgroundJobs && (parseEnvFlag("JOB_QUEUE_EXECUTOR_ENABLED", env.JOB_QUEUE_EXECUTOR_ENABLED) ?? ingestScheduler);
  const liveIntervalMs = positiveNumber(env, "LIVE_QUOTES_INTERVAL_MS", 5 * 60 * 1000);
  const corsFromEnv = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const verbose = parseEnvFlag("DEBUG_VERBOSE", env.DEBUG_VERBOSE) ?? false;
  const dbSlowRaw = text(env, "DEBUG_DB_SLOW_MS");
  return {
    port: positiveInteger(env, "PORT", 3001),
    bindHost: text(env, "HOST") ?? "127.0.0.1",
    corsOrigins: corsFromEnv.length > 0 ? corsFromEnv : DEFAULT_DEV_ORIGINS,
    profile: {
      demo,
      readOnlyApi: demo,
      disabledSyncSources: new Set(demo ? DEMO_SYNC_DISABLED_SOURCES : []),
      afpUnoOfficialSource: demo ? "uno_api" : "sp",
      marketAwakeGate: demo,
      usageInAnalyticsDb: demo,
    },
    backgroundJobs,
    globalSync: {
      enabled: flag("GLOBAL_SYNC_ENABLED", true),
      intervalMs: positiveNumber(env, "GLOBAL_SYNC_INTERVAL_MS", 15 * 60 * 1000),
      nyseStaleIntervalMs: positiveNumber(env, "GLOBAL_SYNC_NYSE_STALE_INTERVAL_MS", 3 * 60 * 1000),
      wakeGapMs: positiveNumber(env, "GLOBAL_SYNC_WAKE_GAP_MS", 5 * 60 * 1000),
    },
    liveQuotes: {
      enabled: flag("LIVE_QUOTES_SYNC_ENABLED", true),
      intervalMs: liveIntervalMs,
      sessionIntervalMs: positiveNumber(env, "LIVE_QUOTES_SESSION_INTERVAL_MS", 2 * 60 * 1000),
      retentionHours: positiveNumber(env, "LIVE_QUOTES_RETENTION_HOURS", 48),
      maxAgeMs: positiveNumber(env, "LIVE_QUOTES_MAX_AGE_MS", liveIntervalMs * 2),
      streamEnabled: flag("LIVE_QUOTES_STREAM_ENABLED", true),
      streamUrl: text(env, "LIVE_QUOTES_STREAM_URL") ?? "wss://streamer.finance.yahoo.com/?version=2",
      flushGapMs: positiveNumber(env, "LIVE_QUOTES_FLUSH_GAP_MS", 5_000),
    },
    dbBackup: {
      enabled: flag("DB_BACKUP_ENABLED", true),
      keep: positiveInteger(env, "DB_BACKUP_KEEP", 14),
      dir: text(env, "DB_BACKUP_DIR"),
      dirKeep: positiveInteger(env, "DB_BACKUP_DIR_KEEP", 60),
    },
    cacheWarm: flag("CACHE_WARM_ENABLED", true),
    usageLog: flag("USAGE_LOG_ENABLED", true),
    ingestScheduler,
    jobQueueExecutor,
    bcentralGate: {
      minIntervalMs: positiveNumber(env, "BCENTRAL_MIN_REQUEST_INTERVAL_MS", positiveNumber(env, "SBIF_MIN_REQUEST_INTERVAL_MS", 3_000)),
      backoffBaseMs: positiveNumber(env, "BCENTRAL_BACKOFF_BASE_MS", positiveNumber(env, "SBIF_BACKOFF_BASE_MS", 15 * 60 * 1000)),
      backoffMaxMs: positiveNumber(env, "BCENTRAL_BACKOFF_MAX_MS", positiveNumber(env, "SBIF_BACKOFF_MAX_MS", 6 * 60 * 60 * 1000)),
    },
    log: {
      verbose,
      http: verbose || (parseEnvFlag("DEBUG_HTTP", env.DEBUG_HTTP) ?? false),
      httpOut: verbose || (parseEnvFlag("DEBUG_HTTP_OUT", env.DEBUG_HTTP_OUT) ?? false),
      db: verbose || (parseEnvFlag("DEBUG_DB", env.DEBUG_DB) ?? false),
      dbAll: (parseEnvFlag("DEBUG_DB_ALL", env.DEBUG_DB_ALL) ?? false) || (verbose && dbSlowRaw === "0"),
      perf: verbose || (parseEnvFlag("DEBUG_PERF", env.DEBUG_PERF) ?? false),
      dbSlowMs: dbSlowRaw == null ? null : Number(dbSlowRaw),
      timeZone: text(env, "SERVER_LOG_TIMEZONE") ?? "America/Santiago",
    },
  };
}

let bootConfig: ServerConfig | null = null;

/** Parse once at boot (after `loadRootDotenv()`); every later {@link serverConfig} call reads it. */
export function initServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  bootConfig = parseServerConfig(env);
  return bootConfig;
}

/** The boot configuration; before {@link initServerConfig} (tests, scripts), the current env. */
export function serverConfig(): ServerConfig {
  return bootConfig ?? parseServerConfig(process.env);
}

export function deploymentProfile(): DeploymentProfile {
  return serverConfig().profile;
}

/** One line for the boot log. */
export function describeServerConfig(c: ServerConfig): string {
  const on = (b: boolean) => (b ? "on" : "off");
  return (
    `config: ${c.profile.demo ? "demo" : "personal"} profile; background jobs ${on(c.backgroundJobs)}; ` +
    `global sync ${on(c.globalSync.enabled)}, live quotes ${on(c.liveQuotes.enabled)}, backup ${on(c.dbBackup.enabled)}, ` +
    `cache warm ${on(c.cacheWarm)}, usage log ${on(c.usageLog)}, ingest scheduler ${on(c.ingestScheduler)}, ` +
    `job executor ${on(c.jobQueueExecutor)}`
  );
}
