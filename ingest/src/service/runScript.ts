import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ingestRunStepSchema, type IngestRunCompletion, type IngestRunKind } from "nw-tracker-contracts";
import { resolveCfraserDir, resolveRepoRoot } from "../paths.js";

/**
 * One run = one of the shell runners, exactly as the LaunchAgents ran them: `daily-run.sh` for
 * the nightly, `email-run.sh` for the hourly poll. The runner still records its own app message;
 * what comes back here is its exit status and, through `INGEST_STEPS_FILE`, its step list.
 */
const SCRIPT_BY_KIND: Readonly<Record<IngestRunKind, { script: string; log: string }>> = {
  nightly: { script: "daily-run.sh", log: "daily-run.log" },
  hourly: { script: "email-run.sh", log: "email-run.log" },
};

const stepsSchema = z.array(ingestRunStepSchema);

export async function runScript(kind: IngestRunKind, runId: number): Promise<IngestRunCompletion> {
  const { script, log } = SCRIPT_BY_KIND[kind];
  const stepsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-ingest-run-")), "steps.json");
  // The runner's output goes where launchd used to send it, appended per run.
  const logFd = fs.openSync(path.join(resolveCfraserDir(), log), "a");
  const startedAt = new Date().toISOString();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      // INGEST_RUN_DRY=1: a rehearsal — the runners fetch and write nothing, and record nothing.
      const args = [path.join(resolveRepoRoot(), "ingest", script), ...(process.env.INGEST_RUN_DRY === "1" ? ["--dry-run"] : [])];
      const child = spawn("/bin/bash", args, {
        cwd: resolveRepoRoot(),
        env: { ...process.env, INGEST_STEPS_FILE: stepsFile, INGEST_RUN_ID: String(runId) },
        stdio: ["ignore", logFd, logFd],
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
    let steps: IngestRunCompletion["steps"] = null;
    if (fs.existsSync(stepsFile)) {
      const parsed = stepsSchema.safeParse(JSON.parse(fs.readFileSync(stepsFile, "utf8")));
      steps = parsed.success ? parsed.data : null;
    }
    return { started_at: startedAt, finished_at: new Date().toISOString(), exit_code: exitCode, steps };
  } finally {
    fs.closeSync(logFd);
    fs.rmSync(path.dirname(stepsFile), { recursive: true, force: true });
  }
}

/** A runner started by hand (or by a LaunchAgent still installed) that this service did not start. */
export function runnerScriptRunningOutside(): boolean {
  const r = spawnSync("/usr/bin/pgrep", ["-f", "ingest/(daily|email)-run\\.sh"], { encoding: "utf8" });
  return typeof r.stdout === "string" && r.stdout.trim().length > 0;
}
