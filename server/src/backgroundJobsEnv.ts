/**
 * Umbrella kill-switch for the in-process background schedulers.
 *
 * `BACKGROUND_JOBS_ENABLED=0` defaults GLOBAL_SYNC_ENABLED / LIVE_QUOTES_SYNC_ENABLED /
 * DB_BACKUP_ENABLED / CACHE_WARM_ENABLED to "0"; an explicitly set per-job flag wins
 * (same precedence as demo mode's env defaults).
 *
 * Purpose: secondary dev servers (agent-spawned `.claude/launch.json` configs) share the
 * real SQLite file with the user's primary app. Two processes each running the schedulers
 * double-run every due sync (duplicate `Sync` app_messages rows) and race writes
 * ("database is locked"). Only the primary app instance should run background jobs.
 */

const BACKGROUND_JOB_ENV_FLAGS = [
  "GLOBAL_SYNC_ENABLED",
  "LIVE_QUOTES_SYNC_ENABLED",
  "DB_BACKUP_ENABLED",
  "CACHE_WARM_ENABLED",
] as const;

export function backgroundJobsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BACKGROUND_JOBS_ENABLED?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

/** Call once at boot, after `loadRootDotenv()` and before the schedulers start. */
export function applyBackgroundJobsEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (!backgroundJobsDisabled(env)) return;
  for (const name of BACKGROUND_JOB_ENV_FLAGS) {
    if (env[name] === undefined) env[name] = "0";
  }
  console.log(
    "background jobs: BACKGROUND_JOBS_ENABLED=0 — sync/live-quotes/backup/cache-warm schedulers default off"
  );
}
