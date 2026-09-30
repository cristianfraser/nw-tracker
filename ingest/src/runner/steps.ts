import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IngestRunStep } from "nw-tracker-contracts";

/**
 * Steps of a run, as `run-lib.sh` ran them: each is one command; a failure is recorded and the
 * run goes on (one bank being down still lets the rest import); every step's label, outcome and
 * duration end up in the run report.
 */

export type StepOptions = {
  /** Keep the step's output (a fetch's «Summary: N saved» decides whether the imports run). */
  capture?: boolean;
};

export type StepOutcome = { ok: boolean; output: string };

export interface StepRunner {
  /** Run one command, record it as a step, and return whether it passed. */
  step(label: string, argv: readonly string[], opts?: StepOptions): Promise<StepOutcome>;
  /** A line in the run log that is not a step (a skip and its reason). */
  note(message: string): void;
  readonly steps: IngestRunStep[];
}

/** `[YYYY-MM-DD HH:MM:SS] message` in local time, the shell runners' log format. */
export function logStamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `[${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}]`;
}

/**
 * Commands run from the repo root with their output appended to `logFd`. `npm run <script>` is
 * what the shell runners called, so the same root scripts run with the same arguments.
 */
export function processStepRunner(opts: { cwd: string; logFd: number; env?: NodeJS.ProcessEnv }): StepRunner {
  const steps: IngestRunStep[] = [];
  const write = (text: string) => fs.writeSync(opts.logFd, text);
  const note = (message: string) => write(`${logStamp()} ${message}\n`);
  return {
    steps,
    note,
    async step(label, argv, stepOpts = {}) {
      const started = Date.now();
      note(`=== ${label}`);
      const chunks: string[] = [];
      const code = await new Promise<number>((resolve) => {
        const [cmd, ...args] = argv;
        const child = spawn(cmd!, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
        const onData = (buf: Buffer) => {
          write(buf.toString("utf8"));
          if (stepOpts.capture) chunks.push(buf.toString("utf8"));
        };
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
      return { ok, output: chunks.join("") };
    },
  };
}

/** `npm run <script> [-- args]` from the repo root. */
export function npmRun(script: string, ...args: string[]): string[] {
  return args.length > 0 ? ["npm", "run", script, "--", ...args] : ["npm", "run", script];
}
