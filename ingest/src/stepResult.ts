import fs from "node:fs";

/**
 * What a run step tells the runner, besides its exit status: how many documents a fetch staged,
 * how many rows an import wrote, which listings the bank's product summary asked for. The runner
 * gives each step a file (`NW_INGEST_STEP_RESULT`); the command writes its result there under
 * its own key, and the runner reads it once the step is over. Run by hand, nothing is written.
 */
export const STEP_RESULT_ENV = "NW_INGEST_STEP_RESULT";

export type StepResult = {
  /** Documents a fetch staged (mail documents, broker mail, a capture). */
  staged?: number;
  /** Rows an import wrote (movements written from mail, paid mortgage cuotas, interest credits). */
  inserted?: number;
  /** Listings the bank's product summary asked to read (the balance poll). */
  fetch?: string[];
  /** A product the bank states differently from the app (the balance poll). */
  differs?: boolean;
  /** The broker mail named a broker whose movement list must be read («racional»). */
  read_brokers?: string[];
  /** Why the step failed, in its own words: the run message lists them under the step. */
  problems?: string[];
  /**
   * What the user should see although the step passed (a file the organizer held): the run
   * message lists them under the step, and a run with one is recorded as a notification. Never a
   * failure, and never read by a gate.
   */
  notices?: string[];
};

/**
 * Report this command's result; a no-op outside a run. Several reports merge, later fields
 * winning — except `notices` and `problems`, which add up (a command's children write to the same
 * file: the inbox pipeline's withheld statements and its statement import's refusal are both the
 * step's problems).
 */
export function reportStepResult(result: StepResult, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[STEP_RESULT_ENV];
  if (!file) return;
  const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8") || "{}") as StepResult) : {};
  const { notices: earlier = [], problems: earlierProblems = [], ...rest } = current;
  const { notices: added = [], problems: addedProblems = [], ...fields } = result;
  const notices = [...earlier, ...added];
  const problems = [...earlierProblems, ...addedProblems];
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...rest,
      ...fields,
      ...(notices.length > 0 ? { notices } : {}),
      ...(problems.length > 0 ? { problems } : {}),
    })
  );
}

/** What the step's command reported; `{}` when it reported nothing. */
export function readStepResult(file: string): StepResult {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw ? (JSON.parse(raw) as StepResult) : {};
}
