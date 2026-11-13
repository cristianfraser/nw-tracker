import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IngestRunStep } from "nw-tracker-contracts";
import { readStepResult, STEP_RESULT_ENV, type StepResult } from "../stepResult.js";

/**
 * Steps of a run: each is one ingest command; a failure is recorded and the run goes on (one bank
 * being down still lets the rest import); every step's label, outcome and duration end up in the
 * run report. What a step found — documents staged, rows written, listings to read — comes back
 * as its `StepResult`, never from its printed output.
 */

/** One ingest command: its `npm run` script and arguments, run in `ingest/`. */
export type IngestCommand = { script: string; args: readonly string[] };

export function ingest(script: string, ...args: string[]): IngestCommand {
  return { script, args };
}

/** A server task (`contracts/tasks.ts`), through the ingest command that asks for it. */
export function serverTask(task: string, ...args: string[]): IngestCommand {
  return ingest("server-task", task, ...args);
}

/** `code`: the command's exit status (0 = ok), for a command whose failures say different things. */
export type StepOutcome = { ok: boolean; code: number; result: StepResult };

export interface StepRunner {
  /** Run one command, record it as a step, and return whether it passed and what it reported. */
  step(label: string, command: IngestCommand): Promise<StepOutcome>;
  /** A line in the run log that is not a step (a skip and its reason). */
  note(message: string): void;
  readonly steps: IngestRunStep[];
}

/** `[YYYY-MM-DD HH:MM:SS] message` in local time, the run logs' format. */
export function logStamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `[${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}]`;
}

/** Commands run in the ingest package (`cwd`) with their output appended to `logFd`. */
export function processStepRunner(opts: { cwd: string; logFd: number; env?: NodeJS.ProcessEnv }): StepRunner {
  const steps: IngestRunStep[] = [];
  const write = (text: string) => fs.writeSync(opts.logFd, text);
  const note = (message: string) => write(`${logStamp()} ${message}\n`);
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-ingest-steps-"));
  return {
    steps,
    note,
    async step(label, command) {
      const started = Date.now();
      note(`=== ${label}`);
      const resultFile = path.join(resultDir, `${steps.length + 1}.json`);
      const argv = ["run", command.script, ...(command.args.length > 0 ? ["--", ...command.args] : [])];
      const code = await new Promise<number>((resolve) => {
        const child = spawn("npm", argv, {
          cwd: opts.cwd,
          env: { ...(opts.env ?? process.env), [STEP_RESULT_ENV]: resultFile },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const onData = (buf: Buffer) => write(buf.toString("utf8"));
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (err) => {
          note(`could not start: ${err.message}`);
          resolve(127);
        });
        child.on("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      const ok = code === 0;
      note(ok ? `--- ok: ${label}` : `*** FAILED (${code}): ${label}`);
      steps.push({ label, ok, seconds });
      const result = readStepResult(resultFile);
      fs.rmSync(resultFile, { force: true });
      return { ok, code, result };
    },
  };
}
