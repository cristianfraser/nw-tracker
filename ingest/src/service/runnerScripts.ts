import { spawnSync } from "node:child_process";

/**
 * A shell runner (`daily-run.sh` / `email-run.sh`) started by hand or by a timed LaunchAgent still
 * installed: this service must not start a run beside it (shared document ledger, broker-mail
 * watermark and SQLite file, none of them locked).
 */
export function runnerScriptRunningOutside(): boolean {
  const r = spawnSync("/usr/bin/pgrep", ["-f", "ingest/(daily|email)-run\\.sh"], { encoding: "utf8" });
  return typeof r.stdout === "string" && r.stdout.trim().length > 0;
}
